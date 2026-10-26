import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SUSPECT_MS } from "../server/flows";
import { probeOf, type World } from "./helpers";
import { set } from "./item-flow";
import { advance, asks, finished, first, flowsOf, headline, idFor, kinds, look, OWNER, req, running, withFlows } from "./flows-kit";

// The engine starts flows for items (batch 7b): a rule asks, the intent is written, the process is started, the runtime's
// files are read, and a run that comes to nothing is told. Everything here runs against a launcher that only records and
// a probe the test sets by run id -- no process is started, nothing is spent (the real runtime is in flows-orch.test.ts).

// ---- asking -----------------------------------------------------------------------------------------------

test("a rule asks for a run: the intent is in the journal before the process is started, and the process gets the files it needs", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    const atStart: Array<{ runId: string; intent: boolean; spawned: boolean; types: string[] }> = [];
    w.flows.onStart = (spec) => atStart.push({ runId: spec.runId, intent: !!flowsOf(w)[spec.runId], spawned: !!flowsOf(w)[spec.runId]?.spawnedAt, types: kinds(w) });
    asks(w, 1, [req("k1", { n: 1, list: ["a", "b"] })], { Watch: "triage:k1" });
    await first(w);
    assert.deepEqual(atStart, [{ runId: id, intent: true, spawned: false, types: ["flow.intent"] }], "the intent was on disk when the process was asked for");
    assert.deepEqual(kinds(w), ["flow.intent", "flow.spawned"]);
    const rec = flowsOf(w)[id]!;
    assert.deepEqual([rec.caseId, rec.name, rec.flow, rec.key, rec.round, rec.stage, rec.label, rec.timeout, rec.maxUsd, rec.notify, rec.owner], ["gcp-demo:1", "triage", "triage-flow", "k1", 0, "review", "初查", "30m", 1, true, "owner"]);
    assert.deepEqual(rec.input, { n: 1, list: ["a", "b"] });
    assert.equal(rec.spawnTries, 1);
    // what the process was given: the runtime's own run id and files, the input as the rule gave it, the affair
    const spec = w.flows.launcher.started[0]!;
    assert.deepEqual([spec.runId, spec.flow, spec.timeout], [id, "triage-flow", "30m"]);
    assert.deepEqual(JSON.parse(readFileSync(spec.inputFile, "utf8")), { n: 1, list: ["a", "b"] });
    const affair = JSON.parse(readFileSync(spec.affairFile, "utf8")) as { label: string; url?: string; link: { plugin: string; screen: string; params: Record<string, string> } };
    assert.match(affair.label, /^#1 · 评审 · 初查$/);
    assert.deepEqual([affair.link.plugin, affair.link.screen, affair.link.params], ["reconcile", "inbox", { case: "gcp-demo:1", stage: "review" }], "the stage it was asked in is written without anyone setting it");
    assert.ok(w.engine.status().plan.some((p) => p.kind === "flow" && p.summary.includes("起了流程「初查」")), JSON.stringify(w.engine.status().plan));
    assert.equal(headline(w, 1), "r triage:k1=-", "the rule judged before the run was asked for: it reads nothing yet");
    await first(w);
    assert.equal(headline(w, 1), "r triage:k1=starting", "and now reads where it stands");
  }));

test("asked for once: the same key is not run again however the run came out, a different input is only said, and a rule that stops asking does not stop the run", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1", { n: 1 })], { Watch: "triage:k1" });
    await first(w);
    w.flows.probes.set(id, running());
    await advance(w, 30);
    assert.equal(w.flows.launcher.started.length, 1, "one start however many rounds");
    // the same key with another input: not run again; the page says the input is not the one it was run with
    asks(w, 1, [req("k1", { n: 2 })], { Watch: "triage:k1" });
    await advance(w, 30);
    assert.equal(w.flows.launcher.started.length, 1);
    const views = w.engine.graph("gcp-demo:1")!.runs;
    assert.equal(views.length, 1);
    assert.equal(views[0]!.inputDrifted, true, "said on the page");
    // given the input it was run with again, the page says nothing of it
    asks(w, 1, [req("k1", { n: 1 })], { Watch: "triage:k1" });
    await advance(w, 30);
    assert.ok(!w.engine.graph("gcp-demo:1")!.runs[0]!.inputDrifted);
    // the rule no longer asks: the run goes on, its result is still taken
    set(w, 1, { Runs: "", Watch: "triage:k1" });
    w.flows.probes.set(id, finished({ found: 2 }));
    await advance(w, 30);
    assert.equal(flowsOf(w)[id]!.ended?.outcome, "done");
    assert.equal(headline(w, 1), 'r triage:k1=done{"found":2}');
    // asking for it again later, with the run over: still not run again
    asks(w, 1, [req("k1", { n: 1 })], { Watch: "triage:k1" });
    await advance(w, 30);
    assert.equal(w.flows.launcher.started.length, 1);
    assert.equal(Object.keys(flowsOf(w)).length, 1);
    // another key is another run
    asks(w, 1, [req("k1", { n: 1 }), req("k2", { n: 1 })], { Watch: "triage:k1,triage:k2" });
    await advance(w, 30);
    assert.deepEqual(w.flows.launcher.started.map((s) => s.runId), [id, idFor(1, "k2")]);
  }));

test("two items asking with the same key are two runs; one item asking twice for the same key in one judgment is an error, not two runs", () =>
  withFlows(async (w) => {
    asks(w, 1, [req("k1")]);
    asks(w, 2, [req("k1")]);
    asks(w, 3, [req("k1"), req("k1")]);
    await first(w);
    assert.deepEqual(w.flows.launcher.started.map((s) => s.runId).sort(), [idFor(1, "k1"), idFor(2, "k1")].sort());
    assert.match(w.store.state.assessments["gcp-demo:3"]!.error ?? "", /run k1 asked twice/);
    assert.equal(Object.values(flowsOf(w)).filter((r) => r.caseId === "gcp-demo:3").length, 0, "a failed judgment starts nothing");
  }));

// ---- the result -------------------------------------------------------------------------------------------

test("what a run came to is what the rule reads: its value, summary and cost; the input is dropped, and the person is told once", () =>
  withFlows(
    async (w) => {
      const id = idFor(1, "k1");
      asks(w, 1, [req("k1", { n: 1 })], { Watch: "triage:k1" });
      await first(w);
      w.flows.probes.set(id, running());
      await advance(w, 10);
      assert.equal(headline(w, 1), "r triage:k1=running");
      assert.equal(w.deliveries.length, 0);
      w.flows.probes.set(id, finished({ found: 2, items: ["x"] }));
      await advance(w, 10);
      const rec = flowsOf(w)[id]!;
      assert.deepEqual([rec.ended!.outcome, rec.ended!.summary, rec.ended!.costUsd, rec.ended!.value], ["done", "找到 2 处", 0.5, { found: 2, items: ["x"] }]);
      assert.equal(rec.input, null, "a run that is done is not run again, so its input is not kept");
      assert.equal(headline(w, 1), 'r triage:k1=done{"found":2,"items":["x"]}');
      // one message, for the person, in the words of the label and the flow's own summary
      assert.equal(w.deliveries.length, 1);
      assert.deepEqual([w.deliveries[0]!.channel, w.deliveries[0]!.to, w.deliveries[0]!.title], ["chat", "u1", "初查好了"]);
      assert.match(w.deliveries[0]!.text, /#1 初查好了：找到 2 处/);
      assert.equal(w.deliveries[0]!.idempotencyKey, `test:flow-notify:${id}:chat:u1`);
      await advance(w, 60);
      assert.equal(w.deliveries.length, 1, "not again on the next rounds");
      await w.restart();
      await advance(w, 30);
      assert.equal(w.deliveries.length, 1, "nor after a restart");
      assert.equal(w.flows.launcher.started.length, 1);
    },
    { persons: OWNER() },
  ));

test("a run that was stopped by its flow carries its value like a finished one; a value too large is not handed on", () =>
  withFlows(async (w) => {
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    asks(w, 2, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    w.flows.probes.set(idFor(1, "k1"), finished({ analysis: null, why: "取不到数据", samples: 0 }, { outcome: "stopped", stop: "取不到数据", summary: null }));
    w.flows.probes.set(idFor(2, "k1"), finished(null, { valueDropped: true }));
    await advance(w, 10);
    assert.equal(headline(w, 1), 'r triage:k1=stopped{"analysis":null,"why":"取不到数据","samples":0}');
    const big = w.store.state.assessments["gcp-demo:2"]!;
    assert.equal(big.headline, "r triage:k1=done", "done, with no value");
    assert.equal(flowsOf(w)[idFor(2, "k1")]!.ended!.valueDropped, true);
  }));

test("a run that failed, timed out or was refused is told as not coming to a result, and the rule reads no value of it", () =>
  withFlows(
    async (w) => {
      for (const n of [1, 2, 3]) asks(w, n, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      w.flows.probes.set(idFor(1, "k1"), finished({ leak: 1 }, { outcome: "failed", error: { name: "OutputMismatch", message: "m", headline: "回答不合格式", plain: "x", raw: "x" } as never }));
      w.flows.probes.set(idFor(2, "k1"), finished(null, { outcome: "timeout" }));
      w.flows.probes.set(idFor(3, "k1"), probeOf({ state: "refused", refused: "run id taken" }));
      await advance(w, 10);
      assert.equal(headline(w, 1), "r triage:k1=failed");
      assert.equal(headline(w, 2), "r triage:k1=timeout");
      assert.equal(headline(w, 3), "r triage:k1=refused");
      assert.match(flowsOf(w)[idFor(1, "k1")]!.ended!.why!, /OutputMismatch：回答不合格式/);
      assert.match(w.deliveries.map((d) => d.text).join("\n"), /#1 初查没跑完：流程失败了/);
      assert.equal(w.deliveries.length, 3, "a message for each");
      assert.ok(w.deliveries.every((d) => d.status === "failed"));
    },
    { persons: OWNER() },
  ));

// ---- restarts ---------------------------------------------------------------------------------------------

test("the process dies after the intent was written and before the process was started: the next one starts it, under the same id, once", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1", { n: 1 })], { Watch: "triage:k1" });
    // what the process that died wrote: the intent, and nothing after it
    w.store.append([
      {
        type: "flow.intent",
        rec: { runId: id, caseId: "gcp-demo:1", name: "triage", flow: "triage-flow", key: "k1", round: 0, stage: "review", label: "初查", affairLabel: "#1 · 评审 · 初查", owner: "owner", notify: true, maxUsd: 1, timeout: "30m", input: { n: 1 }, inputHash: "x", rules: "old", intentAt: new Date(w.clock.now).toISOString() },
      },
    ]);
    await w.crash();
    assert.equal(flowsOf(w)[id]!.spawnedAt, undefined, "an intent with no start");
    await first(w);
    assert.deepEqual(w.flows.launcher.started.map((s) => s.runId), [id], "started once, under the id the intent has");
    assert.ok(flowsOf(w)[id]!.spawnedAt);
    await advance(w, 30);
    assert.equal(w.flows.launcher.started.length, 1);
    assert.deepEqual(Object.keys(flowsOf(w)), [id], "the rule asking for it is the same intent, not another");
    assert.deepEqual(kinds(w), ["flow.intent", "flow.spawned"]);
  }));

test("a start that raised before the process was recorded is counted, and the next round starts it again under the same id", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")]);
    w.flows.failStarts = { count: 1, error: new Error("could not spawn") };
    await first(w);
    assert.deepEqual([flowsOf(w)[id]!.spawnTries, flowsOf(w)[id]!.spawnedAt], [1, undefined]);
    await advance(w, 5);
    assert.deepEqual(w.flows.launcher.started.map((s) => s.runId), [id]);
    assert.equal(flowsOf(w)[id]!.spawnTries, 2);
    assert.ok(flowsOf(w)[id]!.spawnedAt);
  }));

test("a start recorded and the process still going: after a restart it is neither started again nor lost", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    w.flows.probes.set(id, running());
    await advance(w, 10);
    for (const how of ["restart", "crash"] as const) {
      await w[how]();
      await advance(w, 15);
      assert.equal(w.flows.launcher.started.length, 1, how);
      assert.equal(headline(w, 1), "r triage:k1=running", how);
      assert.equal(flowsOf(w)[id]!.ended, undefined, how);
    }
  }));

test("a run that ended while the controller was away is found ended when it is back, once", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    w.flows.probes.set(id, running());
    await advance(w, 5);
    w.store.abandon();
    w.flows.probes.set(id, finished({ found: 1 }));
    w.clock.now += 3 * 3_600_000;
    await w.crash();
    await advance(w, 5);
    assert.equal(flowsOf(w)[id]!.ended!.outcome, "done");
    assert.equal(headline(w, 1), 'r triage:k1=done{"found":1}');
    assert.equal(kinds(w).filter((k) => k === "flow.ended").length, 1);
    assert.equal(w.flows.launcher.started.length, 1);
  }));

test("started and nothing ever came of it: started again under the same id when the runtime says that is safe, twice, then it is told as not started", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    assert.equal(w.flows.launcher.started.length, 1);
    // a start a moment ago: the runtime has not had time; the default probe says absent and not yet safe
    await advance(w, 10);
    assert.equal(w.flows.launcher.started.length, 1, "not safe yet: waits");
    assert.equal(headline(w, 1), "r triage:k1=starting");
    w.flows.probes.set(id, probeOf({ state: "absent", safeToRestart: true }));
    await advance(w, 5);
    assert.deepEqual(w.flows.launcher.started.map((s) => s.runId), [id, id], "a second start under the same id");
    assert.equal(flowsOf(w)[id]!.spawnTries, 2);
    await advance(w, 5);
    assert.deepEqual(w.flows.launcher.started.map((s) => s.runId), [id, id, id], "and a third");
    await advance(w, 5);
    assert.equal(w.flows.launcher.started.length, 3, "no fourth");
    const ended = flowsOf(w)[id]!.ended!;
    assert.deepEqual([ended.outcome, ended.costUsd], ["not-started", 0]);
    assert.match(ended.why!, /起了 3 次，运行时一直没有出现/);
    assert.equal(headline(w, 1), "r triage:k1=not-started");
    // it comes to the page as one that did not start, for a person to look at
    const v = w.engine.graph("gcp-demo:1")!;
    assert.equal(v.runs[0]!.situation, "notstarted");
    assert.match(v.hero.kicker, /流程没起来/);
    assert.match(v.hero.line, /没起来：起了 3 次/);
    assert.match(v.hero.sub, /没花钱/);
    assert.deepEqual(v.runs[0]!.actions, ["retry", "mine", "fold"]);
  }));

test("a start that fails outright (the program cannot run) is tried three times, each counted, then told as not started", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    w.flows.failStarts = { count: 9, error: new Error("spawn node ENOENT") };
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    assert.equal(flowsOf(w)[id]!.spawnTries, 1);
    assert.equal(flowsOf(w)[id]!.spawnError, "spawn node ENOENT");
    assert.ok(w.engine.status().problems.some((p) => p.includes("起不了流程「初查」：spawn node ENOENT")), JSON.stringify(w.engine.status().problems));
    await advance(w, 10);
    const ended = flowsOf(w)[id]!.ended!;
    assert.equal(ended.outcome, "not-started");
    assert.match(ended.why!, /起不了进程（试了 3 次）：spawn node ENOENT/);
    assert.equal(w.flows.launcher.started.length, 0);
    assert.equal(flowsOf(w)[id]!.spawnedAt, undefined);
  }));

test("a state that may be a machine asleep is looked at again before it is taken for a death: not started, or lost", () =>
  withFlows(async (w) => {
    const [a, b] = [idFor(1, "k1"), idFor(2, "k1")];
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    asks(w, 2, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    w.flows.probes.set(a, probeOf({ state: "dead-before-start" }));
    w.flows.probes.set(b, running({ costUsd: 0.4 }));
    await look(w, 10);
    w.flows.probes.set(b, probeOf({ state: "lost", costUsd: 0.4 }));
    await look(w, 10);
    assert.equal(flowsOf(w)[a]!.ended, undefined, "seen once: not yet");
    assert.equal(flowsOf(w)[b]!.ended, undefined);
    const doubtful = w.engine.graph("gcp-demo:2")!.runs[0]!;
    assert.equal(doubtful.situation, "slow", "said as quiet, not as lost");
    assert.equal(doubtful.maybeAsleep, true);
    assert.match(w.engine.graph("gcp-demo:2")!.hero.line, /可能是电脑睡了一会儿/);
    // the machine was asleep: it is running again at the next look
    w.flows.probes.set(b, running({ costUsd: 0.4 }));
    await look(w, 10);
    assert.equal(w.engine.graph("gcp-demo:2")!.runs[0]!.maybeAsleep, undefined, "the doubt is gone");
    assert.equal(flowsOf(w)[a]!.ended, undefined, "twenty seconds");
    // and gone for good: seen again after the time
    w.flows.probes.set(b, probeOf({ state: "lost", costUsd: 0.4 }));
    await look(w, 10);
    assert.deepEqual([flowsOf(w)[a]!.ended!.outcome, flowsOf(w)[a]!.ended!.costUsd], ["not-started", 0], "thirty seconds after it was first seen");
    assert.equal(flowsOf(w)[b]!.ended, undefined, "its doubt began again");
    await look(w, SUSPECT_MS / 1000);
    assert.deepEqual([flowsOf(w)[b]!.ended!.outcome, flowsOf(w)[b]!.ended!.costUsd], ["lost", 0.4]);
    assert.equal(w.engine.graph("gcp-demo:2")!.runs[0]!.situation, "lost");
    assert.equal(headline(w, 2), "r triage:k1=lost");
    assert.match(flowsOf(w)[b]!.ended!.why!, /失联.*已花 \$0\.40/);
  }));

// ---- an item is judged while a run of it is going ----------------------------------------------------------

test("an item that has gone cold is judged while a run for it is going, so that its result is read when it comes, and not after", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    w.flows.probes.set(id, running());
    // nothing about the item makes it worth looking at now: its release day is far, nobody touched it
    set(w, 1, { Release: "2027-06-01", Ask: "", Runs: JSON.stringify([req("k1")]) });
    await advance(w, 60);
    assert.equal(w.engine.status().cases.some((c) => c.caseId === "gcp-demo:1"), true, "hot: a run for it is going");
    w.flows.probes.set(id, finished({ found: 3 }));
    await advance(w, 10);
    assert.equal(headline(w, 1), 'r triage:k1=done{"found":3}', "judged on the result as it came");
    await advance(w, 30);
    assert.equal(w.engine.status().cases.some((c) => c.caseId === "gcp-demo:1"), false, "cold again once it is over");
  }));
