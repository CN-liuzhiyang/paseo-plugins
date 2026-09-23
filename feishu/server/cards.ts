import { buttonName, reasonField } from "./permissions";

// One card per request, patched in place: received, running, waiting, and one of done / failed /
// canceled. Card JSON 2.0, which only allows update_multi: true, so every state can be patched.
// Text that comes from the agent goes into plain_text, or through `escape` when it has to sit in
// markdown: there it could mention people or carry links.

// Feishu caps a patched card at 30 KB serialized. Leave room for the frame and escaping.
const MAX_BODY_BYTES = 20_000;
const MAX_QUOTE_CHARS = 200;
const MAX_DETAIL_BYTES = 2_000;
// Open requests past this many are answered in Paseo; the card has a size cap too.
const MAX_FORMS = 5;
const MAX_DECISIONS = 10;

type Template = "blue" | "wathet" | "orange" | "green" | "red" | "grey";

function cardOf(title: string, template: Template, elements: object[]): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements },
  };
}

function card(title: string, template: Template, content: string): object {
  return cardOf(title, template, [markdown(content)]);
}

function markdown(content: string): object {
  return { tag: "markdown", content };
}

function plain(content: string): object {
  return { tag: "div", text: { tag: "plain_text", content } };
}

/** Makes text inert in card markdown: no mentions, links, tags or formatting. */
export function escape(text: string): string {
  return text.replace(/[&<>[\]*_~`#]/g, (char) => `&#${char.charCodeAt(0)};`);
}

const TRUNCATED = "\n\n……（内容过长，已截断；完整内容在 Paseo 里看）";

export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const budget = maxBytes - Buffer.byteLength(TRUNCATED, "utf8");
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= budget) low = mid;
    else high = mid - 1;
  }
  // Do not end on the first half of a surrogate pair.
  const code = text.charCodeAt(low - 1);
  if (code >= 0xd800 && code <= 0xdbff) low -= 1;
  return text.slice(0, low) + TRUNCATED;
}

function quote(request: string): string {
  const oneLine = request.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > MAX_QUOTE_CHARS ? `${oneLine.slice(0, MAX_QUOTE_CHARS)}…` : oneLine;
  return `> ${clipped}`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export interface RunView {
  request: string;
  agentId: string;
  provider: string;
  startedAt: number;
  /** Lines from `decisionLine`, oldest first. */
  decisions: readonly string[];
}

export interface DecisionView {
  outcome: "allowed" | "denied" | "abandoned";
  /** The choice's label, e.g. 允许. */
  label: string;
  /** From `describePermission`. */
  what: string;
  /** Who answered on a card; null when the answer came from Paseo or never came. */
  operator: string | null;
  waitedMs: number | null;
}

export function decisionLine(decision: DecisionView): string {
  const verdict =
    decision.outcome === "allowed"
      ? `<font color='green'>${escape(decision.label)}</font>`
      : decision.outcome === "denied"
        ? `<font color='red'>${escape(decision.label)}</font>`
        : "<font color='grey'>没有处理</font>";
  // A person tag shows the name without notifying anyone, as a mention would on every patch.
  const by =
    decision.operator && /^ou_\w+$/.test(decision.operator)
      ? `<person id='${decision.operator}' show_name=true show_avatar=false></person>`
      : decision.outcome === "abandoned"
        ? "这一轮结束时还在等"
        : "在 Paseo 里";
  const waited = decision.waitedMs === null ? "" : ` · ${formatElapsed(decision.waitedMs)}`;
  return `${verdict} · ${escape(decision.what)} · ${by}${waited}`;
}

function runElements(run: RunView, main: string): object[] {
  const decisions = run.decisions.slice(-MAX_DECISIONS);
  return [
    markdown(main),
    ...(decisions.length > 0 ? [markdown(`**审批**\n${decisions.join("\n")}`)] : []),
    markdown(`<font color='grey'>${run.provider} · agent ${run.agentId.slice(0, 8)}</font>`),
  ];
}

export function receivedCard(request: string, fresh: boolean): object {
  const next = fresh ? "正在为这个会话启动 agent。" : "正在发给这个会话的 agent。";
  return card("已接收", "wathet", `${quote(request)}\n\n${next}`);
}

export function queuedCard(request: string, ahead: number): object {
  return card("排队中", "grey", `${quote(request)}\n\nagent 还在处理前面的 ${ahead} 条，处理完就轮到这条。`);
}

export function newSessionCard(provider: string, agentId: string): object {
  return card(
    "已开新会话",
    "wathet",
    `之后的消息交给新的 agent，之前的会话留在 Paseo 里。\n\n<font color='grey'>${provider} · agent ${agentId.slice(0, 8)}</font>`,
  );
}

export function runningCard(run: RunView, now: number): object {
  return cardOf(
    `进行中 · ${formatElapsed(now - run.startedAt)}`,
    "blue",
    runElements(run, quote(run.request)),
  );
}

/** One open permission request, as the card shows it. */
export interface ApprovalView {
  agentId: string;
  requestId: string;
  /** From the agent: shown as plain text only. */
  title: string;
  detail: string;
  actions: ReadonlyArray<{ label: string; behavior: "allow" | "deny"; variant?: string }>;
  /** The label of a choice already sent to Paseo and not yet confirmed. */
  submitting: string | null;
  /** Why the last answer did not go through. */
  notice: string | null;
}

function buttonType(
  action: ApprovalView["actions"][number],
  primary: ApprovalView["actions"][number] | undefined,
): string {
  if (action === primary) return "primary_filled";
  return action.behavior === "deny" ? "danger" : "default";
}

function approvalElements(approval: ApprovalView, form: number, numbered: boolean): object[] {
  const head = [
    ...(numbered ? [markdown(`**请求 ${form + 1}**`)] : []),
    plain(approval.title),
    ...(approval.detail.trim() === "" ? [] : [plain(truncateBytes(approval.detail, MAX_DETAIL_BYTES))]),
    ...(approval.notice === null
      ? []
      : [markdown(`<font color='red'>${escape(approval.notice)}。可以再点一次，或者到 Paseo 里处理。</font>`)]),
  ];
  if (approval.submitting !== null) {
    return [...head, markdown(`正在提交：**${escape(approval.submitting)}**`)];
  }
  if (approval.actions.length === 0) {
    return [...head, markdown("这是一个提问，请到 Paseo 里回答。")];
  }
  const primary =
    approval.actions.find((action) => action.variant === "primary") ??
    approval.actions.find((action) => action.behavior === "allow");
  const reason = approval.actions.some((action) => action.behavior === "deny")
    ? [
        {
          tag: "input",
          name: reasonField(form),
          placeholder: { tag: "plain_text", content: "拒绝理由（可选，会转告 agent）" },
          max_length: 500,
        },
      ]
    : [];
  const { agentId, requestId } = approval;
  const columns = approval.actions.map((action, index) => ({
    tag: "column",
    width: "auto",
    elements: [
      {
        tag: "button",
        // A button inside a form sends its name, not a value; see buttonName.
        name: buttonName({ form, action: index, agentId, requestId }),
        text: { tag: "plain_text", content: action.label.slice(0, 100) },
        type: buttonType(action, primary),
        form_action_type: "submit",
      },
    ],
  }));
  return [
    {
      tag: "form",
      name: `perm${form}`,
      elements: [...head, ...reason, { tag: "column_set", horizontal_spacing: "8px", columns }],
    },
  ];
}

export function waitingCard(run: RunView, approvals: readonly ApprovalView[]): object {
  const shown = approvals.slice(0, MAX_FORMS);
  const hidden = approvals.length - shown.length;
  const elements = runElements(run, quote(run.request));
  const footer = elements.pop()!;
  return cardOf("等待审批", "orange", [
    ...elements,
    ...shown.flatMap((approval, form) => approvalElements(approval, form, approvals.length > 1)),
    ...(hidden > 0 ? [markdown(`还有 ${hidden} 个请求，在 Paseo 里处理。`)] : []),
    markdown("<font color='grey'>也可以在 Paseo 里处理。</font>"),
    footer,
  ]);
}

/** A card answered after the plugin restarted: the run it belonged to is no longer followed. */
export function answeredCard(decision: string): object {
  return card("已处理审批", "grey", `${decision}\n\n插件重启过，这条消息之后的进度在 Paseo 里看。`);
}

/** An answer Paseo did not take, on a card nothing follows any more. */
export function answerFailedCard(why: string): object {
  return card("审批没有提交", "grey", `${escape(why)}。到 Paseo 里处理这个请求。`);
}

/** A click on a request Paseo no longer holds open, on a card nothing follows any more. */
export function staleApprovalCard(): object {
  return card(
    "审批已结束",
    "grey",
    "这个请求已经不在等待了：可能已在 Paseo 里处理，或者那一轮已经结束。之后的进度在 Paseo 里看。",
  );
}

export function doneCard(run: RunView, result: string, now: number): object {
  const body = result.trim() === "" ? "（agent 没有输出文字）" : result;
  return cardOf(
    `完成 · ${formatElapsed(now - run.startedAt)}`,
    "green",
    runElements(run, truncateBytes(body, MAX_BODY_BYTES)),
  );
}

export function failedCard(request: string, error: string, run?: RunView): object {
  const main = `${quote(request)}\n\n${truncateBytes(error, MAX_BODY_BYTES)}`;
  return run ? cardOf("失败", "red", runElements(run, main)) : card("失败", "red", main);
}

export function canceledCard(run: RunView, reason: string): object {
  return cardOf("已取消", "grey", runElements(run, `${quote(run.request)}\n\n${reason}`));
}

export function noRouteCard(chatId: string): object {
  return card(
    "这个会话还没有路由",
    "grey",
    `chat_id：\`${chatId}\`\n\n把它加进 feishu 插件设置的 routes，这个会话的消息才会交给 agent。`,
  );
}
