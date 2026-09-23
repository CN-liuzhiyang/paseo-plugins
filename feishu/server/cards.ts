// One card per request, patched in place: received, running, waiting, and one of done / failed /
// canceled. Card JSON 2.0, which only allows update_multi: true, so every state can be patched.

// Feishu caps a patched card at 30 KB serialized. Leave room for the frame and escaping.
const MAX_BODY_BYTES = 20_000;
const MAX_QUOTE_CHARS = 200;

type Template = "blue" | "wathet" | "orange" | "green" | "red" | "grey";

function card(title: string, template: Template, markdown: string): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements: [{ tag: "markdown", content: markdown }] },
  };
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
}

export function receivedCard(request: string): object {
  return card("已接收", "wathet", `${quote(request)}\n\n正在启动 agent。`);
}

function runFooter(run: RunView): string {
  return `<font color='grey'>${run.provider} · agent ${run.agentId.slice(0, 8)}</font>`;
}

export function runningCard(run: RunView, now: number): object {
  return card(
    `进行中 · ${formatElapsed(now - run.startedAt)}`,
    "blue",
    `${quote(run.request)}\n\n${runFooter(run)}`,
  );
}

export function waitingCard(run: RunView, what: string): object {
  return card(
    "等待审批",
    "orange",
    `${quote(run.request)}\n\nagent 请求：**${what}**\n在 Paseo 里批准或拒绝；飞书内审批在下一版。\n\n${runFooter(run)}`,
  );
}

export function doneCard(run: RunView, result: string, now: number): object {
  const body = result.trim() === "" ? "（agent 没有输出文字）" : result;
  return card(
    `完成 · ${formatElapsed(now - run.startedAt)}`,
    "green",
    `${truncateBytes(body, MAX_BODY_BYTES)}\n\n${runFooter(run)}`,
  );
}

export function failedCard(request: string, error: string, run?: RunView): object {
  const footer = run ? `\n\n${runFooter(run)}` : "";
  return card(
    "失败",
    "red",
    `${quote(request)}\n\n${truncateBytes(error, MAX_BODY_BYTES)}${footer}`,
  );
}

export function canceledCard(run: RunView, reason: string): object {
  return card("已取消", "grey", `${quote(run.request)}\n\n${reason}\n\n${runFooter(run)}`);
}

export function noRouteCard(chatId: string): object {
  return card(
    "这个会话还没有路由",
    "grey",
    `chat_id：\`${chatId}\`\n\n把它加进 feishu 插件设置的 routes，这个会话的消息才会交给 agent。`,
  );
}
