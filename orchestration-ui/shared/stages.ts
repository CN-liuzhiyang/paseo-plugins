// A run as the flow bar lists it when opened: one row per phase the flow declares, with the
// conversations that phase held. The full picture (nodes, time, evidence) stays in the 流程 tab.

import { fixingOf, fixingText, fixRounds, REUSED, stoppedStep } from "./fixes";
import { callTitle, graphVisits, nodeState, visitState, type VisitState } from "./graph";
import { gateVerdict, type CallState, type RunState, type RunStatus } from "./run";

/** A conversation a row can open: the agent behind an ask, or the one carrying a gate's card. */
export interface Talk {
  callId: string;
  agentId: string;
  /** A gate nobody has answered yet: the button is "去批准", not "对话". */
  waiting: boolean;
  /** Which of several in the same row; null when the row has only this one. */
  label: string | null;
}

export type StageState = VisitState | "pending" | "skipped";

export interface StageRow {
  key: string;
  title: string;
  state: StageState;
  /** What a person did at this step, or what happened to its answers: "你批了", "改过 1 轮". */
  note: string | null;
  talks: Talk[];
}

const STAGE_OF_NODE = { ok: "done", error: "failed", running: "running", waiting: "waiting", interrupted: "interrupted" } as const;

const GATE_NOTE: Record<string, string> = {
  allowed: "你批了",
  denied: "你拒了",
  expired: "过期了，按拒绝",
  mismatch: "原文被改过",
  error: "出错了",
};

function gateNote(calls: readonly CallState[], status: RunStatus): string | null {
  const gate = calls.filter((call) => call.type === "gate").at(-1);
  if (!gate) return null;
  if (nodeState(gate, status) === "waiting") return "等你批准";
  const outcome = gateVerdict(gate)?.outcome;
  return outcome ? (GATE_NOTE[outcome] ?? outcome) : null;
}

/** What happened to the answers of these calls: being sent back now, sent back before, or taken from an earlier run. */
function fixNote(calls: readonly CallState[], status: RunStatus): string | null {
  const live = status === "running" || status === "starting";
  const fixing = live ? calls.map(fixingOf).find((one) => one !== null) : undefined;
  if (fixing) return fixingText(fixing);
  const rounds = calls.reduce((sum, call) => sum + fixRounds(call), 0);
  if (rounds > 0) return `改过 ${rounds} 轮`;
  return calls.length > 0 && calls.every((call) => call.reused) ? REUSED : null;
}

function noteOf(calls: readonly CallState[], status: RunStatus): string | null {
  return [gateNote(calls, status), fixNote(calls, status)].filter(Boolean).join(" · ") || null;
}

function talksOf(run: RunState, calls: readonly CallState[], status: RunStatus): Talk[] {
  // `$.again` carries on the same agent's conversation: one button for it, not one per question.
  const seen = new Set<string>();
  const talking = calls.filter((call) => {
    if (!(call.type === "ask" || call.type === "gate") || call.agentId === null || seen.has(call.agentId)) return false;
    seen.add(call.agentId);
    return true;
  });
  return talking.map((call) => ({
    callId: call.callId,
    agentId: call.agentId!,
    waiting: nodeState(call, status) === "waiting",
    label: talking.length > 1 ? callTitle(run, call) : null,
  }));
}

/** A step that cannot be taken back has no call of its own when the run stops on it: the stop says which. */
function unknownStepRow(run: RunState): StageRow[] {
  const step = stoppedStep(run);
  return step?.kind === "unknown" ? [{ key: `@stop:${step.label}`, title: step.label, state: "failed", note: "不知道做没做", talks: [] }] : [];
}

export function stageRows(run: RunState, status: RunStatus): StageRow[] {
  return [...phaseRows(run, status), ...unknownStepRow(run)];
}

function phaseRows(run: RunState, status: RunStatus): StageRow[] {
  const live = status === "running" || status === "starting";
  if (run.phaseOrder.length === 0) {
    // A flow that declares no phases: the calls are the steps.
    return run.callOrder
      .map((id) => run.calls.get(id)!)
      .filter((call) => call.startedAt !== null)
      .map((call) => ({
        key: call.callId,
        title: callTitle(run, call),
        state: STAGE_OF_NODE[nodeState(call, status)],
        note: noteOf([call], status),
        talks: talksOf(run, [call], status),
      }));
  }
  const visits = graphVisits(run);
  return run.phaseOrder.map((id) => {
    const phase = run.phases.get(id)!;
    const latest = visits.filter((visit) => visit.phase === id).at(-1);
    const calls = phase.callIds.map((callId) => run.calls.get(callId)).filter((call): call is CallState => call !== undefined);
    return {
      key: id,
      title: phase.title,
      state: latest ? visitState(latest, run, status) : live ? "pending" : "skipped",
      note: noteOf(calls, status),
      talks: talksOf(run, calls, status),
    };
  });
}

/**
 * Steps with nothing to open and nothing to say are one line when they sit together: the ones done
 * ("读单、检查副本") and the ones still ahead ("更新 · 编译 · 提交").
 */
export function compactStages(rows: readonly StageRow[]): StageRow[] {
  const plain = (row: StageRow) => row.talks.length === 0 && row.note === null && (row.state === "done" || row.state === "pending" || row.state === "skipped");
  const out: StageRow[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last && plain(last) && plain(row) && last.state === row.state) {
      out[out.length - 1] = { ...last, key: `${last.key}+${row.key}`, title: `${last.title}${last.state === "done" ? "、" : " · "}${row.title}` };
    } else {
      out.push(row);
    }
  }
  return out;
}
