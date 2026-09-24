import { cardMarkdown } from "./markdown";
import { buttonName, reasonField } from "./permissions";
import type { Progress, Step } from "./progress";

// One card per request, patched in place: received, running, waiting, and one of done / failed /
// canceled. Card JSON 2.0, which only allows update_multi: true, so every state can be patched.
// Text that comes from the agent goes into plain_text, through `escape` when it has to sit in
// markdown as a fragment, or through `cardMarkdown` when it is an answer meant to be formatted.

// Feishu caps a patched card at 30 KB serialized. Leave room for the frame and escaping.
const MAX_BODY_BYTES = 18_000;
const MIN_BODY_BYTES = 1_000;
const MAX_CARD_BYTES = 28_000;
const MAX_QUOTE_CHARS = 200;
const MAX_DETAIL_BYTES = 2_000;
// Open requests past this many are answered in Paseo; the card has a size cap too.
const MAX_FORMS = 5;
const MAX_DECISIONS = 10;
// Steps a running card shows; the finished card folds all of them away.
const RECENT_STEPS = 3;
const MAX_LOGGED_STEPS = 30;
const MAX_TODOS = 8;

export type Template = "blue" | "wathet" | "orange" | "green" | "red" | "grey";

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

function notation(content: string): object {
  return { tag: "markdown", content, text_size: "notation" };
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

/** The request as one quoted line. It is what someone typed, but in a group that is not us. */
function quote(request: string): string {
  const oneLine = request.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > MAX_QUOTE_CHARS ? `${oneLine.slice(0, MAX_QUOTE_CHARS)}…` : oneLine;
  return `> ${escape(clipped)}`;
}

/** An answer, formatted but inert, cut to `budget` bytes before escaping grows it. */
function answer(text: string, budget = MAX_BODY_BYTES): string {
  return cardMarkdown(truncateBytes(text, budget));
}

/**
 * Builds a card that fits Feishu's limit. Escaping, link rewriting, the steps panel and the
 * approval records all add to the answer, so the whole card is measured: the steps go first,
 * then the answer is cut shorter until it fits.
 */
function fitted(build: (budget: number, withSteps: boolean) => object): object {
  let budget = MAX_BODY_BYTES;
  let withSteps = true;
  for (;;) {
    const built = build(budget, withSteps);
    const size = Buffer.byteLength(JSON.stringify(built), "utf8");
    if (size <= MAX_CARD_BYTES || budget <= MIN_BODY_BYTES) return built;
    if (withSteps) withSteps = false;
    else budget = Math.max(MIN_BODY_BYTES, Math.floor(budget * Math.min(0.8, MAX_CARD_BYTES / size)));
  }
}

/**
 * What a card falls back to when Feishu refuses its last state for any reason but the rate
 * limit, so it does not stay on "running" for good.
 */
export function lastResortCard(title: string, template: Template, run: RunView): object {
  return cardOf(title, template, [
    markdown("卡片没能显示完整内容（飞书不接受这张卡片），完整结果在 Paseo 里看。"),
    footer(run),
  ]);
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
  progress: Progress;
  /** What did not reach the agent with the message, e.g. an image too large to attach. */
  notes: readonly string[];
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

function stepLine(step: Step, now: number): string {
  const what = escape(step.subject === "" ? step.verb : `${step.verb} ${step.subject}`);
  switch (step.status) {
    case "running":
      return `<font color='blue'>▶ ${what} · ${formatElapsed(now - step.startedAt)}</font>`;
    case "failed":
      return `<font color='red'>✗ ${what}</font>`;
    case "canceled":
      return `<font color='grey'>– ${what}（已取消）</font>`;
    default:
      return `<font color='grey'>✓ ${what}</font>`;
  }
}

function todoLines(progress: Progress): string[] {
  const todos = progress.todos.slice(0, MAX_TODOS);
  const hidden = progress.todos.length - todos.length;
  const done = progress.todos.filter((todo) => todo.status === "completed").length;
  return [
    `**计划 ${done}/${progress.todos.length}**`,
    ...todos.map((todo) =>
      todo.status === "completed"
        ? `<font color='grey'>✓ ~~${escape(todo.text)}~~</font>`
        : todo.status === "in_progress"
          ? `▶ **${escape(todo.text)}**`
          : `<font color='grey'>○ ${escape(todo.text)}</font>`,
    ),
    ...(hidden > 0 ? [`<font color='grey'>……还有 ${hidden} 项</font>`] : []),
  ];
}

/** What the agent is doing right now, as the running card says it. */
function activity(progress: Progress, now: number): string[] {
  const { steps } = progress;
  const recent = steps.slice(-RECENT_STEPS);
  const earlier = steps.length - recent.length;
  const lines = [
    ...(earlier > 0 ? [`<font color='grey'>……前面还有 ${earlier} 步</font>`] : []),
    ...recent.map((step) => stepLine(step, now)),
  ];
  if (!steps.some((step) => step.status === "running")) {
    const phase =
      progress.phase === "writing" ? "正在写回答…" : progress.phase === "thinking" ? "正在思考…" : "正在启动…";
    lines.push(`<font color='blue'>${phase}</font>`);
  }
  return lines;
}

function notesBlock(run: RunView): object[] {
  if (run.notes.length === 0) return [];
  return [notation(run.notes.map((note) => `<font color='orange'>⚠ ${escape(note)}</font>`).join("\n"))];
}

function footer(run: RunView): object {
  return notation(`<font color='grey'>${escape(run.provider)} · agent ${run.agentId.slice(0, 8)}</font>`);
}

function decisionsBlock(run: RunView): object[] {
  const decisions = run.decisions.slice(-MAX_DECISIONS);
  return decisions.length > 0 ? [markdown(`**审批**\n${decisions.join("\n")}`)] : [];
}

/** The finished run's steps, folded away under the answer. */
function stepsPanel(run: RunView, now: number): object[] {
  const { steps } = run.progress;
  if (steps.length === 0) return [];
  const shown = steps.slice(-MAX_LOGGED_STEPS);
  const hidden = steps.length - shown.length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const title = [`执行过程 · ${steps.length} 步`, ...(failed > 0 ? [`${failed} 步失败`] : []), `用时 ${formatElapsed(now - run.startedAt)}`];
  return [
    {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "markdown", content: `<font color='grey'>${title.join(" · ")}</font>` },
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", color: "grey", size: "16px 16px" },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "5px" },
      padding: "4px 8px 4px 8px",
      elements: [
        notation(
          [
            ...(hidden > 0 ? [`<font color='grey'>……前面还有 ${hidden} 步，在 Paseo 里看</font>`] : []),
            ...shown.map((step) => stepLine(step, now)),
          ].join("\n"),
        ),
      ],
    },
  ];
}

/** `note` is this plugin's own markdown, said before what happens next. */
export function receivedCard(request: string, fresh: boolean, note?: string): object {
  const next = fresh ? "正在为这个会话启动 agent。" : "正在发给这个会话的 agent。";
  return card("已接收", "wathet", [quote(request), ...(note ? [note] : []), next].join("\n\n"));
}

export function queuedCard(request: string, ahead: number): object {
  return card("排队中", "grey", `${quote(request)}\n\nagent 还在处理前面的 ${ahead} 条，处理完就轮到这条。`);
}

/** `previous` is what became of the conversation before: archived, left alone while working, or none. */
export function newSessionCard(provider: string, agentId: string, previous: "archived" | "kept" | "none"): object {
  const before =
    previous === "archived"
      ? "之前的会话已在 Paseo 里归档。"
      : previous === "kept"
        ? "之前的会话还在处理，没有归档，留在 Paseo 里。"
        : "";
  return card(
    "已开新会话",
    "wathet",
    `之后的消息交给新的 agent。${before}\n\n<font color='grey'>${escape(provider)} · agent ${agentId.slice(0, 8)}</font>`,
  );
}

/** A result Paseo sends on its own, such as a scheduled run's, as a new message in the chat. */
export function deliveredCard(title: string, status: "succeeded" | "failed", text: string): object {
  if (status === "failed") {
    const why = text.trim() === "" ? "没有给出原因" : truncateBytes(text, MAX_DETAIL_BYTES);
    return cardOf(`${title} · 没能完成`, "red", [markdown(escape(why))]);
  }
  return fitted((budget) =>
    cardOf(title, "green", [markdown(text.trim() === "" ? "（agent 没有输出文字）" : answer(text, budget))]),
  );
}

export function runningCard(run: RunView, now: number): object {
  const { progress } = run;
  const draft = progress.text.trim();
  return fitted((budget) =>
    cardOf(`进行中 · ${formatElapsed(now - run.startedAt)}`, "blue", [
      markdown(quote(run.request)),
      ...notesBlock(run),
      ...(progress.todos.length > 0 ? [markdown(todoLines(progress).join("\n"))] : []),
      notation(activity(progress, now).join("\n")),
      ...(draft === "" ? [] : [{ tag: "hr" }, markdown(answer(draft, budget))]),
      ...decisionsBlock(run),
      footer(run),
    ]),
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

// No clock on this card: it is not redrawn while it waits, because a redraw would wipe a
// reason someone is halfway through typing.
export function waitingCard(run: RunView, approvals: readonly ApprovalView[]): object {
  const shown = approvals.slice(0, MAX_FORMS);
  const hidden = approvals.length - shown.length;
  return cardOf("等待审批", "orange", [
    markdown(quote(run.request)),
    ...decisionsBlock(run),
    ...shown.flatMap((approval, form) => approvalElements(approval, form, approvals.length > 1)),
    ...(hidden > 0 ? [markdown(`还有 ${hidden} 个请求，在 Paseo 里处理。`)] : []),
    markdown("<font color='grey'>也可以在 Paseo 里处理。</font>"),
    footer(run),
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

export function doneTitle(run: RunView, now: number): string {
  return `完成 · ${formatElapsed(now - run.startedAt)}`;
}

export function doneCard(run: RunView, result: string, now: number): object {
  return fitted((budget, withSteps) =>
    cardOf(doneTitle(run, now), "green", [
      markdown(result.trim() === "" ? "（agent 没有输出文字）" : answer(result, budget)),
      ...notesBlock(run),
      ...(withSteps ? stepsPanel(run, now) : []),
      ...decisionsBlock(run),
      footer(run),
    ]),
  );
}

/** `error` is shown as text; `hint` is this plugin's own markdown, e.g. what to do next. */
export function failedCard(
  request: string,
  error: string,
  options: { run?: RunView; now?: number; hint?: string } = {},
): object {
  const { run, now, hint } = options;
  const main = markdown(
    [quote(request), escape(truncateBytes(error, MAX_DETAIL_BYTES)), ...(hint ? [hint] : [])].join("\n\n"),
  );
  if (!run) return cardOf("失败", "red", [main]);
  return fitted((_budget, withSteps) =>
    cardOf("失败", "red", [
      main,
      ...(withSteps ? stepsPanel(run, now ?? run.startedAt) : []),
      ...decisionsBlock(run),
      footer(run),
    ]),
  );
}

export function canceledCard(run: RunView, reason: string, now: number): object {
  return fitted((_budget, withSteps) =>
    cardOf("已取消", "grey", [
      markdown(`${quote(run.request)}\n\n${escape(reason)}`),
      ...(withSteps ? stepsPanel(run, now) : []),
      ...decisionsBlock(run),
      footer(run),
    ]),
  );
}

export function noRouteCard(chatId: string): object {
  return card(
    "这个会话还没有路由",
    "grey",
    `chat_id：\`${chatId}\`\n\n在 Paseo 的 设置 → 插件 → feishu 里给它加一条路由，这个会话的消息才会交给 agent。`,
  );
}

/**
 * For someone the bot does not know yet. In a group an admin is likely reading, so the card
 * asks them, and the button lets the person in; in a single chat nobody else is, so it says
 * where an admin can.
 */
export function strangerCard(input: {
  name: string | null;
  letIn: string | null;
  notice?: string | null;
  /** Nobody is admin yet: nobody could press the button, so say how the first one is made. */
  noAdmin?: boolean;
}): object {
  const who = input.name ? `**${escape(input.name)}**` : "这位";
  if (input.noAdmin) {
    return card(
      "还没有管理员",
      "grey",
      "这个机器人还没有管理员，所以谁的消息都不会交给 agent。\n\n装它的人：打开 Paseo 的 设置 → 飞书，在「最近被挡下的消息」里找到自己，点「设为管理员」再保存。",
    );
  }
  if (input.letIn === null) {
    return card(
      "还不能用",
      "grey",
      "你还不在这个机器人的名单里，这条消息没有交给 agent。\n\n请让管理员在 Paseo 的 设置 → 飞书 里放行你：你会出现在「最近被挡下的消息」里。",
    );
  }
  return cardOf("还不能用", "grey", [
    markdown(`${who} 还不在这个机器人的名单里，这条消息没有交给 agent。\n管理员可以放行，放行后这条消息会接着处理。`),
    ...(input.notice ? [markdown(`<font color='red'>${escape(input.notice)}</font>`)] : []),
    {
      tag: "button",
      name: input.letIn,
      text: { tag: "plain_text", content: `放行 ${input.name ?? "这位"}`.slice(0, 100) },
      type: "primary_filled",
      behaviors: [{ type: "callback", value: { letIn: input.letIn } }],
    },
  ]);
}

/** `handled`: the message that raised the card is being handled now, not lost to a restart. */
export function letInCard(name: string | null, byName: string | null, handled: boolean): object {
  const who = name ? `**${escape(name)}**` : "这位";
  const by = byName ? `由 ${escape(byName)} ` : "";
  const next = handled ? "刚才那条消息正在处理。" : `刚才那条消息没留住，请${name ? escape(name) : "他"}再 @ 我一次。`;
  return card(
    "已放行",
    "green",
    `${who} 已${by}放行，可以 @ 我派活了。${next}\n需要批准的操作仍由管理员在卡片上批。`,
  );
}
