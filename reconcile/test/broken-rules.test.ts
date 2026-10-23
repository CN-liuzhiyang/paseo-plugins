import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { EngineStatus } from "../server/engine";
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
    assert.match(problem ?? "", /^判断方法 mini\.mjs 从 10-13 12:15 起加载不上，先接着用 10-13 12:00 那一版判断，新改的没有生效：stages\.0: /);
    assert.equal(status(w).rules.errors[0]!.fallback?.slice(0, 16), "2026-10-13T04:00");
    // Broken differently: since when stays, the reason follows.
    write(w, BROKEN.replace("export default", "export default ("));
    await w.run("2026-10-13 12:45");
    assert.match(status(w).problems.find((p) => p.includes("mini.mjs"))!, /从 10-13 12:15 起加载不上/);
    assert.doesNotMatch(status(w).problems.find((p) => p.includes("mini.mjs"))!, /stages\.0/);
    // A restart goes on with the copy too: it is kept with the data.
    await w.restart();
    await w.run("2026-10-13 13:00");
    assert.match(status(w).problems.find((p) => p.includes("mini.mjs"))!, /先接着用 10-13 12:00 那一版/);
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
    assert.match(card.content.questions[0]!.question, /^判断方法 mini\.mjs 从 10-13 12:00 起加载不上，先接着用 10-13 10:00 那一版判断/);
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
