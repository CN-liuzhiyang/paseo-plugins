import type { LogDirInfo, RunSummary } from "../shared/rpc";
import type { NodeState, StripState, VisitState } from "../shared/graph";
import type { CallType, RunStatus } from "../shared/run";
import type { Tone } from "./ui";

// How each state looks. Words live in shared/format.ts and shared/graph.ts; this is color and icon.

export const RUN_LOOK: Record<RunSummary["status"], { tone: Tone; icon: string }> = {
  done: { tone: "success", icon: "CircleCheck" },
  stopped: { tone: "warning", icon: "CircleStop" },
  failed: { tone: "danger", icon: "CircleX" },
  timeout: { tone: "danger", icon: "TimerOff" },
  running: { tone: "accent", icon: "Loader" },
  lost: { tone: "warning", icon: "Unplug" },
  starting: { tone: "neutral", icon: "Hourglass" },
  unreadable: { tone: "danger", icon: "TriangleAlert" },
};

export const HERO_ICON: Record<RunStatus, string> = {
  done: "Check",
  stopped: "CircleStop",
  failed: "X",
  timeout: "TimerOff",
  running: "Loader",
  lost: "Unplug",
  starting: "Hourglass",
};

export const NODE_LOOK: Record<NodeState, { tone: Tone; mark: string; label: string }> = {
  ok: { tone: "success", mark: "✓", label: "完成" },
  error: { tone: "danger", mark: "✕", label: "失败" },
  running: { tone: "accent", mark: "●", label: "运行中" },
  waiting: { tone: "warning", mark: "●", label: "等你批准" },
  interrupted: { tone: "warning", mark: "?", label: "没有结束记录" },
};

export const VISIT_LOOK: Record<VisitState | StripState, { tone: Tone; label: string }> = {
  done: { tone: "success", label: "完成" },
  running: { tone: "accent", label: "进行中" },
  waiting: { tone: "warning", label: "等人" },
  failed: { tone: "danger", label: "失败" },
  stopped: { tone: "warning", label: "在此停下" },
  interrupted: { tone: "warning", label: "没有结束记录" },
  pending: { tone: "neutral", label: "还没到" },
  skipped: { tone: "neutral", label: "没有进入" },
};

/** The small badge on a node: who does the work. */
export const KIND_LOOK: Record<CallType, { label: string; tone: Tone; name: string }> = {
  ask: { label: "AI", tone: "accent", name: "agent 调用" },
  do: { label: "脚本", tone: "neutral", name: "脚本动作" },
  gate: { label: "人闸", tone: "warning", name: "人闸" },
};

export const GATE_TONE: Record<string, Tone> = {
  allowed: "success",
  denied: "warning",
  expired: "warning",
  mismatch: "danger",
  error: "danger",
};

export const LOG_DIR_SOURCE: Record<LogDirInfo["source"], string> = {
  settings: "插件设置里填的",
  env: "daemon 进程的环境变量 ORCH_LOG_DIR",
  config: "config.json 的 logDir",
  default: "默认位置",
};
