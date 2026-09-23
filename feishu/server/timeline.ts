import type { AgentPermissionRequest, AgentTimelineItem } from "@getpaseo/protocol/agent-types";

/**
 * The answer a turn ended with: the assistant text after the turn's last tool call or other
 * non-text item. Earlier text in the turn is narration ("let me check...") and stays in Paseo.
 * Falls back to all of the turn's assistant text when nothing follows the last tool call.
 */
export function finalAnswer(timeline: readonly AgentTimelineItem[]): string {
  let turn: string[] = [];
  let tail: string[] = [];
  for (const item of timeline) {
    if (item.type === "user_message") {
      turn = [];
      tail = [];
    } else if (item.type === "assistant_message") {
      turn.push(item.text);
      tail.push(item.text);
    } else if (item.type !== "reasoning") {
      if (tail.length > 0) turn.push("\n\n");
      tail = [];
    }
  }
  const answer = tail.join("").trim();
  return answer === "" ? turn.join("").trim() : answer;
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
