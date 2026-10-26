import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { capsuleFiles, loadCapsules, readCapsule, writeCapsule, type Capsule, type Expect } from "../server/capsule";
import { keepCase, listCases, readExpect, replayOnly, setExpect } from "../server/cases";
import { applyCandidate, copyConfig, preview, previewText, PreviewError, type Preview } from "../server/preview";
import { replayCapsules, replayDigest, replayLines } from "../server/replay-report";
import { capture, cleanDemos, demoRuleText, loadDemo, type DemoParams, type World0 } from "./replay-helpers";
import { makeWorld, TEST_POLICY, TZ, type World } from "./helpers";

// Past judgments in the preview: the capsules (in the data directory and among the config's cases)
// asked of the rules in use and of the candidate, what that adds to a preview and its id, what a
// person said was right, and what stops an apply. The demo rule is replay-helpers.ts's; every
// name, number and time is made up.

// apply makes its copy of the candidate under the system temp directory, and preview.test.ts counts
// those copies before and after one of its own: test files run side by side, so this one keeps its
// temp files (and the commands it starts) to a directory of its own.
const outerTmp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
const ownTmp = mkdtempSync(path.join(os.tmpdir(), "reconcile-replay-tmp-"));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = ownTmp;

after(() => {
  cleanDemos();
  for (const [name, value] of Object.entries(outerTmp)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(ownTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "reconcile-preview.mjs");
const person = { owner: { name: "测试用户", admin: true, tz: TZ, quiet: { work: "workdays 09:30-20:00" }, pushPerDay: 8 } };
const RULE_FILE = "rules/demo.mjs";

interface Tools {
  w: World;
  candidate: string;
  /** Capsules made from the rule text given (the demo's), kept in the data directory. */
  keep: (when: string, params?: DemoParams, more?: World0 & { correction?: boolean; to?: string }) => Promise<Capsule>;
  /** The candidate's rule: the demo with these params. */
  candidateRule: (params?: DemoParams, text?: string) => void;
  look: (more?: { workdays?: number }) => Promise<Preview>;
}

async function withDemo(body: (t: Tools) => Promise<void>, options: { inUse?: string } = {}) {
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "demo.mjs": options.inUse ?? demoRuleText() }, policy: TEST_POLICY, persons: person } });
  const candidate = mkdtempSync(path.join(os.tmpdir(), "reconcile-candidate-"));
  try {
    await w.run("2026-10-13 10:05");
    rmSync(candidate, { recursive: true });
    copyConfig(w.configDir, candidate);
    const tools: Tools = {
      w,
      candidate,
      keep: async (when, params, more = {}) => {
        const c = capture(await loadDemo(demoRuleText(params)), when, more);
        const made: Capsule = more.correction
          ? { ...c, trigger: ["wrong"], correction: { annotation: "an_1", said: "不是外放，是内测", what: "外放了吗", expected: null, at: c.at, by: "owner" } }
          : c;
        writeCapsule(more.to ?? path.join(w.dataDir, "capsules"), made);
        return made;
      },
      candidateRule: (params, text) => writeFileSync(path.join(candidate, RULE_FILE), text ?? demoRuleText(params)),
      look: (more = {}) => preview({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now, ...more }),
    };
    await body(tools);
  } finally {
    try {
      w.close();
    } finally {
      rmSync(candidate, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

/** Every file under a directory, with its size and modified time. */
const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const full = path.join(e.parentPath, e.name);
      return `${path.relative(dir, full)} ${statSync(full).size} ${statSync(full).mtimeMs}`;
    })
    .sort();

test("a candidate that judges a past moment differently shows it in the preview, though nothing live differs; with nothing different, nothing", () =>
  withDemo(async (t) => {
    await t.keep("2026-10-13 10:00");
    await t.keep("2026-10-14 11:00", {}, { trigger: ["first"] });
    const same = await t.look();
    assert.equal(same.replay.capsules, 2);
    assert.equal(same.replay.applicable, 2);
    assert.equal(same.empty, true, "two capsules the two sides judge alike are no difference");
    assert.match(previewText(same), /存档 2 份.*没有差异：每份存档在两版下得到同样的判断/s);

    // A change of wording only: the headline and a fact, no judgment.
    t.candidateRule({ verb: "上线" });
    const worded = await t.look();
    assert.equal(worded.empty, false, "the live data has no items; only the capsules differ");
    assert.equal(worded.replay.changed.length, 2);
    assert.deepEqual(worded.replay.changed[0]!.diff.judgment, []);
    assert.ok(worded.replay.changed[0]!.diff.text.some((d) => d.field === "现状" && d.before.includes("外放") && d.after.includes("上线")), JSON.stringify(worded.replay.changed[0]!.diff.text));
    assert.ok(worded.replay.changed[0]!.diff.facts.some((d) => d.field === "seen"));
    assert.notEqual(worded.id, same.id);
    assert.doesNotMatch(previewText(worded), /判断变了/);
    assert.match(previewText(worded), /记下的事实不同（2 份）：seen×2/);

    // A different judgment: the question is asked on another day.
    t.candidateRule({ grace: 3 });
    const judged = await t.look();
    assert.equal(judged.replay.changed.length, 2);
    assert.ok(judged.replay.changed[0]!.diff.judgment.length > 0);
    const text = previewText(judged);
    assert.match(text, /判断变了（2 份，1 个事项；在用 → 候选）：\n- #1 示例单 1 10-13 10:00（换阶段）/);
    assert.match(text, /  问题 ask:gcp-demo:1:2026-10-14：要问「示例单 1 外放了吗？」 → 没有/);
    assert.notEqual(judged.id, worded.id);
  }));

test("the id follows what differs between the two sides, not how many capsules there are", () =>
  withDemo(async (t) => {
    const none = await t.look();
    await t.keep("2026-10-13 10:00");
    await t.keep("2026-10-14 11:00");
    assert.equal((await t.look()).id, none.id, "capsules both sides judge alike are not in it");

    t.candidateRule({ verb: "上线" });
    const two = await t.look();
    assert.equal((await t.look()).id, two.id, "the same difference, the same id");
    await t.keep("2026-10-15 12:00");
    const three = await t.look();
    assert.notEqual(three.id, two.id, "one more capsule it differs on");
    // The same candidate, a different difference: another id.
    t.candidateRule({ verb: "内测" });
    assert.notEqual((await t.look()).id, three.id);
  }));

test("a side that asked for what the capsule never saw is told so and not counted as changed", () =>
  withDemo(async (t) => {
    await t.keep("2026-10-13 10:00");
    t.candidateRule({ peek: "gcp-demo:99" });
    const p = await t.look();
    assert.equal(p.replay.missing.length, 1);
    assert.deepEqual(p.replay.missing[0]!.sides, ["candidate"]);
    assert.ok(p.replay.missing[0]!.calls.length > 0);
    assert.deepEqual(p.replay.changed, [], "its answer is not counted");
    assert.equal(p.empty, false);
    assert.match(previewText(p), /回放缺数据（候选读了存档里没有的：/);
  }));

test("what goes into a preview's id from the replay: what differs and what is amiss with it, not what only counts", async () => {
  const inUse = await loadDemo(demoRuleText());
  const lacking = await loadDemo(demoRuleText({ peek: "gcp-demo:99" }));
  const plain = capture(inUse, "2026-10-13 10:00");
  const digest = (...args: Parameters<typeof replayCapsules>) => replayDigest(replayCapsules(...args)) as Record<string, unknown[]>;
  assert.deepEqual(digest([plain], [inUse], [lacking]).missing.map((m) => (m as unknown[])[0]), [plain.id], "a side that read what the capsule lacks");
  const alike = digest([plain], [inUse], [inUse]);
  assert.deepEqual(Object.values(alike).flat(), [], "alike on both sides: nothing");
  // Counted in the report, not in the id.
  const never = capture(inUse, "2026-10-13 11:00", { expect: { headline: { has: ["从来不会有"] } } });
  const pending: Capsule = { ...capture(inUse, "2026-10-13 12:00"), correction: { annotation: "an_2", said: "x", what: null, expected: null, at: "2026-10-13T12:00:00+08:00", by: "owner" } };
  const report = replayCapsules([plain, never, pending], [inUse], [inUse]);
  assert.equal(report.expect.stillBroken.length, 1);
  assert.equal(report.expect.pending.length, 1);
  assert.deepEqual(replayDigest(report), replayDigest(replayCapsules([plain], [inUse], [inUse])), "neither is in it");
  // A broken correction is.
  const kept = capture(inUse, "2026-10-13 13:00", { expect: { headline: { has: ["外放"] } } });
  const worse = await loadDemo(demoRuleText({ verb: "上线" }));
  assert.deepEqual(digest([kept], [inUse], [worse]).broken.map((b) => (b as unknown[])[0]), [kept.id]);
});

test("a candidate that fails on a past moment is warned at the top, before the replay section", () =>
  withDemo(async (t) => {
    await t.keep("2026-10-13 10:00");
    t.candidateRule({ boom: true });
    const p = await t.look();
    assert.deepEqual(p.replay.errors.map((e) => e.side), ["candidate"]);
    assert.match(p.replay.errors[0]!.error, /boom/);
    const lines = previewText(p).split("\n");
    assert.match(lines.find((l) => l.startsWith("⚠ 候选在这份存档上判断出错")) ?? "", /boom/);
    assert.ok(lines.findIndex((l) => l.startsWith("⚠ 候选在这份存档上")) < lines.findIndex((l) => l.startsWith("## 拿过去的判断时刻重放")), "warned before the section");
  }));

test("a warning list cut at ten says how many it leaves out", () =>
  withDemo(async (t) => {
    const minute = (i: number) => `2026-10-13 10:${String(i).padStart(2, "0")}`;
    for (let i = 0; i < 12; i++) await t.keep(minute(i), {}, { correction: true, expect: { headline: { has: ["外放"] } } });
    t.candidateRule({ boom: true });
    const lines = previewText(await t.look()).split("\n");
    assert.equal(lines.filter((l) => l.startsWith("⚠ 纠错又犯了")).length, 10);
    assert.ok(lines.includes("⚠ 还有 2 条纠错又犯了"));
    assert.equal(lines.filter((l) => l.startsWith("⚠ 候选在这份存档上判断出错")).length, 10);
    assert.ok(lines.includes("⚠ 还有 2 份存档上候选也判断出错"));
  }));

test("a self-check list cut at ten says how many it leaves out", () =>
  withDemo(async (t) => {
    const kept = path.join(t.w.dir, "kept");
    const rule = await loadDemo(demoRuleText());
    for (let i = 0; i < 11; i++) {
      const c = capture(rule, `2026-10-13 10:${String(i).padStart(2, "0")}`);
      writeCapsule(kept, { ...c, outcome: { ...c.outcome, output: { ...c.outcome.output!, headline: "别的话" } } });
    }
    t.candidateRule({});
    const p = await preview({ configDir: t.w.configDir, candidateDir: t.candidate, dataDir: t.w.dataDir, nowMs: t.w.clock.now, casesDirs: [kept] });
    assert.equal(p.replay.selfCheck.length, 11);
    const lines = previewText(p).split("\n");
    assert.equal(lines.filter((l) => l.startsWith("⚠ 存档复现不了")).length, 10);
    assert.ok(lines.includes("⚠ 还有 1 份存档复现不了"));
  }));

test("the rule in use failing on a capsule where the candidate does not is said, not warned as the candidate's", () =>
  withDemo(
    async (t) => {
      await t.keep("2026-10-13 10:00");
      t.candidateRule({});
      const p = await t.look();
      assert.deepEqual(p.replay.errors.map((e) => e.side), ["inUse"]);
      const text = previewText(p);
      assert.match(text, /在用的在这份存档上判断出错、候选不出错/);
      assert.doesNotMatch(text, /⚠ 候选在这份存档上/);
    },
    { inUse: demoRuleText({ boom: true }) },
  ));

test("a candidate that does not load: the replay asks the rules in use alone and says so", () =>
  withDemo(async (t) => {
    await t.keep("2026-10-13 10:00");
    t.candidateRule({}, "export default {");
    const p = await t.look();
    assert.ok(p.candidate.errors.length > 0);
    assert.equal(p.replay.candidate, "broken");
    assert.deepEqual(p.replay.changed, []);
    assert.deepEqual(p.replay.noRule, [], "a candidate with no rules loaded is not one that has no rule for the item");
    assert.equal(p.replay.applicable, 1, "the rule in use still judges it");
    assert.match(previewText(p), /候选的判断方法加载不上，只拿在用的判断一遍/);
  }));

test("what people said was right: a correction said again is warned, one put right is told, one still wrong or not yet written is listed", () =>
  withDemo(async (t) => {
    const a = await t.keep("2026-10-13 10:00", {}, { correction: true, expect: { headline: { has: ["外放"] } } });
    const b = await t.keep("2026-10-13 11:00", {}, { correction: true, expect: { headline: { not: ["外放"] } } });
    const c = await t.keep("2026-10-13 12:00", {}, { correction: true, expect: { headline: { has: ["从来不会有"] } } });
    const d = await t.keep("2026-10-13 13:00", {}, { correction: true });
    t.candidateRule({ verb: "上线" });
    const p = await t.look();
    assert.deepEqual(p.replay.expect.broken.map((e) => e.id), [a.id], "the rule in use meets it, the candidate does not");
    assert.deepEqual(p.replay.expect.fixed.map((e) => e.id), [b.id], "the rule in use does not, the candidate does");
    assert.deepEqual(p.replay.expect.stillBroken.map((e) => e.id), [c.id]);
    assert.deepEqual(p.replay.expect.pending.map((e) => e.id), [d.id]);
    assert.equal(p.empty, false);
    const text = previewText(p);
    const warning = text.split("\n").find((l) => l.startsWith("⚠ 纠错又犯了")) ?? "";
    assert.match(warning, new RegExp(`#1 示例单 1 10-13 10:00（${a.id}）`));
    assert.match(warning, /说过：「不是外放，是内测」/);
    assert.match(text, /修好了 1 条纠错/);
    assert.match(text, /还没修好的纠错 1 条/);
    assert.match(text, new RegExp(`还没写 expect 的纠错 1 条：.*${d.id}`));
    assert.ok(text.indexOf("⚠ 纠错又犯了") < text.indexOf("## 拿过去的判断时刻重放"));
    // Told in the id: another candidate that breaks it differently is another preview.
    t.candidateRule({ verb: "内测" });
    assert.notEqual(p.id, (await t.look()).id);
  }));

test("an expectation the rule could not be asked about (it read what the capsule lacks) gives no verdict", () =>
  withDemo(async (t) => {
    const a = await t.keep("2026-10-13 10:00", {}, { correction: true, expect: { stage: "open" } });
    t.candidateRule({ peek: "gcp-demo:99" });
    const p = await t.look();
    assert.deepEqual(p.replay.expect.unknown.map((e) => e.id), [a.id]);
    assert.deepEqual(p.replay.expect.broken, []);
    assert.match(previewText(p), /有 expect、但有一边读了存档里没有的数据，不下结论/);
  }));

test("apply: a correction said again is not copied unless named; a name that is not one is refused; the rest of the id still counts", () =>
  withDemo(async (t) => {
    const a = await t.keep("2026-10-13 10:00", {}, { correction: true, expect: { headline: { has: ["外放"] } } });
    const inUse = readFileSync(path.join(t.w.configDir, RULE_FILE), "utf8");
    t.candidateRule({ verb: "上线" });
    const p = await t.look();
    const base = { configDir: t.w.configDir, candidateDir: t.candidate, dataDir: t.w.dataDir, nowMs: t.w.clock.now, expect: p.id };

    await assert.rejects(applyCandidate(base), (e: Error) => e instanceof PreviewError && /候选让 1 条纠错又犯了，没拷/.test(e.message) && e.message.includes(a.id) && e.message.includes(`--accept-regress ${a.id}`));
    await assert.rejects(applyCandidate({ ...base, acceptRegress: [] }), PreviewError);
    assert.equal(readFileSync(path.join(t.w.configDir, RULE_FILE), "utf8"), inUse, "nothing copied");

    await assert.rejects(applyCandidate({ ...base, acceptRegress: [a.id, "k_0000000000000000"] }), (e: Error) => e instanceof PreviewError && /k_0000000000000000 不是这次纠错又犯了的存档/.test(e.message));
    assert.equal(readFileSync(path.join(t.w.configDir, RULE_FILE), "utf8"), inUse, "nothing copied");

    // Named, but for a preview that is not this one: the id is checked first and nothing is copied.
    const other = await applyCandidate({ ...base, expect: "p_0000000000", acceptRegress: [a.id] });
    assert.deepEqual(other.applied, []);
    assert.equal(readFileSync(path.join(t.w.configDir, RULE_FILE), "utf8"), inUse);

    const done = await applyCandidate({ ...base, acceptRegress: [a.id] });
    assert.deepEqual(done.applied, [RULE_FILE]);
    assert.equal(readFileSync(path.join(t.w.configDir, RULE_FILE), "utf8"), demoRuleText({ verb: "上线" }));
    assert.equal(os.tmpdir(), ownTmp, "the copy apply makes is made here, not beside another test file's");
    assert.deepEqual(readdirSync(ownTmp).filter((f) => f.startsWith("reconcile-apply-")), [], "and is gone");
  }));

test("apply: with two corrections said again, naming one is not enough", () =>
  withDemo(async (t) => {
    const a = await t.keep("2026-10-13 10:00", {}, { correction: true, expect: { headline: { has: ["外放"] } } });
    const b = await t.keep("2026-10-13 11:00", {}, { correction: true, expect: { stage: "waiting" } });
    // The second is said again by a candidate that keeps the item in "open" though its peer is closed.
    t.candidateRule(undefined, demoRuleText({ verb: "上线" }).replace('peer && peer.closed ? "waiting" : "open"', '"open"'));
    const p = await t.look();
    assert.deepEqual(p.replay.expect.broken.map((e) => e.id).sort(), [a.id, b.id].sort());
    const base = { configDir: t.w.configDir, candidateDir: t.candidate, dataDir: t.w.dataDir, nowMs: t.w.clock.now, expect: p.id };
    await assert.rejects(applyCandidate({ ...base, acceptRegress: [a.id] }), (e: Error) => e instanceof PreviewError && /候选让 1 条纠错又犯了/.test(e.message) && e.message.includes(b.id) && !e.message.includes(`（${a.id}）`));
    const done = await applyCandidate({ ...base, acceptRegress: [b.id, a.id] });
    assert.deepEqual(done.applied, [RULE_FILE]);
  }));

test("apply: a correction put right, or an expectation unmet on both sides, does not stop it", () =>
  withDemo(async (t) => {
    await t.keep("2026-10-13 10:00", {}, { correction: true, expect: { headline: { not: ["外放"] } } });
    await t.keep("2026-10-13 11:00", {}, { correction: true, expect: { headline: { has: ["从来不会有"] } } });
    t.candidateRule({ verb: "上线" });
    const p = await t.look();
    assert.equal(p.replay.expect.broken.length, 0);
    const done = await applyCandidate({ configDir: t.w.configDir, candidateDir: t.candidate, dataDir: t.w.dataDir, nowMs: t.w.clock.now, expect: p.id });
    assert.deepEqual(done.applied, [RULE_FILE]);
  }));

test("the rule that made a capsule, asked again of its tape, has to give what it gave: when it does not, the replay is warned as untrustworthy", () =>
  withDemo(async (t) => {
    // Made by the very rule in use (same text); what it said is kept, with its words changed since.
    const c = await t.keep("2026-10-13 10:00");
    const said = c.outcome.output!;
    const tampered: Capsule = { ...c, outcome: { ...c.outcome, output: { ...said, headline: "别的话" } } };
    rmSync(path.join(t.w.dataDir, "capsules"), { recursive: true });
    writeCapsule(path.join(t.w.dataDir, "capsules"), tampered);
    const p = await t.look();
    assert.equal(p.replay.changed.length, 0, "the two sides are alike; only the replay itself is amiss");
    assert.equal(p.replay.selfChecked, 1);
    assert.equal(p.replay.selfCheck.length, 1);
    assert.deepEqual(p.replay.selfCheck[0]!.fields, ["现状"]);
    assert.match(previewText(p), /其中 1 份是在用的这一版判断方法存下的，拿存档再判断一遍：1 份和存下的不一样（见 ⚠）/);
    assert.equal(p.empty, false, "a preview that cannot trust its replay is not an empty one");
    assert.match(previewText(p), /^⚠ 存档复现不了：#1 示例单 1 10-13 10:00/m);
    assert.equal((await replayOnly({ configDir: t.w.configDir, dataDir: t.w.dataDir })).selfCheck.length, 1, "replay alone says it too");
    rmSync(path.join(t.w.dataDir, "capsules"), { recursive: true });
    writeCapsule(path.join(t.w.dataDir, "capsules"), c);
    const sound = await t.look();
    assert.equal(sound.replay.selfCheck.length, 0);
    assert.equal(sound.replay.selfChecked, 1);
    assert.match(previewText(sound), /拿存档再判断一遍：答案和存下的一样。/);
    assert.equal(sound.empty, true);
    assert.notEqual(p.id, sound.id, "told in the id");
  }));

test("a capsule made by another version of the rule than the one in use is not held to what it said then", () =>
  withDemo(async (t) => {
    await t.keep("2026-10-13 10:00", { verb: "内测" });
    const p = await t.look();
    assert.deepEqual(p.replay.selfCheck, []);
    assert.equal(p.empty, true, "both sides are the rule in use");
    assert.match(previewText(p), /没有差异：每份存档在两版下得到同样的判断/);
    const alone = await replayOnly({ configDir: t.w.configDir, dataDir: t.w.dataDir });
    assert.equal(alone.candidate, "none");
    assert.deepEqual(alone.selfCheck, []);
    assert.equal(alone.selfChecked, 0, "none was made by this version, so none was held to anything");
    assert.equal(p.replay.selfChecked, 0);
    const lines = replayLines(alone).join("\n");
    assert.match(lines, /没有一份是在用的这一版判断方法存下的（存下它们的判断方法后来改过），存档里记的答案没拿来核对/);
    assert.doesNotMatch(lines, /和存下的一样/, "no claim that was not checked");
  }));

test("capsules are read from the data directory and from the config's cases/; one that cannot be read is listed and nothing else stops", () =>
  withDemo(async (t) => {
    await t.keep("2026-10-13 10:00");
    await t.keep("2026-10-14 10:00", {}, { to: path.join(t.w.configDir, "cases") });
    const bad = path.join(t.w.dataDir, "capsules", "gcp-demo_1");
    writeFileSync(path.join(bad, "broken.json.gz"), "not gzip");
    t.candidateRule({ verb: "上线" });
    const p = await t.look();
    assert.equal(p.replay.capsules, 2);
    assert.equal(p.replay.changed.length, 2);
    assert.equal(p.replay.unreadable.length, 1);
    assert.match(previewText(p), /读不了的存档 1 份：gcp-demo_1\/broken\.json\.gz/);
    // Narrowed on purpose (a different place to read from).
    const narrowed = await preview({ configDir: t.w.configDir, candidateDir: t.candidate, dataDir: t.w.dataDir, nowMs: t.w.clock.now, casesDirs: [path.join(t.w.configDir, "cases")] });
    assert.equal(narrowed.replay.capsules, 1);
  }));

test("with no capsules, the preview says where they come from", () =>
  withDemo(async (t) => {
    const p = await t.look();
    assert.equal(p.replay.capsules, 0);
    assert.equal(p.empty, true);
    assert.match(previewText(p), /没有存档（数据目录的 capsules\/ 和配置目录的 cases\/ 里都没有）：reconcile-preview cases backfill/);
  }));

test("the preview and the replay read capsules and write nothing", () =>
  withDemo(async (t) => {
    await t.keep("2026-10-13 10:00", {}, { correction: true, expect: { headline: { has: ["外放"] } } });
    await t.keep("2026-10-14 10:00", {}, { to: path.join(t.w.configDir, "cases") });
    t.candidateRule({ verb: "上线" });
    const before = [tree(t.w.dataDir), tree(t.w.configDir), tree(t.candidate)];
    await t.look();
    await replayOnly({ configDir: t.w.configDir, dataDir: t.w.dataDir, candidateDir: t.candidate });
    listCases({ configDir: t.w.configDir, dataDir: t.w.dataDir });
    assert.deepEqual([tree(t.w.dataDir), tree(t.w.configDir), tree(t.candidate)], before);
  }));

test("copy does not take the config's cases/ along: they are not a part of what is changed", () =>
  withDemo(async (t) => {
    await t.keep("2026-10-13 10:00", {}, { to: path.join(t.w.configDir, "cases") });
    const to = path.join(t.w.dir, "copy-out");
    const files = copyConfig(t.w.configDir, to);
    assert.ok(files.length > 0);
    assert.ok(!files.some((f) => f.startsWith("cases")), files.join());
    assert.equal(readdirSync(to).includes("cases"), false);
  }));

test("cases: list says where each is and what a person said of it; keep puts one among the config's cases as plain JSON, once; expect is set in its own file", () =>
  withDemo(async (t) => {
    const made = await t.keep("2026-10-13 10:00", {}, { correction: true });
    const plain = await t.keep("2026-10-14 10:00");
    const options = { configDir: t.w.configDir, dataDir: t.w.dataDir };
    const rows = listCases(options);
    assert.deepEqual(rows.map((r) => [r.id, r.where, r.correction, r.expect]), [[made.id, "data", true, false], [plain.id, "data", false, false]]);
    assert.deepEqual(listCases({ ...options, item: "#1" }).length, 2);
    assert.deepEqual(listCases({ ...options, item: "gcp-demo:1" }).length, 2);
    assert.deepEqual(listCases({ ...options, item: "99" }), []);

    await assert.rejects(async () => keepCase({ ...options, id: "x" }), /不像存档的编号/);
    await assert.rejects(async () => keepCase({ ...options, id: "k_0000000000000000" }), /capsules\/ 里没有 k_0000000000000000/);
    const expect: Expect = { headline: { has: ["内测"] }, stage: ["open", "waiting"] };
    const file = keepCase({ ...options, id: made.id, expect });
    assert.equal(file.startsWith(path.join(t.w.configDir, "cases")), true);
    assert.match(file, /\.json$/, "plain, not gz: anyone can read it and git can show a change");
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes("\n  "), "indented");
    const kept = readCapsule(file);
    assert.ok("capsule" in kept);
    assert.deepEqual((kept as { capsule: Capsule }).capsule.expect, expect);
    assert.equal((kept as { capsule: Capsule }).capsule.id, made.id);
    assert.throws(() => keepCase({ ...options, id: made.id }), /已经在 cases\/ 里了：要改 expect 用 cases expect/);

    // Now listed once, as the config's.
    assert.deepEqual(listCases(options).map((r) => [r.id, r.where, r.expect]), [[made.id, "cases", true], [plain.id, "data", false]]);
    assert.equal(loadCapsules([path.join(t.w.dataDir, "capsules"), path.join(t.w.configDir, "cases")]).capsules.length, 2);

    // expect: replaced in the same file, in the same form; not for one that was not kept.
    assert.equal(setExpect({ configDir: t.w.configDir, id: made.id, expect: { error: false } }), file);
    assert.deepEqual((readCapsule(file) as { capsule: Capsule }).capsule.expect, { error: false });
    assert.equal(readFileSync(file, "utf8").endsWith("}\n"), true);
    assert.throws(() => setExpect({ configDir: t.w.configDir, id: plain.id, expect: { error: false } }), /先 cases keep/);
    assert.deepEqual(readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")), [], "no leftover");
    assert.equal(capsuleFiles(path.join(t.w.configDir, "cases")).length, 1);
  }));

test("cases: an expect file is checked the way a capsule's own is", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-expect-"));
  try {
    const file = (name: string, text: string) => {
      const f = path.join(dir, name);
      writeFileSync(f, text);
      return f;
    };
    assert.deepEqual(readExpect(file("ok.json", JSON.stringify({ stage: "open", asks: { none: ["ask:"] } }))), { stage: "open", asks: { none: ["ask:"] } });
    assert.throws(() => readExpect(file("empty.json", "{}")), (e: Error) => e instanceof PreviewError && /expect says nothing/.test(e.message));
    assert.throws(() => readExpect(file("extra.json", JSON.stringify({ stage: "open", mood: "x" }))), PreviewError);
    assert.throws(() => readExpect(file("health.json", JSON.stringify({ health: "fine" }))), PreviewError);
    assert.throws(() => readExpect(file("bad.json", "{")), (e: Error) => e instanceof PreviewError && e.message.includes("bad.json"));
    assert.throws(() => readExpect(path.join(dir, "none.json")), PreviewError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command: replay, cases list/keep/expect, and apply with --accept-regress", () =>
  withDemo(async (t) => {
    const a = await t.keep("2026-10-13 10:00", {}, { correction: true, expect: { headline: { has: ["外放"] } } });
    await t.keep("2026-10-14 10:00");
    t.candidateRule({ verb: "上线" });
    const now = new Date(t.w.clock.now).toISOString();
    const env = { ...process.env, PASEO_HOME: path.join(t.w.dir, "no-home") };
    const base = ["--config", t.w.configDir, "--data", t.w.dataDir];
    const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });

    const alone = run("replay", ...base);
    assert.equal(alone.status, 0, alone.stderr);
    assert.match(alone.stdout, /存档 2 份.*只拿在用的判断一遍（没有候选）/s);
    assert.match(alone.stdout, /其中 2 份是在用的这一版判断方法存下的，拿存档再判断一遍：答案和存下的一样。/);
    const both = run("replay", ...base, "--candidate", t.candidate);
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /^⚠ 纠错又犯了/m);
    assert.match(both.stdout, /记下的事实不同（2 份）/);
    const json = JSON.parse(run("replay", ...base, "--candidate", t.candidate, "--json").stdout) as { candidate: string; expect: { broken: Array<{ id: string }> } };
    assert.equal(json.candidate, "run");
    assert.deepEqual(json.expect.broken.map((e) => e.id), [a.id]);
    const inside = path.join(t.w.configDir, "inside");
    mkdirSync(inside);
    assert.equal(run("replay", ...base, "--candidate", inside).status, 2, "a candidate inside the config is refused as for diff");
    rmSync(inside, { recursive: true });

    const diff = run("diff", ...base, "--candidate", t.candidate, "--now", now);
    assert.equal(diff.status, 0, diff.stderr);
    assert.match(diff.stdout, /拷的时候要加 --accept-regress/);
    const id = (JSON.parse(run("diff", ...base, "--candidate", t.candidate, "--now", now, "--json").stdout) as Preview).id;
    const blocked = run("apply", ...base, "--candidate", t.candidate, "--now", now, "--expect", id);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, new RegExp(`候选让 1 条纠错又犯了，没拷.*--accept-regress ${a.id}`));
    assert.match(readFileSync(path.join(t.w.configDir, RULE_FILE), "utf8"), /外放/);

    // cases: list, keep, expect.
    const list = JSON.parse(run("cases", "list", ...base, "--json").stdout) as Array<{ id: string; where: string }>;
    assert.deepEqual(list.map((r) => r.where), ["data", "data"]);
    const text = run("cases", "list", ...base, "--item", "1");
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`${a.id} #1 示例单 1 2026-10-13 10:00 wrong.*数据目录  纠错  有 expect`));
    const expectFile = path.join(t.w.dir, "expect.json");
    writeFileSync(expectFile, JSON.stringify({ stage: "open" }));
    assert.equal(run("cases", "keep", ...base).status, 2, "--id is needed");
    assert.equal(run("cases", "expect", ...base, "--id", a.id).status, 2, "--expect is needed");
    const kept = run("cases", "keep", ...base, "--id", a.id, "--expect", expectFile);
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /留下了 .*cases.*\.json/);
    assert.equal(run("cases", "keep", ...base, "--id", a.id).status, 2, "not twice");
    writeFileSync(expectFile, JSON.stringify({ headline: { has: ["外放"] } }));
    const set = run("cases", "expect", "--config", t.w.configDir, "--id", a.id, "--expect", expectFile);
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /expect 写进了/);
    assert.equal(run("cases", "list", ...base, "--item", "1", "--json").status, 0);
    assert.equal(run("cases", "nonsense", ...base).status, 2);

    // apply: named, it goes; the same words copied wrongly do not.
    const wrong = run("apply", ...base, "--candidate", t.candidate, "--now", now, "--expect", id, "--accept-regress", "k_0000000000000000");
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /不是这次纠错又犯了的存档/);
    const ok = run("apply", ...base, "--candidate", t.candidate, "--now", now, "--expect", id, "--accept-regress", a.id);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /已拷到/);
    assert.match(readFileSync(path.join(t.w.configDir, RULE_FILE), "utf8"), /上线/);
  }));

