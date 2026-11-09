// What the run's page says about itself in a glance, and how a run that carries on an earlier one keeps
// the steps it took over out of the way. Pure and derived from shared/run.ts and shared/graph.ts.

import { formatCost, formatDuration } from "./format";
import type { Graph, Stage } from "./graph";
import { ms, hasUncountedCodex, runCost, type CallState, type RunState, type RunStatus } from "./run";

/** What "taken from an earlier run" is called wherever it is drawn. */
export const REUSED_LEAD = (steps: number) => `前面 ${steps} 步沿用上一段`;

/**
 * A step that was only taken over: answered by an earlier run, nothing asked, nobody asked again.
 * A script that ran again beside it (cheap, and it did run) does not make the stage a new one.
 */
function takenOver(call: CallState): boolean {
  return call.reused !== null || (call.type === "do" && call.end?.ok === true);
}

/** A stage that has at least one taken-over step and nothing real in it: the whole stage was a replay. */
export function replayedStage(stage: Stage): boolean {
  const calls = stage.visit.calls;
  return calls.some((call) => call.reused !== null) && calls.every(takenOver);
}

export interface ReusedLead {
  /** How many pieces after the input the lead covers: graph.pieces[1..pieces]. */
  pieces: number;
  /** How many steps were taken over in them. */
  steps: number;
}

/**
 * The stages at the front of a run that did nothing this time: a run that carries on an earlier one starts
 * the flow from the top, and everything the earlier run already did is a replay. They fold into one line
 * ("前面 5 步沿用上一段") so nobody reads them as asked, written or approved all over again. Null when the run
 * took nothing over, or the first thing that happened this time comes before it.
 */
export function reusedLead(graph: Graph): ReusedLead | null {
  let pieces = 0;
  let steps = 0;
  for (const piece of graph.pieces.slice(1)) {
    if (piece.kind !== "column" || !piece.stages.every(replayedStage)) break;
    pieces += 1;
    steps += piece.stages.reduce((sum, stage) => sum + stage.visit.calls.filter((call) => call.reused !== null).length, 0);
  }
  return steps > 0 ? { pieces, steps } : null;
}

/** How many times a person approved something in this run itself; a gate taken from the run before is not one. */
export function approvedHere(run: RunState): number {
  let count = 0;
  for (const call of run.calls.values()) {
    if (call.type !== "gate" || call.reused) continue;
    if (call.end?.ok && (call.end.output as { outcome?: unknown } | null)?.outcome === "allowed") count += 1;
  }
  return count;
}

/** The figure for a run's cost in a line: the whole cost once it ended, what is counted so far before. */
export function spendOf(run: RunState, soFar: number): string | null {
  // Nothing asked this time (a run that only carried on) is not "$0": there is no figure to give.
  if (![...run.calls.values()].some((call) => call.type === "ask" && !call.reused)) return null;
  const cost = runCost(run);
  if (run.end) return run.end.cost ? formatCost(cost.usd, cost) : null;
  return formatCost(soFar, { unknown: cost.unknown, estimated: cost.estimated });
}

/**
 * "9 分 20 秒 · $1.14 · 你批过 2 次": the numbers a run's top gives, in one line. Time and cost are this run's
 * own; a step taken over adds nothing to either, and a gate taken over is not an approval of this run.
 * Anything that is not known is left out rather than shown as a dash or a zero.
 */
export function numbersLine(run: RunState, status: RunStatus, clock: number, soFar: number): string {
  const started = ms(run.startedAt);
  const took = run.end?.durationMs ?? (started === null ? null : clock - started);
  const lead = status === "running" || status === "starting" ? "已跑 " : "";
  const spent = spendOf(run, soFar);
  const approved = approvedHere(run);
  return [
    took === null ? null : `${lead}${formatDuration(took)}`,
    spent === null ? null : `${spent}${hasUncountedCodex(run) ? "（不含 Codex）" : ""}`,
    approved > 0 ? `你批过 ${approved} 次` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
