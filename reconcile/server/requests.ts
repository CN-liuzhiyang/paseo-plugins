import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// What a person said in a conversation, handed to the engine as a file. Any session with a shell
// runs bin/reconcile-say.mjs, which writes one request into <data>/requests/ and waits for the
// receipt in <data>/requests/done/. The engine is the only one that writes the journal: it reads
// the requests at the start of a reconcile, and nothing else is trusted about them. Anything on
// this machine can write a file there, so a request is checked like input from outside: its name,
// its size, its shape; at most a few per reconcile and per hour; once per id, even across a crash.

export const REQUEST_ID = /^r_[0-9a-f]{12}$/;
export const ANNOTATION_ID = /^a_[0-9a-f]{12}$/;
export const MAX_REQUEST_BYTES = 8 * 1024;
export const REQUESTS_PER_TICK = 10;
export const REQUESTS_PER_HOUR = 30;
/** Request names looked at per reconcile, so that a flooded directory costs a bounded read. */
const NAMES_PER_TICK = 200;
const STALE_TMP_MS = 3_600_000;
const RECEIPT_KEEP_MS = 7 * 86_400_000;

const base = {
  v: z.literal(1),
  id: z.string().regex(REQUEST_ID),
  at: z.string().max(40),
  /** PASEO_AGENT_ID of the session that ran the command; the engine looks the conversation up by it. */
  via: z.string().min(1).max(80).nullable(),
  said: z.string().trim().min(1).max(500),
};

const say = z
  .object({
    ...base,
    cmd: z.literal("say"),
    kind: z.enum(["drop", "hold", "wrong"]),
    item: z.string().trim().min(1).max(80),
    /** hold: the day asking starts again (YYYY-MM-DD, local). */
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** hold: only this person's questions; absent, everyone's on the item. */
    person: z.string().min(1).max(40).optional(),
    /** wrong: what is wrong, and what is right, in words. */
    what: z.string().max(300).optional(),
    expected: z.string().max(300).optional(),
  })
  .strict();

const undo = z
  .object({
    ...base,
    cmd: z.literal("undo"),
    /** An annotation id, or "last": the newest still in force said in the same session. */
    target: z.union([z.string().regex(ANNOTATION_ID), z.literal("last")]),
  })
  .strict();

export const requestSchema = z.discriminatedUnion("cmd", [say, undo]);
export type Request = z.output<typeof requestSchema>;
export type SayRequest = Extract<Request, { cmd: "say" }>;

export const KIND_LABEL: Record<SayRequest["kind"], string> = { drop: "不再追踪", hold: "先别问", wrong: "判断错了" };

/** One request file read: a request, or why it was refused (with its id when the name was one). */
export type Incoming = { id: string; request: Request } | { id: string; error: string };

/**
 * The request files waiting, oldest first (by time written, then name). Ids already handled
 * (`known`) come back apart and take no slot, so a request whose file could not be removed does
 * not hold up the others; of the rest at most `limit`. A file that is a link, a directory, too big
 * or not a request comes back as an error with the reason; the caller writes the receipt and
 * removes it. A name that is not a request id is left alone.
 */
export function readRequests(dir: string, known: (id: string) => boolean, limit = REQUESTS_PER_TICK): { fresh: Incoming[]; known: string[] } {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { fresh: [], known: [] };
  }
  const candidates: Array<{ id: string; file: string; mtimeMs: number; st: ReturnType<typeof lstatSync> | null }> = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort().slice(0, NAMES_PER_TICK)) {
    const id = name.slice(0, -".json".length);
    if (!REQUEST_ID.test(id)) continue;
    const file = path.join(dir, name);
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(file);
    } catch {
      // Gone since the listing, or unreadable: reported below as unreadable.
    }
    candidates.push({ id, file, mtimeMs: st?.mtimeMs ?? 0, st });
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  const out: Incoming[] = [];
  const done: string[] = [];
  for (const { id, file, st } of candidates) {
    if (known(id)) {
      done.push(id);
      continue;
    }
    if (out.length >= limit) continue;
    if (!st) {
      out.push({ id, error: "读不出来" });
      continue;
    }
    if (!st.isFile()) {
      out.push({ id, error: "不是普通文件" });
      continue;
    }
    if (st.size > MAX_REQUEST_BYTES) {
      out.push({ id, error: `太大了（${st.size} 字节，最多 ${MAX_REQUEST_BYTES}）` });
      continue;
    }
    try {
      const parsed = requestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) {
        out.push({ id, error: `格式不对：${parsed.error.issues.map((i) => `${i.path.join(".") || "（整体）"} ${i.message}`).join("；").slice(0, 300)}` });
        continue;
      }
      if (parsed.data.id !== id) {
        out.push({ id, error: "文件名和里面的 id 不一致" });
        continue;
      }
      out.push({ id, request: parsed.data });
    } catch (error) {
      out.push({ id, error: `读不出来：${(error as Error).message.slice(0, 200)}` });
    }
  }
  return { fresh: out, known: done };
}

export interface Receipt {
  id: string;
  outcome: "applied" | "proposed" | "rejected";
  text: string;
  annotation: string | null;
}

/**
 * Writes the receipt the command waits for, then takes the request away: removed, or, when it
 * cannot be (a directory under a request's name), moved into rejected/ so that it is not read again.
 */
export function finishRequest(dir: string, receipt: Receipt): void {
  const done = path.join(dir, "done");
  mkdirSync(done, { recursive: true });
  const file = path.join(done, `${receipt.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(receipt, null, 2));
  renameSync(`${file}.tmp`, file);
  const request = path.join(dir, `${receipt.id}.json`);
  try {
    unlinkSync(request);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    const rejected = path.join(dir, "rejected");
    mkdirSync(rejected, { recursive: true });
    renameSync(request, path.join(rejected, `${receipt.id}.json`));
  }
}

/** Leftovers: half-written files an hour old (a command killed while writing), and receipts a week old. */
export function sweepRequests(dir: string, nowMs: number): void {
  const sweep = (where: string, gone: (name: string, mtimeMs: number) => boolean) => {
    let names: string[];
    try {
      names = readdirSync(where);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const st = lstatSync(path.join(where, name));
        if (st.isFile() && gone(name, st.mtimeMs)) rmSync(path.join(where, name));
      } catch {
        // Raced with the command, or not ours to remove.
      }
    }
  };
  const staleTmp = (name: string, mtimeMs: number) => name.endsWith(".json.tmp") && nowMs - mtimeMs > STALE_TMP_MS;
  sweep(dir, staleTmp);
  sweep(path.join(dir, "done"), (name, mtimeMs) => staleTmp(name, mtimeMs) || (name.endsWith(".json") && nowMs - mtimeMs > RECEIPT_KEEP_MS));
}

/** One thing in a turn, in the order the timeline has it: a person's message, a command run, a message from another agent. */
export type TurnStep = { kind: "person"; text: string } | { kind: "command"; text: string } | { kind: "agent" };

/** The conversation a request came from, as the host shows it. */
export interface Conversation {
  labels: Record<string, string>;
  cwd: string | null;
  /** The turn the session is running now; null when it is not running one. */
  turn: { id: string; steps: TurnStep[] } | null;
}

/** A timeline entry as far as the turn matters. */
export interface TurnEntry {
  type: string;
  /** A person's message: its text. */
  text?: string;
  /** A tool call that ran a command: the command as the agent wrote it. */
  command?: string;
  /** A message another agent sent into the conversation (the host shows it as a tool call). */
  agent?: boolean;
  turnId?: string;
}

/**
 * The command a timeline tool call ran: a shell call's, or, for a tool the host does not know
 * (PowerShell on Windows), a string `command` in its input. Undefined when it shows none.
 */
export function commandOf(item: unknown): string | undefined {
  const it = item as { type?: unknown; detail?: { type?: unknown; command?: unknown; input?: unknown } } | null;
  if (it?.type !== "tool_call" || !it.detail) return undefined;
  if (it.detail.type === "shell" && typeof it.detail.command === "string") return it.detail.command;
  const input = it.detail.input as { command?: unknown } | null | undefined;
  if (it.detail.type === "unknown" && input && typeof input === "object" && typeof input.command === "string") return input.command;
  return undefined;
}

/**
 * The person's messages, the commands and other agents' messages of the turn the session is
 * running now (`turnId`, the host's active turn), in order. Nothing else counts: a turn woken by a
 * notice or a timer has no message of the person's, and is not taken to carry words they said in
 * an earlier one.
 */
export function currentTurn(entries: TurnEntry[], turnId: string | null): Conversation["turn"] {
  if (!turnId) return null;
  const steps: TurnStep[] = [];
  for (const e of entries) {
    if (e.turnId !== turnId) continue;
    if (e.type === "user_message" && e.text) steps.push({ kind: "person", text: e.text });
    else if (e.agent) steps.push({ kind: "agent" });
    else if (e.command) steps.push({ kind: "command", text: e.command });
  }
  return { id: turnId, steps };
}

/** Timeline entries read per page when checking whose words a request carries. */
export const TIMELINE_PAGE = 200;

/** As much of a host agent handle as reading its conversation takes; `C` is the host's page cursor. */
export interface ConversationSource<C = unknown> {
  timeline: { refetch(options: { direction: "tail" | "before"; limit: number; cursor?: C }): Promise<TimelinePage<C>> };
  refresh(): Promise<unknown>;
  current(): AgentSnapshot | null;
}
interface AgentSnapshot {
  status: string;
  activeTurn?: { turnId: string } | null;
  labels?: Record<string, string>;
  cwd?: string | null;
}
interface TimelinePage<C> {
  agent?: AgentSnapshot | null;
  entries: Array<{ item: unknown; turnId?: string }>;
  hasOlder: boolean;
  startCursor: C | null;
}

/**
 * An agent's conversation as the check needs it. The command runs inside a turn of the session
 * that ran it: the host's running turn is that one, and no other; a session not running one has
 * none. A long turn starts before the newest page: older pages are read until its start is in, a
 * few at most.
 */
export async function readConversation<C>(ref: ConversationSource<C>): Promise<Conversation | null> {
  let page = await ref.timeline.refetch({ direction: "tail", limit: TIMELINE_PAGE });
  const agent = page.agent ?? ((await ref.refresh()) ? ref.current() : null);
  if (!agent) return null;
  const turnId = agent.status === "running" ? (agent.activeTurn?.turnId ?? null) : null;
  const entries = [...page.entries];
  for (let more = 0; turnId && entries[0]?.turnId === turnId && page.hasOlder && page.startCursor && more < 3; more++) {
    page = await ref.timeline.refetch({ direction: "before", cursor: page.startCursor, limit: TIMELINE_PAGE });
    entries.unshift(...page.entries);
  }
  const turn = entries.map((e) => {
    const item = e.item as { type?: unknown; text?: unknown; name?: unknown } | null;
    return {
      type: String(item?.type),
      text: item?.type === "user_message" && typeof item.text === "string" ? item.text : undefined,
      command: commandOf(e.item),
      agent: item?.type === "tool_call" && item.name === "agent_message",
      turnId: e.turnId,
    };
  });
  return { labels: agent.labels ?? {}, cwd: agent.cwd ?? null, turn: currentTurn(turn, turnId) };
}

/** Labels of agents that are not a person's own conversation: started by another agent, a flow, or a card. */
const NOT_A_PERSON = ["paseo.parent-agent-id", "orch-run", "reconcile-card"];

const MAX_MESSAGE = 200;
const MIN_COVER = 0.7;

/** Text as a command line carries it, without the quoting and escaping a shell adds. */
const squash = (text: string) => text.replace(/[\s"'`\\^]/g, "");

/**
 * The words of a command line, split into the commands it runs (at ;, &, |, && and ||, and line
 * ends), as a POSIX shell or PowerShell would split them: quotes grouped, a backslash or backtick
 * escaping the next character, an unquoted # starting a comment. Rough on purpose: a line it reads
 * wrong can only make a request not match, and that sends it to a card.
 */
export function commandWords(line: string): string[][] {
  // A backtick escapes what follows it (PowerShell); a backslash only a quote, itself, a space or
  // what a shell treats specially, so that a Windows path keeps its backslashes.
  const escapes = (text: string, at: number) => at + 1 < text.length && (text[at] === "`" || (text[at] === "\\" && /[\s"'\\$`;&|#]/.test(text[at + 1]!)));
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'") {
      // Literal to the closing quote; '' inside is one quote (PowerShell).
      for (i++; i < line.length; i++) {
        if (line[i] !== "'") word += line[i];
        else if (line[i + 1] === "'") word += line[++i];
        else break;
      }
      inWord = true;
    } else if (ch === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) word += escapes(line, i) ? line[++i] : line[i];
      inWord = true;
    } else if (escapes(line, i)) {
      const next = line[++i]!;
      if (next === "\n" || next === "\r") endWord();
      else {
        word += next;
        inWord = true;
      }
    } else if (ch === "#" && !inWord) {
      while (i + 1 < line.length && line[i + 1] !== "\n") i++;
    } else if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      endCommand();
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

const SAY_PROGRAM = /(^|[\\/])reconcile-say(\.mjs)?$/i;
/** What may stand before the program in a command that runs it: node itself, its options, variables set for it. */
const RUNNER = /^(?:(?:.*[\\/])?node(?:js)?(?:\.exe)?|env|-.*|[A-Za-z_][A-Za-z0-9_]*=.*)$/i;

/** The reconcile-say runs in a command line: each one's subcommand and flags, as the command reads them. */
export function sayCalls(line: string): Array<{ cmd: string; flags: Record<string, string | true> }> {
  const calls: Array<{ cmd: string; flags: Record<string, string | true> }> = [];
  for (const words of commandWords(line)) {
    const at = words.findIndex((w) => SAY_PROGRAM.test(w));
    // Only a run of it: grep, cat, echo or a comment that mentions it is not one.
    if (at < 0 || !words.slice(0, at).every((w) => RUNNER.test(w))) continue;
    const [cmd = "", ...rest] = words.slice(at + 1);
    const flags: Record<string, string | true> = {};
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]!;
      if (!w.startsWith("--")) continue;
      const eq = w.indexOf("=");
      if (eq > 0) flags[w.slice(2, eq)] = w.slice(eq + 1);
      else if (w === "--last" || w === "--help") flags[w.slice(2)] = true;
      else flags[w.slice(2)] = rest[++i] ?? "";
    }
    calls.push({ cmd, flags });
  }
  return calls;
}

/** Whether a reconcile-say run asked for exactly this request: the subcommand, and every flag that makes it. */
function asks(call: { cmd: string; flags: Record<string, string | true> }, r: Request): boolean {
  const same = (flag: string, value: string | undefined) => {
    const got = call.flags[flag];
    return value === undefined ? got === undefined : typeof got === "string" && squash(got) === squash(value);
  };
  if (call.cmd !== r.cmd || !same("said", r.said)) return false;
  if (r.cmd === "undo") return r.target === "last" ? call.flags.last === true && call.flags.id === undefined : same("id", r.target) && call.flags.last === undefined;
  return same("item", r.item) && call.flags.kind === r.kind && same("until", r.until) && same("person", r.person) && same("what", r.what) && same("expected", r.expected);
}

/** What one turn's words vouched for once: a second request on the same words in the same turn is not taken as theirs. */
export const vouchKey = (via: string, turnId: string, said: string) => `${via}\u0000${turnId}\u0000${squash(said)}`;

/**
 * Whether the request carries the person's own words, said just now in their own conversation:
 * null when it does, else why not. The session must be running a turn that a message of the
 * person's started, and that turn must have run reconcile-say for this very request (its item,
 * kind and words): so the check is bound to the session running it and to what it asked, not to
 * whatever id a request names. Only that turn counts (an agent may not quote back what was said
 * yesterday), and no other agent's message may have come into it between the person's words and
 * the command; a message that is long, many lines or has a code block reads as pasted, and the
 * words must be most of the message, so that a line picked out of someone else's chat does not
 * pass as the person's. What cannot be checked is not taken as theirs.
 */
export function notOwnWords(r: Request, conversation: Conversation | null): string | null {
  if (!conversation) return "找不到说这句话的对话";
  if (NOT_A_PERSON.some((l) => l in conversation.labels)) return "这个对话不是人直接在用的（是别的 agent、流程或卡片起的）";
  // A chat channel (or another plugin) starts its conversations with a source label: the host does not say who sent what there.
  if (conversation.labels.source) return `这是从「${clip(conversation.labels.source, 20)}」进来的对话（聊天软件或别的插件），分不清是谁说的`;
  const turn = conversation.turn;
  if (!turn) return "说这句话的对话这会儿没在跑，对不上是哪一轮说的";
  const steps = turn.steps;
  if (!steps.some((s) => s.kind === "person")) return "这一轮不是人发消息开始的（比如被通知或定时叫醒），不算本人说的";
  const words = r.said.trim();
  const run = steps.findIndex((s) => s.kind === "command" && sayCalls(s.text).some((call) => asks(call, r)));
  if (run < 0) return "这一轮里找不到这次的 reconcile-say 调用（命令里的事项、改动和原话要和这次的一致）";
  // The message the words come from: of those before the command that have them, the closest fit.
  let said = -1;
  for (let i = 0; i < run; i++) {
    const step = steps[i]!;
    if (step.kind === "person" && step.text.includes(words) && (said < 0 || step.text.length < (steps[said] as { text: string }).text.length)) said = i;
  }
  if (said < 0) return "这一轮对话里找不到这句原话";
  if (steps.slice(said + 1, run).some((s) => s.kind === "agent")) return "人说完这句话以后，这一轮里进来过别的 agent 的消息，分不清是谁的意思";
  const text = (steps[said] as { text: string }).text.trim();
  if (text.length > MAX_MESSAGE || text.split("\n").length > 3 || text.includes("```")) return "原话所在的消息像是贴进来的一段，不算本人说的";
  if (words.length < MIN_COVER * text.length) return "原话只是那条消息里的一小段，不算本人说的";
  return null;
}

/** Shortens text from outside (a tracker title, a headline, words said) to one line before it is shown anywhere. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The same, for a place that renders Markdown (a card, plan.md): one line, and the characters
 * that would make a link, emphasis, code, a heading or a quote shown as they are.
 */
export function clipMd(text: string, max: number): string {
  return clip(text, max).replace(/[\\`*_[\]()<>#|~!]/g, "\\$&");
}
