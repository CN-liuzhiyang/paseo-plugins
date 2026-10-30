import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ledgerText, resumeNote, retryLabel, troubleLine, type RunView } from "../shared/graph";
import type { FlowEnd, FlowRec } from "../shared/model";
import { createLauncher, endedMessage, inputHashOf, resultOf, type LaunchSpec } from "../server/flows";
import { offerOf, probeFromRunnerOutput } from "../server/runs";
import { probeOf } from "./helpers";
import { set } from "./item-flow";
import { advance, asks, finished, first, flowsOf, headline, idFor, kinds, look, OWNER, POLICY, req, RULE, running, withFlows } from "./flows-kit";
import { AFFAIR, ago, fixture, MIN, runView, start } from "./run-files";

// Carrying on a run that stopped short ("接着跑"): what the reader takes from the runtime's files, what the page offers and when,
// what the person's button writes and starts, how a run started by hand with `orch.mjs resume` is taken into the record, and what the
// rule and the message at the end are told. As flows-trouble.test.ts: a launcher that records and a probe the test sets; nothing is
// started (the real runtime is in flows-orch.test.ts).

type Offer = { flow: string; from: string; spends: "nothing" | "maybe"; print?: string };
const OFFER: Offer = { flow: "triage-resume", from: "第一步已完成：从第二步接着，不重做第一步", spends: "nothing" };

/** A run that stopped on purpose and said in its value that it did not get done what it was for, and how it could be carried on. */
const stopped = (resume: Offer | null = OFFER, why = "校验没过：缺一个必填字段", costUsd = 0.4) =>
  probeOf({ state: "ended", costUsd, resume, end: { at: 0, outcome: "stopped", summary: null, stop: why, error: null, value: { why }, valueDropped: false, totalUsd: null } });

/** The rule of flows-kit, reading out of each run what it is told of carrying on. */
const READS = RULE.replace(
  'return n + ":" + k + "=" + (r ? r.state + (r.value ? JSON.stringify(r.value) : "") : "-");',
  'return n + ":" + k + "=" + (r ? r.state + (r.value ? JSON.stringify(r.value) : "") + (r.resumable ? "|can:" + r.resumable.from + "/" + r.resumable.spends : "") + (r.resumedFrom ? "|from:" + r.resumedFrom : "") + "|ran:" + r.ran : "-");',
);
assert.notEqual(READS, RULE, "the rule was changed");
const SELF = RULE.replace('triage: { flow: "triage-flow", timeout: "30m", maxUsd: 1, notify: true }', 'triage: { flow: "triage-flow", timeout: "30m", maxUsd: 1, notify: true, selfRetry: true }');
assert.notEqual(SELF, RULE);

const view = (w: { engine: { graph(caseId: string): { runs: RunView[] } | null } }, n: number, runId: string): RunView => view_(w.engine.graph(`gcp-demo:${n}`)!.runs, runId);
const view_ = (runs: RunView[], runId: string): RunView => {
  const found = runs.find((r) => r.runId === runId);
  assert.ok(found, `no run ${runId} on the page: ${runs.map((r) => r.runId).join(", ")}`);
  return found;
};

// ---- what the reader takes from the runtime's files -------------------------------------------------------

test("the reader takes how a run said it could be carried on, and which run it carries on, from the runtime's own files", () => {
  const f = fixture();
  try {
    const point = { flow: "triage-resume", input: { dir: "d1" }, from: "第一步已完成：从第二步接着", spends: "nothing" };
    const end = (resume: unknown) => ({ kind: "run.end", ts: ago(MIN), outcome: "stopped", summary: null, stop: { reason: "停下" }, error: null, value: { why: "要处理" }, cost: { totalUsd: 0.2 }, resume });
    // ended: the word on run.end counts, whatever was said before it
    f.run("ended", [start(ago(30 * MIN), AFFAIR("tracker:1")), { kind: "resume", ts: ago(20 * MIN), ...point, from: "更早的一句" }, end({ ...point, from: "最后的一句" })], { claimAgeMs: null });
    // ended with nothing to carry on from, after having said something while it ran: nothing
    f.run("ended-none", [start(ago(30 * MIN), AFFAIR("tracker:2")), { kind: "resume", ts: ago(20 * MIN), ...point }, end(null)], { claimAgeMs: null });
    // cut off (no run.end): the last thing it said
    f.run("cut-off", [start(ago(30 * MIN), AFFAIR("tracker:3")), { kind: "resume", ts: ago(20 * MIN), ...point, from: "第一句" }, { kind: "resume", ts: ago(10 * MIN), ...point, from: "第二句", spends: "maybe" }]);
    // taken back
    f.run("taken-back", [start(ago(30 * MIN), AFFAIR("tracker:4")), { kind: "resume", ts: ago(20 * MIN), ...point }, { kind: "resume", ts: ago(10 * MIN), cleared: true }]);
    // what does not fit the shape the runtime writes is not an offer (the file can be edited, and a button is drawn from this)
    f.run("bad-flow", [start(ago(30 * MIN), AFFAIR("tracker:5")), { kind: "resume", ts: ago(20 * MIN), ...point, flow: "../elsewhere" }]);
    f.run("bad-spends", [start(ago(30 * MIN), AFFAIR("tracker:6")), { kind: "resume", ts: ago(20 * MIN), ...point, spends: "sometimes" }]);
    f.run("no-line", [start(ago(30 * MIN), AFFAIR("tracker:7")), { kind: "resume", ts: ago(20 * MIN), ...point, from: "  " }]);
    // which run it carries on, and from which point it was started
    f.run("resumed", [{ ...start(ago(30 * MIN), AFFAIR("tracker:8")), resumeOf: "ended", resumePrint: "92645a244d9b3d69" }]);
    f.run("resumed-bad", [{ ...start(ago(30 * MIN), AFFAIR("tracker:9")), resumeOf: "a/b" }]);
    f.run("plain", [start(ago(30 * MIN), AFFAIR("tracker:10"))]);
    const of = (n: number) => f.reader.forCase(`tracker:${n}`)[0]!;
    assert.deepEqual(of(1).resume, { from: "最后的一句", spends: "nothing" });
    assert.equal(of(2).resume, null);
    assert.deepEqual(of(3).resume, { from: "第二句", spends: "maybe" });
    assert.equal(of(4).resume, null);
    for (const n of [5, 6, 7]) assert.equal(of(n).resume, null, `tracker:${n}`);
    assert.equal(of(8).resumeOf, "ended");
    assert.equal(of(8).resumePrint, "92645a244d9b3d69");
    assert.equal(of(10).resumePrint, null);
    assert.equal(of(9).resumeOf, null, "an id that does not read as one is not one");
    assert.equal(of(10).resumeOf, null);
    // the controller reads a run by its id, too
    const print = inputHashOf({ flow: "triage-resume", input: { dir: "d1" } });
    assert.deepEqual(f.reader.probe("ended", null).resume, { flow: "triage-resume", from: "最后的一句", spends: "nothing", print });
    assert.deepEqual(f.reader.probe("cut-off", null).resume, { flow: "triage-resume", from: "第二句", spends: "maybe", print });
    assert.equal(f.reader.probe("taken-back", null).resume, null);
    assert.equal(f.reader.probe("not-there", null).resume ?? null, null);
    assert.equal(offerOf({ flow: "a", from: "x", spends: "nothing", input: { secret: 1 } })!.flow, "a");
    // the fingerprint is the runtime's `pointPrint` (flow and input, whatever order the keys are in): this vector is the one in orchestration's resume test
    assert.equal(offerOf({ flow: "rs-part-two", from: "x", spends: "nothing", input: { b: 1, a: [1, { d: 2, c: 3 }], s: "中文" } })!.print, "92645a244d9b3d69");
    assert.equal(offerOf({ input: { s: "中文", a: [1, { c: 3, d: 2 }], b: 1 }, flow: "rs-part-two", from: "another line", spends: "maybe" })!.print, "92645a244d9b3d69");
    assert.equal(offerOf({ flow: "a", from: "x", spends: "nothing" })!.print, undefined, "no input to fingerprint: no fingerprint");
    assert.equal(offerOf("nope"), null);
  } finally {
    f.close();
  }
});

test("the result a run printed carries how it could be carried on too: a run that ended before the controller read its files is not read as one with nothing to say", () => {
  const printed = (over: Record<string, unknown>) => JSON.stringify({ ok: false, outcome: "stopped", value: { why: "停了" }, summary: null, runId: "r", stop: { reason: "停" }, cost: null, ...over }, null, 2);
  const stoppedShort = probeFromRunnerOutput(printed({ resume: { flow: "triage-resume", input: { a: 1 }, from: "从核对接着", spends: "nothing" } }), 1)!;
  const offer = { flow: "triage-resume", from: "从核对接着", spends: "nothing", print: inputHashOf({ flow: "triage-resume", input: { a: 1 } }) };
  assert.deepEqual([stoppedShort.resume, stoppedShort.end!.resume], [offer, offer]);
  assert.equal(probeFromRunnerOutput(printed({ resume: null }), 1)!.resume, null);
  assert.equal(probeFromRunnerOutput(printed({}), 1)!.resume, null, "a runtime that did not say");
  assert.equal(probeFromRunnerOutput(printed({ resume: { flow: "../x", from: "y", spends: "nothing" } }), 1)!.resume, null);
});

// ---- the button: where it is and where it is not ----------------------------------------------------------

test("a stopped run that said how it could be carried on is offered 接着跑 first, and running it again from the start is then called 从头重跑", () =>
  withFlows(async (w) => {
    const [a, b] = [idFor(1, "k1"), idFor(2, "k1")];
    asks(w, 1, [req("k1")]);
    asks(w, 2, [req("k1")]);
    await first(w);
    w.flows.probes.set(a, stopped());
    w.flows.probes.set(b, stopped(null));
    await advance(w, 10);
    const offered = view(w, 1, a);
    assert.deepEqual(offered.actions, ["resume", "retry", "mine", "fold"]);
    assert.deepEqual(offered.resume, { from: OFFER.from, spends: "nothing" });
    assert.equal(retryLabel(offered), "从头重跑（会再花钱，上次花了 $0.40）");
    assert.match(troubleLine(offered), /没查成：校验没过：缺一个必填字段。处理好原因以后点「接着跑」/);
    assert.equal(resumeNote(offered), "第一步已完成：从第二步接着，不重做第一步 · 不调模型");
    assert.match(w.engine.graph("gcp-demo:1")!.hero.sub, /可以接着跑、从头重跑，或者你自己来。不会自动重来。/);
    // one that said nothing is offered what it always was
    const plain = view(w, 2, b);
    assert.deepEqual(plain.actions, ["retry", "mine", "fold"]);
    assert.equal(plain.resume, null);
    assert.equal(retryLabel(plain), "重新跑一次（会再花钱，上次花了 $0.40）");
    assert.match(troubleLine(plain), /不会自动重来。$/);
    // and a flow that may call a model says so
    assert.equal(resumeNote({ resume: { from: "第二步失败时要查原因。", spends: "maybe" }, costUsd: 1.5 }), "第二步失败时要查原因 · 可能会调模型（上一轮花了 $1.50）");
    assert.equal(resumeNote({ resume: { from: "第二步失败时要查原因", spends: "maybe" }, costUsd: 0 }), "第二步失败时要查原因 · 可能会调模型");
    assert.equal(resumeNote({ resume: null, costUsd: 0 }), "");
  }));

test("no button where it would be wrong: a run still going, one that came out whole, a run set aside, an earlier round, a stage the item has left, a flow the rule retries itself", async () => {
  await withFlows(async (w) => {
    const ids = [1, 2, 3, 4, 5].map((n) => idFor(n, "k1"));
    for (const n of [1, 2, 3, 4, 5]) asks(w, n, [req("k1")]);
    await first(w);
    w.flows.probes.set(ids[0]!, running());
    w.flows.probes.set(ids[1]!, finished({ ok: 1 }));
    w.flows.probes.set(ids[2]!, finished({ ok: 1 }, { outcome: "stopped" })); // a stop with no `why` is a finished one
    w.flows.probes.set(ids[3]!, stopped());
    w.flows.probes.set(ids[4]!, stopped());
    await advance(w, 10);
    for (const [i, n] of [[0, 1], [1, 2], [2, 3]] as const) assert.deepEqual(view(w, n, ids[i]!).actions?.includes("resume"), false, `item ${n}`);
    assert.deepEqual(view(w, 4, ids[3]!).actions?.[0], "resume");
    // set aside by the person ("我自己来"): not carried on
    assert.equal(w.engine.dismissFlow(ids[3]!, "mine", "owner").ok, true);
    assert.deepEqual(view(w, 4, ids[3]!).actions, []);
    assert.match(w.engine.resumeFlow(ids[3]!, "owner").detail, /已经被收起/);
    // an earlier round is history: the button is for the newest round of its request
    assert.equal(w.engine.resumeFlow(ids[4]!, "owner").ok, true);
    await advance(w, 10);
    const earlier = view(w, 5, ids[4]!);
    assert.deepEqual([earlier.actions, earlier.resume], [[], null]);
    assert.match(w.engine.resumeFlow(ids[4]!, "owner").detail, /已经有更新的一轮了/);
    // the item has left the stage the run was asked in: history, as for the retry
    set(w, 1, { Phase: "finished" });
    w.flows.probes.set(ids[0]!, stopped());
    await advance(w, 30);
    assert.deepEqual(view(w, 1, ids[0]!).actions, []);
  }, { policy: POLICY({}) });
  await withFlows(
    async (w) => {
      const id = idFor(1, "k1");
      asks(w, 1, [req("k1")]);
      await first(w);
      w.flows.probes.set(id, stopped());
      await advance(w, 10);
      assert.deepEqual(view(w, 1, id).actions, [], "the rule takes the failure of this flow itself");
      assert.match(w.engine.resumeFlow(id, "owner").detail, /判断方法会自己再起一次/);
    },
    { rule: SELF },
  );
});

// ---- what the button does ---------------------------------------------------------------------------------

test("carrying on is a person's: the next round of the request under a new id, written with its intent in one go, started by `resume` with no input of the controller's, and read by the rule as the latest round", () =>
  withFlows(
    async (w) => {
      const [r0, r1] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1)];
      asks(w, 1, [req("k1", { n: 1 })], { Watch: "triage:k1" });
      await first(w);
      w.flows.probes.set(r0, stopped());
      await advance(w, 10);
      assert.equal(headline(w, 1), `r triage:k1=stopped{"why":"校验没过：缺一个必填字段"}|can:${OFFER.from}/nothing|ran:triage-flow`, "the rule is told it can be carried on, and by what");
      const r = w.engine.resumeFlow(r0, "owner");
      assert.deepEqual([r.ok, r.detail], [true, `记下了，这就接着跑（第 2 次）：${OFFER.from}`]);
      const events = w.journal().filter((e) => e.type === "flow.resume" || (e.type === "flow.intent" && (e.rec as { round: number }).round === 1));
      assert.deepEqual(events.map((e) => e.type), ["flow.resume", "flow.intent"], "the person's act and the intent, in one write");
      assert.deepEqual([events[0]!.runId, events[0]!.round, events[0]!.from, events[0]!.flow, events[0]!.by, events[0]!.caseId, events[0]!.name, events[0]!.key], [r1, 1, r0, "triage-resume", "owner", "gcp-demo:1", "triage", "k1"]);
      const rec = flowsOf(w)[r1]!;
      assert.deepEqual([rec.round, rec.flow, rec.input, rec.logDir], [1, "triage-flow", { n: 1 }, flowsOf(w)[r0]!.logDir], "the request's own flow and input stay; it is made where the run it carries on is");
      assert.deepEqual(rec.resume, { from: r0, flow: "triage-resume", line: OFFER.from, spends: "nothing", by: "owner" });
      await advance(w, 10);
      assert.deepEqual(w.flows.launcher.started.map((s) => s.runId), [r0, r1]);
      const spec = w.flows.launcher.started[1]!;
      assert.deepEqual([spec.resumeOf, spec.flow], [r0, "triage-resume"]);
      assert.equal(existsSync(spec.inputFile), false, "the runtime reads the input of the run it carries on, not the controller's");
      const affair = JSON.parse(readFileSync(spec.affairFile, "utf8")) as { link: { params: { case: string } } };
      assert.equal(affair.link.params.case, "gcp-demo:1", "the same item's workspace");
      assert.equal(existsSync(w.flows.launcher.started[0]!.inputFile), true, "a run from the start has its input written, as before");
      assert.equal(headline(w, 1), `r triage:k1=starting|from:${r0}|ran:triage-resume`);
      assert.match(w.engine.resumeFlow(r0, "owner").detail, /已经有更新的一轮了/);
      // the page says what it is
      const shown = view(w, 1, r1);
      assert.deepEqual([shown.round, shown.flow, shown.resumeOf, shown.carriedOn], [1, "triage-flow", r0, { by: "owner", line: OFFER.from, spends: "nothing" }]);
      // it comes out: the request is no longer one that did not come to a result
      w.flows.probes.set(r1, finished({ ok: true }, {}, 0));
      await advance(w, 10);
      assert.match(headline(w, 1)!, /triage:k1=done\{"ok":true\}\|from:.*\|ran:triage-resume/);
      assert.deepEqual(view(w, 1, r1).actions, []);
      assert.equal(w.engine.graph("gcp-demo:1")!.situation, "them", "the item stands where its rule says, not as one with a stopped run");
    },
    { rule: READS, policy: POLICY({}) },
  ));

test("carrying on is held to the day's limits as a person's retry is: the item's own count does not hold it, the day's count does", async () => {
  await withFlows(
    async (w) => {
      asks(w, 1, [req("k1")]);
      await first(w);
      w.flows.probes.set(idFor(1, "k1"), stopped());
      await advance(w, 10);
      const r = w.engine.resumeFlow(idFor(1, "k1"), "owner");
      assert.equal(r.ok, true, r.detail);
    },
    { policy: POLICY({ perCasePerDay: 1 }) },
  );
  await withFlows(
    async (w) => {
      asks(w, 1, [req("k1")]);
      asks(w, 2, [req("k1")]);
      await first(w);
      w.flows.probes.set(idFor(1, "k1"), stopped());
      await advance(w, 10);
      const r = w.engine.resumeFlow(idFor(1, "k1"), "owner");
      assert.equal(r.ok, false);
      assert.match(r.detail, /今天流程已经起了 2 次（上限 2），明天再点/);
      assert.equal(kinds(w).filter((k) => k === "flow.resume").length, 0);
    },
    { policy: POLICY({ perDay: 2 }) },
  );
});

test("carrying on is refused, writing nothing, where it makes no sense: no such run, still going, came out whole, said nothing about it, only a rehearsal, or the rule means another flow by the name now", async () => {
  await withFlows(async (w) => {
    const ids = [1, 2, 3, 4].map((n) => idFor(n, "k1"));
    for (const n of [1, 2, 3, 4]) asks(w, n, [req("k1")]);
    await first(w);
    w.flows.probes.set(ids[0]!, running());
    w.flows.probes.set(ids[1]!, finished({ ok: 1 }));
    w.flows.probes.set(ids[2]!, stopped(null));
    w.flows.probes.set(ids[3]!, stopped());
    await advance(w, 10);
    assert.match(w.engine.resumeFlow("rc-test-nope", "owner").detail, /不是这个控制器起的/);
    assert.match(w.engine.resumeFlow(ids[0]!, "owner").detail, /还没结束/);
    assert.match(w.engine.resumeFlow(ids[1]!, "owner").detail, /已经有结果了/);
    assert.match(w.engine.resumeFlow(ids[2]!, "owner").detail, /没说过能从哪里接着跑/);
    assert.equal(kinds(w).filter((k) => k === "flow.resume").length, 0);
    // the rule means another flow by the name now: that is another request, and this one is not carried on
    writeFileSync(path.join(w.configDir, "rules", "flow.mjs"), RULE.replace('flow: "triage-flow"', 'flow: "replacement-flow"'));
    await look(w, 60);
    assert.match(w.engine.resumeFlow(ids[3]!, "owner").detail, /判断方法现在不起这个流程了/);
    assert.equal(kinds(w).filter((k) => k === "flow.resume").length, 0);
  });
  await withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")]);
    await first(w);
    w.flows.probes.set(id, stopped());
    await advance(w, 10);
    await w.restart("dry-run");
    assert.match(w.engine.resumeFlow(id, "owner").detail, /现在只演练/);
  });
});

test("a carrying on that never ran (the runtime refused it, nothing spent) is carried on again with the same word, from the run it was to carry on, and does not count for the day", () =>
  withFlows(
    async (w) => {
      const [r0, r1, r2] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1), idFor(1, "k1", "triage", 2)];
      asks(w, 1, [req("k1")]);
      await first(w);
      w.flows.probes.set(r0, stopped());
      await advance(w, 10);
      assert.equal(w.engine.resumeFlow(r0, "owner").ok, true);
      await advance(w, 10);
      w.flows.probes.set(r1, probeOf({ state: "refused", refused: "flow \"triage-resume\" cannot be loaded" }));
      await advance(w, 10);
      assert.equal(flowsOf(w)[r1]!.ended!.outcome, "refused");
      const shown = view(w, 1, r1);
      assert.deepEqual(shown.actions, ["resume", "retry", "mine", "fold"], "the same two ways, for a round that did not run");
      assert.deepEqual(shown.resume, { from: OFFER.from, spends: "nothing" });
      const again = w.engine.resumeFlow(r1, "owner");
      assert.equal(again.ok, true, again.detail);
      assert.deepEqual(flowsOf(w)[r2]!.resume, { from: r0, flow: "triage-resume", line: OFFER.from, spends: "nothing", by: "owner" }, "it carries on the run that stopped, not the round that never ran");
      await advance(w, 10);
      assert.deepEqual([w.flows.launcher.started[2]!.runId, w.flows.launcher.started[2]!.resumeOf], [r2, r0]);
    },
    { policy: POLICY({ perDay: 2 }) },
  ));

test("a run that was cut off is offered to be carried on too, by what it said while it ran", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")]);
    await first(w);
    w.flows.probes.set(id, probeOf({ state: "lost", costUsd: 0.2, resume: OFFER }));
    await advance(w, 10);
    assert.equal(flowsOf(w)[id]!.ended!.outcome, "lost");
    assert.deepEqual(flowsOf(w)[id]!.ended!.resume, OFFER);
    assert.deepEqual(view(w, 1, id).actions, ["resume", "retry", "mine", "fold"]);
    assert.equal(w.engine.resumeFlow(id, "owner").ok, true);
  }));

// ---- from the start ---------------------------------------------------------------------------------------

test("running a round that carried on again is from the start: the request's own flow with the rule's input now, not the carrying on again", () =>
  withFlows(
    async (w) => {
      const [r0, r1, r2] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1), idFor(1, "k1", "triage", 2)];
      asks(w, 1, [req("k1", { n: 1 })]);
      await first(w);
      w.flows.probes.set(r0, stopped());
      await advance(w, 10);
      assert.equal(w.engine.resumeFlow(r0, "owner").ok, true);
      await advance(w, 10);
      w.flows.probes.set(r1, stopped(OFFER, "又停了", 0.1));
      await advance(w, 10);
      const second = view(w, 1, r1);
      assert.deepEqual(second.actions, ["resume", "retry", "mine", "fold"]);
      assert.equal(retryLabel(second), "从头重跑（会再花钱，上次花了 $0.40）", "what starting over costs is what the request cost when it last ran from the start");
      asks(w, 1, [req("k1", { n: 2 })]);
      await advance(w, 10);
      const r = w.engine.retryFlow(r1, "owner");
      assert.deepEqual([r.ok, r.detail], [true, "记下了，这就从头重跑（第 3 轮）；上一轮花了 $0.10"]);
      assert.equal(flowsOf(w)[r2]!.resume, undefined);
      await advance(w, 10);
      const spec = w.flows.launcher.started[2]!;
      assert.deepEqual([spec.runId, spec.flow, spec.resumeOf], [r2, "triage-flow", undefined]);
      assert.deepEqual(JSON.parse(readFileSync(spec.inputFile, "utf8")), { n: 2 });
    },
    { policy: POLICY({}) },
  ));

test("a round that carries on is not told off for its input: the rule's input is not what it was made with", () =>
  withFlows(
    async (w) => {
      const [a, b] = [idFor(1, "k1"), idFor(2, "k1")];
      asks(w, 1, [req("k1", { n: 1 })]);
      asks(w, 2, [req("k1", { n: 1 })]);
      await first(w);
      w.flows.probes.set(a, stopped());
      w.flows.probes.set(b, running());
      await advance(w, 10);
      assert.equal(w.engine.resumeFlow(a, "owner").ok, true);
      asks(w, 1, [req("k1", { n: 2 })]);
      asks(w, 2, [req("k1", { n: 2 })]);
      await advance(w, 30);
      const flowMarks = (n: number) => w.engine.graph(`gcp-demo:${n}`)!.marks.filter((m) => m.kind === "flow");
      assert.equal(flowMarks(2).length, 1, "a run from the start that the rule now gives another input is said to be so");
      assert.match(flowMarks(2)[0]!.line, /起的时候给的输入，和判断方法现在给的不一样/);
      assert.equal(flowMarks(1).length, 0, "a round that carries on has no input of the rule's to differ from");
      assert.equal(view(w, 1, idFor(1, "k1", "triage", 1)).inputDrifted, undefined);
    },
    { policy: POLICY({}) },
  ));

// ---- a run started by hand with `orch.mjs resume` ---------------------------------------------------------

/** A run somebody started from the command line, as the reader sees it. */
const byHand = (w: { clock: { now: number } }, resumeOf: string, over: Partial<RunView> = {}): RunView =>
  runView("doing", { runId: "by-hand-1", stage: "review", flow: OFFER.flow, resumeOf, startedAt: new Date(w.clock.now - 60_000).toISOString(), link: { plugin: "orchestration-ui", screen: "runs", params: { run: "by-hand-1" } }, ...over });

test("a run started by hand to carry on a stopped run of the controller's own is taken into the record as the next round, and followed from there", async () => {
  let views: RunView[] = [];
  await withFlows(
    async (w) => {
      const [r0, hand] = [idFor(1, "k1"), "by-hand-1"];
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      w.flows.probes.set(r0, stopped());
      await advance(w, 10);
      assert.deepEqual(w.engine.graph("gcp-demo:1")!.runs.map((r) => r.own), [true]);
      views = [byHand(w, r0)];
      await first(w);
      const events = w.journal().filter((e) => e.type === "flow.resume" || (e.type === "flow.intent" && (e.rec as { round: number }).round === 1) || (e.type === "flow.spawned" && e.runId === hand));
      assert.deepEqual(events.map((e) => e.type), ["flow.resume", "flow.intent", "flow.spawned"]);
      assert.deepEqual([events[0]!.runId, events[0]!.round, events[0]!.from, events[0]!.flow, events[0]!.by], [hand, 1, r0, OFFER.flow, "cli"]);
      const rec = flowsOf(w)[hand]!;
      assert.deepEqual([rec.round, rec.caseId, rec.name, rec.flow, rec.key], [1, "gcp-demo:1", "triage", "triage-flow", "k1"], "the same request");
      assert.deepEqual(rec.resume, { from: r0, flow: OFFER.flow, line: OFFER.from, spends: "nothing", by: "cli" });
      assert.equal(w.flows.launcher.started.length, 1, "nothing is started for a run that is already going");
      assert.equal(headline(w, 1), `r triage:k1=starting|from:${r0}|ran:triage-resume`);
      const shown = view(w, 1, hand);
      assert.deepEqual([shown.own, shown.carriedOn?.by], [true, "cli"]);
      const lines = w.engine.graph("gcp-demo:1")!.history.filter((h) => h.kind === "run");
      assert.ok(lines.some((l) => l.line === "接着跑了流程「triage-flow」（第 2 次）" && /从命令行接着跑的，已记进来/.test(l.detail ?? "") && (l.detail ?? "").includes(OFFER.from)), JSON.stringify(lines));
      // once, however often it is looked at
      const before = w.journal().length;
      await advance(w, 30);
      assert.equal(w.journal().filter((e) => e.type === "flow.resume").length, 1);
      assert.ok(w.journal().length >= before);
      // it comes out, and the item stands as it is: the stopped run is no longer what it is
      w.flows.probes.set(hand, finished({ ok: true }, {}, 0));
      views = [byHand(w, r0, { situation: "done", endedAt: new Date(w.clock.now).toISOString() })];
      await advance(w, 10);
      assert.match(headline(w, 1)!, /triage:k1=done\{"ok":true\}\|from:.*\|ran:triage-resume/);
      assert.equal(w.engine.graph("gcp-demo:1")!.runs.filter((r) => (r.actions?.length ?? 0) > 0).length, 0);
      assert.equal(w.engine.status().flows.length, 2, "both rounds are the controller's own and in its list");
    },
    { rule: READS, policy: POLICY({}), runs: () => views },
  );
});

test("a run that carries on another is taken in only for the newest round of a request of the controller's own that came to no result, in the same item, in a live instance", async () => {
  let views: Record<string, RunView[]> = {};
  await withFlows(
    async (w) => {
      const [a, b, c, d] = [1, 2, 3, 4].map((n) => idFor(n, "k1"));
      for (const n of [1, 2, 3, 4]) asks(w, n, [req("k1")]);
      await first(w);
      for (const id of [a, b, d]) w.flows.probes.set(id!, stopped());
      w.flows.probes.set(c!, finished({ ok: 1 })); // came to a result
      await advance(w, 10);
      assert.equal(w.engine.resumeFlow(d!, "owner").ok, true); // d is no longer the newest round of its request: its next round is
      await advance(w, 10);
      views = {
        "gcp-demo:1": [byHand(w, "someone-elses-run", { runId: "by-hand-a" }), byHand(w, a!, { runId: "by-hand-b" })],
        "gcp-demo:2": [byHand(w, a!, { runId: "by-hand-c" })], // names a stopped run of another item
        "gcp-demo:3": [byHand(w, c!, { runId: "by-hand-d" })], // names a run that came to a result
        "gcp-demo:4": [byHand(w, d!, { runId: "by-hand-e" })], // names an earlier round: the newest is the one the button made, still going
      };
      await first(w);
      const taken = w.journal().filter((e) => e.type === "flow.resume" && e.by === "cli").map((e) => e.runId);
      assert.deepEqual(taken, ["by-hand-b"], "only the one that names the stopped run, for the item it is for");
      for (const id of ["by-hand-a", "by-hand-c", "by-hand-d", "by-hand-e"]) assert.equal(flowsOf(w)[id], undefined, id);
      // not in a rehearsal: the run that names item 2's own stopped run is only listed there, and is taken in once the instance is live
      views = { "gcp-demo:2": [byHand(w, b!, { runId: "by-hand-f" })] };
      await w.restart("dry-run");
      await first(w);
      assert.equal(flowsOf(w)["by-hand-f"], undefined);
      await w.restart("live");
      await first(w);
      assert.equal(flowsOf(w)["by-hand-f"]?.resume?.by, "cli");
    },
    { policy: POLICY({}), runs: (caseId) => views[caseId] ?? [] },
  );
});

test("a run started by hand is taken in even after the person set the stopped run aside: the new round is a new thing, and is not set aside", async () => {
  let views: RunView[] = [];
  await withFlows(
    async (w) => {
      const r0 = idFor(1, "k1");
      asks(w, 1, [req("k1")]);
      await first(w);
      w.flows.probes.set(r0, stopped());
      await advance(w, 10);
      assert.equal(w.engine.dismissFlow(r0, "mine", "owner").ok, true);
      views = [byHand(w, r0)];
      await first(w);
      const taken = flowsOf(w)["by-hand-1"]!;
      assert.deepEqual([taken.round, taken.dismissed, taken.resume?.by], [1, undefined, "cli"]);
      assert.equal(flowsOf(w)[r0]!.dismissed?.how, "mine", "what the person said about the earlier round stands");
    },
    { policy: POLICY({}), runs: () => views },
  );
});

test("a button and a run by hand that raced for the same stop: the round that was refused is the person's, and the run by hand is the round after it", async () => {
  let views: RunView[] = [];
  await withFlows(
    async (w) => {
      const [r0, r1] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1)];
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      w.flows.probes.set(r0, stopped());
      await advance(w, 10);
      assert.equal(w.engine.resumeFlow(r0, "owner").ok, true);
      await advance(w, 10);
      // the runtime took the stop for the run by hand first, and refused the button's round
      views = [byHand(w, r0)];
      w.flows.probes.set(r1, probeOf({ state: "refused", refused: `run ${r0} was already carried on, as run by-hand-1: it is running. A stop is carried on once` }));
      await advance(w, 10);
      assert.equal(flowsOf(w)[r1]!.ended!.outcome, "refused");
      const taken = flowsOf(w)["by-hand-1"]!;
      assert.deepEqual([taken.round, taken.resume!.from, taken.resume!.by, taken.resume!.line], [2, r0, "cli", OFFER.from]);
      assert.equal(w.flows.launcher.started.length, 2, "the round that was refused was started, the run by hand was not");
      assert.match(headline(w, 1)!, /triage:k1=starting\|from:/);
      assert.equal(view(w, 1, r1).actions?.length ?? 0, 0, "the refused round is history now");
    },
    { rule: READS, policy: POLICY({}), runs: () => views },
  );
});

// ---- the page, the button and the rule say the same -------------------------------------------------------

test("a carrying on that never ran is carried on again with the word as it stands now, and the rule is told the same as the page", () =>
  withFlows(
    async (w) => {
      const [r0, r1, r2] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1), idFor(1, "k1", "triage", 2)];
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      const first0 = { ...OFFER, print: "1111111111111111" };
      w.flows.probes.set(r0, stopped(first0));
      await advance(w, 10);
      assert.equal(w.engine.resumeFlow(r0, "owner").ok, true);
      await advance(w, 10);
      assert.equal(w.flows.launcher.started[1]!.expect, "1111111111111111", "what the person was shown goes to the runtime");
      w.flows.probes.set(r1, probeOf({ state: "refused", refused: "the resume point of run x is not the one that was shown" }));
      await advance(w, 10);
      // the round that never ran is offered again, and the rule reads what the page shows
      const shown = view(w, 1, r1);
      assert.deepEqual(shown.resume, { from: OFFER.from, spends: "nothing" });
      assert.deepEqual(w.engine.flowResult("gcp-demo:1", "triage", "k1")!.resumable, shown.resume, "the rule and the page agree");
      assert.match(headline(w, 1)!, /triage:k1=refused\|can:/);
      // the run it was to carry on says something else now (it went on after it was read as lost): the page shows that, and the next try is for that
      w.flows.probes.set(r0, stopped({ ...first0, from: "改过了：从第三步接着", print: "2222222222222222" }));
      await advance(w, 10);
      assert.deepEqual(view(w, 1, r1).resume, { from: "改过了：从第三步接着", spends: "nothing" });
      assert.equal(w.engine.resumeFlow(r1, "owner").ok, true);
      assert.deepEqual([flowsOf(w)[r2]!.resume!.line, flowsOf(w)[r2]!.resume!.print, flowsOf(w)[r2]!.resume!.from], ["改过了：从第三步接着", "2222222222222222", r0]);
      await advance(w, 10);
      assert.equal(w.flows.launcher.started[2]!.expect, "2222222222222222");
      // and a point that cannot be read any more leaves the word the round was made with
      w.flows.probes.set(r2, probeOf({ state: "refused", refused: "gone" }));
      w.flows.probes.delete(r0);
      await advance(w, 10);
      assert.deepEqual(view(w, 1, r2).resume, { from: "改过了：从第三步接着", spends: "nothing" });
    },
    { rule: READS, policy: POLICY({}) },
  ));

test("the buttons' words do not take one round's cost for another's: starting over says what it cost to start over, and the carrying on says what the round it carries on cost", async () => {
  await withFlows(
    async (w) => {
      const [r0, r1] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1)];
      asks(w, 1, [req("k1")]);
      await first(w);
      w.flows.probes.set(r0, stopped(OFFER, "第一次停了", 1.14));
      await advance(w, 10);
      assert.equal(w.engine.resumeFlow(r0, "owner").ok, true);
      // the process cannot be started three times: the carrying on never ran, and spent nothing
      w.flows.failStarts.count = 3;
      await advance(w, 20);
      assert.equal(flowsOf(w)[r1]!.ended!.outcome, "not-started");
      const never = view(w, 1, r1);
      assert.equal(never.situation, "notstarted");
      assert.equal(retryLabel(never), "从头重跑（会再花钱，上次花了 $1.14）", "what starting over costs is known, whatever the carrying on that never started spent");
    },
    { policy: POLICY({}) },
  );
  await withFlows(
    async (w) => {
      const [r0, r1] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1)];
      asks(w, 1, [req("k1")]);
      await first(w);
      const maybe = { ...OFFER, spends: "maybe" as const };
      w.flows.probes.set(r0, stopped(maybe, "第一次停了", 1.14));
      await advance(w, 10);
      assert.equal(w.engine.resumeFlow(r0, "owner").ok, true);
      await advance(w, 10);
      w.flows.probes.set(r1, stopped(maybe, "又停了", 0.1));
      await advance(w, 10);
      const second = view(w, 1, r1);
      assert.match(resumeNote(second), /可能会调模型（上一轮花了 \$0\.10）$/, "the round it carries on is the one that just stopped");
      assert.match(retryLabel(second), /上次花了 \$1\.14/, "starting over is what the request cost when it last ran from the start");
    },
    { policy: POLICY({}) },
  );
});

// ---- what ran is what was shown ---------------------------------------------------------------------------

test("a round that carries on is told as what really ran: the rule reads the flow of the run's own start, and a run that was not started from the point the button showed is said so", async () => {
  let views: RunView[] = [];
  await withFlows(
    async (w) => {
      const [r0, r1] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1)];
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      const shown = { ...OFFER, print: "1111111111111111" };
      w.flows.probes.set(r0, stopped(shown));
      await advance(w, 10);
      assert.equal(w.engine.resumeFlow(r0, "owner").ok, true);
      await advance(w, 10);
      assert.match(headline(w, 1)!, /\|ran:triage-resume$/, "until it is read, the flow it was made to run");
      // it ran another flow than the one shown, from another point (the file was changed after the page drew the button, and the runtime did not stop it)
      const actual = runView("done", { runId: r1, stage: "review", flow: "triage-resume-b", resumeOf: r0, resumePrint: "9999999999999999" });
      views = [actual];
      w.flows.probes.set(r1, probeOf({ state: "ended", view: actual, costUsd: 0, end: { at: 0, outcome: "done", summary: null, stop: null, error: null, value: { actual: "b" }, valueDropped: false, totalUsd: 0 } }));
      await advance(w, 10);
      const result = w.engine.flowResult("gcp-demo:1", "triage", "k1")!;
      assert.deepEqual([result.ran, result.resumedFrom, result.value], ["triage-resume-b", r0, { actual: "b" }]);
      assert.match(headline(w, 1)!, /\|ran:triage-resume-b$/);
      const page = view(w, 1, r1);
      assert.deepEqual([page.ran, page.resumeDiffers, page.flow], ["triage-resume-b", true, "triage-flow"]);
      const marks = w.engine.graph("gcp-demo:1")!.marks.filter((m) => m.kind === "flow");
      assert.equal(marks.length, 1);
      assert.match(marks[0]!.line, /接着跑起来的流程和输入，和按钮上写的不一样（实际跑的是「triage-resume-b」）；以实际跑的为准，结果照样记/);
      // one that was started from the point that was shown is not told off
      views = [{ ...actual, flow: "triage-resume", resumePrint: "1111111111111111" }];
      await advance(w, 10);
      assert.equal(view(w, 1, r1).resumeDiffers, undefined);
      assert.equal(w.engine.graph("gcp-demo:1")!.marks.filter((m) => m.kind === "flow").length, 0);
    },
    { rule: READS, policy: POLICY({}), runs: () => views },
  );
});

// ---- what a person is told --------------------------------------------------------------------------------

const END = (over: Partial<FlowEnd> = {}): FlowEnd => ({ at: "2026-10-13T10:00:00+08:00", outcome: "stopped", summary: null, costUsd: 0, value: { why: "校验没过：缺一个必填字段" }, valueDropped: false, why: "校验没过：缺一个必填字段", ...over });

test("the message for a run that did not finish points at the button, in the flow's own words, once, and only where there is a button", async () => {
  const rec = { label: "初查", caseId: "gcp-demo:1" };
  assert.equal(endedMessage(rec, END()).text, "#1 初查没跑完：校验没过：缺一个必填字段。详情在「事项追踪」里。");
  assert.equal(endedMessage(rec, END({ resume: OFFER })).text, "#1 初查没跑完：校验没过：缺一个必填字段。处理好以后在事项页点「接着跑」（第一步已完成：从第二步接着，不重做第一步）。详情在「事项追踪」里。");
  assert.equal(endedMessage(rec, END({ outcome: "failed", value: null, why: "出错了", resume: OFFER })).text, "#1 初查没跑完：流程失败了（出错了），要自己看。处理好以后在事项页点「接着跑」（第一步已完成：从第二步接着，不重做第一步）。");
  // the rule takes its own failure: no button, so none is spoken of
  assert.doesNotMatch(endedMessage({ ...rec, selfRetry: true }, END({ resume: OFFER })).text, /接着跑/);
  // a run that came out whole has nothing to carry on
  assert.doesNotMatch(endedMessage(rec, END({ value: { found: 1 }, summary: "找到 1 处", resume: OFFER })).text, /接着跑/);
  // what the flow wrote is not drawn as anything
  assert.match(endedMessage(rec, END({ resume: { ...OFFER, from: "看[这里](http://x) *不重编*" } })).text, /（看［这里］\(http:\/\/x\) ＊不重编＊）/);
});

test("the person who is told when a run ends hears about the button in the message", () =>
  withFlows(
    async (w) => {
      asks(w, 1, [req("k1")]);
      await first(w);
      w.flows.probes.set(idFor(1, "k1"), stopped());
      await advance(w, 10);
      assert.equal(w.deliveries.length, 1);
      assert.match(w.deliveries[0]!.text, /处理好以后在事项页点「接着跑」（第一步已完成：从第二步接着，不重做第一步）。详情在「事项追踪」里。$/);
    },
    { persons: OWNER(), policy: POLICY({}) },
  ));

// ---- the page's own words -----------------------------------------------------------------------------

test("the page says what the rounds of a request were: carried on or from the start, and what they cost together", () =>
  withFlows(
    async (w) => {
      const [r0, r1] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1)];
      asks(w, 1, [req("k1")]);
      await first(w);
      w.flows.probes.set(r0, stopped());
      await advance(w, 10);
      assert.equal(view(w, 1, r0).ledger, undefined, "one round has no sum to give");
      assert.equal(w.engine.resumeFlow(r0, "owner").ok, true);
      await advance(w, 10);
      w.flows.probes.set(r1, stopped(OFFER, "又停了", 0.1));
      await advance(w, 10);
      const latest = view(w, 1, r1);
      assert.deepEqual(latest.ledger, { rounds: 2, costUsd: 0.5 });
      assert.equal(ledgerText(latest.ledger), "这件事已经跑了 2 次，一共花了 $0.50。");
      assert.equal(ledgerText(undefined), "");
      assert.equal(view(w, 1, r0).ledger, undefined, "the sum is the newest round's to show");
      const lines = w.engine.graph("gcp-demo:1")!.history.filter((h) => h.kind === "run").map((h) => h.line);
      assert.deepEqual(lines, ["起了流程「triage-flow」", "流程「triage-flow」没查成", "接着跑了流程「triage-flow」（第 2 次）", "流程「triage-flow」没查成"]);
    },
    { policy: POLICY({}) },
  ));

// ---- how the process is started ---------------------------------------------------------------------------

test("the launcher starts `run <flow> --input` for a run from the start and `resume <run>` for one that carries on", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-resume-launch-"));
  try {
    const script = path.join(dir, "echo-args.mjs");
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const launcher = createLauncher({ command: [process.execPath, script] });
    const spec = (over: Partial<LaunchSpec>): LaunchSpec => ({ runId: "rc-x-1", flow: "triage-flow", timeout: "30m", inputFile: path.join(dir, "in.json"), affairFile: path.join(dir, "aff.json"), outFile: path.join(dir, "out.txt"), logDir: dir, ...over });
    const printed = async (s: LaunchSpec): Promise<string[]> => {
      await launcher.start(s);
      for (let i = 0; i < 100; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          const text = readFileSync(s.outFile, "utf8");
          if (text.trim().endsWith("]")) return JSON.parse(text) as string[];
        } catch {
          // not there yet
        }
      }
      throw new Error("the process printed nothing");
    };
    assert.deepEqual(await printed(spec({})), ["run", "triage-flow", "--run-id", "rc-x-1", "--affair", `@${path.join(dir, "aff.json")}`, "--input", `@${path.join(dir, "in.json")}`, "--timeout", "30m"]);
    rmSync(path.join(dir, "out.txt"));
    assert.deepEqual(await printed(spec({ resumeOf: "rc-x-0", timeout: null })), ["resume", "rc-x-0", "--run-id", "rc-x-1", "--affair", `@${path.join(dir, "aff.json")}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("what a rule is told of a run: where it carried on from, the flow that ran, and whether it can be carried on", () => {
  const rec = (over: Partial<FlowRec> = {}): FlowRec => ({ runId: "r1", caseId: "gcp-demo:1", name: "triage", flow: "triage-flow", key: "k1", round: 0, stage: null, label: "初查", affairLabel: "x", owner: null, notify: false, maxUsd: 1, timeout: null, input: null, inputHash: "", rules: "", intentAt: "2026-10-13T10:00:00+08:00", ...over });
  const ended = (over: Partial<FlowEnd> = {}) => END({ resume: OFFER, ...over });
  assert.deepEqual(
    (({ resumedFrom, ran, resumable }) => ({ resumedFrom, ran, resumable }))(resultOf(rec({ ended: ended() }), null)),
    { resumedFrom: null, ran: "triage-flow", resumable: { from: OFFER.from, spends: "nothing" } },
  );
  assert.deepEqual(
    (({ resumedFrom, ran, resumable }) => ({ resumedFrom, ran, resumable }))(resultOf(rec({ round: 1, resume: { from: "r0", flow: "triage-resume", line: "x", spends: "nothing", by: "owner" }, ended: ended({ resume: undefined, outcome: "done", value: { a: 1 }, why: null }) }), null)),
    { resumedFrom: "r0", ran: "triage-resume", resumable: null },
  );
  assert.equal(resultOf(rec({ ended: ended({ value: { found: 1 }, why: null }) }), null).resumable, null, "a stop with no `why` is a finished one");
  assert.equal(resultOf(rec({ ended: ended(), dismissed: { how: "mine", by: "owner", at: "x" } }), null).resumable, null, "set aside by the person");
  assert.equal(resultOf(rec({ ended: ended(), selfRetry: true }), null).resumable, null, "the rule's own");
  assert.equal(resultOf(rec(), "running").resumable, null);
});
