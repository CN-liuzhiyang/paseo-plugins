// A journal whose last write was cut off, and one with a line that cannot be read: what a step that cannot be taken back does about them.
// The runs that die are real processes (tail-child.mjs). Nothing here talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFlow } from "../runtime/run.mjs";
import { flow } from "../runtime/flow.mjs";
import { readEvents } from "../runtime/events.mjs";
import { Journal, fingerprint, journalFile } from "../runtime/journal.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { settleRun } from "../runtime/orch.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "tail-child.mjs");

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const carry = (target, logDir, line, extra = {}) =>
  runFlow(target, { roster, caller: null, executor: fakeExecutor(), cwd: "C:/work", logDir, lineage: line, resumeOf: line, ...extra });
const make = (body) => flow({ name: "tail-test", description: "d", phases: [], inputs: {}, grants: [], run: (_, $) => body($) });
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const child = (logDir, line, runId, actions, mode) => spawnSync(process.execPath, [CHILD, logDir, line, runId, actions, mode], { encoding: "utf8" });

test("the first line written after a write that was cut off starts on a line of its own, and is read back", async () => {
  const dir = await tempDir("orch-tail-");
  const file = journalFile(dir, "L");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ v: 1, id: "step:a", kind: "step", state: "done", keyPrint: null, value: 1 })}\n{"v":1,"id":"ask:draft#1"`);
  const journal = new Journal({ dir, lineage: "L" });
  assert.deepEqual(journal.steps().map((e) => e.id), ["step:a"], "the cut-off line says nothing");
  assert.deepEqual(journal.damaged, [], "and is not damage either");

  journal.append({ id: "step:b", kind: "step", state: "begun", once: true, keyPrint: null }, { sync: true });
  const text = readFileSync(file, "utf8");
  assert.equal(text.includes('"ask:draft#1"'), false, "the fragment is gone, not joined to the next line");
  assert.equal(text.endsWith("\n"), true);
  const again = new Journal({ dir, lineage: "L" });
  assert.equal(again.get("step:b")?.state, "begun");
  assert.deepEqual(again.damaged, []);
});

test("a step that cannot be taken back, begun after a cut-off write and cut off itself, is not done again by the next run", async () => {
  const logDir = await tempDir("orch-tail-");
  const actions = path.join(logDir, "actions.txt");
  const file = journalFile(logDir, "T1");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"v":1,"id":"ask:draft#1"');

  const first = child(logDir, "T1", "T1-a", actions, "die");
  assert.equal(first.status, 17, first.stderr);
  assert.deepEqual(lines(actions), ["T1-a"]);
  assert.equal(new Journal({ dir: logDir, lineage: "T1" }).get("step:publish")?.state, "begun", "the begun line was not lost to the fragment before it");

  const second = child(logDir, "T1", "T1-b", actions, "live");
  assert.equal(second.status, 0, second.stderr);
  const said = JSON.parse(second.stdout);
  assert.equal(said.outcome, "stopped");
  assert.match(said.stop.reason, /可能已经做了/);
  assert.deepEqual(lines(actions), ["T1-a"], "the act was not done a second time");
});

test("a complete line that cannot be read is damage: said, counted, and a step that cannot be taken back with no line is not done on that account", async () => {
  const logDir = await tempDir("orch-tail-");
  const file = journalFile(logDir, "D1");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ v: 1, id: "step:ordinary", kind: "step", state: "done", keyPrint: fingerprint(null), value: 7 })}\n{"v":1,"id":"step:publish","kind"\n`);
  assert.equal(new Journal({ dir: logDir, lineage: "D1" }).damaged.length, 1);

  const acted = [];
  const result = await carry(
    make(async ($) => {
      const ordinary = await $.step("ordinary", () => 99);
      const published = await $.step("publish", () => (acted.push("publish"), true), { once: true });
      return { ordinary, published };
    }),
    logDir,
    "D1",
  );
  assert.equal(result.outcome, "stopped");
  assert.deepEqual(acted, [], "the act was not done");
  assert.match(result.stop.reason, /读不懂的行/);
  const events = readEvents(result.events);
  assert.equal(events.some((e) => e.kind === "caveat" && /cannot be read/.test(e.text)), true);
  // The ordinary step took its value from the lines that could be read.
  assert.equal(events.find((e) => e.kind === "call.start" && e.name === "ordinary").reused !== null, true);

  // A person says how it ended; the next run goes by that.
  const settled = settleRun(result.runId, ["publish", "--not-done"], { logDir }).ok;
  assert.equal(settled, true);
});

test("a step that cannot be taken back and has no line is done as usual when the journal has nothing damaged", async () => {
  const logDir = await tempDir("orch-tail-");
  const acted = [];
  const result = await carry(make(async ($) => $.step("publish", () => (acted.push("publish"), true), { once: true })), logDir, "N1");
  assert.equal(result.outcome, "done");
  assert.deepEqual(acted, ["publish"]);
});
