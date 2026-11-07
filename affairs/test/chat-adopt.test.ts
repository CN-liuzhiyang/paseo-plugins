import { createWatch } from "./kit";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createEngine, type PaseoLike } from "../server/engine";
import { type ChatAgent } from "../server/chat";
import { chatPrompt } from "../server/lib/chat.mjs";
import { affairDir, append, load, read } from "../server/lib/log.mjs";
import * as ops from "../server/lib/ops.mjs";
import { world } from "./kit";

async function setup(rootWithSpaces = false, available = false) {
  const w = world();
  if (rootWithSpaces) {
    const root = path.join(w.dir, "root with spaces");
    w.ctx.command = w.ctx.command.replace(w.root, root);
    w.root = w.ctx.root = root;
  }
  const made = await createWatch(w.ctx, { id: "dental", title: "预约", said: "盯一下预约", noWait: true });
  const id = made.id as string;
  const ws = load(w.root, id).workspaceId;
  const agents = new Map<string, ChatAgent>();
  const tails = new Map<string, any[]>();
  const handlers = new Map<string, (e: any) => void>();
  const sent: Array<{ id: string; text: string; options: any }> = [];
  const archived: string[] = [];
  const logs: string[] = [];
  let observer: any;
  let lists = 0, releases = 0, creates = 0;
  let failSend = false;
  const emit = (agent: ChatAgent) => {
    agents.set(agent.id, agent);
    observer?.update({ type: "agent_update", payload: { kind: "upsert", agent } });
  };
  const message = (agent: string, text: string, messageId: string) => {
    const item = { type: "user_message", text, messageId };
    tails.set(agent, [...(tails.get(agent) ?? []), { item }]);
    handlers.get(agent)?.({ event: { type: "timeline", item } });
  };
  const paseo: PaseoLike = {
    agents: {
      list: async (options: any) => {
        if (options.filter) return { entries: [] };
        lists++;
        return { entries: [], subscription: {
          subscribe: (value) => { observer = value; value.snapshot({ entries: [...agents.values()].map((agent) => ({ agent })) }); return () => {}; },
          release: async () => { releases++; observer = null; },
        } };
      },
      ref: (agentId) => ({
        refresh: async () => ({ agent: agents.get(agentId)! }),
        archive: async () => {
          archived.push(agentId);
          emit({ ...agents.get(agentId)!, archivedAt: new Date(w.now()).toISOString() });
        },
        send: async (text, options) => {
          if (failSend) throw new Error("send unavailable");
          assert.ok(load(w.root, id).said.some((s: any) => s.text === "请接着办"), "the existing words reach brief before the instruction");
          sent.push({ id: agentId, text, options });
          message(agentId, text, options.messageId);
        },
        timeline: {
          append: async () => {},
          subscribe: (h) => { handlers.set(agentId, h); return Object.assign(() => { handlers.delete(agentId); }, { ready: Promise.resolve() }); },
          refetch: async () => ({ entries: tails.get(agentId) ?? [] }),
        },
      }),
    },
    workspaces: { ref: () => ({ setTitle: async () => {}, archive: async () => {}, agents: { create: async (options) => {
      const agentId = `made-${++creates}`;
      emit({ id: agentId, workspaceId: ws, createdAt: new Date(w.now()).toISOString(), status: "idle", labels: options.labels as Record<string, string> });
      return { id: agentId };
    } } }) },
  };
  const engine = createEngine({ ctx: w.ctx, paseo, deliver: null, log: (m) => logs.push(m) });
  await engine.scan(id);
  if (!available) agents.get("made-1")!.status = "error";
  w.advance(1000);
  const candidate = (name = "new", over: Partial<ChatAgent> = {}): ChatAgent => ({ id: name, workspaceId: ws, status: "idle", createdAt: new Date(w.now()).toISOString(), labels: {}, ...over });
  const add = (name = "new", over: Partial<ChatAgent> = {}) => { message(name, "请接着办", `person:${name}`); emit(candidate(name, over)); };
  return { w, id, ws, agents, engine, sent, archived, logs, handlers, candidate, add, emit, message,
    remove: (agentId: string) => { agents.delete(agentId);observer?.update({ type: "agent_update", payload: { kind: "remove", agentId } }); },
    failSend: (v: boolean) => { failSend = v; }, counts: () => ({ lists, releases, creates }) };
}

test("a healthy main stays main, including closed and running; archived, failed and missing mains allow adoption", async () => {
  for (const status of ["idle", "closed", "running", "initializing", "archived", "error", "missing"]) {
    const s = await setup(false, true);
    try {
      const old = s.agents.get("made-1")!;
      if (status === "missing") s.remove(old.id);
      else s.emit({ ...old, status: status === "archived" ? "closed" : status, archivedAt: status === "archived" ? "yes" : null });
      s.add();await s.engine.scan(s.id);
      assert.equal(load(s.w.root, s.id).chatId, ["archived", "error", "missing"].includes(status) ? "new" : "made-1", status);
    } finally { await s.engine.stop(); }
  }
});

test("a new ordinary chat is adopted promptly through directory events, hears earlier words, and receives instructions once", async () => {
  const s = await setup(true);
  try {
    s.add();
    await new Promise((r) => setTimeout(r, 400));
    const state = load(s.w.root, s.id);
    assert.equal(state.chatId, "new");
    assert.equal(state.chats.at(-1).why, "adopted");
    assert.equal(s.sent.length, 1);
    const promptFile = path.resolve(affairDir(s.w.root, s.id), "chat-prompt.md");
    assert.equal(readFileSync(promptFile, "utf8"), chatPrompt(s.w.ctx, state));
    assert.equal(s.sent[0].text, `这是事项 dental「预约」的对话。先读 ${promptFile.replaceAll("\\", "/")}，照里面做（它说每次先跑 brief --chat），再回答我刚才说的。`);
    assert.ok(s.sent[0].text.length <= 200, "the visible message stays short");
    assert.doesNotMatch(s.sent[0].text, /affair\.mjs|node |--root|会话|校验|读数|\\|\n/);
    assert.deepEqual(s.sent[0].options, { messageId: "affair-chat:adopted:new", activeTurnBehavior: "steer" });
    assert.deepEqual(s.archived, ["made-1"]);
    s.message("new", "明天再看", "person:after");
    await s.engine.scan(s.id);
    const words = load(s.w.root, s.id).said;
    assert.deepEqual(words.filter((m: any) => m.via === "chat-session").map((m: any) => m.text), ["请接着办", "明天再看"]);
    assert.equal(s.sent.length, 1);
    assert.equal(s.counts().creates, 1);
    assert.equal(s.counts().lists, 1, "subscribed once; no polling or reading unrelated timelines");
    assert.deepEqual(s.logs, []);
  } finally { await s.engine.stop(); }
  assert.equal(s.counts().releases, 1);
});

test("each adoption overwrites the same prompt file with current instructions", async () => {
  const s = await setup();
  try {
    s.add();
    await s.engine.scan(s.id);
    const dir = affairDir(s.w.root, s.id);
    const promptFile = path.join(dir, "chat-prompt.md");
    const before = readFileSync(promptFile, "utf8");
    s.w.ctx.command += " --paseo-home updated";
    s.w.advance(1000);
    s.agents.get("new")!.status = "error";
    s.add("next");
    await s.engine.scan(s.id);
    const current = readFileSync(promptFile, "utf8");
    assert.notEqual(current, before);
    assert.equal(current, chatPrompt(s.w.ctx, load(s.w.root, s.id)));
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("chat-prompt")), ["chat-prompt.md"]);
    await s.engine.scan(s.id);
    assert.equal(s.sent.length, 2);
    assert.equal(readFileSync(promptFile, "utf8"), current);
  } finally { await s.engine.stop(); }
});

test("a prompt file write failure is reported and retried before sending or marking the instruction", async () => {
  const s = await setup();
  try {
    const promptFile = path.join(affairDir(s.w.root, s.id), "chat-prompt.md");
    mkdirSync(promptFile);
    s.add();
    await s.engine.scan(s.id);
    assert.ok(s.logs.some((message) => message.includes("chat-prompt.md")));
    assert.equal(s.sent.length, 0);
    assert.ok(!read(s.w.root, s.id).some((line: any) => line.kind === "chat.prompt"));
    rmdirSync(promptFile);
    await s.engine.scan(s.id);
    assert.equal(s.sent.length, 1);
    assert.equal(readFileSync(promptFile, "utf8"), chatPrompt(s.w.ctx, load(s.w.root, s.id)));
    assert.equal(read(s.w.root, s.id).filter((line: any) => line.kind === "chat.prompt").length, 1);
  } finally { await s.engine.stop(); }
});

test("adoption refuses other workspaces, known chats, labels, children, helpers, errors, archives, and missing or older creation times", async () => {
  const s = await setup();
  try {
    const forbidden: Array<Partial<ChatAgent>> = [
      { workspaceId: "elsewhere" }, { labels: { "affairs.chat": "other" } }, { labels: { "affairs.look": s.id } },
      { labels: { "affairs.affair": s.id, "affairs.role": "dispatched" } },
      { labels: { "paseo.schedule-id": "plan" } }, { parentAgentId: "parent" }, { labels: { "paseo.parent-agent-id": "parent" } },
      { labels: { "orch-run": "run" } }, { labels: { "orch-step": "gate" } }, { labels: { "orch-steward": "all" } },
      { internal: true }, { providerUnavailable: true }, { archivedAt: "2026-01-01" }, { status: "error" }, { status: "unknown" },
      { createdAt: undefined }, { createdAt: "invalid" }, { createdAt: new Date(s.w.now() - 1000).toISOString() }, { createdAt: "2020-01-01" },
    ];
    forbidden.forEach((over, i) => s.add(`refused-${i}`, over));
    s.emit(s.agents.get("made-1")!);
    await s.engine.scan(s.id);
    assert.equal(load(s.w.root, s.id).chatId, "made-1");
    assert.equal(s.sent.length, 0);
    assert.deepEqual(s.archived, []);
    assert.equal(s.handlers.size, 1, "refused timelines are not read");
  } finally { await s.engine.stop(); }
});

test("only the newest of several arriving chats is adopted; older tabs stay untouched", async () => {
  const s = await setup();
  try {
    s.add("unchosen");
    s.w.advance(1000);
    s.add("latest");
    await s.engine.scan(s.id);
    await s.engine.scan(s.id);
    assert.equal(load(s.w.root, s.id).chatId, "latest");
    assert.deepEqual(s.sent.map((m) => m.id), ["latest"]);
    assert.deepEqual(s.archived, ["made-1"]);
    assert.ok(!s.handlers.has("unchosen"));
  } finally { await s.engine.stop(); }
});

test("done and stopped affairs adopt nothing and release their directory subscription", async () => {
  for (const status of ["done", "stopped"]) {
    const s = await setup();
    try {
      append(s.w.root, s.id, [{ kind: "status", status, by: "user", evidence: "不用盯了" }], { now: s.w.now() });
      s.add();
      await s.engine.scan(s.id);
      assert.equal(load(s.w.root, s.id).chatId, "made-1");
      assert.equal(s.sent.length, 0);
      assert.equal(s.counts().releases, 1);
    } finally { await s.engine.stop(); }
  }
});

test("a busy healthy main is kept when an ordinary tab arrives and when the main becomes idle", async () => {
  const s = await setup();
  try {
    s.emit({ ...s.agents.get("made-1")!, status: "running" });
    s.add();
    await s.engine.scan(s.id);
    assert.deepEqual(s.archived, []);
    s.w.advance(6 * 60_000);
    s.emit({ ...s.agents.get("made-1")!, status: "idle", updatedAt: new Date(s.w.now()).toISOString() } as ChatAgent);
    await s.engine.scan(s.id);
    await s.engine.scan(s.id);
    assert.equal(load(s.w.root, s.id).chatId, "made-1");
    assert.deepEqual(s.archived, []);
    assert.equal(s.sent.length, 0);
  } finally { await s.engine.stop(); }
});

test("returning to an old chat does not let an unchosen tab from before that return be adopted", async () => {
  const s = await setup();
  try {
    s.add("unchosen");
    s.w.advance(1000);
    s.add("latest");
    await s.engine.scan(s.id);
    s.w.advance(6 * 60_000);
    s.emit({ ...s.agents.get("made-1")!, status: "idle", archivedAt: null, updatedAt: new Date(s.w.now()).toISOString(), lastUserMessageAt: new Date(s.w.now()).toISOString() } as ChatAgent);
    await s.engine.scan(s.id);
    assert.equal(load(s.w.root, s.id).chatId, "made-1");
    await s.engine.scan(s.id);
    assert.equal(load(s.w.root, s.id).chatId, "made-1");
    assert.equal(s.sent.length, 1);
  } finally { await s.engine.stop(); }
});

test("a failed instruction send is retried from the binding without claiming the instruction as his words", async () => {
  const s = await setup();
  try {
    s.failSend(true);
    s.add();
    await s.engine.scan(s.id);
    assert.equal(load(s.w.root, s.id).chatId, "new");
    assert.ok(s.logs.some((m) => /send unavailable/.test(m)));
    s.failSend(false);
    await s.engine.scan(s.id);
    assert.equal(s.sent.length, 1);
    assert.deepEqual(s.archived, ["made-1"]);
    assert.equal(read(s.w.root, s.id).filter((l: any) => l.kind === "chat" && l.why === "adopted").length, 1);
  } finally { await s.engine.stop(); }
});

test("an idle chat announced before its first message is heard is bound immediately and instructed after the message arrives", async () => {
  const s = await setup();
  try {
    s.emit(s.candidate("starting", { status: "idle" }));
    await s.engine.scan(s.id);
    assert.equal(load(s.w.root, s.id).chatId, "starting");
    assert.equal(s.sent.length, 0, "sending now could replace the first prompt that is still starting");
    s.message("starting", "请接着办", "first:late");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.sent.length, 1);
    assert.ok(read(s.w.root, s.id).some((m: any) => m.kind === "said" && m.msg === "first:late"));
    assert.deepEqual(s.archived, ["made-1"]);
  } finally { await s.engine.stop(); }
});

test("an adopted chat without creation labels is recognized by commands, while a scheduled look stays a look", async () => {
  const s = await setup();
  try {
    s.add();
    await s.engine.scan(s.id);
    process.env.PASEO_AGENT_ID = "new";
    process.env.FAKE_PASEO_LABELS = "{}";
    assert.deepEqual(await ops.callerInfo(s.w.ctx), { by: "chat", chatFor: s.id });
    process.env.FAKE_PASEO_LABELS = JSON.stringify({ "paseo.schedule-id": load(s.w.root, s.id).scheduleId });
    assert.deepEqual(await ops.callerInfo(s.w.ctx), { by: "look", chatFor: "" });
  } finally {
    delete process.env.PASEO_AGENT_ID;
    delete process.env.FAKE_PASEO_LABELS;
    await s.engine.stop();
  }
});
