import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderInput } from "@getpaseo/plugin/server/provider";
import type { Commitment } from "../shared/model";
import { createInboxProvider } from "../server/inbox";
import { planText } from "../index.server";
import { troubleOf } from "../shared/status";
import { at, issue, makeWorld, type World } from "./helpers";

// Cards across failures and restarts, with a minimal rule: one question per issue, asked at
// 18:00 on its release day: Paseo shutting down under an open card, restarts in quiet hours,
// carriers that cannot be raised, questions taken back, repeated headers.

const mini = (header = "Q", withId = false) => `export default {
  name: "mini",
  description: "x",
  applies: { source: "gcp-demo" },
  params: {},
  stages: ["s"],
  assess(kase, ctx) {
    const d = (kase.primary.fields.Release || "").slice(0, 10);
    const base = { stage: "s", health: "on-track", headline: "h " + d, next: { actor: "nobody", what: "" }, facts: [] };
    if (!d) return { ...base, commitments: [] };
    return { ...base, health: "waiting", commitments: [{
      key: "q:" + kase.id, title: "q " + kase.id, domain: "work", owner: "owner",
      trigger: { at: ctx.at(d, "18:00") },
      ask: { header: ${JSON.stringify(header)}${withId ? ' + kase.id.split(":").pop()' : ""}, question: "q " + kase.id + "?", options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "B", description: "" }], allowOther: true },
      brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 3 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }] };
  },
};`;

async function withMini<T>(options: { header?: string; withId?: boolean; pushPerDay?: number }, body: (w: World) => Promise<T>): Promise<T> {
  const persons = options.pushPerDay ? { owner: { name: "测试用户", admin: true, tz: "Asia/Shanghai", quiet: { work: "workdays 09:30-20:00" }, pushPerDay: options.pushPerDay } } : undefined;
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": mini(options.header ?? "Q", options.withId) }, ...(persons ? { persons } : {}) } });
  try {
    return await body(w);
  } finally {
    w.close();
  }
}

const commitment = (w: World, n = 1) => Object.values(w.store.state.commitments).find((c) => c.key === `q:gcp-demo:${n}`) as Commitment;

test("after Paseo shuts down (session.close, then the connection), the open card gets a new carrier on restart", () =>
  withMini({}, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    assert.equal(w.cards.length, 1);
    const cardId = w.cards[0]!.card.id;
    const provider = createInboxProvider({ card: (id) => w.engine.card(id), answer: (id, a) => w.engine.answer(id, a) }, { closeGraceMs: 200 });
    const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.steer", "permission"] });
    const send = async (input: unknown) => (await conn.send(input as ProviderInput), new Promise((r) => setTimeout(r, 20)));
    await send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: "/x", env: {}, mcpServers: {}, settings: {}, persist: true, title: "t" } });
    await send({ type: "session.prompt", sessionId: "s1", prompt: { delivery: "auto", clientMessageId: "m1", input: { type: "message", content: [{ type: "text", text: `事务问题卡 ${cardId}` }] } } });
    await send({ type: "session.close", requestId: "r2", sessionId: "s1" });
    await conn.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(w.store.state.cards[cardId]!.status, "raised", "not taken for a person closing it");
    await w.restart("live");
    assert.equal(w.cards.length, 2, "a new carrier for the same card");
    assert.equal(w.cards[1]!.card.id, cardId);
  }));

test("a restart outside quiet hours does not bring the open card back until they are over, and it does not count again", () =>
  withMini({}, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    assert.equal(w.cards.length, 1);
    w.clock.now = at("2026-10-15 03:10");
    await w.restart("live");
    assert.equal(w.cards.length, 1, "nothing at 03:10");
    assert.equal(w.store.state.cards[w.cards[0]!.card.id]!.status, "pending");
    await w.run("2026-10-15 09:20");
    assert.equal(w.cards.length, 1);
    await w.run("2026-10-15 09:45");
    assert.equal(w.cards.length, 2, "back once quiet hours are over");
    assert.equal(w.cards[1]!.card.id, w.cards[0]!.card.id);
  }));

test("a card that could not be raised does not use up the day's budget", () =>
  withMini({ pushPerDay: 3 }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    w.fail.carrier = new Error("workspace create failed");
    await w.run("2026-10-14 19:00");
    assert.equal(w.cards.length, 0);
    assert.ok(Object.values(w.store.state.cards).length >= 3, "it kept trying");
    w.fail.carrier = null;
    await w.run("2026-10-14 19:55");
    assert.equal(w.cards.length, 1, "raised once the carrier is back, the same evening");
  }));

test("when the next card cannot be raised, the open one stays open", () =>
  withMini({ header: "Q", withId: true }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    const first = w.cards[0]!.card.id;
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-14" }));
    w.fail.carrier = new Error("workspace create failed");
    await w.run("2026-10-14 19:00");
    assert.equal(w.store.state.cards[first]!.status, "raised");
    assert.deepEqual(w.archived, []);
    assert.equal(commitment(w, 1).status, "waiting");
  }));

test("a nag that cannot be raised goes back to the last ask's time, so it is asked again the same morning", () =>
  withMini({}, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    const firstAsked = commitment(w).lastAskedAt;
    w.fail.carrier = new Error("boom");
    await w.run("2026-10-15 10:30");
    assert.equal(commitment(w).lastAskedAt, firstAsked);
    assert.equal(commitment(w).rounds, 1);
    w.fail.carrier = null;
    await w.run("2026-10-15 12:00");
    assert.equal(w.cards.length, 2, "the nag went out once the carrier was back");
  }));

test("a question taken back because its trigger moved later is asked again at the new trigger", () =>
  withMini({}, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    assert.equal(w.cards.length, 1);
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-19" }));
    await w.run("2026-10-14 19:30");
    assert.equal(commitment(w).status, "scheduled");
    assert.equal(w.store.state.ledger[`ask:${commitment(w).id}:1`]!.status, "superseded");
    await w.run("2026-10-19 19:30");
    assert.equal(w.cards.length, 2);
  }));

test("two questions with the same header on one card are told apart, and one answer fills only its own", () =>
  withMini({ header: "Q" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    assert.equal(w.cards.length, 1);
    assert.deepEqual(w.cards[0]!.content.questions.map((q) => q.header), ["Q", "Q（2）"]);
    w.answer({ Q: "A" });
    assert.equal(commitment(w, 1).status, "done");
    assert.equal(commitment(w, 2).status, "waiting");
  }));

test("the brief's heading is the header and the title, but only the title when the title already starts with the header", async () => {
  await withMini({ header: "Q" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    assert.match(w.cards[0]!.content.brief, /^### Q：q gcp-demo:1\n\n/);
  });
  await withMini({ header: "q gcp-demo:", withId: true }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    assert.equal(w.cards[0]!.content.questions[0]!.header, "q gcp-demo:1");
    assert.match(w.cards[0]!.content.brief, /^### q gcp-demo:1\n\n/);
  });
});

test("the page lists a case waiting on you before one that is fine, and plan.md says what each step is in words", () =>
  withMini({}, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-20" }));
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    const status = w.engine.status();
    assert.deepEqual(status.cases.map((c) => c.caseId), ["gcp-demo:2", "gcp-demo:1"]);
    const text = planText({ ...status, plan: [{ at: status.now, kind: "card", person: "owner", summary: "x" }, { at: status.now, kind: "note", person: null, summary: "y" }] });
    assert.match(text, /- \[发卡\] x\n- \[记事实\] y/);
  }));

test("a reconcile that runs long says so, and since when, and is late only past its limit", () =>
  withMini({}, async (w) => {
    await w.run("2026-10-13 10:00");
    let release!: () => void;
    w.hold = new Promise((r) => (release = r));
    w.clock.now = at("2026-10-13 10:30");
    const running = w.engine.tick();
    w.clock.now = at("2026-10-13 10:38");
    const during = w.engine.status();
    assert.equal(during.ticking, true);
    assert.equal(Date.parse(during.tickStartedAt!), at("2026-10-13 10:30"));
    assert.equal(Date.parse(during.lastTickAt!), at("2026-10-13 10:00"), "the last finished reconcile is still the one before");
    assert.deepEqual([troubleOf(during).late, troubleOf(during).stuck], [false, false], "eight minutes in: running, not late");
    // Past max(10 minutes, five periods): one stuck on a call that never returns is late again.
    w.clock.now = at("2026-10-13 10:41");
    assert.deepEqual([troubleOf(w.engine.status()).late, troubleOf(w.engine.status()).stuck], [true, true]);
    w.hold = null;
    release();
    await running;
    const after = w.engine.status();
    assert.equal(after.ticking, false);
    assert.equal(after.tickStartedAt, null);
  }));
