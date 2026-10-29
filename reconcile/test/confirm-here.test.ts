import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnStep } from "../server/requests";
import type { World } from "./helpers";
import { assessed, converse, item, note, own, PERSONS, say, tell, track, withDesk } from "./desk-kit";

// Words that cannot be taken as the person's own, said in a conversation the person is in, are not put on a card: the agent is given a
// sentence to ask them there, and their yes (confirm) is checked against the conversation. Each check of that yes has a test that fails
// when the check is gone.

const MINE = { source: "chatapp", "chatapp-chat": "p2p:owner" };
const GROUP = { source: "chatapp", "chatapp-chat": "group:team" };
const NOT_THEIRS = "帮我盯一下体检"; // the agent's copy: the person's message is not this
const withHere = <T>(body: (w: World) => Promise<T>, options: Parameters<typeof withDesk>[1] = {}) => withDesk(body, { askHere: true, ...options });
const mine = () => PERSONS({ chats: [MINE], notify: [{ channel: "im", to: "p2p:owner", label: "IM" }] });

/** The agent tells a matter with words it did not take from the person: the receipt is a question to ask them. */
async function asked(w: World, labels: Record<string, string> = {}) {
  converse(w, labels, [{ kind: "person", text: "随便聊聊，月底前要约上体检" }]);
  const id = say(w, track(NOT_THEIRS, "年度体检", "personal"));
  await w.engine.tick();
  const receipt = w.receipt(id)!;
  return { id, receipt, question: w.store.state.requests[id]?.question ?? "" };
}

/** A turn of the conversation with these steps, in which the agent runs confirm. */
async function confirmIn(w: World, id: string, steps: TurnStep[], before?: string, labels: Record<string, string> = {}) {
  converse(w, labels, steps, before);
  const cid = say(w, { cmd: "confirm", pending: id, said: "-" });
  await w.engine.tick();
  return w.receipt(cid)!;
}
/** The person's next message, which the agent asked the question just before. */
const reply = (w: World, id: string, text: string, said: string, labels: Record<string, string> = {}) => confirmIn(w, id, [{ kind: "person", text }], said, labels);
const tracked = (w: World) => Object.values(w.store.state.items).filter((i) => i.key.startsWith("desk:")).length;

test("words that do not check out, in the person's own conversation, are not put on a card: the agent is told what to ask", () =>
  withHere(async (w) => {
    const { id, receipt, question } = await asked(w);
    assert.equal(receipt.outcome, "asked", receipt.text);
    assert.match(question, /^要我盯「年度体检」吗？/);
    assert.ok(receipt.text.includes(question), "the sentence is in the receipt");
    assert.match(receipt.text, new RegExp(`reconcile-say confirm --id ${id} --said -`));
    assert.equal(Object.values(w.store.state.commitments).filter((c) => c.origin.who === "confirm").length, 0, "no card");
    assert.equal(tracked(w), 0, "and nothing is told yet");
  }));

test("their yes after the question was asked word for word tells the matter, as it was asked", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    const done = await reply(w, id, "要", `好的。${question}`);
    assert.equal(done.outcome, "applied", done.text);
    assert.match(done.text, /记下了/);
    assert.equal(item(w, 1)?.title, "年度体检");
  }));

test("Markdown, quote styles and spaces in the agent's wording do not matter; a particle after the yes does not either", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    const said = `**${question.replace("吗？", "吗？ ").replace(/「/g, ' "').replace(/」/g, '" ')}**`;
    const done = await reply(w, id, "要的", said);
    assert.equal(done.outcome, "applied", done.text);
  }));

// ---- what has to hold, one by one ---------------------------------------------------------------------------------------

test("the question not said as written: the yes is not taken", () =>
  withHere(async (w) => {
    const { id } = await asked(w);
    const done = await reply(w, id, "要", "我帮你盯着体检这件事，可以吗？");
    assert.equal(done.outcome, "rejected", done.text);
    assert.equal(tracked(w), 0);
  }));

test("the question said only after their message (the yes came before it was asked): not taken", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    const done = await confirmIn(w, id, [{ kind: "person", text: "要" }, { kind: "text", text: question }]);
    assert.equal(done.outcome, "rejected", done.text);
    assert.equal(tracked(w), 0);
  }));

test("the question said in the same turn, right before their yes, counts as much as one said in the turn before", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    const done = await confirmIn(w, id, [{ kind: "text", text: question }, { kind: "person", text: "要吧" }]);
    assert.equal(done.outcome, "applied", done.text);
  }));

test("a reply that is more than a yes is not a yes: words of their own, a no, a yes with a condition", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    for (const text of ["不要", "要吗？先等等", "好的，不过别太频繁", "好像不太对", "随便"]) {
      const done = await reply(w, id, text, question);
      assert.equal(done.outcome, "rejected", `${text}: ${done.text}`);
    }
    assert.equal(tracked(w), 0);
  }));

test("a turn that no message of theirs began (woken by a notice) cannot carry their yes", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    const done = await confirmIn(w, id, [], question);
    assert.equal(done.outcome, "rejected", done.text);
    assert.equal(tracked(w), 0);
  }));

test("another agent's message between their yes and the command: not their yes", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    const done = await confirmIn(w, id, [{ kind: "person", text: "要" }, { kind: "agent" }], question);
    assert.equal(done.outcome, "rejected", done.text);
    assert.equal(tracked(w), 0);
  }));

test("another conversation cannot confirm it", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    w.conversations.set("agent-other", { labels: {}, cwd: "/work", turn: { id: "tx", steps: [{ kind: "person", text: "要" }, { kind: "command", text: `node D:/plugins/reconcile/bin/reconcile-say.mjs confirm --id ${id} --said "-"` }] }, before: question });
    const cid = w.say({ cmd: "confirm", pending: id, said: "-", via: "agent-other" });
    await w.engine.tick();
    assert.equal(w.receipt(cid)!.outcome, "rejected");
    assert.match(w.receipt(cid)!.text, /另一个对话/);
    assert.equal(tracked(w), 0);
  }));

test("after 30 minutes it is no longer asked: the yes is not taken", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    w.clock.now += 31 * 60_000;
    const done = await reply(w, id, "要", question);
    assert.equal(done.outcome, "rejected", done.text);
    assert.equal(tracked(w), 0);
  }));

test("within 30 minutes it is", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    w.clock.now += 29 * 60_000;
    assert.equal((await reply(w, id, "要", question)).outcome, "applied");
  }));

test("a question is used once: a second yes does not tell it again", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    assert.equal((await reply(w, id, "要", question)).outcome, "applied");
    const again = await reply(w, id, "对", question);
    assert.equal(again.outcome, "rejected", again.text);
    assert.match(again.text, /已经确认过了/);
    assert.equal(tracked(w), 1);
  }));

test("one message of theirs confirms one question", () =>
  withHere(async (w) => {
    const first = await asked(w);
    converse(w, {}, [{ kind: "person", text: "随便聊聊，也盯一下续费" }]);
    const second = say(w, track("帮我盯一下续费", "续费", "personal"));
    await w.engine.tick();
    const q2 = w.store.state.requests[second]!.question!;
    // one "要" after both questions as the agent asked them: it confirms the first, and cannot also confirm the second
    converse(w, {}, [{ kind: "person", text: "要" }], `${first.question}
${q2}`);
    const a = say(w, { cmd: "confirm", pending: first.id, said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(a)!.outcome, "applied");
    const b = say(w, { cmd: "confirm", pending: second, said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(b)!.outcome, "rejected", w.receipt(b)!.text);
    assert.equal(tracked(w), 1);
  }));

test("a confirm of an id that was never asked, or that was put on a card, is refused", () =>
  withHere(async (w) => {
    const { id } = await asked(w);
    for (const pending of ["r_000000000000", id.replace(/.$/, (c) => (c === "0" ? "1" : "0"))]) {
      converse(w, {}, [{ kind: "person", text: "要" }]);
      const cid = say(w, { cmd: "confirm", pending, said: "-" });
      await w.engine.tick();
      assert.equal(w.receipt(cid)!.outcome, "rejected");
    }
  }));

// ---- where the person is, and where they are not ---------------------------------------------------------------------------------

test("in a group chat nobody can be asked in place: the card, as before", () =>
  withHere(
    async (w) => {
      const { receipt } = await asked(w, GROUP);
      assert.equal(receipt.outcome, "proposed", receipt.text);
    },
    { persons: mine() },
  ));

test("in the admin's own chat words the agent copied, that cannot be checked against the message, are asked in place too", () =>
  withHere(
    async (w) => {
      await tell(w, "帮我盯一下体检，月底前要约上", "年度体检");
      assert.equal(tracked(w), 1);
      converse(w, MINE, [{ kind: "person", text: "不用盯体检了" }]);
      // the agent copied the words as it understood them (not the message itself): it cannot be checked, so it is asked
      const id = say(w, { cmd: "say", kind: "drop", item: "D1", said: "他说体检不用盯了" });
      await w.engine.tick();
      const receipt = w.receipt(id)!;
      assert.equal(receipt.outcome, "asked", receipt.text);
      const question = w.store.state.requests[id]!.question!;
      assert.match(question, /不再追踪「年度体检」（D1）/);
      assert.notEqual(assessed(w, 1)?.stage, "dropped");
      const done = await reply(w, id, "要的", question, MINE);
      assert.equal(done.outcome, "applied", done.text);
      assert.match(done.text, /不再追踪/);
    },
    { persons: mine() },
  ));

test("a matter told again in the minutes after it was asked: the yes tells nothing twice", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    // the same matter told in the person's own words in the meantime
    await tell(w, "帮我盯一下体检", "年度体检");
    assert.equal(tracked(w), 1);
    const done = await reply(w, id, "要", question);
    assert.equal(done.outcome, "rejected", done.text);
    assert.match(done.text, /已经在盯了/);
    assert.equal(tracked(w), 1);
  }));

test("the matter ended another way in the minutes after it was asked to end: the yes ends nothing twice", () =>
  withHere(
    async (w) => {
      await tell(w, "帮我盯一下体检，月底前要约上", "年度体检");
      converse(w, MINE, [{ kind: "person", text: "不用盯体检了" }]);
      const id = say(w, { cmd: "say", kind: "drop", item: "D1", said: "他说体检不用盯了" });
      await w.engine.tick();
      const question = w.store.state.requests[id]!.question!;
      // the same thing, said in the person's own conversation and taken at once
      own(w, "不用盯体检了");
      const direct = say(w, { cmd: "say", kind: "drop", item: "D1", said: "不用盯体检了" });
      await w.engine.tick();
      assert.equal(w.receipt(direct)!.outcome, "applied", w.receipt(direct)!.text);
      const done = await reply(w, id, "要", question, MINE);
      assert.equal(done.outcome, "rejected", done.text);
      assert.match(done.text, /已经不再追踪/);
    },
    { persons: mine() },
  ));

test("a request that was put on a card (nobody could be asked) cannot be confirmed by a yes in a conversation", () =>
  withHere(
    async (w) => {
      const { id, receipt } = await asked(w, GROUP);
      assert.equal(receipt.outcome, "proposed");
      const done = await reply(w, id, "要", "要我盯「年度体检」吗？（回「要」就办）");
      assert.equal(done.outcome, "rejected", done.text);
      assert.equal(tracked(w), 0);
    },
    { persons: mine() },
  ));

// ---- fix B: what is asked is what is recorded; the yes comes after the question; few yes words; no silent lapse ------------------------

test("the question carries the words that will be recorded as theirs, and what is recorded is those words", () =>
  withHere(async (w) => {
    const AGENT_WORDS = "已经约好了，不用再盯，也不要再问我";
    converse(w, {}, [{ kind: "person", text: "随便聊聊，月底前要约上体检" }]);
    const id = say(w, track(AGENT_WORDS, "年度体检", "personal"));
    await w.engine.tick();
    const question = w.store.state.requests[id]!.question!;
    assert.ok(question.includes(`「${AGENT_WORDS}」`), question);
    assert.ok(w.receipt(id)!.text.includes(question));
    assert.equal((await reply(w, id, "要", question)).outcome, "applied");
    assert.equal(Object.values(w.store.state.annotations).find((a) => a.kind === "track")?.said, AGENT_WORDS);
  }));

test("a line added to a matter: the person is shown the line", () =>
  withHere(async (w) => {
    converse(w, {}, [{ kind: "person", text: "帮我盯一下体检，月底前要约上" }]);
    say(w, track("-", "年度体检", "personal"));
    await w.engine.tick();
    assert.ok(item(w, 1), "told");
    const LINE = "体检已经做完了，这件事结束";
    converse(w, {}, [{ kind: "person", text: "补一句，下周三下午去" }]);
    const id = say(w, note("D1", LINE));
    await w.engine.tick();
    assert.ok(w.store.state.requests[id]!.question!.includes(`「${LINE}」`));
  }));

test("a judgment said to be wrong: the question carries what is wrong and what it should be", () =>
  withHere(async (w) => {
    converse(w, {}, [{ kind: "person", text: "帮我盯一下体检，月底前要约上" }]);
    say(w, track("-", "年度体检", "personal"));
    await w.engine.tick();
    converse(w, {}, [{ kind: "person", text: "这个判断好像不太对" }]);
    const id = say(w, { cmd: "say", kind: "wrong", item: "D1", said: "判断不对", what: "阶段说成了已约上", expected: "还没约" });
    await w.engine.tick();
    const question = w.store.state.requests[id]!.question!;
    assert.match(question, /「阶段说成了已约上」/);
    assert.match(question, /「还没约」/);
  }));

test("words too long to show are cut, the question says so, and what is recorded is what was shown", () =>
  withHere(async (w) => {
    const LONG = `这是一段很长的话。${"约上体检，".repeat(80)}`;
    converse(w, {}, [{ kind: "person", text: "随便聊聊，月底前要约上体检" }]);
    const id = say(w, track(LONG, "年度体检", "personal"));
    await w.engine.tick();
    const question = w.store.state.requests[id]!.question!;
    assert.match(question, /话太长/);
    const shown = w.store.state.requests[id]!.request!.said;
    assert.ok(shown.length <= 200 && question.includes(`「${shown}」`));
    assert.equal((await reply(w, id, "要", question)).outcome, "applied");
    assert.equal(Object.values(w.store.state.annotations).find((a) => a.kind === "track")?.said, shown);
  }));

test("the question said ahead of time and a 要 said to something else, with the command run after both: not their yes to it", () =>
  withHere(async (w) => {
    const PRE_SAID = "顺便一说：要我盯「年度体检」吗？记下的原话是「帮我盯一下体检」（回「要」就办）你先看看别的，晚点回我。";
    converse(w, {}, [{ kind: "person", text: "要" }], PRE_SAID);
    const id = say(w, track("帮我盯一下体检", "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(w.receipt(id)!.outcome, "asked");
    const cid = say(w, { cmd: "confirm", pending: id, said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(cid)!.outcome, "rejected", w.receipt(cid)!.text);
    assert.equal(tracked(w), 0);
  }));

test("the same with a 好: before the command that made the question, it is not their answer to it", () =>
  withHere(async (w) => {
    const PRE_SAID = "顺便一说：要我盯「年度体检」吗？记下的原话是「帮我盯一下体检」（回「要」就办）你先看看别的，晚点回我。";
    converse(w, {}, [{ kind: "person", text: "好" }], PRE_SAID);
    const id = say(w, track("帮我盯一下体检", "年度体检", "personal"));
    await w.engine.tick();
    const cid = say(w, { cmd: "confirm", pending: id, said: "-" });
    await w.engine.tick();
    assert.notEqual(w.receipt(cid)!.outcome, "applied");
    assert.equal(tracked(w), 0);
  }));

test("in the turn the question was made in, their yes after the command that made it counts", () =>
  withHere(async (w) => {
    const c = converse(w, {}, [{ kind: "person", text: "随便聊聊，月底前要约上体检" }]);
    const id = say(w, track(NOT_THEIRS, "年度体检", "personal"));
    await w.engine.tick();
    const question = w.store.state.requests[id]!.question!;
    c.turn!.steps.push({ kind: "text", text: question }, { kind: "person", text: "要" });
    const cid = say(w, { cmd: "confirm", pending: id, said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(cid)!.outcome, "applied", w.receipt(cid)!.text);
  }));

test("a 好 that comes in answer to the question is a yes (what is a yes: wrapped-commands.test.ts)", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    assert.equal((await reply(w, id, "好的", question)).outcome, "applied");
  }));

/** The asked one is past its 30 minutes and the reconcile has run: what became of it. */
const lapsed = async (w: World, id: string) => {
  w.clock.now += 31 * 60_000;
  await w.engine.tick();
  return w.store.state.requests[id]!;
};
const cards = (w: World) => Object.values(w.store.state.commitments).filter((c) => c.origin.who === "confirm");

test("a question nobody confirmed in 30 minutes becomes a confirmation card with the words on it, and the log and the receipt say so", () =>
  withHere(async (w) => {
    const { id } = await asked(w);
    assert.equal(cards(w).length, 0);
    const rec = await lapsed(w, id);
    assert.equal(rec.outcome, "proposed", rec.detail);
    assert.match(rec.detail, /当场问没确认上，改发卡/);
    assert.match(rec.why ?? "", /当场问没确认上，改发卡/);
    assert.equal(rec.question, undefined, "it can no longer be confirmed in the conversation");
    assert.equal(cards(w).length, 1);
    assert.match(cards(w)[0]!.brief, new RegExp(NOT_THEIRS));
    assert.equal(tracked(w), 0, "and nothing is told until the card is answered");
    // once: later reconciles do not make more
    await w.engine.tick();
    assert.equal(cards(w).length, 1);
  }));

test("a card made that way, answered yes, tells the matter as asked", () =>
  withHere(async (w) => {
    const { id } = await asked(w);
    await lapsed(w, id);
    const card = cards(w)[0]!;
    assert.equal(w.engine.answerQuestion(card.id, card.rounds, { option: "yes" }).ok, true);
    await w.engine.tick();
    assert.equal(item(w, 1)?.title, "年度体检");
  }));

test("a question confirmed in time is not made a card", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    assert.equal((await reply(w, id, "要", question)).outcome, "applied");
    w.clock.now += 31 * 60_000;
    await w.engine.tick();
    assert.equal(cards(w).length, 0);
    assert.equal(w.store.state.requests[id]!.outcome, "asked");
  }));

test("a confirm that did not check out leaves the question to run out, and then it is a card", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    assert.equal((await reply(w, id, "不要", question)).outcome, "rejected");
    assert.equal(cards(w).length, 0, "no card at once");
    assert.equal((await lapsed(w, id)).outcome, "proposed");
    assert.equal(cards(w).length, 1);
  }));

test("a question for a matter that is gone by then is closed, not carded", () =>
  withHere(async (w) => {
    converse(w, {}, [{ kind: "person", text: "帮我盯一下体检，月底前要约上" }]);
    say(w, track("-", "年度体检", "personal"));
    await w.engine.tick();
    converse(w, {}, [{ kind: "person", text: "补一句，下周三下午去" }]);
    const id = say(w, note("D1", "体检已经做完了"));
    await w.engine.tick();
    assert.equal(w.store.state.requests[id]!.outcome, "asked");
    converse(w, {}, [{ kind: "person", text: "不用盯体检了" }]);
    say(w, { cmd: "say", kind: "drop", item: "D1", said: "不用盯体检了" });
    await w.engine.tick();
    const rec = await lapsed(w, id);
    assert.equal(rec.outcome, "rejected", rec.detail);
    assert.match(rec.detail, /当场问没确认上/);
  }));
