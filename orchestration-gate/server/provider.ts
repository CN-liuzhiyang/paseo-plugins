import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPermissionRequest,
  type ProviderPermissionResponse,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { readRequest, RequestError, type GateRequest } from "./request";

// The human gate's carrier, with no model. The orchestration runtime starts it
// with `paseo run --provider orch-gate/card` and a prompt that points at a gate
// request. It shows the decision as a Paseo permission card -- title, a short
// description, the content, and two buttons -- with the brief and the evidence
// above it, and writes the receipt the runtime asked for only after an allow.
// Whatever the answer, it records how it came in the answer file.
//
// It decides nothing. The runtime decides from the receipt file alone; the
// answer file only says how the card was answered, and Paseo does not say who:
// `via` is "button" when the answer carried one of this card's button ids (the
// app and IM cards send them, `paseo permit` does not), "no-button" when it did
// not, "typed" when someone wrote in the conversation while the card was up.
// That is what the answering client sent, not who it was.

export const PROVIDER_ID = "orch-gate";
export const MODEL_ID = "card";
const CAPABILITIES = ["prompt.message", "prompt.steer", "permission"] as const;

export const APPROVE = "approve";
export const DENY = "deny";

export interface Answer {
  v: 1;
  at: string;
  permissionId: string | null;
  behavior: "allow" | "deny";
  via: "button" | "no-button" | "typed";
  selectedActionId: string | null;
  message: string | null;
  typed: string | null;
}

interface Waiting {
  turnId: string;
  permissionId: string;
  request: GateRequest;
}

interface Session {
  config: ProviderSessionConfig;
  turns: number;
  /** fresh: no gate yet; waiting: the card is up; done: the gate is over, whatever the answer. */
  state: "fresh" | "waiting" | "done";
  waiting: Waiting | null;
  outcome: string | null;
}

/** File writes, swappable in tests. */
export interface GateFiles {
  write(file: string, text: string): Promise<void>;
}

const diskFiles: GateFiles = {
  async write(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  },
};

export function createGateProvider(files: GateFiles = diskFiles): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: "人闸",
    description: "The orchestration runtime's human gate: a permission card, no model",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES), files);
    },
  };
}

const lines = (text: string) => (text === "" ? 0 : text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").length);

/** A row's label, ending in the file name when there is one so the app can highlight it. */
const rowPath = (label: string, name?: string) => (name ? `${label} · ${name}` : label);

/** What goes above the card: the brief as Markdown, then each piece of evidence folded, then the content folded. */
export function gateTimeline(request: GateRequest, turn: number): ProviderTimelineItem[] {
  const items: ProviderTimelineItem[] = [
    {
      type: "assistant_message",
      id: `brief-${turn}`,
      text: [`**要你决定**：${request.title}`, ...(request.brief.trim() === "" ? [] : ["", request.brief.trim()])].join("\n"),
    },
  ];
  request.evidence.forEach((entry, i) => {
    items.push({
      type: "tool_call",
      id: `evidence-${turn}-${i}`,
      callId: `evidence-${turn}-${i}`,
      name: entry.label,
      status: "completed",
      error: null,
      detail:
        entry.kind === "diff"
          ? { type: "edit", filePath: rowPath(`证据：${entry.label}`, entry.name), unifiedDiff: entry.text }
          : { type: "read", filePath: rowPath(`证据：${entry.label}`, entry.name), content: entry.text },
    });
  });
  items.push({
    type: "tool_call",
    id: `content-${turn}`,
    callId: `content-${turn}`,
    name: "待批全文",
    status: "completed",
    error: null,
    detail: { type: "read", filePath: rowPath(`待批全文（${lines(request.content)} 行）`, request.name), content: request.content },
  });
  return items;
}

/** The card: the decision as its title, what to know as its description, the content in it, two buttons. */
export function gatePermission(request: GateRequest, permissionId: string): ProviderPermissionRequest {
  const description = [
    ...(request.summary.trim() === "" ? [] : [request.summary.trim()]),
    `批准 = 同意脚本随后原样写下这 ${lines(request.content)} 行（${request.name}，sha256 ${request.sha256.slice(0, 12)}…）。`,
    request.help,
  ].join("\n");
  return {
    id: permissionId,
    name: "人闸",
    kind: "tool",
    title: request.title,
    description,
    detail: { type: "write", filePath: request.name, content: request.content },
    actions: [
      { id: DENY, label: "不批", behavior: "deny", variant: "danger", intent: "dismiss" },
      { id: APPROVE, label: "批准", behavior: "allow", variant: "primary" },
    ],
    metadata: { runId: request.runId, callId: request.callId, sha256: request.sha256 },
  };
}

/** How an answer came in, from the ids the card offered. */
export function viaOf(response: ProviderPermissionResponse): "button" | "no-button" {
  const own = response.behavior === "allow" ? APPROVE : DENY;
  return response.selectedActionId === own ? "button" : "no-button";
}

const promptText = (input: Extract<ProviderInput, { type: "session.prompt" }>) =>
  input.prompt.input.type === "message"
    ? input.prompt.input.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    : `/${input.prompt.input.name} ${input.prompt.input.arguments}`.trim();

function createConnection(capabilities: readonly string[], files: GateFiles): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  let closed = false;
  // One input at a time, in order: an answer must not overtake the card it answers.
  let queue = Promise.resolve();
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  const say = (sessionId: string, id: string, text: string) =>
    emit({ type: "timeline.item", sessionId, item: { type: "assistant_message", id, text } });

  async function record(answerPath: string, answer: Omit<Answer, "v" | "at">): Promise<void> {
    await files.write(answerPath, JSON.stringify({ v: 1, at: new Date().toISOString(), ...answer }, null, 2));
  }

  /** The card is answered: write what the runtime needs, close the card, end the turn. */
  async function settle(sessionId: string, session: Session, answer: Omit<Answer, "v" | "at" | "permissionId">): Promise<void> {
    const waiting = session.waiting;
    if (!waiting) return;
    session.waiting = null;
    session.state = "done";
    const { request, turnId, permissionId } = waiting;
    let failure: string | null = null;
    try {
      // The receipt first: the runtime reads it once the turn has ended.
      if (answer.behavior === "allow") await files.write(request.receiptPath, request.receipt);
      await record(request.answerPath, { permissionId, ...answer });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      await files.write(request.answerPath, JSON.stringify({ v: 1, at: new Date().toISOString(), error: `cannot record the answer: ${failure}` })).catch(() => {});
    }
    emit({ type: "session.permission_resolved", sessionId, permissionId });
    if (failure) {
      session.outcome = "出错";
      emit({ type: "timeline.item", sessionId, item: { type: "error", id: `answer-error-${turnId}`, message: `没能记下这次应答：${failure}` } });
      emit({ type: "session.turn", sessionId, turnId, state: "failed", error: { message: failure } });
      return;
    }
    session.outcome = answer.behavior === "allow" ? "批准" : "未批准";
    const how = answer.via === "typed" ? "在对话里回复了" : answer.via === "button" ? "点了卡片按钮" : "没有经过卡片按钮（例如命令行）";
    const words = answer.typed ?? (answer.via === "no-button" ? answer.message : null);
    say(
      sessionId,
      `answer-${turnId}`,
      answer.behavior === "allow"
        ? `已批准（${how}）。回执已写到 \`${request.receiptPath}\`，脚本核对回执后写入。`
        : `未批准（${how}）。${words ? `\n\n> ${words.replace(/\n/g, "\n> ")}` : ""}`,
    );
    emit({ type: "session.turn", sessionId, turnId, state: "completed" });
  }

  async function startGate(sessionId: string, session: Session, input: Extract<ProviderInput, { type: "session.prompt" }>) {
    session.turns += 1;
    const turnId = `turn-${session.turns}`;
    const text = promptText(input);
    emit({
      type: "timeline.item",
      sessionId,
      item: { type: "user_message", id: `user-${session.turns}`, text, clientMessageId: input.prompt.clientMessageId },
    });
    emit({ type: "session.prompt_result", sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
    emit({ type: "session.turn", sessionId, turnId, state: "started" });

    if (session.state !== "fresh") {
      say(sessionId, `closed-${turnId}`, `这个人闸已经结束（${session.outcome ?? "已应答"}），这里不再接受回复。`);
      emit({ type: "session.turn", sessionId, turnId, state: "completed" });
      return;
    }

    let request: GateRequest;
    try {
      request = await readRequest(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.state = "done";
      session.outcome = "没有起卡片";
      // The runtime reads this as an error, not as a person's denial.
      if (error instanceof RequestError && error.answerPath) {
        await files.write(error.answerPath, JSON.stringify({ v: 1, at: new Date().toISOString(), error: message })).catch(() => {});
      }
      emit({ type: "timeline.item", sessionId, item: { type: "error", id: `request-error-${turnId}`, message: `人闸没有起卡片：${message}` } });
      emit({ type: "session.turn", sessionId, turnId, state: "failed", error: { message } });
      return;
    }

    for (const item of gateTimeline(request, session.turns)) emit({ type: "timeline.item", sessionId, item });
    const permissionId = `gate-${request.callId}-${session.turns}`;
    session.state = "waiting";
    session.waiting = { turnId, permissionId, request };
    emit({ type: "session.permission", sessionId, request: gatePermission(request, permissionId) });
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: { models: [{ id: MODEL_ID, label: "人闸卡片", isDefault: true }], modes: [], defaultModel: MODEL_ID },
        });
        return;
      case "sessions":
        emit({ type: "sessions", requestId: input.requestId, sessions: [] });
        return;
      case "session.open": {
        sessions.set(input.sessionId, { config: input.config, turns: 0, state: "fresh", waiting: null, outcome: null });
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities,
          restoration: "core",
          title: input.config.title,
          cwd: input.config.cwd,
        });
        emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: { model: MODEL_ID, models: [{ id: MODEL_ID, label: "人闸卡片" }], modes: [], thinkingOptions: [], settings: [] },
        });
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        return;
      }
      case "session.prompt": {
        const session = sessions.get(input.sessionId);
        if (!session) return;
        if (input.prompt.delivery === "steer") {
          // Someone wrote in the conversation while the card was up: that is a no, with their words.
          if (!session.waiting) {
            emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: { message: "There is no active turn to steer" } },
            });
            return;
          }
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "steer", turnId: session.waiting.turnId },
          });
          const typed = promptText(input).trim();
          await settle(input.sessionId, session, { behavior: "deny", via: "typed", selectedActionId: null, message: null, typed: typed === "" ? null : typed });
          return;
        }
        await startGate(input.sessionId, session, input);
        return;
      }
      case "session.permission": {
        const session = sessions.get(input.sessionId);
        if (!session?.waiting || session.waiting.permissionId !== input.permissionId) return;
        const { response } = input;
        await settle(input.sessionId, session, {
          behavior: response.behavior,
          via: viaOf(response),
          selectedActionId: response.selectedActionId ?? null,
          message: response.behavior === "deny" ? (response.message ?? null) : null,
          typed: null,
        });
        return;
      }
      case "session.interrupt": {
        const session = sessions.get(input.sessionId);
        if (session?.waiting) {
          await settle(input.sessionId, session, { behavior: "deny", via: "no-button", selectedActionId: null, message: "interrupted", typed: null });
        }
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
        // Closed with the card up: nobody answered, so no answer is recorded and the runtime
        // reads the closed carrier as an error, not as a denial.
        if (session?.waiting) emit({ type: "session.permission_resolved", sessionId: input.sessionId, permissionId: session.waiting.permissionId });
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
      if ("sessionId" in input && input.type !== "session.open" && !sessions.has(input.sessionId)) {
        throw new Error(`Unknown session: ${input.sessionId}`);
      }
      queue = queue.then(() => (closed ? undefined : dispatch(input))).catch((error: unknown) => {
        console.error(`orchestration-gate: ${input.type} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      sessions.clear();
      listeners.clear();
    },
  };
}
