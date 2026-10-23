import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { EngineStatus, PlanEntry } from "../server/engine";
import { exampleRule, issue, makeWorld, TEST_RULE_PARAMS, type World } from "./helpers";

// The engine end to end against a fake source and a fake carrier, with the example rule. One
// issue (or a few) moves through the tracker; the clock moves in 15-minute ticks. 2026-10-23 is
// a Friday; the owner's work window is workdays 09:30-20:00.

const status = (world: World) => world.statuses[world.statuses.length - 1] as EngineStatus;
const plan = (world: World, kind?: PlanEntry["kind"]) => status(world).plan.filter((p) => !kind || p.kind === kind);
const commitments = (world: World) => Object.values(world.store.state.commitments).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const stage = (world: World, key = "gcp-demo:1") => world.store.state.assessments[key]?.stage;
const note = (world: World, field: string, key = "gcp-demo:1") => world.store.state.notes[key]?.[field];

async function withWorld(options: Parameters<typeof makeWorld>[0], body: (world: World) => Promise<void>) {
  const world = await makeWorld(options);
  try {
    await body(world);
  } finally {
    world.close();
  }
}

test("no machine signal: asked on the release day, answered, done -- an issue with no switch key is not followed further", () =>
  withWorld({ start: "2026-10-21 17:00" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23外放（例行）" }));
    await w.run("2026-10-21 17:00");
    assert.equal(stage(w), "open");
    assert.equal(w.store.state.notes["gcp-demo:1"]?.plannedRelease?.value, "2026-10-23");
    assert.equal(commitments(w).length, 0);

    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23外放（例行）", status: "关闭", closed: true, sourceUpdatedAt: "2026-10-22T15:00:00+08:00" }));
    await w.run("2026-10-22 15:00");
    assert.equal(stage(w), "awaiting-release");
    const obs = w.store.state.recent["gcp-demo:1"]!;
    assert.deepEqual(obs[obs.length - 1]!.changes.map((c) => c.field), ["status", "closed"]);
    assert.equal(commitments(w).length, 1);
    assert.equal(w.cards.length, 0, "nothing is asked before the release day");

    await w.run("2026-10-23 17:45");
    assert.equal(w.cards.length, 0);
    await w.run("2026-10-23 18:00");
    assert.equal(w.cards.length, 1);
    const [first] = w.cards;
    assert.equal(first!.card.title, "#1 外放了吗？");
    assert.match(first!.content.brief, /计划 \*\*2026-10-23\*\* 外放，过了 0 个工作日机器上还是看不出来：外网 release 里还没有这张单的提交/);
    // The same tick again does not ask again.
    await w.run("2026-10-23 19:00");
    assert.equal(w.cards.length, 1);

    assert.match(w.answer({ "#1": "已外放，灰度开了" }), /已记下/);
    await w.run("2026-10-23 19:15");
    assert.equal(stage(w), "finished");
    assert.match(w.store.state.assessments["gcp-demo:1"]!.headline, /已外放（你说已外放，灰度开了），没有灰度 key，不跟灰度/);
    assert.deepEqual(w.archived, [first!.agentId]);
    assert.equal(status(w).openCommitments, 0);
  }));

const keyed = (patch: Parameters<typeof issue>[1] = {}) =>
  issue(1, {
    release: "2026-10-23",
    status: "关闭",
    closed: true,
    text: "示例单 1：新开关 feature_x，先灰度",
    revisions: [{ id: "R-101", repo: "demo", branch: "trunk", at: "2026-10-12T10:00:00+08:00", author: "甲", summary: "add feature_x", added: [["feature_x", 'if switches.on("feature_x") then']] }],
    ...patch,
  });

test("the machine way: the key is found in the text and the commit, the outer switch file says released and how far, nobody is asked", () =>
  withWorld({ start: "2026-10-21 17:00" }, async (w) => {
    w.flags.set("other_key", 100);
    w.items.set("gcp-demo:1", keyed());
    await w.run("2026-10-21 17:00");
    // Not in the file yet: the key is only known once the file has it.
    assert.equal(w.store.state.notes["gcp-demo:1"]?.flagKey, undefined);
    w.flags.set("feature_x", { enabled: true, grey: 0 });
    await w.run("2026-10-21 17:30");
    const flagKey = note(w, "flagKey")!;
    assert.equal(flagKey.value, "feature_x");
    assert.match(flagKey.evidence!, /单子文本：…示例单 1：新开关 feature_x，先灰度…；R-101（trunk）：\+ if switches.on\("feature_x"\) then/);
    // In the outer file at 0: released (the config is out), not yet rolled out.
    assert.equal(stage(w), "rolling-out");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.headline, "灰度中：外网 0%");
    assert.deepEqual(commitments(w).filter((c) => c.status === "scheduled").map((c) => c.key), [], "the release question was dropped: the file answered it");

    w.flags.set("feature_x", { enabled: true, grey: 20 });
    await w.run("2026-10-26 10:00");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.headline, "灰度中：外网 20%");
    w.flags.set("feature_x", { enabled: true, grey: 100 });
    await w.run("2026-10-28 10:00");
    assert.equal(stage(w), "finished");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.headline, "已全量：外网 100%");
    assert.equal(w.cards.length, 0);
  }));

test("back to 0 after being on is a rollback, read and not asked", () =>
  withWorld({ start: "2026-10-23 10:00" }, async (w) => {
    w.flags.set("feature_x", 30);
    w.items.set("gcp-demo:1", keyed());
    await w.run("2026-10-23 10:00");
    assert.equal(w.store.state.notes["gcp-demo:1"]?.["rollout.peak.main"]?.value, "30");
    w.flags.set("feature_x", 0);
    await w.run("2026-10-23 11:00");
    assert.equal(stage(w), "finished");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.headline, "已回退：外网 0%（之前到过 30%）");
    assert.equal(w.cards.length, 0);
  }));

test("the key gone from the file after being there cannot be told apart, so it is one question", () =>
  withWorld({ start: "2026-10-23 10:00" }, async (w) => {
    w.flags.set("feature_x", 100);
    w.flags.set("other_key", 1);
    w.items.set("gcp-demo:1", keyed({ text: "feature_x 示例" }));
    await w.run("2026-10-23 10:00");
    assert.equal(stage(w), "finished", "100 everywhere is full");
    w.flags.set("feature_x", 50);
    await w.run("2026-10-23 11:00");
    assert.equal(stage(w), "rolling-out", "a change in the file wakes it again");
    w.flags.delete("feature_x");
    await w.run("2026-10-23 18:00");
    assert.equal(w.cards.length, 1);
    assert.match(w.cards[0]!.card.title, /`feature_x` 从外网开关文件里删掉了，是全量后清理，还是撤掉了？/);
    w.answer({ "#1": "全量了" });
    await w.run("2026-10-23 18:15");
    assert.equal(stage(w), "finished");
  }));

test("two candidate keys and nothing to tell them apart: one question, and the answer is kept", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.flags.set("feature_x", 10);
    w.flags.set("feature_y", 20);
    w.items.set("gcp-demo:1", keyed({ text: "feature_x 或者 feature_y", revisions: [] }));
    await w.run("2026-10-21 10:00");
    assert.equal(w.cards.length, 1);
    assert.equal(w.cards[0]!.card.title, "#1 对应哪个灰度 key？");
    assert.deepEqual(w.cards[0]!.content.questions[0]!.options.map((o) => o.label), ["feature_x", "feature_y", "没有灰度 key"]);
    w.answer({ "#1 key": "feature_y" });
    await w.run("2026-10-21 10:15");
    assert.equal(w.store.state.notes["gcp-demo:1"]?.flagKey?.value, "feature_y");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.headline, "灰度中：外网 20%");
    await w.run("2026-10-22 10:00");
    assert.equal(w.cards.length, 1, "not asked again");
  }));

test("nothing on the issue itself, but a sibling settled a key: asked as a one-click yes, with the evidence marked as the sibling's", () =>
  withWorld({ start: "2026-10-21 10:00", config: { rules: { "release-followup.mjs": exampleRule({ ...TEST_RULE_PARAMS, keyHint: "灰度" }) } } }, async (w) => {
    w.flags.set("feature_x", 10);
    // Both arrive at once, the one without a key first: which is judged first must not matter.
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-23", status: "关闭", closed: true, parent: "gcp-demo:9", text: "引擎侧的版本检查，配合灰度" }));
    w.items.set("gcp-demo:1", keyed({ parent: "gcp-demo:9" }));
    await w.run("2026-10-21 10:00");
    assert.equal(w.store.state.notes["gcp-demo:1"]?.flagKey?.value, "feature_x");
    assert.equal(w.cards.length, 1);
    assert.equal(w.cards[0]!.card.title, "#2 的灰度 key 是不是 `feature_x`？");
    const options = w.cards[0]!.content.questions[0]!.options;
    assert.deepEqual(options.map((o) => o.label), ["feature_x", "没有灰度 key"]);
    assert.equal(options[0]!.description, "同一父单下的 #1 用的 key");
    const brief = commitments(w).find((c) => c.key === "flagkey:gcp-demo:2")!.brief;
    assert.match(brief, /这张单本身没读准，下面是从同一父单下的兄弟单推出来的候选/);
    assert.match(brief, /`feature_x`：#1 对上的（那边的证据：单子文本：/);
    w.answer({ "#2 key": "feature_x" });
    await w.run("2026-10-21 10:15");
    assert.equal(w.store.state.notes["gcp-demo:2"]?.flagKey?.value, "feature_x");
    assert.equal(w.store.state.notes["gcp-demo:2"]?.flagKey?.evidence, "你在问题卡上确认的（候选从兄弟单推出来）");
  }));

const adds = (name: string, id = "R-7") => ({ id, repo: "demo", branch: "trunk", at: "2026-10-12T10:00:00+08:00", author: "甲", summary: "", added: [[name, `int ${name}()`]] as Array<[string, string]> });

test("key order, first: what the issue names itself wins over an alias of the same key", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.flags.set("feature_x", { enabled: true, grey: 10, checker: "CheckFeatureX" });
    w.items.set("gcp-demo:1", keyed({ revisions: [...keyed().revisions!, adds("CheckFeatureX")] }));
    await w.run("2026-10-21 10:00");
    assert.equal(note(w, "flagKey")!.value, "feature_x");
    assert.match(note(w, "flagKey")!.evidence!, /^单子文本：/);
    assert.doesNotMatch(note(w, "flagKey")!.evidence!, /别名/);
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.headline, "灰度中：外网 10%");
  }));

test("key order, second: an alias the issue's own commits bring in settles the key, said to be inferred; the text alone does not", () =>
  withWorld({ start: "2026-10-21 10:00", config: { rules: { "release-followup.mjs": exampleRule({ ...TEST_RULE_PARAMS, keyHint: "灰度" }) } } }, async (w) => {
    w.flags.set("feature_x", { enabled: true, grey: 10, checker: ["CheckFeatureX", 2] });
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true, text: "引擎侧加 CheckFeatureX，配合灰度" }));
    await w.run("2026-10-21 10:00");
    assert.equal(w.store.state.notes["gcp-demo:1"]?.flagKey, undefined, "named in the text only: not an alias hit");
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true, text: "引擎侧加 CheckFeatureX，配合灰度", revisions: [adds("CheckFeatureX")] }));
    await w.run("2026-10-21 10:30");
    assert.equal(note(w, "flagKey")!.value, "feature_x");
    assert.equal(note(w, "flagKey")!.evidence, "别名匹配：R-7 在 trunk 上新加了 CheckFeatureX，它是 switches.feature_x 的 checker");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.headline, "灰度中：外网 10%；key 由提交里的 CheckFeatureX 推出");
    assert.deepEqual(commitments(w).filter((c) => c.status === "scheduled").map((c) => c.key), [], "the key question it asked first is withdrawn");
  }));

test("an alias counts only under a property the rule lists: a branch name in the entry is not one, nor a key it found before", () =>
  withWorld({ start: "2026-10-21 10:00", config: { rules: { "release-followup.mjs": exampleRule({ ...TEST_RULE_PARAMS, aliasProperties: ["checker", "branch"] }) } } }, async (w) => {
    w.flags.set("feature_x", { enabled: true, grey: 10, branch: "trunk_main" });
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true, revisions: [adds("trunk_main")] }));
    await w.run("2026-10-21 10:00");
    assert.equal(note(w, "flagKey")!.value, "feature_x", "listed: found by it");
    writeFileSync(path.join(w.configDir, "rules", "release-followup.mjs"), exampleRule(TEST_RULE_PARAMS));
    await w.run("2026-10-21 10:30");
    assert.doesNotMatch(w.store.state.assessments["gcp-demo:1"]!.headline, /灰度中|别名/, "no longer listed: the key it found is not kept while still in the file");
  }));

test("key order, last: an alias that is not unique or disagrees with a direct hit settles nothing; asked, with a sibling's key offered", () =>
  withWorld({ start: "2026-10-21 10:00", config: { rules: { "release-followup.mjs": exampleRule({ ...TEST_RULE_PARAMS, keyHint: "灰度" }) } } }, async (w) => {
    w.flags.set("feature_x", { enabled: true, grey: 10, checker: "CheckShared" });
    w.flags.set("feature_y", { enabled: true, grey: 20, checker: "CheckShared" });
    w.flags.set("feature_z", { enabled: true, grey: 30, checker: "CheckFeatureZ" });
    w.flags.set("feature_w", 40);
    const engineSide = (id: number, patch: Parameters<typeof issue>[1]) => issue(id, { release: "2026-10-23", status: "关闭", closed: true, parent: "gcp-demo:9", text: "引擎侧，配合灰度", ...patch });
    w.items.set("gcp-demo:3", issue(3, { release: "2026-10-23", status: "关闭", closed: true, parent: "gcp-demo:9", text: "示例单：新开关 feature_w" }));
    // Shared alias: one name, two keys.
    w.items.set("gcp-demo:1", engineSide(1, { revisions: [adds("CheckShared")] }));
    // Disagreeing: the text names feature_y, the commit brings in feature_z's checker.
    w.items.set("gcp-demo:2", engineSide(2, { text: "引擎侧，feature_y 灰度", revisions: [adds("CheckFeatureZ")] }));
    await w.run("2026-10-21 10:15");
    const ask = (id: number) => commitments(w).find((c) => c.key === `flagkey:gcp-demo:${id}`)!;
    assert.equal(w.store.state.notes["gcp-demo:1"]?.flagKey, undefined);
    assert.deepEqual(ask(1).ask.options.map((o) => `${o.id} ${o.label}`), ["a1 feature_x", "a2 feature_y", "s1 feature_w", "none 没有灰度 key"]);
    assert.match(ask(1).brief, /按别名对上了，但不唯一/);
    assert.match(ask(1).brief, /这个名字也是 feature_y 的/);
    assert.match(ask(1).brief, /从同一父单下的兄弟单推出来的候选/);
    assert.equal(w.store.state.notes["gcp-demo:2"]?.flagKey, undefined);
    assert.deepEqual(ask(2).ask.options.map((o) => `${o.id} ${o.label}`), ["k1 feature_y", "a1 feature_z", "s1 feature_w", "none 没有灰度 key"]);
    assert.match(ask(2).brief, /推出来的，和上面的不一致/);
  }));

// One item follows a key's rollout: the lead, whose own commits add the key. Item 2 comes to the
// same key through an alias and is out early (its commit is on the release branch).
const follower = () =>
  issue(2, { release: "2026-10-16", status: "关闭", closed: true, text: "引擎侧的检查", revisions: [{ ...adds("CheckFeatureX", "R-8"), branch: "release" }] });
const headline = (w: World, id: number) => w.store.state.assessments[`gcp-demo:${id}`]!.headline;
const open = (w: World, id: number) => commitments(w).filter((c) => c.caseId === `gcp-demo:${id}` && (c.status === "scheduled" || c.status === "waiting"));

test("a follower is out but does not ask about the rollout: the lead follows the key", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.innerFlags.set("feature_x", { enabled: true, grey: 100, checker: ["CheckFeatureX", 2] });
    w.items.set("gcp-demo:1", keyed());
    w.items.set("gcp-demo:2", follower());
    await w.run("2026-10-22 18:30");
    assert.equal(headline(w, 2), "推断已外放（R-8 10-12 10:00 进 release，外放日到了），灰度跟着 #1；key 由提交里的 CheckFeatureX 推出");
    assert.deepEqual(open(w, 2), [], "no rollout question, no grace");
    assert.equal(w.cards.length, 0);
  }));

test("out only by inference, and the key not in the outer file yet: the headline says the release is inferred", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.innerFlags.set("feature_x", { enabled: true, grey: 100 });
    w.items.set("gcp-demo:1", keyed({ release: "2026-10-22", revisions: [{ id: "R-101", repo: "demo", branch: "release", at: "2026-10-12T10:00:00+08:00", author: "甲", summary: "add feature_x", added: [["feature_x", 'if switches.on("feature_x") then']] }] }));
    await w.run("2026-10-22 10:00");
    assert.match(headline(w, 1), /^推断已外放，外网开关里还没有 `feature_x`，\d\d-\d\d \d\d:\d\d 还没有就问你$/);
  }));

test("a follower ends when its lead ends, and says whose end it followed", () =>
  withWorld({ start: "2026-10-23 10:00" }, async (w) => {
    w.innerFlags.set("feature_x", { enabled: true, grey: 100, checker: ["CheckFeatureX", 2] });
    w.flags.set("feature_x", { enabled: true, grey: 30, checker: ["CheckFeatureX", 2] });
    w.items.set("gcp-demo:1", keyed());
    w.items.set("gcp-demo:2", follower());
    await w.run("2026-10-23 10:15");
    assert.equal(headline(w, 1), "灰度中：外网 30%");
    assert.match(headline(w, 2), /灰度跟着 #1/);
    w.flags.set("feature_x", { enabled: true, grey: 100, checker: ["CheckFeatureX", 2] });
    await w.run("2026-10-23 11:00");
    assert.equal(headline(w, 1), "已全量：外网 100%");
    assert.equal(w.store.state.assessments["gcp-demo:2"]!.stage, "finished");
    assert.equal(headline(w, 2), "跟着 #1 结束：已全量；key 由提交里的 CheckFeatureX 推出");
    const result = w.store.state.notes["gcp-demo:2"]!["rollout.result"]!;
    assert.equal(result.value, "full");
    assert.equal(result.evidence, "跟着 #1 结束（外网开关文件：外网 100%）");
    assert.equal(w.cards.length, 0);
  }));

test("a follower whose lead is not followed this round asks on its own", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.innerFlags.set("feature_x", { enabled: true, grey: 100, checker: ["CheckFeatureX", 2] });
    // The lead is old and nobody touches it: cold.
    w.items.set("gcp-demo:1", keyed({ release: "2026-07-01" }));
    w.items.set("gcp-demo:2", follower());
    await w.run("2026-10-21 10:15");
    assert.equal(w.store.state.assessments["gcp-demo:1"], undefined, "cold, not judged");
    assert.equal(w.cards.length, 1);
    assert.equal(w.cards[0]!.card.title, "#2 外放了，但外网开关文件里一直没有 `feature_x`：灰度开了吗？");
  }));

test("two items both add the key: the one released later leads, the other follows it", () =>
  withWorld({ start: "2026-10-23 10:00" }, async (w) => {
    w.flags.set("feature_x", 30);
    w.items.set("gcp-demo:1", keyed());
    w.items.set("gcp-demo:3", issue(3, { ...keyed(), key: "gcp-demo:3", url: null, fields: { Release: "2026-10-30" } }));
    await w.run("2026-10-23 10:15");
    assert.equal(headline(w, 3), "灰度中：外网 30%");
    assert.equal(headline(w, 1), "已外放（外网开关文件里有 `feature_x`（外网 30%）），灰度跟着 #3");
    assert.deepEqual(open(w, 1), []);
  }));

// A capability alias: the switch needs what another issue provides (a version check function).
const CAPS = { ...TEST_RULE_PARAMS, keyHint: "灰度", capabilityProperties: ["checker"] };
const provider = (branch: string) =>
  issue(2, { release: "2026-10-16", status: "关闭", closed: true, text: "引擎侧的检查，配合灰度", revisions: [{ ...adds("CheckFeatureX", "R-8"), branch }] });

test("a capability alias is a dependency edge, not a key, seen from both ends; its provider is not asked for a key", () =>
  withWorld({ start: "2026-10-21 10:00", config: { rules: { "release-followup.mjs": exampleRule(CAPS) } } }, async (w) => {
    w.innerFlags.set("feature_x", { enabled: true, grey: 100, checker: ["CheckFeatureX", 2] });
    w.items.set("gcp-demo:1", keyed());
    w.items.set("gcp-demo:2", provider("trunk"));
    await w.run("2026-10-21 10:15");
    const two = w.store.state.notes["gcp-demo:2"]!;
    assert.equal(two.flagKey, undefined);
    assert.equal(two["provides.feature_x"]!.value, "#1 的 `feature_x` 要求 #2 的能力 CheckFeatureX ≥ 2");
    assert.equal(two["provides.feature_x"]!.evidence, "R-8 在 trunk 上新加了 CheckFeatureX：+ int CheckFeatureX()；它是 switches.feature_x 的 checker");
    assert.equal(w.store.state.notes["gcp-demo:1"]!["requires.2"]!.value, "#1 的 `feature_x` 要求 #2 的能力 CheckFeatureX ≥ 2");
    assert.match(headline(w, 1), /；前置 #2 还没外放$/);
    assert.match(headline(w, 2), /；给 #1 提供能力 CheckFeatureX$/);
    assert.deepEqual(commitments(w).filter((c) => c.key.startsWith("flagkey:")), [], "the text says 灰度, but a provider has no key to ask for");
  }));

test("a provider is done once out, without following any rollout; a commit and the day are an inferred release", () =>
  withWorld({ start: "2026-10-21 10:00", config: { rules: { "release-followup.mjs": exampleRule(CAPS) } } }, async (w) => {
    w.innerFlags.set("feature_x", { enabled: true, grey: 100, checker: ["CheckFeatureX", 2] });
    w.items.set("gcp-demo:1", keyed());
    w.items.set("gcp-demo:2", provider("release"));
    await w.run("2026-10-21 10:15");
    assert.equal(w.store.state.assessments["gcp-demo:2"]!.stage, "finished");
    assert.equal(headline(w, 2), "推断已外放（R-8 10-12 10:00 进 release，外放日到了）；给 #1 提供能力 CheckFeatureX");
    assert.equal(w.store.state.notes["gcp-demo:2"]!.releasedHow!.value, "inferred");
    assert.deepEqual(open(w, 2), []);
  }));

test("a provider going out wakes the issue that needs it, which then says so", () =>
  withWorld({ start: "2026-10-21 10:00", config: { rules: { "release-followup.mjs": exampleRule(CAPS) } } }, async (w) => {
    w.innerFlags.set("feature_x", { enabled: true, grey: 100, checker: ["CheckFeatureX", 2] });
    // Released far ahead and nobody touches it: cold.
    w.items.set("gcp-demo:1", keyed({ release: "2026-11-30" }));
    w.items.set("gcp-demo:2", provider("trunk"));
    await w.run("2026-10-21 10:15");
    assert.equal(w.store.state.assessments["gcp-demo:1"], undefined, "cold");
    w.items.set("gcp-demo:2", provider("release"));
    await w.run("2026-10-21 11:00");
    assert.equal(w.store.state.notes["gcp-demo:1"]!["woken.gcp-demo:2"]!.value, "前置 #2 推断已外放");
    assert.match(headline(w, 1), /；前置 #2 推断已外放$/);
    const status = w.statuses[w.statuses.length - 1] as { cases: Array<{ caseId: string; hot: string[] }> };
    assert.ok(status.cases.find((c) => c.caseId === "gcp-demo:1")!.hot.includes("前置 #2 推断已外放（10-21）"));
  }));

// Umbrella and standing issues, known by title (policy.coldTitles).
const umbrella = () => issue(9, { title: "【总单】示例功能", release: "2026-10-23", status: "开发中", lastHumanAt: "2026-10-20T10:00:00+08:00" });
const standing = () => issue(8, { title: "示例工具长期维护", release: "2026-10-23", status: "开发中", lastHumanAt: "2026-10-20T10:00:00+08:00" });
const statusOf = (w: World) => w.statuses[w.statuses.length - 1] as { cases: Array<{ caseId: string; hot: string[] }>; cold: Array<{ caseId: string }> };

test("an umbrella or standing issue is not made hot by a person's change or a near date", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.items.set("gcp-demo:9", umbrella());
    w.items.set("gcp-demo:8", standing());
    await w.run("2026-10-21 10:15");
    assert.equal(w.store.state.assessments["gcp-demo:9"], undefined);
    assert.equal(w.store.state.assessments["gcp-demo:8"], undefined);
    assert.deepEqual(statusOf(w).cold.map((c) => c.caseId).sort(), ["gcp-demo:8", "gcp-demo:9"]);
  }));

test("an umbrella issue on the watch list is hot, for that reason only", () =>
  withWorld({ start: "2026-10-21 10:00", config: { watch: [9] } }, async (w) => {
    w.items.set("gcp-demo:9", umbrella());
    await w.run("2026-10-21 10:15");
    assert.ok(w.store.state.assessments["gcp-demo:9"]);
    assert.deepEqual(statusOf(w).cases.find((c) => c.caseId === "gcp-demo:9")!.hot, ["在关注列表里"]);
  }));

test("the children of a cold umbrella issue are followed as usual, and still meet as siblings under it", () =>
  withWorld({ start: "2026-10-21 10:00", config: { rules: { "release-followup.mjs": exampleRule({ ...TEST_RULE_PARAMS, keyHint: "灰度" }) } } }, async (w) => {
    w.flags.set("feature_x", 10);
    w.items.set("gcp-demo:9", umbrella());
    w.items.set("gcp-demo:1", keyed({ parent: "gcp-demo:9" }));
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-23", status: "关闭", closed: true, parent: "gcp-demo:9", text: "配合灰度" }));
    await w.run("2026-10-21 10:15");
    assert.equal(w.store.state.assessments["gcp-demo:9"], undefined, "the umbrella itself stays cold");
    assert.equal(headline(w, 1), "灰度中：外网 10%");
    assert.equal(commitments(w).find((c) => c.key === "flagkey:gcp-demo:2")!.ask.question, "#2 的灰度 key 是不是 `feature_x`？");
  }));

// Released, checked in the background against each region's release branch and outward version file.
const VERSIONED = {
  ...TEST_RULE_PARAMS,
  graceWorkdays: 1,
  releaseCheck: "notice",
  regions: { default: ["main"], all: ["main", "second"], allWhen: [{ field: "Both", equals: "是" }] },
  regionNames: { main: "国服", second: "海外" },
  regionBranches: { second: ["release2"] },
  versionFiles: { main: "flags-demo:ver-main", second: "flags-demo:ver-second" },
  versionFields: { version: "version", revision: "rev", revisionRepo: "demo", builtAt: "built" },
};
// Committed on stable 10-12; the release branch got it with a copy on 10-21 21:12 (revision 160).
const copied = (inRelease: Record<string, { rev: number; at: string }> = { release: { rev: 160, at: "2026-10-21T13:12:00Z" } }) =>
  issue(1, {
    release: "2026-10-23",
    status: "关闭",
    closed: true,
    revisions: [{ id: "R-150", repo: "demo", branch: "stable", at: "2026-10-12T02:00:00Z", author: "甲", summary: "", added: [], in: { stable: { rev: 150, at: "2026-10-12T02:00:00Z" }, ...inRelease } }],
  });
const version = (minor: number, rev: number, built: string) => ({ version: `pub.demo.${built}.7.${minor}`, rev: String(rev), built });

test("confirmed out: the outward version is built from a revision that has the commit; nobody is asked", () =>
  withWorld({ start: "2026-10-22 10:00", config: { rules: { "release-followup.mjs": exampleRule(VERSIONED) } } }, async (w) => {
    w.versions.set("main", version(12, 100, "20261020201500"));
    w.items.set("gcp-demo:1", copied());
    await w.run("2026-10-22 10:15");
    assert.equal(headline(w, 1), "关闭，10-23 外放；R-150 10-21 21:12 进 release");
    w.versions.set("main", version(13, 170, "20261023083000"));
    await w.run("2026-10-23 09:30");
    assert.equal(headline(w, 1), "已外放（国服外网版本 7.12→7.13，包含 rev 160（R-150 10-21 21:12 进 release）），没有灰度 key，不跟灰度");
    assert.equal(w.store.state.notes["gcp-demo:1"]!["released.main"]!.value, "confirmed");
    assert.equal(w.store.state.notes["gcp-demo:1"]!.releasedHow!.value, "confirmed");
    assert.equal(w.cards.length, 0);
    // A revision from another repository is not compared with the file's: weak at best.
    w.items.set("gcp-demo:1", { ...copied(), revisions: copied().revisions!.map((r) => ({ ...r, repo: "other" })) });
    await w.run("2026-10-23 10:00");
    assert.equal(w.store.state.notes["gcp-demo:1"]!["released.main"]!.value, "weak");
  }));

test("weakly confirmed: built after the commit got there, but the file names no revision", () =>
  withWorld({ start: "2026-10-22 10:00", config: { rules: { "release-followup.mjs": exampleRule({ ...VERSIONED, versionFields: { version: "version", revision: null, builtAt: "built" } }) } } }, async (w) => {
    w.versions.set("main", version(12, 100, "20261020201500"));
    w.items.set("gcp-demo:1", copied());
    await w.run("2026-10-22 10:15");
    w.versions.set("main", version(13, 100, "20261023083000"));
    await w.run("2026-10-23 09:30");
    assert.equal(headline(w, 1), "已外放（国服外网版本 7.12→7.13（10-23 08:30 出包，在 R-150 10-21 21:12 进 release 之后；对不上 revision，弱证据）），没有灰度 key，不跟灰度");
    assert.equal(w.store.state.notes["gcp-demo:1"]!.releasedHow!.value, "weak");
  }));

test("one region's branch never gets the commit: after the grace a statement on a card with only 知道了; acknowledged, not said again; changed, said again", () =>
  withWorld({ start: "2026-10-23 10:00", config: { rules: { "release-followup.mjs": exampleRule(VERSIONED) } } }, async (w) => {
    w.versions.set("main", version(13, 170, "20261023083000"));
    w.versions.set("second", version(12, 100, "20261020201500"));
    w.items.set("gcp-demo:1", { ...copied(), fields: { Release: "2026-10-23", Both: "是" } });
    await w.run("2026-10-23 10:15");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.notice ?? null, null, "the release day itself: nothing to say yet");
    await w.run("2026-10-26 10:30");
    const a = w.store.state.assessments["gcp-demo:1"]!;
    assert.equal(a.stage, "awaiting-release");
    assert.match(a.notice!, /^#1 外放日 10-23 已过 \d 个工作日：海外 release2 里还没有这张单的提交，可能没赶上这班版本$/);
    const plans = (w.statuses as Array<{ plan: Array<{ kind: string; summary: string }> }>).flatMap((s) => s.plan);
    assert.equal(plans.filter((e) => e.kind === "notice").length, 1, "said once, when it first looks wrong");
    assert.equal(w.cards.length, 1, "and told, on a card");
    const [card] = w.cards;
    assert.equal(card!.card.title, "#1 外放日 10-23 之后：海外 release2 里还没有这张单的提交，可能没赶上这班版本");
    // The brief does not say the title a third time; it says how each region stands.
    assert.match(card!.content.brief, /^### #1 提醒：#1 外放提醒\n\n外放日 \*\*2026-10-23\*\* 已过 \d 个工作日。各地区现在的情况：/);
    assert.ok(!card!.content.brief.includes("可能没赶上这班版本"));
    const [q] = card!.content.questions;
    assert.deepEqual(q!.options.map((o) => o.label), ["知道了"]);
    assert.equal(q!.allowOther, true);
    w.answer({ "#1 提醒": "知道了" });
    await w.run("2026-10-28 10:30");
    assert.equal(w.cards.length, 1, "acknowledged: the same situation is not told again");
    assert.match(w.store.state.assessments["gcp-demo:1"]!.notice!, /（你 10-26 10:30 知道了）$/);
    // Now the other region has the commit, but its outward version has not moved for days: told again.
    w.items.set("gcp-demo:1", { ...copied({ release: { rev: 160, at: "2026-10-21T13:12:00Z" }, release2: { rev: 165, at: "2026-10-22T02:00:00Z" } }), fields: { Release: "2026-10-23", Both: "是" } });
    await w.run("2026-10-28 11:00");
    assert.equal(w.cards.length, 2);
    assert.equal(w.cards[1]!.card.title, "#1 外放日 10-23 之后：海外 release2 里 10-22 10:00 就有提交了，但外网版本 10-20 20:15 之后没动过");
    // A line of one's own is kept on the issue.
    w.answer({ "#1 提醒": "这个版本不赶了" });
    await w.run("2026-10-28 11:30");
    assert.equal(w.store.state.notes["gcp-demo:1"]!.noticeReply!.value, "这个版本不赶了");
    assert.equal(w.cards.length, 2);
  }));

test("on the release branch but the outward version does not move: inferred out, and said so", () =>
  withWorld({ start: "2026-10-23 10:00", config: { rules: { "release-followup.mjs": exampleRule(VERSIONED) } } }, async (w) => {
    w.versions.set("main", version(12, 100, "20261018200000"));
    w.items.set("gcp-demo:1", { ...copied({ release: { rev: 160, at: "2026-10-19T02:00:00Z" } }), fields: { Release: "2026-10-20" } });
    await w.run("2026-10-23 10:15");
    const a = w.store.state.assessments["gcp-demo:1"]!;
    assert.equal(a.headline, "推断已外放（R-150 10-19 10:00 进 release，外放日到了），没有灰度 key，不跟灰度");
    assert.equal(a.notice, "#1 外放日 10-20 已过 3 个工作日：国服 release 里 10-19 10:00 就有提交了，但外网版本 10-18 20:00 之后没动过");
    assert.equal(w.cards.length, 1);
    assert.equal(w.cards[0]!.card.title, "#1 外放日 10-20 之后：国服 release 里 10-19 10:00 就有提交了，但外网版本 10-18 20:00 之后没动过");
  }));

test("long past the release day nothing is said: too late to matter", () =>
  withWorld({ start: "2026-10-23 10:00", config: { watch: [1], rules: { "release-followup.mjs": exampleRule(VERSIONED) } } }, async (w) => {
    w.versions.set("main", version(12, 100, "20261018200000"));
    w.items.set("gcp-demo:1", { ...copied({}), fields: { Release: "2026-07-10" } });
    await w.run("2026-10-23 10:15");
    assert.equal(stage(w), "dropped");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.notice ?? null, null);
    assert.equal(commitments(w).length, 0);
  }));

// The release branch was frozen by copying stable at revision 159 on 10-21 21:12 (revision 160).
// Last seen, with no newer copy, two hours and more after it.
const FREEZE = { rev: 160, at: "2026-10-21T13:12:00Z", from: 159, seen: "2026-10-21T16:00:00Z" };
const onStable = (n: number, inRelease = false) => ({
  id: `R-${n}`,
  repo: "demo",
  branch: "stable",
  at: "2026-10-12T02:00:00Z",
  author: "甲",
  summary: "",
  added: [] as Array<[string, string]>,
  in: { stable: { rev: n, at: "2026-10-12T02:00:00Z" }, ...(inRelease ? { release: { rev: 160, at: FREEZE.at } } : {}) },
  copied: { release: FREEZE },
});
const frozen = (revisions: unknown[]) => issue(1, { release: "2026-10-23", status: "关闭", closed: true, revisions: revisions as never });

test("the freeze brought every commit of an issue due right after it: a fact, nothing said", () =>
  withWorld({ start: "2026-10-21 22:00", config: { rules: { "release-followup.mjs": exampleRule(VERSIONED) } } }, async (w) => {
    w.items.set("gcp-demo:1", frozen([onStable(150, true)]));
    await w.run("2026-10-22 11:00");
    assert.equal(w.store.state.notes["gcp-demo:1"]!["freeze.main"]!.value, "in");
    assert.match(w.store.state.notes["gcp-demo:1"]!["freeze.main"]!.evidence!, /^10-21 21:12 封版（release 从 stable@159 复制，rev 160）里有 R-150$/);
    assert.equal(stage(w), "awaiting-release");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.notice ?? null, null);
    assert.equal(w.cards.length, 0);
  }));

test("a commit the freeze did not bring: told at once, once; waits for the separate merge, and moves on when it lands", () =>
  withWorld({ start: "2026-10-21 22:00", config: { rules: { "release-followup.mjs": exampleRule(VERSIONED) } } }, async (w) => {
    w.items.set("gcp-demo:1", frozen([onStable(150, true), onStable(170)]));
    await w.run("2026-10-22 10:00");
    const said = "#1 没赶上 10-21 21:12 的封版：它在 stable 上的 R-170 不在这次复制里，后续要单独 merge release，否则赶不上 10-23 外放";
    assert.equal(w.cards.length, 1, "days before the release day");
    // The title is the short question (it fits a card title); the whole statement is in the brief.
    assert.equal(w.cards[0]!.card.title, "#1 赶不上 10-23 外放：R-170 没进 10-21 21:12 的封版，要单独 merge release");
    assert.ok(w.cards[0]!.card.title.length <= 80);
    assert.ok(w.cards[0]!.content.brief.includes(said.replace(/^#1 /, "")));
    assert.deepEqual(w.cards[0]!.content.questions[0]!.options.map((o) => o.label), ["知道了"]);
    assert.equal(stage(w), "awaiting-merge");
    assert.equal(headline(w, 1), "关闭，没赶上 10-21 21:12 的封版，等单独 merge release；10-23 外放");
    assert.equal(w.store.state.notes["gcp-demo:1"]!["freeze.main"]!.value, "missed");
    w.answer({ "#1 封版": "知道了" });
    await w.run("2026-10-22 16:00");
    assert.equal(w.cards.length, 1, "the same freeze is not told again");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.notice, `${said}（你 10-22 10:00 知道了）`);
    // Merged into the release branch on its own: on with the release.
    w.items.set("gcp-demo:1", frozen([onStable(150, true), onStable(170), { id: "R-175", repo: "demo", branch: "release", at: "2026-10-22T08:00:00Z", author: "甲", summary: "merge", added: [], in: { release: { rev: 175, at: "2026-10-22T08:00:00Z" } } }]));
    await w.run("2026-10-22 16:30");
    assert.equal(stage(w), "awaiting-release");
    assert.equal(headline(w, 1), "关闭，10-23 外放；R-175 10-22 16:00 进 release");
    assert.equal(w.store.state.notes["gcp-demo:1"]!["freeze.main"]!.value, "merged");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.notice ?? null, null);
    assert.equal(w.cards.length, 1);
  }));

test("with a freeze day expected, an earlier copy is a sync: nothing said; the copy on that day is the freeze", () =>
  withWorld({ start: "2026-10-21 22:00", config: { rules: { "release-followup.mjs": exampleRule({ ...VERSIONED, freezeExpected: "thu 21:00" }) } } }, async (w) => {
    w.items.set("gcp-demo:1", frozen([onStable(150, true), onStable(170)]));
    await w.run("2026-10-22 10:00");
    assert.equal(w.cards.length, 0, "Wednesday's copy for a Friday release");
    assert.equal(w.store.state.notes["gcp-demo:1"]!["freeze.main"], undefined);
    const thursday = { rev: 180, at: "2026-10-22T11:05:00Z", from: 165, seen: "2026-10-22T13:45:00Z" };
    w.items.set("gcp-demo:1", frozen([{ ...onStable(150, true), copied: { release: thursday } }, { ...onStable(170), copied: { release: thursday } }]));
    await w.run("2026-10-22 21:50");
    assert.equal(w.cards.length, 1);
    assert.equal(w.cards[0]!.card.title, "#1 赶不上 10-23 外放：R-170 没进 10-22 19:05 的封版，要单独 merge release");
  }));

test("a freeze is judged after a quiet while: a copy within it that brings the commit means nothing is said; still missing after it, told", () =>
  withWorld({ start: "2026-10-21 22:00", config: { rules: { "release-followup.mjs": exampleRule(VERSIONED) } } }, async (w) => {
    const copy = (seen: string) => ({ ...FREEZE, seen });
    w.items.set("gcp-demo:1", frozen([{ ...onStable(150, true), copied: { release: copy("2026-10-21T14:12:00Z") } }, { ...onStable(170), copied: { release: copy("2026-10-21T14:12:00Z") } }]));
    await w.run("2026-10-21 23:00");
    const freeze = () => w.store.state.notes["gcp-demo:1"]?.["freeze.main"]?.value;
    assert.equal(w.cards.length, 0, "an hour after the copy: not yet");
    assert.equal(freeze(), undefined);
    // Copied again within the quiet while, and this one brings it.
    const again = { rev: 175, at: "2026-10-21T15:00:00Z", from: 172, seen: "2026-10-21T17:30:00Z" };
    w.items.set("gcp-demo:1", frozen([{ ...onStable(150, true), copied: { release: again } }, { ...onStable(170), in: { stable: { rev: 170, at: "2026-10-12T02:00:00Z" }, release: { rev: 175, at: again.at } }, copied: { release: again } }]));
    await w.run("2026-10-22 11:00");
    assert.equal(w.cards.length, 0);
    assert.equal(freeze(), "in");
    // Still missing once the quiet while is over: told.
    w.items.set("gcp-demo:1", frozen([{ ...onStable(150, true), copied: { release: again } }, { ...onStable(180), copied: { release: again } }]));
    await w.run("2026-10-22 11:30");
    assert.equal(w.cards.length, 1);
    assert.equal(w.cards[0]!.card.title, "#1 赶不上 10-23 外放：R-180 没进 10-21 23:00 的封版，要单独 merge release");
  }));

test("dry-run: the notice card is only planned", () =>
  withWorld({ start: "2026-10-23 10:00", mode: "dry-run", config: { rules: { "release-followup.mjs": exampleRule(VERSIONED) } } }, async (w) => {
    w.versions.set("main", version(12, 100, "20261018200000"));
    w.items.set("gcp-demo:1", { ...copied({ release: { rev: 160, at: "2026-10-19T02:00:00Z" } }), fields: { Release: "2026-10-20" } });
    await w.run("2026-10-23 10:15");
    assert.equal(w.cards.length, 0);
    assert.match(plan(w, "card")[0]!.summary, /发问题卡给 测试用户：「#1 外放日 10-20 之后：/);
  }));

test("a commit on the release branch and the release day come: released without asking; a ready status counts like closed", () =>
  withWorld({ start: "2026-10-22 10:00" }, async (w) => {
    w.items.set(
      "gcp-demo:1",
      issue(1, {
        release: "2026-10-23",
        status: "merged",
        revisions: [{ id: "R-7", repo: "demo", branch: "release", at: "2026-10-20T10:00:00+08:00", author: "甲", summary: "merge", added: [] }],
      }),
    );
    await w.run("2026-10-22 10:00");
    assert.equal(stage(w), "awaiting-release");
    await w.run("2026-10-23 00:00", 60);
    assert.equal(stage(w), "finished");
    assert.match(w.store.state.assessments["gcp-demo:1"]!.headline, /^推断已外放（R-7 10-20 10:00 进 release，外放日到了），没有灰度 key，不跟灰度$/);
    assert.equal(w.cards.length, 0);
  }));

test("hot and cold: an old issue nobody works on is not judged or shown, until a key it names changes", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.flags.set("feature_z", 50);
    w.items.set("gcp-demo:1", issue(1, { release: "2026-07-10", status: "关闭", closed: true, text: "旧单 feature_z" }));
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-23", status: "关闭", closed: true }));
    await w.run("2026-10-21 10:00");
    assert.equal(stage(w, "gcp-demo:1"), undefined, "cold: never judged");
    assert.deepEqual(status(w).cold.map((c) => c.caseId), ["gcp-demo:1"]);
    assert.deepEqual(status(w).cases.map((c) => [c.caseId, c.hot]), [["gcp-demo:2", ["Release 10-23 在前后 14 天内"]]]);
    w.flags.set("feature_z", 0);
    await w.run("2026-10-21 10:30");
    assert.deepEqual(status(w).cases.map((c) => c.caseId).sort(), ["gcp-demo:1", "gcp-demo:2"]);
    assert.match(status(w).cases.find((c) => c.caseId === "gcp-demo:1")!.hot[0]!, /关联的开关 10-21 变过/);
    // Its earlier 50% was never judged, so 0 now reads as not started rather than rolled back.
    assert.equal(stage(w, "gcp-demo:1"), "rolling-out");
  }));

test("which listed rows are worth a full read", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-07-10", status: "关闭", closed: true }));
    await w.run("2026-10-21 10:00");
    const decide = w.lastPoll!.decide!;
    const row = (key: string, patch: Partial<Parameters<typeof decide>[0]> = {}) => decide({ key, title: "示例单", status: "关闭", updatedOn: "2026-10-21 09:00", changed: true, columns: { Release: "2026-07-10" }, ...patch });
    // Known and cold: an automation's touch is one look at the history; an old touch is nothing.
    assert.equal(row("gcp-demo:1"), "people");
    assert.equal(row("gcp-demo:1", { updatedOn: "2026-09-01 09:00" }), "skip");
    assert.equal(row("gcp-demo:1", { changed: false }), "skip");
    // A field that matters changed: read it.
    assert.equal(row("gcp-demo:1", { status: "重新打开" }), "full");
    assert.equal(row("gcp-demo:1", { columns: { Release: "2026-10-30" } }), "full");
    // Unknown and dated near today: read it.
    assert.equal(row("gcp-demo:9", { columns: { Release: "2026-10-25" } }), "full");
    // An umbrella issue: neither a near date nor a recent touch is worth a read.
    assert.equal(row("gcp-demo:7", { title: "【总单】示例", columns: { Release: "2026-10-25" } }), "skip");
    assert.equal(row("gcp-demo:7", { title: "【总单】示例" }), "skip");
  }));

test("dry-run plans the card and records nothing that would stop the live run from asking", () =>
  withWorld({ start: "2026-10-23 17:30", mode: "dry-run" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true }));
    await w.run("2026-10-23 18:00");
    assert.equal(w.cards.length, 0);
    const cards = plan(w, "card");
    assert.equal(cards.length, 1);
    assert.match(cards[0]!.summary, /发问题卡给 测试用户：「#1 外放了吗？」/);
    assert.equal(commitments(w)[0]!.status, "scheduled");
    assert.deepEqual(Object.keys(w.store.state.ledger).filter((k) => k.startsWith("ask:")), []);
    assert.equal(status(w).mode, "dry-run");

    await w.restart("live");
    await w.run("2026-10-23 18:15");
    assert.equal(w.cards.length, 1);
  }));

test("quiet hours defer the first ask to the next window", () =>
  withWorld({ start: "2026-10-23 20:30" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true }));
    await w.run("2026-10-23 20:30");
    assert.equal(w.cards.length, 0);
    assert.match(plan(w, "deferred")[0]!.summary, /不打扰时段，延到 10-26 09:30 再问 测试用户：#1/);
    await w.run("2026-10-26 09:15");
    assert.equal(w.cards.length, 0);
    await w.run("2026-10-26 09:30");
    assert.equal(w.cards.length, 1);
  }));

test("no answer: asked again each workday up to the limit, then the backstop ends it", () =>
  withWorld({ start: "2026-10-23 17:45" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true }));
    await w.run("2026-10-23 18:00");
    await w.run("2026-10-26 10:00");
    assert.equal(w.cards.length, 2);
    assert.match(w.cards[1]!.content.brief, /第 2 次问/);
    // The new card replaced the old one, whose carrier is archived.
    assert.equal(w.store.state.cards[w.cards[0]!.card.id]!.status, "closed");
    assert.ok(w.archived.includes(w.cards[0]!.agentId));
    await w.run("2026-10-27 10:00");
    assert.equal(w.cards.length, 3);
    await w.run("2026-10-30 17:45");
    assert.equal(w.cards.length, 3, "three rounds, no fourth");
    assert.equal(commitments(w)[0]!.status, "waiting");
    await w.run("2026-10-30 18:00");
    assert.equal(commitments(w)[0]!.status, "expired");
    // The backstop is applied after judging, so the assessment follows on the next tick.
    await w.run("2026-10-30 18:15");
    assert.equal(stage(w), "dropped");
    assert.deepEqual(status(w).cards, []);
    assert.ok(w.archived.includes(w.cards[2]!.agentId));
    assert.equal(w.store.state.evals, 2, "nag-ignored and commitment-expired");
  }));

test("dismissing is not an answer: the next round asks again", () =>
  withWorld({ start: "2026-10-23 17:45" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true }));
    await w.run("2026-10-23 18:00");
    assert.match(w.respond({ kind: "dismissed", via: "deny" }), /已收起/);
    assert.equal(commitments(w)[0]!.status, "waiting");
    await w.run("2026-10-26 10:00");
    assert.equal(w.cards.length, 2);
  }));

test("a typed answer with a new date moves the release, and the next ask goes to that day", () =>
  withWorld({ start: "2026-10-23 17:45" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true }));
    await w.run("2026-10-23 18:00");
    w.respond({ kind: "typed", text: "推迟到 10-30" });
    await w.run("2026-10-23 18:15");
    const [asked, moved] = commitments(w);
    assert.equal(asked!.answer!.option, null);
    assert.equal(asked!.answer!.text, "推迟到 10-30");
    assert.equal(moved!.key, "release:gcp-demo:1:2026-10-30");
    assert.deepEqual(moved!.trigger, { at: "2026-10-30T18:00:00+08:00" });
    assert.equal(w.store.state.notes["gcp-demo:1"]?.["plannedRelease.answered"]?.value, "2026-10-30");
    await w.run("2026-10-29 18:00");
    assert.equal(w.cards.length, 1);
    await w.run("2026-10-30 18:00");
    assert.equal(w.cards.length, 2);
  }));

test("asks due for one person at once go out on one card", () =>
  withWorld({ start: "2026-10-23 17:45" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true }));
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-23", status: "关闭", closed: true }));
    await w.run("2026-10-23 18:00");
    assert.equal(w.cards.length, 1);
    assert.equal(w.cards[0]!.card.title, "2 件事要你回答：#1、#2");
    w.answer({ "#2": "不用跟了" });
    await w.run("2026-10-23 18:15");
    assert.equal(stage(w, "gcp-demo:2"), "dropped");
    assert.equal(stage(w, "gcp-demo:1"), "awaiting-release", "an unanswered question on the card stays open");
  }));

test("after a restart, an open card gets a new carrier; the old one is archived", () =>
  withWorld({ start: "2026-10-23 17:45" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true }));
    await w.run("2026-10-23 18:00");
    await w.restart("live");
    assert.equal(w.cards.length, 2);
    assert.equal(w.cards[1]!.card.id, w.cards[0]!.card.id);
    assert.equal(w.cards[1]!.attempt, 2);
    assert.deepEqual(w.archived, [w.cards[0]!.agentId]);
    // The answer lands on the same card.
    w.answer({ "#1": "还没外放" });
    assert.equal(commitments(w)[0]!.status, "done");
  }));

test("a carrier that cannot start leaves the commitment to be asked again later", () =>
  withWorld({ start: "2026-10-23 17:45" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true }));
    w.fail.carrier = new Error("no workspace");
    await w.run("2026-10-23 18:00");
    assert.equal(w.cards.length, 0);
    assert.equal(commitments(w)[0]!.status, "scheduled");
    assert.ok(status(w).problems.some((p) => p.includes("no workspace")));
    w.fail.carrier = null;
    await w.run("2026-10-23 18:04", 1);
    assert.equal(w.cards.length, 0, "waits out the retry delay");
    await w.run("2026-10-23 18:05", 1);
    assert.equal(w.cards.length, 1);
  }));

test("a rule change that would create many commitments is held until released", () =>
  withWorld(
    {
      start: "2026-10-21 10:00",
      config: { rules: { "release-followup.mjs": exampleRule(TEST_RULE_PARAMS, "gcp-other") } },
    },
    async (w) => {
      for (const id of [1, 2, 3, 4]) w.items.set(`gcp-demo:${id}`, issue(id, { release: "2026-10-23", status: "关闭", closed: true }));
      await w.run("2026-10-21 10:00");
      assert.equal(commitments(w).length, 0);
      writeFileSync(path.join(w.configDir, "rules", "release-followup.mjs"), exampleRule(TEST_RULE_PARAMS));
      await w.run("2026-10-21 10:15");
      assert.equal(commitments(w).length, 0);
      const held = w.store.state.rules.held!;
      assert.equal(held.newCommitments, 4);
      assert.equal(plan(w, "held").filter((p) => p.summary.includes("排了：")).length, 4);
      assert.equal(stage(w), "awaiting-release", "assessments still follow the new rules");
      // Nor does it record what it concludes: a wrong rule would leave facts behind that outlive it.
      assert.ok(plan(w, "held").some((p) => p.summary.includes("记下事实 plannedRelease")));
      assert.equal(note(w, "plannedRelease"), undefined);
      assert.equal(w.engine.releaseRules("not-it"), false);
      assert.equal(w.engine.releaseRules(held.fingerprint), true);
      await w.run("2026-10-21 10:30");
      assert.equal(commitments(w).length, 4);
      assert.equal(w.store.state.rules.held, null);
      assert.equal(note(w, "plannedRelease")?.value, "2026-10-23");
      assert.equal(note(w, "plannedRelease")?.rules, held.fingerprint, "a fact carries the rules that wrote it");
    },
  ));

// A rule that asks one question per issue, and none for an issue flagged "drop".
const askingRule = (brief = "b", dropWhen = 'f.Flag === "drop"') => `export default { name: "mini", description: "x", applies: { source: "gcp-demo" }, params: {}, stages: ["s", "dropped"],
  assess(kase, ctx) {
    const f = kase.primary.fields;
    const dropped = ${dropWhen};
    const base = { stage: dropped ? "dropped" : "s", health: "waiting", headline: "h", next: { actor: "me", what: "x" }, facts: [] };
    if (dropped) return { ...base, commitments: [] };
    return { ...base, commitments: [{ key: "q:" + kase.id, title: "q " + kase.id, domain: "work", owner: "owner", trigger: { at: ctx.at("2026-10-16", "18:00") },
      ask: { header: kase.id, question: "q?", options: [{ id: "a", label: "A", description: "" }], allowOther: true },
      brief: "${brief}", nag: { everyWorkdays: 1, at: "10:00", max: 3 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }] };
  } };`;
// Each change is a new version of the issue, as the tracker would list it.
let flaggedVersion = 0;
const flagged = (id: number, flag: string) =>
  issue(id, { fields: { Release: "2026-10-16", Flag: flag }, sourceUpdatedAt: new Date(Date.parse("2026-10-12T10:00:00+08:00") + ++flaggedVersion * 60_000).toISOString() });
const heldNow = (w: World) => w.store.state.rules.held;

test("a commitment the rule stopped wanting is opened again when it wants it again, and goes on from the rounds asked", () =>
  withWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": askingRule() } } }, async (w) => {
    w.items.set("gcp-demo:1", flagged(1, ""));
    await w.run("2026-10-13 12:00");
    assert.equal(commitments(w)[0]!.status, "scheduled");
    // Asked once before it is dropped.
    await w.run("2026-10-16 18:00");
    assert.equal(w.cards.length, 1);
    assert.equal(commitments(w)[0]!.rounds, 1);
    w.items.set("gcp-demo:1", flagged(1, "drop"));
    await w.run("2026-10-16 18:30");
    assert.equal(commitments(w)[0]!.status, "cancelled");
    assert.equal(stage(w), "dropped");

    w.items.set("gcp-demo:1", flagged(1, ""));
    await w.run("2026-10-16 19:00");
    const [c] = commitments(w);
    assert.equal(commitments(w).length, 1, "the same commitment, not a new one");
    assert.equal(c!.reason, null);
    assert.ok(plan(w, "commitment").some((p) => p.summary.startsWith("重新排上：q gcp-demo:1")), "the plan says so");
    assert.ok(Object.keys(w.store.state.ledger).some((k) => k.startsWith(`reopen:${c!.id}:`)), "and the ledger records it");
    assert.ok(plan(w, "commitment").some((p) => p.summary.includes("接着之前问过的 1 次")));
    // Asked once before: not asked afresh, but nagged when the next round is due (Monday 10:00).
    assert.equal(w.cards.length, 1);
    assert.equal(c!.status, "waiting");
    assert.equal(c!.rounds, 1);
    await w.run("2026-10-19 10:00");
    assert.equal(w.cards.length, 2);
    assert.equal(commitments(w)[0]!.rounds, 2);
  }));

test("a judgment that flips back and forth does not ask a question asked to the end once more", () =>
  withWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": askingRule() } } }, async (w) => {
    w.items.set("gcp-demo:1", flagged(1, ""));
    await w.run("2026-10-20 10:00");
    assert.equal(w.cards.length, 3, "asked three times, unanswered");
    assert.equal(commitments(w)[0]!.rounds, 3);
    w.items.set("gcp-demo:1", flagged(1, "drop"));
    await w.run("2026-10-20 10:30");
    assert.equal(commitments(w)[0]!.status, "cancelled");
    w.items.set("gcp-demo:1", flagged(1, ""));
    await w.run("2026-10-23 18:00");
    const [c] = commitments(w);
    assert.equal(c!.status, "waiting", "open again");
    assert.equal(c!.rounds, 3);
    assert.equal(w.cards.length, 3, "and not asked three times more");
  }));

test("a commitment ended otherwise is not opened again", () =>
  withWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": askingRule() } } }, async (w) => {
    w.items.set("gcp-demo:1", flagged(1, ""));
    await w.run("2026-10-16 18:00");
    assert.match(w.answer({ "gcp-demo:1": "A" }), /已记下/);
    await w.run("2026-10-16 18:15");
    assert.equal(commitments(w)[0]!.status, "done");
    w.items.set("gcp-demo:1", flagged(1, "drop"));
    await w.run("2026-10-16 18:30");
    assert.equal(stage(w), "dropped");
    w.items.set("gcp-demo:1", flagged(1, ""));
    await w.run("2026-10-16 19:00");
    assert.equal(stage(w), "s");
    assert.equal(commitments(w)[0]!.status, "done", "an answered question stays answered");
  }));

test("a rule change that would take many questions back is held, and nothing is taken back until released", () =>
  withWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": askingRule() } } }, async (w) => {
    for (const id of [1, 2, 3, 4]) w.items.set(`gcp-demo:${id}`, flagged(id, ""));
    await w.run("2026-10-13 12:00");
    assert.equal(commitments(w).length, 4);
    // A wrong condition: every issue now reads as dropped.
    writeFileSync(path.join(w.configDir, "rules", "mini.mjs"), askingRule("b", 'f.Flag !== "drop"'));
    await w.run("2026-10-13 12:15");
    const held = w.store.state.rules.held!;
    assert.equal(held.dropped, 4);
    assert.equal(held.newCommitments, 0);
    assert.ok(commitments(w).every((c) => c.status === "scheduled"), "nothing taken back while held");
    assert.equal(plan(w, "held").filter((p) => p.summary.startsWith("判断方法改了先停着，没做：收回")).length, 4);
    assert.ok(w.store.state.evals > 0);
    // Put back: the held version is gone, nothing happened.
    writeFileSync(path.join(w.configDir, "rules", "mini.mjs"), askingRule());
    await w.run("2026-10-13 12:30");
    assert.equal(w.store.state.rules.held, null);
    assert.ok(commitments(w).every((c) => c.status === "scheduled"));
  }));

test("changed questions count against the breaker too; a few are not held", () =>
  withWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": askingRule() } } }, async (w) => {
    for (const id of [1, 2]) w.items.set(`gcp-demo:${id}`, flagged(id, ""));
    await w.run("2026-10-13 12:00");
    writeFileSync(path.join(w.configDir, "rules", "mini.mjs"), askingRule("b2"));
    await w.run("2026-10-13 12:15");
    assert.equal(heldNow(w), null, "two changes are under the limit of 3");
    assert.ok(commitments(w).every((c) => c.brief === "b2"));
    for (const id of [3, 4]) w.items.set(`gcp-demo:${id}`, flagged(id, ""));
    await w.run("2026-10-13 12:30");
    writeFileSync(path.join(w.configDir, "rules", "mini.mjs"), askingRule("b3"));
    await w.run("2026-10-13 12:45");
    assert.equal(heldNow(w)?.changed, 4);
    assert.ok(commitments(w).every((c) => c.brief === "b2"), "held: not changed");
  }));

test("a failing source goes degraded, then down, then stale; recovering clears it", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23" }));
    await w.run("2026-10-21 10:00");
    assert.equal(status(w).sources[0]!.state, "ok");
    w.fail.source = new Error("connection reset");
    await w.run("2026-10-21 10:30");
    assert.equal(status(w).sources[0]!.state, "degraded");
    await w.run("2026-10-21 13:00");
    assert.equal(status(w).sources[0]!.state, "down");
    await w.run("2026-10-21 17:00");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.stale, true);
    assert.equal(w.store.state.evals, 1, "down past sourceDownHours is an eval candidate, once");
    w.fail.source = null;
    await w.run("2026-10-21 19:00");
    assert.equal(status(w).sources[0]!.state, "ok");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.stale, false);
  }));

test("a test card goes to the admin on the next reconcile, inside the work window, and is answered like any other", () =>
  withWorld({ start: "2026-10-21 20:30" }, async (w) => {
    assert.equal(w.engine.testCard().ok, true);
    await w.run("2026-10-21 20:30");
    assert.equal(w.cards.length, 0, "not in quiet hours");
    await w.run("2026-10-22 09:30");
    assert.equal(w.cards.length, 1);
    assert.deepEqual(status(w).cards[0]!.caseIds, []);
    assert.match(w.cards[0]!.content.brief, /测试卡/);
    w.answer({ 测试: "都正常" });
    await w.run("2026-10-22 09:45");
    assert.equal(commitments(w)[0]!.status, "done");
    assert.deepEqual(w.archived, [w.cards[0]!.agentId]);
  }));

test("an issue closed long after its release day is not asked, and nothing is recorded as missed", () =>
  withWorld({ start: "2026-10-21 20:05" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-07-10外放", status: "关闭", closed: true }));
    // Released a week ago but still inside the backstop: asked, late.
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-16", status: "关闭", closed: true }));
    await w.run("2026-10-21 20:05");
    // Months past its release day and nobody on it: cold, not even judged.
    assert.equal(stage(w, "gcp-demo:1"), undefined);
    assert.ok(status(w).cold.some((c) => c.caseId === "gcp-demo:1"));
    assert.deepEqual(commitments(w).map((c) => c.key), ["release:gcp-demo:2:2026-10-16"]);
    assert.equal(w.store.state.evals, 0);
  }));

test("the engine itself does not create a commitment whose backstop has passed", () =>
  withWorld(
    {
      start: "2026-10-21 10:00",
      config: {
        rules: {
          "late.mjs": `export default {
  name: "late", description: "", applies: { source: "gcp-demo" }, params: {}, stages: ["x"],
  assess(kase, ctx) {
    const ask = { header: "h", question: "q", options: [{ id: "a", label: "a", description: "" }], allowOther: false };
    return { stage: "x", health: "waiting", headline: "h", next: { actor: "me", what: "" }, facts: [], commitments: [
      { key: "late:" + kase.id, title: "迟到的", domain: "work", owner: "owner", trigger: { at: ctx.at("2026-10-01", "10:00") }, ask, brief: "", nag: { everyWorkdays: 1, at: "10:00", max: 1 }, backstop: { at: ctx.at("2026-10-20", "10:00") }, level: "push" },
    ] };
  },
};
`,
        },
      },
    },
    async (w) => {
      w.items.set("gcp-demo:1", issue(1, { release: "2026-10-21" }));
      await w.run("2026-10-21 10:00");
      assert.equal(commitments(w).length, 0);
      assert.match(plan(w, "skipped")[0]!.summary, /没排：迟到的 的兜底时间 10-20 10:00 已经过了/);
      assert.equal(w.store.state.evals, 0);
    },
  ));

test("an item read before items kept text and commits: no question until it is read again, and the poll asks for it", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    const old = issue(1, { release: "2026-10-16", status: "关闭", closed: true });
    delete old.text;
    delete old.revisions;
    w.items.set("gcp-demo:1", old);
    // The second poll (at the 10:30 tick) is the first that knows the item.
    await w.run("2026-10-21 10:30");
    assert.equal(stage(w), "awaiting-release");
    assert.match(w.store.state.assessments["gcp-demo:1"]!.headline, /等重新读一遍单子和提交记录/);
    assert.equal(commitments(w).length, 0);
    assert.deepEqual(w.lastPoll!.watch, ["1"]);
    // The read brings text and commits but no field changes: it is still kept, and the item judged.
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-16", status: "关闭", closed: true }));
    await w.run("2026-10-21 11:00");
    assert.equal(w.store.state.items["gcp-demo:1"]!.text, "示例单 1");
    assert.doesNotMatch(w.store.state.assessments["gcp-demo:1"]!.headline, /等重新读/);
    assert.equal(commitments(w).length, 1, "now it can ask whether it went out");
    assert.equal(w.store.state.recent["gcp-demo:1"]?.length ?? 0, 0, "not an observation");
  }));

test("an outward version file that cannot be read does not hold back the freeze card, which rests on version control alone", () =>
  withWorld(
    {
      start: "2026-10-21 22:00",
      config: {
        rules: { "release-followup.mjs": exampleRule({ ...VERSIONED, versionFiles: { main: "ver-demo:main", second: "ver-demo:main" } }) },
        // Configured, never read.
        extraSources: [{ id: "ver-demo", kind: "flags", itemKind: "version", files: [{ id: "main", url: "https://ver.example/main.json", labels: {} }], sections: [""], activeHours: "daily 00:00-23:59", everyMinutes: 15, offHoursEveryMinutes: 15, maxCallsPerHour: 60, timeoutSeconds: 10, domain: "work" }],
      },
    },
    async (w) => {
      w.items.set("gcp-demo:1", frozen([onStable(150, true), onStable(170)]));
      await w.run("2026-10-22 10:00");
      assert.equal(w.store.state.assessments["gcp-demo:1"]!.stale, true, "the judgment read the version file");
      assert.equal(w.cards.length, 1);
      assert.match(w.cards[0]!.card.title, /^#1 赶不上 10-23 外放：R-170 没进 10-21 21:12 的封版/);
    },
  ));

test("an issue read before, then kept without a new commit that could not be read: the mark reaches the journal, nothing is said on it, and the page says why", () =>
  withWorld({ start: "2026-10-21 22:00", config: { rules: { "release-followup.mjs": exampleRule(VERSIONED) } } }, async (w) => {
    w.items.set("gcp-demo:1", frozen([onStable(150, true)]));
    await w.run("2026-10-22 09:00");
    assert.equal(w.store.state.items["gcp-demo:1"]!.incomplete, undefined);
    // Its next read: a second commit, on a branch that cannot be read; everything else the same.
    w.items.set("gcp-demo:1", { ...frozen([onStable(150, true)]), incomplete: ["R-170: svn: E170001: Authorization failed"] });
    await w.run("2026-10-22 10:00");
    assert.deepEqual(w.store.state.items["gcp-demo:1"]!.incomplete, ["R-170: svn: E170001: Authorization failed"]);
    assert.equal(w.cards.length, 0);
    assert.ok(status(w).problems.some((p) => /^gcp-demo:1 有提交一直读不到，按读到的判断（不据此提醒）：R-170/.test(p)));
  }));
