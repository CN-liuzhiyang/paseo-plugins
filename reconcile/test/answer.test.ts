import assert from "node:assert/strict";
import { test } from "node:test";
import type { Commitment } from "../shared/model";
import { at, issue, makeWorld, type World } from "./helpers";

// A question answered on the item's page and on its card: the same answer either way, whichever
// arrives first counts, the one that comes second is told "already answered" and records nothing,
// and the card follows (closed when nothing is left on it, cut down when something is).

const mini = `export default {
  name: "mini",
  description: "x",
  applies: { source: "gcp-demo" },
  params: {},
  stages: ["s"],
  assess(kase, ctx) {
    const d = (kase.primary.fields.Release || "").slice(0, 10);
    const base = { stage: "s", health: "on-track", headline: "h " + d, next: { actor: "nobody", what: "" }, facts: [], commitments: [] };
    if (!d) return base;
    return { ...base, health: "waiting", commitments: [{
      key: "q:" + kase.id, title: "q " + kase.id, domain: "work", owner: "owner",
      trigger: { at: ctx.at(d, "18:00") },
      ask: { header: "Q" + kase.id.split(":").pop(), question: "q " + kase.id + "?", options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "B", description: "" }], allowOther: true },
      brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 3 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }] };
  },
};`;

async function withWorld<T>(items: number[], body: (w: World) => Promise<T>): Promise<T> {
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": mini } } });
  try {
    for (const id of items) w.items.set(`gcp-demo:${id}`, issue(id, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    return await body(w);
  } finally {
    w.close();
  }
}

const commitment = (w: World, n: number) => Object.values(w.store.state.commitments).find((c) => c.key === `q:gcp-demo:${n}`) as Commitment;
const page = (w: World, n: number, input: { option?: string; text?: string }, round?: number) => {
  const c = commitment(w, n);
  return w.engine.answerQuestion(c.id, round ?? c.rounds, input);
};
const answersOf = (w: World) => Object.values(w.store.state.commitments).filter((c) => c.answer).length;

test("answered on the page first: the commitment is answered as on the card, the card is over, and the form that comes after is told it was answered", () =>
  withWorld([1], async (w) => {
    assert.equal(w.cards.length, 1);
    const cardId = w.cards[0]!.card.id;
    assert.equal(commitment(w, 1).status, "waiting");
    const done = page(w, 1, { option: "a" });
    assert.deepEqual([done.ok, done.already], [true, false]);
    const c = commitment(w, 1);
    assert.equal(c.status, "done");
    assert.deepEqual([c.answer!.option, c.answer!.label, c.answer!.via], ["a", "A", "page"]);
    assert.equal(w.store.state.cards[cardId]!.status, "answered", "nothing left to ask on it: it collapses at once");
    const late = w.answer({ Q1: "B" });
    assert.match(late, /已经答过了/);
    assert.equal(commitment(w, 1).answer!.label, "A", "the later answer changed nothing");
    assert.equal(answersOf(w), 1);
  }));

test("answered on the card first: the page is told it was answered, with what was answered and where, and records nothing", () =>
  withWorld([1], async (w) => {
    w.answer({ Q1: "B" });
    const c = commitment(w, 1);
    assert.equal(c.status, "done");
    assert.equal(c.answer!.label, "B");
    const late = page(w, 1, { option: "a" });
    assert.deepEqual([late.ok, late.already], [false, true]);
    assert.match(late.detail, /已经答过了：B/);
    assert.match(late.detail, /问题卡/);
    assert.equal(commitment(w, 1).answer!.label, "B");
  }));

test("the two ways give the same answer: the same option, label and text, only `via` tells them apart; a written answer is kept trimmed", () =>
  withWorld([1, 2, 3], async (w) => {
    page(w, 1, { option: "b" });
    w.answer({ Q2: "B" });
    const [byPage, byCard] = [commitment(w, 1).answer!, commitment(w, 2).answer!];
    assert.deepEqual([byPage.option, byPage.label, byPage.text], [byCard.option, byCard.label, byCard.text]);
    assert.deepEqual([byPage.via, byCard.via], ["page", "form"]);
    page(w, 3, { text: "  下周再说  " });
    assert.deepEqual([commitment(w, 3).answer!.option, commitment(w, 3).answer!.text], [null, "下周再说"]);
    assert.equal(commitment(w, 3).status, "done");
  }));

test("a card with other questions still open is not over when one is answered on the page; the form answers what is left and is told which was already answered", () =>
  withWorld([1, 2], async (w) => {
    assert.equal(w.cards.length, 1, "both questions are on one card");
    const cardId = w.cards[0]!.card.id;
    page(w, 1, { option: "a" });
    assert.notEqual(w.store.state.cards[cardId]!.status, "answered", "one is still waiting on it");
    const told = w.answer({ Q1: "B", Q2: "B" });
    assert.match(told, /已经答过了/, "the form says which one the page answered first");
    assert.deepEqual([commitment(w, 1).answer!.label, commitment(w, 1).answer!.via], ["A", "page"]);
    assert.equal(commitment(w, 2).answer!.label, "B");
    assert.equal(commitment(w, 2).answer!.via, "form");
    assert.equal(answersOf(w), 2);
  }));

test("a page that has fallen behind (an older ask), a made-up option, an empty answer, and a question not yet asked are each refused with the reason", () =>
  withWorld([1], async (w) => {
    const c = commitment(w, 1);
    assert.match(page(w, 1, { option: "a" }, c.rounds + 1).detail, /又问了一轮|旧的/);
    assert.match(page(w, 1, { option: "zzz" }).detail, /没有这个选项/);
    assert.match(page(w, 1, {}).detail, /先选一个/);
    assert.match(page(w, 1, { text: "   " }).detail, /先选一个/);
    assert.equal(commitment(w, 1).status, "waiting", "none of them recorded anything");
    assert.match(w.engine.answerQuestion("no-such-id", 1, { option: "a" }).detail, /不在了/);
    // not yet asked
    w.items.set("gcp-demo:3", issue(3, { release: "2026-10-20" }));
    await w.run("2026-10-14 19:00");
    const later = commitment(w, 3);
    assert.equal(later.status, "scheduled");
    assert.match(w.engine.answerQuestion(later.id, later.rounds, { option: "a" }).detail, /还没有问到/);
  }));

test("a question that does not take written answers refuses one", () =>
  makeWorld({
    start: "2026-10-13 10:00",
    config: { rules: { "mini.mjs": mini.replace("allowOther: true", "allowOther: false") } },
  }).then(async (w) => {
    try {
      w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
      await w.run("2026-10-14 18:30");
      assert.match(page(w, 1, { text: "随便写" }).detail, /只能选/);
      assert.equal(page(w, 1, { option: "a" }).ok, true);
    } finally {
      w.close();
    }
  }));

test("a question that expired or was taken back says so instead of taking an answer", () =>
  withWorld([1], async (w) => {
    const c = commitment(w, 1);
    // The backstop passes with nobody answering.
    await w.run("2026-12-31 18:30", 24 * 60);
    assert.equal(commitment(w, 1).status, "expired");
    const r = w.engine.answerQuestion(c.id, c.rounds, { option: "a" });
    assert.deepEqual([r.ok, r.already], [false, false]);
    assert.match(r.detail, /过期/);
  }));

// ---- while the card is being raised -------------------------------------------------------------------------------
// The question is on the page from the moment it is waiting, which is before the card's carrier is up: an answer given
// in that window is the answer, whether the carrier then comes up or fails.

async function answeredWhileRaising(carrierFails: boolean) {
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": mini } } });
  try {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 17:00");
    let result: ReturnType<typeof w.engine.answerQuestion> | null = null;
    w.hooks.raise = () => {
      const c = commitment(w, 1);
      assert.equal(c.status, "waiting", "the page can already see the question");
      result = w.engine.answerQuestion(c.id, c.rounds, { option: "a" });
    };
    if (carrierFails) w.fail.carrier = new Error("carrier down");
    w.clock.now = at("2026-10-14 18:05");
    await w.engine.tick();
    w.hooks.raise = null;
    w.fail.carrier = null;
    const afterTick = { commitment: { ...commitment(w, 1) }, cards: Object.values(w.store.state.cards).map((c) => c.status), raised: w.cards.length, archived: [...w.archived] };
    await w.run("2026-10-14 19:30");
    return { result: result as ReturnType<typeof w.engine.answerQuestion> | null, afterTick, later: { commitment: commitment(w, 1), raised: w.cards.length, cards: Object.values(w.store.state.cards).map((c) => c.status) } };
  } finally {
    w.close();
  }
}

test("an answer given on the page while the card is being raised is kept, and the card that comes up for it is taken down, not raised", async () => {
  const r = await answeredWhileRaising(false);
  assert.deepEqual([r.result!.ok, r.result!.already], [true, false]);
  assert.deepEqual([r.afterTick.commitment.status, r.afterTick.commitment.answer!.label, r.afterTick.commitment.answer!.via], ["done", "A", "page"]);
  assert.deepEqual(r.afterTick.cards, ["answered"], "the answer ended the card; the carrier coming up does not make it a card again");
  assert.deepEqual(r.afterTick.archived, ["agent-1"], "and the agent that came up for it goes");
  assert.equal(r.later.commitment.answer!.label, "A");
  assert.equal(r.later.raised, 1, "nothing is asked again");
});

test("an answer given on the page while the card is being raised is kept when the card cannot be raised: the question is not asked again", async () => {
  const r = await answeredWhileRaising(true);
  assert.equal(r.result!.ok, true);
  assert.deepEqual([r.afterTick.commitment.status, r.afterTick.commitment.answer!.label], ["done", "A"], "it is not put back to 'not asked yet'");
  assert.equal(r.afterTick.raised, 0);
  assert.equal(r.later.raised, 0, "and 25 minutes on, no card is raised for a question that has been answered");
  assert.deepEqual([r.later.commitment.status, r.later.commitment.answer!.label], ["done", "A"], "the answer is not overwritten or lost");
});
