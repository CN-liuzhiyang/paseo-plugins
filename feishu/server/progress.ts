import type { AgentTimelineItem, ToolCallDetail } from "@getpaseo/protocol/agent-types";

// What a run is doing, rebuilt from the agent's live timeline so the card can say it. Paseo
// streams assistant and reasoning text as deltas and repeats a tool call under the same
// callId as its status changes (running, then completed or failed).

export type StepStatus = "running" | "completed" | "failed" | "canceled";

export interface Step {
  callId: string;
  /** What the tool does, in Chinese: 运行, 读取, 编辑... */
  verb: string;
  /** The command, file, URL or query; from the agent, so never trusted as markup. */
  subject: string;
  status: StepStatus;
  startedAt: number;
  endedAt: number | null;
}

export interface Todo {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface Progress {
  steps: Step[];
  /** The agent's latest plan, when it keeps one (Claude's TodoWrite). */
  todos: Todo[];
  /** Assistant text since the last tool call: the answer as it is being written. */
  text: string;
  phase: "starting" | "thinking" | "writing" | "tool";
}

const MAX_SUBJECT_CHARS = 120;

export function createProgress(): Progress {
  return { steps: [], todos: [], text: "", phase: "starting" };
}

/** Folds one live timeline item into `progress`; returns whether the card should change. */
export function applyItem(progress: Progress, item: AgentTimelineItem, at: number, cwd: string): boolean {
  switch (item.type) {
    case "user_message":
      // A new turn: whatever came before belongs to the previous one.
      Object.assign(progress, createProgress());
      return true;
    case "assistant_message":
      progress.text += item.text;
      progress.phase = "writing";
      return true;
    case "reasoning": {
      const changed = progress.phase !== "thinking";
      progress.phase = "thinking";
      return changed;
    }
    case "tool_call": {
      const existing = progress.steps.find((step) => step.callId === item.callId);
      if (existing) {
        if (existing.status === item.status) return false;
        existing.status = item.status;
        if (item.status !== "running") existing.endedAt = at;
      } else {
        const { verb, subject } = describeTool(item.name, item.detail, cwd);
        progress.steps.push({
          callId: item.callId,
          verb,
          subject,
          status: item.status,
          startedAt: at,
          endedAt: item.status === "running" ? null : at,
        });
        // Text before a tool call was narration ("let me check..."), not the answer.
        progress.text = "";
      }
      progress.phase = progress.steps.some((step) => step.status === "running") ? "tool" : "thinking";
      return true;
    }
    case "todo":
      progress.todos = item.items.map((todo) => ({
        text: todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.text,
        status: todo.status ?? (todo.completed ? "completed" : "pending"),
      }));
      return true;
    default:
      return false;
  }
}

export function describeTool(
  name: string,
  detail: ToolCallDetail | undefined,
  cwd: string,
): { verb: string; subject: string } {
  const path = (filePath: string) => shorten(relativeTo(filePath, cwd));
  switch (detail?.type) {
    case "shell":
      return { verb: "运行", subject: shorten(detail.command) };
    case "read":
      return { verb: "读取", subject: path(detail.filePath) };
    case "edit":
      return { verb: "编辑", subject: path(detail.filePath) };
    case "write":
      return { verb: "写入", subject: path(detail.filePath) };
    case "search":
      return { verb: detail.toolName === "web_search" ? "搜索网页" : "搜索", subject: shorten(detail.query) };
    case "fetch":
      return { verb: "打开网页", subject: shorten(detail.url) };
    case "sub_agent":
      return { verb: "派出子任务", subject: shorten(detail.description ?? detail.subAgentType ?? "") };
    case "plan":
      return { verb: "拟定计划", subject: "" };
    case "worktree_setup":
      return { verb: "准备工作区", subject: shorten(detail.branchName) };
    case "plain_text":
      return { verb: detail.label ? shorten(detail.label) : name, subject: "" };
    default:
      return { verb: "调用", subject: shorten(name) };
  }
}

function relativeTo(filePath: string, cwd: string): string {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = normalize(filePath);
  const root = normalize(cwd);
  if (root !== "" && file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return file.slice(root.length + 1);
  }
  return filePath;
}

function shorten(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUBJECT_CHARS ? `${line.slice(0, MAX_SUBJECT_CHARS)}…` : line;
}
