// What a flow says about how its run could be carried on: a resume point, `{ flow, input, from, spends }`, as
// `$.resumeWith` takes it and as the `resume` event and `run.end.resume` record it. This is its shape only, a file with
// nothing to read or start, so that the runner (run.mjs), the contract check (events.mjs) and `orch resume`
// (resume.mjs) all say the same thing is wrong. That the flow exists and the input fits it is checked where the
// flow can be looked up (resume.mjs, `checkResumePoint`).
//
//   { flow: "build-resume",                                   // a flow's name, never a path
//     input: { dir: "batch-1" },                   // what that flow's `inputs` ask for
//     from: "编译已过：从提交前的核对接着，不重编",               // one line for a person, at most FROM_LIMIT characters
//     spends: "nothing" }                                     // "nothing": no model is called; "maybe": one may be

import { textProblem } from "./affair.mjs";
import { isFlowName } from "./resolve.mjs";

/** `from` is drawn on a button's side, so it is short: characters (code points). */
export const FROM_LIMIT = 60;
export const SPENDS = ["nothing", "maybe"];
export const POINT_KEYS = ["flow", "input", "from", "spends"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * What is wrong with a resume point as a value: an empty list when it fits. Every key is required (R2: there are no
 * optional fields), and the file a resume point is read back from can be edited by anyone with the disk, so a reader runs
 * this too.
 *
 * @param {unknown} point
 * @returns {string[]}
 */
export function pointProblems(point) {
  if (!isObject(point)) return ["a resume point is { flow, input, from, spends }"];
  const problems = [];
  for (const key of Object.keys(point)) {
    if (!POINT_KEYS.includes(key)) problems.push(`unknown key "${key}"; keys: ${POINT_KEYS.join(", ")}`);
  }
  for (const key of POINT_KEYS) {
    if (!(key in point)) problems.push(`${key} is missing: a resume point has ${POINT_KEYS.join(", ")}`);
  }
  if ("flow" in point && !(typeof point.flow === "string" && isFlowName(point.flow))) {
    problems.push(`flow must be a flow's name (lowercase letters, digits and dashes), not a path or anything else: ${JSON.stringify(point.flow)}`);
  }
  if ("input" in point && !isObject(point.input)) problems.push("input must be an object, the input of that flow");
  if ("from" in point) {
    const from = textProblem("from", point.from, FROM_LIMIT);
    if (from) problems.push(from);
  }
  if ("spends" in point && !SPENDS.includes(point.spends)) problems.push(`spends must be ${SPENDS.map((s) => `"${s}"`).join(" or ")}, got ${JSON.stringify(point.spends)}`);
  return problems;
}

/** The point as it is recorded: the four keys, in this order, nothing else. */
export const pointOf = (point) => ({ flow: point.flow, input: point.input, from: point.from, spends: point.spends });
