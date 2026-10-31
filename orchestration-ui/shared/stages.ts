// A run as the flow bar lists it when opened: one row per phase the flow declares, with the
// conversations that phase held. The full picture (nodes, time, evidence) stays in the 流程 tab.

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
  /** What a person did at this step, when there was one: "你批了". */
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

function noteOf(calls: readonly CallState[], status: RunStatus): string | null {
  const gate = calls.filter((call) => call.type === "gate").at(-1);
  if (!gate) return null;
  if (nodeState(gate, status) === "waiting") return "等你批准";
  const outcome = gateVerdict(gate)?.outcome;
  return outcome ? (GATE_NOTE[outcome] ?? outcome) : null;
}

function talksOf(run: RunState, calls: readonly CallState[], status: RunStatus): Talk[] {
  const talking = calls.filter((call) => (call.type === "ask" || call.type === "gate") && call.agentId !== null);
  return talking.map((call) => ({
    callId: call.callId,
    agentId: call.agentId!,
    waiting: nodeState(call, status) === "waiting",
    label: talking.length > 1 ? callTitle(run, call) : null,
  }));
}

export function stageRows(run: RunState, status: RunStatus): StageRow[] {
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
