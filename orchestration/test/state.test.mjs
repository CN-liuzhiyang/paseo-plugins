// What state a run is in (runtime/state.mjs): the table as data, then the same table read from real
// files. Nothing here talks to Paseo and nothing is spent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import advisor from "../flows/advisor.mjs";
import { runFlow } from "../runtime/run.mjs";
import { claimFile, claimRun, LIVE_WITHIN_MS } from "../runtime/claim.mjs";
import { eventsFile } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { classify, readRunState, RUN_STATES, START_GRACE_MS } from "../runtime/state.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(readFileSync(path.join(HERE, "..", "fixtures", "run-state-cases.json"), "utf8"));
const tmp = () => tempDir("orch-state-");

test("the table: every row of fixtures/run-state-cases.json", () => {
  assert.ok(TABLE.cases.length >= 30);
  for (const { name, expect, ...facts } of TABLE.cases) {
    assert.deepEqual(classify(facts), expect, name);
  }
  const seen = new Set(TABLE.cases.map((c) => c.expect.state));
  for (const state of RUN_STATES) assert.ok(seen.has(state), `no row for state ${state}`);
});

test("the table: only one thing is ever safe to start again", () => {
  const safe = TABLE.cases.filter((c) => c.expect.safeToRestart);
  assert.ok(safe.length > 0);
  for (const row of safe) {
    assert.equal(row.expect.state, "absent");
    assert.equal(row.claim, null);
    assert.equal(row.events, "none");
    assert.ok(row.spawnedAgoMs >= START_GRACE_MS);
  }
  // Whatever the facts, a state that cost or may have cost money is never offered again.
  for (const claimAge of [0, 1000, LIVE_WITHIN_MS, LIVE_WITHIN_MS + 1, 1e9]) {
    for (const events of ["none", "open", "ended"]) {
      for (const pid of ["alive", "gone", "unknown"]) {
        for (const refused of [false, true]) {
          const verdict = classify({ claim: { ageMs: claimAge, refused }, events, pid, spawnedAgoMs: 1e9 });
          assert.equal(verdict.safeToRestart, false, JSON.stringify({ claimAge, events, pid, refused, verdict }));
        }
      }
    }
  }
});

// --- The same table, from files ---------------------------------------------

const NOW = Date.parse("2026-10-24T08:00:00.000Z");
const start = { v: 1, seq: 0, ts: "2026-10-24T07:59:00.000Z", runId: "r", kind: "run.start" };
const end = { v: 1, seq: 1, ts: "2026-10-24T07:59:30.000Z", runId: "r", kind: "run.end", outcome: "done" };
const gone = { hostname: os.hostname(), kill: () => { throw Object.assign(new Error("no"), { code: "ESRCH" }); } };
const there = { hostname: os.hostname(), kill: () => true };
const elsewhere = { hostname: "some-other-box", kill: () => { throw new Error("must not be asked"); } };

/** A log directory with a claim touched `ageMs` before NOW and the given event lines. */
async function setup({ ageMs = null, body = { pid: 4242, hostname: os.hostname(), startedAt: "2026-10-24T07:58:00.000Z" }, raw = null, events = null } = {}) {
  const dir = await tmp();
  mkdirSync(path.join(dir, "runs"));
  if (ageMs !== null) {
    const file = claimFile(dir, "r");
    writeFileSync(file, raw ?? JSON.stringify(body));
    utimesSync(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
  }
  if (events) writeFileSync(eventsFile(dir, "r"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}
const stateOf = (dir, options = {}) => readRunState({ dir, runId: "r", now: () => NOW, probe: elsewhere, ...options });

test("files: nothing at all, and how long ago the process was started", async () => {
  const dir = await setup();
  assert.equal(stateOf(dir).state, "absent");
  assert.equal(stateOf(dir).safeToRestart, false, "the caller did not say when it started the process");
  assert.equal(stateOf(dir, { spawnedAt: NOW - 5_000 }).state, "pending");
  const later = stateOf(dir, { spawnedAt: new Date(NOW - START_GRACE_MS) });
  assert.deepEqual([later.state, later.safeToRestart], ["absent", true]);
  assert.equal(stateOf(dir, { spawnedAt: NOW - 5_000, graceMs: 1_000 }).safeToRestart, true);
});

test("files: a claim, with and without events, fresh and stale", async () => {
  const fresh = await setup({ ageMs: 5_000 });
  assert.equal(stateOf(fresh).state, "starting");
  const running = await setup({ ageMs: 5_000, events: [start] });
  assert.equal(stateOf(running).state, "running");
  assert.equal(stateOf(running).lastEventAt, start.ts);

  const stale = await setup({ ageMs: LIVE_WITHIN_MS + 1_000 });
  const dead = stateOf(stale);
  assert.deepEqual([dead.state, dead.safeToRestart], ["dead-before-start", false]);
  assert.match(dead.reason, /A person decides/);
  assert.equal(dead.claim.pid, 4242);
  assert.equal(dead.claim.touchedAgoMs, LIVE_WITHIN_MS + 1_000);
  const lost = stateOf(await setup({ ageMs: LIVE_WITHIN_MS + 1_000, events: [start] }));
  assert.deepEqual([lost.state, lost.safeToRestart], ["lost", false]);
});

test("files: a finished run is ended whatever its claim says, with its outcome", async () => {
  const dir = await setup({ ageMs: 9_000_000, events: [start, end] });
  const done = stateOf(dir);
  assert.deepEqual([done.state, done.outcome], ["ended", "done"]);
  const noClaim = await setup({ events: [start, { ...end, outcome: "stopped" }] });
  assert.deepEqual([stateOf(noClaim).state, stateOf(noClaim).outcome], ["ended", "stopped"]);
});

test("files: a half-written last line is not an event", async () => {
  const dir = await setup({ ageMs: 5_000, events: [start] });
  writeFileSync(eventsFile(dir, "r"), `${JSON.stringify(start)}\n${JSON.stringify(end).slice(0, 20)}`);
  assert.equal(stateOf(dir).state, "running");
});

test("files: a refusal, however fresh the claim looks", async () => {
  const dir = await tmp();
  const claim = claimRun({ dir, runId: "r" });
  claim.refuse("FlowLookupError: no flow");
  const refused = readRunState({ dir, runId: "r", probe: elsewhere });
  assert.deepEqual([refused.state, refused.refused, refused.safeToRestart], ["refused", "FlowLookupError: no flow", false]);
  assert.ok(refused.claim.touchedAgoMs < 5_000, "writing the reason touched it");
});

test("files: a claim that cannot be read yet is to be looked at again, until it has gone stale", async () => {
  assert.equal(stateOf(await setup({ ageMs: 50, raw: "" })).state, "unreadable");
  assert.equal(stateOf(await setup({ ageMs: 50, raw: '{"pid":42,"host' })).state, "unreadable");
  assert.equal(stateOf(await setup({ ageMs: LIVE_WITHIN_MS + 1_000, raw: "" })).state, "dead-before-start");
});

test("files: the pid is evidence of death only, and only on the holder's machine", async () => {
  const fresh = await setup({ ageMs: 5_000, events: [start] });
  assert.equal(stateOf(fresh, { probe: there }).state, "running", "alive pid: no more than the claim says");
  const goneNow = stateOf(fresh, { probe: gone });
  assert.deepEqual([goneNow.state, goneNow.processAlive], ["lost", false], "gone pid: dead, however fresh the claim");
  assert.equal(stateOf(fresh, { probe: elsewhere }).processAlive, null, "another machine: not asked");

  const stale = await setup({ ageMs: LIVE_WITHIN_MS + 1_000, events: [start] });
  const staleButThere = stateOf(stale, { probe: there });
  assert.deepEqual([staleButThere.state, staleButThere.processAlive], ["lost", true], "a pid that exists does not make it alive");
  const early = await setup({ ageMs: LIVE_WITHIN_MS + 1_000 });
  assert.equal(stateOf(early, { probe: there }).state, "stalled-before-start");
  assert.equal(stateOf(early, { probe: gone }).state, "dead-before-start");
  assert.equal(stateOf(await setup({ ageMs: 5_000, body: { pid: "x", hostname: 5 } }), { probe: gone }).processAlive, null);
});

test("files: a run that really ran, read afterwards and while its claim is held", async () => {
  const dir = await tmp();
  const executor = fakeExecutor({ answer: () => ({ verdict: "v", reasoning: "r", recommendation: "do", whatWouldChangeMyMind: "w", confidence: "high" }), delayMs: 150 });
  const running = runFlow(advisor, {
    roster: await loadRoster([ROLES_DIR]),
    executor,
    logDir: dir,
    runId: "real",
    cwd: "C:/work",
    caller: null,
    input: { question: "q", role: "fast" },
  });
  await new Promise((r) => setTimeout(r, 60));
  const during = readRunState({ dir, runId: "real", probe: { hostname: os.hostname(), kill: (pid) => (pid === process.pid ? true : (() => { throw Object.assign(new Error(), { code: "ESRCH" }); })()) } });
  assert.equal(during.state, "running");
  assert.equal(during.processAlive, true);
  await running;
  const after = readRunState({ dir, runId: "real" });
  assert.deepEqual([after.state, after.outcome], ["ended", "done"]);
});
