import type {
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";

/**
 * The choices Paseo's own permission card offers, in its order: the request's actions when the
 * provider sent some, otherwise deny and allow. Questions get none: they need answers, not a
 * verdict, and are answered in Paseo.
 */
export function permissionActions(request: AgentPermissionRequest): AgentPermissionAction[] {
  if (request.kind === "question") return [];
  if (request.actions && request.actions.length > 0) return request.actions;
  return [
    { id: "reject", label: "拒绝", behavior: "deny", variant: "danger", intent: "dismiss" },
    {
      id: "accept",
      label: request.kind === "plan" ? "按计划执行" : "允许",
      behavior: "allow",
      variant: "primary",
    },
  ];
}

/** The response Paseo's own card sends for the same choice, plus the reason typed on the card. */
export function permissionResponse(
  action: AgentPermissionAction,
  reason: string | null,
): AgentPermissionResponse {
  if (action.behavior === "allow") return { behavior: "allow", selectedActionId: action.id };
  return {
    behavior: "deny",
    selectedActionId: action.id,
    message: reason ? `Denied by user: ${reason}` : "Denied by user",
  };
}

// A button inside a Feishu form carries no value of its own, only its name, so the name says
// which request and which choice it answers. It is only an address: every click is checked
// against the requests Paseo holds open at that moment, which is also why a card from before a
// plugin restart still works.
export interface ButtonTarget {
  form: number;
  action: number;
  agentId: string;
  requestId: string;
}

export function buttonName(target: ButtonTarget): string {
  return `${target.form}|${target.action}|${target.agentId}|${target.requestId}`;
}

export function parseButtonName(name: string): ButtonTarget | null {
  const [form, action, agentId, ...rest] = name.split("|");
  const requestId = rest.join("|");
  if (!/^\d+$/.test(form ?? "") || !/^\d+$/.test(action ?? "") || !agentId || !requestId) {
    return null;
  }
  return { form: Number(form), action: Number(action), agentId, requestId };
}

/** The name of the reason input in form `form`; its value arrives keyed by this name. */
export function reasonField(form: number): string {
  return `reason${form}`;
}

const MAX_REASON_CHARS = 500;

export function reasonFrom(formValue: unknown, form: number): string | null {
  if (typeof formValue !== "string" || formValue === "") return null;
  try {
    const value = (JSON.parse(formValue) as Record<string, unknown>)[reasonField(form)];
    if (typeof value !== "string") return null;
    const reason = value.trim().slice(0, MAX_REASON_CHARS);
    return reason === "" ? null : reason;
  } catch {
    return null;
  }
}

/**
 * What exactly the agent wants to do, as plain text for the person deciding: the command, the
 * file and its change, the plan. Falls back to the raw input.
 */
export function requestDetail(request: AgentPermissionRequest): string {
  if (request.kind === "plan") {
    const plan = request.metadata?.planText ?? request.input?.plan;
    if (typeof plan === "string") return plan;
  }
  const detail = request.detail;
  switch (detail?.type) {
    case "shell":
      return detail.cwd ? `${detail.command}\n\n（目录：${detail.cwd}）` : detail.command;
    case "edit": {
      const change =
        detail.unifiedDiff ??
        [detail.oldString && `- ${detail.oldString}`, detail.newString && `+ ${detail.newString}`]
          .filter(Boolean)
          .join("\n");
      return change ? `${detail.filePath}\n\n${change}` : detail.filePath;
    }
    case "write":
      return detail.content ? `${detail.filePath}\n\n${detail.content}` : detail.filePath;
    case "read":
      return detail.filePath;
    case "fetch":
      return detail.url;
    case "search":
      return detail.query;
  }
  const command = request.input?.command;
  if (typeof command === "string") return command;
  if (request.input && Object.keys(request.input).length > 0) {
    return JSON.stringify(request.input, null, 2);
  }
  return request.description ?? "";
}
