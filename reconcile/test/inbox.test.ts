import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderConnection, ProviderEvent, ProviderInput, ProviderPermissionRequest } from "@getpaseo/plugin/server/provider";
import type { CardAnswer, CardContent } from "../server/engine";
import { answersOf, cardPrompt, CLOSE_GRACE_MS, createInboxProvider } from "../server/inbox";

// The carrier against a fake host: the inputs Paseo sends and the events it gets back.

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const CARD = "card_0123456789ab";
const content: CardContent = {
  title: "示例单 1：外放了吗？",
  brief: "**示例单 1** 计划 10-23 外放，单子已关闭。",
  questions: [
    {
      commitmentId: "c_0123456789abcdef",
      header: "示例单 1",
      question: "示例单 1 计划 10-23 外放，外放了吗？",
      options: [
        { id: "out-on", label: "外放了，开关开着", description: "" },
        { id: "not-yet", label: "还没外放", description: "过一个工作日再问" },
      ],
      allowOther: true,
    },
  ],
};

async function host(cards: Record<string, CardContent | null> = { [CARD]: content }, closeGraceMs = 30) {
  const answered: Array<{ cardId: string; answer: CardAnswer }> = [];
  const connection: ProviderConnection = await createInboxProvider({
    card: (id) => cards[id] ?? null,
    answer: (cardId, answer) => {
      answered.push({ cardId, answer });
      return "记下了。";
    },
  }, { closeGraceMs }).connect({ versions: [1], capabilities: ["prompt.message", "prompt.steer", "permission", "session.list"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const send = async (input: ProviderInput) => {
    await connection.send(input);
    await settle();
  };
  await send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "s1",
    history: "skip",
    config: { cwd: "C:/work", env: {}, mcpServers: {}, settings: {}, persist: true, title: "事务" },
  });
  let n = 0;
  const prompt = (text: string, delivery: "auto" | "steer" = "auto") =>
    send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: `m-${++n}`, delivery, input: { type: "message", content: [{ type: "text", text }] } } });
  const card = () => events.find((e): e is Extract<ProviderEvent, { type: "session.permission" }> => e.type === "session.permission")?.request as ProviderPermissionRequest;
  const turns = () => events.filter((e) => e.type === "session.turn").map((e) => (e as { state: string }).state);
  const said = () => events.filter((e) => e.type === "timeline.item").map((e) => (e as { item: { type: string; text?: string } }).item).filter((i) => i.type === "assistant_message").map((i) => i.text);
  return { connection, events, send, prompt, card, turns, said, answered };
}

test("the prompt raises one question form: the brief above it, choices and other below", async () => {
  const h = await host();
  await h.prompt(cardPrompt(CARD));
  const card = h.card();
  assert.equal(card.kind, "question");
  assert.equal(card.title, content.title);
  assert.deepEqual(card.input, {
    questions: [
      {
        question: content.questions[0]!.question,
        header: "示例单 1",
        options: [
          { label: "外放了，开关开着", description: "" },
          { label: "还没外放", description: "过一个工作日再问" },
        ],
        multiSelect: false,
        allowOther: true,
      },
    ],
  });
  assert.deepEqual(h.said(), [content.brief]);
  assert.deepEqual(h.turns(), ["started"]);
});

test("answering the form hands header -> label to the engine and ends the turn", async () => {
  const h = await host();
  await h.prompt(cardPrompt(CARD));
  await h.send({ type: "session.permission", sessionId: "s1", permissionId: h.card().id, response: { behavior: "allow", updatedInput: { answers: { "示例单 1": "还没外放" } } } });
  assert.deepEqual(h.answered, [{ cardId: CARD, answer: { kind: "answers", answers: { "示例单 1": "还没外放" }, via: "form" } }]);
  assert.ok(h.events.some((e) => e.type === "session.permission_resolved"));
  assert.deepEqual(h.turns(), ["started", "completed"]);
  assert.deepEqual(h.said(), [content.brief, "记下了。"]);
  // A second answer, or a new prompt, changes nothing.
  await h.send({ type: "session.permission", sessionId: "s1", permissionId: h.card().id, response: { behavior: "deny" } });
  await h.prompt(cardPrompt(CARD));
  assert.equal(h.answered.length, 1);
  assert.equal(h.events.filter((e) => e.type === "session.permission").length, 1);
});

test("typing instead of choosing is an answer; denying is a dismissal; closing is a close", async () => {
  const typed = await host();
  await typed.prompt(cardPrompt(CARD));
  await typed.prompt("推迟到 10-30", "steer");
  assert.deepEqual(typed.answered[0]!.answer, { kind: "typed", text: "推迟到 10-30" });

  const denied = await host();
  await denied.prompt(cardPrompt(CARD));
  await denied.send({ type: "session.permission", sessionId: "s1", permissionId: denied.card().id, response: { behavior: "deny" } });
  assert.deepEqual(denied.answered[0]!.answer, { kind: "dismissed", via: "deny" });

  const closed = await host();
  await closed.prompt(cardPrompt(CARD));
  await closed.send({ type: "session.close", requestId: "close-1", sessionId: "s1" });
  assert.ok(closed.events.some((e) => e.type === "session.closed"));
  assert.equal(closed.answered.length, 0, "not at once: it may be Paseo shutting down");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(closed.answered[0]!.answer, { kind: "closed" }, "the connection stayed: a person archived the card");
});

test("Paseo shutting down closes the session and then the connection: the card is not told closed, so it comes back after the restart", async () => {
  const h = await host(undefined, 30);
  await h.prompt(cardPrompt(CARD));
  // What the host does on a graceful stop: session.close for every agent, then the provider connection.
  await h.send({ type: "session.close", requestId: "close-1", sessionId: "s1" });
  await h.connection.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(h.answered, []);
});

test("a card the engine no longer has gets a note, not a form", async () => {
  const h = await host({});
  await h.prompt(cardPrompt(CARD));
  assert.equal(h.card(), undefined);
  assert.match(h.said()[0]!, /已经结束/);
  assert.deepEqual(h.turns(), ["started", "completed"]);
  await h.prompt("你好", "steer");
  assert.equal(h.answered.length, 0);
});

test("answersOf keeps only string answers", () => {
  assert.deepEqual(answersOf({ answers: { a: "x", b: 2 } }), { a: "x" });
  assert.equal(answersOf({}), null);
  assert.equal(answersOf(undefined), null);
});

test("by default a close waits 90 seconds for the connection: a host shutting down can take longer than a few seconds to get there", () => {
  assert.equal(CLOSE_GRACE_MS, 90_000);
});
