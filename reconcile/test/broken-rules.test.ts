import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { EngineStatus } from "../server/engine";
import { sha256 } from "../server/rules";
import { issue, makeWorld, TEST_POLICY, TZ, type World } from "./helpers";

// A rule file that stops loading -- a syntax error, a wrong shape, a forbidden call -- does not
// stop the items it judges without a word: the last copy of it that loaded goes on, the page says
// so at the top, the admin gets a card to acknowledge after half an hour, and is told when it is
// over. 2026-10-13 is a Tuesday.

const rule = (headline: string) => `export default { name: "mini", description: "x", applies: { source: "gcp-demo" }, params: {}, stages: ["s"],
  assess(kase, ctx) {
    return { stage: "s", health: "waiting", headline: "${headline}", next: { actor: "me", what: "x" }, facts: [], commitments: [] };
  } };`;
// A shape the plugin does not take: a stage whose id is not a string.
const BROKEN = rule("新写的").replace('stages: ["s"]', "stages: [{ id: 7 }]");

const ADMIN = { owner: { name: "测试用户", admin: true, tz: TZ, quiet: { work: "workdays 09:30-20:00" }, pushPerDay: 8, notify: [{ channel: "im", to: "p2p:someone", label: "IM" }] } };

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": rule("第一版") }, policy: TEST_POLICY, persons: ADMIN } });
  try {
    w.items.set("gcp-demo:1", issue(1, { fields: { Release: "2026-10-16" } }));
    await w.run("2026-10-13 12:00");
    await body(w);
  } finally {
    w.close();
  }
}

const status = (w: World) => w.statuses[w.statuses.length - 1] as EngineStatus;
const write = (w: World, text: string) => writeFileSync(path.join(w.configDir, "rules", "mini.mjs"), text);
const headline = (w: World) => w.store.state.assessments["gcp-demo:1"]?.headline;
const broken = (w: World) => Object.values(w.store.state.commitments).filter((c) => c.origin.who === "rules-broken");
const copy = (w: World, file = "mini.mjs") => path.join(w.dataDir, "rules-last-good", file);
const problem = (w: World, text: string) => status(w).problems.find((p) => p.includes(text));

test("a rule file that stops loading goes on as its last copy that did, and the page says so", () =>
  withWorld(async (w) => {
    assert.equal(headline(w), "第一版");
    const fingerprint = w.store.state.rules.fingerprint;
    write(w, rule("第二版"));
    await w.run("2026-10-13 12:15");
    assert.equal(headline(w), "第二版");
    const second = w.store.state.rules.fingerprint;
    assert.notEqual(second, fingerprint);
    write(w, BROKEN);
    await w.run("2026-10-13 12:30");
    assert.equal(headline(w), "第二版", "judged as before, not stopped");
    assert.equal(status(w).cases.length, 1);
    assert.equal(w.store.state.rules.fingerprint, second, "what runs is the same: no rules change");
    const problem = status(w).problems.find((p) => p.includes("mini.mjs"));
    assert.match(problem ?? "", /^判断方法 mini\.mjs 从 10-13 12:15 起加载不上，先接着用 10-13 12:00 换上的那一版判断，新改的没有生效：stages\.0: /);
    assert.equal(status(w).rules.errors[0]!.fallback?.slice(0, 16), "2026-10-13T04:00");
    // Broken differently: since when stays, the reason follows.
    write(w, BROKEN.replace("export default", "export default ("));
    await w.run("2026-10-13 12:45");
    assert.match(status(w).problems.find((p) => p.includes("mini.mjs"))!, /从 10-13 12:15 起加载不上/);
    assert.doesNotMatch(status(w).problems.find((p) => p.includes("mini.mjs"))!, /stages\.0/);
    // A restart goes on with the copy too: it is kept with the data.
    await w.restart();
    await w.run("2026-10-13 13:00");
    assert.match(status(w).problems.find((p) => p.includes("mini.mjs"))!, /先接着用 10-13 12:00 换上的那一版/);
    assert.equal(headline(w), "第二版");
  }));

test("with no copy to go on with, the page says how many items stopped being judged", () =>
  withWorld(async (w) => {
    rmSync(path.join(w.dataDir, "rules-last-good"), { recursive: true, force: true });
    write(w, BROKEN);
    await w.run("2026-10-13 12:15");
    assert.equal(status(w).cases.length, 0);
    assert.match(status(w).problems.find((p) => p.includes("mini.mjs"))!, /^判断方法 mini\.mjs 从 10-13 12:00 起加载不上，1 个事项停止判断：/);
  }));

test("broken for half an hour, it goes to the admin on a card and their channels; loading again, the card goes and they are told", () =>
  withWorld(async (w) => {
    write(w, BROKEN);
    await w.run("2026-10-13 12:25", 5);
    assert.equal(broken(w).length, 0, "not before half an hour");
    await w.run("2026-10-13 12:30", 5);
    assert.equal(broken(w).length, 1);
    const card = w.cards[w.cards.length - 1]!;
    assert.equal(card.card.title, card.content.questions[0]!.question, "the card says it in its title");
    assert.match(card.content.questions[0]!.question, /^判断方法 mini\.mjs 从 10-13 12:00 起加载不上，先接着用 10-13 10:00 换上的那一版判断/);
    assert.deepEqual(card.content.questions[0]!.options.map((o) => o.label), ["知道了"]);
    assert.ok(w.deliveries.some((d) => d.channel === "im" && d.title === card.card.title));
    await w.run("2026-10-13 13:30", 5);
    assert.equal(broken(w).length, 1, "one card for one outage");

    write(w, rule("修好了"));
    await w.run("2026-10-13 13:45");
    assert.equal(headline(w), "修好了");
    assert.equal(broken(w)[0]!.status, "cancelled");
    assert.equal(broken(w)[0]!.reason, "恢复了");
    assert.equal(status(w).problems.some((p) => p.includes("mini.mjs")), false);
    const told = w.deliveries.filter((d) => d.title === "判断方法 mini.mjs 恢复了");
    assert.equal(told.length, 1);
    assert.match(told[0]!.text, /^mini\.mjs 又能加载了，事项照常判断/);
    await w.run("2026-10-13 14:30");
    assert.equal(w.deliveries.filter((d) => d.title === "判断方法 mini.mjs 恢复了").length, 1, "told once");
  }));

test("quiet hours hold the card, and the word that it is over, until the admin may be reached", () =>
  withWorld(async (w) => {
    await w.run("2026-10-13 19:45");
    write(w, BROKEN);
    await w.run("2026-10-14 09:15");
    assert.equal(broken(w).length, 1, "the card is there");
    assert.equal(w.cards.length, 0, "but not raised in quiet hours");
    await w.run("2026-10-14 09:30");
    assert.equal(w.cards.length, 1, "raised when they may be reached");
    await w.run("2026-10-14 20:15");
    write(w, rule("修好了"));
    await w.run("2026-10-14 21:00");
    assert.equal(broken(w)[0]!.status, "cancelled");
    assert.equal(w.deliveries.filter((d) => d.title.endsWith("恢复了")).length, 0, "not at night");
    await w.run("2026-10-15 09:30");
    assert.equal(w.deliveries.filter((d) => d.title.endsWith("恢复了")).length, 1);
  }));

test("a card never asked is not followed by word that it is over", () =>
  withWorld(async (w) => {
    await w.run("2026-10-13 19:45");
    write(w, BROKEN);
    await w.run("2026-10-13 21:00");
    write(w, rule("修好了"));
    await w.run("2026-10-14 10:00");
    assert.equal(broken(w)[0]!.status, "cancelled");
    assert.equal(w.cards.length, 0);
    assert.equal(w.deliveries.filter((d) => d.title.endsWith("恢复了")).length, 0);
  }));

test("a copy that cannot be read is said with the error, and nothing else stops", () =>
  withWorld(async (w) => {
    rmSync(copy(w));
    mkdirSync(copy(w));
    write(w, BROKEN);
    await w.run("2026-10-13 12:30", 5);
    assert.match(problem(w, "mini.mjs") ?? "", /^判断方法 mini\.mjs 从 10-13 12:00 起加载不上，1 个事项停止判断：stages\.0: .*；副本读不了：/);
    assert.equal(status(w).problems.some((p) => p.startsWith("这次检查出错")), false, "the check goes on");
    assert.equal(broken(w).length, 1, "and the card is raised on time");
  }));

test("a copy that cannot be saved is on the page at once", () =>
  withWorld(async (w) => {
    rmSync(path.join(w.dataDir, "rules-last-good"), { recursive: true });
    writeFileSync(path.join(w.dataDir, "rules-last-good"), "not a directory");
    write(w, rule("第二版"));
    await w.run("2026-10-13 12:15");
    assert.equal(headline(w), "第二版");
    assert.match(problem(w, "副本存不下来（mini.mjs") ?? "", /^判断方法的副本存不下来（mini\.mjs：.+）：mini\.mjs 以后加载不上时没有可接着用的$/);
  }));

test("a rule file taken away takes its copy with it: a new file of that name that breaks does not bring the old one back", () =>
  withWorld(async (w) => {
    writeFileSync(path.join(w.configDir, "rules", "other.mjs"), rule("别的").replace('name: "mini"', 'name: "other"').replace("gcp-demo", "other-source"));
    await w.run("2026-10-13 12:15");
    assert.ok(existsSync(copy(w)));
    rmSync(path.join(w.configDir, "rules", "mini.mjs"));
    await w.run("2026-10-13 12:30");
    assert.equal(existsSync(copy(w)), false);
    assert.equal(w.store.state.rules.kept?.["mini.mjs"], undefined);
    assert.ok(w.store.state.rules.kept?.["other.mjs"]);
    write(w, BROKEN);
    await w.run("2026-10-13 12:45");
    assert.equal(status(w).cases.length, 0, "the old rule does not come back");
    assert.match(problem(w, "mini.mjs") ?? "", /1 个事项停止判断/);
    // The count is of the items each file judged: other.mjs judged none.
    writeFileSync(path.join(w.configDir, "rules", "other.mjs"), BROKEN.replace('name: "mini"', 'name: "other"'));
    rmSync(copy(w, "other.mjs"));
    await w.run("2026-10-13 13:00");
    assert.match(problem(w, "other.mjs") ?? "", /0 个事项停止判断/);
    assert.match(problem(w, "mini.mjs") ?? "", /1 个事项停止判断/);
  }));

test("a copy that does not load either is said with both errors", () =>
  withWorld(async (w) => {
    const old = "export default (";
    writeFileSync(copy(w), old);
    w.store.append([{ type: "rules.kept", file: "mini.mjs", sha256: sha256(old), source: "gcp-demo" }]);
    write(w, BROKEN);
    await w.run("2026-10-13 12:15");
    assert.match(problem(w, "mini.mjs") ?? "", /1 个事项停止判断：stages\.0: .*；副本也加载不上：/);
  }));

test("a copy the controller did not save is not used", () =>
  withWorld(async (w) => {
    writeFileSync(copy(w), rule("放进来的"));
    write(w, BROKEN);
    await w.run("2026-10-13 12:15");
    assert.notEqual(headline(w), "放进来的");
    assert.equal(status(w).cases.length, 0);
    assert.match(problem(w, "mini.mjs") ?? "", /1 个事项停止判断：.*；副本和控制器存下时记的不一样，没用它$/);
  }));

test("a copy saved before its sha256 was recorded is recorded the next time its file loads, and then used", () =>
  withWorld(async (w) => {
    // As after an upgrade: the copy is there, the record of it is not.
    w.store.append([{ type: "rules.kept", file: "mini.mjs", sha256: null }]);
    assert.ok(existsSync(copy(w)));
    writeFileSync(path.join(w.configDir, "rules", "other.mjs"), rule("别的").replace('name: "mini"', 'name: "other"').replace("gcp-demo", "other-source"));
    await w.run("2026-10-13 12:15");
    assert.ok(w.store.state.rules.kept?.["mini.mjs"]);
    write(w, BROKEN);
    await w.run("2026-10-13 12:30");
    assert.equal(headline(w), "第一版");
  }));

test("a rules directory with nothing in it is said on the page, goes to the admin after half an hour, and they are told when it is over", () =>
  withWorld(async (w) => {
    rmSync(path.join(w.configDir, "rules", "mini.mjs"));
    await w.run("2026-10-13 12:15");
    assert.equal(problem(w, "判断方法目录"), "判断方法目录从 10-13 12:00 起一个文件都没有，1 个事项停止判断");
    await w.run("2026-10-13 12:45", 5);
    assert.equal(broken(w).length, 1);
    assert.equal(w.cards[w.cards.length - 1]!.card.title, "判断方法目录从 10-13 12:00 起一个文件都没有，1 个事项停止判断");
    write(w, rule("回来了"));
    await w.run("2026-10-13 13:00");
    assert.equal(headline(w), "回来了");
    assert.equal(problem(w, "判断方法目录"), undefined);
    assert.equal(broken(w)[0]!.status, "cancelled");
    assert.match(w.deliveries.find((d) => d.title === "判断方法目录又有文件了")?.text ?? "", /^判断方法目录里又有文件了/);
  }));
