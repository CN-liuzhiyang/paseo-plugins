// Answer smoke: one cheap agent asked for a field in a form it cannot guess, so the check fails the first time and the
// agent is asked, in the same session, to redo that one field. A few cents; it is how a person checks, against a real
// Paseo, that a wrong answer goes back to the agent that gave it and comes back merged.
//
//   node runtime/orch.mjs run flows/answer-smoke.mjs
//
// In the run's events: `call.fix` / `call.fixed` for round 2 and `call.end.rounds` 2 on this Paseo's CLI. The agent's own
// conversation holds the second message: only the problem and a schema for one field (`f1`), not the prompt again. On a
// CLI without `send --output-schema` the run says so in a caveat and stops with `CheckFailed`; that is the old-CLI path.

import { flow, define, text, pointer } from "../runtime/flow.mjs";

const answer = define({
  name: "answer",
  title: "答一个带格式的字段",
  headline: "tag",
  effects: "none",
  timeout: "5m",
  returns: { color: text("one colour word"), tag: text("a short tag for that colour") },
  prompt: () => "Name a colour, and give a short tag for it.",
});

const TAG = /^[A-Z]{3}-\d$/;

export default flow({
  name: "answer-smoke",
  description: "打回冒烟：问一个小问题，字段 tag 的格式它猜不到，核对第一次必不过，看运行时把问题发回同一个 agent、改完合并回来；几分钱",
  phases: [],
  inputs: {},
  grants: [],
  run: (_, $) =>
    $.ask(answer, {}, {
      role: "fast",
      check: (a) => (TAG.test(a.tag) ? [] : [{ at: pointer("tag"), say: "the tag must look like ABC-1: three capital letters, a dash, a digit" }]),
    }),
  summarize: (value) => `${value.color} · ${value.tag}`,
});
