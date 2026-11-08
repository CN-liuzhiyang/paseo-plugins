import type { AgentPermissionRequest, AgentTimelineItem } from "@getpaseo/protocol/agent-types";

/** A timeline entry as `timeline.refetch` returns it: the item and the turn it belongs to. */
export interface TimelineEntry {
  item: AgentTimelineItem;
  turnId?: string;
}

/**
 * The answer a turn ended with: the assistant text after the turn's last tool call or other
 * non-text item. Earlier text in the turn is narration ("let me check...") and stays in Paseo.
 * Falls back to all of the turn's assistant text when nothing follows the last tool call.
 *
 * Only the turn that ended counts. With its `turnId`, entries of other turns are dropped; this
 * matters for a turn no message started (an agent going on after a background task), since
 * nothing in the timeline marks where it began: the task's tool call is updated in place, far
 * back, so the previous turn's answer would otherwise run straight into this one's. Without a
 * turn ID a user message is the only boundary there is.
 *
 * Separate assistant messages are separate paragraphs; only the pieces of one message (the same
 * `messageId`) are joined as they are.
 */
export function finalAnswer(
  entries: readonly TimelineEntry[],
  turnId: string | null = null,
): string {
  const ofTurn = turnId === null ? [] : entries.filter((entry) => entry.turnId === turnId);
  let turn: AssistantText[] = [];
  let tail: AssistantText[] = [];
  for (const { item } of ofTurn.length > 0 ? ofTurn : entries) {
    if (item.type === "user_message") {
      turn = [];
      tail = [];
    } else if (item.type === "assistant_message") {
      turn.push(item);
      tail.push(item);
    } else if (item.type !== "reasoning") {
      if (tail.length > 0) turn.push(BREAK);
      tail = [];
    }
  }
  const answer = paragraphs(tail);
  return answer === "" ? paragraphs(turn) : answer;
}

type AssistantText = { text: string; messageId?: string };

// Where a tool call came between two pieces of text.
const BREAK: AssistantText = { text: "" };

/** The pieces as markdown: one paragraph per message, a blank line between paragraphs. */
function paragraphs(pieces: readonly AssistantText[]): string {
  const out: string[] = [];
  let previous: AssistantText | null = null;
  for (const piece of pieces) {
    const sameMessage =
      previous !== null && piece.messageId !== undefined && previous.messageId === piece.messageId;
    if (sameMessage && out.length > 0) out[out.length - 1] += piece.text;
    else out.push(piece.text);
    previous = piece;
  }
  return out
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join("\n\n");
}

const MAX_WHAT_CHARS = 200;

/** One line saying what an agent is asking permission for, e.g. `Write: src/a.ts`. */
export function describePermission(request: AgentPermissionRequest): string {
  const subject = subjectOf(request);
  const what = subject ? `${request.name}: ${subject}` : (request.title ?? request.name);
  const oneLine = what.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_WHAT_CHARS ? `${oneLine.slice(0, MAX_WHAT_CHARS)}…` : oneLine;
}

/** The command, file, URL or query a request is about: Paseo's normalized detail first. */
function subjectOf(request: AgentPermissionRequest): string | undefined {
  const detail = request.detail;
  switch (detail?.type) {
    case "shell":
      return detail.command;
    case "edit":
    case "write":
    case "read":
      return detail.filePath;
    case "fetch":
      return detail.url;
    case "search":
      return detail.query;
  }
  const input = request.input as Record<string, unknown> | undefined;
  for (const key of ["command", "file_path"]) {
    if (typeof input?.[key] === "string") return input[key];
  }
  return undefined;
}
