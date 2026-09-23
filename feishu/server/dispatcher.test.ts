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

interface FakeAgent {
  id: string;
  provider: string;
  labels: Record<string, string>;
  status: "idle" | "running";
  archivedAt: string | null;
  order: number;
}

/** Stands in for Paseo's agent registry; share one between harnesses to model a restart. */
function registry() {
  const agents = new Map<string, FakeAgent>();
  const created: Array<Record<string, unknown>> = [];
  const sends: Array<{ agentId: string; text: string }> = [];
  return { agents, created, sends };
}

function harness(
  options: { settings?: Settings | null; createFails?: boolean; paseo?: ReturnType<typeof registry> } = {},
) {
  const paseo = options.paseo ?? registry();
  const sent: Array<{ op: "reply" | "patch"; id: string; title: string; body: string }> = [];
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
  const agents = {
    create: async (input: Record<string, unknown>) => {
      paseo.created.push(input);
      if (options.createFails) throw new Error("provider is not installed");
      const id = String(input.agentId);
      paseo.agents.set(id, {
        id,
        provider: "claude",
        labels: input.labels as Record<string, string>,
        status: input.prompt ? "running" : "idle",
        archivedAt: null,
        order: paseo.agents.size,
      });
      return { id };
    },
    list: async (input: { filter: { labels: Record<string, string> }; page: { limit: number } }) => {
      const matches = [...paseo.agents.values()]
        .filter((agent) => agent.archivedAt === null)
        .filter((agent) =>
          Object.entries(input.filter.labels).every(([key, value]) => agent.labels[key] === value),
        )
        .sort((left, right) => right.order - left.order)
        .slice(0, input.page.limit);
      return { entries: matches.map((agent) => ({ agent })) };
    },
    ref: (id: string) => ({
      refresh: async () => {
        const agent = paseo.agents.get(id);
        return agent ? { agent } : null;
      },
      send: async (text: string) => {
        paseo.sends.push({ agentId: id, text });
        const agent = paseo.agents.get(id);
        if (agent) agent.status = "running";
      },
    }),
  };
  const dispatcher = createDispatcher({
    paseo: { agents } as never,
    lark,
    readSettings: async () => (options.settings === undefined ? settings : options.settings),
    log: (line) => logs.push(line),
    now: () => 0,
  });
  dispatchers.push(dispatcher);
  // Card patches are chained on promises; let them drain before asserting.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Ends the agent's current turn with `answer`, as Paseo's turn_ended hook would. */
  const end = async (agentId: string, answer: string) => {
    const fake = paseo.agents.get(agentId);
    if (fake) fake.status = "idle";
    dispatcher.onTurnEnded({
      agent: agent(agentId),
      turnId: null,
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "q" },
        { type: "assistant_message", text: answer },
      ],
    });
    await settle();
  };
  return { dispatcher, paseo, created: paseo.created, sent, logs, settle, end };
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

test("later messages in a chat go to the same agent", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message({ message_id: "om_1", content: "记住：暗号是蓝鲸" }));
  const agentId = String(h.created[0].agentId);
  assert.deepEqual(h.created[0].labels, { source: "feishu", "feishu-chat": CHAT });
  await h.end(agentId, "记住了。");

  await h.dispatcher.onMessage(message({ message_id: "om_2", content: "暗号是什么？" }));
  await h.settle();
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.paseo.sends, [{ agentId, text: "暗号是什么？" }]);
  await h.end(agentId, "蓝鲸。");
  assert.equal(h.sent.at(-1)?.title.split(" ")[0], "完成");
  assert.match(h.sent.at(-1)?.body ?? "", /^蓝鲸。/);
});

test("a message sent while the agent is busy waits for the turn to end", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message({ message_id: "om_1" }));
  const agentId = String(h.created[0].agentId);
  await h.dispatcher.onMessage(message({ message_id: "om_2", content: "顺便看看测试" }));
  await h.settle();
  assert.deepEqual(h.paseo.sends, []);
  assert.equal(h.sent.at(-1)?.title, "排队中");

  await h.end(agentId, "构建通过。");
  await h.settle();
  assert.deepEqual(h.paseo.sends, [{ agentId, text: "顺便看看测试" }]);
});

test("a turn started in Paseo also makes the next Feishu message wait", async () => {
  const shared = registry();
  const first = harness({ paseo: shared });
  await first.dispatcher.onMessage(message({ message_id: "om_1" }));
  const agentId = String(shared.created[0].agentId);
  await first.end(agentId, "好了。");
  // Someone types into the same agent from the Paseo app.
  shared.agents.get(agentId)!.status = "running";
  await first.dispatcher.onMessage(message({ message_id: "om_2", content: "还在吗" }));
  await first.settle();
  assert.deepEqual(shared.sends, []);
  await first.end(agentId, "（Paseo 里那一轮的回答）");
  assert.deepEqual(shared.sends, [{ agentId, text: "还在吗" }]);
});

test("/new starts a fresh agent that later messages go to", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message({ message_id: "om_1" }));
  const oldId = String(h.created[0].agentId);
  await h.end(oldId, "好了。");

  await h.dispatcher.onMessage(message({ message_id: "om_2", content: "/new" }));
  assert.equal(h.created.length, 2);
  assert.equal(h.created[1].prompt, undefined);
  const newId = String(h.created[1].agentId);
  assert.equal(h.sent.at(-1)?.title, "已开新会话");

  await h.dispatcher.onMessage(message({ message_id: "om_3", content: "从头来" }));
  assert.deepEqual(h.paseo.sends, [{ agentId: newId, text: "从头来" }]);
});

test("/new with text starts the fresh agent on that text", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message({ message_id: "om_1", content: "/new 换个话题" }));
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].prompt, "换个话题");
});

test("after a restart the chat finds its agent again through the label", async () => {
  const shared = registry();
  const before = harness({ paseo: shared });
  await before.dispatcher.onMessage(message({ message_id: "om_1" }));
  const agentId = String(shared.created[0].agentId);
  await before.end(agentId, "好了。");
  before.dispatcher.stop();

  const after = harness({ paseo: shared });
  await after.dispatcher.onMessage(message({ message_id: "om_2", content: "接着说" }));
  assert.equal(shared.created.length, 1);
  assert.deepEqual(shared.sends, [{ agentId, text: "接着说" }]);
});

test("an archived conversation is not resumed", async () => {
  const shared = registry();
  const h = harness({ paseo: shared });
  await h.dispatcher.onMessage(message({ message_id: "om_1" }));
  const agentId = String(shared.created[0].agentId);
  await h.end(agentId, "好了。");
  shared.agents.get(agentId)!.archivedAt = "2026-09-23T00:00:00Z";

  await h.dispatcher.onMessage(message({ message_id: "om_2", content: "新问题" }));
  assert.equal(shared.created.length, 2);
  assert.equal(shared.created[1].prompt, "新问题");
  assert.deepEqual(shared.sends, []);
});

test("two quick first messages start one agent, not two", async () => {
  const h = harness();
  await Promise.all([
    h.dispatcher.onMessage(message({ message_id: "om_1", content: "第一句" })),
    h.dispatcher.onMessage(message({ message_id: "om_2", content: "第二句" })),
  ]);
  await h.settle();
  assert.equal(h.created.length, 1);
  assert.equal(h.sent.at(-1)?.title, "排队中");
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
