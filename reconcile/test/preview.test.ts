import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyCandidate, copyConfig, preview, previewText, PreviewError, type Preview } from "../server/preview";
import type { Item } from "../shared/model";
import { at, exampleRule, issue, makeWorld, TEST_POLICY, TEST_RULE_PARAMS, TZ, type World } from "./helpers";

// The preview of a change to the rules, policy.json or persons.json: two engines on a copy of the
// data, the config in use and the candidate, now and on through the next workdays. 2026-10-13 is
// a Tuesday.

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "reconcile-preview.mjs");

// One question per item, asked on 10-16 at 18:20 (off the hour); QUESTIONS: false asks nothing.
const rule = (questions = true, headline = "等着问") => `export default { name: "mini", description: "x", applies: { source: "gcp-demo" }, params: {}, stages: ["s"],
  assess(kase, ctx) {
    return { stage: "s", health: "waiting", headline: "${headline}", next: { actor: "me", what: "x" }, facts: [],
      commitments: ${questions ? `[{ key: "q:" + kase.id, title: "q " + kase.id, domain: "work", owner: "owner", trigger: { at: ctx.at("2026-10-16", "18:20") },
        ask: { header: kase.id, question: "q?", options: [{ id: "a", label: "A", description: "" }], allowOther: true },
        brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 2 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }]` : "[]"} };
  } };`;

const person = (quiet = "workdays 09:30-20:00") => ({ owner: { name: "测试用户", admin: true, tz: TZ, quiet: { work: quiet }, pushPerDay: 8 } });

async function withWorld(body: (w: World, candidate: string) => Promise<void>, options: { rules?: Record<string, string>; start?: string; items?: Item[]; run?: string } = {}) {
  const w = await makeWorld({ start: options.start ?? "2026-10-13 10:00", config: { rules: options.rules ?? { "mini.mjs": rule() }, policy: TEST_POLICY, persons: person() } });
  const candidate = mkdtempSync(path.join(os.tmpdir(), "reconcile-candidate-"));
  try {
    for (const item of options.items ?? [issue(1, { fields: { Release: "2026-10-16" } })]) w.items.set(item.key, item);
    await w.run(options.run ?? "2026-10-13 12:00");
    rmSync(candidate, { recursive: true });
    copyConfig(w.configDir, candidate);
    await body(w, candidate);
  } finally {
    w.close();
    rmSync(candidate, { recursive: true, force: true });
  }
}

const look = (w: World, candidate: string, more: { workdays?: number } = {}) => preview({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now, ...more });
const put = (dir: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
/** Every file under a directory, with its size and modified time. */
const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const full = path.join(e.parentPath, e.name);
      const s = statSync(full);
      return `${path.relative(dir, full)} ${s.size} ${s.mtimeMs}`;
    })
    .sort();

test("a copy changed in nothing, or only in a comment, shows no difference; its id stays the same", () =>
  withWorld(async (w, candidate) => {
    const same = await look(w, candidate);
    assert.equal(same.empty, true);
    assert.deepEqual(same.changedFiles, []);
    assert.equal((await look(w, candidate)).id, same.id, "the same id run again");
    w.clock.now += 20 * 60_000;
    assert.equal((await look(w, candidate)).id, same.id, "minutes later, the same");
    put(candidate, "rules/mini.mjs", `// a note\n${rule()}`);
    const comment = await look(w, candidate);
    assert.equal(comment.empty, true);
    assert.deepEqual(comment.changedFiles, ["rules/mini.mjs"]);
    assert.notEqual(comment.id, same.id, "the files are part of what was looked at");
    put(candidate, "rules/mini.mjs", `// another note\n${rule()}`);
    assert.notEqual((await look(w, candidate)).id, comment.id, "however little they change");
    put(candidate, "rules/mini.mjs", rule());
    put(candidate, "policy.json", JSON.stringify(TEST_POLICY, null, 2));
    const spaced = await look(w, candidate);
    assert.equal(spaced.empty, true);
    put(candidate, "policy.json", JSON.stringify(TEST_POLICY, null, 4));
    assert.notEqual((await look(w, candidate)).id, spaced.id, "a file the rules fingerprint does not cover too");
    assert.match(previewText(comment), /没有差异：现在和往后这几个工作日/);
    // A directory named like a rule is not one, on either side.
    mkdirSync(path.join(candidate, "rules", "dir.mjs"));
    mkdirSync(path.join(w.configDir, "rules", "dir.mjs"));
    assert.equal((await look(w, candidate)).empty, true);
  }));

test("a change that is the same now and differs later shows when it differs (the review's grace 1 and 3)", () => {
  const params = { ...TEST_RULE_PARAMS, releaseCheck: "notice", graceWorkdays: 1 };
  return withWorld(
    async (w, candidate) => {
      put(candidate, "rules/release-followup.mjs", exampleRule({ ...params, graceWorkdays: 3 }));
      const p = await look(w, candidate);
      assert.deepEqual(p.cases, [], "now, both judge it alike");
      assert.deepEqual(p.questions, []);
      assert.equal(p.empty, false);
      const later = p.later.cases.find((c) => c.caseId === "gcp-demo:1")!;
      assert.match(later.inUse!.notice ?? "", /已过 \d 个工作日/);
      assert.equal(later.candidate!.notice, null);
      assert.equal(later.from, "10-21 00:00", "a workday after the release day");
      // The notice goes out a workday after the release day in use, three with the candidate.
      assert.deepEqual(p.later.asks.map((a) => [a.title, a.round, a.inUse, a.candidate]), [["#1 外放提醒", 1, "10-21 10:00", "10-23 10:00"]]);
      assert.match(previewText(p), /事项的判断后来变得不一样（在用 → 候选）：\n- #1 示例单 1（从 10-21 00:00 起）.*\n  提醒：.*已过 \d 个工作日.* → 无\n/);
    },
    { rules: { "release-followup.mjs": exampleRule(params) }, start: "2026-10-19 10:00", run: "2026-10-20 12:00", items: [issue(1, { release: "2026-10-20", closed: true, status: "关闭" })] },
  ).then(() => undefined);
});

test("a person's hours changed: the card goes at another time", () =>
  withWorld(async (w, candidate) => {
    put(candidate, "persons.json", JSON.stringify(person("workdays 09:30-17:00")));
    const p = await look(w, candidate);
    assert.deepEqual(p.questions, []);
    assert.deepEqual(
      p.later.asks.filter((a) => a.round === 1).map((a) => [a.label, a.inUse, a.candidate]),
      [["#1 示例单 1", "10-16 18:20", "10-19 09:30"]],
    );
    // The nag the next workday at 10:00 moves with it; on 10-19 each side sends one.
    assert.deepEqual(p.later.cardsPerDay, [
      { date: "10-16", inUse: 1, candidate: 0 },
      { date: "10-20", inUse: 0, candidate: 1 },
    ]);
    assert.match(previewText(p), /- #1 示例单 1「q gcp-demo:1」第 1 次：在用 10-16 18:20，候选 10-19 09:30/);
  }));

test("the cards each side raises now, when they differ", () =>
  withWorld(
    async (w, candidate) => {
      put(candidate, "persons.json", JSON.stringify(person("workdays 09:30-17:00")));
      w.clock.now = at("2026-10-16 18:20");
      const p = await look(w, candidate);
      assert.deepEqual(p.cardsNow, { inUse: [{ person: "测试用户", title: "q?", questions: ["gcp-demo:1"], channels: [] }], candidate: [] });
      assert.match(previewText(p), /现在就会发的卡（按不打扰时段和每天的上限算）：\n- 在用：发给 测试用户「q\?」（gcp-demo:1）\n- 候选：不发/);
      put(candidate, "persons.json", JSON.stringify(person()));
      assert.equal((await look(w, candidate)).cardsNow, null, "the same card on both sides");
    },
    { run: "2026-10-16 18:00" },
  ));

test("a question a hold took off its card, asked again when the hold ends, is an ask of its own", () =>
  withWorld(
    async (w, candidate) => {
      w.store.append([{ type: "annotation.added", annotation: { id: "a_hold", caseId: "gcp-demo:1", kind: "hold", until: "2026-10-19", person: null, by: "owner", said: "先别问", at: "2026-10-16T18:31:00+08:00", via: "x", how: "own-words", what: null, expected: null, revoked: null } }]);
      w.clock.now = at("2026-10-16 18:31");
      await w.engine.tick();
      put(candidate, "rules/mini.mjs", rule(false));
      const p = await look(w, candidate);
      assert.deepEqual(
        p.later.asks.map((a) => [a.title, a.round, a.inUse, a.candidate]),
        [
          ["q gcp-demo:1（先别问的时间过了，再问一次）", 1, "10-19 09:30", null],
          ["q gcp-demo:1", 2, "10-20 10:00", null],
        ],
      );
    },
    { run: "2026-10-16 18:30" },
  ));

test("questions added, taken back and changed, and whether the breaker would hold the change", () =>
  withWorld(
    async (w, candidate) => {
      put(candidate, "rules/mini.mjs", rule(true));
      const p = await look(w, candidate);
      assert.deepEqual(p.questions.map((q) => q.kind), ["new", "new", "new", "new"]);
      assert.deepEqual(p.breaker, { changes: { newCommitments: 4, dropped: 0, changed: 0, reopened: 0 }, limit: 3 });
      assert.match(previewText(p), /⚠ 这个改动一下子会新排 4 个要问的问题，超过了上限 3/);
    },
    { rules: { "mini.mjs": rule(false) }, items: [1, 2, 3, 4].map((id) => issue(id, { fields: { Release: "2026-10-16" } })) },
  ));

test("a question changed or taken back, now", () =>
  withWorld(async (w, candidate) => {
    put(candidate, "rules/mini.mjs", rule(true).replace("max: 2", "max: 3").replace('headline: "等着问"', 'headline: "换了说法"'));
    const p = await look(w, candidate);
    assert.equal(p.cases.length, 1);
    assert.equal(p.cases[0]!.inUse!.headline, "等着问");
    assert.equal(p.cases[0]!.candidate!.headline, "换了说法");
    assert.deepEqual(p.questions.map((q) => [q.kind, q.fields.map((f) => [f.field, f.inUse, f.candidate])]), [["change", [["追问", "每 1 个工作日 10:00，最多 2 次", "每 1 个工作日 10:00，最多 3 次"]]]]);
    assert.equal(p.breaker, null, "one change is under the limit");
    put(candidate, "rules/mini.mjs", rule(false));
    const gone = await look(w, candidate);
    assert.deepEqual(gone.questions.map((q) => q.kind), ["cancel"]);
    assert.ok(gone.later.asks.some((a) => a.inUse === "10-16 18:20" && a.candidate === null));
    assert.match(previewText(gone), /- 收回：#1 示例单 1「q gcp-demo:1」/);
  }));

test("against what the rules in use do now: a question the candidate keeps, or does not add", () =>
  withWorld(async (w, candidate) => {
    // The rules in use were changed in place and take the question back at the next reconcile.
    writeFileSync(path.join(w.configDir, "rules", "mini.mjs"), rule(false));
    const keep = await look(w, candidate);
    assert.deepEqual(keep.questions.map((q) => q.kind), ["keep"]);
    assert.match(previewText(keep), /- 留着（在用的这次会收回）：#1 示例单 1「q gcp-demo:1」/);
  }, { rules: { "mini.mjs": rule() } }).then(() =>
    withWorld(async (w, candidate) => {
      writeFileSync(path.join(w.configDir, "rules", "mini.mjs"), rule());
      put(candidate, "rules/mini.mjs", rule(false));
      assert.deepEqual((await look(w, candidate)).questions.map((q) => q.kind), ["skip"]);
    }, { rules: { "mini.mjs": rule(false) } }),
  ));

test("a candidate that does not load is said so, and is not copied", () =>
  withWorld(async (w, candidate) => {
    put(candidate, "rules/mini.mjs", rule().replace('stages: ["s"]', "stages: [{ id: 7 }]"));
    const p = await look(w, candidate);
    assert.equal(p.candidate.errors[0]!.file, "mini.mjs");
    assert.equal(p.candidate.errors[0]!.fallback, undefined, "the candidate has no copy to go on with");
    assert.deepEqual(p.heat, [], "not cold: not judged");
    assert.deepEqual(p.judged, { onlyInUse: ["#1 示例单 1"], onlyCandidate: [] });
    assert.match(previewText(p), /候选不再判断的事项（1 个，管它们的判断方法在候选里没有或者加载不上）：#1 示例单 1/);
    assert.match(previewText(p), /⚠ 候选的判断方法 mini\.mjs 加载不上，不能拷过去/);
    await assert.rejects(applyCandidate({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now, expect: p.id }), /加载出错，不拷/);
    assert.equal(readFileSync(path.join(w.configDir, "rules", "mini.mjs"), "utf8"), rule());
  }));

test("rules in use that do not load are previewed as the controller runs them: on its kept copy", () =>
  withWorld(async (w, candidate) => {
    writeFileSync(path.join(w.configDir, "rules", "mini.mjs"), "export default {");
    const p = await look(w, candidate);
    assert.equal(p.inUse.errors[0]!.fallback?.slice(0, 16), "2026-10-13T10:00");
    assert.deepEqual(p.cases, [], "the candidate is the copy that runs");
    // What differs: the rules in use, broken, are told to the admin half an hour on.
    assert.deepEqual(p.later.asks.map((a) => [a.inUse, a.candidate]), [["10-13 12:30", null]]);
    assert.match(p.later.asks[0]!.title, /^判断方法 mini\.mjs 加载不上$/);
    assert.match(previewText(p), /⚠ 在用的判断方法 mini\.mjs 现在就加载不上，daemon 接着用 10-13 10:00 换上的那一版/);
  }));

test("apply copies what changed only when the preview is the one looked at, and deletes nothing", () =>
  withWorld(async (w, candidate) => {
    put(candidate, "policy.json", JSON.stringify({ ...TEST_POLICY, ruleBreakerChanges: 5 }));
    const options = { configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now };
    const p = await look(w, candidate);
    assert.deepEqual(p.changedFiles, ["policy.json"]);
    const before = readFileSync(path.join(w.configDir, "policy.json"), "utf8");
    const stale = await applyCandidate({ ...options, expect: "p_0000000000" });
    assert.deepEqual(stale.applied, []);
    assert.equal(readFileSync(path.join(w.configDir, "policy.json"), "utf8"), before);
    // Changed again after it was looked at: another id, nothing copied.
    put(candidate, "rules/mini.mjs", `// x\n${rule()}`);
    assert.deepEqual((await applyCandidate({ ...options, expect: p.id })).applied, []);
    put(candidate, "rules/mini.mjs", rule());
    const rules = tree(path.join(w.configDir, "rules"));
    const done = await applyCandidate({ ...options, expect: p.id });
    assert.deepEqual(done.applied, ["policy.json"]);
    assert.equal(JSON.parse(readFileSync(path.join(w.configDir, "policy.json"), "utf8")).ruleBreakerChanges, 5);
    assert.deepEqual(tree(path.join(w.configDir, "rules")), rules, "the rest untouched");
    // A rule file left out of the candidate is not deleted.
    put(candidate, "rules/other.mjs", rule().replace('name: "mini"', 'name: "other"'));
    rmSync(path.join(candidate, "rules", "mini.mjs"));
    const without = await look(w, candidate);
    await assert.rejects(applyCandidate({ ...options, expect: without.id }), /少了 rules\/mini\.mjs：删文件要人自己做/);
  }));

test("a candidate inside the config in use, or with sources, is refused; previewing writes nothing anywhere", () =>
  withWorld(async (w, candidate) => {
    await assert.rejects(look(w, path.join(w.configDir, "rules")), PreviewError);
    await assert.rejects(look(w, w.configDir), /外面/);
    assert.throws(() => copyConfig(w.configDir, path.join(w.configDir, "copy")), /外面/);
    assert.throws(() => copyConfig(w.configDir, candidate), /不是空的/);
    put(candidate, "sources.json", "[]");
    await assert.rejects(look(w, candidate), /sources\.json/);
    rmSync(path.join(candidate, "sources.json"));
    put(candidate, "persons.json", JSON.stringify(person("workdays 09:30-17:00")));
    const data = tree(w.dataDir);
    const config = tree(w.configDir);
    const lock = readFileSync(path.join(w.dataDir, "LOCK"), "utf8");
    await look(w, candidate);
    assert.deepEqual(tree(w.dataDir), data);
    assert.deepEqual(tree(w.configDir), config);
    assert.equal(readFileSync(path.join(w.dataDir, "LOCK"), "utf8"), lock);
  }));

test("the command: diff prints the preview and how to apply it; apply with another id copies nothing", () =>
  withWorld(async (w, candidate) => {
    put(candidate, "persons.json", JSON.stringify(person("workdays 09:30-17:00")));
    const now = new Date(w.clock.now).toISOString();
    const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, PASEO_HOME: path.join(w.dir, "no-home") } });
    assert.equal(run("--help").status, 0);
    const diff = run("diff", "--config", w.configDir, "--data", w.dataDir, "--candidate", candidate, "--now", now, "--days", "8");
    assert.equal(diff.status, 0, diff.stderr);
    const id = /^改动预览 (p_[0-9a-f]{10})/.exec(diff.stdout)?.[1];
    assert.ok(id, diff.stdout);
    // Everything that went into the id is in the line to copy.
    assert.match(diff.stdout, new RegExp(`要拷回去：reconcile-preview apply --config .+ --data .+ --days 8 --now ${now.replace(/[.]/g, "[.]")} --candidate .+ --expect ${id}`));
    const json = JSON.parse(run("diff", "--config", w.configDir, "--data", w.dataDir, "--candidate", candidate, "--now", now, "--days", "8", "--json").stdout) as Preview;
    assert.equal(json.id, id);
    const short = run("apply", "--config", w.configDir, "--data", w.dataDir, "--candidate", candidate, "--days", "3", "--expect", id);
    assert.equal(short.status, 2);
    assert.match(short.stderr, /至少要往后推演 7 个工作日（这次是 3）/);
    const home = path.join(w.dir, "bad-home");
    put(home, "plugin-settings/reconcile/reconcile.json", "{");
    const bad = spawnSync(process.execPath, [BIN, "diff", "--candidate", candidate], { encoding: "utf8", env: { ...process.env, PASEO_HOME: home } });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /^插件设置读不懂/);
    assert.doesNotMatch(bad.stderr, /\n\s+at /, "no stack");
    // Both directories given: the settings are not needed, and not read.
    const given = spawnSync(process.execPath, [BIN, "diff", "--config", w.configDir, "--data", w.dataDir, "--candidate", candidate, "--now", now], { encoding: "utf8", env: { ...process.env, PASEO_HOME: home } });
    assert.equal(given.status, 0, given.stderr);
    const apply = run("apply", "--config", w.configDir, "--data", w.dataDir, "--candidate", candidate, "--now", now, "--expect", "p_0000000000");
    assert.equal(apply.status, 1);
    assert.match(apply.stdout, /差异变了.*没拷/);
    assert.equal(run("diff", "--candidate", candidate).status, 2, "no config to compare with");
    assert.equal(run("diff", "--config", w.configDir, "--data", w.dataDir, "--candidate", candidate, "--said", "x").status, 2);
  }));

/** Runs body with fs.readFileSync calling spy after each read of file (its count so far). */
async function onRead(file: string, spy: (count: number) => void, body: () => Promise<void>) {
  const read = fs.readFileSync;
  let count = 0;
  fs.readFileSync = ((...args: Parameters<typeof read>) => {
    const out = read(...args);
    if (typeof args[0] === "string" && path.resolve(args[0]) === path.resolve(file)) spy(++count);
    return out;
  }) as typeof read;
  syncBuiltinESMExports();
  try {
    await body();
  } finally {
    fs.readFileSync = read;
    syncBuiltinESMExports();
  }
}

test("apply copies the candidate as it read it: a candidate or config in use changed while it is previewed stops it", () =>
  withWorld(async (w, candidate) => {
    put(candidate, "rules/mini.mjs", rule(true, "换了说法"));
    const options = { configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now };
    const p = await look(w, candidate);
    const copies = () => readdirSync(os.tmpdir()).filter((f) => f.startsWith("reconcile-apply-"));
    const left = copies();
    const file = path.join(candidate, "rules", "mini.mjs");
    const inUse = path.join(w.configDir, "rules", "mini.mjs");
    // Changed right after it was read: what is previewed is the copy read, and nothing is copied.
    await onRead(file, (n) => n === 1 && writeFileSync(file, rule(true, "没看过的")), () =>
      assert.rejects(applyCandidate({ ...options, expect: p.id }), /预览的这几秒里，候选或者在用的文件变了，没拷/),
    );
    assert.equal(readFileSync(inUse, "utf8"), rule());
    // The config in use changed as the candidate is read again, before writing.
    put(candidate, "rules/mini.mjs", rule(true, "换了说法"));
    await onRead(file, (n) => n === 2 && writeFileSync(path.join(w.configDir, "policy.json"), JSON.stringify({ ...TEST_POLICY, ruleBreakerChanges: 9 })), () =>
      assert.rejects(applyCandidate({ ...options, expect: p.id }), /变了，没拷/),
    );
    assert.equal(readFileSync(inUse, "utf8"), rule());
    writeFileSync(path.join(w.configDir, "policy.json"), JSON.stringify(TEST_POLICY));
    const again = await look(w, candidate);
    assert.deepEqual((await applyCandidate({ ...options, expect: again.id })).applied, ["rules/mini.mjs"]);
    assert.equal(readFileSync(inUse, "utf8"), rule(true, "换了说法"));
    assert.deepEqual(copies(), left, "its own copy is gone");
  }));

test("a candidate that is, or holds, a link is refused, wherever it leads", () =>
  withWorld(async (w, candidate) => {
    rmSync(path.join(candidate, "rules"), { recursive: true });
    symlinkSync(path.join(w.configDir, "rules"), path.join(candidate, "rules"), "junction");
    await assert.rejects(look(w, candidate), /候选里的 rules 是个链接/);
    const whole = path.join(w.dir, "whole");
    symlinkSync(w.configDir, whole, "junction");
    await assert.rejects(look(w, whole), /外面/);
    assert.throws(() => copyConfig(w.configDir, path.join(whole, "rules", "x")), /外面/);
  }));

test("the id holds how far on it looked, and an ask due before now; apply looks on at least seven workdays", () =>
  withWorld(
    async (w, candidate) => {
      put(candidate, "persons.json", JSON.stringify(person("workdays 09:30-17:00")));
      w.clock.now = at("2026-10-16 18:19");
      const before = await look(w, candidate);
      assert.deepEqual(before.later.asks.filter((a) => a.round === 1).map((a) => a.inUse), ["10-16 18:20"]);
      w.clock.now = at("2026-10-16 18:21");
      const after = await look(w, candidate);
      assert.deepEqual(after.later.asks.filter((a) => a.round === 1).map((a) => a.inUse), ["现在（本该 10-16 18:20）"]);
      assert.equal(after.id, before.id, "an ask moment passed between them: the same");
      assert.notEqual((await look(w, candidate, { workdays: 8 })).id, after.id, "looked on further: another id");
      const short = await look(w, candidate, { workdays: 3 });
      await assert.rejects(
        applyCandidate({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now, workdays: 3, expect: short.id }),
        /至少要往后推演 7 个工作日（这次是 3）/,
      );
    },
    { run: "2026-10-16 18:00" },
  ));

test("apply writes all or none: a file that cannot be replaced puts back the ones that were", () =>
  withWorld(async (w, candidate) => {
    put(candidate, "policy.json", JSON.stringify({ ...TEST_POLICY, ruleBreakerChanges: 5 }));
    put(candidate, "rules/mini.mjs", `// x\n${rule()}`);
    const p = await look(w, candidate);
    const config = tree(w.configDir).map((l) => l.split(" ").slice(0, 2).join(" "));
    const policy = readFileSync(path.join(w.configDir, "policy.json"), "utf8");
    const locked = path.join(w.configDir, "rules", "mini.mjs");
    chmodSync(locked, 0o444);
    try {
      await assert.rejects(
        applyCandidate({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now, expect: p.id }),
        (error: Error) => error instanceof PreviewError && /^拷的时候出错，没拷（.+）：已经换上的 policy\.json 改回了原样$/.test(error.message),
      );
    } finally {
      chmodSync(locked, 0o644);
    }
    assert.equal(readFileSync(path.join(w.configDir, "policy.json"), "utf8"), policy);
    assert.deepEqual(tree(w.configDir).map((l) => l.split(" ").slice(0, 2).join(" ")), config, "nothing left behind");
  }));

test("a judgment that differs in one field says which, before and after, in words", () =>
  withWorld(async (w, candidate) => {
    put(candidate, "rules/mini.mjs", rule().replace('actor: "me"', 'actor: "them"'));
    const p = await look(w, candidate);
    assert.deepEqual(p.cases.map((c) => c.fields), [[{ field: "在等谁", inUse: "你", candidate: "别人" }]]);
    assert.match(previewText(p), /事项的判断（1 个变了，在用 → 候选）：\n- #1 示例单 1：等着问\n  在等谁：你 → 别人\n/);
  }));

test("what only the page shows: the list's group and stage name, and the stages declared; not the breaker's", () =>
  withWorld(async (w, candidate) => {
    put(candidate, "rules/mini.mjs", rule().replace('stages: ["s"]', 'stages: [{ id: "s", label: "等回答" }, { id: "e", label: "结束", end: true, endKind: "dropped" }]'));
    const p = await look(w, candidate);
    assert.deepEqual(p.cases, [], "the same stage: the judgment is the same");
    assert.equal(p.breaker, null);
    assert.equal(p.empty, false);
    // The in-use rule does not name its stage, so the list calls it by its place in the line ("第 1 步"), not by its id.
    assert.deepEqual(p.page.rows.map((r) => [r.label, r.fields.map((f) => [f.field, f.inUse, f.candidate])]), [["#1 示例单 1", [["阶段名", "第 1 步", "等回答"]]]]);
    assert.deepEqual(p.page.stages, [{ rule: "mini", changes: ["新加阶段 「结束」（e）", "s 改名：「第 1 步」→「等回答」"] }]);
    assert.match(previewText(p), /## 页面上看到的（不算进熔断）\n列表里的事项（1 个变了，在用 → 候选）：\n- #1 示例单 1\n  阶段名：第 1 步 → 等回答\n判断方法声明的阶段：\n- mini\n  新加阶段 「结束」（e）\n  s 改名：「第 1 步」→「等回答」\n/);
    // A different stage is the judgment's, with the names each side gives it.
    put(candidate, "rules/mini.mjs", rule().replace('stages: ["s"]', 'stages: ["s", { id: "t", label: "下一步" }]').replace('stage: "s"', 'stage: "t"'));
    const moved = await look(w, candidate);
    assert.deepEqual(moved.cases.map((c) => c.fields.find((f) => f.field === "阶段")), [{ field: "阶段", inUse: "s", candidate: "下一步（t）" }]);
  }));

test("since when the page counts the wait: from the journal before, and the candidate's own judgments after", () =>
  withWorld(
    async (w, candidate) => {
      put(candidate, "rules/mini.mjs", rule().replace('next: { actor: "me", what: "x" }', 'next: { actor: "me", what: "x", since: ctx.at("2026-10-13", "11:00") }'));
      const p = await look(w, candidate);
      const since = p.page.rows.flatMap((r) => r.fields).find((f) => f.field === "等待从几点算起");
      assert.deepEqual(since, { field: "等待从几点算起", inUse: "10-13 10:00（至少，之前多久不知道）", candidate: "10-13 11:00" }, JSON.stringify(p.page.rows));
      // without the rule's evidence, the change of hands is when the candidate's rules first judged it, and a floor
      put(candidate, "rules/mini.mjs", rule());
      const bare = (await look(w, candidate)).page.rows.flatMap((r) => r.fields).find((f) => f.field === "等待从几点算起");
      assert.equal(bare?.candidate, "10-13 12:00（至少，之前多久不知道）");
    },
    { rules: { "mini.mjs": rule().replace('next: { actor: "me", what: "x" }', 'next: { actor: "them", what: "x" }') } },
  ));

test("what the preview cannot see is said: items cold on both sides, the hour, the daemon's memory, the candidate's code", () =>
  withWorld(
    async (w, candidate) => {
      put(candidate, "rules/mini.mjs", `// a note\n${rule()}`);
      const p = await look(w, candidate);
      assert.equal(p.empty, true);
      assert.equal(p.coldBoth, 1);
      assert.match(previewText(p), /没有差异：.*都一样。（1 个事项两边都是冷的，没判断）/);
      for (const said of [/按整点取样/, /不是 daemon 内存里的：.*要 reload 才生效/, /会把候选的判断方法当代码执行/, /现在有 1 个事项两边都是冷的/]) assert.ok(p.caveats.some((c) => said.test(c)), String(said));
    },
    { items: [issue(1, { fields: { Release: "2026-10-16" } }), issue(9, { title: "【总单】示例功能", release: "2026-10-23", status: "开发中" })] },
  ));

test("a file that differs only in its line endings is not a change, and is not copied", () =>
  withWorld(async (w, candidate) => {
    put(candidate, "rules/mini.mjs", rule().replace(/\n/g, "\r\n"));
    put(candidate, "policy.json", JSON.stringify({ ...TEST_POLICY, ruleBreakerChanges: 5 }));
    const p = await look(w, candidate);
    assert.deepEqual([p.changedFiles, p.eolOnly], [["policy.json"], ["rules/mini.mjs"]]);
    assert.match(previewText(p), /候选里和在用不同的文件：policy\.json\n只差行尾（CRLF \/ LF），不算改动，apply 不拷：rules\/mini\.mjs\n/);
    const done = await applyCandidate({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now, expect: p.id });
    assert.deepEqual(done.applied, ["policy.json"]);
    assert.equal(readFileSync(path.join(w.configDir, "rules", "mini.mjs"), "utf8"), rule());
    put(candidate, "policy.json", readFileSync(path.join(w.configDir, "policy.json"), "utf8"));
    assert.match(previewText(await look(w, candidate)), /^.*\n候选里的文件和在用的只差行尾。\n只差行尾/);
  }));
