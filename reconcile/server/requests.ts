import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// What a person said in a conversation, handed to the engine as a file. Any session with a shell
// runs bin/reconcile-say.mjs, which writes one request into <data>/requests/ and waits for the
// receipt in <data>/requests/done/. The engine is the only one that writes the journal: it reads
// the requests at the start of a reconcile, and nothing else is trusted about them. Anything on
// this machine can write a file there, so a request is checked like input from outside: its name,
// its size, its shape; at most a few per reconcile; once per id, even across a crash.

export const REQUEST_ID = /^r_[0-9a-f]{12}$/;
export const ANNOTATION_ID = /^a_[0-9a-f]{12}$/;
export const MAX_REQUEST_BYTES = 8 * 1024;
export const REQUESTS_PER_TICK = 10;

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
 * The request files waiting, oldest name first, at most `limit`. A name that is not an id, or a
 * file that is a link, too big or not a request, comes back as an error with the reason; the
 * caller writes the receipt and removes it. Anything else in the directory is left alone.
 */
export function readRequests(dir: string, limit = REQUESTS_PER_TICK): Incoming[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Incoming[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    if (out.length >= limit) break;
    const id = name.slice(0, -".json".length);
    if (!REQUEST_ID.test(id)) continue;
    const file = path.join(dir, name);
    try {
      const st = lstatSync(file);
      if (!st.isFile()) {
        out.push({ id, error: "不是普通文件" });
        continue;
      }
      if (st.size > MAX_REQUEST_BYTES) {
        out.push({ id, error: `太大了（${st.size} 字节，最多 ${MAX_REQUEST_BYTES}）` });
        continue;
      }
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
  return out;
}

export interface Receipt {
  id: string;
  outcome: "applied" | "proposed" | "rejected";
  text: string;
  annotation: string | null;
}

/** Writes the receipt the command waits for, then removes the request. */
export function finishRequest(dir: string, receipt: Receipt): void {
  const done = path.join(dir, "done");
  mkdirSync(done, { recursive: true });
  const file = path.join(done, `${receipt.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(receipt, null, 2));
  renameSync(`${file}.tmp`, file);
  try {
    unlinkSync(path.join(dir, `${receipt.id}.json`));
  } catch {
    // Already gone.
  }
}

/** The conversation a request came from, as the host shows it. */
export interface Conversation {
  labels: Record<string, string>;
  cwd: string | null;
  /** The person's messages in the turn running now, oldest first. */
  turn: string[];
}

/** A timeline entry as far as the turn matters. */
export interface TurnEntry {
  type: string;
  text?: string;
  turnId?: string;
}

/**
 * The person's messages of the turn running now: those with the turn id of the newest entry, or,
 * when the host gives no turn ids, the run of messages after the last thing the agent said.
 */
export function currentTurn(entries: TurnEntry[]): string[] {
  const last = entries[entries.length - 1];
  if (last?.turnId) {
    const ofTurn = entries.filter((e) => e.type === "user_message" && e.turnId === last.turnId && e.text).map((e) => e.text!);
    if (ofTurn.length > 0) return ofTurn;
  }
  let i = entries.length - 1;
  while (i >= 0 && entries[i]!.type !== "user_message") i--;
  const out: string[] = [];
  while (i >= 0 && entries[i]!.type === "user_message") out.unshift(entries[i--]!.text ?? "");
  return out.filter(Boolean);
}

/** Labels of agents that are not a person's own conversation: started by another agent, a flow, or a card. */
const NOT_A_PERSON = ["paseo.parent-agent-id", "orch-run", "reconcile-card"];

const MAX_MESSAGE = 200;
const MIN_COVER = 0.7;

/**
 * Whether the words are the person's own, said just now in their own conversation: null when they
 * are, else why not. Only the turn running now counts (an agent may not quote back what was said
 * yesterday); a message that is long, many lines or has a code block reads as pasted, and the
 * words must be most of the message, so that a line picked out of someone else's chat does not
 * pass as the person's.
 */
export function notOwnWords(said: string, conversation: Conversation | null, chatCwds: string[]): string | null {
  if (!conversation) return "找不到说这句话的对话";
  const label = NOT_A_PERSON.find((l) => l in conversation.labels);
  if (label) return "这个对话不是人直接在用的（是别的 agent、编排运行或卡片起的）";
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const cwd = conversation.cwd ? norm(conversation.cwd) : null;
  if (cwd && chatCwds.some((c) => cwd === norm(c) || cwd.startsWith(norm(c) + path.sep))) {
    return "这是聊天软件里的对话，分不清是谁说的";
  }
  const words = said.trim();
  for (const message of conversation.turn) {
    const text = message.trim();
    if (!text.includes(words)) continue;
    if (text.length > MAX_MESSAGE || text.split("\n").length > 3 || text.includes("```")) return "原话所在的消息像是贴进来的一段，不算本人说的";
    if (words.length < MIN_COVER * text.length) return "原话只是那条消息里的一小段，不算本人说的";
    return null;
  }
  return "这一轮对话里找不到这句原话";
}

/** Shortens text from outside (a tracker title, a headline) before it goes back to a conversation. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
