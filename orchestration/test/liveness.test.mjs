// runtime/liveness.mjs: the one file that says whether a run is alive, and the copies of it that plugins carry.
// The table's rows are run through `classify` in state.test.mjs (state.mjs re-exports it) and again, row by row,
// in each plugin that carries a copy.

import "./hermetic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, LIVE_WITHIN_MS, parseDuration, pidFact, STALE_BASE_MS, STALE_GRACE_MS, staleAfterMs } from "../runtime/liveness.mjs";
import * as claim from "../runtime/claim.mjs";
import * as state from "../runtime/state.mjs";
import { sync } from "../scripts/sync-liveness.mjs";

test("the runtime's other modules use this one: nothing is written twice", () => {
  assert.equal(claim.LIVE_WITHIN_MS, LIVE_WITHIN_MS);
  assert.equal(state.classify, classify);
});

test("pidFact: gone only when the holder's machine says so; anywhere else, or when it cannot ask, unknown", () => {
  const probe = (code) => ({
    hostname: "Here",
    kill: () => {
      if (code) throw Object.assign(new Error(code), { code });
      return true;
    },
  });
  const body = { pid: 4242, hostname: "here" };
  assert.equal(pidFact(body, probe(null)), "alive");
  assert.equal(pidFact(body, probe("EPERM")), "alive", "it exists, we may only not signal it");
  assert.equal(pidFact(body, probe("ESRCH")), "gone");
  assert.equal(pidFact(body, probe("EINVAL")), "unknown");
  assert.equal(pidFact({ pid: 4242, hostname: "elsewhere" }, probe("ESRCH")), "unknown", "a pid means nothing on another machine");
  assert.equal(pidFact({ pid: "4242", hostname: "here" }, probe(null)), "unknown");
  assert.equal(pidFact({ pid: 4242 }, probe(null)), "unknown");
  assert.equal(pidFact(null, probe(null)), "unknown");
});

test("parseDuration: what people write for a timeout, and null for the rest", () => {
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("1h30m"), 90 * 60_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("2d"), 2 * 86_400_000);
  assert.equal(parseDuration("600000"), 600_000);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration("5 minutes"), null);
  assert.equal(parseDuration(null), null);
});

test("staleAfterMs: the base, raised by what an open call may legitimately take, measured from the last event", () => {
  const last = Date.parse("2026-10-24T09:00:00Z");
  assert.equal(staleAfterMs({ lastEventAtMs: last, openCalls: [] }), STALE_BASE_MS);
  // started 1 minute before the last event, may take 60 minutes: quiet is fine until 61 minutes + grace after the start
  const call = { startedAtMs: last - 60_000, timeoutMs: 60 * 60_000 };
  assert.equal(staleAfterMs({ lastEventAtMs: last, openCalls: [call] }), 60 * 60_000 + STALE_GRACE_MS - 60_000);
  assert.equal(staleAfterMs({ baseMs: 90 * 60_000, lastEventAtMs: last, openCalls: [call] }), 90 * 60_000, "a higher base wins");
  assert.equal(staleAfterMs({ lastEventAtMs: last, openCalls: [{ startedAtMs: last, timeoutMs: null }] }), STALE_BASE_MS, "no readable timeout: the base");
  assert.equal(staleAfterMs({ lastEventAtMs: null, openCalls: [call] }), STALE_BASE_MS, "no last event to measure from: the base");
});

test("every plugin that carries a copy of liveness.mjs carries the current one (npm run sync:liveness)", () => {
  assert.deepEqual(sync({ check: true }), []);
});
