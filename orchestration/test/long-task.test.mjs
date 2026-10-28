// A run that takes hours: a `$.do` that waits on a build, then a gate that waits on a person for up to eight hours.
// The clock is mocked (node:test mock timers: Date, setTimeout, setInterval), so four hours pass in a moment while
// everything that depends on time -- the claim's heartbeat, the events' timestamps, the gate's deadline and its
// polling -- sees them pass. The executor is the fake one. What this pins:
//
//   - nothing in the runtime puts a time limit on a `$.do`, or on a gate beyond its own `timeout`;
//   - the claim stays fresh through hours with no events (the heartbeat is a timer, not an event), so
//     `readRunState` says "running" all the way;
//   - the quiet-time bar for "maybe stuck" (liveness.staleAfterMs) is 15 minutes for an open `$.do`, which declares
//     no timeout -- so a long `$.do` has to say something at least that often, and `$.log` is what it says it with;
//   - a gate of eight hours expires as `expired`, with the card closed by the runtime's deny, and one answered at
//     seven hours is allowed, value and all.
//
//   node --test        (from orchestration/)

import { test, mock, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFlow } from "../runtime/run.mjs";
import { flow } from "../runtime/flow.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { readRunState } from "../runtime/state.mjs";
import { staleAfterMs, STALE_BASE_MS, LIVE_WITHIN_MS } from "../runtime/liveness.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { fakeExecutor } from "./fake-executor.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
let roster;

before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

/** Let pending promises and real I/O callbacks run; mocked timers do not advance on their own. */
const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Run `target` under a mocked clock, advancing it `stepMs` at a time until the run ends, and call `sample(elapsedMs)`
 * once per simulated `sampleEveryMs`. The real clock is not waited on.
 */
async function runLong(target, options, { stepMs = 10_000, limitMs = 12 * HOUR, sampleEveryMs = HOUR, sample = () => {} } = {}) {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "orch-long-"));
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  try {
    let result = null;
    let failure = null;
    const running = runFlow(target, { roster, logDir, cwd: "C:/work", caller: null, gatePollMs: 10_000, agentProbeDelays: [5, 10, 20], ...options }).then(
      (value) => (result = value),
      (error) => (failure = error),
    );
    await flush(8);
    let elapsed = 0;
    let nextSample = sampleEveryMs;
    while (result === null && failure === null && elapsed < limitMs) {
      mock.timers.tick(stepMs);
      elapsed += stepMs;
      await flush();
      if (elapsed >= nextSample) {
        await sample(elapsed, logDir);
        nextSample += sampleEveryMs;
      }
    }
    await running;
    if (failure) throw failure;
    return { result, logDir, elapsed };
  } finally {
    mock.timers.reset();
  }
}

/** A build that takes `buildMs`, saying so every `logEveryMs` (or never), then a gate asking for a value. */
const longFlow = ({ buildMs, logEveryMs, gateTimeout, gate = true }) =>
  flow({
    name: "long-task",
    description: "d",
    phases: [{ id: "build", title: "编译" }, { id: "commit", title: "提交" }],
    inputs: {},
    grants: ["gate:deny"],
    run: async (_, $) => {
      await $.phase("build", () =>
        $.do("compile", async () => {
          const startedAt = Date.now();
          let lastSaid = startedAt;
          while (Date.now() - startedAt < buildMs) {
            await new Promise((resolve) => setTimeout(resolve, MIN));
            if (logEveryMs && Date.now() - lastSaid >= logEveryMs) {
              $.log.info(`还在编译，已 ${Math.round((Date.now() - startedAt) / MIN)} 分钟`);
              lastSaid = Date.now();
            }
          }
          return { builtInMs: Date.now() - startedAt };
        }),
      );
      if (!gate) return { gated: false };
      return $.phase("commit", () =>
        $.gate({ title: "批准提交并输入验证码", content: "svn commit -m fix\n", timeout: gateTimeout, input: { label: "验证码", pattern: "\\d{6}", hint: "6 位数字" } }),
      );
    },
  });

test("a 4-hour $.do is not cut off, the claim stays fresh the whole time, and a log line every 10 minutes keeps the run from reading as stuck", async () => {
  const states = [];
  const { result, elapsed } = await runLong(
    longFlow({ buildMs: 4 * HOUR, logEveryMs: 10 * MIN, gate: false }),
    { executor: fakeExecutor(), runId: "long-4h-run" },
    {
      sample: (at, dir) => {
        const state = readRunState({ dir, runId: "long-4h-run", now: Date.now });
        states.push([at / HOUR, state.state]);
      },
    },
  );
  // The 4h sample lands as the run finishes, so it may already read "ended".
  assert.deepEqual(states.slice(0, 3).map(([, state]) => state), ["running", "running", "running"], "alive at 1h, 2h, 3h");
  assert.ok(["running", "ended"].includes(states[3][1]));
  assert.equal(result.outcome, "done");
  assert.ok(elapsed >= 4 * HOUR && elapsed < 4 * HOUR + 5 * MIN, `ran for ${elapsed / MIN} simulated minutes`);
  assert.deepEqual(result.value, { gated: false });
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  const doCall = events.find((e) => e.kind === "call.end");
  assert.ok(doCall.durationMs >= 4 * HOUR, "the call's duration is the whole build");
  assert.equal(doCall.ok, true);

  // Quiet time: the longest stretch between two events, while the build ran.
  const stamps = events.map((e) => Date.parse(e.ts));
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  assert.ok(Math.max(...gaps) <= 10 * MIN + 2 * MIN, `longest quiet stretch ${Math.max(...gaps) / MIN} minutes`);
  assert.ok(Math.max(...gaps) < STALE_BASE_MS, "under the 15-minute bar for an open call with no timeout");
  assert.equal(events.filter((e) => e.kind === "log").length >= 20, true, "about one line per ten minutes of the four hours");
  assert.match(events.find((e) => e.kind === "log").message, /^还在编译，已 \d+ 分钟$/);
});

test("the claim stays fresh through hours with no events at all; only the quiet-time bar speaks, and a $.do carries no timeout to raise it", async () => {
  const sampled = [];
  let runId = null;
  const { result } = await runLong(
    longFlow({ buildMs: 3 * HOUR, logEveryMs: 0, gate: false }),
    { executor: fakeExecutor(), runId: "long-quiet-run" },
    {
      sample: (at, dir) => {
        runId = "long-quiet-run";
        const s = readRunState({ dir, runId, now: Date.now });
        sampled.push({ hours: at / HOUR, state: s.state, touchedAgoMs: s.claim.touchedAgoMs, lastEventAt: s.lastEventAt, now: Date.now() });
      },
    },
  );
  assert.equal(result.outcome, "done");
  assert.ok(sampled.filter((x) => x.state !== "ended").length >= 2);
  for (const s of sampled.filter((x) => x.state !== "ended")) {
    assert.equal(s.state, "running", `at ${s.hours}h the run reads as alive: the heartbeat is a timer, it does not need events`);
    assert.ok(s.touchedAgoMs <= 30_000 + 10_000, `claim touched ${s.touchedAgoMs}ms ago`);
    assert.ok(s.touchedAgoMs < LIVE_WITHIN_MS);
    const quiet = s.now - Date.parse(s.lastEventAt);
    assert.ok(quiet > STALE_BASE_MS, `${quiet / MIN} quiet minutes with nothing logged`);
    // The bar a reader applies: an open `$.do` has no timeout to raise it, so it is the 15-minute base.
    assert.equal(staleAfterMs({ lastEventAtMs: Date.parse(s.lastEventAt), openCalls: [{ startedAtMs: Date.parse(s.lastEventAt), timeoutMs: null }] }), STALE_BASE_MS);
  }
});

test("a gate of 8 hours nobody answers expires as expired, by the runtime's deny, at 8 hours", async () => {
  const executor = fakeExecutor({ carrier: "hang" });
  const { result, elapsed } = await runLong(longFlow({ buildMs: 0, logEveryMs: 0, gateTimeout: "8h" }), { executor }, { stepMs: 10_000 });
  assert.equal(result.outcome, "done");
  assert.equal(result.value.outcome, "expired");
  assert.equal(result.value.approved, false);
  assert.equal(result.value.input, null);
  assert.equal(result.value.by, "gate timeout");
  assert.equal(result.value.reason, "no answer within 8h");
  // The driver advances the mocked clock while the gate's real file I/O is still in flight, so askedAt is a few
  // ticks (10 s each) after the deadline was computed: the wait reads a little under 8h, never over.
  assert.ok(result.value.waitedMs >= 8 * HOUR - 5 * MIN && result.value.waitedMs < 8 * HOUR + MIN, `waited ${result.value.waitedMs / MIN} minutes`);
  assert.ok(elapsed >= 8 * HOUR);
  assert.equal(executor.denied.length, 1, "the card was closed with a deny, once");
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  const start = events.find((e) => e.kind === "call.start" && e.type === "gate");
  assert.equal(start.timeout, "8h");
  // While it waits, a reader's bar is the gate's own timeout plus a grace: it is not "stuck" at 8 hours quiet.
  assert.equal(staleAfterMs({ lastEventAtMs: Date.parse(start.ts), openCalls: [{ startedAtMs: Date.parse(start.ts), timeoutMs: 8 * HOUR }] }), 8 * HOUR + 2 * MIN);
});

test("a gate answered after 7 of its 8 hours is allowed, with the value, after a build that took 2 hours", async () => {
  const executor = fakeExecutor({ carrier: "input", inputValue: "483921", answerAfterMs: 7 * HOUR });
  const { result, elapsed } = await runLong(longFlow({ buildMs: 2 * HOUR, logEveryMs: 10 * MIN, gateTimeout: "8h" }), { executor });
  assert.equal(result.value.outcome, "allowed");
  assert.equal(result.value.input, "483921");
  // Same artifact as above, on both ends: the carrier's files are written in real time while the mocked clock runs.
  assert.ok(result.value.waitedMs >= 7 * HOUR - 5 * MIN && result.value.waitedMs < 7 * HOUR + 30 * MIN, `waited ${result.value.waitedMs / MIN} minutes`);
  assert.ok(elapsed >= 9 * HOUR);
  assert.equal(executor.denied.length, 0);
  const text = await readFile(result.events, "utf8");
  assert.ok(!text.includes("483921"));
  assert.deepEqual(checkEvents(readEvents(result.events), { strict: true, complete: true }), []);
});

test("--timeout is the only limit on a whole run: none by default, and a run past it ends as timeout (the flow itself cannot set one)", async () => {
  const { result } = await runLong(longFlow({ buildMs: 6 * HOUR, logEveryMs: 10 * MIN, gate: false }), { executor: fakeExecutor(), timeout: "2h" }, { limitMs: 3 * HOUR });
  assert.equal(result.outcome, "timeout");
  assert.match(result.error.message, /2h/);
  const events = readEvents(result.events);
  assert.equal(events.find((e) => e.kind === "run.end").outcome, "timeout");
  // The call still running when the run ended is closed by the runner, as EVENTS.md says.
  assert.equal(events.find((e) => e.kind === "call.end").error.name, "RunEnded");
});
