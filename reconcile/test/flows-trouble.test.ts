import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { RunView } from "../shared/graph";
import { at } from "./helpers";
import { set } from "./item-flow";
import { advance, asks, failedProbe, finished, first, flowsOf, headline, idFor, kinds, OWNER, POLICY, req, RULE, running, withFlows } from "./flows-kit";

// The limits on what is started, the breaker, a run in trouble and the way out of it, the page, a card that waits on a run, and
// telling a person. As flows-engine.test.ts: a launcher that records and a probe the test sets; nothing is started.

// ---- limits -----------------------------------------------------------------------------------------------

test("the day's count holds a request back: told on the plan and to the rule, noted once a day, and started the next day without anyone asking again", () =>
  withFlows(
    async (w) => {
      for (const n of [1, 2, 3]) asks(w, n, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      assert.equal(w.flows.launcher.started.length, 2, "two a day");
      const held = [1, 2, 3].filter((n) => !flowsOf(w)[idFor(n, "k1")]);
      assert.equal(held.length, 1);
      const n = held[0]!;
      assert.equal(headline(w, n), "r triage:k1=-", "judged in this round, before it could be told");
      await advance(w, 30);
      assert.equal(headline(w, n), "r triage:k1=deferred");
      assert.ok(w.engine.status().plan.some((p) => p.kind === "skipped" && /没起流程「初查」.*今天流程已经起了 2 次（上限 2），明天再起/.test(p.summary)), JSON.stringify(w.engine.status().plan));
      assert.equal(w.store.state.evals, 1, "one candidate for the evaluation set, however many rounds");
      await advance(w, 120);
      assert.equal(w.store.state.evals, 1);
      assert.equal(w.flows.launcher.started.length, 2);
      // the next day: nothing was recorded for it, so it is simply asked for and started
      w.clock.now = at("2026-10-14 10:00");
      await advance(w, 30);
      assert.equal(w.flows.launcher.started.length, 3);
      assert.ok(flowsOf(w)[idFor(n, "k1")], "the held one");
      assert.equal(headline(w, n), "r triage:k1=starting");
    },
    { policy: POLICY({ perDay: 2 }) },
  ));

test("at most so many at once: a request waits for room and is started in the same day when a run ends", () =>
  withFlows(
    async (w) => {
      for (const n of [1, 2, 3]) asks(w, n, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      await advance(w, 10);
      assert.equal(w.flows.launcher.started.length, 2);
      const started = Object.keys(flowsOf(w));
      assert.match(JSON.stringify(w.engine.status().plan), /同时在跑的流程已经有 2 个（上限 2），等有空位再起/);
      assert.equal(w.store.state.evals, 1);
      w.flows.probes.set(started[0]!, finished({ found: 1 }));
      await advance(w, 10);
      assert.equal(w.flows.launcher.started.length, 3, "the room freed by a run that ended");
      assert.equal(Object.keys(flowsOf(w)).length, 3);
    },
    { policy: POLICY({ concurrent: 2 }) },
  ));

test("one item gets so many a day", () =>
  withFlows(
    async (w) => {
      asks(w, 1, [req("a"), req("b"), req("c")], { Watch: "triage:a,triage:b,triage:c" });
      await first(w);
      assert.equal(w.flows.launcher.started.length, 2);
      assert.match(JSON.stringify(w.engine.status().plan), /这个事项今天流程已经起了 2 次（上限 2）/);
    },
    { policy: POLICY({ perCasePerDay: 2 }) },
  ));

test("the day's money: the ceiling of a run going counts until it is over, then what it cost", () =>
  withFlows(
    async (w) => {
      asks(w, 1, [req("a", { n: 1 }, "triage"), req("b", { n: 1 }, "quick", "快查")], { Watch: "triage:a,quick:b" });
      await first(w);
      assert.deepEqual(w.flows.launcher.started.map((s) => s.flow), ["triage-flow"], "$1 and then $0.5 would be over $1.2");
      assert.match(JSON.stringify(w.engine.status().plan), /花费已到 \$1\.00（上限 \$1\.2），再起一个按 \$0\.5 算会超/);
      w.flows.probes.set(idFor(1, "a"), finished({ x: 1 }, {}, 0.1));
      await advance(w, 10);
      assert.deepEqual(w.flows.launcher.started.map((s) => s.flow), ["triage-flow", "quick-flow"], "it cost $0.10, not $1");
    },
    { policy: POLICY({ usdPerDay: 1.2 }) },
  ));

test("a rehearsal says what it would run and starts nothing, asks for nothing", () =>
  withFlows(
    async (w) => {
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      assert.equal(w.flows.launcher.started.length, 0);
      assert.deepEqual(Object.keys(flowsOf(w)), []);
      assert.deepEqual(w.journal().filter((e) => e.type.startsWith("flow.")), []);
      assert.match(JSON.stringify(w.engine.status().plan), /会起流程「初查」（#1，triage-flow），按 \$1 算/);
      assert.equal(headline(w, 1), "r triage:k1=-");
    },
    { mode: "dry-run" },
  ));

test("an instance with no way to start flows says so, and nothing is recorded", () =>
  withFlows(
    async (w) => {
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await advance(w, 10);
      assert.deepEqual(Object.keys(flowsOf(w)), []);
      assert.equal(headline(w, 1), "r triage:k1=deferred");
      assert.match(JSON.stringify(w.engine.status().plan), /这个实例没有配起流程的命令（flows.json）/);
    },
    { flows: false },
  ));

// ---- the breaker ------------------------------------------------------------------------------------------

test("a rules change that would start many runs at once is held with the rest, a few are not, and what was held starts when it is let through", async () => {
  for (const [count, held] of [[4, true], [3, false]] as const) {
    await withFlows(async (w) => {
      const file = path.join(w.configDir, "rules", "flow.mjs");
      writeFileSync(file, RULE.replace("if (f.Runs) out.run = JSON.parse(f.Runs);", ""));
      for (let n = 1; n <= count; n++) asks(w, n, [req("k1")], { Watch: "triage:k1" });
      await w.run("2026-10-13 09:55", 5);
      assert.equal(w.flows.launcher.started.length, 0);
      writeFileSync(file, RULE);
      await w.run("2026-10-13 10:20", 5);
      if (held) {
        const h = w.store.state.rules.held!;
        assert.ok(h, `${count} runs at once: held`);
        assert.equal(h.flows, count);
        assert.equal(w.flows.launcher.started.length, 0);
        assert.deepEqual(Object.keys(flowsOf(w)), [], "no intent either: nothing is recorded for what is held");
        assert.ok(w.engine.status().plan.some((p) => p.kind === "held" && p.summary.includes("起流程「初查」")), JSON.stringify(w.engine.status().plan));
        assert.equal(w.engine.releaseRules(h.fingerprint), true);
        await w.run("2026-10-13 10:30", 5);
        assert.equal(w.flows.launcher.started.length, count, "let through: started");
      } else {
        assert.equal(w.store.state.rules.held, null);
        assert.equal(w.flows.launcher.started.length, count);
      }
    }, { start: "2026-10-13 09:50", policy: POLICY({}) });
  }
});

// ---- a run in trouble: the way out ------------------------------------------------------------------------

test("a run that failed is the item's condition until a person takes it over: it leaves the item's own state alone and says what it is", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    w.flows.probes.set(id, failedProbe());
    await advance(w, 10);
    let v = w.engine.graph("gcp-demo:1")!;
    assert.equal(v.runs[0]!.situation, "fail");
    assert.deepEqual(v.runs[0]!.actions, ["retry", "mine", "fold"]);
    assert.equal(w.engine.status().cases.find((c) => c.caseId === "gcp-demo:1")!.row!.situation, "fail");
    assert.match(v.hero.kicker, /流程失败了/);
    // a person takes it over: it is theirs now, not the item's
    const r = w.engine.dismissFlow(id, "mine", "owner");
    assert.deepEqual(r.ok, true, r.detail);
    await advance(w, 5);
    v = w.engine.graph("gcp-demo:1")!;
    assert.equal(w.engine.status().cases.find((c) => c.caseId === "gcp-demo:1")!.row!.situation, "them", "the item's own judgment says where it stands");
    assert.equal(v.runs[0]!.dismissed, "mine");
    assert.deepEqual(v.runs[0]!.actions, []);
    assert.equal(headline(w, 1), "r triage:k1=dismissed");
    assert.equal(flowsOf(w)[id]!.dismissed!.by, "owner");
    assert.match(w.engine.dismissFlow(id, "fold", "owner").detail, /已经收起过了/);
    assert.equal(w.flows.launcher.started.length, 1, "nothing is run again for it");
  }));

test("only a run in trouble is set aside, and one that is not known is not", () =>
  withFlows(async (w) => {
    asks(w, 1, [req("k1")]);
    asks(w, 2, [req("k1")]);
    await first(w);
    w.flows.probes.set(idFor(1, "k1"), running());
    w.flows.probes.set(idFor(2, "k1"), finished({ ok: 1 }));
    await advance(w, 10);
    assert.match(w.engine.dismissFlow(idFor(1, "k1"), "mine", "owner").detail, /还在正常地跑/);
    assert.match(w.engine.dismissFlow(idFor(2, "k1"), "mine", "owner").detail, /正常结束的/);
    assert.match(w.engine.dismissFlow("rc-test-nope", "mine", "owner").detail, /不是这个控制器起的/);
    assert.match(w.engine.retryFlow(idFor(2, "k1"), "owner").detail, /已经有结果了/);
    assert.match(w.engine.retryFlow(idFor(1, "k1"), "owner").detail, /还没结束/);
    assert.equal(kinds(w).filter((k) => k === "flow.dismissed" || k === "flow.retry").length, 0);
  }));

test("run it again is a person's: a new round under a new id with the rule's input now, counted in the day's limits, and the rule reads the latest round", () =>
  withFlows(
    async (w) => {
      const [r0, r1] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1)];
      asks(w, 1, [req("k1", { n: 1 })], { Watch: "triage:k1" });
      await first(w);
      w.flows.probes.set(r0, failedProbe());
      await advance(w, 10);
      assert.equal(headline(w, 1), "r triage:k1=failed");
      // the rule gives another input now: the new round runs with that one
      asks(w, 1, [req("k1", { n: 2 })], { Watch: "triage:k1" });
      await advance(w, 25);
      assert.equal(w.flows.launcher.started.length, 1, "the rule alone never runs it again");
      const r = w.engine.retryFlow(r0, "owner");
      assert.deepEqual([r.ok, r.detail], [true, "记下了，这就重新跑一次（第 2 轮）；上一轮花了 $0.30"]);
      const events = w.journal().filter((e) => e.type === "flow.retry" || (e.type === "flow.intent" && (e.rec as { round: number }).round === 1));
      assert.deepEqual(events.map((e) => e.type), ["flow.retry", "flow.intent"], "the person's act and the intent, in one write");
      assert.deepEqual([events[0]!.runId, events[0]!.round, events[0]!.by, events[0]!.estimateUsd, events[0]!.caseId, events[0]!.name, events[0]!.key], [r1, 1, "owner", 0.3, "gcp-demo:1", "triage", "k1"]);
      assert.deepEqual(flowsOf(w)[r1]!.input, { n: 2 });
      await advance(w, 10);
      assert.deepEqual(w.flows.launcher.started.map((s) => s.runId), [r0, r1]);
      assert.deepEqual(JSON.parse(readFileSync(w.flows.launcher.started[1]!.inputFile, "utf8")), { n: 2 });
      assert.equal(headline(w, 1), "r triage:k1=starting", "the latest round is what the rule reads");
      assert.match(w.engine.retryFlow(r0, "owner").detail, /已经有更新的一轮了/);
      const views = w.engine.graph("gcp-demo:1")!.runs;
      assert.deepEqual(views.map((v) => [v.runId, v.round]).sort(), [[r0, 0], [r1, 1]].sort());
      assert.deepEqual(views.find((v) => v.runId === r0)!.actions, ["mine", "fold"], "the old round can no longer be run again, only set aside");
      // it fails again: and again a person's
      w.flows.probes.set(r1, failedProbe());
      await advance(w, 10);
      assert.equal(w.engine.retryFlow(r1, "owner").ok, true);
      assert.ok(flowsOf(w)[idFor(1, "k1", "triage", 2)]);
    },
    { policy: POLICY({ perDay: 3 }) },
  ));

test("run it again is held to the limits like any other start, and is not offered where nothing can be started", async () => {
  await withFlows(
    async (w) => {
      asks(w, 1, [req("k1")]);
      asks(w, 2, [req("k1")]);
      await first(w);
      w.flows.probes.set(idFor(1, "k1"), failedProbe());
      await advance(w, 10);
      const r = w.engine.retryFlow(idFor(1, "k1"), "owner");
      assert.equal(r.ok, false);
      assert.match(r.detail, /今天流程已经起了 2 次（上限 2），明天再点/);
      assert.equal(kinds(w).filter((k) => k === "flow.retry").length, 0);
    },
    { policy: POLICY({ perDay: 2 }) },
  );
  await withFlows(async (w) => {
    asks(w, 1, [req("k1")]);
    await first(w);
    w.flows.probes.set(idFor(1, "k1"), failedProbe());
    await advance(w, 10);
    await w.restart("dry-run");
    assert.match(w.engine.retryFlow(idFor(1, "k1"), "owner").detail, /现在只演练/);
  });
});

test("a run that was never started because it could not be is offered the same way, and says that nothing was spent", () =>
  withFlows(async (w) => {
    w.flows.failStarts = { count: 3, error: new Error("spawn node ENOENT") };
    asks(w, 1, [req("k1")]);
    await advance(w, 15);
    const id = idFor(1, "k1");
    assert.equal(flowsOf(w)[id]!.ended!.outcome, "not-started");
    assert.match(w.engine.retryFlow(id, "owner").detail, /上一轮花了 \$0\.00/);
    await advance(w, 5);
    assert.deepEqual(w.flows.launcher.started.map((s) => s.runId), [idFor(1, "k1", "triage", 1)]);
  }));

// ---- the page ---------------------------------------------------------------------------------------------

const foreign = (over: Partial<RunView> = {}): RunView => ({
  runId: "someone-elses",
  stage: "review",
  flow: "别人的流程",
  startedAt: "2026-10-13T09:30:00+08:00",
  endedAt: "2026-10-13T09:40:00+08:00",
  situation: "fail",
  unreadLines: 0,
  outcome: null,
  step: null,
  steps: [],
  costUsd: 0,
  quiet: null,
  gate: null,
  error: { name: "Boom", plain: "出错了", raw: "x" },
  stopReason: null,
  sideEffects: [],
  agentId: null,
  link: { plugin: "orchestration-ui", screen: "runs", params: { run: "someone-elses" } },
  retry: null,
  ...over,
});

test("only a run the controller started is the item's condition: any other that names the item is listed and no more", () =>
  withFlows(
    async (w) => {
      set(w, 1, { Ball: "them" });
      await advance(w, 10);
      const row = w.engine.status().cases.find((c) => c.caseId === "gcp-demo:1")!.row!;
      assert.equal(row.situation, "them", "someone's failed file does not put the item among what is for you");
      const runs = w.engine.graph("gcp-demo:1")!.runs;
      assert.deepEqual(runs.map((r) => [r.runId, r.own]), [["someone-elses", false]]);
      assert.equal(runs[0]!.actions, undefined, "and nothing to do with it here");
    },
    { runs: () => [foreign()] },
  ));

test("the page tells a run's whole story: when it began, how it ended, and when the rule has moved on from it", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1", { n: 1 })], { Watch: "triage:k1" });
    await first(w);
    w.flows.probes.set(id, running());
    await advance(w, 10);
    set(w, 1, { Runs: JSON.stringify([req("k1", { n: 2 })]), Watch: "triage:k1" });
    await advance(w, 25);
    assert.ok(w.engine.graph("gcp-demo:1")!.marks.some((m) => m.kind === "flow" && /起的时候给的输入，和判断方法现在给的不一样；不会为这个重跑/.test(m.line)));
    set(w, 1, { Runs: "", Watch: "triage:k1" });
    await advance(w, 25);
    const marks = w.engine.graph("gcp-demo:1")!.marks.filter((m) => m.kind === "flow");
    assert.ok(marks.some((m) => /还在跑，但判断方法已经不要它了；不会去停它，结果出来照样记/.test(m.line)), JSON.stringify(marks));
    w.flows.probes.set(id, finished({ found: 1 }));
    await advance(w, 10);
    const done = w.engine.graph("gcp-demo:1")!;
    assert.equal(done.marks.filter((m) => m.kind === "flow").length, 0, "nothing to say once it is over");
    const lines = done.history.filter((h) => h.kind === "run").map((h) => h.line);
    assert.deepEqual(lines, ["起了流程「triage-flow」", "流程「triage-flow」结束了"]);
    assert.equal(done.runs[0]!.outcome, "找到 2 处");
  }));

test("a run that went quiet while it is alive is said as such and can be set aside, not run again", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")]);
    await first(w);
    w.flows.probes.set(id, running({ slow: true }));
    await advance(w, 10);
    const run = w.engine.graph("gcp-demo:1")!.runs[0]!;
    assert.equal(run.situation, "slow");
    assert.deepEqual(run.actions, ["mine", "fold"]);
    assert.equal(w.engine.dismissFlow(id, "mine", "owner").ok, true);
  }));

test("the list says which runs there are, how they stand and what they cost", () =>
  withFlows(async (w) => {
    asks(w, 1, [req("k1")]);
    asks(w, 2, [req("k1")]);
    await first(w);
    w.flows.probes.set(idFor(1, "k1"), finished({ ok: 1 }));
    await advance(w, 10);
    const list = w.engine.status().flows;
    assert.deepEqual(list.map((f) => [f.caseId, f.state, f.costUsd, f.round]).sort(), [["gcp-demo:1", "done", 0.5, 0], ["gcp-demo:2", "starting", 0, 0]]);
  }));

// ---- a card whose words depend on a run -------------------------------------------------------------------

test("a card whose words changed because a run it waits on ended is put up again with the new ones, once; any other change of its words leaves it alone", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")], { Watch: "triage:k1", Ask: "2026-10-13", Ball: "me" });
    await advance(w, 10);
    assert.equal(w.cards.length, 1, JSON.stringify(w.engine.status().plan));
    const card = w.cards[0]!;
    assert.match(card.content.brief, /b {2}triage:k1=/);
    // the words change for a reason that is not a run ending: the card stays
    set(w, 1, { Word: "another" });
    await advance(w, 30);
    assert.equal(w.cards.length, 1, "no new card for a word the rule changed");
    // the run ends
    w.flows.probes.set(id, finished({ found: 2 }));
    await advance(w, 10);
    assert.equal(w.cards.length, 2, JSON.stringify(w.engine.status().plan));
    const next = w.cards[1]!;
    assert.match(next.content.brief, /triage:k1=done\{"found":2\}/);
    assert.equal(next.card.cutFrom, card.card.id, "in place of the first, which is closed");
    assert.equal(w.store.state.cards[card.card.id]!.status, "closed");
    assert.match(w.store.state.cards[card.card.id]!.reason ?? "", /流程有了结局/);
    assert.equal(w.deliveries.length, 0, "not sent to the channels again");
    await advance(w, 60);
    assert.equal(w.cards.length, 2, "once");
  }));

test("a card that waits on two runs is put up again for each one that ends, and not for the other one's changes in between", () =>
  withFlows(async (w) => {
    const [a, b] = [idFor(1, "k1"), idFor(2, "k1")];
    asks(w, 1, [req("k1")], { Watch: "triage:k1", Ask: "2026-10-13", Ball: "me" });
    asks(w, 2, [req("k1")], { Watch: "triage:k1", Ask: "2026-10-13", Ball: "me" });
    await advance(w, 10);
    assert.equal(w.cards.length, 1, JSON.stringify(w.engine.status().plan));
    assert.equal(w.cards[0]!.card.commitments.length, 2, "one card for both");
    w.flows.probes.set(a, finished({ n: 1 }));
    w.flows.probes.set(b, running());
    await advance(w, 10);
    assert.equal(w.cards.length, 2, "the first one ended: the card says so now");
    assert.match(w.cards[1]!.content.brief, /triage:k1=done/);
    // the other one goes on: its words change on the page and in the card, and a card is not put up again for that
    w.flows.probes.set(b, running({ slow: true }));
    await advance(w, 30);
    assert.equal(w.cards.length, 2, "nothing ended");
    w.flows.probes.set(b, finished({ n: 2 }));
    await advance(w, 10);
    assert.equal(w.cards.length, 3, "and now the second");
    assert.equal(w.deliveries.length, 0);
    await w.restart();
    await advance(w, 30);
    assert.equal(new Set(w.cards.map((c) => c.card.id)).size, 3, "a restart brings back the card that is up, as it always does, and makes no other");
  },
    // the journal writes an event a moment after the round began, as it does in life
    { storeSkewMs: 1000 },
  ));

// ---- telling a person --------------------------------------------------------------------------------------

test("a run that ended in the person's quiet hours is told when they may be reached, not after so long that it would be news of yesterday, and not for a flow that did not ask to be told", () =>
  withFlows(
    async (w) => {
      const [a, b, c] = [idFor(1, "k1"), idFor(2, "k1"), idFor(3, "k1", "quick")];
      asks(w, 1, [req("k1")]);
      asks(w, 2, [req("k1")]);
      asks(w, 3, [req("k1", { n: 1 }, "quick", "快查")]);
      await first(w);
      w.flows.probes.set(a, finished({ ok: 1 }));
      w.flows.probes.set(c, finished({ ok: 1 }));
      await advance(w, 30);
      assert.equal(w.deliveries.length, 0, "08:20: nobody is disturbed");
      assert.ok(w.engine.status().plan.some((p) => p.kind === "deferred" && /不打扰时段，先不发 .*初查 好了/.test(p.summary)), JSON.stringify(w.engine.status().plan));
      await advance(w, 100);
      assert.equal(w.deliveries.length, 1, "09:30 on: told, and once");
      assert.equal(w.deliveries[0]!.title, "初查好了");
      assert.equal(flowsOf(w)[c]!.ended!.outcome, "done");
      assert.equal(flowsOf(w)[c]!.notify, false, "a flow that did not ask to be told is not");
      // b ends at 20:30, after the quiet hours began, and is looked at only the next morning
      w.clock.now = at("2026-10-13 20:30");
      w.flows.probes.set(b, finished({ ok: 2 }));
      await first(w);
      assert.equal(w.deliveries.length, 1, "20:30 is after the quiet hours began");
      w.clock.now = at("2026-10-14 09:35");
      await first(w);
      assert.equal(w.deliveries.length, 1, "13 hours later: left for the next card");
      assert.equal(w.store.state.ledger[`flow-notify:${b}:chat:u1`]!.status, "suppressed");
    },
    { start: "2026-10-13 07:50", persons: OWNER() },
  ));

test("a message that could not be sent is tried again on the next rounds, three times at most", () =>
  withFlows(
    async (w) => {
      const id = idFor(1, "k1");
      asks(w, 1, [req("k1")]);
      await first(w);
      w.fail.deliver = new Error("the channel is down");
      w.flows.probes.set(id, finished({ ok: 1 }));
      await advance(w, 30);
      const key = `flow-notify:${id}:chat:u1`;
      assert.equal(w.store.state.ledger[key]!.status, "failed");
      assert.equal(w.store.state.ledger[key]!.tries, 3, "three tries");
      assert.equal(w.deliveries.length, 3);
      await advance(w, 30);
      assert.equal(w.deliveries.length, 3, "and no more");
    },
    { persons: OWNER() },
  ));

test("a message that failed once and then got through is sent again with the same key, and then not again", () =>
  withFlows(
    async (w) => {
      const id = idFor(1, "k1");
      asks(w, 1, [req("k1")]);
      await first(w);
      w.fail.deliver = new Error("down");
      w.flows.probes.set(id, finished({ ok: 1 }));
      await advance(w, 5);
      assert.equal(w.deliveries.length, 1);
      w.fail.deliver = null;
      await advance(w, 10);
      assert.equal(w.deliveries.length, 2);
      assert.equal(w.deliveries[0]!.idempotencyKey, w.deliveries[1]!.idempotencyKey, "the channel can tell a repeat");
      assert.equal(w.store.state.ledger[`flow-notify:${id}:chat:u1`]!.status, "done");
      await advance(w, 30);
      assert.equal(w.deliveries.length, 2);
    },
    { persons: OWNER() },
  ));
