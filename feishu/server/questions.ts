import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";

export interface Question {
  key: string;
  text: string;
  options: Array<{ label: string; description: string }>;
  multi: boolean;
}

/** Claude and Codex sync use header/question; Codex async uses Question 1, Question 2, ... */
export function questionsOf(request: AgentPermissionRequest): Question[] {
  if (request.provider !== "claude" && request.provider !== "codex") return [];
  if (request.provider === "codex" && request.name !== "request_user_input" &&
      request.name !== "request_user_input_async") return [];
  const raw = request.input?.questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return [];
  const questions = raw.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.question !== "string" || !item.question.trim()) return [];
    if (item.options !== undefined && !Array.isArray(item.options)) return [];
    if (request.provider === "codex" && request.name === "request_user_input" &&
        (typeof item.header !== "string" || !item.header.trim())) return [];
    // Keep the complete choice set on a phone-sized card; larger forms stay in Paseo.
    if (Array.isArray(item.options) && item.options.length > 6) return [];
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) return [];
          const entry = option as Record<string, unknown>;
          return typeof entry.label === "string" && entry.label.trim()
            ? [{ label: entry.label, description: typeof entry.description === "string" ? entry.description : "" }]
            : [];
        })
      : [];
    if (Array.isArray(item.options) && options.length !== item.options.length) return [];
    const codexAsync = request.provider === "codex" && request.name === "request_user_input_async";
    const key = codexAsync ? `Question ${index + 1}` :
      typeof item.header === "string" && item.header.trim() ? item.header : item.question;
    return [{ key, text: item.question, options, multi: item.multiSelect === true }];
  });
  return questions.length === raw.length &&
    new Set(questions.map((question) => question.key)).size === questions.length ? questions : [];
}

export function questionButtonName(agentId: string, requestId: string): string {
  return `question|${agentId}|${requestId}`;
}

export function parseQuestionButtonName(name: string): { agentId: string; requestId: string } | null {
  if (!name.startsWith("question|")) return null;
  const [, agentId, ...rest] = name.split("|");
  const requestId = rest.join("|");
  return agentId && requestId ? { agentId, requestId } : null;
}

function valuesOf(formValue: unknown): Record<string, unknown> | null {
  if (typeof formValue !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(formValue);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** Reject malformed or forged option values; free text is accepted for every question. */
export function questionResponse(
  request: AgentPermissionRequest,
  formValue: unknown,
): { response: AgentPermissionResponse; summary: string } | { error: string } {
  const questions = questionsOf(request);
  const values = valuesOf(formValue);
  if (questions.length === 0) return { error: "问题内容无法识别，请在 Paseo 中回答" };
  if (!values) return { error: "没有收到表单内容，请重新提交" };
  const answers: Record<string, string> = {};
  const summary: string[] = [];
  for (const [index, question] of questions.entries()) {
    const picked = values[`choice${index}`];
    const typed = values[`custom${index}`];
    const free = typeof typed === "string" ? typed.trim().slice(0, 1000) : "";
    let selected: string[] = [];
    if (typeof picked === "string" && picked) selected = [picked];
    else if (Array.isArray(picked) && picked.every((value) => typeof value === "string")) selected = picked;
    if (selected.some((value) => !question.options.some((option, optionIndex) => `${optionIndex}` === value))) {
      return { error: `第 ${index + 1} 题的选项已失效，请重新选择` };
    }
    const labels = selected.map((value) => question.options[Number(value)]!.label);
    if (!question.multi && labels.length > 1) return { error: `第 ${index + 1} 题只能选一项` };
    const parts = [...labels, ...(free ? [free] : [])];
    if (parts.length === 0) return { error: `请回答第 ${index + 1} 题` };
    const answer = !question.multi && labels.length === 1 && free
      ? `${labels[0]}（补充：${free}）`
      : parts.join(", ");
    answers[question.key] = answer;
    summary.push(`${index + 1}. ${question.multi ? parts.join("、") : answer}`);
  }
  return { response: { behavior: "allow", updatedInput: { answers } }, summary: summary.join("；") };
}
