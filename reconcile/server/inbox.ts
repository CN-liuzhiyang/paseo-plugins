import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPermissionRequest,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { CardAnswer, CardContent } from "./engine";

// The carrier of a question card: a provider with no model. The engine starts one agent per
// card, with the card id as its prompt; this provider shows what is known above the question
// and raises one `question` permission request, which the app renders as its native question
// form (choices plus a free-text "other") and pushes to the phone. The answer goes straight
// back to the engine. Sessions live in this process only: after a restart the engine starts a
// new carrier for every card still open.
//
// A session closed under a card waiting for its answer is either a person archiving that card
// or Paseo shutting down, which closes every agent and then this provider's connection. So a
// close counts as the person's only after closeGraceMs without the connection closing; on a
// shutdown the card stays open and gets a new carrier after the restart. The grace is long: on a
// shutdown the host closes the agents, drains events and flushes storage before it closes the
// connection, which can take more than a few seconds; and the plugin process ends with the host,
// so a long timer costs nothing then. A person's close shows on the page that much later.

export const PROVIDER_ID = "reconcile";
export const MODEL_ID = "inbox";
const CAPABILITIES = ["prompt.message", "prompt.steer", "permission"] as const;
export const CLOSE_GRACE_MS = 90_000;

export interface InboxDeps {
  card(cardId: string): CardContent | null;
  answer(cardId: string, answer: CardAnswer): string;
}

interface Session {
  turns: number;
  waiting: { turnId: string; permissionId: string; cardId: string } | null;
  done: boolean;
}

const CARD_ID = /\bcard_[0-9a-f]{6,}\b/;

export function cardPrompt(cardId: string): string {
  return `事务问题卡 ${cardId}`;
}

export function questionRequest(cardId: string, content: CardContent, permissionId: string): ProviderPermissionRequest {
  return {
    id: permissionId,
    name: "事务",
    kind: "question",
    title: content.title,
    description: "选一个答案；选项都不对就写在「其他」里。收起不算回答，到时候会再问。",
    input: {
      questions: content.questions.map((q) => ({
        question: q.question,
        header: q.header,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
        multiSelect: false,
        allowOther: q.allowOther,
      })),
    },
    metadata: { cardId },
  };
}

/** The app answers a question form with `updatedInput.answers`: header -> chosen label or the typed "other". */
export function answersOf(updatedInput: unknown): Record<string, string> | null {
  const answers = (updatedInput as { answers?: unknown } | undefined)?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const out: Record<string, string> = {};
  for (const [header, value] of Object.entries(answers)) if (typeof value === "string") out[header] = value;
  return out;
}

const promptText = (input: Extract<ProviderInput, { type: "session.prompt" }>) =>
  input.prompt.input.type === "message"
    ? input.prompt.input.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    : `/${input.prompt.input.name} ${input.prompt.input.arguments}`.trim();

export function createInboxProvider(deps: InboxDeps, options: { closeGraceMs?: number } = {}): ProviderRegistration {
  const closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
  return {
    id: PROVIDER_ID,
    label: "事务",
    description: "Question cards from the reconcile controller; no model",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES), deps, closeGraceMs);
    },
  };
}

function createConnection(capabilities: readonly string[], deps: InboxDeps, closeGraceMs: number): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  /** Cards whose session closed, to be told closed unless the connection closes first. */
  const closing = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  let queue = Promise.resolve();
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };
  const say = (sessionId: string, id: string, text: string) => emit({ type: "timeline.item", sessionId, item: { type: "assistant_message", id, text } });

  function settle(sessionId: string, session: Session, answer: CardAnswer) {
    const waiting = session.waiting;
    if (!waiting) return;
    session.waiting = null;
    session.done = true;
    let reply: string;
    try {
      reply = deps.answer(waiting.cardId, answer);
    } catch (error) {
      reply = `没能记下这次回答：${(error as Error).message}`;
    }
    emit({ type: "session.permission_resolved", sessionId, permissionId: waiting.permissionId });
    if (reply) say(sessionId, `answer-${waiting.turnId}`, reply);
    emit({ type: "session.turn", sessionId, turnId: waiting.turnId, state: "completed" });
  }

  function start(sessionId: string, session: Session, input: Extract<ProviderInput, { type: "session.prompt" }>) {
    session.turns += 1;
    const turnId = `turn-${session.turns}`;
    const text = promptText(input);
    emit({ type: "timeline.item", sessionId, item: { type: "user_message", id: `user-${session.turns}`, text, clientMessageId: input.prompt.clientMessageId } });
    emit({ type: "session.prompt_result", sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
    emit({ type: "session.turn", sessionId, turnId, state: "started" });
    const cardId = CARD_ID.exec(text)?.[0] ?? null;
    const content = !session.done && cardId ? deps.card(cardId) : null;
    if (!cardId || !content) {
      say(sessionId, `closed-${turnId}`, session.done ? "这张卡已经答过了，这里不再接受回复。" : "这张卡已经结束了（答过、过期，或者被新卡替换），这里没有要回答的。");
      emit({ type: "session.turn", sessionId, turnId, state: "completed" });
      return;
    }
    say(sessionId, `brief-${turnId}`, content.brief);
    const permissionId = `ask-${cardId}-${session.turns}`;
    session.waiting = { turnId, permissionId, cardId };
    emit({ type: "session.permission", sessionId, request: questionRequest(cardId, content, permissionId) });
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        emit({ type: "catalog", requestId: input.requestId, catalog: { models: [{ id: MODEL_ID, label: "问题卡", isDefault: true }], modes: [], defaultModel: MODEL_ID } });
        return;
      case "sessions":
        emit({ type: "sessions", requestId: input.requestId, sessions: [] });
        return;
      case "session.open":
        sessions.set(input.sessionId, { turns: 0, waiting: null, done: false });
        emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities, restoration: "core", title: input.config.title, cwd: input.config.cwd });
        emit({ type: "session.config", sessionId: input.sessionId, config: { model: MODEL_ID, models: [{ id: MODEL_ID, label: "问题卡" }], modes: [], thinkingOptions: [], settings: [] } });
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        return;
      case "session.prompt": {
        const session = sessions.get(input.sessionId);
        if (!session) return;
        if (input.prompt.delivery === "steer") {
          if (!session.waiting) {
            emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message: "There is no active turn to steer" } } });
            return;
          }
          emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "steer", turnId: session.waiting.turnId } });
          settle(input.sessionId, session, { kind: "typed", text: promptText(input).trim() });
          return;
        }
        start(input.sessionId, session, input);
        return;
      }
      case "session.permission": {
        const session = sessions.get(input.sessionId);
        if (!session?.waiting || session.waiting.permissionId !== input.permissionId) return;
        const { response } = input;
        if (response.behavior === "allow") {
          const answers = answersOf(response.updatedInput);
          settle(input.sessionId, session, answers ? { kind: "answers", answers, via: "form" } : { kind: "dismissed", via: "allow-without-answers" });
        } else {
          settle(input.sessionId, session, { kind: "dismissed", via: response.selectedActionId ?? "deny" });
        }
        return;
      }
      case "session.interrupt": {
        const session = sessions.get(input.sessionId);
        if (session?.waiting) settle(input.sessionId, session, { kind: "dismissed", via: "interrupt" });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.configure":
      case "session.revert":
      case "session.archive":
      case "session.unarchive":
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.close": {
        const session = sessions.get(input.sessionId);
        if (session?.waiting) {
          const { cardId, permissionId } = session.waiting;
          session.waiting = null;
          const timer = setTimeout(() => {
            closing.delete(timer);
            try {
              deps.answer(cardId, { kind: "closed" });
            } catch {
              // The engine may be stopping too.
            }
          }, closeGraceMs);
          timer.unref?.();
          closing.add(timer);
          emit({ type: "session.permission_resolved", sessionId: input.sessionId, permissionId });
        }
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        emit({ type: "request.completed", requestId: input.requestId });
      }
    }
  }

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      requireProviderCapabilities(capabilities, input);
      if ("sessionId" in input && input.type !== "session.open" && !sessions.has(input.sessionId)) throw new Error(`Unknown session: ${input.sessionId}`);
      queue = queue.then(() => (closed ? undefined : dispatch(input))).catch((error: unknown) => {
        console.error(`reconcile: ${input.type} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      // Paseo is going away: the cards whose sessions it just closed are not the person's doing.
      for (const timer of closing) clearTimeout(timer);
      closing.clear();
      sessions.clear();
      listeners.clear();
    },
  };
}
