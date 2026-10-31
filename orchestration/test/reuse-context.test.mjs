// An answer is taken from the journal only for what it was given for: the prompt, the schema, who was asked (as the roles resolve now),
// and where (the directory and the host). A fake executor answers. Nothing here talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { runFlow } from "../runtime/run.mjs";
import { flow, define, text } from "../runtime/flow.mjs";
import { readEvents } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const carry = (target, logDir, line, extra = {}) =>
  runFlow(target, { roster, caller: null, executor: fakeExecutor(), cwd: "C:/work", logDir, lineage: line, resumeOf: line, agentProbeDelays: [], ...extra });
const make = (body) => flow({ name: "ctx-test", description: "d", phases: [], inputs: {}, grants: [], run: (_, $) => body($) });
const reusedOf = (result) => readEvents(result.events).filter((e) => e.kind === "call.start").map((e) => e.reused !== null);

test("only the directory changes between two runs of a line: the answer given for the other directory is not taken", async () => {
  const logDir = await tempDir("orch-ctx-");
  const step = define({ name: "look", effects: "none", timeout: "5m", returns: { location: text("where") }, prompt: () => "Inspect the files in your current working directory." });
  const ex = fakeExecutor({ answer: (request) => ({ location: request.cwd }) });
  const target = make(($) => $.ask(step, {}, { role: "fast" }));
  const first = await carry(target, logDir, "cwd-1", { executor: ex, runId: "cwd-1", cwd: "C:/tree-a" });
  const same = await carry(target, logDir, "cwd-1", { executor: ex, cwd: "C:/tree-a" });
  assert.deepEqual([same.value.location, ex.requests.length], [first.value.location, 1], "the same directory: taken");
  const other = await carry(target, logDir, "cwd-1", { executor: ex, cwd: "C:/tree-b" });
  assert.equal(other.value.location, "C:/tree-b");
  assert.equal(ex.requests.length, 2);
  assert.deepEqual(reusedOf(other), [false]);
});

test("an agent asked afresh is fingerprinted by what the roles resolve to, not by the names the flow wrote", async () => {
  const logDir = await tempDir("orch-ctx-");
  const step = define({ name: "rewrite", effects: "none", timeout: "5m", returns: { answer: text("an answer") }, prompt: () => "answer" });
  const ex = fakeExecutor({ answer: (request) => ({ answer: request.labels["orch-call"] === "c1" ? "base" : request.provider }) });
  const target = make(async ($) => $.again(await $.ask(step, {}, { provider: "claude/base" }), "rewrite", { fresh: true, role: "worker" }));
  const first = await carry(target, logDir, "fr-1", { executor: ex, runId: "fr-1" });
  assert.equal(ex.requests.length, 2);

  const unchanged = await carry(target, logDir, "fr-1", { executor: ex });
  assert.deepEqual(unchanged.value, first.value);
  assert.equal(ex.requests.length, 2, "the roles are the same: taken");

  const revised = structuredClone(roster);
  revised.roles.worker.provider = "codex/changed-model";
  revised.roles.worker.instructions = "new instructions";
  const second = await carry(target, logDir, "fr-1", { executor: ex, roster: revised });
  assert.equal(second.value.answer, "codex/changed-model", "asked again, as the role is now");
  assert.equal(ex.requests.length, 3);
  assert.deepEqual(reusedOf(second), [true, false], "the first ask is still the one it was; the question after it is new");
});

test("the question put to an agent is not taken for the answer to another one that happened to read the same", async () => {
  const logDir = await tempDir("orch-ctx-");
  const step = define({ name: "write", effects: "none", timeout: "5m", returns: { body: text("the text") }, prompt: ({ topic }) => `write about ${topic}` });
  const ex = fakeExecutor({ answer: () => ({ body: "same words" }) });
  const target = (topic) => make(async ($) => $.again(await $.ask(step, { topic }, { role: "fast" }), "tighten it", { fresh: true }));
  await carry(target("tides"), logDir, "pv-1", { executor: ex, runId: "pv-1" });
  assert.equal(ex.requests.length, 2);
  // The first question changed, and the agent happened to give the same words: what was said to improve them was not said to these.
  const second = await carry(target("winds"), logDir, "pv-1", { executor: ex });
  assert.equal(ex.requests.length, 4, "both asked again");
  assert.deepEqual(reusedOf(second), [false, false]);
});
