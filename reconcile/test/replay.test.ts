import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { readCapsule, writeCapsule, type Capsule, type CapsuleOutcome } from "../server/capsule";
import { diffOutcomes, noDiff, replayOn, unmet, verdictOf } from "../server/replay";
import { issue } from "./helpers";
import { cleanDemos, capture, demoRuleText, loadDemo, type DemoParams } from "./replay-helpers";

after(cleanDemos);

/** A capsule as it is after a trip through a file: the replay never sees the live objects. */
function viaFile(capsule: Capsule): Capsule {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-replay-"));
  try {
    const read = readCapsule(writeCapsule(dir, capsule));
    if ("error" in read) throw new Error(read.error);
    return read.capsule;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rule = (params: DemoParams = {}) => loadDemo(demoRuleText(params));
const WATCHED = { watched: true };

test("a capsule asked again of the rule it was made by gives the answer it gave, with nothing missing", async () => {
  const original = await rule({ watch: true });
  const live = capture(original, "2026-10-21 17:00", WATCHED);
  assert.equal(live.outcome.error, null);
  assert.deepEqual(live.outcome.output!.observe!.map((o) => o.key), ["k1"]);
  const run = replayOn(viaFile(live), await rule({ watch: true }));
  assert.deepEqual(run.missing, []);
  assert.deepEqual(run.outcome, live.outcome);
  assert.equal(noDiff(diffOutcomes(live.outcome, run.outcome)), true);
});

test("the clock and the holiday tables are the capsule's: a week of holidays then is still one", async () => {
  const r = await rule({ grace: 1 });
  // 2026-10-22 is a Thursday; one workday later is Friday the 23rd -- unless the 23rd was a holiday.
  const open = capture(r, "2026-10-22 17:00", { years: { "2026": { holidays: [], workdays: [] } } });
  const closed = capture(r, "2026-10-22 17:00", { years: { "2026": { holidays: ["2026-10-23"], workdays: [] } } });
  const due = (c: Capsule) => c.outcome.output!.commitments[0]!.trigger.at;
  assert.match(due(open), /^2026-10-23T10:00/);
  assert.match(due(closed), /^2026-10-26T10:00/);
  // Asked again, whatever the tables are now, the tables are the capsule's own.
  for (const c of [open, closed]) {
    const run = replayOn(viaFile(c), r);
    assert.equal(run.outcome.output!.commitments[0]!.trigger.at, due(c));
    assert.ok(run.outcome.output!.facts[0]!.value.includes("due=" + due(c)));
  }
});

test("a rule that looks at what the capsule never saw is told it is not there, and the call is named", async () => {
  const live = capture(await rule(), "2026-10-21 17:00");
  const run = replayOn(viaFile(live), await rule({ peek: "gcp-demo:2" }));
  assert.deepEqual(run.missing, []);
  assert.deepEqual(replayOn(viaFile(live), await rule({ peek: "gcp-demo:3" })).missing, ['item("gcp-demo:3")']);
  // Told once, however often it asks; and what it is given is nothing, so it carries on.
  const miss = replayOn(viaFile(live), await rule({ peek: "gcp-demo:3" }));
  assert.match(miss.outcome.output!.facts[0]!.value, /peek=none/);
  // Its own change of what it read is a different answer, found by comparing the two.
  const peeked = replayOn(viaFile(capture(await rule({ peek: "gcp-demo:2" }), "2026-10-21 17:00")), await rule({ peek: "gcp-demo:2" }));
  assert.match(peeked.outcome.output!.facts[0]!.value, /peek=关闭/);
});

test("a rule that throws or names a stage it does not have is a judgment that failed, not a crash", async () => {
  const live = viaFile(capture(await rule(), "2026-10-21 17:00"));
  const boom = replayOn(live, await rule({ boom: true }));
  assert.equal(boom.outcome.output, null);
  assert.match(boom.outcome.error!, /demo\.mjs: boom/);
  const stage = replayOn(live, await rule({ badStage: true }));
  assert.match(stage.outcome.error!, /stage "nowhere" is not one of the declared stages/);
  // The names an output refers to are the capsule's: it asks to watch a source that was no observing one then.
  const names = viaFile({ ...live, names: { ...live.names, observing: [] } });
  assert.match(replayOn(names, await rule({ watch: true })).outcome.error!, /observe 里的 "watch-demo" 不是配置里的观察来源/);
  // And so are the names a question rests on: a source or file that was configured, an item that was there.
  for (const uses of [["flags-demo:outer"], ["gcp-demo:2"]]) assert.equal(replayOn(live, await rule({ uses })).outcome.error, null, uses.join());
  assert.match(replayOn(live, await rule({ uses: ["flag-demo:outer"] })).outcome.error!, /uses 里的 "flag-demo:outer" 不是配置里的来源、文件或已有的数据项/);
});

test("a difference is a judgment, a fact, a watch or wording, and the same answer written another way is none", async () => {
  const live = viaFile(capture(await rule(), "2026-10-21 17:00"));
  const run = async (params: DemoParams) => replayOn(live, await rule(params)).outcome;
  const base = live.outcome;
  assert.equal(noDiff(diffOutcomes(base, await run({}))), true);

  const worded = diffOutcomes(base, await run({ verb: "上线" }));
  assert.deepEqual(worded.judgment, [], "wording alone decides nothing");
  assert.deepEqual(worded.facts.map((f) => f.field), ["seen"], "what the rule read is a fact it wrote down");
  assert.deepEqual(worded.text.map((t) => t.field), ["现状", "问题 ask:gcp-demo:1:2026-10-22：标题", "问题 ask:gcp-demo:1:2026-10-22：问法", "问题 ask:gcp-demo:1:2026-10-22：卡上的说明"]);
  assert.equal(worded.observe.length, 0);

  // What the rule is given decides where it goes: another stage is a different judgment, though not a word of it is.
  const open = capture(await rule(), "2026-10-21 17:00", { items: { "gcp-demo:1": issue(1), "gcp-demo:2": issue(2) } });
  assert.equal(open.outcome.output!.stage, "open");
  assert.deepEqual(diffOutcomes(open.outcome, base).judgment, [{ field: "阶段", before: "open", after: "waiting" }]);

  const later = diffOutcomes(base, await run({ grace: 2 }));
  assert.deepEqual(
    later.judgment.map((j) => [j.field, j.before.slice(0, 16), j.after.slice(0, 16)]),
    [
      ["问题 ask:gcp-demo:1:2026-10-22", "要问「示例单 1 外放了吗？」", "没有"],
      ["问题 ask:gcp-demo:1:2026-10-23", "没有", "要问「示例单 1 外放了吗？」"],
    ],
    "a question keyed by its day is another question when the day moves",
  );

  const none = diffOutcomes(base, await run({ ask: false }));
  assert.deepEqual(none.judgment.map((j) => j.after), ["没有"]);

  const watching = diffOutcomes(base, await run({ watch: true }));
  assert.deepEqual(watching.observe.map((o) => [o.field, o.before, o.after]), [["观察 watch-demo:k1", "不要", "要"]]);

  const failed = diffOutcomes(base, await run({ boom: true }));
  assert.deepEqual(failed.judgment.map((j) => [j.field, j.before]), [["判断出错", "无"]]);
  assert.match(failed.judgment[0]!.after, /boom/);
  const bothFailed = diffOutcomes(await run({ boom: true }), { output: null, error: "another way to fail" });
  assert.deepEqual([bothFailed.judgment.length, bothFailed.text.map((t) => t.field)], [0, ["出错原因"]]);
});

test("the same answer with its keys in another order, or an instant in another zone, is the same answer", async () => {
  const live = viaFile(capture(await rule({ watch: true }), "2026-10-21 17:00", WATCHED));
  const reorder = (o: object): any => Object.fromEntries(Object.entries(o).reverse());
  const out = live.outcome.output!;
  const rewritten: CapsuleOutcome = {
    error: null,
    output: { ...reorder(out), commitments: out.commitments.map((c) => ({ ...reorder(c), trigger: { at: new Date(Date.parse(c.trigger.at)).toISOString() } })), observe: out.observe!.map((o) => ({ ...reorder(o), params: reorder(o.params) })) },
  };
  assert.notEqual(rewritten.output!.commitments[0]!.trigger.at, out.commitments[0]!.trigger.at);
  assert.equal(noDiff(diffOutcomes(live.outcome, rewritten)), true);
});

test("an expectation is met when everything written holds, and says what does not", async () => {
  const live = viaFile(capture(await rule(), "2026-10-21 17:00"));
  const o = live.outcome;
  assert.deepEqual(unmet({ stage: "waiting", health: ["on-track", "waiting"], actor: "system", error: false, notice: false, asks: { has: ["ask:gcp-demo:1:"], none: ["rollout-step:"] }, facts: { plan: "none", missing: null }, headline: { has: ["外放"], not: ["推断"] } }, o), []);
  assert.deepEqual(unmet({ stage: ["finished", "dropped"] }, o), ["阶段要是 finished 或 dropped，是 waiting"]);
  assert.deepEqual(unmet({ health: "done" }, o), ["健康要是 结束，是 在走"]);
  assert.deepEqual(unmet({ actor: ["me", "nobody"] }, o), ["在等谁要是 你 或 没有人，是 系统"]);
  assert.deepEqual(unmet({ notice: true }, o), ["该有提醒，没有"]);
  assert.deepEqual(unmet({ error: true }, o), ["该判断出错，它没有"]);
  assert.deepEqual(unmet({ asks: { has: ["release-check:"], none: ["ask:"] } }, o), ["该问 release-check:…，没有", "不该问 ask:…，却要问 ask:gcp-demo:1:2026-10-22"]);
  const factsUnmet = unmet({ facts: { plan: "x", seen: null } }, o);
  assert.equal(factsUnmet[0], "事实 plan 该是 x，是 none");
  assert.ok(factsUnmet[1]!.startsWith("不该记事实 seen，记了 示例单 1 外放"), factsUnmet[1]);
  assert.deepEqual(unmet({ headline: { has: ["推断"], not: ["外放"] } }, o), ["现状里该有「推断」", "现状里不该有「外放」"]);
  // A judgment that failed meets only a wish for it to have failed.
  const failed = replayOn(live, await rule({ boom: true })).outcome;
  assert.deepEqual(unmet({ error: true }, failed), []);
  assert.deepEqual(unmet({ error: false }, failed).length, 1);
  assert.deepEqual(unmet({ stage: "waiting", error: true }, failed), ["判断出错了，核对不了「stage」"]);
});

test("whether a side meets an expectation is not said where the rule asked for what the capsule never saw", async () => {
  const live = viaFile(capture(await rule(), "2026-10-21 17:00"));
  const expect = { stage: "waiting" } as const;
  assert.equal(verdictOf(expect, replayOn(live, await rule())), "met");
  assert.equal(verdictOf({ stage: "finished" }, replayOn(live, await rule())), "unmet");
  assert.equal(verdictOf(expect, replayOn(live, await rule({ peek: "gcp-demo:3" }))), "unknown", "even a wish that happens to hold");
  assert.equal(verdictOf(expect, null), "none");
});
