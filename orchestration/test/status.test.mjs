// `orch.mjs status` (runtime/status.mjs): what a run is doing now, read from its two files. Nothing talks to Paseo.

import "./hermetic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { claimFile, LIVE_WITHIN_MS } from "../runtime/claim.mjs";
import { eventsFile } from "../runtime/events.mjs";
import { runStatus } from "../runtime/status.mjs";
import { pointPrint } from "../runtime/resume-point.mjs";
import { tempDir } from "./temp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-05T10:00:00.000Z");
const at = (s) => new Date(NOW - 600_000 + s * 1000).toISOString();
let n = 0;
const ev = (kind, rest = {}, s = n) => ({ v: 1, seq: n++, ts: at(s), runId: "r", kind, ...rest });
const start = () =>
  ev("run.start", {
    flow: { name: "plan-and-patch", phases: [{ id: "plan", title: "方案" }, { id: "patch", title: "补丁" }] },
    resumeOf: null,
  }, 0);

/** A log directory with the run's events and a claim touched `ageMs` before NOW. */
async function setup(events, { ageMs = 5_000 } = {}) {
  n = 0;
  const dir = await tempDir("orch-status-");
  mkdirSync(path.join(dir, "runs"));
  if (ageMs !== null) {
    const file = claimFile(dir, "r");
    writeFileSync(file, JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: at(0) }));
    utimesSync(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
  }
  if (events) writeFileSync(eventsFile(dir, "r"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}
const status = (dir) => runStatus({ dir, runId: "r", now: () => NOW });
const cost = (usd) => ({ usd, inputTokens: 1, outputTokens: 1 });

test("status: nothing at all is absent, with the empty shape", async () => {
  const dir = await setup(null, { ageMs: null });
  const s = status(dir);
  assert.equal(s.state, "absent");
  assert.deepEqual([s.flow, s.phase, s.asking, s.gates, s.costUsd], [null, null, [], [], null]);
});

test("status: running, asking an agent in a phase", async () => {
  const dir = await setup([
    start(),
    ev("phase.start", { phase: "plan" }),
    ev("call.start", { callId: "c1", type: "ask", name: "plan", title: "写方案", phase: "plan" }),
    ev("call.agent", { callId: "c1", agentId: "agent-1" }),
  ]);
  const s = status(dir);
  assert.equal(s.state, "running");
  assert.equal(s.flow, "plan-and-patch");
  assert.deepEqual(s.phase, { id: "plan", title: "方案" });
  assert.deepEqual(s.asking, [{ callId: "c1", name: "plan", title: "写方案", agentId: "agent-1" }]);
  assert.deepEqual(s.gates, []);
  assert.equal(s.endedAt, null);
  assert.equal(s.durationMs, 600_000);
});

test("status: waiting at a gate, then the answer", async () => {
  const gateStart = ev("call.start", { callId: "c2", type: "gate", name: "gate", title: "批方案", phase: "plan" }, 30);
  const base = [start(), ev("phase.start", { phase: "plan" }), ev("call.start", { callId: "c1", type: "ask", name: "plan", title: "写方案" }),
    ev("call.end", { callId: "c1", ok: true, cost: cost(0.25) }), gateStart, ev("call.agent", { callId: "c2", agentId: "carrier-1" })];
  const waiting = status(await setup(base));
  assert.deepEqual(waiting.asking, []);
  assert.equal(waiting.gates.length, 1);
  assert.deepEqual([waiting.gates[0].state, waiting.gates[0].agentId, waiting.gates[0].title], ["waiting", "carrier-1", "批方案"]);
  assert.equal(waiting.costUsd, 0.25);

  const decided = { outcome: "allowed", approved: true, agentId: "carrier-1", askedAt: at(30), decidedAt: at(90), reason: null };
  const answered = status(await setup([...base, ev("call.end", { callId: "c2", ok: true, output: decided, agentId: "carrier-1" })]));
  assert.deepEqual([answered.gates[0].state, answered.gates[0].decidedAt], ["allowed", at(90)]);

  const denied = status(await setup([...base, ev("call.end", { callId: "c2", ok: true, output: { ...decided, outcome: "denied", approved: false, reason: "不要这样" } })]));
  assert.deepEqual([denied.gates[0].state, denied.gates[0].reason], ["denied", "不要这样"]);
  const expired = status(await setup([...base, ev("call.end", { callId: "c2", ok: true, output: { ...decided, outcome: "expired", approved: false } })]));
  assert.equal(expired.gates[0].state, "expired");
  const broke = status(await setup([...base, ev("call.end", { callId: "c2", ok: false, output: null, error: { name: "X", message: "m" } })]));
  assert.equal(broke.gates[0].state, "error");
});

test("status: the phase is the last one still open, else the last one opened", async () => {
  const s1 = status(await setup([start(), ev("phase.start", { phase: "plan" }), ev("phase.end", { phase: "plan", ok: true }), ev("phase.start", { phase: "patch" })]));
  assert.equal(s1.phase.id, "patch");
  const s2 = status(await setup([start(), ev("phase.start", { phase: "plan" }), ev("phase.end", { phase: "plan", ok: true })]));
  assert.equal(s2.phase.id, "plan");
});

test("status: how a run ended -- done, stopped, failed, timeout -- with cost, summary and where it can be carried on", async () => {
  const resume = { flow: "plan-and-patch", input: {}, from: "从补丁接着做", spends: "maybe" };
  const done = status(await setup([start(), ev("run.end", { outcome: "done", summary: "提交了 r123", durationMs: 120000, cost: { totalUsd: 2.4, agentCount: 3, partial: "" }, resume: null })], { ageMs: 9_000_000 }));
  assert.deepEqual([done.state, done.outcome, done.summary, done.costUsd, done.durationMs], ["ended", "done", "提交了 r123", 2.4, 120000]);
  const stopped = status(await setup([start(), ev("run.end", { outcome: "stopped", stop: { reason: "补丁没批", kind: "flow", step: null }, resume })], { ageMs: 9_000_000 }));
  assert.deepEqual([stopped.outcome, stopped.stop.reason, stopped.resume.from], ["stopped", "补丁没批", "从补丁接着做"]);
  const failed = status(await setup([start(), ev("run.end", { outcome: "failed", error: { name: "Boom", message: "炸了" } })], { ageMs: 9_000_000 }));
  assert.deepEqual([failed.outcome, failed.error.message], ["failed", "炸了"]);
  const timeout = status(await setup([start(), ev("run.end", { outcome: "timeout", error: { name: "Timeout", message: "超时" } })], { ageMs: 9_000_000 }));
  assert.equal(timeout.outcome, "timeout");
});

test("status: lost keeps the money that was spent and the last resume point the flow declared", async () => {
  const dir = await setup([
    start(),
    ev("call.start", { callId: "c1", type: "ask", name: "plan", title: "写方案" }),
    ev("call.end", { callId: "c1", ok: true, cost: cost(0.5) }),
    ev("resume", { flow: "plan-and-patch", input: {}, from: "从方案接着做", spends: "nothing" }),
    ev("call.start", { callId: "c2", type: "ask", name: "patch", title: "写补丁" }),
  ], { ageMs: LIVE_WITHIN_MS + 5_000 });
  const s = status(dir);
  assert.equal(s.state, "lost");
  assert.equal(s.costUsd, 0.5);
  const point = { flow: "plan-and-patch", input: {}, from: "从方案接着做", spends: "nothing" };
  assert.deepEqual(s.resume, { ...point, print: pointPrint(point) });
  assert.equal(s.asking.length, 1);
});

test("status: a refused run says why", async () => {
  const dir = await setup(null);
  writeFileSync(claimFile(dir, "r"), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: at(0), refused: "no available provider" }));
  const s = status(dir);
  assert.deepEqual([s.state, s.refused], ["refused", "no available provider"]);
});

test("status: the fingerprint covers the declared flow and input, and clearing a point removes it", async () => {
  const point = { flow: "plan-and-patch", input: { version: 2 }, from: "接着做", spends: "maybe" };
  const s = status(await setup([start(), ev("run.end", { outcome: "stopped", resume: point })]));
  assert.deepEqual(s.resume, { ...point, print: pointPrint(point) });
  assert.notEqual(s.resume.print, pointPrint({ ...point, input: { version: 3 } }));
  const cleared = status(await setup([start(), ev("resume", point), ev("resume", { cleared: true })]));
  assert.equal(cleared.resume, null);
});

test("status: the command prints the same object, and refuses a bad --spawned-at", async () => {
  const dir = await setup([start(), ev("phase.start", { phase: "plan" })]);
  const run = (...args) => execFileSync(process.execPath, [path.join(HERE, "..", "runtime", "orch.mjs"), "status", ...args], { env: { ...process.env, ORCH_LOG_DIR: dir }, encoding: "utf8", cwd: os.tmpdir() });
  const printed = JSON.parse(run("r"));
  assert.equal(printed.runId, "r");
  assert.equal(printed.flow, "plan-and-patch");
  assert.throws(() => execFileSync(process.execPath, [path.join(HERE, "..", "runtime", "orch.mjs"), "status", "r", "--spawned-at", "soon"], { env: { ...process.env, ORCH_LOG_DIR: dir }, stdio: "pipe", cwd: os.tmpdir() }), /status: 2|Command failed/);
});
