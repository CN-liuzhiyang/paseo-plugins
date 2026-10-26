import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { backfill } from "../server/backfill";
import { buildCapsule, type Capsule, type CaptureInput } from "../server/capsule";
import { diffFlowDecls, diffOutcomes, noDiff, replayOn } from "../server/replay";
import { replayCapsules, replayDigest, replayLines } from "../server/replay-report";
import { loadRules } from "../server/rules";
import { issue, makeWorld, TEST_POLICY } from "./helpers";
import { advance, asks, finished, first, idFor, req, running, withFlows } from "./flows-kit";
import { set } from "./item-flow";
import { capture, cleanDemos, demoRuleText, loadDemo, type DemoParams } from "./replay-helpers";

// The replay sees the flows a rule asks for (batch 7b's `ctx.run`, the output's `run`, a rule's
// `flows`): a candidate that asks for another flow, with another input, or whose name for a flow
// stands for another one is a difference of its own kind; who a run's owner may be is part of what
// a capsule knows; and a backfill does not tape the state of a run it cannot know. Every name,
// number and time is made up.

after(cleanDemos);

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "reconcile-preview.mjs");

const FLOWS = { review: { flow: "review-flow", maxUsd: 1 } };
const RUN = { key: "k1", input: { n: 1 }, label: "初查" };

/** A rule that asks for the flow `review` as the params say, declared as given. */
const rule = (params: DemoParams = {}, flows: Parameters<typeof demoRuleText>[1] = FLOWS) => loadDemo(demoRuleText({ run: RUN, ...params }, flows));

test("a flow the answers ask for otherwise is a difference of its own kind: asked or not, with what input, told to whom; the name it goes by is only wording", async () => {
  const base = await rule();
  const c = capture(base, "2026-10-13 10:00");
  assert.deepEqual(c.outcome.output!.run, [{ flow: "review", key: "k1", input: { n: 1 }, label: "初查" }]);
  const answer = await replayOn(c, base);
  const diff = async (params: DemoParams) => diffOutcomes(answer.outcome, replayOn(c, await rule(params)).outcome);
  const fields = (list: Array<{ field: string }>) => list.map((d) => d.field);

  assert.ok(noDiff(await diff({})), "the same");
  const input = await diff({ run: { ...RUN, input: { n: 2 } } });
  assert.deepEqual(fields(input.flows), ["流程 review:k1：输入"]);
  assert.deepEqual([input.judgment, input.text, input.facts], [[], [], []], "and nothing else");
  assert.deepEqual([input.flows[0]!.before, input.flows[0]!.after], ['{"n":1}', '{"n":2}']);
  assert.deepEqual(fields((await diff({ run: { ...RUN, key: "k2" } })).flows), ["流程 review:k1", "流程 review:k2"], "another key is another run: one is not asked for, the other is");
  const owner = await diff({ run: { ...RUN, owner: "owner" } });
  assert.deepEqual(owner.flows, [{ field: "流程 review:k1：结果告诉谁", before: "管理员", after: "owner" }]);
  const none = await diff({ run: undefined as never });
  assert.deepEqual(none.flows, [{ field: "流程 review:k1", before: "要起", after: "不起" }]);
  const label = await diff({ run: { ...RUN, label: "复查" } });
  assert.deepEqual([label.flows, fields(label.text)], [[], ["流程 review:k1：名字"]], "a name is wording");
  assert.equal(noDiff(label), false);
});

test("what a rule's name for a flow stands for is compared on the flows the answers ask for: which flow, the most it may cost, how long, whether the person is told", async () => {
  const a = await rule();
  const c = capture(a, "2026-10-13 10:00");
  const out = replayOn(c, a).outcome.output;
  const same = await rule();
  assert.deepEqual(diffFlowDecls(a, same, out, out), []);
  const other = await rule({}, { review: { flow: "review-flow-2", maxUsd: 3, timeout: "30m", notify: true } });
  assert.deepEqual(
    diffFlowDecls(a, other, out, out).map((d) => [d.field, d.before, d.after]),
    [
      ["流程 review：起的是哪个流程", "review-flow", "review-flow-2"],
      ["流程 review：花费上限", "$1", "$3"],
      ["流程 review：超时", "（默认）", "30m"],
      ["流程 review：结束时告诉人", "false", "true"],
    ],
  );
  // A name neither answer asks for is not looked at; one only the candidate declares is "not declared" for the rule in use.
  assert.deepEqual(diffFlowDecls(a, other, { ...out!, run: [] }, { ...out!, run: [] }), []);
  assert.deepEqual(diffFlowDecls(a, await rule({}, {}), out, out).map((d) => d.after), ["（没声明）", "（没声明）", "（没声明）"], "what both leave to the default is not a difference");
});

test("a candidate whose name for a flow stands for another one shows in the replay as a difference in what is started, though the answers read alike", async () => {
  const a = await rule();
  const c = capture(a, "2026-10-13 10:00");
  const other = await rule({}, { review: { flow: "review-flow-2", maxUsd: 1 } });
  const report = replayCapsules([c], [a], [other]);
  assert.equal(report.changed.length, 1);
  assert.deepEqual(report.changed[0]!.diff.flows.map((d) => d.field), ["流程 review：起的是哪个流程"]);
  const text = replayLines(report).join("\n");
  assert.match(text, /要起的流程不同（1 份）：流程 review：起的是哪个流程/);
  assert.match(text, /流程 review：起的是哪个流程：review-flow → review-flow-2/);
  assert.doesNotMatch(text, /没有差异/);
  // The id of a preview holds it.
  const same = replayCapsules([c], [a], [await rule()]);
  assert.notEqual(JSON.stringify(replayDigest(report)), JSON.stringify(replayDigest(same)));
});

test("the self-check names a flow among the fields that differ from what the capsule stored", async () => {
  const a = await rule();
  const c = capture(a, "2026-10-13 10:00");
  assert.equal(c.rule.sha256, a.sha256, "made by the very version asked again");
  assert.deepEqual(replayCapsules([c], [a], null).selfCheck, []);
  const stored = c.outcome.output!;
  const tampered: Capsule = { ...c, outcome: { ...c.outcome, output: { ...stored, run: [{ ...stored.run![0]!, input: { n: 9 } }] } } };
  assert.deepEqual(replayCapsules([tampered], [a], null).selfCheck.map((s) => s.fields), [["流程 review:k1：输入"]]);
});

// ---- who a run's owner may be --------------------------------------------------------------------

test("a capsule keeps who the persons were: a candidate whose run is told to a stranger fails as the controller's judgment does; a capsule made before that cannot say, and is told so", async () => {
  const a = await rule({ run: { ...RUN, owner: "owner" } });
  const c = capture(a, "2026-10-13 10:00");
  assert.deepEqual(c.names.persons, ["owner"]);
  assert.equal(c.outcome.error, null);

  const stranger = replayOn(c, await rule({ run: { ...RUN, owner: "nobody-here" } }));
  assert.equal(stranger.outcome.output, null);
  assert.match(stranger.outcome.error!, /run 里的 owner "nobody-here" 不是 persons.json 里的人/);
  assert.deepEqual(stranger.missing, []);

  // Made before the persons were kept: whether the owner is one cannot be told; nothing is made up, and it is named as what the capsule lacks.
  const { persons: _gone, ...names } = c.names;
  const old: Capsule = { ...c, names };
  const run = replayOn(old, await rule({ run: { ...RUN, owner: "nobody-here" } }));
  assert.ok(run.outcome.output, "let through, not failed on a guess");
  assert.deepEqual(run.missing, ['persons.json 里有没有 "nobody-here"']);
  const quiet = replayOn(old, await rule());
  assert.deepEqual(quiet.missing, [], "a run with no owner needs no person");
  const report = replayCapsules([old], [await rule({ run: { ...RUN, owner: "owner" } })], [await rule({ run: { ...RUN, owner: "owner" }, verb: "上线" })]);
  assert.equal(report.missing.length, 1);
  assert.deepEqual(report.missing[0]!.calls, ['persons.json 里有没有 "owner"']);
  assert.deepEqual(report.changed, [], "told as missing data, not as a difference");
  // A flow asked for otherwise on a capsule that lacks something is shown for reference, with the judgment's differences.
  const asked = await rule({ run: { ...RUN, owner: "owner" } });
  const other = await rule({ run: { ...RUN, input: { n: 2 }, owner: "owner" } });
  const lacking = replayCapsules([old], [asked], [other]);
  assert.equal(lacking.missing.length, 1);
  assert.deepEqual(lacking.missing[0]!.diff!.flows.map((d) => d.field), ["流程 review:k1：输入"]);
  const lines = replayLines(lacking);
  assert.ok(lines.some((l) => l.includes("结果只作参考（两边要起的流程不同）")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("  （仅参考）流程 review:k1：输入：")), lines.join("\n"));
});

test("the engine offers the persons with a judgment, and a capsule made of it keeps them", async () => {
  const taken: Array<Omit<CaptureInput, "trigger" | "origin">> = [];
  const w = await makeWorld({ start: "2026-10-13 09:50", capture: (j) => taken.push(j), config: { rules: { "demo.mjs": demoRuleText() }, policy: TEST_POLICY } });
  try {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-13 10:05");
    assert.ok(taken.length > 0);
    const made = buildCapsule({ ...taken[0]!, trigger: ["sample"], origin: "live" });
    assert.deepEqual(made.names.persons, ["owner"]);
  } finally {
    w.close();
  }
});

// ---- a backfill does not tape what it cannot know --------------------------------------------------

test("a backfill does not tape the state of a run still going (the journal does not hold how it stood) and says so; a run the journal holds the end of, or one never asked for, is taped as it was", () =>
  withFlows(async (w) => {
    const to = mkdtempSync(path.join(os.tmpdir(), "reconcile-backfill-flows-"));
    try {
      const id = idFor(1, "k1");
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      // The source is read every twenty minutes: the stage changes at the next reading, with the run still going.
      w.flows.probes.set(id, running());
      set(w, 1, { Phase: "draft" });
      await advance(w, 20);
      w.flows.probes.set(id, finished({ found: 2 }));
      await advance(w, 10);
      set(w, 1, { Phase: "review" });
      await advance(w, 30);
      assert.equal(w.store.state.flows![id]!.ended?.outcome, "done");

      const result = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      const by = (stage: string, nth = 0) => result.made.map((m) => m.capsule).filter((c) => c.outcome.output?.stage === stage)[nth]!;
      const runCalls = (c: Capsule) => c.calls.filter((x) => x.m === "run");
      const first_ = by("review", 0);
      const going = by("draft");
      const over = by("review", 1);
      assert.ok(first_ && going && over, JSON.stringify(result.made.map((m) => [m.capsule.at, m.capsule.trigger, m.capsule.outcome.output?.stage])));

      // Never asked for: null, as the controller was told.
      assert.deepEqual(runCalls(first_).map((x) => [x.args, x.result]), [[["triage", "k1"], null]]);
      // Going: the engine in the preview would say "waiting" of it; nothing is taped.
      assert.deepEqual(runCalls(going), []);
      assert.deepEqual(result.unknowable.map((u) => [u.caseId, u.at, u.calls]), [["gcp-demo:1", going.at, ['run("triage", "k1")']]]);
      // Ended, and the journal holds the end: how it stood is what the record says.
      assert.deepEqual(runCalls(over).map((x) => [x.args, (x.result as { state: string }).state]), [[["triage", "k1"], "done"]]);

      // The command says it, and the JSON holds it.
      const env = { ...process.env, PASEO_HOME: path.join(to, "no-home") };
      const args = ["cases", "backfill", "--config", w.configDir, "--data", w.dataDir];
      const said = spawnSync(process.execPath, [BIN, ...args, "--to", path.join(to, "again")], { encoding: "utf8", env });
      assert.equal(said.status, 0, said.stderr);
      assert.match(said.stdout, /流程的状态补录时不可知：1 份存档里，判断方法读了还在跑的流程（run\("triage", "k1"\)）/);
      assert.match(said.stdout, /- 不可知：gcp-demo:1 2026-10-13 10:20/);
      const json = JSON.parse(spawnSync(process.execPath, [BIN, ...args, "--to", path.join(to, "again-json"), "--json"], { encoding: "utf8", env }).stdout) as { unknowable: Array<{ caseId: string; calls: string[] }> };
      assert.deepEqual(json.unknowable.map((u) => [u.caseId, u.calls]), [["gcp-demo:1", ['run("triage", "k1")']]]);

      // And a replay of the one that lacks it says it lacks it, instead of being told a state that never was.
      const rules = (await loadRules(path.join(w.configDir, "rules"))).rules;
      assert.deepEqual(replayOn(going, rules[0]!).missing, ['run("triage", "k1")']);
      assert.deepEqual(replayOn(over, rules[0]!).missing, []);
      assert.deepEqual(replayOn(first_, rules[0]!).missing, []);
    } finally {
      rmSync(to, { recursive: true, force: true });
    }
  }));
