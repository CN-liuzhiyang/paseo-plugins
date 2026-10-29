import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnStep } from "../server/requests";
import type { World } from "./helpers";
import { assessed, converse, item, own, PERSONS, say, tell, track, withDesk } from "./desk-kit";

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
    const { id } = await asked(w);
    const said = '**要我盯 "年度体检" 吗？**（回 “要” 就办）';
    const done = await reply(w, id, "好的呀", said);
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
    const done = await confirmIn(w, id, [{ kind: "text", text: question }, { kind: "person", text: "好的" }]);
    assert.equal(done.outcome, "applied", done.text);
  }));

test("a reply that is more than a yes is not a yes: words of their own, a no, a yes with a condition", () =>
  withHere(async (w) => {
    const { id, question } = await asked(w);
    for (const text of ["要，月底前约上", "不要", "要吗？先等等", "好的，不过别太频繁"]) {
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
    assert.match(done.text, /30 分钟/);
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

test("in the admin's own chat the matter is asked in place too (not told: the chat's own words are not let through for this)", () =>
  withHere(
    async (w) => {
      await tell(w, "帮我盯一下体检，月底前要约上", "年度体检");
      assert.equal(tracked(w), 1);
      converse(w, MINE, [{ kind: "person", text: "不用盯体检了" }]);
      const id = say(w, { cmd: "say", kind: "drop", item: "D1", said: "-" });
      await w.engine.tick();
      const receipt = w.receipt(id)!;
      assert.equal(receipt.outcome, "asked", receipt.text);
      const question = w.store.state.requests[id]!.question!;
      assert.match(question, /不再追踪 D1/);
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
      const id = say(w, { cmd: "say", kind: "drop", item: "D1", said: "-" });
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
