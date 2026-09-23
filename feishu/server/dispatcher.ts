import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { AgentPermissionAction, AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { Route, Settings } from "../shared/settings";
import type { Audit } from "./audit";
import {
  answerFailedCard,
  answeredCard,
  canceledCard,
  decisionLine,
  doneCard,
  doneTitle,
  failedCard,
  lastResortCard,
  newSessionCard,
  noRouteCard,
  queuedCard,
  receivedCard,
  runningCard,
  staleApprovalCard,
  strangerCard,
  letInCard,
  waitingCard,
  type ApprovalView,
  type RunView,
} from "./cards";
import { contextOf, systemPrompt } from "./context";
import { overheardBlock, stripMentions, type Incoming, type Overheard } from "./inbound";
import { patchCard, replyCard, type LarkCli } from "./lark";
import { createPainter, type Painter } from "./painter";
import type { Directory } from "./directory";
import type { People } from "./people";
import {
  letInName,
  parseButtonName,
  parseLetInName,
  permissionActions,
  permissionResponse,
  reasonFrom,
  requestDetail,
} from "./permissions";
import { applyItem, createProgress } from "./progress";
import { describePermission, finalAnswer } from "./timeline";

// A running card is redrawn on the agent's own events, at most this often (Feishu rate-limits
// edits to a message), and otherwise on a heartbeat so its clock never looks stuck.
const PAINT_INTERVAL_MS = 1_500;
const TICK_MS = 1_000;
// How soon a card whose last patch failed is tried again.
const RETRY_BEHIND_MS = 3_000;
// How often a queue waiting on a turn started outside this plugin is looked at.
const QUEUE_CHECK_MS = 5_000;
const REMEMBERED_MESSAGES = 1_000;
// How long a turn waits for the live timeline before it is sent anyway.
const FOLLOW_WAIT_MS = 3_000;
// How long an answer sent from a card may go without Paseo confirming it.
const CONFIRM_MS = 15_000;
const REMEMBERED_ORPHANS = 100;
// Worded like the orchestration runtime's gate, which has the same blind spot.
const UNATTRIBUTED = "paseo (unattributed: Paseo does not record who answered)";
// Marks the agent that holds a chat's conversation. It lives on the agent in Paseo's own
// registry, so the conversation survives plugin reloads and daemon restarts.
export const CHAT_LABEL = "feishu-chat";
// What a group said while the bot was not @-ed, kept for its next @: the last this many
// messages, none older than this.
const OVERHEARD_LIMIT = 20;
const OVERHEARD_MAX_AGE_MS = 6 * 60 * 60_000;
// Someone the bot does not know is told so once in this long per chat, not on every message.
const STRANGER_NOTICE_MS = 10 * 60_000;
// A message from someone not yet let in waits this long for an admin to let them in.
const HELD_MAX_AGE_MS = 60 * 60_000;
const HELD_LIMIT = 50;
const NEW_SESSION = /^\/new(?:\s+([\s\S]*))?$/;
const NEW_COMMAND = /^\/new\b\s*/;

/** How long a running card may go without a redraw: often at first, less as the run goes on. */
export function heartbeatMs(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 3_000;
  if (elapsedMs < 600_000) return 10_000;
  return 30_000;
}

interface Pending {
  request: AgentPermissionRequest;
  askedAt: number;
  /** Why the last answer from the card did not go through, shown until the next one. */
  notice: string | null;
}

interface Run extends RunView {
  chatId: string;
  cardId: string;
  cwd: string;
  pending: Map<string, Pending>;
  decisions: string[];
  painter: Painter;
  /** Stops following the agent's live timeline. */
  unfollow: (() => void) | null;
}

/** A choice made on a card and sent to Paseo, until Paseo confirms it. */
interface Answer {
  agentId: string;
  requestId: string;
  cardId: string;
  chatId: string;
  operator: string;
  action: AgentPermissionAction;
  reason: string | null;
  what: string;
  askedAt: number | null;
  timer: NodeJS.Timeout;
}

interface Turn {
  chatId: string;
  messageId: string;
  incoming: Incoming;
  provider: string;
  cwd: string;
  cardId: string;
  painter: Painter;
}

/** Someone the plugin turned away: not in senders, or writing from a chat with no route. */
export interface Stranger {
  senderId: string;
  /** As Feishu shows them, when it could be found. */
  name: string | null;
  chatId: string;
  chatType: "p2p" | "group";
  why: "sender" | "route";
  at: number;
}

interface ChatAgent {
  agentId: string;
  provider: string;
  cwd: string;
}

export interface Lark {
  reply(messageId: string, card: object): Promise<string>;
  patch(cardId: string, card: object): Promise<void>;
}

export function larkOf(cli: LarkCli): Lark {
  return {
    reply: (messageId, card) => replyCard(cli, messageId, card),
    patch: (cardId, card) => patchCard(cli, cardId, card),
  };
}

type Event<Name extends keyof PluginLifecycleEvents> = PluginLifecycleEvents[Name];

/** A message as typed, for tests and for hosts that cannot fetch attachments. */
export async function textOnly(
  event: Record<string, unknown>,
  options: { command?: RegExp; overheard?: Overheard[] } = {},
): Promise<Incoming> {
  const typed = stripMentions(typeof event.content === "string" ? event.content : "", event.mentions);
  const text = options.command ? typed.replace(options.command, "").trim() : typed;
  const heard = await overheardBlock(options.overheard ?? []);
  return { prompt: heard === "" ? text : `${heard}\n\n${text}`, images: [], summary: text, problems: [] };
}

/**
 * One Feishu chat is one conversation with one agent. The first message in a routed chat starts
 * the agent; later messages go to the same agent in order, queued while it is busy. `/new`
 * starts a fresh agent for the chat. Every message gets its own card, redrawn from the agent's
 * live timeline and lifecycle events until that message's turn ends.
 */
export function createDispatcher(deps: {
  paseo: Pick<PaseoApi, "agents">;
  lark: Lark;
  readSettings: () => Promise<Settings | null>;
  log: (line: string) => void;
  audit: Audit;
  /** What the agent is sent for a message: text, images, the message replied to. */
  readIncoming?: (
    event: Record<string, unknown>,
    options?: { command?: RegExp; overheard?: Overheard[] },
  ) => Promise<Incoming>;
  /** This bot's open_id, which a group message @-mentions when it is meant for the bot. */
  botId?: () => Promise<string | null>;
  /** Told about an agent before it is created without CLAUDE.md; see context.ts. */
  isolate?: (agentId: string) => void;
  /** Told about everyone turned away, so the settings screen can offer to let them in. */
  onStranger?: (stranger: Stranger) => void;
  /** Members let in from Feishu; see people.ts. Without it only senders get in. */
  people?: People;
  /** Names for open_ids; see directory.ts. */
  directory?: Directory;
  now?: () => number;
  paintIntervalMs?: number;
}) {
  const { paseo, lark, readSettings, log, audit } = deps;
  const readIncoming = deps.readIncoming ?? textOnly;
  const now = deps.now ?? Date.now;
  const paintIntervalMs = deps.paintIntervalMs ?? PAINT_INTERVAL_MS;
  const seen = new Set<string>();
  const seenActions = new Set<string>();
  const runs = new Map<string, Run>();
  const answers = new Map<string, Answer>();
  // Cards whose run is no longer followed, as after a restart.
  const orphans = new Map<string, Painter>();
  // Cards already showing how their run ended; a late click must not replace that.
  const settled = new Set<string>();
  const queues = new Map<string, Turn[]>();
  // When each queue whose agent is busy outside this plugin was last checked.
  const queueChecks = new Map<string, number>();
  const chats = new Map<string, ChatAgent>();
  const chatWork = new Map<string, Promise<void>>();
  const overheard = new Map<string, Overheard[]>();
  let botIdMissingLogged = false;
  // When each stranger was last told, by chat and sender.
  const toldStrangers = new Map<string, number>();
  // Messages from strangers, by message ID, until an admin lets the sender in.
  const held = new Map<string, { event: Record<string, unknown>; at: number }>();
  let ticker: NodeJS.Timeout | null = null;
  let stopped = false;

  const painterFor = (cardId: string): Painter =>
    createPainter({ cardId, patch: lark.patch, log, intervalMs: paintIntervalMs, now });

  const approvalsOf = (run: Run): ApprovalView[] =>
    [...run.pending.values()].map(({ request, notice }) => {
      const detail = requestDetail(request);
      const title = request.title ?? request.name;
      const described = request.description && request.description !== detail;
      return {
        agentId: run.agentId,
        requestId: request.id,
        title: described ? `${title}\n${request.description}` : title,
        detail,
        actions: permissionActions(request),
        submitting: answers.get(answerKey(run.agentId, request.id))?.action.label ?? null,
        notice,
      };
    });

  /** The card for a run that has not ended: waiting while anything is open, else running. */
  const render = (run: Run): object =>
    run.pending.size > 0 ? waitingCard(run, approvalsOf(run)) : runningCard(run, now());

  const redraw = (run: Run) => run.painter.draw(() => render(run));

  const orphan = (cardId: string): Painter => {
    let painter = orphans.get(cardId);
    if (!painter) {
      painter = painterFor(cardId);
      orphans.set(cardId, painter);
      const oldest = orphans.keys().next().value;
      if (orphans.size > REMEMBERED_ORPHANS && oldest !== undefined) orphans.delete(oldest);
    }
    return painter;
  };

  const settle = (cardId: string) => {
    settled.add(cardId);
    const oldest = settled.values().next().value;
    if (settled.size > REMEMBERED_MESSAGES && oldest !== undefined) settled.delete(oldest);
  };

  const heartbeat = () => {
    const at = now();
    for (const run of runs.values()) {
      // A waiting card is left alone, since a redraw would wipe a reason someone is typing,
      // unless its last patch failed: then it shows no buttons at all.
      const due = run.pending.size === 0 ? heartbeatMs(at - run.startedAt) : Infinity;
      if (run.painter.idleFor() >= due || (run.painter.behind() && run.painter.idleFor() >= RETRY_BEHIND_MS)) {
        redraw(run);
      }
    }
    // A message queued behind a turn this plugin did not start has no turn_ended of its own
    // to wait for if that turn ended before it was queued; look, now and then.
    for (const agentId of queues.keys()) {
      if (runs.has(agentId) || at - (queueChecks.get(agentId) ?? 0) < QUEUE_CHECK_MS) continue;
      queueChecks.set(agentId, at);
      void paseo.agents
        .ref(agentId)
        .refresh()
        .then((live) => {
          if (!runs.has(agentId) && live?.agent.status !== "running") return drain(agentId);
        })
        .catch((error: unknown) => log(`check queue of agent ${agentId}: ${describe(error)}`));
    }
    if (runs.size === 0 && queues.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  // Refreshing a card is no reason to keep a process alive.
  const tick = () => {
    if (!stopped) ticker ??= setInterval(heartbeat, TICK_MS).unref();
  };

  /** Follows the agent's live timeline so the card can say what it is doing. */
  const follow = async (run: Run) => {
    try {
      const subscription = paseo.agents.ref(run.agentId).timeline.subscribe((event) => {
        if (runs.get(run.agentId) !== run) return;
        const inner = event.event;
        if (inner.type === "timeline") {
          if (applyItem(run.progress, inner.item, now(), run.cwd) && run.pending.size === 0) redraw(run);
        } else if (inner.type === "error") {
          log(`timeline of agent ${run.agentId}: ${inner.error}`);
        }
      });
      // The run may have ended, or the plugin stopped, while this was being set up.
      if (runs.get(run.agentId) !== run) {
        subscription();
        return;
      }
      run.unfollow = subscription;
      await Promise.race([subscription.ready, new Promise((resolve) => setTimeout(resolve, FOLLOW_WAIT_MS).unref())]);
    } catch (error) {
      // The card still shows its clock; it just cannot say what the agent is doing.
      log(`follow agent ${run.agentId}: ${describe(error)}`);
    }
  };

  const track = (agentId: string, run: Run): boolean => {
    if (stopped) return false;
    runs.set(agentId, run);
    tick();
    return true;
  };

  /** Stops following `run`; returns it if it was still the agent's current run. */
  const finish = (agentId: string, run?: Run): Run | undefined => {
    const current = runs.get(agentId);
    if (!current || (run && current !== run)) return undefined;
    runs.delete(agentId);
    current.unfollow?.();
    current.unfollow = null;
    settle(current.cardId);
    return current;
  };

  const reply = async (messageId: string, card: object): Promise<string | null> => {
    try {
      return await lark.reply(messageId, card);
    } catch (error) {
      log(`reply to ${messageId}: ${describe(error)}`);
      return null;
    }
  };

  // Messages in one chat are handled one at a time, so two quick messages cannot both find no
  // agent and start two.
  const inChat = (chatId: string, work: () => Promise<void>): Promise<void> => {
    const next = (chatWork.get(chatId) ?? Promise.resolve()).then(work);
    const settled = next.catch(() => undefined);
    chatWork.set(chatId, settled);
    void settled.then(() => {
      if (chatWork.get(chatId) === settled) chatWork.delete(chatId);
    });
    return next;
  };

  /** The chat's current agent: the newest live agent labelled with it. */
  async function currentAgent(chatId: string): Promise<ChatAgent | null> {
    const cached = chats.get(chatId);
    if (cached) return cached;
    const { entries } = await paseo.agents.list({
      filter: { labels: { [CHAT_LABEL]: chatId } },
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 1 },
    });
    const agent = entries[0]?.agent;
    if (!agent) return null;
    const found = { agentId: agent.id, provider: agent.provider, cwd: agent.cwd };
    chats.set(chatId, found);
    return found;
  }

  async function createAgent(chatId: string, chatType: "p2p" | "group", route: Route, messageId: string, title: string) {
    // The ID is chosen here so the agent is known to be isolated before its first session opens.
    const agentId = randomUUID();
    const context = contextOf(route);
    if (context.labels["feishu-claude-md"]) deps.isolate?.(agentId);
    await paseo.agents.create({
      agentId,
      idempotencyKey: `feishu:${messageId}`,
      cwd: route.cwd,
      title,
      config: {
        provider: route.provider,
        modeId: route.modeId,
        thinkingOptionId: route.thinkingOptionId,
        systemPrompt: systemPrompt(route, chatType),
      },
      ...(Object.keys(context.env).length > 0 ? { env: context.env } : {}),
      labels: { source: "feishu", [CHAT_LABEL]: chatId, ...context.labels },
    });
    const chat = { agentId, provider: route.provider, cwd: route.cwd };
    chats.set(chatId, chat);
    return chat;
  }

  async function startAgent(chatId: string, chatType: "p2p" | "group", route: Route, messageId: string, incoming: Incoming) {
    const cardId = await reply(messageId, receivedCard(incoming.summary, true));
    if (!cardId) return;
    const painter = painterFor(cardId);
    let chat: ChatAgent;
    try {
      chat = await createAgent(chatId, chatType, route, messageId, `飞书：${oneLine(incoming.summary).slice(0, 40)}`);
    } catch (error) {
      log(`create agent for ${messageId}: ${describe(error)}`);
      settle(cardId);
      painter.finish(failedCard(incoming.summary, `没能启动 agent：${describe(error)}`));
      return;
    }
    log(`${messageId} -> new agent ${chat.agentId}`);
    // Created without a prompt and then sent one, so the card follows the turn from its start.
    await sendTurn(chat.agentId, {
      chatId,
      messageId,
      incoming,
      provider: chat.provider,
      cwd: chat.cwd,
      cardId,
      painter,
    });
  }

  async function newSession(chatId: string, chatType: "p2p" | "group", route: Route, messageId: string) {
    let chat: ChatAgent;
    try {
      chat = await createAgent(chatId, chatType, route, messageId, "飞书会话");
    } catch (error) {
      log(`create agent for ${messageId}: ${describe(error)}`);
      await reply(messageId, failedCard("/new", `没能开新会话：${describe(error)}`));
      return;
    }
    log(`${messageId} -> new session ${chat.agentId}`);
    await reply(messageId, newSessionCard(route.provider, chat.agentId));
  }

  async function continueAgent(chat: ChatAgent, chatId: string, messageId: string, incoming: Incoming) {
    const cardId = await reply(messageId, receivedCard(incoming.summary, false));
    if (!cardId) return;
    // Asked after the reply, not before: the turn may have ended while the card went out, and
    // a message queued behind a turn that already ended would wait for nothing.
    const live = await paseo.agents
      .ref(chat.agentId)
      .refresh()
      .catch(() => null);
    const running = live?.agent.status === "running";
    const turn: Turn = {
      chatId,
      messageId,
      incoming,
      provider: chat.provider,
      cwd: chat.cwd,
      cardId,
      painter: painterFor(cardId),
    };
    const queue = queues.get(chat.agentId) ?? [];
    // A turn this plugin did not start (someone typing in Paseo) also makes the agent busy.
    if (running || runs.has(chat.agentId) || queue.length > 0) {
      queue.push(turn);
      queues.set(chat.agentId, queue);
      log(`${messageId} queued for agent ${chat.agentId} (${queue.length})`);
      turn.painter.draw(() => queuedCard(incoming.summary, queue.length));
      tick();
      return;
    }
    await sendTurn(chat.agentId, turn);
  }

  async function sendTurn(agentId: string, turn: Turn) {
    const run: Run = {
      request: turn.incoming.summary,
      notes: turn.incoming.problems,
      agentId,
      chatId: turn.chatId,
      cardId: turn.cardId,
      cwd: turn.cwd,
      provider: turn.provider,
      startedAt: now(),
      pending: new Map(),
      decisions: [],
      progress: createProgress(),
      painter: turn.painter,
      unfollow: null,
    };
    if (!track(agentId, run)) return;
    await follow(run);
    try {
      const { prompt, images } = turn.incoming;
      await paseo.agents.ref(agentId).send(prompt, {
        messageId: `feishu:${turn.messageId}`,
        ...(images.length > 0 ? { images } : {}),
      });
    } catch (error) {
      // Only this run: while the send was out, its turn may have ended and the next one begun.
      finish(agentId, run);
      run.unfollow?.();
      settle(run.cardId);
      log(`send ${turn.messageId} to agent ${agentId}: ${describe(error)}`);
      run.painter.finish(
        failedCard(run.request, `发不进这个会话的 agent：${describe(error)}`, {
          run,
          now: now(),
          hint: "发 `/new` 开新会话。",
        }),
      );
      void drain(agentId);
      return;
    }
    log(`${turn.messageId} -> agent ${agentId}`);
    if (runs.get(agentId) === run && run.pending.size === 0) redraw(run);
  }

  async function drain(agentId: string) {
    // The agent's current turn drains the queue when it ends.
    if (stopped || runs.has(agentId)) return;
    const queue = queues.get(agentId);
    const next = queue?.shift();
    if (queue?.length === 0) queues.delete(agentId);
    if (next) await sendTurn(agentId, next);
  }

  /** Admins (senders) and members let in from Feishu may give the agent work. */
  async function mayTalk(settings: Settings, openId: string): Promise<boolean> {
    if (settings.senders.includes(openId)) return true;
    return (await deps.people?.isMember(openId).catch((error: unknown) => {
      log(`members cannot be read: ${describe(error)}`);
      return false;
    })) ?? false;
  }

  async function nameOf(openId: string, chatId: string, messageId: string): Promise<string | null> {
    return (await deps.directory?.resolve(openId, { chatId, messageId }).catch(() => null)) ?? null;
  }

  /**
   * Tells a stranger why nothing happens, at most once in a while per chat. In a group the
   * card carries a button for an admin, and the message waits to be handled once they press it.
   */
  async function turnAway(
    event: Record<string, unknown>,
    who: { senderId: string; name: string | null; chatId: string; chatType: "p2p" | "group"; messageId: string },
  ) {
    if (who.chatType === "group") {
      for (const [id, entry] of held) if (now() - entry.at >= HELD_MAX_AGE_MS) held.delete(id);
      held.set(who.messageId, { event, at: now() });
      while (held.size > HELD_LIMIT) held.delete(held.keys().next().value!);
    }
    const key = `${who.chatId}|${who.senderId}`;
    const told = toldStrangers.get(key);
    if (told !== undefined && now() - told < STRANGER_NOTICE_MS) return;
    toldStrangers.set(key, now());
    const letIn = who.chatType === "group" ? letInName({ openId: who.senderId, messageId: who.messageId }) : null;
    await reply(who.messageId, strangerCard({ name: who.name, letIn }));
  }

  /**
   * The person a 放行 click is for. A button in a form sends its name; one outside a form, like
   * this one, sends only the value it carries (measured: action_name did not match, 2026-09-24).
   */
  function letInOf(event: Record<string, unknown>): { openId: string; messageId: string } | null {
    const named = parseLetInName(text(event.action_name) ?? "");
    if (named) return named;
    const raw = text(event.action_value);
    if (!raw) return null;
    try {
      const value = (JSON.parse(raw) as { letIn?: unknown }).letIn;
      return typeof value === "string" ? parseLetInName(value) : null;
    } catch {
      return null;
    }
  }

  /** An admin pressed 放行 on a stranger card. */
  async function onLetIn(event: Record<string, unknown>, target: { openId: string; messageId: string }) {
    const operator = text(event.operator_id);
    const cardId = text(event.message_id);
    const chatId = text(event.chat_id);
    if (stopped || !operator || !cardId || !chatId) return;
    const eventId = text(event.event_id);
    if (eventId) {
      if (seenActions.has(eventId)) return;
      remember(seenActions, eventId);
    }
    const name = await nameOf(target.openId, chatId, target.messageId);
    const byName = await nameOf(operator, chatId, target.messageId);
    const letIn = letInName(target);
    const refuse = async (why: string, notice: string) => {
      log(`refused ${operator}'s letting ${target.openId} in: ${why}`);
      audit("feishu.people.refused", { openId: target.openId, chatId, cardId, operator, why });
      await lark.patch(cardId, strangerCard({ name, letIn, notice })).catch((error: unknown) => {
        log(`patch ${cardId}: ${describe(error)}`);
      });
    };

    const settings = await readSettings();
    if (!settings || !deps.people) return refuse("members cannot be kept", "现在放行不了，到 Paseo 设置 → 飞书 里看看");
    if (!settings.senders.includes(operator)) {
      return refuse("only admins let people in", `${byName ?? "刚才点的人"}不是管理员，只有管理员能放行。`);
    }
    if (!(await mayTalk(settings, target.openId))) {
      try {
        await deps.people.add({ openId: target.openId, name: name ?? "", by: operator, byName: byName ?? "", chatId, at: now() });
      } catch (error) {
        return refuse(`members cannot be saved: ${describe(error)}`, "放行没存上，到 Paseo 设置 → 飞书 里看看");
      }
      audit("feishu.people.added", { openId: target.openId, name, chatId, cardId, operator, operatorName: byName });
    }
    toldStrangers.delete(`${chatId}|${target.openId}`);
    // The message that raised the card is handled now, as if it had just arrived. It is only
    // kept in memory, so after a restart the card says to send it again instead.
    const waiting = held.get(target.messageId);
    held.delete(target.messageId);
    const replay = waiting !== undefined && now() - waiting.at < HELD_MAX_AGE_MS;
    await lark.patch(cardId, letInCard(name, byName, replay)).catch((error: unknown) => {
      log(`patch ${cardId}: ${describe(error)}`);
    });
    if (replay) {
      seen.delete(target.messageId);
      await onMessage(waiting.event);
    }
  }

  /** Whether a group message @-mentions this bot. */
  async function meantForBot(event: Record<string, unknown>): Promise<boolean> {
    const mentioned = Array.isArray(event.mentions)
      ? event.mentions.map((mention) => (mention as { id?: unknown } | null)?.id)
      : [];
    const botId = deps.botId ? await deps.botId().catch(() => null) : null;
    if (botId) return mentioned.includes(botId);
    // Not knowing its own ID, the bot takes any @ as possibly meant for it: answering an @ that
    // was for someone else beats staying silent when it was for the bot.
    if (!botIdMissingLogged) {
      botIdMissingLogged = true;
      log("this bot's open_id is unknown: any @ in a group is taken as meant for it");
    }
    return mentioned.length > 0;
  }

  function overhear(chatId: string, messageId: string, event: Record<string, unknown>) {
    const kept = (overheard.get(chatId) ?? []).filter((entry) => now() - entry.at < OVERHEARD_MAX_AGE_MS);
    kept.push({ messageId, content: text(event.content) ?? "", mentions: event.mentions, at: now() });
    overheard.set(chatId, kept.slice(-OVERHEARD_LIMIT));
  }

  function takeOverheard(chatId: string): Overheard[] {
    const kept = overheard.get(chatId) ?? [];
    overheard.delete(chatId);
    return kept.filter((entry) => now() - entry.at < OVERHEARD_MAX_AGE_MS);
  }

  async function onMessage(event: Record<string, unknown>): Promise<void> {
    const messageId = text(event.message_id);
    const chatId = text(event.chat_id);
    const senderId = text(event.sender_id);
    if (stopped || event.sender_type !== "user" || !messageId || !chatId || !senderId) return;
    if (seen.has(messageId)) return;
    remember(seen, messageId);

    const settings = await readSettings();
    if (!settings) {
      log(`dropped ${messageId}: settings are invalid`);
      return;
    }
    const chatType = event.chat_type === "group" ? "group" : "p2p";
    if (chatType === "group" && !(await meantForBot(event))) {
      // With 「获取群组中所有消息」 Feishu sends everything said in the group. The bot speaks when
      // @-ed, as a person would; the rest is what it hears in the meantime.
      if (settings.routes.some((candidate) => candidate.chatId === chatId)) overhear(chatId, messageId, event);
      return;
    }
    if (!(await mayTalk(settings, senderId))) {
      // Both IDs are per app, so this line is how an operator finds the values to allow.
      log(`dropped ${messageId} from ${senderId} in ${chatId}: not in senders`);
      const name = await nameOf(senderId, chatId, messageId);
      deps.onStranger?.({ senderId, name, chatId, chatType, why: "sender", at: now() });
      await turnAway(event, { senderId, name, chatId, chatType, messageId });
      return;
    }
    if (deps.directory && !deps.directory.name(senderId)) void nameOf(senderId, chatId, messageId);
    const typed = stripMentions(text(event.content) ?? "", event.mentions);
    const route = settings.routes.find((candidate) => candidate.chatId === chatId);
    if (!route) {
      log(`no route for ${chatId}`);
      deps.onStranger?.({ senderId, name: deps.directory?.name(senderId) ?? null, chatId, chatType, why: "route", at: now() });
      await reply(messageId, noRouteCard(chatId));
      return;
    }
    // Taken now, not when the chat's turn comes: what is said after this @ belongs to the next.
    const heard = takeOverheard(chatId);

    await inChat(chatId, async () => {
      const kind = text(event.message_type) ?? "text";
      const reset = kind === "text" || kind === "post" ? NEW_SESSION.exec(typed) : null;
      if (reset) {
        chats.delete(chatId);
        const rest = reset[1]?.trim() ?? "";
        if (rest === "") await newSession(chatId, chatType, route, messageId);
        else {
          const incoming = await readIncoming(event, { command: NEW_COMMAND, overheard: heard });
          await startAgent(chatId, chatType, route, messageId, incoming);
        }
        return;
      }
      const incoming = await readIncoming(event, { overheard: heard });
      if (incoming.prompt.trim() === "" && incoming.images.length === 0) return;
      const current = await currentAgent(chatId);
      if (current) {
        const live = await paseo.agents.ref(current.agentId).refresh();
        if (live && !live.agent.archivedAt) {
          await continueAgent(current, chatId, messageId, incoming);
          return;
        }
        // Archived or gone: the conversation is over, so this message starts the next one.
        chats.delete(chatId);
      }
      await startAgent(chatId, chatType, route, messageId, incoming);
    });
  }

  function onTurnEnded(event: Event<"agent.turn_ended">): void {
    const run = finish(event.agent.id);
    if (run) {
      // A request still open when its turn ends was never answered.
      for (const [requestId, pending] of run.pending) {
        const answer = answers.get(answerKey(run.agentId, requestId));
        if (answer) {
          clearTimeout(answer.timer);
          answers.delete(answerKey(run.agentId, requestId));
        }
        const decidedAt = now();
        const waitedMs = decidedAt - pending.askedAt;
        const what = describePermission(pending.request);
        run.decisions.push(
          decisionLine({ outcome: "abandoned", label: "", what, operator: null, waitedMs }),
        );
        audit("feishu.approval.decision", {
          agentId: run.agentId,
          requestId,
          chatId: run.chatId,
          outcome: "abandoned",
          approved: false,
          actionId: null,
          askedAt: iso(pending.askedAt),
          decidedAt: iso(decidedAt),
          waitedMs,
          reason: null,
          by: "turn ended",
        });
      }
      run.pending.clear();
      const { outcome } = event;
      const at = now();
      if (outcome.kind === "completed") {
        run.painter.finish(
          doneCard(run, finalAnswer(event.timeline), at),
          lastResortCard(doneTitle(run, at), "green", run),
        );
      } else if (outcome.kind === "failed") {
        run.painter.finish(
          failedCard(run.request, outcome.error.message, { run, now: at }),
          lastResortCard("失败", "red", run),
        );
      } else {
        run.painter.finish(canceledCard(run, outcome.reason, at), lastResortCard("已取消", "grey", run));
      }
    }
    // Whoever started the turn that just ended, the next queued message can go now.
    void drain(event.agent.id).catch((error: unknown) => log(`drain ${event.agent.id}: ${describe(error)}`));
  }

  function onPermissionRequested(event: Event<"agent.permission_requested">): void {
    const run = runs.get(event.agent.id);
    if (!run) return;
    const { request } = event;
    const askedAt = now();
    run.pending.set(request.id, { request, askedAt, notice: null });
    audit("feishu.approval.ask", {
      agentId: run.agentId,
      requestId: request.id,
      chatId: run.chatId,
      cardId: run.cardId,
      tool: request.name,
      requestKind: request.kind,
      title: request.title ?? null,
      what: describePermission(request),
      input: request.input ?? null,
      askedAt: iso(askedAt),
    });
    redraw(run);
  }

  /** A button on a waiting card: someone allowed or denied a request from Feishu. */
  async function onCardAction(event: Record<string, unknown>): Promise<void> {
    const letIn = letInOf(event);
    if (letIn) return onLetIn(event, letIn);
    const target = parseButtonName(text(event.action_name) ?? "");
    if (!target) {
      // A click this plugin cannot place was once dropped without a word, and a button that
      // did nothing looked broken with nothing in the log to say why.
      log(
        `card action not understood: tag=${text(event.action_tag) ?? "-"} name=${text(event.action_name) ?? "-"} value=${(text(event.action_value) ?? "-").slice(0, 200)}`,
      );
      return;
    }
    const operator = text(event.operator_id);
    const cardId = text(event.message_id);
    const chatId = text(event.chat_id);
    if (stopped || !target || !operator || !cardId || !chatId) return;
    const eventId = text(event.event_id);
    if (eventId) {
      if (seenActions.has(eventId)) return;
      remember(seenActions, eventId);
    }
    const { agentId, requestId } = target;
    const key = answerKey(agentId, requestId);
    const refuse = (why: string) => {
      log(`refused ${operator}'s answer to ${requestId} on agent ${agentId}: ${why}`);
      audit("feishu.approval.refused", { agentId, requestId, chatId, cardId, operator, why });
    };

    const settings = await readSettings();
    if (!settings) return refuse("settings are invalid");
    // Whoever may give the agent work may answer it; nobody else.
    if (!settings.senders.includes(operator)) return refuse("not in senders");
    if (answers.has(key)) return refuse("an answer is already on its way");

    // Paseo, not this plugin's memory, says whether the request is still open: the card may be
    // older than a plugin restart, or the request may have been answered in Paseo meanwhile.
    const live = await paseo.agents
      .ref(agentId)
      .refresh()
      .catch(() => null);
    const agent = live?.agent;
    if (!agent || agent.archivedAt) return refuse("the agent is gone");
    if (agent.labels[CHAT_LABEL] !== chatId) return refuse("the card is not in the agent's chat");
    const request = agent.pendingPermissions.find((open) => open.id === requestId);
    const run = runs.get(agentId);
    if (!request) {
      refuse("the request is no longer open");
      // Whatever the card still shows is out of date.
      if (run) redraw(run);
      else if (!settled.has(cardId)) orphan(cardId).draw(() => staleApprovalCard());
      return;
    }
    const action = permissionActions(request)[target.action];
    if (!action) return refuse(`there is no choice ${target.action}`);
    const reason = action.behavior === "deny" ? reasonFrom(event.form_value, target.form) : null;
    const pending = run?.pending.get(requestId);
    const answer: Answer = {
      agentId,
      requestId,
      cardId,
      chatId,
      operator,
      action,
      reason,
      what: describePermission(request),
      askedAt: pending?.askedAt ?? null,
      timer: setTimeout(
        () => fail(key, "Paseo 没有确认这个回答"),
        CONFIRM_MS,
      ).unref(),
    };
    answers.set(key, answer);
    audit("feishu.approval.answer", {
      agentId,
      requestId,
      chatId,
      cardId,
      operator,
      actionId: action.id,
      behavior: action.behavior,
      reason,
    });
    if (run && pending) {
      pending.notice = null;
      redraw(run);
    }
    try {
      await paseo.agents.ref(agentId).respondToPermission({
        requestId,
        response: permissionResponse(action, reason),
      });
    } catch (error) {
      fail(key, `没能提交给 Paseo：${describe(error)}`);
    }
  }

  /** An answer from a card that Paseo did not take: say so on the card and let it be tried again. */
  function fail(key: string, why: string): void {
    const answer = answers.get(key);
    if (!answer) return;
    clearTimeout(answer.timer);
    answers.delete(key);
    log(`answer to ${answer.requestId} on agent ${answer.agentId}: ${why}`);
    audit("feishu.approval.error", {
      agentId: answer.agentId,
      requestId: answer.requestId,
      chatId: answer.chatId,
      cardId: answer.cardId,
      operator: answer.operator,
      actionId: answer.action.id,
      why,
    });
    const run = runs.get(answer.agentId);
    const pending = run?.pending.get(answer.requestId);
    if (run && pending) {
      pending.notice = why;
      redraw(run);
    } else if (!settled.has(answer.cardId)) {
      orphan(answer.cardId).draw(() => answerFailedCard(why));
    }
  }

  function onPermissionResolved(event: Event<"agent.permission_resolved">): void {
    const agentId = event.agent.id;
    const { requestId, resolution } = event;
    const key = answerKey(agentId, requestId);
    const answer = answers.get(key);
    if (answer) {
      clearTimeout(answer.timer);
      answers.delete(key);
    }
    const run = runs.get(agentId);
    const pending = run?.pending.get(requestId);
    if (!pending && !answer) return;

    // Paseo does not say who answered. It was the card's answer if it made the same choice.
    const byCard = answer && resolution.selectedActionId === answer.action.id ? answer : null;
    const askedAt = pending?.askedAt ?? answer?.askedAt ?? null;
    const decidedAt = now();
    const waitedMs = askedAt === null ? null : decidedAt - askedAt;
    const outcome = resolution.behavior === "allow" ? "allowed" : "denied";
    const chosen = pending
      ? permissionActions(pending.request).find((action) => action.id === resolution.selectedActionId)
      : undefined;
    const label = byCard?.action.label ?? chosen?.label ?? (outcome === "allowed" ? "允许" : "拒绝");
    const what = pending ? describePermission(pending.request) : answer!.what;
    const line = decisionLine({ outcome, label, what, operator: byCard?.operator ?? null, waitedMs });
    audit("feishu.approval.decision", {
      agentId,
      requestId,
      chatId: run?.chatId ?? answer?.chatId ?? null,
      outcome,
      approved: outcome === "allowed",
      actionId: resolution.selectedActionId ?? null,
      askedAt: iso(askedAt),
      decidedAt: iso(decidedAt),
      waitedMs,
      reason: resolution.behavior === "deny" ? (resolution.message ?? null) : null,
      by: byCard ? `feishu:${byCard.operator}` : UNATTRIBUTED,
    });

    if (run && pending) {
      run.pending.delete(requestId);
      run.decisions.push(line);
      redraw(run);
    } else if (answer && !settled.has(answer.cardId)) {
      orphan(answer.cardId).draw(() => answeredCard(line));
    }
  }

  // Cards whose last state is already on its way are left to land.
  function stop(): void {
    stopped = true;
    if (ticker) clearInterval(ticker);
    ticker = null;
    for (const answer of answers.values()) clearTimeout(answer.timer);
    answers.clear();
    for (const run of runs.values()) {
      run.unfollow?.();
      run.painter.stop();
    }
    runs.clear();
    for (const queue of queues.values()) for (const turn of queue) turn.painter.stop();
    queues.clear();
    for (const painter of orphans.values()) painter.stop();
    orphans.clear();
  }

  return {
    onMessage,
    onCardAction,
    onTurnEnded,
    onPermissionRequested,
    onPermissionResolved,
    /** Redraws running cards whose clock is due; runs on a timer, exposed for tests. */
    heartbeat,
    stop,
  };
}

function answerKey(agentId: string, requestId: string): string {
  return `${agentId}\n${requestId}`;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export type Dispatcher = ReturnType<typeof createDispatcher>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function remember(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size > REMEMBERED_MESSAGES) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
