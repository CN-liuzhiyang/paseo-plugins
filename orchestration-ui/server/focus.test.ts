import assert from "node:assert/strict";
import { test } from "node:test";
import { createFocusStore, defaultRun } from "../client/focus";

test("focus: an open from outside reselects; the panel remembering does not", () => {
  const focus = createFocusStore();
  let changes = 0;
  const stop = focus.subscribe(() => (changes += 1));
  assert.equal(focus.get("w1"), null);

  focus.open("w1", "run-a", "c3");
  const first = focus.get("w1")!;
  assert.deepEqual({ runId: first.runId, select: first.select }, { runId: "run-a", select: "c3" });

  // The person picks another node: remembered under the same nonce, so the view is not rebuilt.
  focus.remember("w1", "run-a", "c5");
  assert.equal(focus.get("w1")!.select, "c5");
  assert.equal(focus.get("w1")!.nonce, first.nonce);
  // Same place again: nothing to tell anyone.
  const before = changes;
  focus.remember("w1", "run-a", "c5");
  assert.equal(changes, before);

  // Asking for the same run again from a card bumps the nonce: the view reselects.
  focus.open("w1", "run-a", "c3");
  assert.ok(focus.get("w1")!.nonce > first.nonce);
  assert.equal(focus.get("w1")!.select, "c3");

  // Workspaces are kept apart.
  assert.equal(focus.get("w2"), null);
  stop();
});

test("default run: needs you, then running, then newest", () => {
  const run = (runId: string, status: string, needsYou = false) => ({ runId, status, needsYou });
  assert.equal(defaultRun([run("a", "done"), run("b", "running"), run("c", "lost", true)])?.runId, "c");
  assert.equal(defaultRun([run("a", "done"), run("b", "running")])?.runId, "b");
  assert.equal(defaultRun([run("a", "done"), run("b", "failed")])?.runId, "a");
  assert.equal(defaultRun([]), null);
});
