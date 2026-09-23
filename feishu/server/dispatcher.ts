import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { AgentPermissionAction, AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { Audit } from "./audit";
import {
  answerFailedCard,
  answeredCard,
  canceledCard,
  decisionLine,
  doneCard,
  failedCard,
  newSessionCard,
  noRouteCard,
  queuedCard,
  receivedCard,
  runningCard,
  staleApprovalCard,
  waitingCard,
  type ApprovalView,
  type RunView,
} from "./cards";
import { patchCard, replyCard, type LarkCli } from "./lark";
import {
  parseButtonName,
  permissionActions,
  permissionResponse,
  reasonFrom,
  requestDetail,
} from "./permissions";
import type { Route, Settings } from "./settings";
import { describePermission, finalAnswer } from "./timeline";

const TICK_MS = 30_000;
const REMEMBERED_MESSAGES = 1_000;
// How long an answer sent from a card may go without Paseo confirming it.
const CONFIRM_MS = 15_000;
const REMEMBERED_ORPHANS = 100;
// Worded like the orchestration runtime's gate, which has the same blind spot.
const UNATTRIBUTED = "paseo (unattributed: Paseo does not record who answered)";
// Marks the agent that holds a chat's conversation. It lives on the agent in Paseo's own
// registry, so the conversation survives plugin reloads and daemon restarts.
export const CHAT_LABEL = "feishu-chat";
const NEW_SESSION = /^\/new(?:\s+([\s\S]*))?$/;

interface Pending {
  request: AgentPermissionRequest;
  askedAt: number;
  /** Why the last answer from the card did not go through, shown until the next one. */
  notice: string | null;
}

interface Run extends RunView {
  chatId: string;
  cardId: string;
  pending: Map<string, Pending>;
  decisions: string[];
  // Patches to one card go out in order, so a late "running" tick never lands on top of "done".
  chain: Promise<void>;
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
  request: string;
  provider: string;
  cardId: string;
  chain: Promise<void>;
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

/**
 * One Feishu chat is one conversation with one agent. The first message in a routed chat starts
 * the agent; later messages go to the same agent in order, queued while it is busy. `/new`
 * starts a fresh agent for the chat. Every message gets its own card, patched in place from the
 * agent's lifecycle events until that message's turn ends.
 */
export function createDispatcher(deps: {
  paseo: Pick<PaseoApi, "agents">;
  lark: Lark;
  readSettings: () => Promise<Settings | null>;
  log: (line: string) => void;
  audit: Audit;
  now?: () => number;
}) {
  const { paseo, lark, readSettings, log, audit } = deps;
  const now = deps.now ?? Date.now;
  const seen = new Set<string>();
  const seenActions = new Set<string>();
  const runs = new Map<string, Run>();
  const answers = new Map<string, Answer>();
  // Cards whose run is no longer followed, as after a restart; their patches stay in order too.
  const orphans = new Map<string, { cardId: string; chain: Promise<void> }>();
  const queues = new Map<string, Turn[]>();
  const chats = new Map<string, { agentId: string; provider: string }>();
  const chatWork = new Map<string, Promise<void>>();
  let ticker: NodeJS.Timeout | null = null;

  const update = (run: { cardId: string; chain: Promise<void> }, card: object) => {
    run.chain = run.chain
      .then(() => lark.patch(run.cardId, card))
      .catch((error: unknown) => log(`card ${run.cardId}: ${describe(error)}`));
  };

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

  const orphan = (cardId: string) => {
    let entry = orphans.get(cardId);
    if (!entry) {
      entry = { cardId, chain: Promise.resolve() };
      orphans.set(cardId, entry);
      const oldest = orphans.keys().next().value;
      if (orphans.size > REMEMBERED_ORPHANS && oldest !== undefined) orphans.delete(oldest);
    }
    return entry;
  };

  const tick = () => {
    for (const run of runs.values()) {
      if (run.pending.size === 0) update(run, runningCard(run, now()));
    }
  };

  const track = (agentId: string, run: Run) => {
    runs.set(agentId, run);
    // Refreshing a card is no reason to keep a process alive.
    ticker ??= setInterval(tick, TICK_MS).unref();
  };

  const finish = (agentId: string): Run | undefined => {
    const run = runs.get(agentId);
    if (!run) return undefined;
    runs.delete(agentId);
    if (runs.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    return run;
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
  async function currentAgent(chatId: string): Promise<{ agentId: string; provider: string } | null> {
    const cached = chats.get(chatId);
    if (cached) return cached;
    const { entries } = await paseo.agents.list({
      filter: { labels: { [CHAT_LABEL]: chatId } },
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 1 },
    });
    const agent = entries[0]?.agent;
    if (!agent) return null;
    const found = { agentId: agent.id, provider: agent.provider };
    chats.set(chatId, found);
    return found;
  }

  async function startAgent(chatId: string, route: Route, messageId: string, request: string) {
    const cardId = await reply(messageId, receivedCard(request, true));
    if (!cardId) return;
    // The ID is chosen here so the run is tracked before the agent exists: a turn that ends
    // before create() returns still finds its card.
    const agentId = randomUUID();
    const run = newRun(agentId, chatId, route.provider, request, cardId);
    track(agentId, run);
    try {
      await paseo.agents.create({
        ...creation(chatId, route, messageId, agentId),
        title: `飞书：${oneLine(request).slice(0, 40)}`,
        prompt: request,
      });
    } catch (error) {
      finish(agentId);
      log(`create agent for ${messageId}: ${describe(error)}`);
      update(run, failedCard(request, `没能启动 agent：${describe(error)}`));
      return;
    }
    chats.set(chatId, { agentId, provider: route.provider });
    log(`${messageId} -> new agent ${agentId}`);
    if (runs.get(agentId) === run && run.pending.size === 0) update(run, runningCard(run, now()));
  }

  async function newSession(chatId: string, route: Route, messageId: string) {
    const agentId = randomUUID();
    try {
      // No prompt: the agent exists, and is the newest for the chat, before anything is asked.
      await paseo.agents.create({ ...creation(chatId, route, messageId, agentId), title: "飞书会话" });
    } catch (error) {
      log(`create agent for ${messageId}: ${describe(error)}`);
      await reply(messageId, failedCard("/new", `没能开新会话：${describe(error)}`));
      return;
    }
    chats.set(chatId, { agentId, provider: route.provider });
    log(`${messageId} -> new session ${agentId}`);
    await reply(messageId, newSessionCard(route.provider, agentId));
  }

  async function continueAgent(
    agentId: string,
    chatId: string,
    provider: string,
    messageId: string,
    request: string,
    running: boolean,
  ) {
    const cardId = await reply(messageId, receivedCard(request, false));
    if (!cardId) return;
    const turn: Turn = { chatId, messageId, request, provider, cardId, chain: Promise.resolve() };
    const queue = queues.get(agentId) ?? [];
    // A turn this plugin did not start (someone typing in Paseo) also makes the agent busy.
    if (running || runs.has(agentId) || queue.length > 0) {
      queue.push(turn);
      queues.set(agentId, queue);
      log(`${messageId} queued for agent ${agentId} (${queue.length})`);
      update(turn, queuedCard(request, queue.length));
      return;
    }
    await sendTurn(agentId, turn);
  }

  async function sendTurn(agentId: string, turn: Turn) {
    const run = newRun(agentId, turn.chatId, turn.provider, turn.request, turn.cardId, turn.chain);
    track(agentId, run);
    try {
      await paseo.agents.ref(agentId).send(turn.request, { messageId: `feishu:${turn.messageId}` });
    } catch (error) {
      finish(agentId);
      log(`send ${turn.messageId} to agent ${agentId}: ${describe(error)}`);
      update(run, failedCard(turn.request, `发不进这个会话的 agent：${describe(error)}\n\n发 \`/new\` 开新会话。`, run));
      void drain(agentId);
      return;
    }
    log(`${turn.messageId} -> agent ${agentId}`);
    if (runs.get(agentId) === run && run.pending.size === 0) update(run, runningCard(run, now()));
  }

  async function drain(agentId: string) {
    const queue = queues.get(agentId);
    const next = queue?.shift();
    if (queue?.length === 0) queues.delete(agentId);
    if (next) await sendTurn(agentId, next);
  }

  async function onMessage(event: Record<string, unknown>): Promise<void> {
    const messageId = text(event.message_id);
    const chatId = text(event.chat_id);
    const senderId = text(event.sender_id);
    if (event.sender_type !== "user" || !messageId || !chatId || !senderId) return;
    if (seen.has(messageId)) return;
    remember(seen, messageId);

    const settings = await readSettings();
    if (!settings) {
      log(`dropped ${messageId}: settings are invalid`);
      return;
    }
    if (!settings.senders.includes(senderId)) {
      // Both IDs are per app, so this line is how an operator finds the values to allow.
      log(`dropped ${messageId} from ${senderId} in ${chatId}: not in senders`);
      return;
    }
    const request = stripMentions(text(event.content) ?? "", event.mentions);
    if (request === "") return;
    const route = settings.routes.find((candidate) => candidate.chatId === chatId);
    if (!route) {
      log(`no route for ${chatId}`);
      await reply(messageId, noRouteCard(chatId));
      return;
    }

    await inChat(chatId, async () => {
      const reset = NEW_SESSION.exec(request);
      if (reset) {
        chats.delete(chatId);
        const prompt = reset[1]?.trim() ?? "";
        if (prompt === "") await newSession(chatId, route, messageId);
        else await startAgent(chatId, route, messageId, prompt);
        return;
      }
      const current = await currentAgent(chatId);
      if (current) {
        const live = await paseo.agents.ref(current.agentId).refresh();
        if (live && !live.agent.archivedAt) {
          const running = live.agent.status === "running";
          await continueAgent(current.agentId, chatId, current.provider, messageId, request, running);
          return;
        }
        // Archived or gone: the conversation is over, so this message starts the next one.
        chats.delete(chatId);
      }
      await startAgent(chatId, route, messageId, request);
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
      if (outcome.kind === "completed") {
        update(run, doneCard(run, finalAnswer(event.timeline), now()));
      } else if (outcome.kind === "failed") {
        update(run, failedCard(run.request, outcome.error.message, run));
      } else {
        update(run, canceledCard(run, outcome.reason));
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
    update(run, render(run));
  }

  /** A button on a waiting card: someone allowed or denied a request from Feishu. */
  async function onCardAction(event: Record<string, unknown>): Promise<void> {
    const target = parseButtonName(text(event.action_name) ?? "");
    const operator = text(event.operator_id);
    const cardId = text(event.message_id);
    const chatId = text(event.chat_id);
    if (!target || !operator || !cardId || !chatId) return;
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
      if (run) update(run, render(run));
      else update(orphan(cardId), staleApprovalCard());
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
      update(run, render(run));
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
      update(run, render(run));
    } else {
      update(orphan(answer.cardId), answerFailedCard(why));
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
      update(run, render(run));
    } else if (answer) {
      update(orphan(answer.cardId), answeredCard(line));
    }
  }

  function stop(): void {
    if (ticker) clearInterval(ticker);
    ticker = null;
    for (const answer of answers.values()) clearTimeout(answer.timer);
    answers.clear();
    runs.clear();
    queues.clear();
  }

  function newRun(
    agentId: string,
    chatId: string,
    provider: string,
    request: string,
    cardId: string,
    chain = Promise.resolve(),
  ): Run {
    return {
      request,
      agentId,
      chatId,
      provider,
      startedAt: now(),
      cardId,
      pending: new Map(),
      decisions: [],
      chain,
    };
  }

  return {
    onMessage,
    onCardAction,
    onTurnEnded,
    onPermissionRequested,
    onPermissionResolved,
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

function creation(chatId: string, route: Route, messageId: string, agentId: string) {
  return {
    agentId,
    idempotencyKey: `feishu:${messageId}`,
    cwd: route.cwd,
    config: {
      provider: route.provider,
      modeId: route.modeId,
      thinkingOptionId: route.thinkingOptionId,
    },
    labels: { source: "feishu", [CHAT_LABEL]: chatId },
  };
}

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

/** Removes the `@_user_1` placeholders Feishu puts where a message mentions someone. */
export function stripMentions(content: string, mentions: unknown): string {
  let stripped = content;
  if (Array.isArray(mentions)) {
    for (const mention of mentions) {
      const key = (mention as { key?: unknown } | null)?.key;
      if (typeof key === "string" && key !== "") stripped = stripped.split(key).join("");
    }
  }
  return stripped.trim();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
