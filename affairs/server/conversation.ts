import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPermissionRequest,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { CARD_ID, CARD_KIND, CARD_VERSION, LINE_KIND, LINE_VERSION, type Card } from "../shared/card";

// The conversation of one affair: a provider with no model. Its timeline is drawn from the affair's log, never from
// what was said to it before: the card on top (one id, so every new version replaces the last), one line per thing
// that happened, and each open question as the app's own "needs you" request. What is typed in it is said to the
// affair. After a restart the same lines are drawn again under the same ids.

export const PROVIDER_ID = "affairs";
export const MODEL_ID = "conversation";
const CAPABILITIES = ["prompt.message", "prompt.steer", "permission", "session.persistence"] as const;
export const ACK = "收到，看一下…";
const BOOT = /^事项 (\S+)/;

export interface Row {
  key: string;
  text: string;
  /** Said by the person (drawn as theirs). */
  own: boolean;
  tone: string;
  detail: string;
}
export interface OpenAsk {
  id: string;
  title: string;
  line: string;
  options: string[];
}
export interface View {
  card: Card;
  rows: Row[];
  asks: OpenAsk[];
}
export interface ConversationDeps {
  view(affairId: string): View | null;
  /** The person typed in the conversation. */
  said(affairId: string, text: string): Promise<void>;
  /** The person answered a question in the app (a choice, or what they typed under "other"). */
  answered(affairId: string, askId: string, text: string): Promise<void>;
}

interface Session {
  affairId: string | null;
  card: string;
  rows: Map<string, string>;
  asks: Map<string, string>;
  turn: string | null;
  turns: number;
  ack: string | null;
}

export function questionRequest(ask: OpenAsk, permissionId: string): ProviderPermissionRequest {
  return {
    id: permissionId,
    name: "事项",
    kind: "question",
    title: ask.title,
    description: ask.line,
    input: { questions: [{ question: ask.line ? `${ask.title}\n${ask.line}` : ask.title, header: ask.id, options: ask.options.map((label) => ({ label, description: "" })), multiSelect: false, allowOther: true }] },
    metadata: { askId: ask.id },
  };
}

const answerOf = (updatedInput: unknown): string | null => {
  const answers = (updatedInput as { answers?: Record<string, unknown> } | undefined)?.answers;
  const first = answers && typeof answers === "object" ? Object.values(answers)[0] : undefined;
  return typeof first === "string" ? first : null;
};

const textOf = (input: Extract<ProviderInput, { type: "session.prompt" }>) =>
  input.prompt.input.type === "message"
    ? input.prompt.input.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n")
    : `/${input.prompt.input.name} ${input.prompt.input.arguments}`.trim();

export function createConversations(deps: ConversationDeps) {
  const connections = new Set<{ sync(affairId: string, force?: boolean): void }>();

  const registration: ProviderRegistration = {
    id: PROVIDER_ID,
    label: "事项",
    description: "The conversation of an affair; no model",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return connect(negotiateProviderCapabilities(request.capabilities, CAPABILITIES));
    },
  };

  function connect(capabilities: readonly string[]): ProviderConnection {
    const listeners = new Set<(event: ProviderEvent) => void>();
    const sessions = new Map<string, Session>();
    let closed = false;
    let queue = Promise.resolve();
    const emit = (event: ProviderEvent) => {
      if (!closed) for (const listener of listeners) listener(event);
    };

    function startTurn(sessionId: string, session: Session) {
      session.turns += 1;
      session.turn = `turn-${session.turns}`;
      emit({ type: "session.turn", sessionId, turnId: session.turn, state: "started" });
    }
    function endTurn(sessionId: string, session: Session) {
      if (!session.turn) return;
      emit({ type: "session.turn", sessionId, turnId: session.turn, state: "completed" });
      session.turn = null;
    }

    /** `force`: draw the card and the lines again even if they look the same as last time (what was drawn while the conversation was still being made may not have reached the app). */
    function sync(sessionId: string, force = false) {
      const session = sessions.get(sessionId);
      if (!session?.affairId) return;
      if (force) {
        session.card = "";
        session.rows.clear();
      }
      const view = deps.view(session.affairId);
      if (!view) return;
      const card = JSON.stringify(view.card);
      if (card !== session.card) {
        session.card = card;
        emit({ type: "timeline.item", sessionId, item: { type: "plugin", id: CARD_ID, pluginId: "affairs", kind: CARD_KIND, version: CARD_VERSION, data: view.card } });
      }
      for (const row of view.rows) {
        if (session.rows.get(row.key) === row.text) continue;
        session.rows.set(row.key, row.text);
        // A line that answers the "收到，看一下…" the person was told takes its place.
        const id = !row.own && session.ack ? session.ack : `row-${row.key}`;
        if (!row.own) session.ack = null;
        emit({ type: "timeline.item", sessionId, item: row.own ? { type: "user_message", id, text: row.text } : { type: "plugin", id, pluginId: "affairs", kind: LINE_KIND, version: LINE_VERSION, data: { text: row.text, tone: row.tone === "red" ? "red" : "normal", detail: row.detail } } });
      }
      const open = new Set(view.asks.map((a) => a.id));
      for (const ask of view.asks) {
        if (session.asks.has(ask.id)) continue;
        if (!session.turn) startTurn(sessionId, session);
        const permissionId = `ask-${ask.id}`;
        session.asks.set(ask.id, permissionId);
        emit({ type: "session.permission", sessionId, request: questionRequest(ask, permissionId) });
      }
      for (const [askId, permissionId] of session.asks) {
        if (open.has(askId)) continue;
        session.asks.delete(askId);
        emit({ type: "session.permission_resolved", sessionId, permissionId });
      }
      if (session.asks.size === 0) endTurn(sessionId, session);
    }

    const handle = { sync: (affairId: string, force = false) => sessions.forEach((s, id) => s.affairId === affairId && sync(id, force)) };
    connections.add(handle);

    async function dispatch(input: ProviderInput): Promise<void> {
      switch (input.type) {
        case "catalog":
          emit({ type: "catalog", requestId: input.requestId, catalog: { models: [{ id: MODEL_ID, label: "事项", isDefault: true }], modes: [], defaultModel: MODEL_ID } });
          return;
        case "sessions":
          emit({ type: "sessions", requestId: input.requestId, sessions: [] });
          return;
        case "session.open": {
          // A conversation outlives the daemon: what it needs to be drawn again is the affair it belongs to.
          const kept = (input.persistence?.data as { affairId?: string } | undefined)?.affairId;
          const affairId = kept ?? input.config.env.AFFAIR_ID ?? null;
          sessions.set(input.sessionId, { affairId, card: "", rows: new Map(), asks: new Map(), turn: null, turns: 0, ack: null });
          emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities, restoration: "core", ...(affairId ? { persistence: { version: 1, data: { affairId } } } : {}), title: input.config.title, cwd: input.config.cwd });
          emit({ type: "session.config", sessionId: input.sessionId, config: { model: MODEL_ID, models: [{ id: MODEL_ID, label: "事项" }], modes: [], thinkingOptions: [], settings: [] } });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          sync(input.sessionId);
          return;
        }
        case "session.prompt": {
          const session = sessions.get(input.sessionId);
          if (!session) return;
          const text = textOf(input).trim();
          const boot = BOOT.exec(text);
          if (boot && !session.affairId) session.affairId = boot[1]!;
          const affairId = session.affairId;
          if (input.prompt.delivery === "steer") {
            const [first] = session.asks.keys();
            if (!first || !affairId) {
              emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message: "There is no active turn to steer" } } });
              return;
            }
            emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "steer", turnId: session.turn ?? "turn-0" } });
            await deps.answered(affairId, first, text);
            return;
          }
          const isTurnOpen = Boolean(session.turn);
          if (!isTurnOpen) startTurn(input.sessionId, session);
          emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId: session.turn! } });
          if (affairId && !boot && text) {
            session.ack = `ack-${session.turns}-${Date.now()}`;
            emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", id: session.ack, pluginId: "affairs", kind: LINE_KIND, version: LINE_VERSION, data: { text: ACK, tone: "normal", detail: "" } } });
            await deps.said(affairId, text);
          }
          sync(input.sessionId);
          if (!isTurnOpen && session.asks.size === 0) endTurn(input.sessionId, session);
          return;
        }
        case "session.permission": {
          const session = sessions.get(input.sessionId);
          const entry = [...(session?.asks ?? [])].find(([, permissionId]) => permissionId === input.permissionId);
          if (!session?.affairId || !entry) return;
          const text = input.response.behavior === "allow" ? answerOf(input.response.updatedInput) : null;
          if (text) await deps.answered(session.affairId, entry[0], text);
          else emit({ type: "session.permission_resolved", sessionId: input.sessionId, permissionId: input.permissionId });
          return;
        }
        case "session.interrupt":
          emit({ type: "request.completed", requestId: input.requestId });
          return;
        case "session.configure":
        case "session.revert":
        case "session.archive":
        case "session.unarchive":
          emit({ type: "request.completed", requestId: input.requestId });
          return;
        case "session.close":
          sessions.delete(input.sessionId);
          emit({ type: "session.closed", sessionId: input.sessionId });
          emit({ type: "request.completed", requestId: input.requestId });
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
          console.error(`affairs: ${input.type} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async close() {
        closed = true;
        connections.delete(handle);
        sessions.clear();
        listeners.clear();
      },
    };
  }

  return { registration, refresh: (affairId: string, force = false) => connections.forEach((c) => c.sync(affairId, force)), has: () => connections.size > 0 };
}
