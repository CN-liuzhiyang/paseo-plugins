import assert from "node:assert/strict";
import { test } from "node:test";
import { createBareCarrier } from "../server/carrier";
import { askItemId, lineItemId, THREAD_KIND, threadSchema, type AskThread } from "../shared/thread";
import type { World } from "./helpers";
import { assessed, chat, comes, own, pass, PERSONS, proposal, say, track, withDesk } from "./desk-kit";

// A matter told in a conversation has its questions put into that conversation's timeline: one item for each question, replaced where it
// stands as the question is answered, put again after a restart, and not put where there is no conversation of the person's own.

const WORDS = "帮我盯一下体检，月底前要约上";
const MINE = { source: "chatapp", "chatapp-chat": "p2p:owner" };
const mine = () => PERSONS({ chats: [MINE], notify: [{ channel: "im", to: "p2p:owner", label: "IM" }] });

/** A matter told in the person's own conversation, looked at once, and the look put a question. */
async function asked(w: World, labels: Record<string, string> = {}) {
  if (Object.keys(labels).length === 0) own(w, WORDS);
  else chat(w, labels, WORDS);
  say(w, track("-", "年度体检", "personal"));
  await w.engine.tick();
  comes(w, 1, 1, proposal({ status: "任务还没完成", question: "体检约上了吗？", options: ["已约上了", "还没约"] }));
  await pass(w, 10);
}
const asks = (w: World) => w.threads.filter((t) => t.item.data.shape === "ask");
const lastAsk = (w: World) => asks(w).at(-1)!.item.data as AskThread;

test("a question of a matter told in a conversation goes into that conversation's timeline, under an id of its own, as the question it is", () =>
  withDesk(async (w) => {
    await asked(w);
    assert.equal(asks(w).length, 1);
    const put = asks(w)[0]!;
    assert.equal(put.agentId, "agent-me");
    assert.equal(put.item.kind, THREAD_KIND);
    const data = put.item.data as AskThread;
    assert.equal(put.item.id, askItemId(data.commitmentId));
    assert.equal(threadSchema.safeParse(data).success, true);
    assert.deepEqual([data.state, data.no, data.question, data.options.map((o) => o.label)], ["open", "D1-1", "体检约上了吗？", ["已约上了", "还没约", "过 3 天再看", "不用盯了"]]);
    // a quiet reconcile does not put it again
    await pass(w, 10);
    assert.equal(asks(w).length, 1);
  }));

test("answered on the page, it is put again under the same id as a line that says how it was answered", () =>
  withDesk(async (w) => {
    await asked(w);
    const open = lastAsk(w);
    const reply = w.engine.answerQuestion(open.commitmentId, open.round, { option: open.options.find((o) => o.label === "还没约")!.id });
    assert.equal(reply.ok, true, reply.detail);
    await pass(w, 5);
    const last = asks(w).at(-1)!;
    assert.equal(last.item.id, askItemId(open.commitmentId), "in its place");
    const data = last.item.data as AskThread;
    assert.equal(data.state, "answered");
    assert.match(data.line ?? "", /^已答：还没约（/);
  }));

test("a question taken back is put as taken back, and not as answered", () =>
  withDesk(async (w) => {
    await asked(w);
    // the matter is dropped by the person's own words in the same conversation
    own(w, "不用盯体检了");
    say(w, { cmd: "say", kind: "drop", item: "D1", said: "不用盯体检了" });
    await pass(w, 5);
    const data = lastAsk(w);
    assert.equal(data.state, "withdrawn");
    assert.match(data.line ?? "", /收回/);
  }));

test("after a restart the open question is put again (the daemon keeps timeline items in memory only)", () =>
  withDesk(async (w) => {
    await asked(w);
    const before = asks(w).length;
    await w.restart();
    await pass(w, 5);
    assert.equal(asks(w).length, before + 1);
    assert.equal(lastAsk(w).state, "open");
  }));

test("a conversation of a chat app has the push, so nothing is put in it; nor where the matter was told in no conversation", () =>
  withDesk(
    async (w) => {
      await asked(w, MINE);
      assert.equal(asks(w).length, 0);
      assert.ok(Object.values(w.store.state.commitments).some((c) => c.status === "waiting"), "the question is asked all the same");
    },
    { persons: mine() },
  ));

const failures = (w: World) => w.logs.filter((l) => /putting the question D1-1 into agent-me failed/.test(l));

test("a failure to put is tried again no sooner than five minutes after, and put when the host takes it; the reconcile goes on", () =>
  withDesk(async (w) => {
    w.fail.thread = new Error("agent not loaded");
    await asked(w);
    assert.equal(asks(w).length, 0);
    assert.ok(failures(w).length >= 1 && failures(w).length <= 3, `${failures(w).length} tries in ten minutes`);
    assert.ok(w.engine.status().lastTickAt, "and the reconcile did not stop");
    w.fail.thread = null;
    await pass(w, 10);
    assert.equal(lastAsk(w).state, "open");
  }));

test("a host that never takes it is tried five times and no more", () =>
  withDesk(async (w) => {
    w.fail.thread = new Error("agent not loaded");
    await asked(w);
    await pass(w, 90);
    assert.equal(failures(w).length, 5);
    assert.ok(failures(w)[4]!.includes("(5/5)"));
  }));

test("how a confirmation card ended is told in the conversation the words were said in", () =>
  withDesk(async (w) => {
    own(w, "帮我看下这段群聊：说盯一下体检");
    say(w, track("盯一下体检", "年度体检", "personal"));
    await pass(w, 5);
    const confirm = Object.values(w.store.state.commitments).find((c) => c.origin.who === "confirm")!;
    assert.ok(confirm, "words that do not check out, here asked on a card");
    // the card itself is in that conversation too, and is answered there
    assert.equal(asks(w).some((t) => (t.item.data as AskThread).confirm), true);
    const reply = w.engine.answerQuestion(confirm.id, confirm.rounds, { option: "yes" });
    assert.equal(reply.ok, true, reply.detail);
    await pass(w, 5);
    const told = w.threads.filter((t) => t.item.id.startsWith("told:"));
    assert.equal(told.length, 1);
    assert.match((told[0]!.item.data as { text: string }).text, /^事项追踪：照办了。记下了/);
    assert.equal(told[0]!.item.id, lineItemId(confirm.key.slice(confirm.key.lastIndexOf(":") + 1)));
    assert.equal(assessed(w, 1) !== undefined, true);
  }));

test("a confirmation turned down is told too, and says it was not taken", () =>
  withDesk(async (w) => {
    own(w, "帮我看下这段群聊：说盯一下体检");
    say(w, track("盯一下体检", "年度体检", "personal"));
    await pass(w, 5);
    const confirm = Object.values(w.store.state.commitments).find((c) => c.origin.who === "confirm")!;
    w.engine.answerQuestion(confirm.id, confirm.rounds, { option: "no" });
    await pass(w, 5);
    const told = w.threads.filter((t) => t.item.id.startsWith("told:"));
    assert.match((told[0]!.item.data as { text: string }).text, /^事项追踪：没收下。/);
  }));

test("with the switch off no agent is made for a card: the bare carrier gives an id and archives nothing", async () => {
  const carrier = createBareCarrier();
  const id = await carrier.raise({ id: "card_1" } as never, {} as never, 1);
  assert.match(id, /^no-agent:card_1$/);
  await carrier.archive(id);
});
