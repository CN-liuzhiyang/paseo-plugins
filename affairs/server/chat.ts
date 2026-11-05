import { chatCreateOptions, noticeFor, rotationReason } from "./lib/chat.mjs";
import { isOpen } from "./lib/log.mjs";
import * as ops from "./lib/ops.mjs";
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
  refresh(): Promise<{ agent: { status: string } } | null>;
  archive(): Promise<unknown>;
  timeline: {
    append(item: Record<string, unknown>): Promise<unknown>;
    subscribe(handler: (event: any) => void): Unsubscribe;
    refetch(options?: Record<string, unknown>): Promise<{ entries?: Array<{ item: any; timestamp?: string }> }>;
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

export function createChats(deps: ChatDeps) {
  const { ctx, paseo, log } = deps;
  const checked = new Set<string>();
  const drawn = new Map<string, Drawn>();
  const watching = new Map<string, { chatId: string; stop: () => void }>();
  const notices = new Map<string, string>();
  /** Chats that were replaced and could not be put away yet (old chat id -> its affair): tried again on the next scan. */
  const toPutAway = new Map<string, string>();
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
    const ws = paseo.workspaces.ref(s.workspaceId);
    const made = await ws.agents.create(chatCreateOptions(ctx, s));
    deps.write(id, [{ kind: "chat", agentId: made.id, why }]);
    checked.add(made.id);
    const text = noticeFor(why, s.title);
    if (text) notices.set(id, text);
    if (old) await putAway(id, old);
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
    s = deps.state(id);
    const reason = isOpen(s) ? rotationReason(s, ctx.now(), ctx.policy) : "";
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
        await put(chatId, itemId, LINE_KIND, LINE_VERSION, { text: r.text, tone: r.tone === "red" ? "red" : "normal", detail: r.detail, ...(r.parts ? { parts: r.parts } : {}) });
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

  function stop() {
    stopped = true;
    for (const w of watching.values()) w.stop();
    watching.clear();
  }

  return { sync, ensure, draw, listen, stop };
}
