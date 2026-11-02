import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { ACK, createConversations, type OpenAsk, type Row, type View } from "../server/conversation";

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function open(initial: View) {
  let view: View | null = initial;
  const said: string[] = [];
  const answered: Array<[string, string, string]> = [];
  const convo = createConversations({
    view: () => view,
    said: async (_id, text) => void said.push(text),
    answered: async (id, qid, text) => void answered.push([id, qid, text]),
  });
  const connection = await convo.registration.connect({ versions: [1], capabilities: ["prompt.message", "prompt.steer", "permission", "session.list"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((e) => events.push(e));
  const send = async (input: ProviderInput) => {
    await connection.send(input);
    await settle();
  };
  await send({ type: "session.open", requestId: "o1", sessionId: "s1", history: "skip", config: { cwd: "C:/x", env: { AFFAIR_ID: "D1" }, mcpServers: {}, settings: {}, persist: true, title: "洗牙" } });
  return {
    events, send, said, answered, convo,
    set: (v: View | null) => void (view = v),
    refresh: async () => {
      convo.refresh("D1");
      await settle();
    },
    items: () => events.filter((e): e is Extract<ProviderEvent, { type: "timeline.item" }> => e.type === "timeline.item").map((e) => e.item as unknown as Record<string, unknown>),
  };
}

const card = { title: "洗牙", waiting: "等你去约", now: "飞书任务还是待办", next: "明天 9:30 看；你一说话我马上看", open: true };
const row = (key: string, text: string, own = false): Row => ({ key, text, own, tone: "normal", detail: "" });
const ask = (id: string): OpenAsk => ({ id, title: "洗牙约上了吗？", line: "约上了告诉我哪天", options: ["约好了", "还没约", "不用盯了"] });

test("opening draws the card under one id, then the lines; drawing again adds nothing", async () => {
  const w = await open({ card, rows: [row("r2", "18:08  我看了一眼：没变化。"), row("s3", "你：还没约", true)], asks: [] });
  const [first, ...rest] = w.items();
  assert.deepEqual([first.type, first.id, first.kind], ["plugin", "card", "affair-card"]);
  assert.deepEqual(rest.map((i) => [i.type, i.id]), [["plugin", "row-r2"], ["user_message", "row-s3"]]);
  const n = w.items().length;
  await w.refresh();
  await w.refresh();
  assert.equal(w.items().length, n);
});

test("a new version of the card is the same id, so it replaces the last", async () => {
  const w = await open({ card, rows: [], asks: [] });
  w.set({ card: { ...card, next: "11-10 周二 20:00 提醒你明天去洗牙" }, rows: [], asks: [] });
  await w.refresh();
  const cards = w.items().filter((i) => i.type === "plugin");
  assert.equal(cards.length, 2);
  assert.equal(new Set(cards.map((c) => c.id)).size, 1);
});

test("a question is the app's own request, at most three choices; once answered anywhere it is resolved", async () => {
  const w = await open({ card, rows: [], asks: [ask("D1-1")] });
  const request = w.events.find((e) => e.type === "session.permission") as Extract<ProviderEvent, { type: "session.permission" }>;
  assert.equal(request.request.kind, "question");
  assert.equal(request.request.title, "洗牙约上了吗？");
  assert.ok(((request.request.input as { questions: Array<{ options: unknown[] }> }).questions[0]?.options.length ?? 0) <= 3);
  assert.ok(w.events.some((e) => e.type === "session.turn" && e.state === "started"), "a request needs a turn to sit in");
  w.set({ card, rows: [row("a4", "你：还没约 · 9:11", true)], asks: [] });
  await w.refresh();
  assert.ok(w.events.some((e) => e.type === "session.permission_resolved"));
  assert.ok(w.events.some((e) => e.type === "session.turn" && e.state === "completed"));
});

test("choosing in the app answers the affair; the app's own 'other' box carries typed words", async () => {
  const w = await open({ card, rows: [], asks: [ask("D1-1")] });
  await w.send({ type: "session.permission", sessionId: "s1", permissionId: "ask-D1-1", response: { behavior: "allow", updatedInput: { answers: { "D1-1": "还没约" } } } });
  assert.deepEqual(w.answered, [["D1", "D1-1", "还没约"]]);
});

test("typing in the conversation is saying it to the affair: told 收到 at once, and the first line of the look takes that line's place", async () => {
  const w = await open({ card, rows: [], asks: [] });
  await w.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "m1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "那个洗牙的约在下周三下午了" }] } } });
  assert.deepEqual(w.said, ["那个洗牙的约在下周三下午了"]);
  const textOf = (i: Record<string, unknown>) => String((i.data as { text?: string } | undefined)?.text ?? i.text ?? "");
  const ack = w.items().find((i) => textOf(i) === ACK)!;
  assert.ok(ack, "told at once");
  w.set({ card, rows: [row("s9", "你：那个洗牙的约在下周三下午了", true), row("r10", "12:31  我看了一眼：约在 11-11 下午。")], asks: [] });
  await w.refresh();
  const result = w.items().filter((i) => i.id === ack.id);
  assert.equal(result.length, 2);
  assert.match(textOf(result[1]!), /约在 11-11 下午/);
  assert.ok(w.events.some((e) => e.type === "session.turn" && e.state === "completed"), "the turn does not hang open");
});

test("the first message that starts the conversation is not said to the affair", async () => {
  const w = await open({ card, rows: [], asks: [] });
  await w.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "m0", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "事项 D1" }] } } });
  assert.deepEqual(w.said, []);
  assert.ok(!w.items().some((i) => (i.data as { text?: string } | undefined)?.text === ACK));
});

test("typing while a question waits answers it", async () => {
  const w = await open({ card, rows: [], asks: [ask("D1-1")] });
  await w.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "m2", delivery: "steer", input: { type: "message", content: [{ type: "text", text: "下周三" }] } } });
  assert.deepEqual(w.answered, [["D1", "D1-1", "下周三"]]);
});
