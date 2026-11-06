import { chatCreateOptions, noticeFor, rotationReason } from "./lib/chat.mjs";
import { isOpen } from "./lib/log.mjs";
import * as ops from "./lib/ops.mjs";
import { handoffTurns } from "./lib/history.mjs";
import { flowFinishedMessage, flowMessageId, orchCommand, orchLogDir } from "./lib/flows.mjs";
import { ASK_KIND, ASK_VERSION, LINE_KIND, LINE_VERSION, type Segment } from "../shared/card";

// The chat of an affair is a real session of the model (made in the affair's workspace, here). This file keeps it:
// makes it when there is none (or replaces one that has failed, or is too long and cold), listens to it so that what he
// types is put in the log as his, and draws into it what the model cannot see -- what the looks found, the question
// waiting for him. What is drawn into a session is lost when the daemon restarts; the next scan draws it again.

type Ctx = ReturnType<typeof ops.makeCtx>;

export interface Row {
  key: string;
  text: string;
  /** Said by the person. */
  own: boolean;
  tone: string;
  detail: string;
  parts?: Segment[];
  /** The question this line is the answer to. */
  ask?: string;
}
export interface OpenAsk {
  id: string;
  title: string;
  line: string;
  options: string[];
}
export interface View {
  rows: Row[];
  asks: OpenAsk[];
}

type Unsubscribe = (() => void) & { ready?: Promise<unknown> };
export interface ChatHandle {
  send(text: string, options: { messageId: string; activeTurnBehavior: "steer" }): Promise<void>;
  refresh(): Promise<{ agent: { status: string; archivedAt?: string | null; updatedAt?: string | null; lastUserMessageAt?: string | null } } | null>;
  archive(): Promise<unknown>;
  timeline: {
    append(item: Record<string, unknown>): Promise<unknown>;
    subscribe(handler: (event: any) => void): Unsubscribe;
    refetch(options?: Record<string, unknown>): Promise<{ entries?: Array<{ item: any; timestamp?: string }>; hasOlder?: boolean; startCursor?: unknown }>;
  };
}
export interface ChatPaseo {
  agents: { ref(id: string): ChatHandle };
  workspaces: { ref(id: string): { agents: { create(options: Record<string, unknown>): Promise<{ id: string }> } } };
}

export interface ChatDeps {
  ctx: Ctx;
  paseo: ChatPaseo;
  state(id: string): any;
  write(id: string, entries: Array<Record<string, unknown>>): void;
  view(id: string): View | null;
  log(message: string): void;
}

interface Drawn {
  chatId: string;
  rows: Map<string, string>;
  /** Questions drawn and not yet closed. */
  asks: Set<string>;
  started: boolean;
}

const askId = (qid: string) => `ask-${qid}`;

/** An older chat is looked at for coming back to life this often (per affair), and only while it is this recent. */
const REVIVED_EVERY_MS = 5 * 60_000;
const REVIVED_WITHIN_MS = 3 * 86_400_000;
const REVIVED_AT_MOST = 3;

export function createChats(deps: ChatDeps) {
  const { ctx, paseo, log } = deps;
  const checked = new Set<string>();
  const drawn = new Map<string, Drawn>();
  const watching = new Map<string, { chatId: string; stop: () => void }>();
  const notices = new Map<string, string>();
  /** Chats that were replaced and could not be put away yet (old chat id -> its affair): tried again on the next scan. */
  const toPutAway = new Map<string, string>();
  const revivedAt = new Map<string, number>();
  let stopped = false;

  /** Archiving a session that is in the middle of a turn cuts the turn short, so a busy one is left alone and tried again later. */
  const busy = async (chatId: string): Promise<boolean> => {
    try {
      return ["running", "initializing"].includes((await paseo.agents.ref(chatId).refresh())?.agent.status ?? "");
    } catch {
      return false; // not there to ask: nothing is running in it
    }
  };

  /** Puts a replaced chat away; whatever stops it (busy, or Paseo refusing) leaves it on the list for the next scan. */
  async function putAway(id: string, old: string): Promise<void> {
    try {
      if (await busy(old)) {
        toPutAway.set(old, id);
        return;
      }
      await paseo.agents.ref(old).archive();
      toPutAway.delete(old);
    } catch (error) {
      toPutAway.set(old, id);
      log(`${id}: putting the old chat away failed, will try again: ${(error as Error).message}`);
    }
  }

  /** Makes a chat for the affair and puts the old one (if any) away. */
  async function replace(id: string, why: string, old: string | null): Promise<void> {
    const s = deps.state(id);
    let handoff: Record<string, unknown> | null = null;
    if (old && why.startsWith("rotate")) {
      try {
        const timeline = paseo.agents.ref(old).timeline;
        let page = await timeline.refetch({ direction: "tail", limit: 100 });
        let entries = page.entries ?? [];
        while (handoffTurns(entries).length < 3 && page.hasOlder && page.startCursor) {
          page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 100 });
          entries = [...(page.entries ?? []), ...entries];
        }
        handoff = { kind: "chat.handoff", agentId: old, turns: handoffTurns(entries) };
      } catch (error) {
        handoff = { kind: "chat.handoff", agentId: old, error: (error as Error).message };
      }
    }
    const ws = paseo.workspaces.ref(s.workspaceId);
    const made = await ws.agents.create(chatCreateOptions(ctx, s));
    deps.write(id, [...(handoff ? [handoff] : []), { kind: "chat", agentId: made.id, why }]);
    checked.add(made.id);
    const text = noticeFor(why, s.title);
    if (text) notices.set(id, text);
    if (old) await putAway(id, old);
  }

  /**
   * An older chat of the affair that is no longer put away and has been spoken to since it was replaced is the one he is using
   * (he went back to its tab, or a session it started called it): it becomes the chat again, and the empty one made in its place
   * is put away by the usual rule. Any message to an archived session takes it out of the archive, so that and a time after the
   * replacement is all there is to go by. Looked at every few minutes, not every scan.
   */
  async function recognizeRevived(id: string): Promise<boolean> {
    const s = deps.state(id);
    const now = ctx.now();
    if (!isOpen(s) || !s.chatId || now - (revivedAt.get(id) ?? 0) < REVIVED_EVERY_MS) return false;
    revivedAt.set(id, now);
    // Each older chat with the moment it was left: the line of the chat that came after its last turn as the chat.
    const left = new Map<string, string>();
    s.chats.forEach((c: { agentId: string }, i: number) => {
      const next = s.chats[i + 1];
      if (next && next.agentId !== c.agentId) left.set(c.agentId, next.at);
      else if (next) left.delete(c.agentId);
    });
    left.delete(s.chatId);
    const candidates = [...left].filter(([agent, at]) => !toPutAway.has(agent) && now - Date.parse(at) < REVIVED_WITHIN_MS).reverse().slice(0, REVIVED_AT_MOST);
    for (const [agent, at] of candidates) {
      let seen;
      try {
        seen = (await paseo.agents.ref(agent).refresh())?.agent;
      } catch {
        continue;
      }
      if (!seen || seen.archivedAt || seen.status === "error") continue;
      const touched = Math.max(Date.parse(seen.updatedAt ?? "") || 0, Date.parse(seen.lastUserMessageAt ?? "") || 0);
      if (touched <= Date.parse(at)) continue;
      const empty = s.chatId;
      deps.write(id, [{ kind: "chat", agentId: agent, why: "revived" }]);
      checked.add(agent);
      // The one made in its place stays if anything was said in it.
      if (!deps.state(id).lines.some((l: { kind: string; agentId?: string }) => l.kind === "chat.turn" && l.agentId === empty)) await putAway(id, empty);
      return true;
    }
    return false;
  }

  /** The chat exists, and is the right one: made, remade after a restart left it closed, replaced when long and cold. */
  async function ensure(id: string): Promise<void> {
    let s = deps.state(id);
    if (!s.id || !s.workspaceId) return;
    if (!s.chatId) {
      await replace(id, s.conversationId ? "migrate" : "first", s.conversationId);
      return;
    }
    if (!checked.has(s.chatId)) {
      checked.add(s.chatId);
      const status = (await paseo.agents.ref(s.chatId).refresh())?.agent.status;
      // A chat is a real session: after a restart it is only "closed", and the next thing he types wakes it where it was (checked
      // by hand). Only one that has failed is replaced.
      if (status === "error") {
        await replace(id, "failed", s.chatId);
        return;
      }
    }
    for (const [old, owner] of [...toPutAway]) if (owner === id) await putAway(id, old);
    if (await recognizeRevived(id)) return;
    s = deps.state(id);
    let flowRunning = false;
    for (const f of s.flows.filter((f: { failed: string }) => !f.failed)) {
      if ((await ops.flowStateOf(ctx, f, orchCommand(ctx.policy, ops.BIN), orchLogDir(ctx.policy))).state === "going") { flowRunning = true; break; }
    }
    const reason = isOpen(s) ? rotationReason({ ...s, flowRunning }, ctx.now(), ctx.policy) : "";
    // Not while the chat is in the middle of a turn: it may be working on what he just asked, and the new one would not know. The next scan asks again.
    if (reason && !(await busy(s.chatId))) await replace(id, reason, s.chatId);
  }

  const asText = (value: unknown) => (typeof value === "string" ? value : "");

  /** What he typed (or what another session sent into the chat) is put in the log; a turn that ended says how long the chat has become. */
  function onEvent(id: string, chatId: string, event: any) {
    const e = event?.event;
    if (!e) return;
    try {
      if (e.type === "timeline") hearItem(id, e.item, asText(event.timestamp ?? e.timestamp));
      else if (e.type === "turn_completed" && e.usage) {
        // The session reports what it has cost in all, not what this turn cost: this turn's part is the step up from last time
        // (a total that went down is a session that began again, and counts whole). Nothing is lost while the plugin was not listening: the step is bigger.
        const total = Number(e.usage.totalCostUsd) || 0;
        const before = deps.state(id).chatTurn;
        const last = before ? Number(before.usdTotal) || 0 : 0;
        const usd = total >= last ? total - last : total;
        deps.write(id, [{ kind: "chat.turn", agentId: chatId, tokens: Number(e.usage.contextWindowUsedTokens) || 0, usd, usdTotal: total }]);
      }
    } catch (error) {
      log(`${id}: chat event failed: ${(error as Error).message}`);
    }
  }

  function hearItem(id: string, item: any, at = "") {
    if (!item) return;
    if (item.type === "user_message") {
      if (asText(item.messageId ?? item.clientMessageId).startsWith("affair-flow:")) return;
      const text = asText(item.text).trim();
      if (text) void ops.hear(ctx, id, text, { messageId: asText(item.messageId) || asText(item.clientMessageId), at }).catch((error: unknown) => log(`${id}: could not note what he typed: ${(error as Error).message}`));
    } else if (item.type === "tool_call" && (item.name === "agent_message" || item.agentMessage)) {
      // Sent into the chat by another session: put down, but not as his word.
      const text = asText(item.agentMessage?.text ?? item.detail?.text).trim();
      const key = asText(item.callId);
      if (text) void ops.hear(ctx, id, text, { messageId: key ? `call:${key}` : "", at, fromAgent: true }).catch((error: unknown) => log(`${id}: could not note a message sent in: ${(error as Error).message}`));
    }
  }

  /** Listens to the affair's chat; what was typed while nobody listened (the plugin was restarted) is read from the end of it. */
  async function listen(id: string): Promise<void> {
    const s = deps.state(id);
    const chatId: string | null = s.chatId;
    const now = watching.get(id);
    if (now && now.chatId === chatId) return;
    now?.stop();
    watching.delete(id);
    if (!chatId || stopped) return;
    const handle = paseo.agents.ref(chatId);
    const sub = handle.timeline.subscribe((event) => onEvent(id, chatId, event));
    watching.set(id, { chatId, stop: () => sub() });
    try {
      await sub.ready;
      const tail = await handle.timeline.refetch({ limit: 40 });
      for (const entry of tail.entries ?? []) hearItem(id, entry.item, asText((entry as { timestamp?: unknown }).timestamp));
    } catch (error) {
      log(`${id}: listening to the chat failed: ${(error as Error).message}`);
    }
  }

  async function put(chatId: string, id: string, kind: string, version: number, data: Record<string, unknown>) {
    await paseo.agents.ref(chatId).timeline.append({ type: "plugin", id, kind, version, data });
  }

  /** The chat shows what the log says: new lines, the question waiting, an answered question turned into the line of its answer. */
  async function draw(id: string): Promise<void> {
    const s = deps.state(id);
    const chatId: string | null = s.chatId;
    const view = deps.view(id);
    if (!chatId || !view) return;
    let d = drawn.get(id);
    if (!d || d.chatId !== chatId) {
      d = { chatId, rows: new Map(), asks: new Set(), started: false };
      drawn.set(id, d);
    }
    try {
      const keep = ctx.policy.chat.redraw;
      const notice = notices.get(id);
      if (notice) {
        await put(chatId, "notice", LINE_KIND, LINE_VERSION, { text: notice, tone: "normal", detail: "" });
        notices.delete(id);
      }
      // First time in this run: the older lines are not drawn again (the chat has them or does not need them); the latest few and the open questions are.
      const first = !d.started;
      const fresh = first ? view.rows.slice(-keep) : view.rows;
      if (first) for (const r of view.rows.slice(0, Math.max(0, view.rows.length - keep))) d.rows.set(r.key, r.text);
      const open = new Set(view.asks.map((a) => a.id));
      for (const r of fresh) {
        if (d.rows.get(r.key) === r.text) continue;
        d.rows.set(r.key, r.text);
        // The answer to a question takes the question's place, drawn before or not (a card from before a reload is replaced too).
        const itemId = r.ask ? askId(r.ask) : `row-${r.key}`;
        if (r.ask) d.asks.delete(r.ask);
        await put(chatId, itemId, LINE_KIND, LINE_VERSION, { text: r.text, tone: r.tone === "red" || r.tone === "warn" ? r.tone : "normal", detail: r.detail, ...(r.parts ? { parts: r.parts } : {}) });
      }
      for (const a of view.asks) {
        if (d.asks.has(a.id)) continue;
        d.asks.add(a.id);
        await put(chatId, askId(a.id), ASK_KIND, ASK_VERSION, { affair: id, id: a.id, title: a.title, line: a.line, options: a.options });
      }
      // A question that is no longer open and has no answer to show (taken back): its card says so.
      for (const qid of [...d.asks]) {
        if (open.has(qid)) continue;
        d.asks.delete(qid);
        await put(chatId, askId(qid), LINE_KIND, LINE_VERSION, { text: "这个问题不用答了。", tone: "normal", detail: "" });
      }
      d.started = true;
    } catch (error) {
      // Not drawn (the chat is gone or Paseo is down): tried again from the start on the next scan.
      drawn.delete(id);
      log(`${id}: drawing into the chat failed: ${(error as Error).message}`);
    }
  }

  async function sync(id: string): Promise<void> {
    await ensure(id);
    await listen(id);
    await draw(id);
  }

  /** Wait for the result's look first. A blocked or failed look must not hide the run's end from the person. */
  async function tellFinished(id: string): Promise<void> {
    const s = deps.state(id);
    for (const f of s.flows) {
      if (!f.outcome || s.lines.some((l: any) => l.kind === "flow.told" && l.runId === f.runId)) continue;
      const end = f.marks.find((m: any) => m.key === "end");
      const look = s.lines.find((l: any) => l.kind === "flow.look" && l.runId === f.runId);
      if (!look || !end) continue;
      const wake = s.wakes.find((w: any) => w.seq > end.seq && w.why.includes(`ring:flow:${f.runId}`));
      const failed = s.lines.some((l: any) => l.kind === "wake.end" && l.seq > look.seq && l.state === "failed");
      if (look.ok && !failed && !(wake && (wake.reported || s.lines.some((l: any) => l.kind === "wake.end" && l.seq > wake.seq)))) continue;
      const record = (ok: boolean, why = "") => deps.write(id, [{ kind: "flow.told", runId: f.runId, agentId: s.chatId, ok, ...(why ? { why } : {}) }]);
      if (!s.chatId) { record(false, "聊天不存在，没发"); continue; }
      const handle = paseo.agents.ref(s.chatId);
      let seen;
      try { seen = (await handle.refresh())?.agent; }
      catch (error) {
        if (!/not found|does not exist/i.test((error as Error).message)) throw error;
      }
      if (!seen || seen.archivedAt) { record(false, "聊天不存在或已归档，没发"); continue; }
      if (["running", "initializing"].includes(seen.status)) continue;
      await handle.send(flowFinishedMessage(ctx, s, f, ctx.flowNow.get(f.runId)?.st), { messageId: flowMessageId(f.runId), activeTurnBehavior: "steer" });
      record(true);
    }
  }

  function stop() {
    stopped = true;
    for (const w of watching.values()) w.stop();
    watching.clear();
  }

  return { sync, ensure, draw, listen, tellFinished, stop };
}
