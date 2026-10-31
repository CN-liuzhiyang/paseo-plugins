import assert from "node:assert/strict";
import { test } from "node:test";
import { endedMessage, unfinishedWhy } from "../server/flows";
import type { RunView } from "../shared/graph";
import { retryCost, RETRY_LABEL, SITUATION, troubleLine, troubleWord } from "../shared/graph";
import type { FlowEnd } from "../shared/model";
import { advance, asks, finished, first, flowsOf, headline, idFor, kinds, OWNER, POLICY, req, withFlows } from "./flows-kit";

// A flow that stops on purpose and says in its value that it did not get done what it was for (`value.why`, a sentence) is a run
// that did not come to a result: told to the person as "没跑完：<why>", shown on the item's page as "没查成：<why>" with the way
// out a run in trouble has (run it again, take it over, fold it away). A stop with no `why` is a finished one. The engine reads only
// that one field of the value, and the rule is told what it always was (state "stopped", the value as it is).
// What the person reads of it is short: the flow's own summary when it has a short one, the why cut when it has not.

const WHY = "连不上数据库，可能是 VPN 没开，这次没查";
const stop = (value: unknown, costUsd = 0, over: Partial<NonNullable<ReturnType<typeof finished>["end"]>> = {}) => finished(value, { outcome: "stopped", stop: "没查成", summary: null, ...over }, costUsd);
const end = (outcome: FlowEnd["outcome"], value: unknown): Pick<FlowEnd, "outcome" | "value"> => ({ outcome, value });

// ---- the one rule that reads it ---------------------------------------------------------------------------

test("a stop is unfinished when its value says why in a sentence; nothing else is: no why, an empty or blank one, one that is not a text, another outcome", () => {
  assert.equal(unfinishedWhy(end("stopped", { why: WHY })), WHY);
  assert.equal(unfinishedWhy(end("stopped", { why: `  ${WHY}  `, samples: 0 })), WHY, "trimmed; the rest of the value is the flow's own");
  assert.equal(unfinishedWhy(end("stopped", { why: "a\u0000b\nc" })), "a b c", "one clean line");
  assert.equal(unfinishedWhy(end("stopped", { why: "x".repeat(400) }))!.length, 300, "bounded");
  for (const value of [null, undefined, "没查成", 5, [], [{ why: WHY }], {}, { why: "" }, { why: "   " }, { why: "\u0000" }, { why: 5 }, { why: null }, { why: ["x"] }, { Why: WHY }, { reason: WHY }]) {
    assert.equal(unfinishedWhy(end("stopped", value)), null, JSON.stringify(value) ?? "undefined");
  }
  for (const outcome of ["done", "failed", "timeout", "lost", "not-started", "refused"] as const) assert.equal(unfinishedWhy(end(outcome, { why: WHY })), null, outcome);
});

test("the message to the person: a stop that did not get done what it was for is told as 停了, with the flow's short summary or else its why cut; any other stop is 好了", () => {
  const rec = { label: "初查", caseId: "gcp-demo:7" };
  const base = { at: "2026-10-13T02:00:00.000Z", costUsd: 0, valueDropped: false, why: "没查成" };
  const unfinished = endedMessage(rec, { ...base, outcome: "stopped", summary: "没有可查的", value: { why: WHY } });
  assert.deepEqual([unfinished.title, unfinished.status], ["初查停了", "failed"]);
  assert.match(unfinished.text, /^#7 初查停了：没有可查的/, "a short summary of the flow is what it says");
  assert.equal(endedMessage(rec, { ...base, outcome: "stopped", summary: null, value: { why: `${WHY}。` } }).text.replace("。。", "。"), `#7 初查停了：${WHY}。`, "no summary: the why, with no double stop");
  const long = endedMessage(rec, { ...base, outcome: "stopped", summary: null, value: { why: "x".repeat(200) } });
  assert.ok([...long.text].length < 80 && long.text.includes("…"), `a long why is cut: ${long.text}`);
  for (const told of [unfinished, long]) {
    assert.equal(told.text.match(/#7/g)!.length, 1, "the number once");
    assert.doesNotMatch(told.text, /详情在/, "no pointer to a page when there is nothing to press there");
  }
  for (const value of [null, {}, { why: "" }, { why: "  " }, { why: 3 }, { found: 2 }]) {
    const told = endedMessage(rec, { ...base, outcome: "stopped", summary: "找到 2 处", value });
    assert.deepEqual([told.title, told.status], ["初查好了", "succeeded"], JSON.stringify(value));
    assert.match(told.text, /^#7 初查好了：找到 2 处/);
  }
  assert.match(endedMessage(rec, { ...base, outcome: "stopped", summary: null, value: null }).text, /好了：中止了/);
  const failed = endedMessage(rec, { ...base, outcome: "failed", summary: null, value: null });
  assert.equal(failed.status, "failed");
  assert.match(failed.text, /^#7 初查出错了：/, "a failure is told as one, in one word of its own");
});

// ---- what the page says ---------------------------------------------------------------------------------------

test("the line over the way out reads through for every run in trouble, in one of two words, and what starting over costs is said where there is room", () => {
  const run = (over: Partial<Pick<RunView, "flow" | "title" | "situation" | "why" | "shortWhy" | "retry">> = {}): Pick<RunView, "flow" | "title" | "situation" | "why" | "shortWhy" | "retry"> => ({ flow: "triage-flow", situation: "unchecked", why: WHY, shortWhy: null, retry: { round: 1, estimateUsd: null }, ...over });
  assert.equal(troubleLine(run()), `triage-flow停了：${WHY}`, "the request's name, what became of it, the why");
  assert.equal(troubleLine(run({ why: `${WHY}。` })), `triage-flow停了：${WHY}`, "no double stop");
  assert.equal(troubleLine(run({ why: null })), "triage-flow停了");
  assert.equal(troubleLine(run({ shortWhy: "没有可查的" })), "triage-flow停了：没有可查的", "the flow's own short summary wins over the long why");
  assert.ok([...troubleLine(run({ why: "x".repeat(300) }))].length < 60, "a long why is cut: the whole of it is behind a tap");
  const words = { notstarted: "出错了", unchecked: "停了", lost: "出错了", slow: "可能卡住了", fail: "出错了" } as const;
  for (const [situation, word] of Object.entries(words)) {
    assert.equal(troubleWord(situation as RunView["situation"]), word, situation);
    assert.equal(troubleLine(run({ situation: situation as RunView["situation"], why: "x" })), `triage-flow${word}：x`, situation);
  }
  assert.equal(RETRY_LABEL, "从头重跑");
  assert.equal(retryCost(run()), "从头重跑：上次没花钱", "a check that spent nothing");
  assert.equal(retryCost(run({ retry: { round: 1, estimateUsd: 0.3 } })), "从头重跑：会再花钱，上次 $0.30");
  assert.equal(retryCost(run({ situation: "notstarted" })), "从头重跑：上次没花钱");
  assert.equal(retryCost(run({ situation: "fail", retry: { round: 1, estimateUsd: 0.5 } })), "从头重跑：会再花钱，上次 $0.50");
  assert.equal(retryCost(run({ situation: "fail" })), "从头重跑：会再花钱");
});

// ---- the engine ---------------------------------------------------------------------------------------------

test("on the item's page: 停了 with the flow's sentence, a colour of its own, and the way out of a run in trouble; the list asks for a look", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    const value = { found: 0, why: WHY, samples: 0 };
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    w.flows.probes.set(id, stop(value, 0.3));
    await advance(w, 10);
    // the rule is told what it always was: a stop, and the value as it is
    assert.equal(headline(w, 1), `r triage:k1=stopped${JSON.stringify(value)}`);
    assert.equal(flowsOf(w)[id]!.ended!.outcome, "stopped");
    const v = w.engine.graph("gcp-demo:1")!;
    const run = v.runs[0]!;
    assert.equal(run.situation, "unchecked");
    assert.equal(run.why, WHY);
    assert.equal(run.outcome, `没查成：${WHY}`, "the run's own record keeps its words; what the person reads is the line below");
    assert.deepEqual(run.actions, ["retry", "mine", "fold"]);
    assert.deepEqual(run.retry, { round: 1, estimateUsd: 0.3 });
    assert.equal(troubleLine(run), `triage-flow停了：${WHY}`, "what the page puts over the buttons");
    assert.equal(retryCost(run), "从头重跑：会再花钱，上次 $0.30");
    assert.equal(v.situation, "unchecked");
    assert.equal(SITUATION.unchecked.tone, "warning", "yellow, not the red of a failure");
    assert.equal(SITUATION.unchecked.name, "停了");
    // the trouble and the way out are the top bar itself: what it wants of the person, what happened, nothing more
    assert.match(v.hero.kicker, /^要你：/, "the first words answer whether it wants anything");
    assert.equal(v.hero.line, `triage-flow停了：${WHY}`);
    assert.equal(v.hero.sub, "", "nothing on the first screen but the line: no cost, no promise about what happens next");
    const said = v.history.find((h) => h.kind === "run" && /停了/.test(h.line));
    assert.ok(said, JSON.stringify(v.history));
    assert.equal(said!.line.match(/停了/g)!.length, 1, "one line for the run, said once");
    assert.match(said!.line, /^triage-flow停了：/);
    assert.ok(!said!.inner, "what happened to the run is for the person, not bookkeeping");
    const row = w.engine.status().cases.find((c) => c.caseId === "gcp-demo:1")!.row!;
    assert.deepEqual([row.situation, row.group], ["unchecked", "me"]);
    // after a restart the same
    await w.restart();
    await advance(w, 10);
    assert.equal(w.engine.graph("gcp-demo:1")!.runs[0]!.situation, "unchecked");
  }));

test("nothing spent says so; a stop that came without a why is a finished run: done, nothing to do, the item as its rule judges it", () =>
  withFlows(async (w) => {
    const values: Array<[number, unknown]> = [[1, { why: WHY }], [2, null], [3, { why: "" }], [4, { why: "   " }], [5, { why: 7 }], [6, { found: 2 }]];
    for (const n of [1, 2, 3, 4, 5, 6, 7]) asks(w, n, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    for (const [n, value] of values) w.flows.probes.set(idFor(n, "k1"), stop(value));
    // a seventh whose value was too large to keep reads as a finished one, too
    w.flows.probes.set(idFor(7, "k1"), stop(null, 0, { valueDropped: true }));
    await advance(w, 10);
    assert.equal(retryCost(w.engine.graph("gcp-demo:1")!.runs[0]!), "从头重跑：上次没花钱", "nothing spent says so, where there is room for it");
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const v = w.engine.graph(`gcp-demo:${n}`)!;
      assert.equal(v.runs[0]!.situation, "done", String(n));
      assert.deepEqual(v.runs[0]!.actions, [], String(n));
      assert.equal(v.runs[0]!.retry, null, String(n));
      assert.equal(w.engine.status().cases.find((c) => c.caseId === `gcp-demo:${n}`)!.row!.situation, "them", `${n}: the item is as its rule says`);
    }
    assert.equal(w.engine.retryFlow(idFor(2, "k1"), "owner").ok, false, "a run that came out whole is not run again");
    assert.equal(w.engine.dismissFlow(idFor(2, "k1"), "mine", "owner").ok, false, "nor taken over");
  }, { policy: POLICY({}) }));

test("the person is told once: 停了 for a stop that did not get done what it was for, 好了 for any other", () =>
  withFlows(
    async (w) => {
      asks(w, 1, [req("k1")]);
      asks(w, 2, [req("k1")]);
      await first(w);
      w.flows.probes.set(idFor(1, "k1"), stop({ why: WHY }, 0, { summary: "没有可查的" }));
      w.flows.probes.set(idFor(2, "k1"), stop({ why: "" }, 0, { summary: "没有需要做的" }));
      await advance(w, 10);
      assert.equal(w.deliveries.length, 2);
      const one = w.deliveries.find((d) => d.text.startsWith("#1"))!;
      assert.deepEqual([one.title, one.status], ["初查停了", "failed"]);
      assert.match(one.text, /^#1 初查停了：/);
      assert.equal(one.text.match(/#1/g)!.length, 1);
      const two = w.deliveries.find((d) => d.text.startsWith("#2"))!;
      assert.deepEqual([two.title, two.status], ["初查好了", "succeeded"]);
      assert.match(two.text, /#2 初查好了：没有需要做的/);
      assert.ok(Object.values(w.store.state.ledger).some((a) => a.kind === "notify" && /：初查停了$/.test(a.summary)), "the record says what was sent");
      await advance(w, 60);
      await w.restart();
      await advance(w, 30);
      assert.equal(w.deliveries.length, 2, "once, not again after a restart");
    },
    { persons: OWNER() },
  ));

test("in the person's quiet hours the plan says what is waiting to be told in the same words: 停了 for a stop that did not get done what it was for, 好了 for the rest", () =>
  withFlows(
    async (w) => {
      asks(w, 1, [req("k1")]);
      asks(w, 2, [req("k1")]);
      await first(w);
      w.flows.probes.set(idFor(1, "k1"), stop({ why: WHY }));
      w.flows.probes.set(idFor(2, "k1"), stop({ found: 0 }, 0, { summary: "没有需要做的" }));
      await advance(w, 30);
      assert.equal(w.deliveries.length, 0, "08:20: nobody is disturbed");
      const plan = w.engine.status().plan.filter((p) => p.kind === "deferred").map((p) => p.summary);
      assert.ok(plan.some((p) => /不打扰时段，先不发 .*初查 停了/.test(p)), JSON.stringify(plan));
      assert.ok(plan.some((p) => /不打扰时段，先不发 .*初查 好了/.test(p)), JSON.stringify(plan));
      await advance(w, 100);
      assert.deepEqual(w.deliveries.map((d) => d.title).sort(), ["初查停了", "初查好了"].sort(), "told at 09:30, each once");
    },
    { start: "2026-10-13 07:50", persons: OWNER() },
  ));

test("the way out: run it again with the input it had (a stop that did not get done keeps it, as a failure does), take it over, or fold it away", () =>
  withFlows(async (w) => {
    const [r0, r1] = [idFor(1, "k1"), idFor(1, "k1", "triage", 1)];
    asks(w, 1, [req("k1", { n: 1 })], { Watch: "triage:k1" });
    asks(w, 2, [req("k1", { n: 2 })]);
    await first(w);
    w.flows.probes.set(r0, stop({ why: WHY }, 0.2));
    w.flows.probes.set(idFor(2, "k1"), stop({ found: 2 }, 0.2));
    await advance(w, 10);
    assert.deepEqual(flowsOf(w)[r0]!.input, { n: 1 }, "kept to be run again with");
    assert.equal(flowsOf(w)[idFor(2, "k1")]!.input, null, "a finished stop is not run again, so its input is dropped");
    // the rule stops asking: the input the run had is what it is run again with
    asks(w, 1, [], { Watch: "triage:k1" });
    await advance(w, 30);
    const retried = w.engine.retryFlow(r0, "owner");
    assert.equal(retried.ok, true, retried.detail);
    assert.match(retried.detail, /^从头重跑了/, "the reply is the one thing that was done");
    assert.match(retried.detail, /\$0\.20/, "and what the round it started over from cost");
    assert.ok([...retried.detail].length <= 24, retried.detail);
    const intent = w.journal().find((e) => e.type === "flow.intent" && (e.rec as { runId: string }).runId === r1)!;
    assert.deepEqual((intent.rec as { input: unknown }).input, { n: 1 });
    assert.ok(kinds(w).includes("flow.retry"));
    await advance(w, 10);
    assert.equal(w.flows.launcher.started.length, 3, "two firsts and the second round");
  }));

test("taken over or folded away, it is no longer the item's condition; one for a stage the item has left is history; a run going, or ended well, is not offered it", () =>
  withFlows(async (w) => {
    for (const n of [1, 2, 3]) asks(w, n, [req("k1")], { Watch: "triage:k1" });
    await first(w);
    for (const n of [1, 2, 3]) w.flows.probes.set(idFor(n, "k1"), stop({ why: WHY }, 0.1));
    await advance(w, 10);
    const row = (n: number) => w.engine.status().cases.find((c) => c.caseId === `gcp-demo:${n}`)!.row!.situation;
    assert.deepEqual([1, 2, 3].map(row), ["unchecked", "unchecked", "unchecked"]);
    const mine = w.engine.dismissFlow(idFor(1, "k1"), "mine", "owner");
    assert.equal(mine.ok, true, mine.detail);
    assert.equal(w.engine.dismissFlow(idFor(2, "k1"), "fold", "owner").ok, true);
    await advance(w, 5);
    assert.deepEqual([1, 2].map(row), ["them", "them"]);
    assert.equal(headline(w, 1), `r triage:k1=dismissed${JSON.stringify({ why: WHY })}`, "the rule is told it was set aside, with the value it has");
    assert.deepEqual(w.engine.graph("gcp-demo:1")!.runs[0]!.actions, []);
    // the item went on to another stage: the run for the one it left is history
    asks(w, 3, [req("k1")], { Watch: "triage:k1", Phase: "draft" });
    await advance(w, 45);
    assert.equal(row(3), "them");
    assert.deepEqual(w.engine.graph("gcp-demo:3")!.runs[0]!.actions, []);
  }, { policy: POLICY({}) }));
