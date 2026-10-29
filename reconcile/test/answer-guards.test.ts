import assert from "node:assert/strict";
import { test } from "node:test";
import { issue, makeWorld, TZ, type World } from "./helpers";
import { assessed, chat, comes, commandFor, PERSONS, say, track, withDesk, pass, proposal } from "./desk-kit";

// What an answer written in the admin's chat may not do (found on review): one message of the person's answers one question, and what takes
// effect on a guess at which question the words are for -- a confirmation, an option that ends a matter -- is not taken from a guess.

const MINE = { source: "chatapp", "chatapp-chat": "p2p:owner" };
const GROUP = { source: "chatapp", "chatapp-chat": "group:team" };
const quoted = (text: string, typed: string) => `[回复 机器人 的消息]\n${text}\n\n${typed}`;

const mini = `export default {
  name: "mini", description: "x", applies: { source: "gcp-demo" }, params: {}, stages: ["s"],
  assess(kase, ctx) {
    const d = (kase.primary.fields.Release || "").slice(0, 10);
    const base = { stage: "s", health: "on-track", headline: "h " + d, next: { actor: "nobody", what: "" }, facts: [], commitments: [] };
    if (!d) return base;
    return { ...base, health: "waiting", commitments: [{
      key: "q:" + kase.id, title: "q " + kase.id, domain: "work", owner: "owner",
      trigger: { at: ctx.at(d, "18:00") },
      ask: { header: "Q" + kase.id.split(":").pop(), question: "q " + kase.id + "?", options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "过 3 天再看", description: "" }], allowOther: true },
      brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 3 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }] };
  },
};`;
const persons = { owner: { name: "测试用户", admin: true, tz: TZ, quiet: { work: "workdays 09:30-20:00" }, pushPerDay: 8, notify: [{ channel: "im", to: "p2p:owner", label: "IM" }], chats: [MINE] } };

async function withQuestions<T>(items: number[], body: (w: World) => Promise<T>): Promise<T> {
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": mini }, persons } });
  try {
    for (const id of items) w.items.set(`gcp-demo:${id}`, issue(id, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    return await body(w);
  } finally {
    w.close();
  }
}
/** The person's message in their chat; the agent runs the command; the controller takes the round. */
/** The agent runs answer once more in the turn that is already running (the person said nothing new). */
async function answerAgain(w: World, ask: string) {
  w.conversations.get("agent-me")!.turn!.steps.push({ kind: "command", text: commandFor({ cmd: "answer", ask, said: "-" }) });
  const id = w.say({ cmd: "answer", ask, said: "-" });
  await w.engine.tick();
  return w.receipt(id)!;
}
async function answerIn(w: World, labels: Record<string, string>, message: string, ask: string) {
  chat(w, labels, message);
  const id = say(w, { cmd: "answer", ask, said: "-" });
  await w.engine.tick();
  return w.receipt(id)!;
}
const answersOf = (w: World) => Object.values(w.store.state.commitments).filter((c) => c.answer);

// ---- one message, one answer ------------------------------------------------------------------------------------------------------

test("one message of the person's that named a matter is not the answer to the other matter's question when the agent runs answer again", () =>
  withQuestions([1, 2], async (w) => {
    const first = await answerIn(w, MINE, "#1 选 2", "#1-1");
    assert.equal(first.outcome, "applied");
    // the same turn, the same message: the agent runs it again for the next question (a retry, or taken for the next question's answer)
    const again = await answerAgain(w, "#2-1");
    assert.equal(again.outcome, "rejected", again.text);
    assert.match(again.text, /已经答过一个问题了/);
    assert.equal(answersOf(w).length, 1, "only the first was recorded");
  }));

test("another message of theirs answers the other question: the limit is one answer for each message, not one for each conversation", () =>
  withQuestions([1, 2], async (w) => {
    assert.equal((await answerIn(w, MINE, "#1 选 2", "#1-1")).outcome, "applied");
    assert.equal((await answerIn(w, MINE, "#2 选 1", "#2-1")).outcome, "applied");
    assert.equal(answersOf(w).length, 2);
  }));

test("a message that wrote the number of one question is not the answer to another question either", () =>
  withQuestions([1, 2], async (w) => {
    assert.equal((await answerIn(w, MINE, "#1-1 选 2", "#1-1")).outcome, "applied");
    const second = await answerAgain(w, "#2-1");
    assert.equal(second.outcome, "rejected", second.text);
    assert.equal(answersOf(w).length, 1);
  }));

// ---- a guess does not settle a confirmation, nor an option that ends a matter --------------------------------------------------------

const WORDS = "帮我盯一下体检，月底前要约上";
const mine = () => PERSONS({ chats: [MINE], notify: [{ channel: "im", to: "p2p:owner", label: "IM" }] });

test("a confirmation is not answered by a bare digit that quotes nothing and names no number, even when it is the only question waiting", () =>
  withDesk(
    async (w) => {
      chat(w, GROUP, WORDS);
      const told = say(w, track(WORDS, "年度体检", "personal"));
      await w.engine.tick();
      assert.equal(w.receipt(told)!.outcome, "proposed");
      const bare = await answerIn(w, MINE, "1", "确认-1");
      assert.equal(bare.outcome, "rejected", bare.text);
      assert.match(bare.text, /确认-1/);
      assert.equal(answersOf(w).length, 0);
      assert.equal(Object.values(w.store.state.items).filter((i) => i.key.startsWith("desk:")).length, 0, "the words in the group did not take effect");
    },
    { persons: mine() },
  ));

test("a confirmation is answered when the reply quotes the push, or writes its number", () =>
  withDesk(
    async (w) => {
      chat(w, GROUP, WORDS);
      say(w, track(WORDS, "年度体检", "personal"));
      await w.engine.tick();
      const text = w.deliveries[0]!.text;
      assert.equal((await answerIn(w, MINE, quoted(text, "1"), "确认-1")).outcome, "applied");
    },
    { persons: mine() },
  ));

test("a confirmation is answered when the words write its number", () =>
  withDesk(
    async (w) => {
      chat(w, GROUP, WORDS);
      say(w, track(WORDS, "年度体检", "personal"));
      await w.engine.tick();
      assert.equal((await answerIn(w, MINE, "确认-1 选 2", "确认-1")).outcome, "applied");
    },
    { persons: mine() },
  ));

/** A matter told in the admin's chat, looked at, and the look put a question. */
async function asked(w: World) {
  chat(w, MINE, WORDS);
  say(w, track("-", "年度体检", "personal"));
  await w.engine.tick();
  comes(w, 1, 1, proposal({ status: "任务还没完成", question: "体检约上了吗？", options: ["已约上了", "还没约"] }));
  await pass(w, 10);
}

test("an option that ends the matter (不用盯了) is not taken from a guess at the question: a bare digit or its words need the quote or the number", () =>
  withDesk(
    async (w) => {
      await asked(w);
      for (const typed of ["4", "不用盯了", "选 4"]) {
        const bare = await answerIn(w, MINE, typed, "D1-1");
        assert.equal(bare.outcome, "rejected", `${typed}: ${bare.text}`);
        assert.match(bare.text, /会结束这件事/);
      }
      assert.equal(answersOf(w).length, 0);
      assert.notEqual(assessed(w, 1)?.stage, "dropped");
    },
    { persons: mine() },
  ));

test("the same option is taken when the reply quotes the push, or when the words write the number of the question", () => {
  const quotedCase = () =>
    withDesk(
      async (w) => {
        await asked(w);
        assert.equal((await answerIn(w, MINE, quoted(w.deliveries[0]!.text, "4"), "D1-1")).outcome, "applied");
        await pass(w, 5);
        assert.equal(assessed(w, 1)!.stage, "dropped");
      },
      { persons: mine() },
    );
  const numberedCase = () =>
    withDesk(
      async (w) => {
        await asked(w);
        assert.equal((await answerIn(w, MINE, "D1-1 选 4", "D1-1")).outcome, "applied");
      },
      { persons: mine() },
    );
  return quotedCase().then(numberedCase);
});

test("what does not end the matter is still taken from a guess: a bare 3 (过 3 天再看) and words of their own", () =>
  withDesk(
    async (w) => {
      await asked(w);
      assert.equal((await answerIn(w, MINE, "3", "D1-1")).outcome, "applied");
    },
    { persons: mine() },
  ));
