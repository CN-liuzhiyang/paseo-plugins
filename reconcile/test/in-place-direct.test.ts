import assert from "node:assert/strict";
import { test } from "node:test";
import type { World } from "./helpers";
import { assessed, converse, PERSONS, say, tell, withDesk } from "./desk-kit";

// Something said about a matter in the admin's own chat with `--said -` (the words are the message itself) takes effect at once; a card that
// asked the same thing about the matter is taken back when it does, or when it is found already in force; and what is asked names the matter.

const MINE = { source: "chatapp", "chatapp-chat": "p2p:owner" };
const withAdmin = <T>(body: (w: World) => Promise<T>, askHere = false) => withDesk(body, { askHere, persons: PERSONS({ chats: [MINE], notify: [{ channel: "im", to: "p2p:owner", label: "IM" }] }) });
const cards = (w: World) => Object.values(w.store.state.commitments).filter((c) => c.origin.who === "confirm");
/** A drop of D1 on a card: the words came from an agent with no person in the conversation to ask. */
async function carded(w: World) {
  await tell(w, "帮我盯一下年检，月底前要约上", "年检取模");
  converse(w, {}, [{ kind: "person", text: "随便聊聊" }]);
  const id = say(w, { cmd: "say", kind: "drop", item: "D1", said: "他说年检不用盯了" });
  await w.engine.tick();
  assert.equal(w.receipt(id)!.outcome, "proposed", w.receipt(id)!.text);
  assert.equal(cards(w).length, 1);
  return id;
}

test("drop, hold and wrong said with --said - in the admin's own chat take effect on the message itself, and the receipt says how to take it back", () =>
  withAdmin(async (w) => {
    await tell(w, "帮我盯一下年检，月底前要约上", "年检取模");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["先别问年检了，到下个月再说", { kind: "hold", until: "2026-11-20" }],
      ["年检这个判断不对", { kind: "wrong", what: "阶段", expected: "已约上" }],
      ["算了，年检不用管了", { kind: "drop" }],
    ];
    for (const [text, extra] of cases) {
      converse(w, MINE, [{ kind: "person", text }]);
      const id = say(w, { cmd: "say", item: "D1", said: "-", ...extra });
      await w.engine.tick();
      assert.equal(w.receipt(id)!.outcome, "applied", `${text}: ${w.receipt(id)!.text}`);
      assert.match(w.receipt(id)!.text, /撤销：reconcile-say undo --id a_[0-9a-f]{12}/, "the way back is kept for the agent");
      const a = Object.values(w.store.state.annotations).find((x) => x.said === text)!;
      assert.equal(a.how, "own-words");
    }
    assert.equal(assessed(w, 1)?.stage, "dropped");
  }));

test("a card that asks to drop the matter is taken back when the drop takes effect, with the reason", () =>
  withAdmin(async (w) => {
    const id = await carded(w);
    converse(w, MINE, [{ kind: "person", text: "算了，年检不用管了" }]);
    const said = say(w, { cmd: "say", item: "D1", kind: "drop", said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(said)!.outcome, "applied");
    const card = cards(w)[0]!;
    assert.equal(card.status, "cancelled");
    assert.match(card.reason ?? "", /^已办：/);
    assert.equal(w.store.state.requests[id]!.outcome, "proposed");
    assert.equal(Object.values(w.store.state.commitments).filter((c) => c.status === "waiting" && c.origin.who === "confirm").length, 0);
  }));

test("a card left over from before, for a matter already dropped, is taken back by the next reconcile", () =>
  withAdmin(async (w) => {
    await carded(w);
    // the drop got into force another way (a journal from before this check)
    const key = Object.values(w.store.state.annotations).find((a) => a.kind === "track")!.caseId;
    w.store.append([{ type: "annotation.added", annotation: { id: "a_other2", caseId: key, kind: "drop", said: "不用管了", by: "owner", via: null, how: "own-words", at: new Date(w.clock.now).toISOString(), until: null, person: null, what: null, expected: null, revoked: null } }]);
    await w.engine.tick();
    assert.equal(cards(w)[0]!.status, "cancelled");
    assert.match(cards(w)[0]!.reason ?? "", /^已办：/);
  }));

test("a card asking for a different hold, or a different kind, is left alone", () =>
  withAdmin(async (w) => {
    await carded(w);
    converse(w, MINE, [{ kind: "person", text: "先别问年检了，到下个月再说" }]);
    say(w, { cmd: "say", item: "D1", kind: "hold", until: "2026-11-20", said: "-" });
    await w.engine.tick();
    assert.equal(cards(w)[0]!.status, "waiting");
  }));

test("what is asked names the matter: in the conversation and on the card", () =>
  withAdmin(async (w) => {
    await tell(w, "帮我盯一下年检，月底前要约上", "年检取模");
    converse(w, MINE, [{ kind: "person", text: "算了，年检不用管了" }]);
    const id = say(w, { cmd: "say", item: "D1", kind: "drop", said: "他说年检不用盯了" });
    await w.engine.tick();
    assert.equal(w.receipt(id)!.outcome, "asked");
    const question = w.store.state.requests[id]!.question!;
    assert.match(question, /^要我不盯「年检取模」（D1）吗？/);
    assert.match(w.receipt(id)!.text, /他回了同意以后（比如「要」「对」），在前台跑：reconcile-say confirm --id/);
  }, true));

test("the card names the matter too", () =>
  withAdmin(async (w) => {
    await carded(w);
    assert.match(cards(w)[0]!.ask.question, /^要不盯「年检取模」（D1）吗/);
  }));

test("the yes given in the conversation is recorded as given there; the yes on a card as given on the card", () =>
  withAdmin(async (w) => {
    await tell(w, "帮我盯一下年检，月底前要约上", "年检取模");
    converse(w, MINE, [{ kind: "person", text: "算了，年检不用管了" }]);
    const id = say(w, { cmd: "say", item: "D1", kind: "drop", said: "他说年检不用盯了" });
    await w.engine.tick();
    const question = w.store.state.requests[id]!.question!;
    converse(w, MINE, [{ kind: "person", text: "要" }], question);
    const cid = say(w, { cmd: "confirm", pending: id, said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(cid)!.outcome, "applied", w.receipt(cid)!.text);
    assert.equal(Object.values(w.store.state.annotations).find((a) => a.kind === "drop")!.how, "confirmed-here");
    assert.match(assessed(w, 1)!.headline, /在对话里确认/);
  }, true));

test("the yes on a card is recorded as given on the card", () =>
  withAdmin(async (w) => {
    await carded(w);
    const card = cards(w)[0]!;
    assert.equal(w.engine.answerQuestion(card.id, card.rounds, { option: "yes" }).ok, true);
    await w.engine.tick();
    assert.equal(Object.values(w.store.state.annotations).find((a) => a.kind === "drop")!.how, "confirmed");
    assert.match(assessed(w, 1)!.headline, /在卡片上确认/);
  }));
