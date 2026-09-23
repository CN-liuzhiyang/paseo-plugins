import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { truncateBytes } from "./cards";
import { createDispatcher, stripMentions, type Lark } from "./dispatcher";
import type { Settings } from "./settings";
import { describePermission, finalAnswer } from "./timeline";

const SENDER = "ou_allowed";
const CHAT = "oc_routed";

const settings: Settings = {
  larkCli: "lark-cli",
  profile: "test",
  senders: [SENDER],
  routes: [{ chatId: CHAT, cwd: "/work", provider: "claude/claude-sonnet-5", modeId: "default" }],
};

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: "om_1",
    chat_id: CHAT,
    sender_id: SENDER,
    sender_type: "user",
    content: "查一下今天的构建",
    ...overrides,
  };
}

const dispatchers: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) dispatcher.stop();
});

function harness(options: { settings?: Settings | null; createFails?: boolean } = {}) {
  const sent: Array<{ op: "reply" | "patch"; id: string; title: string; body: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  let cards = 0;
  const record = (op: "reply" | "patch", id: string, card: object) => {
    const view = card as {
      header: { title: { content: string } };
      body: { elements: Array<{ content: string }> };
    };
    sent.push({ op, id, title: view.header.title.content, body: view.body.elements[0].content });
  };
  const lark: Lark = {
    async reply(messageId, card) {
      record("reply", messageId, card);
      cards += 1;
      return `om_card${cards}`;
    },
    async patch(cardId, card) {
      record("patch", cardId, card);
    },
  };
  const dispatcher = createDispatcher({
    paseo: {
      agents: {
        create: async (input: Record<string, unknown>) => {
          created.push(input);
          if (options.createFails) throw new Error("provider is not installed");
          return { id: input.agentId };
        },
      },
    } as never,
    lark,
    readSettings: async () => (options.settings === undefined ? settings : options.settings),
    log: (line) => logs.push(line),
    now: () => 0,
  });
  dispatchers.push(dispatcher);
  // Card patches are chained on promises; let them drain before asserting.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { dispatcher, sent, created, logs, settle };
}

function agent(id: string) {
  return { id, workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/work", title: null };
}

test("a sender outside the allowlist gets nothing back and starts nothing", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message({ sender_id: "ou_stranger" }));
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.created, []);
  // The operator reads both IDs off this line to allow the sender and route the chat.
  assert.match(h.logs.join("\n"), /from ou_stranger in oc_routed: not in senders/);
});

test("invalid settings admit nobody", async () => {
  const h = harness({ settings: null });
  await h.dispatcher.onMessage(message());
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.created, []);
});

test("messages from bots are ignored", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message({ sender_type: "bot" }));
  assert.deepEqual(h.sent, []);
});

test("an allowed sender in an unrouted chat is told the chat_id and starts nothing", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message({ chat_id: "oc_elsewhere" }));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].op, "reply");
  assert.match(h.sent[0].body, /oc_elsewhere/);
  assert.deepEqual(h.created, []);
});

test("a routed message walks one card from received to done", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message());
  await h.settle();
  assert.equal(h.created.length, 1);
  const input = h.created[0];
  assert.equal(input.cwd, "/work");
  assert.equal(input.prompt, "查一下今天的构建");
  assert.equal(input.idempotencyKey, "feishu:om_1");
  assert.deepEqual(input.config, {
    provider: "claude/claude-sonnet-5",
    modeId: "default",
    thinkingOptionId: undefined,
  });

  const timeline: AgentTimelineItem[] = [
    { type: "user_message", text: "查一下今天的构建" },
    { type: "assistant_message", text: "我先看看。" },
    {
      type: "tool_call",
      callId: "1",
      name: "Bash",
      status: "completed",
      detail: { type: "unknown", input: null, output: null },
      error: null,
    },
    { type: "assistant_message", text: "构建全部" },
    { type: "assistant_message", text: "通过。" },
  ];
  h.dispatcher.onTurnEnded({
    agent: agent(String(input.agentId)),
    turnId: null,
    outcome: { kind: "completed" },
    timeline,
  });
  await h.settle();

  assert.deepEqual(
    h.sent.map((entry) => [entry.op, entry.id, entry.title.split(" ")[0]]),
    [
      ["reply", "om_1", "已接收"],
      ["patch", "om_card1", "进行中"],
      ["patch", "om_card1", "完成"],
    ],
  );
  assert.match(h.sent[2].body, /^构建全部通过。/);
});

test("a permission request turns the card orange until it is resolved", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message());
  const agentId = String(h.created[0].agentId);
  h.dispatcher.onPermissionRequested({
    agent: agent(agentId),
    request: {
      id: "perm-1",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      input: { command: "git push" },
    },
  });
  h.dispatcher.onPermissionResolved({
    agent: agent(agentId),
    requestId: "perm-1",
    resolution: { behavior: "allow" },
  });
  await h.settle();
  const titles = h.sent.map((entry) => entry.title.split(" ")[0]);
  assert.deepEqual(titles, ["已接收", "进行中", "等待审批", "进行中"]);
  assert.match(h.sent[2].body, /Bash: git push/);
});

test("a failed turn and a failed start both end on a red card", async () => {
  const turn = harness();
  await turn.dispatcher.onMessage(message());
  turn.dispatcher.onTurnEnded({
    agent: agent(String(turn.created[0].agentId)),
    turnId: null,
    outcome: { kind: "failed", error: { message: "rate limited" } },
    timeline: [],
  });
  await turn.settle();
  assert.equal(turn.sent.at(-1)?.title, "失败");
  assert.match(turn.sent.at(-1)?.body ?? "", /rate limited/);

  const start = harness({ createFails: true });
  await start.dispatcher.onMessage(message());
  await start.settle();
  assert.equal(start.sent.at(-1)?.title, "失败");
  assert.match(start.sent.at(-1)?.body ?? "", /provider is not installed/);
});

test("a redelivered message starts no second agent", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message());
  await h.dispatcher.onMessage(message());
  assert.equal(h.created.length, 1);
});

test("events for agents this plugin did not start are ignored", async () => {
  const h = harness();
  h.dispatcher.onTurnEnded({
    agent: agent("someone-else"),
    turnId: null,
    outcome: { kind: "completed" },
    timeline: [],
  });
  await h.settle();
  assert.deepEqual(h.sent, []);
});

test("mention placeholders are removed from the request", () => {
  assert.equal(stripMentions("@_user_1 帮我看看", [{ key: "@_user_1" }]), "帮我看看");
  assert.equal(stripMentions("  没有提及  ", undefined), "没有提及");
});

test("the final answer falls back to all turn text when a tool call ends the turn", () => {
  assert.equal(
    finalAnswer([
      { type: "user_message", text: "q" },
      { type: "assistant_message", text: "先看看" },
      { type: "todo", items: [] },
    ]),
    "先看看",
  );
});

test("permission descriptions stay on one short line", () => {
  const what = describePermission({
    id: "p",
    provider: "claude",
    name: "Bash",
    kind: "tool",
    input: { command: `echo ${"x".repeat(500)}\nrm -rf /` },
  });
  assert.ok(!what.includes("\n"));
  assert.ok(what.length <= 201);
});

test("truncation keeps a card under the byte budget without splitting a character", () => {
  const long = "汉".repeat(10_000);
  const cut = truncateBytes(long, 1_000);
  assert.ok(Buffer.byteLength(cut, "utf8") <= 1_000);
  assert.ok(!cut.includes(String.fromCharCode(0xfffd)));
  assert.equal(truncateBytes("short", 1_000), "short");
});
