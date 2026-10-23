import assert from "node:assert/strict";
import { test } from "node:test";
import { issue, makeWorld, type World } from "./helpers";

// A card also sent to the person's channels (server.deliver) when it is raised: once per card,
// under the same quiet hours and budget, and never holding the card back.

const persons = { owner: { name: "测试用户", admin: true, tz: "Asia/Shanghai", quiet: { work: "workdays 09:30-20:00" }, pushPerDay: 8, notify: [{ channel: "im", to: "p2p:someone", label: "IM" }] } };

// One question per issue at 18:00 on its release day; an issue titled "提醒" gets a statement with only 知道了.
const rule = `export default {
  name: "mini",
  description: "x",
  applies: { source: "gcp-demo" },
  params: {},
  stages: ["s"],
  assess(kase, ctx) {
    const d = (kase.primary.fields.Release || "").slice(0, 10);
    const n = kase.id.split(":").pop();
    const say = kase.primary.status === "提醒";
    return { stage: "s", health: "waiting", headline: "h", next: { actor: "me", what: "" }, facts: [], commitments: [{
      key: "q:" + kase.id, title: "q " + n, domain: "work", owner: "owner",
      trigger: { at: ctx.at(d, "18:00") },
      ask: say
        ? { header: "#" + n + " 提醒", question: "#" + n + " 没进封版", options: [{ id: "ack", label: "知道了", description: "" }], allowOther: true }
        : { header: "#" + n, question: "#" + n + " 外放了吗？", options: [{ id: "yes", label: "外放了", description: "" }, { id: "no", label: "还没", description: "过两天再问" }], allowOther: true },
      brief: say ? "#" + n + " 在 stable 上的 R-170 不在这次复制里，后续要单独 merge。" : "b",
      nag: { everyWorkdays: 1, at: "10:00", max: 1 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }] };
  },
};`;

async function withWorld(options: { mode?: "live" | "dry-run"; deliver?: boolean } = {}, body: (w: World) => Promise<void>) {
  const w = await makeWorld({ start: "2026-10-13 10:00", ...options, config: { rules: { "mini.mjs": rule }, persons } });
  try {
    await body(w);
  } finally {
    w.close();
  }
}

const problems = (w: World) => w.engine.status().problems;

test("a raised card is sent to the person's channel at once: its title, the question and its options, and where to answer", () =>
  withWorld({}, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:00");
    assert.equal(w.cards.length, 1);
    assert.equal(w.deliveries.length, 1);
    const [d] = w.deliveries;
    assert.deepEqual([d!.channel, d!.to, d!.title, d!.status], ["im", "p2p:someone", w.cards[0]!.card.title, "succeeded"]);
    assert.equal(d!.text, "#1 外放了吗？\n- 外放了\n- 还没：过两天再问\n- 其他（自己写）\n\n在 Paseo「事项追踪」里回答");
    assert.match(d!.idempotencyKey, new RegExp(`^test:notify:${w.cards[0]!.card.id}:im:`));
  }));

test("a statement goes in full, with nothing to answer", () =>
  withWorld({}, async (w) => {
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-14", status: "提醒" }));
    await w.run("2026-10-14 18:00");
    assert.equal(w.deliveries[0]!.text, "#2 没进封版\n\n#2 在 stable 上的 R-170 不在这次复制里，后续要单独 merge。");
  }));

test("a restart raises the same card again without sending it again; a new card is sent", () =>
  withWorld({}, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:00");
    await w.restart("live");
    await w.run("2026-10-14 18:30");
    assert.equal(w.cards.length, 2, "a new carrier for the same card");
    assert.equal(w.cards[1]!.card.id, w.cards[0]!.card.id);
    assert.equal(w.deliveries.length, 1);
    // Another question the next day is a new card (carrying the open one): sent.
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-15" }));
    await w.run("2026-10-15 18:00");
    assert.equal(w.cards.length, 3);
    assert.notEqual(w.cards[2]!.card.id, w.cards[0]!.card.id);
    assert.equal(w.deliveries.length, 2);
  }));

test("a channel that fails does not hold the card back: said on the page, tried at most three times, once per reconcile", () =>
  withWorld({}, async (w) => {
    w.fail.deliver = new Error("机器人 token 过期");
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:00");
    assert.equal(w.cards.length, 1, "the card is up");
    assert.ok(problems(w).includes("IM 没发出去：机器人 token 过期"));
    await w.run("2026-10-14 19:00");
    assert.equal(w.deliveries.length, 3);
    assert.ok(problems(w).includes("IM 没发出去：机器人 token 过期（试了 3 次，不再试）"));
    // Back before the tries run out, on another card: it goes, and the page is clear of it.
    w.fail.deliver = null;
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-15" }));
    await w.run("2026-10-15 18:00");
    assert.equal(w.deliveries.at(-1)!.ok, true);
  }));

test("a failed send is tried again at the next reconcile and then goes", () =>
  withWorld({}, async (w) => {
    w.fail.deliver = new Error("网络断了");
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:00");
    w.fail.deliver = null;
    await w.run("2026-10-14 18:15");
    assert.deepEqual(w.deliveries.map((d) => d.ok), [false, true]);
    assert.ok(!problems(w).some((p) => p.includes("没发出去")));
  }));

test("a host without server.deliver: the card is raised, and the page says the channel gets nothing", () =>
  withWorld({ deliver: false }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:00");
    assert.equal(w.cards.length, 1);
    assert.ok(problems(w).includes("这个 daemon 不支持投递，IM 收不到"));
  }));

test("rehearsing lists what would be sent, and sends nothing", () =>
  withWorld({ mode: "dry-run" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:00");
    const plan = (w.statuses as Array<{ plan: Array<{ summary: string }> }>).flatMap((s) => s.plan);
    assert.ok(plan.some((p) => p.summary === "会发 IM：#1 外放了吗？"));
    assert.equal(w.deliveries.length, 0);
  }));

test("in quiet hours nothing is sent, as no card is raised; both go when they are over", () =>
  withWorld({}, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    // Seen first at 20:30: due, but past 20:00.
    await w.run("2026-10-13 10:00");
    w.clock.now = Date.parse("2026-10-14T20:30:00+08:00");
    await w.run("2026-10-14 22:00");
    assert.deepEqual([w.cards.length, w.deliveries.length], [0, 0]);
    await w.run("2026-10-15 09:30");
    assert.deepEqual([w.cards.length, w.deliveries.length], [1, 1]);
  }));
