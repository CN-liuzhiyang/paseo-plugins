import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RunView } from "../shared/graph";
import { caseOfStart, createRunReader, resolveRunsDir } from "../server/runs";
import { issue, makeWorld } from "./helpers";
import { AFFAIR, ago, callEnd, callStart, fixture, MIN, NOW, only, phaseEnd, phaseStart, runView, start } from "./run-files";

// The runs of flows started for an item, read from fixture event files (run-files.ts).

test("a run belongs to an item only by the affair link it was started with; every other run is passed over", () => {
  const f = fixture();
  try {
    f.run("mine", [start(ago(5 * MIN), AFFAIR("tracker:1"))]);
    f.run("other-plugin", [start(ago(5 * MIN), { label: "x", link: { plugin: "elsewhere", screen: "inbox", params: { case: "tracker:1" } } })]);
    f.run("other-screen", [start(ago(5 * MIN), { label: "x", link: { plugin: "reconcile", screen: "settings", params: { case: "tracker:1" } } })]);
    f.run("no-affair", [start(ago(5 * MIN), null)]);
    f.run("old-file", [{ kind: "run.start", ts: ago(5 * MIN), flow: { name: "x", phases: [] } }]);
    f.run("bad-case", [start(ago(5 * MIN), AFFAIR("tracker:1\u0007x"))]);
    f.run("not-json-first-line", []);
    appendFileSync(path.join(f.dir, "not-json-first-line.jsonl"), "{this is not json\n");
    f.run("someone-elses-item", [start(ago(5 * MIN), AFFAIR("tracker:2"))]);
    assert.deepEqual(f.reader.forCase("tracker:1").map((r) => r.runId), ["mine"]);
    assert.deepEqual(f.reader.forCase("tracker:2").map((r) => r.runId), ["someone-elses-item"]);
    assert.deepEqual(f.reader.forCase("tracker:3"), []);
    assert.deepEqual(caseOfStart({ affair: AFFAIR("tracker:9", { stage: "ship" }) }, { plugin: "reconcile", screen: "inbox" }), { caseId: "tracker:9", stage: "ship" });
  } finally {
    f.close();
  }
});

test("alive and working: the step it is on, the ribbon, only the money of finished calls, and the agent working now", () => {
  const f = fixture();
  try {
    f.run("r1", [
      start(ago(30 * MIN), AFFAIR("tracker:1", { stage: "review" })),
      phaseStart(ago(29 * MIN), "collect"),
      callStart(ago(29 * MIN), "c1", "ask", { phase: "collect", timeout: "30m" }),
      callEnd(ago(20 * MIN), "c1"),
      phaseEnd(ago(20 * MIN), "collect"),
      phaseStart(ago(20 * MIN), "draft"),
      callStart(ago(19 * MIN), "c2", "ask", { phase: "draft", timeout: "30m" }),
      { kind: "call.agent", ts: ago(18 * MIN), callId: "c2", agentId: "agent-x" },
      { kind: "log", ts: ago(2 * MIN), level: "info", message: "still going" },
    ]);
    const r = only(f);
    assert.deepEqual([r.situation, r.stage, r.flow], ["doing", "review", "示例流程"]);
    assert.deepEqual(r.step, { index: 2, total: 3, title: "阶段 draft" });
    assert.deepEqual(r.steps, ["ok", "run", "todo"]);
    assert.equal(r.costUsd, 0.25, "the call still going is not counted: its cost is not known yet");
    assert.equal(r.agentId, "agent-x");
    assert.equal(r.quiet!.ms, 2 * MIN);
    assert.equal(r.gate, null);
    assert.deepEqual(r.link, { plugin: "orchestration-ui", screen: "runs", params: { run: "r1" } });
    assert.equal(r.startedAt, "2026-10-23T19:30:00+08:00", "told in the instance's zone like everything on the page");
  } finally {
    f.close();
  }
});

test("a gate waiting for a person is the run asking you, not a run that is stuck", () => {
  const f = fixture();
  try {
    f.run("r2", [
      start(ago(90 * MIN), AFFAIR("tracker:1")),
      phaseStart(ago(89 * MIN), "collect"),
      phaseEnd(ago(80 * MIN), "collect"),
      phaseStart(ago(80 * MIN), "draft"),
      callStart(ago(70 * MIN), "g1", "gate", { phase: "draft", title: "批准写入", summary: "把示例改动放进目录", carrier: "provider", timeout: "2h" }),
      { kind: "call.agent", ts: ago(70 * MIN), callId: "g1", agentId: "gate-agent" },
    ]);
    const r = only(f);
    assert.equal(r.situation, "me", "70 minutes quiet, and still not 'maybe stuck': it waits for a person");
    assert.deepEqual(r.gate, { callId: "g1", summary: "把示例改动放进目录", since: "2026-10-23T18:50:00+08:00", kind: "provider", agentId: "gate-agent" });
    assert.deepEqual(r.steps, ["ok", "wait", "todo"]);
    assert.equal(r.agentId, "gate-agent");
  } finally {
    f.close();
  }
});

test("alive but quiet too long is 'maybe stuck', and the limit is the runtime's: the running call's own timeout plus two minutes, from the last event, not a fixed time", () => {
  const f = fixture();
  try {
    f.run("quiet", [start(ago(60 * MIN), AFFAIR("tracker:1")), phaseStart(ago(59 * MIN), "collect"), callStart(ago(40 * MIN), "c1", "ask", { phase: "collect", timeout: "30m" })]);
    const slow = only(f);
    assert.equal(slow.situation, "slow");
    assert.deepEqual([slow.quiet!.ms, slow.quiet!.limitMs], [40 * MIN, 32 * MIN], "the call's timeout and the runtime's two minutes of grace, from the last event");
    assert.deepEqual(slow.steps, ["slow", "todo", "todo"]);
    const g = fixture();
    try {
      g.run("patient", [start(ago(60 * MIN), AFFAIR("tracker:1")), phaseStart(ago(59 * MIN), "collect"), callStart(ago(40 * MIN), "c1", "ask", { phase: "collect", timeout: "2h" })]);
      const ok = only(g);
      assert.equal(ok.situation, "doing", "a call allowed two hours is not stuck after 40 minutes");
      assert.equal(ok.quiet!.limitMs, 122 * MIN);
    } finally {
      g.close();
    }
    const h = fixture();
    try {
      h.run("short", [start(ago(60 * MIN), AFFAIR("tracker:1")), callStart(ago(20 * MIN), "c1", "ask", { timeout: "1m" })]);
      assert.equal(only(h).situation, "slow", "never below the base of 15 minutes");
      assert.equal(only(h).quiet!.limitMs, 15 * MIN);
    } finally {
      h.close();
    }
  } finally {
    f.close();
  }
});

test("lost: the claim has not been touched for two minutes, or an old file without a claim has been quiet for fifteen", () => {
  const f = fixture();
  try {
    f.run("stale", [start(ago(60 * MIN), AFFAIR("tracker:1")), phaseStart(ago(59 * MIN), "collect"), callStart(ago(58 * MIN), "c1", "ask", { timeout: "30m" }), callEnd(ago(50 * MIN), "c1")], { claimAgeMs: 10 * MIN });
    const lost = only(f);
    assert.equal(lost.situation, "lost");
    assert.deepEqual(lost.steps, ["lost", "todo", "todo"]);
    assert.equal(lost.costUsd, 0.25, "what was spent is what finished calls report");
    assert.equal(lost.agentId, null);
    const g = fixture();
    try {
      g.run("old-quiet", [start(ago(60 * MIN), AFFAIR("tracker:1")), { kind: "log", ts: ago(20 * MIN), level: "info", message: "x" }], { claimAgeMs: null });
      assert.equal(only(g).situation, "lost");
    } finally {
      g.close();
    }
    const fresh = fixture();
    try {
      fresh.run("old-fresh", [start(ago(60 * MIN), AFFAIR("tracker:1")), { kind: "log", ts: ago(2 * MIN), level: "info", message: "x" }], { claimAgeMs: null });
      assert.equal(only(fresh).situation, "doing");
    } finally {
      fresh.close();
    }
    // a claim touched 100 seconds ago is still alive (four heartbeats are two minutes)
    const h = fixture();
    try {
      h.run("recent", [start(ago(60 * MIN), AFFAIR("tracker:1")), { kind: "log", ts: ago(MIN), level: "info", message: "x" }], { claimAgeMs: 100_000 });
      assert.equal(only(h).situation, "doing");
    } finally {
      h.close();
    }
  } finally {
    f.close();
  }
});

test("failed: the error in plain words with the runtime's own beside it, what the finished steps may already have changed, and what never ran", () => {
  const f = fixture();
  try {
    f.run(
      "bad",
      [
        start(ago(60 * MIN), AFFAIR("tracker:1")),
        phaseStart(ago(59 * MIN), "collect"),
        callStart(ago(58 * MIN), "c1", "ask", { phase: "collect", effects: "none" }),
        callEnd(ago(55 * MIN), "c1"),
        callStart(ago(54 * MIN), "d1", "do", { phase: "collect", title: "拷贝示例文件" }),
        callEnd(ago(53 * MIN), "d1", true, { cost: null }),
        phaseEnd(ago(53 * MIN), "collect"),
        phaseStart(ago(52 * MIN), "draft"),
        callStart(ago(51 * MIN), "c2", "ask", { phase: "draft", effects: "workspace", title: "写草稿" }),
        callEnd(ago(40 * MIN), "c2", false, { error: { name: "OutputMismatch", message: "missing field verdict" } }),
        phaseEnd(ago(40 * MIN), "draft", false),
        { kind: "run.end", ts: ago(40 * MIN), outcome: "failed", value: null, summary: null, stop: null, error: { name: "OutputMismatch", message: "missing field verdict" }, durationMs: 1, cost: null, caveats: [] },
      ],
      { claimAgeMs: 30 * MIN },
    );
    const r = only(f);
    assert.equal(r.situation, "fail");
    assert.deepEqual(r.error, { name: "OutputMismatch", plain: "agent 的回答不合约定的格式，这一步没拿到结果", raw: "OutputMismatch: missing field verdict" });
    assert.deepEqual(r.steps, ["ok", "bad", "todo"]);
    assert.deepEqual(r.sideEffects, ["拷贝示例文件", "写草稿"], "a script's action that finished, and an agent that was allowed to write");
    assert.equal(r.quiet, null, "an ended run is not quiet");
    assert.equal(r.outcome, "agent 的回答不合约定的格式，这一步没拿到结果");
    assert.equal(r.costUsd, 0.5, "failed calls still cost");
    assert.equal(r.agentId, null);
  } finally {
    f.close();
  }
});

test("done and stopped are both over without a problem; a timeout is a failure; an unknown error is shown as the runtime told it", () => {
  const f = fixture();
  try {
    const end = (outcome: string, extra: Record<string, unknown> = {}) => ({ kind: "run.end", ts: ago(10 * MIN), outcome, value: null, summary: null, stop: null, error: null, durationMs: 1, cost: null, caveats: [], ...extra });
    f.run("done", [start(ago(30 * MIN), AFFAIR("tracker:1")), phaseStart(ago(29 * MIN), "collect"), phaseEnd(ago(28 * MIN), "collect"), end("done", { summary: "一共改了 3 处" })], { claimAgeMs: null });
    f.run("stopped", [start(ago(25 * MIN), AFFAIR("tracker:1")), end("stopped", { stop: { reason: "没有需要做的", phase: null } })], { claimAgeMs: null });
    f.run("timeout", [start(ago(20 * MIN), AFFAIR("tracker:1")), end("timeout", { error: { name: "RunTimeout", message: "exceeded 30m" } })], { claimAgeMs: null });
    f.run("odd", [start(ago(15 * MIN), AFFAIR("tracker:1")), end("failed", { error: { name: "WeirdThing", message: "boom\nsecond line" } })], { claimAgeMs: null });
    const by = Object.fromEntries(f.reader.forCase("tracker:1").map((r) => [r.runId, r]));
    assert.deepEqual([by.done!.situation, by.done!.outcome, by.done!.steps], ["done", "一共改了 3 处", ["ok", "skip", "skip"]]);
    assert.deepEqual([by.stopped!.situation, by.stopped!.stopReason, by.stopped!.outcome], ["done", "没有需要做的", "中止了：没有需要做的"]);
    assert.deepEqual([by.timeout!.situation, by.timeout!.error!.plain], ["fail", "超过了这次流程的总时限"]);
    assert.deepEqual([by.odd!.situation, by.odd!.error!.plain, by.odd!.error!.raw], ["fail", "出错了：boom", "WeirdThing: boom second line"], "the sentence is the first line, the raw one the whole message on one line");
    assert.deepEqual(f.reader.forCase("tracker:1").map((r) => r.runId), ["odd", "timeout", "stopped", "done"], "newest first");
  } finally {
    f.close();
  }
});

test("the file is read as it grows: a half-written last line waits, and the run moves on when the rest arrives", () => {
  const f = fixture();
  try {
    f.run("grow", [start(ago(5 * MIN), AFFAIR("tracker:1")), phaseStart(ago(4 * MIN), "collect")]);
    assert.deepEqual(only(f).steps, ["run", "todo", "todo"]);
    const half = JSON.stringify({ v: 1, seq: 9, runId: "grow", ...phaseEnd(ago(3 * MIN), "collect") });
    f.append("grow", [], half.slice(0, 30));
    // The scan is throttled: a reader that looks again at once sees the same thing.
    const later = createRunReader({ runsDir: f.dir, tz: "Asia/Shanghai", now: () => NOW, affair: { plugin: "reconcile", screen: "inbox" }, view: { plugin: "orchestration-ui", screen: "runs" } });
    assert.deepEqual(later.forCase("tracker:1")[0]!.steps, ["run", "todo", "todo"], "the half line is not read");
    appendFileSync(path.join(f.dir, "grow.jsonl"), half.slice(30) + "\n");
    const again = createRunReader({ runsDir: f.dir, tz: "Asia/Shanghai", now: () => NOW, affair: { plugin: "reconcile", screen: "inbox" }, view: { plugin: "orchestration-ui", screen: "runs" } });
    assert.deepEqual(again.forCase("tracker:1")[0]!.steps, ["ok", "todo", "todo"]);
  } finally {
    f.close();
  }
});

test("a runs directory that is not there is no runs, not an error", () => {
  const reader = createRunReader({ runsDir: path.join(os.tmpdir(), "reconcile-no-such-dir"), tz: "Asia/Shanghai", now: () => NOW, affair: { plugin: "reconcile", screen: "inbox" }, view: { plugin: "orchestration-ui", screen: "runs" } });
  assert.deepEqual(reader.forCase("tracker:1"), []);
});

test("the runs directory is found in the runtime's order: ORCH_LOG_DIR, the config file's logDir, the default", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "reconcile-home-"));
  try {
    assert.equal(resolveRunsDir({ ORCH_LOG_DIR: "/logs" }, home), path.join("/logs", "runs"));
    assert.equal(resolveRunsDir({}, home), path.join(home, ".paseo-orchestration", "logs", "runs"));
    mkdirSync(path.join(home, ".paseo-orchestration"));
    writeFileSync(path.join(home, ".paseo-orchestration", "config.json"), JSON.stringify({ logDir: "/elsewhere" }));
    assert.equal(resolveRunsDir({}, home), path.join("/elsewhere", "runs"));
    assert.equal(resolveRunsDir({ ORCH_LOG_DIR: "/logs" }, home), path.join("/logs", "runs"), "the environment still comes first");
    writeFileSync(path.join(home, ".paseo-orchestration", "config.json"), "{not json");
    assert.equal(resolveRunsDir({}, home), null, "a config that cannot be read is not guessed around");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- on the page --------------------------------------------------------------------------------------------

const RULE = `export default { name: "flow", description: "x", applies: { source: "gcp-demo" }, params: {}, stages: ["a", "b"],
  assess() { return { stage: "a", health: "on-track", headline: "h", next: { actor: "them", what: "w" }, facts: [], commitments: [] }; } };`;

test("a run's state decides where the item stands on the list and what the page says first", async () => {
  const states: Record<number, RunView> = {
    1: runView("doing"),
    2: runView("fail", { error: { name: "OutputMismatch", plain: "agent 的回答不合约定的格式，这一步没拿到结果", raw: "OutputMismatch: x" }, sideEffects: ["拷贝示例文件"], quiet: null }),
    3: runView("lost"),
    4: runView("slow", { quiet: { ms: 40 * MIN, limitMs: 35 * MIN } }),
    5: runView("me", { gate: { callId: "g1", summary: "把示例改动放进目录", since: "2026-10-13T09:40:00+08:00", kind: "provider", agentId: null } }),
    6: runView("done", { quiet: null, outcome: "一共改了 3 处" }),
  };
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "flow.mjs": RULE } }, runs: (caseId) => [states[Number(caseId.split(":")[1])]].filter((r): r is RunView => !!r) });
  try {
    for (const id of [1, 2, 3, 4, 5, 6]) w.items.set(`gcp-demo:${id}`, issue(id, { release: "2026-10-14" }));
    await w.run("2026-10-13 10:30");
    const cell = (id: number) => {
      const row = w.engine.status().cases.find((c) => c.caseId === `gcp-demo:${id}`)!.row!;
      return [row.situation, row.group];
    };
    // a finished run is no longer what the item is doing: the item's own judgment says (someone else has the ball)
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(cell), [["doing", "system"], ["fail", "me"], ["lost", "me"], ["slow", "me"], ["me", "me"], ["them", "them"]]);
    const fail = w.engine.graph("gcp-demo:2")!;
    assert.match(fail.hero.kicker, /流程失败了/);
    assert.match(fail.hero.line, /agent 的回答不合约定的格式/);
    assert.match(fail.hero.sub, /拷贝示例文件/, "what it may already have changed is told");
    assert.match(fail.hero.sub, /不会自动重来/);
    assert.equal(fail.runs.length, 1);
    const gate = w.engine.graph("gcp-demo:5")!;
    assert.match(gate.hero.line, /把示例改动放进目录/);
    assert.match(gate.hero.sub, /审批卡上点/, "approval is not done on this page");
    assert.deepEqual([gate.facts[3]!.value, gate.facts[3]!.hot], ["要", true], "a run waiting for approval is something for you to do");
    assert.match(gate.facts[3]!.sub, /审批卡/);
    assert.match(w.engine.graph("gcp-demo:1")!.hero.line, /示例流程/);
  } finally {
    w.close();
  }
});
