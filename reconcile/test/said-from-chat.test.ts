import assert from "node:assert/strict";
import { test } from "node:test";
import { issue, type World } from "./helpers";
import { chat, commandFor, item, note, own, PERSONS, say, track, undoLast, withDesk } from "./desk-kit";

// `--said -`: the agent does not copy what the person said, the controller takes it from the conversation: the last message of the
// person's before the command. Every other check of own words holds -- the same turn, the same command, no other agent in between,
// not pasted -- and a message that cannot be taken is told to the agent, which can then copy the words (the way that goes to a card).

const MINE = { source: "chatapp", "chatapp-chat": "p2p:owner" };
const GROUP = { source: "chatapp", "chatapp-chat": "group:team" };
const SAID = "帮我盯一下体检，月底前要约上";
const FROM_CHAT = "-";
const withAdmin = <T>(body: (w: World) => Promise<T>) => withDesk(body, { persons: PERSONS({ chats: [MINE] }) });
const outcome = (w: World, id: string) => w.receipt(id)!.outcome;
const why = (w: World, id: string) => w.store.state.requests[id]!.why ?? "";
const annotations = (w: World) => Object.values(w.store.state.annotations);
const GUIDE = /^没收下：用 --said - 没能从对话里取到人说的原话。把原话照抄进 --said "…" 再跑一遍，那样会先发一张确认卡给 admin$/;

test("a matter told with --said -: the words kept are the person's message, as they typed it", () =>
  withDesk(async (w) => {
    own(w, SAID);
    const id = say(w, track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, id), "applied");
    assert.equal(annotations(w)[0]!.said, SAID, "not the dash");
    assert.equal(annotations(w)[0]!.how, "own-words");
    assert.equal(item(w, 1)!.fields.said, SAID);
    assert.equal(w.cards.length, 0);
  }));

test("with --said - in the admin's own chat the matter is told with no card, as it is with the words copied", () =>
  withAdmin(async (w) => {
    chat(w, MINE, SAID);
    const id = say(w, track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, id), "applied");
    assert.equal(annotations(w)[0]!.said, SAID);
    assert.equal(w.store.state.requests[id]!.waived, true);
  }));

test("a line added, a thing said about an item, and a taking back, each with --said -", () =>
  withAdmin(async (w) => {
    chat(w, MINE, SAID);
    say(w, track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    chat(w, MINE, "约在下周三下午了");
    const added = say(w, note("D1", FROM_CHAT));
    await w.engine.tick();
    assert.equal(outcome(w, added), "applied");
    assert.equal(item(w, 1)!.fields["note.0"], "约在下周三下午了");
    chat(w, MINE, "刚才那句补充不要了");
    const back = say(w, undoLast(FROM_CHAT));
    await w.engine.tick();
    assert.equal(outcome(w, back), "applied");
    assert.equal(w.store.state.annotations[Object.keys(w.store.state.annotations).find((k) => w.store.state.annotations[k]!.kind === "note")!]!.revoked!.said, "刚才那句补充不要了");
  }));

test("a thing said about a followed item with --said -: the item the message names is the one it vouches for", () =>
  withDesk(
    async (w) => {
      w.items.set("gcp-demo:1", issue(1));
      await w.run("2026-10-13 10:30");
      own(w, "#1 不用追踪了");
      const id = say(w, { cmd: "say", kind: "drop", item: "#1", said: FROM_CHAT });
      await w.engine.tick();
      assert.equal(outcome(w, id), "applied");
      assert.equal(annotations(w)[0]!.said, "#1 不用追踪了");
    },
    {
      rule: `export default { name: "mini", description: "x", applies: { source: "gcp-demo" }, params: {}, stages: ["s"], assess() { return { stage: "s", health: "on-track", headline: "h", next: { actor: "nobody", what: "" }, facts: [], commitments: [] }; } };`,
      flows: false,
    },
  ));

// ---- what cannot be taken ------------------------------------------------------------------------------------------------------

test("a message too long to be a sentence is not taken: the agent is told to copy the words, and no card is made of the dash", () =>
  withDesk(async (w) => {
    own(w, "帮我盯一下体检，".repeat(40));
    const id = say(w, track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, id), "rejected");
    assert.match(w.receipt(id)!.text, GUIDE);
    assert.equal(why(w, id), "原话所在的消息像是贴进来的一段，不算本人说的");
    assert.equal(w.cards.length, 0);
    assert.equal(annotations(w).length, 0);
  }));

test("many lines (four) or a code block: not taken either; three lines are", async () => {
  for (const [message, taken] of [["盯一下体检\n月底前要约上\n谢谢", true], ["盯一下体检\n月底前\n要约上\n谢谢", false], ["盯一下体检 ```x```", false]] as const) {
    await withDesk(async (w) => {
      own(w, message);
      const id = say(w, track(FROM_CHAT, "年度体检", "personal"));
      await w.engine.tick();
      assert.equal(outcome(w, id), taken ? "applied" : "rejected", message);
      if (!taken) assert.match(w.receipt(id)!.text, GUIDE);
    });
  }
});

test("a group chat or another's chat: the dash is not taken (nobody can tell who wrote it), and the agent is told how it can still be put to the admin", () =>
  withAdmin(async (w) => {
    chat(w, GROUP, SAID);
    const id = say(w, track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, id), "rejected");
    assert.match(w.receipt(id)!.text, GUIDE);
    assert.equal(why(w, id), "这是从「chatapp」进来的对话（聊天软件或别的插件），分不清是谁说的");
    // and with the words copied, the same chat goes to a card, as it always did
    const copied = say(w, track(SAID, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, copied), "proposed");
  }));

test("a message another agent came in after: the dash is not taken", () =>
  withDesk(async (w) => {
    own(w, SAID);
    w.conversations.get("agent-me")!.turn!.steps.push({ kind: "agent" });
    const id = say(w, track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, id), "rejected");
    assert.equal(why(w, id), "人说完这句话以后，这一轮里进来过别的 agent 的消息，分不清是谁的意思");
  }));

test("a turn the person's message did not start, or none at all: the dash is not taken", () =>
  withDesk(async (w) => {
    w.conversations.set("agent-me", { labels: {}, cwd: "/work", turn: { id: "wake", steps: [{ kind: "command", text: commandFor(track(FROM_CHAT, "年度体检", "personal")) }] } });
    const woken = w.say(track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, woken), "rejected");
    assert.equal(why(w, woken), "这一轮不是人发消息开始的（比如被通知或定时叫醒），不算本人说的");
    w.conversations.set("agent-me", { labels: {}, cwd: "/work", turn: null });
    const idle = w.say(track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(why(w, idle), "说这句话的对话这会儿没在跑，对不上是哪一轮说的");
  }));

test("a message of the person's that comes only after the command is not what the command was about", () =>
  withDesk(async (w) => {
    own(w);
    const c = w.conversations.get("agent-me")!;
    c.turn!.steps.push({ kind: "person", text: "先说一句" }, { kind: "command", text: commandFor(track(FROM_CHAT, "年度体检", "personal")) }, { kind: "person", text: SAID });
    const id = w.say(track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, id), "applied");
    assert.equal(annotations(w)[0]!.said, "先说一句", "the last before the command, not the one after");
  }));

test("a command with no person's message before it in the turn: nothing to take", () =>
  withDesk(async (w) => {
    own(w);
    const c = w.conversations.get("agent-me")!;
    c.turn!.steps.push({ kind: "command", text: commandFor(track(FROM_CHAT, "年度体检", "personal")) }, { kind: "person", text: SAID });
    const id = w.say(track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, id), "rejected");
    assert.equal(why(w, id), "这条命令之前，这一轮里没有人发的消息");
  }));

test("the command the agent ran has to say the dash too: a request of one thing and a command of another is no command of this request", () =>
  withDesk(async (w) => {
    own(w, SAID);
    const c = w.conversations.get("agent-me")!;
    c.turn!.steps.push({ kind: "command", text: commandFor(track(SAID, "年度体检", "personal")) });
    const id = w.say(track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, id), "rejected");
    assert.equal(why(w, id), "这一轮里找不到这次的 reconcile-say 调用（命令里的事项、改动和原话要和这次的一致）");
    // and the other way round: the command said the dash, the request has other words
    own(w, SAID);
    w.conversations.get("agent-me")!.turn!.steps.push({ kind: "command", text: commandFor(track(FROM_CHAT, "年度体检", "personal")) });
    const copied = w.say(track(SAID, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, copied), "proposed", "words that are not the dash are judged as words");
  }));

test("no conversation to read: the dash is not taken", () =>
  withDesk(async (w) => {
    const id = w.say({ ...track(FROM_CHAT, "年度体检", "personal"), via: "agent-gone" });
    await w.engine.tick();
    assert.equal(outcome(w, id), "rejected");
    assert.equal(why(w, id), "找不到说这句话的对话");
  }));

// ---- one message, one request --------------------------------------------------------------------------------------------------------

test("one message releases one request: a second command on the same message goes to a card, with the person's words on it", () =>
  withDesk(async (w) => {
    own(w, SAID);
    const first = say(w, track(FROM_CHAT, "年度体检", "personal"));
    const second = say(w, track(FROM_CHAT, "洗牙", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, first), "applied");
    assert.equal(outcome(w, second), "proposed", "the same message does not let a second matter through");
    assert.equal(why(w, second), "人的这条消息这一轮里已经放行过一条请求了（写明了几个单号的，每个单号一条）");
    const card = Object.values(w.store.state.commitments).find((c) => c.key.startsWith("confirm:"))!;
    assert.ok(card.brief.includes(`「${SAID}」`), "the card shows what the person said, not a dash");
    assert.equal(w.store.state.requests[second]!.request!.said, SAID);
  }));

test("the same words told twice with --said - on different turns: the second is the matter already followed", () =>
  withDesk(async (w) => {
    own(w, SAID);
    say(w, track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    own(w, SAID);
    const again = say(w, track(FROM_CHAT, "体检又一个", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, again), "rejected");
    assert.match(w.receipt(again)!.text, /已经在盯了：D1「年度体检」/);
  }));

test("a line added twice with --said -: the second says it was added already", () =>
  withDesk(async (w) => {
    own(w, SAID);
    say(w, track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    own(w, "约在下周三下午了");
    say(w, note("D1", FROM_CHAT));
    await w.engine.tick();
    own(w, "约在下周三下午了");
    const again = say(w, note("D1", FROM_CHAT));
    await w.engine.tick();
    assert.equal(outcome(w, again), "rejected");
    assert.equal(w.receipt(again)!.text.split("\n")[0], "没收下：这句已经补过了");
  }));

test("a message that names two items lets one through for each, with --said - as with copied words", () =>
  withDesk(
    async (w) => {
      w.items.set("gcp-demo:1", issue(1));
      w.items.set("gcp-demo:2", issue(2));
      await w.run("2026-10-13 10:30");
      own(w, "#1 和 #2 都不用追踪了");
      const one = say(w, { cmd: "say", kind: "drop", item: "#1", said: FROM_CHAT });
      const two = say(w, { cmd: "say", kind: "drop", item: "#2", said: FROM_CHAT });
      const again = say(w, { cmd: "say", kind: "drop", item: "#1", said: FROM_CHAT });
      await w.engine.tick();
      assert.equal(outcome(w, one), "applied");
      assert.equal(outcome(w, two), "applied");
      assert.notEqual(outcome(w, again), "applied", "the same item twice from one message is not");
    },
    {
      rule: `export default { name: "mini", description: "x", applies: { source: "gcp-demo" }, params: {}, stages: ["s"], assess() { return { stage: "s", health: "on-track", headline: "h", next: { actor: "nobody", what: "" }, facts: [], commitments: [] }; } };`,
      flows: false,
    },
  ));

test("a dash in a command line is read as the dash by the plugin the way the command reads it (quoted or not)", async () => {
  const { sayCalls } = await import("../server/requests");
  for (const line of ['node D:/p/bin/reconcile-say.mjs track --title "体检" --said -', 'node D:/p/bin/reconcile-say.mjs track --said "-" --title 体检', "node D:/p/bin/reconcile-say.mjs track --said '-' --title 体检"]) {
    assert.deepEqual(sayCalls(line).map((c) => c.request.said), ["-"], line);
  }
});

test("of several messages of the person's before the command, the last is the words", () =>
  withDesk(async (w) => {
    own(w, "先说一句别的", SAID);
    const id = say(w, track(FROM_CHAT, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, id), "applied");
    assert.equal(annotations(w)[0]!.said, SAID);
  }));
