// Words and numbers for people. Pure so the list, the detail view and the tests say the same thing.

import {
  callStatus,
  gateVerdict,
  ms,
  openCalls,
  phaseTitle,
  staleAfterMs,
  type CallState,
  type PhaseStatus,
  type ProcessCheck,
  type RunState,
  type RunStatus,
} from "./run";

export function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${Math.round(value)} 毫秒`;
  const seconds = Math.floor(value / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/** The same, tight enough for a node: "42秒", "3分12秒", "1时05分". */
export function formatShort(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return "<1秒";
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}分${String(seconds % 60).padStart(2, "0")}秒` : `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  return `${hours}时${String(minutes % 60).padStart(2, "0")}分`;
}

export function formatUsd(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local wall-clock time; the date only when it is not today. */
export function formatTime(iso: string | null, now: number = Date.now()): string {
  const at = ms(iso);
  if (at === null) return "—";
  const date = new Date(at);
  const today = new Date(now);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (date.toDateString() === today.toDateString()) return time;
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === today.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`;
}

export function formatAgo(iso: string | null, now: number): string {
  const at = ms(iso);
  if (at === null) return "—";
  const delta = now - at;
  if (delta < 5_000) return "刚刚";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return `${Math.floor(delta / 1_000)} 秒前`;
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} 小时前` : `${hours} 小时 ${minutes % 60} 分前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export const RUN_STATUS_LABEL: Record<RunStatus | "unreadable", string> = {
  done: "完成",
  stopped: "已停止",
  failed: "失败",
  timeout: "超时",
  running: "运行中",
  lost: "失联",
  starting: "启动中",
  unreadable: "读不了",
};

export const PHASE_STATUS_LABEL: Record<PhaseStatus, string> = {
  pending: "未开始",
  skipped: "未进入",
  running: "进行中",
  done: "完成",
  failed: "出错",
  stopped: "在此停止",
  interrupted: "未结束",
};

export const CALL_TYPE_LABEL: Record<string, string> = {
  ask: "agent",
  do: "动作",
  gate: "人闸",
};

export const GATE_OUTCOME_LABEL: Record<string, string> = {
  allowed: "已批准",
  denied: "已拒绝",
  expired: "过期未批",
  mismatch: "原文被改过",
  error: "出错",
};

export const EFFECTS_LABEL: Record<string, string> = {
  none: "请求只读",
  workspace: "可改工作区",
};

/** "请求只读 · 未强制": what the step asked for, and whether anything holds it to that. */
export function fenceLabel(call: CallState): string | null {
  const ask = call.ask;
  if (!ask) return null;
  const effects = ask.effects === null ? "影响范围未声明" : (EFFECTS_LABEL[ask.effects] ?? ask.effects);
  if (!ask.fence) return `${effects} · 无栅栏信息`;
  const mode = ask.fence.mode ? `（${ask.fence.mode}）` : "";
  return `${effects} · ${ask.fence.enforced ? "已强制" : "未强制"}${mode}`;
}

/** "reviewer · claude/claude-opus-5-5 · thinking high" */
export function askLine(call: CallState): string | null {
  const ask = call.ask;
  if (!ask) return null;
  return [ask.role ?? "（无角色，直接指定模型）", ask.provider, ask.thinking ? `thinking ${ask.thinking}` : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function byLabel(by: string | null): string {
  if (by === null || by === "") return "不知道是谁（判定里没有 by）";
  if (by === "unattributed") return "未能归属到具体的人（unattributed）";
  return by;
}

/** One sentence on what a call is doing right now, for the run's banner and the list. */
function describeOpen(call: CallState, run: RunState, status: RunStatus, now: number): string {
  const since = ms(call.startedAt);
  // A lost run's clock stopped at its last event; counting on to now would claim it kept going.
  const elapsed =
    since === null ? "" : status === "lost" ? `，${formatTime(call.startedAt, now)} 开始` : `，已 ${formatDuration(now - since)}`;
  const where = call.phase ? `「${phaseTitle(run, call.phase)}」` : "";
  if (call.type === "gate") return `等人审批：${call.title}${elapsed}`;
  if (call.type === "ask") return `${where}等 ${call.ask?.role ?? call.ask?.provider ?? "agent"} 回答：${call.title}${elapsed}`;
  return `${where}执行：${call.title}${elapsed}`;
}

/** What is happening in a run without run.end, or what was happening when it went quiet. */
export function activity(
  run: RunState,
  status: RunStatus,
  now: number,
  { proc = null, staleMs = null }: { proc?: ProcessCheck | null; staleMs?: number | null } = {},
): string | null {
  if (run.end) return null;
  if (!run.start) return "文件已创建，第一条事件还没写完";
  const open = openCalls(run).filter((call) => callStatus(call, status) !== "ok");
  const last = `最后一条事件在 ${formatAgo(run.lastEventAt, now)}（${formatTime(run.lastEventAt, now)}）`;
  const lost =
    proc && !proc.alive
      ? `运行进程（pid ${proc.pid}）已退出，没有写出 run.end。${last}`
      : `${last}，之后没有新事件，也没有 run.end`;
  // A live process that has been quiet past the threshold: running, but say how quiet.
  const lastAt = ms(run.lastEventAt);
  const quietAlive =
    status === "running" && proc?.alive && staleMs !== null && lastAt !== null && now - lastAt > staleAfterMs(run, staleMs)
      ? `（${formatDuration(now - lastAt)}没有新事件；进程 pid ${proc.pid} 还在）`
      : "";
  if (open.length === 0) {
    const phases = run.phaseOrder
      .map((id) => run.phases.get(id)!)
      .filter((phase) => phase.starts > phase.ends)
      .map((phase) => `「${phase.title}」`);
    const doing = phases.length > 0 ? `在阶段${phases.join("、")}里，调用之间` : "在调用之间（脚本自己的代码在跑）";
    return status === "lost" ? `${lost}。当时${doing}` : `${doing}${quietAlive}`;
  }
  const described = open.slice(0, 3).map((call) => describeOpen(call, run, status, now));
  const more = open.length > 3 ? `；另有 ${open.length - 3} 个调用进行中` : "";
  const text = `${described.join("；")}${more}`;
  return status === "lost" ? `${lost}。当时：${text}` : `${text}${quietAlive}`;
}

export function callStatusText(call: CallState, status: RunStatus): string {
  const state = callStatus(call, status);
  if (call.type === "gate" && call.end) {
    const verdict = gateVerdict(call);
    if (verdict?.outcome) return GATE_OUTCOME_LABEL[verdict.outcome] ?? verdict.outcome;
  }
  switch (state) {
    case "running":
      return call.type === "gate" ? "等待审批" : "进行中";
    case "ok":
      return "完成";
    case "error":
      return "出错";
    case "interrupted":
      return "没有结束记录";
  }
}
