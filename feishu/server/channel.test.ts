import assert from "node:assert/strict";
import { test } from "node:test";
import type { Settings } from "../shared/settings";
import { createChannel, type ChannelDelivery } from "./channel";

const CHAT = "oc_routed";

const settings: Settings = {
  larkCli: "lark-cli",
  profile: "test",
  senders: [],
  routes: [
    {
      chatId: CHAT,
      name: "",
      cwd: "/work",
      provider: "claude/claude-sonnet-5",
      modeId: "default",
      instructions: "",
      claudeMd: false,
      dailyReset: "",
    },
  ],
  auditDir: "",
};

function delivery(overrides: Partial<ChannelDelivery> = {}): ChannelDelivery {
  return {
    to: CHAT,
    idempotencyKey: "run_1",
    source: { kind: "schedule", scheduleId: "sch_1", scheduleName: "每晚日报", runId: "run_1" },
    status: "succeeded",
    text: "今天比较平静。",
    agentId: "agent_1",
    ...overrides,
  };
}

function harness(values: Settings | null = settings) {
  const sent: Array<{ chatId: string; card: object; key: string }> = [];
  const audits: Array<{ kind: string } & Record<string, unknown>> = [];
  const deliver = createChannel({
    readSettings: async () => values,
    send: async (_settings, chatId, card, key) => {
      sent.push({ chatId, card, key });
      return "om_sent";
    },
    audit: (kind, fields) => audits.push({ kind, ...fields }),
    log: () => {},
  });
  return { deliver, sent, audits };
}

function view(card: object) {
  const typed = card as { header: { title: { content: string }; template: string }; body: { elements: Array<{ content: string }> } };
  return { title: typed.header.title.content, template: typed.header.template, body: typed.body.elements[0].content };
}

test("a finished run is posted to its routed chat as a new card, keyed by the run", async () => {
  const h = harness();
  await h.deliver(delivery());
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].chatId, CHAT);
  assert.equal(h.sent[0].key, "run_1");
  assert.deepEqual(view(h.sent[0].card), { title: "每晚日报", template: "green", body: "今天比较平静。" });
  assert.equal(h.audits[0].kind, "feishu.delivery");
});

test("a failed run tells the chat it did not finish, with the reason", async () => {
  const h = harness();
  await h.deliver(delivery({ status: "failed", text: "agent 在等权限" }));
  const card = view(h.sent[0].card);
  assert.equal(card.title, "每晚日报 · 没能完成");
  assert.equal(card.template, "red");
  assert.match(card.body, /agent 在等权限/);
});

test("a chat without a route is refused, so a schedule cannot post anywhere the bot is", async () => {
  const h = harness();
  await assert.rejects(h.deliver(delivery({ to: "oc_elsewhere" })), /has no route/);
  assert.equal(h.sent.length, 0);
});

test("an unconfigured plugin refuses rather than dropping the result", async () => {
  await assert.rejects(harness({ ...settings, profile: "" }).deliver(delivery()), /not configured/);
  await assert.rejects(harness(null).deliver(delivery()), /settings are invalid/);
});
