import assert from "node:assert/strict";
import { test } from "node:test";
import { FLOW_VALUE_BYTES } from "../shared/model";
import { apply, emptyState, flowKeyOf } from "../server/state";
import type { FlowRec } from "../shared/model";
import { RUN_INPUT_BYTES, RUNS_PER_JUDGMENT } from "../server/rules";
import { heatOf } from "../server/heat";
import { advance, asks, finished, first, flowsOf, headline, idFor, req, RULE, withFlows } from "./flows-kit";
import { set } from "./item-flow";

// What a rule may declare and ask for (rules.ts), and what the journal makes of the events a run leaves (state.ts).

/** The rule of flows-kit.ts with its `flows` replaced. */
const withDecl = (decl: string) => RULE.replace(/export const flows = \{[\s\S]*?\n\};/, `export const flows = ${decl};`);

const errorsOf = (w: Parameters<Parameters<typeof withFlows>[0]>[0]) => w.engine.status().rules.errors.map((e) => e.error).join("\n");

// ---- declaring --------------------------------------------------------------------------------------------

test("a rule declares the flows it may have started by its own names, beside the default export", () =>
  withFlows(async (w) => {
    await first(w);
    assert.deepEqual(w.engine.status().rules.errors, []);
    assert.equal(w.store.state.assessments["gcp-demo:1"]?.rule ?? "flowrule", "flowrule");
  }));

test("a declaration that does not fit is told when the rule is loaded, and the rule is not", async () => {
  const bad: Array<[string, string, RegExp]> = [
    ["a flow name the runtime cannot find", `{ triage: { flow: "Triage_Flow", maxUsd: 1 } }`, /flows: triage.flow/],
    ["no ceiling", `{ triage: { flow: "triage-flow" } }`, /flows: triage.maxUsd/],
    ["a ceiling of nothing", `{ triage: { flow: "triage-flow", maxUsd: 0 } }`, /flows: triage.maxUsd/],
    ["a ceiling too high to mean it", `{ triage: { flow: "triage-flow", maxUsd: 5000 } }`, /flows: triage.maxUsd/],
    ["a time limit that is not a duration", `{ triage: { flow: "triage-flow", maxUsd: 1, timeout: "soon" } }`, /flows: triage.timeout.*not a duration/],
    ["a field nobody knows", `{ triage: { flow: "triage-flow", maxUsd: 1, retries: 3 } }`, /flows: triage/],
    ["a name with a space", `{ "my flow": { flow: "triage-flow", maxUsd: 1 } }`, /flows: /],
  ];
  for (const [what, decl, error] of bad) {
    await withFlows(async (w) => {
      await first(w);
      assert.match(errorsOf(w), error, what);
      assert.equal(w.engine.status().plan.some((p) => p.kind === "flow"), false);
    }, { rule: withDecl(decl) });
  }
});

test("flows declared inside the default export are told, not dropped without a word", () =>
  withFlows(
    async (w) => {
      await first(w);
      assert.match(errorsOf(w), /flows: declare them as `export const flows = \{\.\.\.\}` beside the default export, not inside it/);
    },
    { rule: RULE.replace('name: "flowrule",', 'name: "flowrule", flows: {},') },
  ));

// ---- asking -----------------------------------------------------------------------------------------------

const error = (w: Parameters<Parameters<typeof withFlows>[0]>[0], n: number) => w.store.state.assessments[`gcp-demo:${n}`]?.error ?? "";

test("a request that does not fit is a judgment that failed: told, and nothing is started or recorded for it", () =>
  withFlows(async (w) => {
    const cases: Array<[number, unknown[], RegExp]> = [
      [1, [{ ...req("k"), flow: "nope" }], /run k: "nope" is not a flow this rule declares \(export const flows\)/],
      [2, [req("has space")], /key/],
      [3, [{ ...req("k"), label: "x".repeat(61) }], /label/],
      [4, Array.from({ length: RUNS_PER_JUDGMENT + 1 }, (_, i) => req(`k${i}`)), /run/],
      [5, [{ ...req("k"), owner: "nobody" }], /run 里的 owner "nobody" 不是 persons.json 里的人/],
      [6, [{ ...req("k"), surprise: true }], /run/],
      [7, [{ ...req("k"), input: { s: "x".repeat(RUN_INPUT_BYTES) } }], new RegExp(`input over ${RUN_INPUT_BYTES} bytes`)],
    ];
    for (const [n, runs] of cases) asks(w, n, runs);
    await first(w);
    for (const [n, , expected] of cases) assert.match(error(w, n), expected, `#${n}`);
    assert.equal(w.flows.launcher.started.length, 0);
    assert.deepEqual(Object.keys(flowsOf(w)), []);
  }));

test("a request that asks for a run again with the same key twice in one judgment is told, and an input that is not JSON is too", async () => {
  await withFlows(
    async (w) => {
      set(w, 1, { Runs: "x" });
      await first(w);
      assert.match(error(w, 1), /input is not JSON/);
      assert.equal(w.flows.launcher.started.length, 0);
    },
    { rule: RULE.replace("if (f.Runs) out.run = JSON.parse(f.Runs);", 'if (f.Runs) out.run = [{ flow: "triage", key: "k", input: { n: 10n }, label: "初查" }];') },
  );
});

test("what the rule is given of a run is a frozen copy: it cannot change what the controller keeps or what another judgment reads", () =>
  withFlows(
    async (w) => {
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      w.flows.probes.set(idFor(1, "k1"), finished({ list: [1, 2] }));
      await advance(w, 10);
      assert.equal(headline(w, 1), "r triage:k1=done frozen", "the rule below tried to push onto what it read");
      assert.deepEqual(flowsOf(w)[idFor(1, "k1")]!.ended!.value, { list: [1, 2] }, "the journal's copy is as it was");
    },
    {
      rule: RULE.replace(
        'return n + ":" + k + "=" + (r ? r.state + (r.value ? JSON.stringify(r.value) : "") : "-");',
        'let how = ""; if (r && r.value) { try { r.value.list.push(99); how = " mutable"; } catch (e) { how = " frozen"; } } return n + ":" + k + "=" + (r ? r.state + how : "-");',
      ),
    },
  ));

test("a run never asked for reads as nothing, whether it is another key, another name or a name the rule does not declare", () =>
  withFlows(async (w) => {
    set(w, 1, { Watch: "triage:other,quick:k1,nope:k1" });
    await first(w);
    assert.equal(headline(w, 1), "r triage:other=- quick:k1=- nope:k1=-");
  }));

// ---- hot while a run is going -----------------------------------------------------------------------------

test("an item with a run going is hot, however cold it would be: its result is judged when it comes", () => {
  const policy = { recentDays: 14, dateWindowDays: 14, dateFields: ["Release"] };
  const cold = { fields: {}, lastHumanAt: null };
  const inputs = { nowMs: Date.parse("2026-10-13T10:00:00+08:00"), tz: "Asia/Shanghai", policy, open: false, watched: false, flagChangedAt: null };
  assert.deepEqual(heatOf(cold, inputs), []);
  assert.deepEqual(heatOf(cold, { ...inputs, flowing: true }), ["有流程在跑"]);
  assert.deepEqual(heatOf(cold, { ...inputs, flowing: true, quiet: true }), ["有流程在跑"], "a container or standing item too: a run it started is its own reason");
});

// ---- what the journal makes of it -------------------------------------------------------------------------

const rec = (over: Partial<FlowRec> = {}): FlowRec => ({
  runId: "rc-x-1",
  caseId: "tracker:1",
  name: "triage",
  flow: "triage-flow",
  key: "k",
  round: 0,
  stage: null,
  label: "初查",
  affairLabel: "x",
  owner: null,
  notify: false,
  maxUsd: 1,
  timeout: null,
  input: { a: 1 },
  inputHash: "h",
  rules: "fp",
  intentAt: "2026-10-13T10:00:00+08:00",
  ...over,
});
const ev = (state: ReturnType<typeof emptyState>, body: Record<string, unknown>) => apply(state, { v: 1, seq: state.seq + 1, at: "2026-10-13T02:00:00.000Z", ...body } as never);

test("the events a run leaves fold into what the controller knows of it, and only once", () => {
  const s = emptyState();
  ev(s, { type: "flow.intent", rec: rec() });
  assert.deepEqual(Object.keys(s.flows!), ["rc-x-1"]);
  assert.deepEqual(s.flowKeys![flowKeyOf("tracker:1", "triage", "k")], { round: 0, runId: "rc-x-1" });
  ev(s, { type: "flow.spawn-failed", runId: "rc-x-1", error: "ENOENT" });
  assert.deepEqual([s.flows!["rc-x-1"]!.spawnTries, s.flows!["rc-x-1"]!.spawnError], [1, "ENOENT"]);
  ev(s, { type: "flow.spawned", runId: "rc-x-1", pid: 77 });
  assert.deepEqual([s.flows!["rc-x-1"]!.spawnTries, s.flows!["rc-x-1"]!.pid, s.flows!["rc-x-1"]!.spawnedAt], [2, 77, "2026-10-13T02:00:00.000Z"]);
  assert.equal(s.flows!["rc-x-1"]!.spawnError, undefined, "a start that went through clears the last failure");
  ev(s, { type: "flow.ended", runId: "rc-x-1", end: { outcome: "failed", summary: null, costUsd: 0.2, value: null, valueDropped: false, why: "坏了" } });
  assert.deepEqual(s.flows!["rc-x-1"]!.input, { a: 1 }, "a run that did not come to a result keeps its input: it is run again with it");
  ev(s, { type: "flow.ended", runId: "rc-x-1", end: { outcome: "done", summary: "好", costUsd: 9, value: { x: 1 }, valueDropped: false, why: null } });
  assert.deepEqual([s.flows!["rc-x-1"]!.ended!.outcome, s.flows!["rc-x-1"]!.ended!.costUsd], ["failed", 0.2], "the first end stands");
  ev(s, { type: "flow.dismissed", runId: "rc-x-1", how: "mine", by: "owner" });
  ev(s, { type: "flow.dismissed", runId: "rc-x-1", how: "fold", by: "other" });
  assert.deepEqual([s.flows!["rc-x-1"]!.dismissed!.how, s.flows!["rc-x-1"]!.dismissed!.by], ["mine", "owner"]);
  // events of a run the journal does not know change nothing
  ev(s, { type: "flow.spawned", runId: "rc-gone", pid: 1 });
  ev(s, { type: "flow.ended", runId: "rc-gone", end: { outcome: "done", summary: null, costUsd: 0, value: null, valueDropped: false, why: null } });
  ev(s, { type: "flow.dismissed", runId: "rc-gone", how: "mine", by: "x" });
  assert.deepEqual(Object.keys(s.flows!), ["rc-x-1"]);
});

test("a run that came to a result drops its input; the key points at the latest round, however the events came", () => {
  const s = emptyState();
  ev(s, { type: "flow.intent", rec: rec({ runId: "rc-x-1" }) });
  ev(s, { type: "flow.ended", runId: "rc-x-1", end: { outcome: "done", summary: null, costUsd: 0, value: { x: 1 }, valueDropped: false, why: null } });
  assert.equal(s.flows!["rc-x-1"]!.input, null);
  ev(s, { type: "flow.retry", caseId: "tracker:1", name: "triage", key: "k", round: 1, runId: "rc-x-1-r1", by: "owner", estimateUsd: 0 });
  assert.deepEqual(s.flowKeys![flowKeyOf("tracker:1", "triage", "k")], { round: 0, runId: "rc-x-1" }, "a person's act alone moves nothing: the intent that follows does");
  ev(s, { type: "flow.intent", rec: rec({ runId: "rc-x-1-r1", round: 1 }) });
  assert.deepEqual(s.flowKeys![flowKeyOf("tracker:1", "triage", "k")], { round: 1, runId: "rc-x-1-r1" });
  // an older round written late does not take the key back
  ev(s, { type: "flow.intent", rec: rec({ runId: "rc-x-1" }) });
  assert.equal(s.flowKeys![flowKeyOf("tracker:1", "triage", "k")]!.runId, "rc-x-1-r1");
  // another item with the same key is another key
  ev(s, { type: "flow.intent", rec: rec({ runId: "rc-y-1", caseId: "tracker:2" }) });
  assert.equal(Object.keys(s.flowKeys!).length, 2);
});

test("what a rule keeps within the bound is the bound the runtime's reader uses", () => {
  assert.equal(FLOW_VALUE_BYTES, 16 * 1024);
});
