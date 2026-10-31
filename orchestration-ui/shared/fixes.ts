// How an answer was sent back, asked again or taken from an earlier run, in the words a person reads.
// Pure and derived from shared/run.ts; the card, the flow bar and the run view say the same thing.

import type { Tone } from "./graph";
import type { CallState, Fix, RunState } from "./run";

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The round being worked on right now: the agent was given the problems and has not handed the round back. */
export function fixingOf(call: CallState): { round: number; count: number } | null {
  const fix = call.fixes.at(-1);
  if (call.type !== "ask" || call.end || !fix || fix.fixed) return null;
  return { round: fix.round, count: fix.problems.length };
}

/** "改 1 处（第 2 轮）". */
export function fixingText(fixing: { round: number; count: number }): string {
  return `改 ${fixing.count} 处（第 ${fixing.round} 轮）`;
}

/** How many times a finished call was sent back: 3 answers is 2. */
export function fixRounds(call: CallState): number {
  return call.end ? call.end.rounds - 1 : 0;
}

export interface Mark {
  label: string;
  tone: Tone;
}

/** What a call taken from an earlier run is called wherever it is drawn. */
export const REUSED = "沿用上一段";

/** The small tags on a call: what happened to it that the plain node does not say. */
export function callMarks(call: CallState): Mark[] {
  const marks: Mark[] = [];
  if (call.continues) marks.push({ label: "接着问", tone: "accent" });
  if (call.revises) marks.push({ label: "换人重做", tone: "neutral" });
  const rounds = fixRounds(call);
  if (rounds > 0) marks.push({ label: `改 ${rounds} 轮`, tone: "warning" });
  return marks;
}

/** A JSON pointer as a person reads it: `/edits/4/old` is `edits › 第 5 项 › old`, "" is the whole answer. */
export function pathLabel(pointer: string): string {
  if (pointer === "") return "整份答案";
  if (!pointer.startsWith("/")) return pointer;
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((token) => (/^\d+$/.test(token) ? `第 ${Number(token) + 1} 项` : token))
    .join(" › ");
}

/**
 * What came back for the n-th problem of a round (from 0). The agent answers a partial round as
 * `{ f1, f2 }`, one key per problem in the order they were sent; a round on the whole answer comes back as the
 * answer. `undefined` when the round has not come back or the reply does not say.
 */
export function returnedFor(fix: Fix, index: number): { value: unknown } | undefined {
  const answer = fix.fixed?.answer;
  if (answer === undefined || answer === null) return undefined;
  if (isObj(answer) && `f${index + 1}` in answer) return { value: answer[`f${index + 1}`] };
  return fix.problems.length === 1 && fix.problems[0]!.at === "" ? { value: answer } : undefined;
}

/**
 * The step a stop that the flow did not choose is about: an answer that never passed its check, or a
 * step that cannot be taken back with no record of whether it happened. Null for a stop the flow asked
 * for, and for files that do not say which kind it was.
 */
export function stoppedStep(run: RunState): { kind: "check" | "unknown"; label: string; asked: CallState | null } | null {
  const stop = run.end?.outcome === "stopped" ? run.end.stop : null;
  if (!stop?.step) return null;
  if (stop.kind === "check") {
    const asked = [...run.calls.values()].filter((call) => call.type === "ask" && call.name === stop.step).at(-1) ?? null;
    return { kind: "check", label: asked?.title ?? stop.step, asked };
  }
  if (stop.kind === "unknown") {
    // The runtime's sentence opens with the step's title in 「」; the event itself carries only the name.
    return { kind: "unknown", label: /^「([^」]{1,40})」/.exec(stop.reason)?.[1] ?? stop.step, asked: null };
  }
  return null;
}

/** The one line for such a stop, on the card and at the top of the run. */
export function stopLine(run: RunState): string | null {
  const step = stoppedStep(run);
  if (!step) return null;
  if (step.kind === "unknown") return `要你确认「${step.label}」做没做`;
  return `${step.label}核对${step.asked?.end ? ` ${step.asked.end.rounds} 轮` : "多轮"}还不过`;
}
