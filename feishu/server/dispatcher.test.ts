import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
} from "@getpaseo/protocol/agent-types";
import { decisionLine, truncateBytes } from "./cards";
import { createDispatcher, heartbeatMs, type Lark, type Stranger } from "./dispatcher";
import { stripMentions, type Incoming } from "./inbound";
import { parseButtonName, requestDetail } from "./permissions";
import type { Settings } from "../shared/settings";
import { describePermission, finalAnswer } from "./timeline";

const SENDER = "ou_allowed";
const CHAT = "oc_routed";

const settings: Settings = {
  larkCli: "lark-cli",
  profile: "test",
  senders: [SENDER],
  routes: [
    {
      chatId: CHAT,
      name: "",
      cwd: "/work",
      provider: "claude/claude-sonnet-5",
      modeId: "default",
      instructions: "",
      claudeMd: false,
    },
  ],
  auditDir: "",
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
  pendingPermissions: AgentPermissionRequest[];
}

/** Stands in for Paseo's agent registry; share one between harnesses to model a restart. */
function registry() {
  const agents = new Map<string, FakeAgent>();
  const created: Array<Record<string, unknown>> = [];
  const sends: Array<{ agentId: string; text: string; images?: unknown }> = [];
  const responses: Array<{ agentId: string; requestId: string; response: AgentPermissionResponse }> = [];
  // Live timeline listeners, one per followed agent.
  const streams = new Map<string, (event: unknown) => void>();
  return { agents, created, sends, responses, streams, respondFails: false };
}

interface Sent {
  op: "reply" | "patch";
  id: string;
  title: string;
  /** The card's first element, which is always markdown. */
  body: string;
  card: object;
}

function harness(
  options: {
    settings?: Settings | null;
    createFails?: boolean;
    paseo?: ReturnType<typeof registry>;
    readIncoming?: (event: Record<string, unknown>, options?: { command?: RegExp }) => Promise<Incoming>;
    botId?: () => Promise<string | null>;
  } = {},
) {
  const paseo = options.paseo ?? registry();
  const sent: Sent[] = [];
  const logs: string[] = [];
  const audits: Array<{ kind: string } & Record<string, unknown>> = [];
  const strangers: Stranger[] = [];
  let cards = 0;
  const record = (op: "reply" | "patch", id: string, card: object) => {
    const view = card as {
      header: { title: { content: string } };
      body: { elements: Array<{ content: string }> };
    };
    sent.push({ op, id, title: view.header.title.content, body: view.body.elements[0].content, card });
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
        status: "idle",
        archivedAt: null,
        order: paseo.agents.size,
        pendingPermissions: [],
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
      send: async (text: string, sendOptions?: { images?: unknown }) => {
        paseo.sends.push({ agentId: id, text, ...(sendOptions?.images ? { images: sendOptions.images } : {}) });
        const agent = paseo.agents.get(id);
        if (agent) agent.status = "running";
      },
      respondToPermission: async (input: { requestId: string; response: AgentPermissionResponse }) => {
        if (paseo.respondFails) throw new Error("daemon went away");
        paseo.responses.push({ agentId: id, ...input });
      },
      timeline: {
        subscribe: (handler: (event: unknown) => void) => {
          paseo.streams.set(id, handler);
          return Object.assign(() => paseo.streams.delete(id), { ready: Promise.resolve() });
        },
      },
    }),
  };
  let clock = 0;
  const dispatcher = createDispatcher({
    paseo: { agents } as never,
    lark,
    readSettings: async () => (options.settings === undefined ? settings : options.settings),
    log: (line) => logs.push(line),
    audit: (kind, fields) => audits.push({ kind, ...fields }),
    now: () => clock,
    paintIntervalMs: 0,
    ...(options.readIncoming ? { readIncoming: options.readIncoming } : {}),
    ...(options.botId ? { botId: options.botId } : {}),
    onStranger: (stranger) => strangers.push(stranger),
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
  /** The agent asks for permission: Paseo holds the request open and the hook fires. */
  const ask = async (agentId: string, request: AgentPermissionRequest) => {
    paseo.agents.get(agentId)?.pendingPermissions.push(request);
    dispatcher.onPermissionRequested({ agent: agent(agentId), request });
    await settle();
  };
  /** Paseo settles a request, whoever answered it. */
  const resolve = async (agentId: string, requestId: string, resolution: AgentPermissionResponse) => {
    const fake = paseo.agents.get(agentId);
    if (fake) fake.pendingPermissions = fake.pendingPermissions.filter((open) => open.id !== requestId);
    dispatcher.onPermissionResolved({ agent: agent(agentId), requestId, resolution });
    await settle();
  };
  /** Someone presses a button, as lark-cli's card.action.trigger line describes it. */
  let events = 0;
  const click = async (
    name: string,
    input: { operator?: string; chatId?: string; cardId?: string; reason?: string } = {},
  ) => {
    events += 1;
    const form = parseButtonName(name)?.form ?? 0;
    await dispatcher.onCardAction({
      event_id: `ev_${events}`,
      operator_id: input.operator ?? SENDER,
      message_id: input.cardId ?? "om_card1",
      chat_id: input.chatId ?? CHAT,
      action_tag: "button",
      action_name: name,
      form_value: JSON.stringify({ [`reason${form}`]: input.reason ?? "" }),
    });
    await settle();
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  /** The agent's live timeline shows `item`, as Paseo streams it. */
  const stream = async (agentId: string, item: AgentTimelineItem) => {
    paseo.streams.get(agentId)?.({ agentId, event: { type: "timeline", item, provider: "claude" } });
    await settle();
  };
  return {
    dispatcher,
    paseo,
    created: paseo.created,
    sent,
    logs,
    audits,
    settle,
    end,
    ask,
    resolve,
    click,
    advance,
    stream,
    strangers,
  };
}

/** Every button on a card, in order, with the name it sends back. */
function buttons(card: object): Array<{ name: string; label: string; type: string }> {
  const found: Array<{ name: string; label: string; type: string }> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const element = node as Record<string, unknown>;
    if (element.tag === "button") {
      found.push({
        name: String(element.name),
        label: String((element.text as { content: string }).content),
        type: String(element.type),
      });
    }
    Object.values(element).forEach(walk);
  };
  walk(card);
  return found;
}

const push: AgentPermissionRequest = {
  id: "toolu_push",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  input: { command: "git push origin next" },
  detail: { type: "shell", command: "git push origin next" },
};

/** Starts a run and has its agent ask for `request`; returns the agent's ID. */
async function waiting(h: ReturnType<typeof harness>, request = push): Promise<string> {
  await h.dispatcher.onMessage(message());
  const agentId = String(h.created[0].agentId);
  await h.ask(agentId, request);
  return agentId;
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
  assert.equal(input.idempotencyKey, "feishu:om_1");
  const config = input.config as Record<string, unknown>;
  assert.equal(config.provider, "claude/claude-sonnet-5");
  assert.equal(config.modeId, "default");
  assert.match(String(config.systemPrompt), /飞书单聊/);
  // Created first and then sent the message, so the card can follow the turn from its start.
  assert.equal(input.prompt, undefined);
  assert.deepEqual(h.paseo.sends, [{ agentId: String(input.agentId), text: "查一下今天的构建" }]);

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
  const agentId = await waiting(h);
  await h.resolve(agentId, push.id, { behavior: "allow" });
  const titles = h.sent.map((entry) => entry.title.split(" ")[0]);
  assert.deepEqual(titles, ["已接收", "进行中", "等待审批", "进行中"]);
  assert.match(JSON.stringify(h.sent[2].card), /git push origin next/);
});

test("the waiting card offers Paseo's choices, with a reason for denying", async () => {
  const h = harness();
  const agentId = await waiting(h);
  const card = h.sent.at(-1)!.card;
  assert.deepEqual(
    buttons(card).map(({ label, type }) => [label, type]),
    [
      ["拒绝", "danger"],
      ["允许", "primary_filled"],
    ],
  );
  assert.deepEqual(parseButtonName(buttons(card)[1].name), {
    form: 0,
    action: 1,
    agentId,
    requestId: push.id,
  });
  assert.match(JSON.stringify(card), /"tag":"input","name":"reason0"/);
});

test("an allowed sender approves from the card and the card says who did", async () => {
  const h = harness();
  const agentId = await waiting(h);
  h.advance(12_000);
  await h.click(buttons(h.sent.at(-1)!.card)[1].name);
  assert.deepEqual(h.paseo.responses, [
    { agentId, requestId: push.id, response: { behavior: "allow", selectedActionId: "accept" } },
  ]);
  assert.match(JSON.stringify(h.sent.at(-1)!.card), /正在提交/);
  assert.deepEqual(buttons(h.sent.at(-1)!.card), []);

  await h.resolve(agentId, push.id, { behavior: "allow", selectedActionId: "accept" });
  const done = h.sent.at(-1)!;
  assert.equal(done.title.split(" ")[0], "进行中");
  assert.match(JSON.stringify(done.card), /<person id='ou_allowed'/);
  assert.match(JSON.stringify(done.card), /12 秒/);
  const decision = h.audits.find((entry) => entry.kind === "feishu.approval.decision")!;
  assert.equal(decision.by, "feishu:ou_allowed");
  assert.equal(decision.outcome, "allowed");
  assert.equal(decision.waitedMs, 12_000);
  assert.deepEqual(
    h.audits.map((entry) => entry.kind),
    ["feishu.approval.ask", "feishu.approval.answer", "feishu.approval.decision"],
  );
});

test("a denial carries the reason typed on the card to the agent", async () => {
  const h = harness();
  await waiting(h);
  await h.click(buttons(h.sent.at(-1)!.card)[0].name, { reason: "  先别推，等评审  " });
  assert.deepEqual(h.paseo.responses[0].response, {
    behavior: "deny",
    selectedActionId: "reject",
    message: "Denied by user: 先别推，等评审",
  });
});

test("nobody outside senders can answer, and the card does not change", async () => {
  const h = harness();
  await waiting(h);
  const before = h.sent.length;
  await h.click(buttons(h.sent.at(-1)!.card)[1].name, { operator: "ou_stranger" });
  assert.deepEqual(h.paseo.responses, []);
  assert.equal(h.sent.length, before);
  assert.deepEqual(h.audits.at(-1), {
    kind: "feishu.approval.refused",
    agentId: String(h.created[0].agentId),
    requestId: push.id,
    chatId: CHAT,
    cardId: "om_card1",
    operator: "ou_stranger",
    why: "not in senders",
  });
});

test("a card in another chat cannot answer the agent", async () => {
  const h = harness();
  await waiting(h);
  await h.click(buttons(h.sent.at(-1)!.card)[1].name, { chatId: "oc_elsewhere" });
  assert.deepEqual(h.paseo.responses, []);
  assert.equal(h.audits.at(-1)?.why, "the card is not in the agent's chat");
});

test("a second click while the first answer is on its way sends nothing", async () => {
  const h = harness();
  await waiting(h);
  const allow = buttons(h.sent.at(-1)!.card)[1].name;
  await h.click(allow);
  await h.click(allow);
  assert.equal(h.paseo.responses.length, 1);
  assert.equal(h.audits.at(-1)?.why, "an answer is already on its way");
});

test("a request answered in Paseo is recorded as such and cannot be answered again", async () => {
  const h = harness();
  const agentId = await waiting(h);
  const allow = buttons(h.sent.at(-1)!.card)[1].name;
  await h.resolve(agentId, push.id, { behavior: "deny", selectedActionId: "reject", message: "Denied by user" });
  assert.match(JSON.stringify(h.sent.at(-1)!.card), /在 Paseo 里/);
  const decision = h.audits.find((entry) => entry.kind === "feishu.approval.decision")!;
  assert.equal(decision.outcome, "denied");
  assert.match(String(decision.by), /^paseo/);

  await h.click(allow);
  assert.deepEqual(h.paseo.responses, []);
  assert.equal(h.audits.at(-1)?.why, "the request is no longer open");
});

test("after a restart a card still answers its request, checked against Paseo", async () => {
  const shared = registry();
  const before = harness({ paseo: shared });
  const agentId = await waiting(before);
  const allow = buttons(before.sent.at(-1)!.card)[1].name;
  before.dispatcher.stop();

  const after = harness({ paseo: shared });
  await after.click(allow);
  assert.deepEqual(shared.responses.map((entry) => entry.requestId), [push.id]);
  await after.resolve(agentId, push.id, { behavior: "allow", selectedActionId: "accept" });
  const card = after.sent.at(-1)!;
  assert.equal(card.op, "patch");
  assert.equal(card.id, "om_card1");
  assert.equal(card.title, "已处理审批");
  assert.match(card.body, /<person id='ou_allowed'/);
});

test("an answer Paseo does not take is reported and can be tried again", async () => {
  const h = harness();
  await waiting(h);
  h.paseo.respondFails = true;
  await h.click(buttons(h.sent.at(-1)!.card)[1].name);
  const card = JSON.stringify(h.sent.at(-1)!.card);
  assert.match(card, /没能提交给 Paseo：daemon went away/);
  assert.equal(buttons(h.sent.at(-1)!.card).length, 2);
  assert.equal(h.audits.at(-1)?.kind, "feishu.approval.error");

  h.paseo.respondFails = false;
  await h.click(buttons(h.sent.at(-1)!.card)[1].name);
  assert.equal(h.paseo.responses.length, 1);
});

test("a request still open when the turn ends is recorded as never answered", async () => {
  const h = harness();
  const agentId = await waiting(h);
  h.dispatcher.onTurnEnded({
    agent: agent(agentId),
    turnId: null,
    outcome: { kind: "canceled", reason: "stopped in Paseo" },
    timeline: [],
  });
  await h.settle();
  assert.equal(h.sent.at(-1)?.title, "已取消");
  assert.match(JSON.stringify(h.sent.at(-1)!.card), /没有处理/);
  assert.equal(h.audits.at(-1)?.outcome, "abandoned");
});

test("questions are answered in Paseo, not on the card", async () => {
  const h = harness();
  await waiting(h, {
    id: "q1",
    provider: "claude",
    name: "AskUserQuestion",
    kind: "question",
    input: { questions: [{ question: "用哪个分支？" }] },
  });
  const card = h.sent.at(-1)!.card;
  assert.deepEqual(buttons(card), []);
  assert.match(JSON.stringify(card), /请到 Paseo 里回答/);
});

test("several open requests each get their own form", async () => {
  const h = harness();
  const agentId = await waiting(h);
  await h.ask(agentId, { ...push, id: "toolu_second", input: { command: "rm -rf dist" }, detail: undefined });
  const names = buttons(h.sent.at(-1)!.card).map(({ name }) => parseButtonName(name));
  assert.deepEqual(
    names.map((target) => [target?.form, target?.requestId]),
    [
      [0, push.id],
      [0, push.id],
      [1, "toolu_second"],
      [1, "toolu_second"],
    ],
  );
  await h.click(buttons(h.sent.at(-1)!.card)[2].name, { reason: "别删" });
  assert.deepEqual(h.paseo.responses[0], {
    agentId,
    requestId: "toolu_second",
    response: { behavior: "deny", selectedActionId: "reject", message: "Denied by user: 别删" },
  });
});

test("agent text on a card can neither mention anyone nor link anywhere", async () => {
  const line = decisionLine({
    outcome: "allowed",
    label: "允许",
    what: "Bash: echo <at id=all></at> [点我](https://evil.example)",
    operator: null,
    waitedMs: null,
  });
  assert.ok(!line.includes("<at"));
  assert.ok(!line.includes("](https://"));

  const h = harness();
  await waiting(h, { ...push, detail: { type: "shell", command: "echo <at id=all></at>" } });
  // Command text sits in plain_text, which Feishu never parses.
  assert.match(JSON.stringify(h.sent.at(-1)!.card), /"tag":"plain_text","content":"echo <at id=all><\/at>"/);
});

test("the detail shows what a tool would change", () => {
  assert.equal(
    requestDetail({
      id: "e",
      provider: "claude",
      name: "Edit",
      kind: "tool",
      detail: { type: "edit", filePath: "src/a.ts", unifiedDiff: "-old\n+new" },
    }),
    "src/a.ts\n\n-old\n+new",
  );
  assert.equal(
    requestDetail({
      id: "p",
      provider: "claude",
      name: "ExitPlanMode",
      kind: "plan",
      input: { plan: "1. 改配置\n2. 跑测试" },
    }),
    "1. 改配置\n2. 跑测试",
  );
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
  assert.deepEqual(h.created[0].labels, { source: "feishu", "feishu-chat": CHAT, "feishu-claude-md": "off" });
  await h.end(agentId, "记住了。");

  await h.dispatcher.onMessage(message({ message_id: "om_2", content: "暗号是什么？" }));
  await h.settle();
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.paseo.sends, [
    { agentId, text: "记住：暗号是蓝鲸" },
    { agentId, text: "暗号是什么？" },
  ]);
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
  assert.equal(h.paseo.sends.length, 1);
  assert.equal(h.sent.at(-1)?.title, "排队中");

  await h.end(agentId, "构建通过。");
  await h.settle();
  assert.deepEqual(h.paseo.sends.at(-1), { agentId, text: "顺便看看测试" });
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
  assert.equal(shared.sends.length, 1);
  await first.end(agentId, "（Paseo 里那一轮的回答）");
  assert.deepEqual(shared.sends.at(-1), { agentId, text: "还在吗" });
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
  assert.deepEqual(h.paseo.sends.at(-1), { agentId: newId, text: "从头来" });
});

test("/new with text starts the fresh agent on that text", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message({ message_id: "om_1", content: "/new 换个话题" }));
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.paseo.sends, [{ agentId: String(h.created[0].agentId), text: "换个话题" }]);
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
  assert.deepEqual(shared.sends.at(-1), { agentId, text: "接着说" });
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
  assert.deepEqual(shared.sends.at(-1), { agentId: String(shared.created[1].agentId), text: "新问题" });
  assert.equal(shared.sends.filter((sent) => sent.agentId === agentId).length, 1);
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

test("a permission description names the file, not just the tool", () => {
  // As Claude's Write request arrived in the first live test: no title, no detail.
  const write: AgentPermissionRequest = {
    id: "w",
    provider: "claude",
    name: "Write",
    kind: "tool",
    input: { file_path: "C:\\work\\hello.txt", content: "嗨" },
  };
  assert.equal(describePermission(write), "Write: C:\\work\\hello.txt");
  assert.equal(
    describePermission({ ...write, name: "Edit", detail: { type: "edit", filePath: "src/a.ts" } }),
    "Edit: src/a.ts",
  );
});

test("truncation keeps a card under the byte budget without splitting a character", () => {
  const long = "汉".repeat(10_000);
  const cut = truncateBytes(long, 1_000);
  assert.ok(Buffer.byteLength(cut, "utf8") <= 1_000);
  assert.ok(!cut.includes(String.fromCharCode(0xfffd)));
  assert.equal(truncateBytes("short", 1_000), "short");
});

test("the running card says what the agent is doing, as it does it", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message());
  const agentId = String(h.created[0].agentId);
  await h.stream(agentId, { type: "reasoning", text: "想一想" });
  assert.match(JSON.stringify(h.sent.at(-1)!.card), /正在思考/);

  const running: AgentTimelineItem = {
    type: "tool_call",
    callId: "c1",
    name: "Bash",
    status: "running",
    detail: { type: "shell", command: "npm test" },
    error: null,
  };
  h.advance(2_000);
  await h.stream(agentId, running);
  assert.match(JSON.stringify(h.sent.at(-1)!.card), /▶ 运行 npm test/);
  await h.stream(agentId, { ...running, status: "completed" } as AgentTimelineItem);
  await h.stream(agentId, { type: "assistant_message", text: "测试" });
  await h.stream(agentId, { type: "assistant_message", text: "全部通过。" });
  const card = JSON.stringify(h.sent.at(-1)!.card);
  assert.match(card, /✓ 运行 npm test/);
  assert.match(card, /测试全部通过。/);

  await h.end(agentId, "测试全部通过。");
  const done = JSON.stringify(h.sent.at(-1)!.card);
  assert.equal(h.sent.at(-1)!.title.split(" ")[0], "完成");
  // The steps fold away under the answer.
  assert.match(done, /"tag":"collapsible_panel","expanded":false/);
  assert.match(done, /执行过程 · 1 步/);
});

test("a quiet run still shows its clock moving", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message());
  const before = h.sent.length;
  h.advance(1_000);
  h.dispatcher.heartbeat();
  await h.settle();
  assert.equal(h.sent.length, before, "no redraw sooner than the heartbeat");
  h.advance(2_000);
  h.dispatcher.heartbeat();
  await h.settle();
  assert.equal(h.sent.at(-1)!.title, "进行中 · 3 秒");
  assert.equal(heartbeatMs(30_000), 3_000);
  assert.equal(heartbeatMs(5 * 60_000), 10_000);
});

test("a waiting card is not redrawn by the clock, so a reason being typed survives", async () => {
  const h = harness();
  await waiting(h);
  const before = h.sent.length;
  h.advance(60_000);
  h.dispatcher.heartbeat();
  await h.settle();
  assert.equal(h.sent.length, before);
});

test("images in a message go to the agent with it", async () => {
  const image = { data: "aGk=", mimeType: "image/png" };
  const h = harness({
    readIncoming: async () => ({ prompt: "[图片 1]", images: [image], summary: "[图片]", problems: ["有一张图片没附上：图片太大"] }),
  });
  await h.dispatcher.onMessage(message({ message_type: "image", content: "[Image: img_v3_x]" }));
  assert.deepEqual(h.paseo.sends, [{ agentId: String(h.created[0].agentId), text: "[图片 1]", images: [image] }]);
  assert.equal(h.sent[0].body, "> &#91;图片&#93;\n\n正在为这个会话启动 agent。");
  assert.match(JSON.stringify(h.sent.at(-1)!.card), /图片太大/);
});

test("people turned away are remembered for the settings screen", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message({ sender_id: "ou_stranger" }));
  await h.dispatcher.onMessage(message({ message_id: "om_2", chat_id: "oc_elsewhere" }));
  assert.deepEqual(
    h.strangers.map(({ senderId, chatId, why }) => [senderId, chatId, why]),
    [
      ["ou_stranger", CHAT, "sender"],
      [SENDER, "oc_elsewhere", "route"],
    ],
  );
});

test("an agent is created without CLAUDE.md unless its route asks for it", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message());
  assert.deepEqual(h.created[0].env, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });

  const withClaudeMd = harness({
    settings: { ...settings, routes: [{ ...settings.routes[0], claudeMd: true }] },
  });
  await withClaudeMd.dispatcher.onMessage(message());
  assert.equal(withClaudeMd.created[0].env, undefined);
  assert.equal((withClaudeMd.created[0].labels as Record<string, string>)["feishu-claude-md"], undefined);
});

test("a request quoted on a card cannot mention anyone either", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message({ content: "<at id=all></at> 看这里" }));
  assert.ok(!h.sent[0].body.includes("<at"));
});

test("a finished card always fits Feishu's size limit, however long the answer", async () => {
  const h = harness();
  await h.dispatcher.onMessage(message());
  const agentId = String(h.created[0].agentId);
  for (let index = 0; index < 40; index++) {
    await h.stream(agentId, {
      type: "tool_call",
      callId: `c${index}`,
      name: "Bash",
      status: "completed",
      detail: { type: "shell", command: `echo ${"很长的命令".repeat(20)} ${index}` },
      error: null,
    });
  }
  const answer = "见 [文档](https://example.com/some/long/path) 和 <tag> ".repeat(400);
  await h.end(agentId, answer);
  const card = h.sent.at(-1)!;
  assert.equal(card.title.split(" ")[0], "完成");
  assert.ok(Buffer.byteLength(JSON.stringify(card.card), "utf8") <= 28_000);
});

test("a message that finds the agent busy is still sent if the turn ends while its card goes out", async () => {
  const shared = registry();
  const h = harness({ paseo: shared });
  await h.dispatcher.onMessage(message({ message_id: "om_1" }));
  const agentId = String(shared.created[0].agentId);
  await h.end(agentId, "好了。");
  // A turn started in Paseo is running when the message arrives, and ends before the plugin
  // gets to queue it: there will be no turn_ended left to drain the queue.
  shared.agents.get(agentId)!.status = "running";
  const pending = h.dispatcher.onMessage(message({ message_id: "om_2", content: "还在吗" }));
  shared.agents.get(agentId)!.status = "idle";
  h.dispatcher.onTurnEnded({ agent: agent(agentId), turnId: null, outcome: { kind: "completed" }, timeline: [] });
  await pending;
  await h.settle();
  assert.deepEqual(shared.sends.at(-1), { agentId, text: "还在吗" });
});

test("a queue stuck behind a turn that ended unseen is drained by the heartbeat", async () => {
  const shared = registry();
  const h = harness({ paseo: shared });
  await h.dispatcher.onMessage(message({ message_id: "om_1" }));
  const agentId = String(shared.created[0].agentId);
  await h.end(agentId, "好了。");
  shared.agents.get(agentId)!.status = "running";
  await h.dispatcher.onMessage(message({ message_id: "om_2", content: "还在吗" }));
  assert.equal(h.sent.at(-1)?.title, "排队中");
  // The Paseo turn ends; its turn_ended came before anything was queued.
  shared.agents.get(agentId)!.status = "idle";
  h.advance(10_000);
  h.dispatcher.heartbeat();
  await h.settle();
  await h.settle();
  assert.deepEqual(shared.sends.at(-1), { agentId, text: "还在吗" });
});

test("a late click does not replace a card that already shows how its run ended", async () => {
  const h = harness();
  const agentId = await waiting(h);
  const allow = buttons(h.sent.at(-1)!.card)[1].name;
  await h.resolve(agentId, push.id, { behavior: "allow", selectedActionId: "accept" });
  await h.end(agentId, "推送完成。");
  const done = h.sent.length;
  await h.click(allow);
  assert.equal(h.sent.length, done);
  assert.equal(h.audits.at(-1)?.why, "the request is no longer open");
});

test("after stop nothing new is started or followed", async () => {
  const h = harness();
  h.dispatcher.stop();
  await h.dispatcher.onMessage(message());
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.created, []);
});

test("/new with text does not send the command to the agent", async () => {
  const h = harness({
    readIncoming: async (event, options) => {
      const typed = String(event.content);
      const text = options?.command ? typed.replace(options.command, "").trim() : typed;
      return { prompt: text, images: [], summary: text, problems: [] };
    },
  });
  await h.dispatcher.onMessage(message({ content: "/new 看看这张图" }));
  assert.deepEqual(h.paseo.sends, [{ agentId: String(h.created[0].agentId), text: "看看这张图" }]);
});

const BOT = "ou_bot";
const atBot = { id: BOT, key: "@_user_1", name: "Bot" };

function group(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return message({ chat_type: "group", ...overrides });
}

test("in a group the bot answers an @ to it, and hears the rest as context for it", async () => {
  const h = harness({ botId: async () => BOT });
  await h.dispatcher.onMessage(group({ message_id: "om_a", sender_id: "ou_guest", content: "就是杭州" }));
  await h.dispatcher.onMessage(
    group({
      message_id: "om_b",
      content: "@_user_1 你也去吗",
      mentions: [{ id: "ou_guest", key: "@_user_1", name: "访客" }],
    }),
  );
  assert.equal(h.sent.length, 0);
  assert.equal(h.created.length, 0);
  assert.equal(h.strangers.length, 0);

  await h.dispatcher.onMessage(group({ message_id: "om_c", content: "@_user_1 刚才说去哪", mentions: [atBot] }));
  assert.equal(h.created.length, 1);
  assert.equal(
    h.paseo.sends[0].text,
    "[群里在这之前的消息，没有 @ 你]\n某人：就是杭州\n某人：@访客 你也去吗\n\n刚才说去哪",
  );

  // Heard once: the next @ carries only what was said after this one.
  await h.end(String(h.created[0].agentId), "杭州。");
  await h.dispatcher.onMessage(group({ message_id: "om_d", content: "@_user_1 好的", mentions: [atBot] }));
  assert.equal(h.paseo.sends[1].text, "好的");
});

test("a group with no route stays quiet until the bot is @-ed", async () => {
  const h = harness({ botId: async () => BOT });
  await h.dispatcher.onMessage(group({ chat_id: "oc_other", content: "大家好" }));
  assert.equal(h.sent.length, 0);
  assert.equal(h.strangers.length, 0);
  await h.dispatcher.onMessage(group({ message_id: "om_2", chat_id: "oc_other", content: "@_user_1 在吗", mentions: [atBot] }));
  assert.equal(h.sent.length, 1);
  assert.equal(h.strangers[0].why, "route");
});

test("what a group said hours ago is not handed to the bot", async () => {
  const h = harness({ botId: async () => BOT });
  await h.dispatcher.onMessage(group({ message_id: "om_a", content: "昨天的事" }));
  h.advance(7 * 60 * 60_000);
  await h.dispatcher.onMessage(group({ message_id: "om_b", content: "@_user_1 在吗", mentions: [atBot] }));
  assert.equal(h.paseo.sends[0].text, "在吗");
});

test("not knowing its own ID, the bot takes any @ in a group as meant for it", async () => {
  const h = harness({ botId: async () => null });
  await h.dispatcher.onMessage(group({ message_id: "om_a", content: "随便聊聊" }));
  assert.equal(h.created.length, 0);
  await h.dispatcher.onMessage(group({ message_id: "om_b", content: "@_user_1 在吗", mentions: [atBot] }));
  assert.equal(h.created.length, 1);
  assert.match(h.logs.join("\n"), /open_id is unknown/);
});
