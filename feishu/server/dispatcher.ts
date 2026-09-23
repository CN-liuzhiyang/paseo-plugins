import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import {
  canceledCard,
  doneCard,
  failedCard,
  noRouteCard,
  receivedCard,
  runningCard,
  waitingCard,
  type RunView,
} from "./cards";
import { patchCard, replyCard, type LarkCli } from "./lark";
import type { Settings } from "./settings";
import { describePermission, finalAnswer } from "./timeline";

const TICK_MS = 30_000;
const REMEMBERED_MESSAGES = 1_000;

interface Run extends RunView {
  cardId: string;
  pending: Set<string>;
  // Patches to one card go out in order, so a late "running" tick never lands on top of "done".
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
 * Receives Feishu messages, checks the sender and the route, starts one agent per message, and
 * keeps that message's card current from the agent's lifecycle events. It holds no state that
 * matters across restarts: a run whose plugin restarted mid-turn just keeps its last card.
 */
export function createDispatcher(deps: {
  paseo: Pick<PaseoApi, "agents">;
  lark: Lark;
  readSettings: () => Promise<Settings | null>;
  log: (line: string) => void;
  now?: () => number;
}) {
  const { paseo, lark, readSettings, log } = deps;
  const now = deps.now ?? Date.now;
  const seen = new Set<string>();
  const runs = new Map<string, Run>();
  let ticker: NodeJS.Timeout | null = null;

  const update = (run: Run, card: object) => {
    run.chain = run.chain
      .then(() => lark.patch(run.cardId, card))
      .catch((error: unknown) => log(`card ${run.cardId}: ${describe(error)}`));
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
      await lark.reply(messageId, noRouteCard(chatId)).catch((error: unknown) => {
        log(`reply to ${messageId}: ${describe(error)}`);
      });
      return;
    }

    let cardId: string;
    try {
      cardId = await lark.reply(messageId, receivedCard(request));
    } catch (error) {
      log(`reply to ${messageId}: ${describe(error)}`);
      return;
    }
    // The ID is chosen here so the run is tracked before the agent exists: a turn that ends
    // before create() returns still finds its card.
    const agentId = randomUUID();
    const run: Run = {
      request,
      agentId,
      provider: route.provider,
      startedAt: now(),
      cardId,
      pending: new Set(),
      chain: Promise.resolve(),
    };
    track(agentId, run);
    try {
      await paseo.agents.create({
        agentId,
        idempotencyKey: `feishu:${messageId}`,
        cwd: route.cwd,
        config: {
          provider: route.provider,
          modeId: route.modeId,
          thinkingOptionId: route.thinkingOptionId,
        },
        title: `飞书：${request.replace(/\s+/g, " ").slice(0, 40)}`,
        prompt: request,
        labels: { source: "feishu" },
      });
    } catch (error) {
      finish(agentId);
      log(`create agent for ${messageId}: ${describe(error)}`);
      update(run, failedCard(request, `没能启动 agent：${describe(error)}`));
      return;
    }
    log(`${messageId} -> agent ${agentId}`);
    if (runs.has(agentId) && run.pending.size === 0) update(run, runningCard(run, now()));
  }

  function onTurnEnded(event: Event<"agent.turn_ended">): void {
    const run = finish(event.agent.id);
    if (!run) return;
    const { outcome } = event;
    if (outcome.kind === "completed") {
      update(run, doneCard(run, finalAnswer(event.timeline), now()));
    } else if (outcome.kind === "failed") {
      update(run, failedCard(run.request, outcome.error.message, run));
    } else {
      update(run, canceledCard(run, outcome.reason));
    }
  }

  function onPermissionRequested(event: Event<"agent.permission_requested">): void {
    const run = runs.get(event.agent.id);
    if (!run) return;
    run.pending.add(event.request.id);
    update(run, waitingCard(run, describePermission(event.request)));
  }

  function onPermissionResolved(event: Event<"agent.permission_resolved">): void {
    const run = runs.get(event.agent.id);
    if (!run || !run.pending.delete(event.requestId)) return;
    if (run.pending.size === 0) update(run, runningCard(run, now()));
  }

  function stop(): void {
    if (ticker) clearInterval(ticker);
    ticker = null;
    runs.clear();
  }

  return { onMessage, onTurnEnded, onPermissionRequested, onPermissionResolved, stop };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
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
