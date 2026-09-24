import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { activity, fenceLabel, formatDuration } from "../shared/format";
import {
  callStatus,
  caveatsOf,
  costSoFar,
  foldEvents,
  gateVerdict,
  parseDuration,
  phaseStatus,
  runStatus,
  staleAfterMs,
  type RunState,
} from "../shared/run";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const BASE = 15 * 60_000;

/** Complete lines only, as the reader would hand them over. */
function fixture(name: string): unknown[] {
  const text = readFileSync(path.join(FIXTURES, name), "utf8");
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  return complete
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function at(iso: string, plusMs = 0): number {
  return Date.parse(iso) + plusMs;
}

function phases(run: RunState, now: number) {
  const status = runStatus(run, now, BASE);
  return Object.fromEntries(run.phaseOrder.map((id) => [id, phaseStatus(run, run.phases.get(id)!, status)]));
}

test("committee: two phases, a loop over debate, concurrent calls", () => {
  const run = foldEvents(fixture("committee-done.jsonl"));
  assert.equal(run.problems.length, 0, run.problems.join("\n"));
  assert.equal(runStatus(run, Date.now(), BASE), "done");
  assert.deepEqual(run.phaseOrder, ["debate", "assess"]);
  const debate = run.phases.get("debate")!;
  assert.equal(debate.starts, 2);
  assert.equal(debate.callIds.length, 4);
  assert.deepEqual(
    debate.callIds.map((id) => run.calls.get(id)!.round),
    [1, 1, 2, 2],
  );
  assert.deepEqual(phases(run, Date.now()), { debate: "done", assess: "done" });
  // Codex reports 0: not counted, and not added as if free.
  const codex = run.calls.get("c2")!;
  assert.equal(codex.end?.cost?.usd, 0);
  assert.deepEqual(costSoFar(run), { usd: 0.41 + 0.29 + 0.12, uncounted: 2 });
  assert.equal(fenceLabel(run.calls.get("c1")!), "请求只读 · 未强制（auto）");
  assert.equal(caveatsOf(run).length, 2);
  assert.equal(run.calls.get("c1")!.caveats.length, 1);
  assert.equal(run.start?.pid, 20412);
  assert.equal(run.start?.hostname, "fixture-host");
});

test("hotfix: unphased do, gate verdict, stopped names its phase", () => {
  const run = foldEvents(fixture("hotfix-stopped.jsonl"));
  assert.equal(run.problems.length, 0, run.problems.join("\n"));
  assert.equal(runStatus(run, Date.now(), BASE), "stopped");
  assert.equal(run.end?.stop?.phase, "approve");
  const d0 = run.calls.get("d0")!;
  assert.equal(d0.phase, null);
  assert.equal(d0.round, 0);
  const gate = gateVerdict(run.calls.get("g1")!);
  assert.equal(gate?.outcome, "denied");
  assert.equal(gate?.by, "unattributed");
  assert.deepEqual(phases(run, Date.now()), {
    fetch: "done",
    snapshot: "done",
    draft: "done",
    verify: "done",
    approve: "stopped",
    write: "skipped",
  });
});

test("advisor: failed call and failed phase", () => {
  const run = foldEvents(fixture("advisor-failed.jsonl"));
  assert.equal(runStatus(run, Date.now(), BASE), "failed");
  const call = run.calls.get("a1")!;
  assert.equal(callStatus(call, "failed"), "error");
  assert.equal(call.end?.error?.name, "TimeoutError");
  assert.deepEqual(phases(run, Date.now()), { consult: "failed" });
  assert.deepEqual(
    run.logs.map((log) => log.level),
    ["warn", "error"],
  );
});

test("unfinished: concurrent phases, unknown kinds and fields are ignored", () => {
  const events = fixture("survey-unfinished.jsonl");
  const run = foldEvents(events);
  assert.equal(run.problems.length, 0, run.problems.join("\n"));
  assert.deepEqual(run.unknownKinds, { heartbeat: 1 });
  assert.equal(run.end, null);
  const last = run.lastEventAt!;
  // Both research phases were entered at once; only one has left.
  const now = at(last, 60_000);
  assert.deepEqual(phases(run, now), { "collect-docs": "done", "collect-code": "running", summarize: "pending" });
  assert.equal(callStatus(run.calls.get("a2")!, runStatus(run, now, BASE)), "running");
  assert.match(activity(run, "running", now) ?? "", /等 reviewer-alt 回答：读 packages\/plugin\/src/);
  // call.agent names the agent while the call is still open.
  assert.equal(run.calls.get("a2")!.agentId, "22222222-3333-4444-8555-666666666677");
  assert.equal(run.calls.get("a2")!.end, null);
});

test("a process the daemon found gone is lost at once; one it found alive is running however quiet", () => {
  const run = foldEvents(fixture("survey-unfinished.jsonl"));
  const last = run.lastEventAt!;
  const soon = at(last, 5_000);
  assert.equal(runStatus(run, soon, BASE), "running");
  assert.equal(runStatus(run, soon, BASE, { pid: 4242, alive: false }), "lost");
  assert.match(
    activity(run, "lost", soon, { proc: { pid: 4242, alive: false }, staleMs: BASE }) ?? "",
    /^运行进程（pid 4242）已退出，没有写出 run\.end。/,
  );
  const late = at(last, 5 * 3_600_000);
  assert.equal(runStatus(run, late, BASE), "lost");
  assert.equal(runStatus(run, late, BASE, { pid: 4242, alive: true }), "running");
  assert.match(
    activity(run, "running", late, { proc: { pid: 4242, alive: true }, staleMs: BASE }) ?? "",
    /没有新事件；进程 pid 4242 还在）$/,
  );
  // A finished run is finished whatever the process does afterwards.
  const done = foldEvents(fixture("committee-done.jsonl"));
  assert.equal(runStatus(done, Date.now(), BASE, { pid: 20412, alive: false }), "done");
});

test("call.agent once per call, before call.end", () => {
  const head = { v: 1, ts: "2026-09-24T00:00:00Z", runId: "r" };
  const run = foldEvents([
    { ...head, seq: 0, kind: "run.start", flow: { name: "x", phases: [] }, pid: 1, hostname: "h" },
    { ...head, seq: 1, kind: "call.start", callId: "a", type: "ask", name: "a", title: "A", phase: null },
    { ...head, seq: 2, kind: "call.agent", callId: "a", agentId: "agent-1" },
    { ...head, seq: 3, kind: "call.agent", callId: "a", agentId: "agent-2" },
    { ...head, seq: 4, kind: "call.end", callId: "a", ok: true, agentId: "agent-2" },
    { ...head, seq: 5, kind: "call.agent", callId: "a", agentId: "agent-3" },
  ]);
  assert.equal(run.problems.length, 3, run.problems.join("\n"));
  assert.equal(run.calls.get("a")!.agentId, "agent-3");
});

test("lost: quiet past the open call's timeout, not merely past the base", () => {
  const run = foldEvents(fixture("survey-unfinished.jsonl"));
  const last = run.lastEventAt!;
  const a2Start = run.calls.get("a2")!.startedAt!;
  // a2 may take 30m from its start; the base alone (15m) would call this lost too early.
  assert.equal(runStatus(run, at(last, 20 * 60_000), BASE), "running");
  assert.equal(staleAfterMs(run, BASE), at(a2Start, 32 * 60_000) - at(last));
  assert.equal(runStatus(run, at(a2Start, 33 * 60_000), BASE), "lost");
  const status = runStatus(run, at(a2Start, 33 * 60_000), BASE);
  assert.deepEqual(phases(run, at(a2Start, 33 * 60_000)), {
    "collect-docs": "done",
    "collect-code": "interrupted",
    summarize: "skipped",
  });
  assert.equal(callStatus(run.calls.get("a2")!, status), "interrupted");
  assert.match(activity(run, status, at(a2Start, 33 * 60_000)) ?? "", /^最后一条事件在 .*没有 run\.end。当时：/);
});

test("lost: no open call means the base applies", () => {
  const run = foldEvents(fixture("survey-unfinished.jsonl").slice(0, 3)); // run.start + two phase.start
  const last = run.lastEventAt!;
  assert.equal(runStatus(run, at(last, BASE - 1), BASE), "running");
  assert.equal(runStatus(run, at(last, BASE + 1), BASE), "lost");
  assert.match(activity(run, "running", at(last, 1000)) ?? "", /在阶段「查文档」、「查代码」里/);
});

test("a run that has not written run.start yet is starting", () => {
  assert.equal(runStatus(foldEvents([]), Date.now(), BASE), "starting");
});

test("contract breaks become problems, not crashes", () => {
  const run = foldEvents([
    "not an object",
    { v: 1, seq: 0, ts: "2026-09-24T00:00:00Z", runId: "r", kind: "run.start", flow: { name: "x", phases: [{ id: "a", title: "A" }] } },
    { v: 1, seq: 2, ts: "2026-09-24T00:00:01Z", runId: "r", kind: "phase.start", phase: "ghost" },
    { v: 1, seq: 3, ts: "2026-09-24T00:00:02Z", runId: "r", kind: "call.end", callId: "nobody", ok: true },
    { v: 2, seq: 4, ts: "2026-09-24T00:00:03Z", runId: "r", kind: "log", level: "info", message: "from the future" },
    { v: 1, seq: 5, ts: "2026-09-24T00:00:04Z", runId: "r", kind: "run.end", outcome: "exploded" },
  ]);
  assert.equal(run.problems.length, 6, run.problems.join("\n"));
  assert.deepEqual(run.phaseOrder, ["a", "ghost"]);
  assert.equal(run.phases.get("ghost")!.declared, false);
  assert.equal(run.end?.outcome, "failed");
});

test("durations", () => {
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("1h30m"), 90 * 60_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("600000"), 600_000);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration("5 minutes"), null);
  assert.equal(formatDuration(3_723_000), "1 小时 2 分");
  assert.equal(formatDuration(65_000), "1 分 05 秒");
});
