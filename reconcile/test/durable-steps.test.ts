import assert from "node:assert/strict";
import { test } from "node:test";
import { endedMessage, unfinishedWhy } from "../server/flows";
import { probeFromRunnerOutput, settleOf } from "../server/runs";
import { SETTLE_KICKER, settleShort, settleView, settleWhole } from "../shared/graph";
import type { FlowEnd } from "../shared/model";
import { probeOf } from "./helpers";
import { advance, asks, first, flowsOf, idFor, req, withFlows } from "./flows-kit";
import { ago, AFFAIR, callEnd, callStart, fixture, MIN, only, runView, start } from "./run-files";

// Steps the runtime does once for a line of runs (`$.step`, EVENTS.md "日志"): what the reader takes from the events of a run that carries
// another on, what a call taken from the journal is not (a spend, a change, a line of its own), and a step that cannot be taken back and may or
// may not have been done -- the run stops there, and the page asks the person which it was. Event files here are made up, in the shape EVENTS.md gives.

const CARRIES = (ts: string, of: string, extra: Record<string, unknown> = {}) => ({ ...start(ts, AFFAIR("tracker:1")), resumeOf: of, resumePrint: "0123456789abcdef", ...extra });
const REUSED = (runId: string, callId: string | null) => ({ reused: { runId, callId } });
const end = (ts: string, outcome: string, extra: Record<string, unknown> = {}) => ({ kind: "run.end", ts, outcome, value: null, summary: null, stop: null, error: null, durationMs: 1, cost: null, caveats: [], ...extra });
/** The reason the runtime writes (run.mjs, `$.step` with `once`) for a step it found begun and did not know the end of. */
const reasonOf = (runId: string, step: string, title = "发布到服务器") => `「${title}」可能已经做了、也可能没做（它开始过，没有留下结果）：去外面查一下，用 orch.mjs settle ${runId} ${step} --done '<值的 JSON>' 或 --not-done 了结，再接着跑`;

// ---- the line a run is on ---------------------------------------------------------------------------------------

test("a run is on the line its run.start says; one from before the runtime wrote lines is on a line of its own, and what does not read as a run id is too", () => {
  const f = fixture();
  try {
    f.run("r1", [start(ago(90 * MIN), AFFAIR("tracker:1")), end(ago(80 * MIN), "stopped")], { claimAgeMs: null });
    f.run("r2", [CARRIES(ago(70 * MIN), "r1", { lineage: "r1", redo: null }), end(ago(60 * MIN), "stopped")], { claimAgeMs: null });
    f.run("r3", [CARRIES(ago(50 * MIN), "r2", { lineage: "r1", redo: "发布到服务器" }), end(ago(40 * MIN), "done")], { claimAgeMs: null });
    f.run("old", [CARRIES(ago(30 * MIN), "r3"), end(ago(25 * MIN), "done")], { claimAgeMs: null });
    f.run("odd", [CARRIES(ago(20 * MIN), "r3", { lineage: "../elsewhere", redo: "x".repeat(300) }), end(ago(15 * MIN), "done")], { claimAgeMs: null });
    const by = Object.fromEntries(f.reader.forCase("tracker:1").map((r) => [r.runId, r]));
    assert.deepEqual(["r1", "r2", "r3"].map((id) => by[id]!.lineage), ["r1", "r1", "r1"], "the runs that carry one another on share the line of the first");
    assert.deepEqual(["r1", "r2", "r3"].map((id) => by[id]!.resumeOf ?? null), [null, "r1", "r2"], "and the link from each to the one before is still its own");
    assert.equal(by.r1!.redo, undefined);
    assert.equal(by.r2!.redo, undefined, "null: nothing was asked to be done again");
    assert.equal(by.r3!.redo, "发布到服务器");
    assert.equal(by.old!.lineage, "old", "a file from before the runtime wrote lines: its own id (EVENTS.md), although it carries r3 on");
    assert.equal(by.old!.resumeOf, "r3");
    assert.equal(by.odd!.lineage, "odd", "not read as a run id: not taken");
    assert.ok([...by.odd!.redo!].length <= 80, "a step name is cut");
  } finally {
    f.close();
  }
});

// ---- what a call taken from the journal is not ------------------------------------------------------------------

test("a call taken from the journal spent nothing in this run, changed nothing in it, and is counted once as taken; a step is a script's act, and is told when it was done", () => {
  const f = fixture();
  try {
    const cost = { usd: 0.4, inputTokens: 9, outputTokens: 9 };
    f.run(
      "r2",
      [
        CARRIES(ago(60 * MIN), "r1", { lineage: "r1" }),
        // taken: an agent's answer (with a cost that must not be counted again, whatever the file says), a card a person answered, a step with a value
        callStart(ago(59 * MIN), "c1", "ask", { effects: "workspace", ...REUSED("r1", "c1") }),
        callEnd(ago(59 * MIN), "c1", true, { agentId: "agent-1", cost }),
        callStart(ago(58 * MIN), "c2", "gate", REUSED("r1", "c4")),
        callEnd(ago(58 * MIN), "c2", true, { output: { outcome: "allowed" }, cost: null }),
        callStart(ago(57 * MIN), "c3", "step", { once: true, key: "0123456789abcdef", title: "提交到主干", ...REUSED("r1", "c5") }),
        callEnd(ago(57 * MIN), "c3", true, { output: { rev: 12 }, cost: null }),
        // made now: a step (done, and a step that cannot be taken back that failed -- it may have taken effect), a step that can be done again that failed
        callStart(ago(56 * MIN), "c4", "step", { once: false, key: "0123456789abcdef", title: "整理文件" }),
        callEnd(ago(55 * MIN), "c4", true, { output: 1, cost: null }),
        callStart(ago(54 * MIN), "c5", "step", { once: true, key: "0123456789abcdef", title: "发出通知" }),
        callEnd(ago(53 * MIN), "c5", false, { error: { name: "Error", message: "boom" }, cost: null }),
        callStart(ago(52 * MIN), "c6", "step", { once: false, key: "0123456789abcdef", title: "算一下" }),
        callEnd(ago(51 * MIN), "c6", false, { error: { name: "Error", message: "boom" }, cost: null }),
        callStart(ago(50 * MIN), "c7", "ask", {}),
        callEnd(ago(49 * MIN), "c7", true, { agentId: "agent-7", cost: { usd: 0.1, inputTokens: 1, outputTokens: 1 } }),
      ],
      { claimAgeMs: 10_000 },
    );
    const view = only(f);
    assert.equal(view.costUsd, 0.1, "only the call made now is a spend");
    assert.equal(view.reused, 3);
    assert.deepEqual(view.sideEffects, ["整理文件", "发出通知"], "the step that was done, and the one that cannot be taken back that failed; not what was taken, not a step that can be done again that failed");
    assert.equal(view.lineage, "r1");
  } finally {
    f.close();
  }
  // a run that took nothing says nothing of it
  const g = fixture();
  try {
    g.run("r1", [start(ago(30 * MIN), AFFAIR("tracker:1")), callStart(ago(29 * MIN), "c1", "ask", {}), callEnd(ago(28 * MIN), "c1", true, { agentId: "agent-1" }), end(ago(27 * MIN), "done")], { claimAgeMs: null });
    const view = only(g);
    assert.equal(view.reused, undefined);
    assert.equal(view.redo, undefined);
    assert.equal(view.settle, undefined);
    assert.equal(view.lineage, "r1");
  } finally {
    g.close();
  }
});

// ---- a step that may or may not have been done ------------------------------------------------------------------

test("the reader knows a stop at such a step by the reason the runtime gives, takes the step's name only where it reads as one word, and nothing else is a settle", () => {
  const ok = settleOf("stopped", reasonOf("r1", "deploy"));
  assert.deepEqual(ok, { step: "deploy", title: "发布到服务器" });
  assert.deepEqual(settleOf("stopped", reasonOf("r1", "发布")), { step: "发布", title: "发布到服务器" }, "a name in the flow's own language");
  assert.deepEqual(settleOf("stopped", reasonOf("r1", "a;rm", "x")), { step: null, title: "x" }, "a name the shell would read as more than a word is not put in a command");
  assert.deepEqual(settleOf("stopped", reasonOf("r1", "a'b")), { step: null, title: "发布到服务器" });
  assert.deepEqual(settleOf("stopped", "orch.mjs settle r1"), { step: null, title: null }, "a reason cut short still says what it is");
  for (const [outcome, reason] of [["failed", reasonOf("r1", "deploy")], ["done", reasonOf("r1", "deploy")], ["stopped", "没有需要做的"], ["stopped", null], ["stopped", 5], ["stopped", ""], [undefined, reasonOf("r1", "deploy")]] as const) {
    assert.equal(settleOf(outcome, reason), null, `${outcome} ${String(reason)}`);
  }
  // the whole reason is read, not the cut one: the run's own reason is far past what a line keeps
  assert.ok(reasonOf("rc-test-0123456789ab-r1", "deploy").length > 120);
  const f = fixture();
  try {
    const long = reasonOf("r1", "deploy");
    f.run("r1", [start(ago(30 * MIN), AFFAIR("tracker:1")), end(ago(10 * MIN), "stopped", { value: { step: "deploy", unknown: true }, stop: { reason: long, phase: null } })], { claimAgeMs: null });
    f.run("r2", [{ ...start(ago(30 * MIN), AFFAIR("tracker:2")) }, end(ago(10 * MIN), "stopped", { stop: { reason: "没有需要做的", phase: null } })], { claimAgeMs: null });
    const [one] = f.reader.forCase("tracker:1");
    assert.deepEqual(one!.settle, { title: "发布到服务器", commands: ["orch.mjs settle r1 deploy --not-done", "orch.mjs settle r1 deploy --done '<值的 JSON>'"] });
    assert.ok(one!.stopReason!.length <= 120, "the reason for a line stays cut");
    assert.equal(f.reader.forCase("tracker:2")[0]!.settle, undefined);
    assert.equal(f.reader.probe("r1", null).end!.settle!.step, "deploy", "the controller is told it too, to write down with how the run ended");
  } finally {
    f.close();
  }
  // and from what the runner printed, when the files are gone
  const printed = (reason: string) => JSON.stringify({ ok: true, outcome: "stopped", value: { step: "deploy", unknown: true }, summary: null, stop: { reason, phase: null }, cost: null }, null, 2);
  assert.deepEqual(probeFromRunnerOutput(printed(reasonOf("r9", "deploy")), 1)!.end!.settle, { step: "deploy", title: "发布到服务器" });
  assert.equal(probeFromRunnerOutput(printed("没有需要做的"), 1)!.end!.settle, null);
});

test("what the person is told of it: a short sentence, and the whole of it with the commands as lines of their own; none that cannot be typed", () => {
  const view = settleView("rc-1", { step: "deploy", title: "发布到服务器" });
  assert.equal(settleShort(view), "「发布到服务器」可能已经做了，也可能没做");
  assert.equal(settleShort({ title: null }), "有一步可能已经做了，也可能没做");
  assert.match(settleWhole(view), /^「发布到服务器」可能已经做了，也可能没做。去外面看一眼它做了没有，再用下面的命令告诉系统，然后接着跑$/);
  assert.deepEqual(view.commands, ["orch.mjs settle rc-1 deploy --not-done", "orch.mjs settle rc-1 deploy --done '<值的 JSON>'"]);
  const noName = settleView("rc-1", { step: null, title: null });
  assert.deepEqual(noName.commands, []);
  assert.match(settleWhole(noName), /orch\.mjs settle/, "it points at the runtime's own word instead");
  assert.doesNotMatch(settleShort(view), /orch|settle|journal|日志/, "the short sentence has no word of the runtime");
});

// ---- the engine and the page ------------------------------------------------------------------------------------

const REASON = (runId: string) => reasonOf(runId, "deploy");
const OFFER = { flow: "triage-resume", from: "确认以后从发布接着", spends: "nothing" as const };
const STOP = (runId: string, resume: typeof OFFER | null = null) =>
  probeOf({
    state: "ended",
    costUsd: 0.3,
    resume,
    end: { at: 0, outcome: "stopped", summary: null, stop: REASON(runId).slice(0, 120), error: null, value: { step: "deploy", unknown: true }, valueDropped: false, totalUsd: null, settle: { step: "deploy", title: "发布到服务器" } },
  });

test("a run stopped at a step nobody knows was done is a run in trouble that asks the person first: the top bar says so, the whole reason has the commands, and starting over is not offered", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    w.flows.probes.set(id, STOP(id, OFFER));
    await advance(w, 10);
    const v = w.engine.graph("gcp-demo:1")!;
    const run = v.runs[0]!;
    assert.equal(run.situation, "unchecked", "a stop that did not get done what it was for");
    assert.equal(v.hero.kicker, SETTLE_KICKER);
    assert.equal(SETTLE_KICKER, "要你：确认那一步做没做");
    assert.equal(v.hero.line, "triage-flow停了：「发布到服务器」可能已经做了，也可能没做", "what became of it, in the words of a person");
    assert.doesNotMatch(JSON.stringify([v.hero, v.history.filter((h) => !h.inner).map((h) => h.line)]), /orch\.mjs|settle|--done|--not-done/, "no command on the first screen");
    assert.deepEqual(run.settle!.commands, [`orch.mjs settle ${id} deploy --not-done`, `orch.mjs settle ${id} deploy --done '<值的 JSON>'`]);
    assert.match(run.why!, /^「发布到服务器」可能已经做了，也可能没做。去外面看一眼它做了没有，再用下面的命令告诉系统，然后接着跑$/);
    assert.deepEqual(run.actions, ["resume", "mine", "fold"], "carrying on is the way once it is said; starting over would do the step again, where nothing of the first is kept");
    assert.equal(run.retry, null);
    const refused = w.engine.retryFlow(id, "owner");
    assert.deepEqual([refused.ok, refused.detail.includes("再做一遍")], [false, true]);
    assert.equal(flowsOf(w)[id]!.ended!.settle!.step, "deploy", "written down with how the run ended: after a restart it is the same");
    await w.restart();
    await advance(w, 10);
    assert.equal(w.engine.graph("gcp-demo:1")!.hero.kicker, SETTLE_KICKER);
  }));

test("without anything to carry on from there is still no way to start over from the page: the person says what happened, then it is theirs", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")]);
    await first(w);
    w.flows.probes.set(id, STOP(id));
    await advance(w, 10);
    const run = w.engine.graph("gcp-demo:1")!.runs[0]!;
    assert.deepEqual(run.actions, ["mine", "fold"]);
    assert.equal(w.engine.graph("gcp-demo:1")!.hero.kicker, SETTLE_KICKER);
  }));

test("the message at the end tells it as 停了 in the words of a person, and the rule's value of the stop is as it always was", () => {
  const rec = { label: "初查", caseId: "gcp-demo:7" };
  const base: FlowEnd = { at: "2026-10-13T02:00:00.000Z", outcome: "stopped", summary: null, costUsd: 0, value: { step: "deploy", unknown: true }, valueDropped: false, why: "x", settle: { step: "deploy", title: "发布到服务器" } };
  assert.equal(unfinishedWhy(base), "「发布到服务器」可能已经做了，也可能没做");
  assert.equal(unfinishedWhy({ ...base, settle: undefined }), null, "without it, a stop with no why of its own is a finished one");
  const told = endedMessage(rec, base);
  assert.deepEqual([told.title, told.status], ["初查停了", "failed"]);
  assert.match(told.text, /^#7 初查停了：「发布到服务器」可能已经做了，也可能没做。/);
  assert.doesNotMatch(told.text, /orch\.mjs|settle/, "the commands are on the page, not in a message");
});

test("a run that carried on says, behind a tap, what it did not do again; a spend is the cost of what it made, and the line is its own", () => {
  const id = idFor(1, "k1");
  return withFlows(
    async (w) => {
      asks(w, 1, [req("k1")]);
      await first(w);
      w.flows.probes.set(id, probeOf({ state: "ended", costUsd: 0.1, end: { at: 0, outcome: "done", summary: "找到 2 处", stop: null, error: null, value: { found: 2 }, valueDropped: false, totalUsd: null } }));
      await advance(w, 10);
      const line = w.engine.graph("gcp-demo:1")!.history.find((h) => h.kind === "run" && /好了/.test(h.line))!;
      assert.ok(line, "one line for the run");
      assert.match(line.line, /好了（.*\$0\.10）$/, "what it cost is what it made");
      assert.ok(line.detail?.includes("从「发布到服务器」起重做，沿用了前面做过的 3 项，没重做"), line.detail ?? "no detail");
      assert.doesNotMatch(line.line, /沿用|重做/, "behind a tap, not on the line");
      assert.equal(w.engine.graph("gcp-demo:1")!.history.filter((h) => h.kind === "run").length, 1, "taking from the journal does not make a line of its own");
    },
    { runs: () => [runView("done", { runId: id, reused: 3, redo: "发布到服务器", lineage: id, startedAt: "2026-10-13T09:30:00+08:00", endedAt: "2026-10-13T09:40:00+08:00", costUsd: 0.1 })] },
  );
});
