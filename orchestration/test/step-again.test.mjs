// `$.step` hands back a JSON copy, and `$.again` only knows the object `$.ask` gave: what that means for a flow that uses both. A fake
// executor answers. Nothing here talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { runFlow } from "../runtime/run.mjs";
import { flow, define, text } from "../runtime/flow.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const plan = define({ name: "plan", effects: "none", timeout: "5m", returns: { body: text("the plan") }, prompt: () => "plan" });
const make = (body) => flow({ name: "step-again", description: "d", phases: [], inputs: {}, grants: [], run: (_, $) => body($) });
const go = async (target, logDir, extra = {}) => {
  const answers = ["first", "second"];
  const executor = fakeExecutor({ answer: () => ({ body: answers.shift() }) });
  const result = await runFlow(target, { roster, caller: null, executor, cwd: "C:/work", logDir, agentProbeDelays: [], ...extra });
  return { result, executor };
};

test("an answer that came out of a $.step cannot be asked again, and the error says what to do", async () => {
  const logDir = await tempDir("orch-sa-");
  const { result } = await go(make(async ($) => $.again(await $.step("plan", () => $.ask(plan, {}, { role: "fast" })), "revise")), logDir);
  assert.equal(result.outcome, "failed");
  assert.match(result.error.message, /came out of \$\.step/);
  assert.match(result.error.message, /inside the one step/);
});

test("asking and asking again inside the one step works, and the step's value is the last version, taken from the journal by a run that carries on", async () => {
  const logDir = await tempDir("orch-sa-");
  const target = make(($) =>
    $.step("plan", async () => {
      const first = await $.ask(plan, {}, { role: "fast" });
      return $.again(first, "tighten it", { fresh: true });
    }),
  );
  const { result: first, executor } = await go(target, logDir, { runId: "sa-1" });
  assert.deepEqual(first.value, { body: "second" });
  assert.equal(executor.requests.length, 2);
  const { result: next, executor: other } = await go(target, logDir, { lineage: "sa-1", resumeOf: "sa-1" });
  assert.deepEqual(next.value, { body: "second" });
  assert.equal(other.requests.length, 0, "nothing was asked: the step's value is taken");
});
