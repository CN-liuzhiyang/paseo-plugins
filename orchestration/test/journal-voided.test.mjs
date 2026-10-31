// What is to be done again stays undone-as-a-record: `--redo` (also for the steps inside the one named, and for a run that stops before it
// has visited everything), a place whose new result cannot be kept, a value a probe finds, and an answer that no longer passes the check.
// A fake executor answers. Nothing here talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runFlow } from "../runtime/run.mjs";
import { flow, define, text } from "../runtime/flow.mjs";
import { readEvents } from "../runtime/events.mjs";
import { Journal, fingerprint } from "../runtime/journal.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { settleRun, UsageError } from "../runtime/orch.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const go = (target, logDir, extra = {}) => runFlow(target, { roster, caller: null, executor: fakeExecutor(), cwd: "C:/work", logDir, gatePollMs: 5, agentProbeDelays: [], ...extra });
const carry = (target, logDir, line, extra = {}) => go(target, logDir, { lineage: line, resumeOf: line, ...extra });
const make = (body, grants = []) => flow({ name: "voided-test", description: "d", phases: [], inputs: {}, grants, run: (_, $) => body($) });
const secretExecutor = (value) => fakeExecutor({ carrier: "input", inputValue: value });
const askSecret = ($) => $.gate({ title: "code", content: "authorize", input: { label: "value" } });
const states = (logDir, line) => new Journal({ dir: logDir, lineage: line }).steps().map((e) => `${e.id}:${e.state}`);
const startsOf = (result) => readEvents(result.events).filter((e) => e.kind === "call.start");

test("a step set aside by --redo stays set aside for the runs after one that stopped before it got there", async () => {
  const logDir = await tempDir("orch-void-");
  const first = await go(
    make(async ($) => {
      await $.step("build", () => "old");
      return $.step("report", () => "old-report");
    }),
    logDir,
    { runId: "redo-1" },
  );
  assert.equal(first.value, "old-report");
  const second = await carry(
    make(async ($) => {
      assert.equal(await $.step("build", () => "new"), "new");
      return $.stop("before report");
    }),
    logDir,
    "redo-1",
    { redo: "build" },
  );
  assert.equal(second.outcome, "stopped");
  assert.deepEqual(states(logDir, "redo-1").sort(), ["step:build:done", "step:report:voided"], "the report was set aside when the redo began");

  let reports = 0;
  const third = await carry(
    make(async ($) => {
      const build = await $.step("build", () => "not-called");
      return { build, report: await $.step("report", () => (reports += 1, "new-report")) };
    }),
    logDir,
    "redo-1",
  );
  assert.deepEqual(third.value, { build: "new", report: "new-report" }, "the build of the redo is taken, the report is done");
  assert.equal(reports, 1);
});

test("--redo of a step also sets aside the steps and asks that were inside it, which were written before it was", async () => {
  const logDir = await tempDir("orch-void-");
  let calls = 0;
  const target = make(($) => $.step("outer", () => $.step("inner", () => ++calls)));
  const first = await go(target, logDir, { runId: "nest-1" });
  assert.equal(first.value, 1);
  assert.equal((await carry(target, logDir, "nest-1")).value, 1, "carried on without --redo: both taken");
  const second = await carry(target, logDir, "nest-1", { redo: "outer" });
  assert.equal(second.value, 2, "the inner step was done again");
  assert.equal(calls, 2);
  assert.equal((await carry(target, logDir, "nest-1")).value, 2, "and its new value is the one that stands");
});

test("a step whose new value cannot be kept does not bring back the old one for the run after", async () => {
  const logDir = await tempDir("orch-void-");
  const first = await go(make(async ($) => $.step("work", () => "old")), logDir, { runId: "keep-1" });
  assert.equal(first.value, "old");
  const withSecret = make(async ($) => {
    const given = await askSecret($);
    return $.step("work", () => given.input, { still: () => false });
  }, ["gate:deny"]);
  const second = await carry(withSecret, logDir, "keep-1", { executor: secretExecutor("secret-1234") });
  assert.equal(second.outcome, "done");
  assert.equal(readFileSync(new Journal({ dir: logDir, lineage: "keep-1" }).file, "utf8").includes("secret-1234"), false);
  let done = 0;
  const third = await carry(make(async ($) => $.step("work", () => (done += 1, "new-result"))), logDir, "keep-1");
  assert.equal(third.value, "new-result", "not the old value");
  assert.equal(done, 1);
});

test("an answer that is asked for again and whose new answer cannot be kept does not bring back the old one either", async () => {
  const logDir = await tempDir("orch-void-");
  const step = define({ name: "draft", effects: "none", timeout: "5m", returns: { body: text("the text") }, prompt: () => "write" });
  const first = await carry(make(($) => $.ask(step, {}, { role: "fast" })), logDir, "ans-1", { executor: fakeExecutor({ answer: () => ({ body: "first" }) }) });
  assert.deepEqual(first.value, { body: "first" });
  // The second run learns a secret, says the earlier answer does not hold (reuse), and is given an answer with the secret in it.
  const second = await carry(
    make(async ($) => {
      await askSecret($);
      return $.ask(step, {}, { role: "fast", reuse: () => false });
    }, ["gate:deny"]),
    logDir,
    "ans-1",
    { executor: fakeExecutor({ carrier: "input", inputValue: "secret-5678", answer: () => ({ body: "has secret-5678 inside" }) }) },
  );
  assert.equal(second.outcome, "done");
  assert.equal(readFileSync(new Journal({ dir: logDir, lineage: "ans-1" }).file, "utf8").includes("secret-5678"), false);
  const asked = [];
  const third = await carry(make(($) => $.ask(step, {}, { role: "fast" })), logDir, "ans-1", { executor: fakeExecutor({ answer: (request) => (asked.push(request), { body: "third" }) }) });
  assert.deepEqual(third.value, { body: "third" }, "asked, not the first answer");
  assert.equal(asked.length, 1);
});

test("an answer in the journal has to pass this run's check; one that does not is set aside and asked for again, with a caveat", async () => {
  const logDir = await tempDir("orch-void-");
  const step = define({ name: "pick", effects: "none", timeout: "5m", returns: { answer: text("an answer") }, prompt: () => "pick" });
  let wanted = "old";
  let checks = 0;
  const ex = fakeExecutor({ answer: () => ({ answer: wanted === "old" ? "old" : "new" }) });
  const target = make(($) =>
    $.ask(step, {}, {
      role: "fast",
      check: (answer) => {
        checks += 1;
        return answer.answer === wanted ? [] : [{ at: "/answer", say: `must be ${wanted}` }];
      },
    }),
  );
  const first = await go(target, logDir, { runId: "chk-1", executor: ex });
  assert.deepEqual(first.value, { answer: "old" });
  wanted = "new";
  const second = await carry(target, logDir, "chk-1", { executor: ex });
  assert.deepEqual(second.value, { answer: "new" }, "asked again, to a new agent");
  assert.equal(ex.requests.length, 2);
  assert.equal(startsOf(second)[0].reused, null);
  assert.equal(readEvents(second.events).some((e) => e.kind === "caveat" && /does not pass this run's check/.test(e.text)), true);
  // The new answer stands for the run after.
  const third = await carry(target, logDir, "chk-1", { executor: ex });
  assert.deepEqual(third.value, { answer: "new" });
  assert.equal(ex.requests.length, 2, "taken from the journal: it passes");
  assert.ok(checks >= 4);
});

test("a value a probe finds for a step that cannot be taken back goes the way a step's own does: not kept when it holds a secret or is too big", async () => {
  const logDir = await tempDir("orch-void-");
  const begun = (line) => new Journal({ dir: logDir, lineage: line }).append({ id: "step:publish", kind: "step", state: "begun", once: true, keyPrint: fingerprint(null), runId: line, callId: "c1" }, { sync: true });
  begun("pr-1");
  const withSecret = make(async ($) => {
    const given = await askSecret($);
    return $.step("publish", () => assert.fail("must not run"), { once: true, probe: () => ({ done: true, value: { code: given.input } }) });
  }, ["gate:deny"]);
  const found = await carry(withSecret, logDir, "pr-1", { executor: secretExecutor("probe-secret-9999") });
  assert.equal(found.outcome, "done");
  assert.deepEqual(found.value, { code: "probe-secret-9999" }, "this run gets what the probe found");
  const journal = new Journal({ dir: logDir, lineage: "pr-1" });
  assert.equal(readFileSync(journal.file, "utf8").includes("probe-secret-9999"), false, "but the journal does not hold it");
  const after = journal.get("step:publish");
  assert.deepEqual([after.state, after.done, after.dropped, after.value], ["settled", true, true, undefined]);

  // The record says it was done and holds no value: a run after it asks the probe again, and without one stops for a person.
  const again = await carry(make(($) => $.step("publish", () => assert.fail("must not run"), { once: true })), logDir, "pr-1");
  assert.equal(again.outcome, "stopped");

  begun("pr-2");
  const huge = await carry(
    make(($) => $.step("publish", () => assert.fail("must not run"), { once: true, probe: () => ({ done: true, value: "x".repeat(2 * 1024 * 1024) }) })),
    logDir,
    "pr-2",
  );
  assert.equal(huge.outcome, "done");
  assert.equal(huge.value.length, 2 * 1024 * 1024);
  assert.equal(readFileSync(new Journal({ dir: logDir, lineage: "pr-2" }).file, "utf8").length < 4_000, true, "the journal does not hold a value that is bigger than a record may be");
});

test("settle refuses a value bigger than a record may be", async () => {
  const logDir = await tempDir("orch-void-");
  const first = await go(make(async ($) => $.stop("nothing")), logDir, { runId: "set-1" });
  assert.equal(first.outcome, "stopped");
  assert.throws(() => settleRun("set-1", ["publish", "--done", JSON.stringify("x".repeat(2 * 1024 * 1024))], { logDir }), UsageError);
});
