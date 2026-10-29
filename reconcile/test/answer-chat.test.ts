import assert from "node:assert/strict";
import { test } from "node:test";
import { answerWords, OPEN_TO_ADMIN_CHAT, splitReply, withoutMention, type Conversation, type Request } from "../server/requests";
import { parseSayArgs } from "../server/say-args.mjs";
import type { Commitment } from "../shared/model";
import { issue, makeWorld, TZ, type World } from "./helpers";
import { chat, commandFor, deskRule, DESK_RULE, own, PERSONS, say, track, withDesk } from "./desk-kit";

// A question pushed to the admin's chat is answered there: the person replies to the push (or writes a sentence), the agent they
// talk to runs `reconcile-say answer --ask <number> --said -`, and the controller reads the conversation itself: whose words, which
// question, which option. The checks, each of which has a case that fails without it:
//   1 whose conversation   2 which turn and command   3 the words are what they typed, not the quote   4 which question
//   5 which option         6 already answered / taken back / expired   7 how it is recorded   and  the admin's chat waiver.

const MINE = { source: "chatapp", "chatapp-chat": "p2p:owner" };
const OTHER_DM = { source: "chatapp", "chatapp-chat": "p2p:colleague" };
const GROUP = { source: "chatapp", "chatapp-chat": "group:team" };
const persons = { owner: { name: "测试用户", admin: true, tz: TZ, quiet: { work: "workdays 09:30-20:00" }, pushPerDay: 8, notify: [{ channel: "im", to: "p2p:owner", label: "IM" }], chats: [MINE] } };

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
      ask: { header: "Q" + kase.id.split(":").pop(), question: "q " + kase.id + "?", options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "过 3 天再看", description: "" }], allowOther: true },
      brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 3 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }] };
  },
};`;

async function withQuestions<T>(items: number[], body: (w: World) => Promise<T>, extra: { persons?: unknown } = {}): Promise<T> {
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": mini }, persons: extra.persons ?? persons } });
  try {
    for (const id of items) w.items.set(`gcp-demo:${id}`, issue(id, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    return await body(w);
  } finally {
    w.close();
  }
}

const commitment = (w: World, n: number) => Object.values(w.store.state.commitments).find((c) => c.key === `q:gcp-demo:${n}`) as Commitment;
/** What a chat app hands the agent when the person replies to a message: the quote first, then what they typed. */
const quoted = (text: string, typed: string) => `[回复 机器人 的消息]\n${text}\n\n${typed}`;
const push = (w: World, k = 0) => w.deliveries[k]!.text;
/** The person's message in their chat; the agent runs the command; the controller takes the round. */
async function answerIn(w: World, labels: Record<string, string>, message: string, ask: string) {
  chat(w, labels, message);
  const id = say(w, { cmd: "answer", ask, said: "-" });
  await w.engine.tick();
  return w.receipt(id)!;
}
const reply = (w: World, typed: string, k = 0) => quoted(push(w, k), typed);
const answersOf = (w: World) => Object.values(w.store.state.commitments).filter((c) => c.answer);

// ---- the push --------------------------------------------------------------------------------------------------------

test("the push of one question: the title names the matter, the text the situation and numbered options, and the number of the question is its last line", () =>
  withQuestions([1], async (w) => {
    assert.equal(w.deliveries.length, 1);
    assert.equal(w.deliveries[0]!.title, "Q1：q gcp-demo:1?");
    assert.equal(push(w), "b\n1 A\n2 过 3 天再看\n引用这条回一个数字，或者直接写一句。（问题 #1-1）");
    assert.ok(push(w).endsWith("（问题 #1-1）"), "nothing after it: what follows it is taken as what the person typed");
  }));

test("a card of several questions: each question has its number, and the text tells how to say which one is answered", () =>
  withQuestions([1, 2], async (w) => {
    assert.equal(w.deliveries.length, 1, "one card");
    const text = push(w);
    assert.match(text, /^引用这条回复，写明答的是哪个问题：编号加答案，比如「#1-1 选 1」，一次答一个。\n\n1\. Q1：q gcp-demo:1\?\nb\n1 A\n2 过 3 天再看\n（问题 #1-1）\n\n2\. Q2：q gcp-demo:2\?\nb\n1 A\n2 过 3 天再看\n（问题 #2-1）$/);
  }));

test("question numbers are the item's number and which question of its own it is, counted over all of them, answered or not, so a number keeps meaning one question", async () => {
  // a rule that asks again, as a new question, when the item's status changes
  const again = mini.replace('key: "q:" + kase.id,', 'key: "q:" + kase.id + ":" + kase.primary.status,');
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": again }, persons } });
  try {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    const [first] = Object.values(w.store.state.commitments);
    assert.deepEqual(w.engine.status().questions.map((q) => q.no), ["#1-1"]);
    w.engine.answerQuestion(first!.id, first!.rounds, { option: "a" });
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14", status: "另一个状态" }));
    await w.run("2026-10-15 10:00");
    assert.equal(Object.keys(w.store.state.commitments).length, 2);
    assert.deepEqual(w.engine.status().questions.map((q) => q.no), ["#1-2"], "the answered one is #1-1 for good; the new one is #1-2");
    assert.match(push(w, w.deliveries.length - 1), /（问题 #1-2）$/);
    // and the first one is still found by its number, for what it is: answered
    const late = await answerIn(w, MINE, "#1-1 选 2", "#1-1");
    assert.match(late.text, /^没收下：#1-1 已经答过了：A/);
  } finally {
    w.close();
  }
});

// ---- 3, 4, 5, 7: a reply to the push --------------------------------------------------------------------------------------

test("a reply to the push with a number: that option, recorded as given in the chat, the card collapses, the receipt says what was recorded", async () =>
  withQuestions([1], async (w) => {
    const cardId = w.cards[0]!.card.id;
    const receipt = await answerIn(w, MINE, reply(w, "2"), "#1-1");
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.text, "记下了：#1-1「Q1」，你选了「过 3 天再看」。接下来怎么追踪，下一次检查时决定，在「事项追踪」页面上看得到。");
    const c = commitment(w, 1);
    assert.equal(c.status, "done");
    assert.deepEqual([c.answer!.option, c.answer!.label, c.answer!.text, c.answer!.via], ["b", "过 3 天再看", null, "chat:chatapp"]);
    assert.equal(w.store.state.cards[cardId]!.status, "answered", "nothing left on the card: it collapses");
  }));

test("the option by its words, with or without the punctuation a chat adds; and a number written as people write it (选 1, 第二个, full-width)", async () => {
  for (const [typed, label] of [["过 3 天再看", "过 3 天再看"], ["过3天再看。", "过 3 天再看"], ["a", "A"], ["选 1", "A"], ["第2个", "过 3 天再看"], ["２", "过 3 天再看"], ["1.", "A"]] as const) {
    await withQuestions([1], async (w) => {
      const receipt = await answerIn(w, MINE, reply(w, typed), "#1-1");
      assert.equal(receipt.outcome, "applied", typed);
      assert.equal(commitment(w, 1).answer!.label, label, typed);
      assert.equal(commitment(w, 1).answer!.text, null, typed);
    });
  }
});

test("a sentence of their own: recorded as 其他 with their words, and the receipt says so", async () =>
  withQuestions([1], async (w) => {
    const receipt = await answerIn(w, MINE, reply(w, "约在 11-04 周三下午了"), "#1-1");
    assert.equal(receipt.text, "记下了：#1-1「Q1」，你说「约在 11-04 周三下午了」。接下来怎么追踪，下一次检查时决定，在「事项追踪」页面上看得到。");
    assert.deepEqual([commitment(w, 1).answer!.option, commitment(w, 1).answer!.label, commitment(w, 1).answer!.text], [null, "其他", "约在 11-04 周三下午了"]);
  }));

test("y is not a yes to the first option: it is recorded as the words they wrote", async () =>
  withQuestions([1], async (w) => {
    await answerIn(w, MINE, reply(w, "y"), "#1-1");
    assert.deepEqual([commitment(w, 1).answer!.option, commitment(w, 1).answer!.text], [null, "y"]);
  }));

test("a number beyond the options is not an answer; nothing is recorded", async () =>
  withQuestions([1], async (w) => {
    const receipt = await answerIn(w, MINE, reply(w, "5"), "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.match(receipt.text, /他回的是 5，可是这个问题的选项只有 1 到 2/);
    assert.equal(answersOf(w).length, 0);
  }));

test("only the typed part counts: the quoted push has the options' words in it, and they are not what the person said", async () =>
  withQuestions([1], async (w) => {
    // The quote says A and 过 3 天再看; what they typed is a sentence that is neither.
    const receipt = await answerIn(w, MINE, reply(w, "明天再说"), "#1-1");
    assert.equal(receipt.outcome, "applied");
    assert.deepEqual([commitment(w, 1).answer!.option, commitment(w, 1).answer!.text], [null, "明天再说"], "not the 1 or the A in the quote above it");
  }));

test("only the quote and nothing typed after it is no answer", async () =>
  withQuestions([1], async (w) => {
    const receipt = await answerIn(w, MINE, quoted(push(w), ""), "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.equal(answersOf(w).length, 0);
    assert.equal(w.store.state.requests[Object.keys(w.store.state.requests).at(-1)!]!.why, "这条消息里没有人自己写的字（只是引用了推送）");
  }));

test("what they typed is held to the same limits as any words: long, many lines or a code block is not taken as their answer", async () => {
  for (const typed of ["很".repeat(201), "一\n二\n三\n四", "```\n2\n```"]) {
    await withQuestions([1], async (w) => {
      const receipt = await answerIn(w, MINE, reply(w, typed), "#1-1");
      assert.equal(receipt.outcome, "rejected", typed.slice(0, 10));
      assert.equal(answersOf(w).length, 0);
    });
  }
});

test("the push's own length is not what is held against it: the quote may be long and many lines", async () =>
  withQuestions([1], async (w) => {
    assert.ok(push(w).split("\n").length > 3, "the quote is more than three lines");
    const receipt = await answerIn(w, MINE, reply(w, "1"), "#1-1");
    assert.equal(receipt.outcome, "applied");
  }));

// ---- 4: which question ----------------------------------------------------------------------------------------------------

test("no quote and one question waiting: it is that one, whether they wrote its number or only the option", async () => {
  for (const typed of ["2", "B 吧", "#1-1 选 2", "#1 选 2"]) {
    await withQuestions([1], async (w) => {
      const receipt = await answerIn(w, MINE, typed, "#1-1");
      assert.equal(receipt.outcome, "applied", typed);
      if (typed === "B 吧") assert.equal(commitment(w, 1).answer!.text, "B 吧");
      else assert.equal(commitment(w, 1).answer!.label, "过 3 天再看", typed);
    });
  }
});

test("no quote and two questions waiting: not guessed; the receipt names them and nothing is recorded", async () =>
  withQuestions([1, 2], async (w) => {
    const receipt = await answerIn(w, MINE, "2", "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.text, "没收下：他还有 2 个问题没答（#1-1、#2-1），问他答的是哪个");
    assert.equal(answersOf(w).length, 0);
  }));

test("two questions waiting and the person names one: that one, and the other stays waiting", async () =>
  withQuestions([1, 2], async (w) => {
    const receipt = await answerIn(w, MINE, "#2-1 选 1", "#2-1");
    assert.equal(receipt.outcome, "applied");
    assert.equal(commitment(w, 2).answer!.label, "A");
    assert.equal(commitment(w, 1).status, "waiting");
    // the card that had both is cut down at the round that follows: the question left is on a card of its own
    assert.deepEqual(w.engine.status().questions.map((q) => q.no), ["#1-1"]);
    assert.equal(w.engine.status().cards.length, 1);
  }));

test("a reply to a push of two questions that names none: not guessed, and the receipt says what to ask", async () =>
  withQuestions([1, 2], async (w) => {
    const receipt = await answerIn(w, MINE, reply(w, "1"), "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.match(receipt.text, /他引用的推送里有 2 个问题（#1-1、#2-1），没说答的是哪个。请他回「编号 答案」，比如「#1-1 选 1」/);
  }));

test("a reply to a push of two questions that names one: that one", async () =>
  withQuestions([1, 2], async (w) => {
    const receipt = await answerIn(w, MINE, reply(w, "#2-1 过 3 天再看"), "#2-1");
    assert.equal(receipt.outcome, "applied");
    assert.equal(commitment(w, 2).answer!.label, "过 3 天再看");
    assert.equal(commitment(w, 1).status, "waiting");
  }));

test("the agent's --ask has to be the question the person's words point at", async () =>
  withQuestions([1, 2], async (w) => {
    const receipt = await answerIn(w, MINE, "#2-1 选 1", "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.text, "没收下：你给的是 #1-1，可是他的话指的是 #2-1。按他的话重新跑一遍；拿不准就问他");
    assert.equal(answersOf(w).length, 0);
    // and a number that is not a question at all
    const none = await answerIn(w, MINE, "#9-1 选 1", "#9-1");
    assert.match(none.text, /没有 #9-1 这个问题/);
  }));

test("an --ask that is not the single waiting question is refused even when the words name none", async () =>
  withQuestions([1], async (w) => {
    w.items.set("gcp-demo:2", issue(2, { release: "2026-10-14" }));
    // #2-1 does not exist yet as a waiting question (not asked); the agent names it, the words name nothing
    const receipt = await answerIn(w, MINE, "1", "#2-1");
    assert.equal(receipt.outcome, "rejected");
    assert.equal(answersOf(w).length, 0);
  }));

// ---- 1, 2: whose words ---------------------------------------------------------------------------------------------------

test("a group chat is not the person's answer: nobody can tell who wrote it", async () =>
  withQuestions([1], async (w) => {
    const receipt = await answerIn(w, GROUP, reply(w, "2"), "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.match(receipt.text, /对不上这是他本人这一轮自己写的回答，不记。请他在 Paseo「事项追踪」里答/);
    assert.equal(w.store.state.requests[Object.keys(w.store.state.requests).at(-1)!]!.why, "这是从「chatapp」进来的对话（聊天软件或别的插件），分不清是谁说的");
    assert.equal(answersOf(w).length, 0);
  }));

test("another member's private chat is not the admin's: not their answer either", async () =>
  withQuestions([1], async (w) => {
    const receipt = await answerIn(w, OTHER_DM, reply(w, "2"), "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.equal(answersOf(w).length, 0);
  }));

test("in a conversation of the Paseo app (no source label) the person's own words are theirs", async () =>
  withQuestions([1], async (w) => {
    const receipt = await answerIn(w, {}, "#1-1 选 2", "#1-1");
    assert.equal(receipt.outcome, "applied");
    assert.equal(commitment(w, 1).answer!.via, "chat", "no channel to name");
  }));

test("a conversation another agent started is nobody's own words, even with the right numbers", async () => {
  for (const label of ["paseo.parent-agent-id", "orch-run", "reconcile-card"]) {
    await withQuestions([1], async (w) => {
      const receipt = await answerIn(w, { [label]: "x" }, "#1-1 选 2", "#1-1");
      assert.equal(receipt.outcome, "rejected", label);
      assert.equal(answersOf(w).length, 0);
    });
  }
});

test("the admin's chat waiver is for answers because the list says so: without it, the chat is a chat like any other", async () => {
  assert.ok(OPEN_TO_ADMIN_CHAT.includes("answer"));
  assert.ok(OPEN_TO_ADMIN_CHAT.includes("track") && OPEN_TO_ADMIN_CHAT.includes("note"));
  await withQuestions([1], async (w) => {
    const receipt = await answerIn(w, MINE, reply(w, "2"), "#1-1");
    assert.equal(receipt.outcome, "applied", "and it is the list that lets it through");
  });
});

test("the turn has to be one the person's message started, with the command run in it", async () =>
  withQuestions([1], async (w) => {
    // no command run in the turn: the request names an answer nobody sent from here
    chat(w, MINE, reply(w, "2"));
    const bare = w.say({ cmd: "answer", ask: "#1-1", said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(bare)!.outcome, "rejected");
    assert.equal(w.store.state.requests[bare]!.why, "这一轮里找不到这次的 reconcile-say 调用（命令里的事项、改动和原话要和这次的一致）");
    // a command of a different question than the request names
    chat(w, MINE, reply(w, "2"));
    w.conversations.get("agent-me")!.turn!.steps.push({ kind: "command", text: commandFor({ cmd: "answer", ask: "#9-9", said: "-" }) });
    const other = w.say({ cmd: "answer", ask: "#1-1", said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(other)!.outcome, "rejected");
    // a turn that no message of the person started (woken by a timer)
    const c: Conversation = { labels: { ...MINE }, cwd: "/work", turn: { id: "wake", steps: [{ kind: "command", text: commandFor({ cmd: "answer", ask: "#1-1", said: "-" }) }] } };
    w.conversations.set("agent-me", c);
    const woken = w.say({ cmd: "answer", ask: "#1-1", said: "-" });
    await w.engine.tick();
    assert.equal(w.store.state.requests[woken]!.why, "这一轮不是人发消息开始的（比如被通知或定时叫醒），不算本人说的");
    assert.equal(answersOf(w).length, 0);
  }));

test("a message another agent put into the turn after the person's makes it nobody's answer", async () =>
  withQuestions([1], async (w) => {
    chat(w, MINE, reply(w, "2"));
    const c = w.conversations.get("agent-me")!;
    c.turn!.steps.push({ kind: "agent" });
    const id = say(w, { cmd: "answer", ask: "#1-1", said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(id)!.outcome, "rejected");
    assert.equal(w.store.state.requests[id]!.why, "人说完这句话以后，这一轮里进来过别的 agent 的消息，分不清是谁的意思");
  }));

test("the answer is taken from the person's last message before the command: an earlier message of the turn is not the answer", async () =>
  withQuestions([1], async (w) => {
    chat(w, MINE, "先说别的", reply(w, "2"));
    const id = say(w, { cmd: "answer", ask: "#1-1", said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(id)!.outcome, "applied");
    assert.equal(commitment(w, 1).answer!.label, "过 3 天再看");
  }));

test("no conversation to read, or none the plugin can read: no answer", async () =>
  withQuestions([1], async (w) => {
    const id = w.say({ cmd: "answer", ask: "#1-1", said: "-", via: null });
    await w.engine.tick();
    assert.match(w.receipt(id)!.text, /命令不是在 Paseo 的对话里跑的/);
    const gone = w.say({ cmd: "answer", ask: "#1-1", said: "-", via: "agent-gone" });
    await w.engine.tick();
    assert.equal(w.receipt(gone)!.outcome, "rejected");
    assert.equal(w.store.state.requests[gone]!.why, "找不到说这句话的对话");
  }));

// ---- 6: already answered, taken back, expired ----------------------------------------------------------------------------------

test("already answered on the page: the receipt says what was answered and where, and the later answer records nothing", async () =>
  withQuestions([1], async (w) => {
    const c = commitment(w, 1);
    w.engine.answerQuestion(c.id, c.rounds, { option: "a" });
    const receipt = await answerIn(w, MINE, reply(w, "2"), "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.match(receipt.text, /^没收下：#1-1 已经答过了：A（在事项页上 \d\d-\d\d \d\d:\d\d），这次的没有记下$/);
    assert.equal(commitment(w, 1).answer!.label, "A");
  }));

test("answered in the chat first: the page that comes after is told where it was answered", async () =>
  withQuestions([1], async (w) => {
    await answerIn(w, MINE, reply(w, "2"), "#1-1");
    const c = commitment(w, 1);
    const late = w.engine.answerQuestion(c.id, c.rounds, { option: "a" });
    assert.deepEqual([late.ok, late.already], [false, true]);
    assert.match(late.detail, /已经答过了：过 3 天再看（在对话里 /);
  }));

test("the same reply brought twice answers once", async () =>
  withQuestions([1], async (w) => {
    await answerIn(w, MINE, reply(w, "2"), "#1-1");
    const again = await answerIn(w, MINE, reply(w, "1"), "#1-1");
    assert.equal(again.outcome, "rejected");
    assert.match(again.text, /已经答过了：过 3 天再看/);
    assert.equal(answersOf(w).length, 1);
  }));

test("taken back (cancelled) or expired: not recorded, and the receipt says which", async () => {
  for (const [status, word] of [["cancelled", "收回"], ["expired", "过期"]] as const) {
    await withQuestions([1], async (w) => {
      const c = commitment(w, 1);
      (w.store.state.commitments[c.id] as Commitment).status = status;
      const receipt = await answerIn(w, MINE, reply(w, "2"), "#1-1");
      assert.equal(receipt.outcome, "rejected", status);
      assert.equal(receipt.text, `没收下：#1-1 这个问题已经${word}了，没有记下`);
      assert.equal(answersOf(w).length, 0);
    });
  }
});

test("a question not asked yet is not answered by a number somebody guessed", async () =>
  withQuestions([1], async (w) => {
    (w.store.state.commitments[commitment(w, 1).id] as Commitment).status = "scheduled";
    const receipt = await answerIn(w, MINE, "#1-1 选 1", "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.text, "没收下：#1-1 这个问题还没有问到，到时候再答");
  }));

test("a question asked of somebody else is not the admin's to answer in their chat", async () =>
  withQuestions([1], async (w) => {
    const c = commitment(w, 1);
    (w.store.state.commitments[c.id] as Commitment).ask.person = "someone-else";
    const receipt = await answerIn(w, MINE, "#1-1 选 1", "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.match(receipt.text, /#1-1 问的不是 测试用户/);
  }));

test("one reply answers the question it names and no other: the agent cannot use it again for the other question", async () =>
  withQuestions([1, 2], async (w) => {
    chat(w, MINE, reply(w, "#1-1 选 1"));
    const first = say(w, { cmd: "answer", ask: "#1-1", said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(first)!.outcome, "applied");
    // the agent runs another answer in the same turn on the same message, for the other question
    w.conversations.get("agent-me")!.turn!.steps.push({ kind: "command", text: commandFor({ cmd: "answer", ask: "#2-1", said: "-" }) });
    const second = w.say({ cmd: "answer", ask: "#2-1", said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(second)!.outcome, "rejected");
    assert.match(w.receipt(second)!.text, /你给的是 #2-1，可是他的话指的是 #1-1/);
    assert.equal(commitment(w, 2).status, "waiting");
  }));

// ---- 7: recorded like any answer -------------------------------------------------------------------------------------------------

test("an answer in the chat shows on the page and in the item's history as given there; the journal keeps the request and the message it came from", async () =>
  withQuestions([1], async (w) => {
    const id = (await (async () => {
      chat(w, MINE, reply(w, "2"));
      const r = say(w, { cmd: "answer", ask: "#1-1", said: "-" });
      await w.engine.tick();
      return r;
    })());
    const handled = w.store.state.requests[id]!;
    assert.equal(handled.outcome, "applied");
    assert.equal(handled.waived, true, "let through on the admin's chat waiver, and the journal says so");
    assert.equal(handled.request?.cmd ?? "answer", "answer");
    const history = w.engine.graph("gcp-demo:1")!.history.map((h) => h.line);
    assert.ok(history.some((l) => /在 POPO 里|在对话里/.test(l) || /回答：过 3 天再看/.test(l)), history.join("\n"));
  }));

test("the observation of the answer is the same as the page's (a rule reads it the same way)", async () =>
  withQuestions([1], async (w) => {
    await answerIn(w, MINE, reply(w, "2"), "#1-1");
    const obs = (w.store.state.recent["gcp-demo:1"] ?? []).filter((o) => o.kind === "answer");
    assert.equal(obs.length, 1);
    assert.equal(obs[0]!.text, "q gcp-demo:1? → 过 3 天再看");
    assert.equal(obs[0]!.trust, "human");
  }));

// ---- the status and plan.md list the waiting questions ---------------------------------------------------------------------------------

test("the status lists the questions waiting with their numbers; answered, they are gone", async () =>
  withQuestions([1, 2], async (w) => {
    assert.deepEqual(w.engine.status().questions.map((q) => [q.no, q.item, q.question]), [["#1-1", "gcp-demo:1", "q gcp-demo:1?"], ["#2-1", "gcp-demo:2", "q gcp-demo:2?"]]);
    await answerIn(w, MINE, "#2-1 选 1", "#2-1");
    assert.deepEqual(w.engine.status().questions.map((q) => q.no), ["#1-1"]);
  }));

// ---- the words of a reply --------------------------------------------------------------------------------------------------------

test("splitReply: the typed part is what follows the last question tag; without a tag, all of it", () => {
  assert.deepEqual(splitReply("[回复 x 的消息]\n问\n1 A\n引用这条回。（问题 D1-1）\n\n2"), { typed: "2", tags: ["D1-1"] });
  assert.deepEqual(splitReply("a\n（问题 D1-1）\nb\n（问题 #3-2）\n\n#3-2 选 1"), { typed: "#3-2 选 1", tags: ["D1-1", "#3-2"] });
  assert.deepEqual(splitReply("2"), { typed: "2", tags: [] });
  assert.deepEqual(splitReply("引用了（问题 D1-1）"), { typed: "", tags: ["D1-1"] });
  assert.deepEqual(splitReply("（问题 D1-1）（问题 D1-1）x"), { typed: "x", tags: ["D1-1"] });
});

test("withoutMention takes out a number where it stands alone, not inside a longer one", () => {
  assert.equal(withoutMention("d1-1 选 2", "d1-1"), " 选 2");
  assert.equal(withoutMention("d1-10 选 2", "d1-1"), "d1-10 选 2");
  assert.equal(withoutMention("选 2 d1", "d1"), "选 2 ");
  assert.equal(withoutMention("abc", ""), "abc");
});

test("answerWords reads nothing out of a conversation that cannot be read", () => {
  const r = { cmd: "answer", ask: "x", said: "-", v: 1, id: "r_000000000001", at: "", via: "a" } as Extract<Request, { cmd: "answer" }>;
  assert.deepEqual(answerWords(r, null), { why: "找不到说这句话的对话" });
});

// ---- the command's arguments ------------------------------------------------------------------------------------------------------

test("reconcile-say answer: --ask and --said - are both needed, and --said can be nothing else", () => {
  assert.deepEqual(parseSayArgs(["answer", "--ask", "D1-1", "--said", "-"]), { request: { cmd: "answer", ask: "D1-1", said: "-" }, data: null, wait: 90 });
  assert.match((parseSayArgs(["answer", "--said", "-"]) as { error: string }).error, /--ask/);
  assert.match((parseSayArgs(["answer", "--ask", "D1-1", "--said", "2"]) as { error: string }).error, /只能是 -/);
  assert.match((parseSayArgs(["answer", "--ask", "D1-1"]) as { error: string }).error, /--said/);
  assert.match((parseSayArgs(["answer", "--ask", "D1-1", "--said", "-", "--kind", "drop"]) as { error: string }).error, /不认识 --kind/);
});

test("--said - is a value like any other to the other commands", () => {
  assert.deepEqual(parseSayArgs(["track", "--title", "体检", "--said", "-"]), { request: { cmd: "track", title: "体检", said: "-" }, data: null, wait: 90 });
  assert.deepEqual(parseSayArgs(["note", "--item", "D1", "--said", "-"]), { request: { cmd: "note", item: "D1", said: "-" }, data: null, wait: 90 });
  assert.deepEqual(parseSayArgs(["undo", "--last", "--said", "-"]), { request: { cmd: "undo", target: "last", said: "-" }, data: null, wait: 90 });
  assert.deepEqual(parseSayArgs(["say", "--item", "#1", "--kind", "drop", "--said", "-"]), { request: { cmd: "say", kind: "drop", item: "#1", said: "-" }, data: null, wait: 90 });
});

// ---- a confirmation card answered in the chat (the leftover of the cards) ---------------------------------------------------------

const deskPersons = () => PERSONS({ chats: [MINE], notify: [{ channel: "im", to: "p2p:owner", label: "IM" }] });
const SAID = "帮我盯一下体检，月底前要约上";

test("a confirmation is pushed with its number and the words it is about, and 照办 in the admin's chat applies what was asked", async () =>
  withDesk(
    async (w) => {
      // told from a conversation that cannot vouch for it (a group chat): it waits on a card to the admin
      chat(w, GROUP, SAID);
      const told = say(w, track(SAID, "年度体检", "personal"));
      await w.engine.tick();
      assert.equal(w.receipt(told)!.outcome, "proposed");
      assert.equal(w.deliveries.length, 1);
      const text = push(w);
      assert.match(text, /^有一句话想让我盯一件事，但没法确认是你本人刚在自己的对话里说的/);
      assert.ok(text.includes(`「${SAID}」`), "the words it is about");
      assert.match(text, /1 照办\n2 不要\n引用这条回一个数字，或者直接写一句。（问题 确认-1）$/);
      const receipt = await answerIn(w, MINE, quoted(text, "1"), "确认-1");
      assert.equal(receipt.outcome, "applied");
      assert.equal(receipt.text, "记下了：确认-1「确认：年度体检」，你选了「照办」，下一次检查（一分钟内）就照办。");
      await w.engine.tick();
      assert.equal(w.store.state.items["desk:D1"]?.title, "年度体检", "applied as said, once the round is taken");
    },
    { persons: deskPersons() },
  ));

test("a reply that is not 照办 to a confirmation: recorded, and the receipt says it does not take effect", async () =>
  withDesk(
    async (w) => {
      chat(w, GROUP, SAID);
      say(w, track(SAID, "年度体检", "personal"));
      await w.engine.tick();
      const receipt = await answerIn(w, MINE, quoted(push(w), "好的"), "确认-1");
      assert.equal(receipt.outcome, "applied");
      assert.equal(receipt.text, "记下了：确认-1「确认：年度体检」，你回的是「好的」，不是「照办」，那句话不会生效。");
      await w.engine.tick();
      assert.equal(w.store.state.items["desk:D1"], undefined, "nothing was started");
    },
    { persons: deskPersons() },
  ));

void [own, deskRule, DESK_RULE];

// ---- a question that has to be chosen from ---------------------------------------------------------------------------------------------

test("a question that takes no words of their own: a sentence that is none of the options is not recorded, a number or the option's words are", async () => {
  const fixed = mini.replace("allowOther: true", "allowOther: false");
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": fixed }, persons } });
  try {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    assert.match(push(w), /^b\n1 A\n2 过 3 天再看\n引用这条回一个数字。（问题 #1-1）$/, "and the push does not offer to write");
    const refused = await answerIn(w, MINE, reply(w, "随便哪个"), "#1-1");
    assert.equal(refused.outcome, "rejected");
    assert.equal(refused.text, "没收下：这个问题只能从选项里选（1 A；2 过 3 天再看），他写的「随便哪个」对不上任何一项");
    assert.equal(answersOf(w).length, 0);
    const taken = await answerIn(w, MINE, reply(w, "A"), "#1-1");
    assert.equal(taken.outcome, "applied");
    assert.equal(commitment(w, 1).answer!.option, "a");
  } finally {
    w.close();
  }
});

test("only the number: a message that is the question's number and nothing else says no answer", async () =>
  withQuestions([1], async (w) => {
    const receipt = await answerIn(w, MINE, "#1-1", "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.text, "没收下：他只写了编号，没写答案");
  }));

test("words that name two questions answer neither: one sentence answers one question, and the receipt says so", async () =>
  withQuestions([1, 2], async (w) => {
    const receipt = await answerIn(w, MINE, "#1-1 选 1，#2-1 选 2", "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.text, "没收下：他的话里提到了好几个问题（#1-1、#2-1），一句话只答一个，问他先答哪个");
    assert.equal(answersOf(w).length, 0);
  }));

test("words that name two matters and no question number answer neither", async () =>
  withQuestions([1, 2], async (w) => {
    const receipt = await answerIn(w, MINE, "#1 和 #2 都选 1", "#1-1");
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.text, "没收下：他的话里提到了好几件事（#1、#2），问他答的是哪个问题");
    assert.equal(answersOf(w).length, 0);
  }));

test("a person's message that comes only after the command is not what the command answers", async () =>
  withQuestions([1], async (w) => {
    chat(w, MINE);
    w.conversations.get("agent-me")!.turn!.steps.push({ kind: "command", text: commandFor({ cmd: "answer", ask: "#1-1", said: "-" }) }, { kind: "person", text: "2" });
    const id = w.say({ cmd: "answer", ask: "#1-1", said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(id)!.outcome, "rejected");
    assert.equal(w.store.state.requests[id]!.why, "这条命令之前，这一轮里没有人发的消息");
    assert.equal(answersOf(w).length, 0);
  }));
