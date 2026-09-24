import type { LogDirInfo, RunSummary } from "../shared/rpc";
import type { CallStatus, CallType, PhaseStatus } from "../shared/run";
import type { Tone } from "./ui";

// How each state looks. Words live in shared/format.ts; this is color and icon only.

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

export const PHASE_LOOK: Record<PhaseStatus, { tone: Tone; icon: string }> = {
  pending: { tone: "neutral", icon: "Circle" },
  skipped: { tone: "neutral", icon: "CircleDashed" },
  running: { tone: "accent", icon: "Loader" },
  done: { tone: "success", icon: "CircleCheck" },
  failed: { tone: "danger", icon: "CircleX" },
  stopped: { tone: "warning", icon: "CircleStop" },
  interrupted: { tone: "warning", icon: "CircleHelp" },
};

export const CALL_LOOK: Record<CallStatus, { tone: Tone; icon: string }> = {
  running: { tone: "accent", icon: "Loader" },
  ok: { tone: "success", icon: "CircleCheck" },
  error: { tone: "danger", icon: "CircleX" },
  interrupted: { tone: "warning", icon: "CircleHelp" },
};

export const GATE_TONE: Record<string, Tone> = {
  allowed: "success",
  denied: "warning",
  expired: "warning",
  mismatch: "danger",
  error: "danger",
};

export const CALL_ICON: Record<CallType, string> = {
  ask: "Bot",
  do: "Cog",
  gate: "Hand",
};

export const LOG_DIR_SOURCE: Record<LogDirInfo["source"], string> = {
  settings: "插件设置里填的",
  env: "daemon 进程的环境变量 ORCH_LOG_DIR",
  config: "config.json 的 logDir",
  default: "默认位置",
};
