import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createEngine, type PaseoLike } from "../server/engine";
import { rotationReason, chatPrompt, noticeFor } from "../server/lib/chat.mjs";
import { append, load, read } from "../server/lib/log.mjs";
import { counts } from "../server/lib/limits.mjs";
import * as ops from "../server/lib/ops.mjs";
import { panelOf, MATERIALS_SHOWN, SOURCES_SHOWN } from "../server/lib/panel.mjs";
import { linkContext } from "../server/lib/links.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { titleOf } from "../server/lib/workspace.mjs";
import { world } from "./kit";

const MIN = 60_000;
const HOUR = 60 * MIN;
const MECHANISM = /叫醒|校验|记录|计划|读数|会话|agent/i;

type Event = Record<string, unknown>;

/** A Paseo with chats in it: what was made, archived, drawn, and the handlers the plugin listens with (called by the test as the session would). */
function paseoWith(opts: { status?: () => string; tail?: () => Array<{ item: unknown }> } = {}) {
  const made: Array<Record<string, any>> = [];
  const archived: string[] = [];
  const drawn: Array<{ chat: string; item: any }> = [];
  const handlers = new Map<string, (e: Event) => void>();
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { status: opts.status?.() ?? "idle" } }),
        archive: async () => void archived.push(id),
        timeline: {
          append: async (item: any) => void drawn.push({ chat: id, item }),
          subscribe: (h: (e: Event) => void) => {
            handlers.set(id, h);
            return Object.assign(() => handlers.delete(id), { ready: Promise.resolve() });
          },
          refetch: async () => ({ entries: opts.tail?.() ?? [] }),
        },
      }),
    },
    workspaces: {
      ref: () => ({
        setTitle: async () => {},
        archive: async () => {},
        agents: { create: async (o: Record<string, any>) => (made.push(o), { id: `chat-${made.length}` }) },
      }),
    },
  } as unknown as PaseoLike;
  const send = (chat: string, event: Event) => handlers.get(chat)!({ agentId: chat, event });
  return { paseo, made, archived, drawn, handlers, send };
}

function setup(policyOver: Record<string, unknown> = {}, opts: Parameters<typeof paseoWith>[0] = {}) {
  const w = world({ policy: { push: { ...DEFAULT_POLICY.push, to: "p2p:me" }, ...policyOver } });
  const p = paseoWith(opts);
  const engine = createEngine({ ctx: w.ctx, paseo: p.paseo, deliver: null, log: () => {}, lookDelaysMs: [0, 0, 0] });
  return { w, p, engine };
}

const start = async (s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) => {
  const made = await ops.create(s.w.ctx, { title: "洗牙", goal: "约上洗牙", said: "帮我盯一下洗牙，今天最好要搞定", noWait: true, ...extra });
  await s.engine.scan(made.id);
  return made.id as string;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const lines = (s: ReturnType<typeof setup>, chat = "chat-1") => s.p.drawn.filter((d) => d.chat === chat);
const textOf = (d: { item: any }) => d.item.data.text as string;
const userMessage = (text: string, messageId = `m-${Math.random()}`) => ({ type: "timeline", item: { type: "user_message", text, messageId } });
const turnDone = (tokens: number, usd = 0.02) => ({ type: "turn_completed", usage: { contextWindowUsedTokens: tokens, totalCostUsd: usd } });

// ---- keeping the chat -------------------------------------------------------------------------------------

test("a new affair's chat has the model of its looks, a long cache, its label and a system prompt that names its commands; no first message", async () => {
  const s = setup();
  const id = await start(s);
  const [o] = s.p.made;
  assert.equal(s.p.made.length, 1);
  assert.equal(o!.config.provider, DEFAULT_POLICY.roles.glance.provider);
  assert.equal(o!.config.thinkingOptionId, "high");
  assert.equal(o!.env.CLAUDE_CODE_PROMPT_CACHE_TTL, "1h");
  assert.equal(o!.env.AFFAIR_ID, id);
  assert.deepEqual(o!.labels, { "affairs.chat": id, "affairs.affair": id });
  assert.equal(o!.prompt, undefined);
  for (const word of ["brief", "note", "--mine", "report", "--from chat", "answer", "history"]) assert.ok(o!.config.systemPrompt.includes(word), word);
  assert.equal(load(s.w.root, id).chatId, "chat-1");
  assert.equal(load(s.w.root, id).chats[0].why, "first");
});

test("an affair from before (with the old conversation): a chat is made, the old one is put away, and the first line says it can be talked to", async () => {
  // as if this affair had been made by the old version: a conversation in the log and no chat
  const t = setup();
  const made = await ops.create(t.w.ctx, { title: "老的", goal: "x", said: "盯一下老的", noWait: true });
  append(t.w.root, made.id, [{ kind: "conversation", agentId: "old-conv" }], { now: t.w.now() });
  await t.engine.scan(made.id);
  assert.equal(t.p.made.length, 1);
  assert.deepEqual(t.p.archived, ["old-conv"]);
  assert.equal(load(t.w.root, made.id).chats[0].why, "migrate");
  assert.match(textOf(lines(t)[0]!), /在这里直接跟我聊/);
});

test("the chat is made once however many scans; one a restart left closed is kept (it wakes where it was); one that failed is replaced and the old put away", async () => {
  let status = "idle";
  const s = setup({}, { status: () => status });
  const id = await start(s);
  await s.engine.scan(id);
  await s.engine.scan(id);
  assert.equal(s.p.made.length, 1);
  status = "closed";
  const restarted = createEngine({ ctx: s.w.ctx, paseo: s.p.paseo, deliver: null, log: () => {} });
  await restarted.scan(id);
  assert.equal(s.p.made.length, 1, "closed after a restart: kept");
  assert.ok(s.p.handlers.has("chat-1"), "and listened to");
  await restarted.stop();
  status = "error";
  const again = createEngine({ ctx: s.w.ctx, paseo: s.p.paseo, deliver: null, log: () => {} });
  await again.scan(id);
  await again.scan(id);
  assert.equal(s.p.made.length, 2);
  assert.deepEqual(s.p.archived, ["chat-1"]);
  assert.equal(load(s.w.root, id).chatId, "chat-2");
  await again.stop();
});

// ---- when it is replaced -----------------------------------------------------------------------------------

function chatAt(tokens: number, idleMs: number, over: Record<string, unknown> = {}) {
  const w = world({ policy: over });
  const now = w.now();
  const s = {
    chatId: "c",
    chatTurn: { at: new Date(now - idleMs).toISOString(), tokens, usd: 0 },
    said: [] as Array<{ via: string; at: string }>,
    chats: [{ agentId: "c", at: new Date(now - 30 * HOUR).toISOString(), seq: 1, why: "first" }],
  };
  return { w, s, now, policy: w.ctx.policy };
}

test("warm, however long, is not replaced until it is very long and idle; cold and long is; cold and short is not", () => {
  let c = chatAt(120_000, 5 * MIN);
  assert.equal(rotationReason(c.s, c.now, c.policy), "", "warm and 120k: kept");
  c = chatAt(160_000, 5 * MIN);
  assert.equal(rotationReason(c.s, c.now, c.policy), "", "very long but he was here five minutes ago: kept");
  c = chatAt(160_000, 11 * MIN);
  assert.equal(rotationReason(c.s, c.now, c.policy), "rotate:long");
  c = chatAt(90_000, 31 * MIN);
  assert.equal(rotationReason(c.s, c.now, c.policy), "rotate:cold");
  c = chatAt(60_000, 31 * MIN);
  assert.equal(rotationReason(c.s, c.now, c.policy), "", "cold but short: cheap to go on");
});

test("never while he is typing, and not more than twice a day; unknown length is left alone", () => {
  // (with no wait required, so that it is the typing that holds it back)
  const c = chatAt(200_000, 11 * MIN, { chat: { ...DEFAULT_POLICY.chat, idleMinutes: 0 } });
  c.s.said.push({ via: "chat-session", at: new Date(c.now - 60_000).toISOString() });
  assert.equal(rotationReason(c.s, c.now, c.policy), "", "he spoke a minute ago");
  const d = chatAt(200_000, 60 * MIN);
  d.s.chats.push({ agentId: "x", at: new Date(d.now - 50 * MIN).toISOString(), seq: 2, why: "rotate:cold" }, { agentId: "y", at: new Date(d.now - 45 * MIN).toISOString(), seq: 3, why: "rotate:long" });
  d.s.chatTurn.at = new Date(d.now - 60 * MIN).toISOString();
  assert.equal(rotationReason(d.s, d.now, d.policy), "", "two today already");
  const e = chatAt(200_000, 60 * MIN);
  (e.s as { chatTurn: unknown }).chatTurn = null;
  assert.equal(rotationReason(e.s, e.now, e.policy), "");
});

test("overnight: after 4 o'clock a chat from before it, quiet for six hours and long enough, is replaced; a short one is not", () => {
  const w = world();
  const morning = Date.parse("2026-11-03T07:00:00+08:00");
  const last = Date.parse("2026-11-02T23:00:00+08:00");
  const mk = (tokens: number) => ({
    chatId: "c",
    chatTurn: { at: new Date(last).toISOString(), tokens, usd: 0 },
    said: [],
    chats: [{ agentId: "c", at: new Date(last - 5 * HOUR).toISOString(), seq: 1, why: "first" }],
  });
  assert.equal(rotationReason(mk(55_000), morning, w.ctx.policy), "rotate:night");
  assert.equal(rotationReason(mk(40_000), morning, w.ctx.policy), "");
  assert.equal(rotationReason(mk(55_000), Date.parse("2026-11-03T03:00:00+08:00"), w.ctx.policy), "", "before 4 it is still the night before");
});

test("a replaced chat: a new one is made, the old put away, the new one starts with a line that says where the points are", async () => {
  const s = setup();
  const id = await start(s);
  const chat = s.p.send;
  await s.engine.scan(id);
  chat("chat-1", turnDone(170_000));
  s.w.advance(40 * MIN);
  await s.engine.scan(id);
  assert.equal(s.p.made.length, 2);
  assert.deepEqual(s.p.archived, ["chat-1"]);
  assert.equal(load(s.w.root, id).chats[1].why, "rotate:long");
  assert.match(textOf(lines(s, "chat-2")[0]!), /^接着聊/);
  assert.doesNotMatch(textOf(lines(s, "chat-2")[0]!), MECHANISM);
  // and the new one is the one listened to
  assert.ok(s.p.handlers.has("chat-2"));
  assert.ok(!s.p.handlers.has("chat-1"));
});

// ---- what he types ----------------------------------------------------------------------------------------

test("what he types in the chat is his word in the log, once, and calls for no look; what the plugin drew and what another session sent are not his", async () => {
  const s = setup();
  const id = await start(s);
  const before = read(s.w.root, id).length;
  s.p.send("chat-1", userMessage("靠复制拿它的分支是啥意思呀？", "m1"));
  s.p.send("chat-1", userMessage("靠复制拿它的分支是啥意思呀？", "m1"));
  s.p.send("chat-1", { type: "timeline", item: { type: "plugin", id: "row-x", kind: "affair-line", data: { text: "我自己画的" } } });
  s.p.send("chat-1", { type: "timeline", item: { type: "tool_call", name: "agent_message", callId: "k1", detail: { text: "别的会话说的话" } } });
  await settle();
  const added = read(s.w.root, id).slice(before).filter((l: { kind: string }) => l.kind === "said");
  assert.equal(added.length, 2);
  assert.deepEqual([added[0].via, added[0].by, added[0].text], ["chat-session", "user", "靠复制拿它的分支是啥意思呀？"]);
  assert.deepEqual([added[1].via, added[1].by], ["chat-agent", "look"], "another session's words are put down as what they are");
  const state = load(s.w.root, id);
  assert.ok(!state.pending.some((p: string) => p === `said:${added[0].seq}`), "no look is called for what he said in the chat");
  assert.ok(!state.pending.some((p: string) => p === `said:${added[1].seq}`));
  const shown = (await import("../server/lib/view.mjs")).rowsOf({ ...state, lines: read(s.w.root, id) }, s.w.now(), s.w.ctx.policy);
  assert.ok(!shown.some((r: { text: string }) => r.text.includes("靠复制拿")), "and it is not drawn back at him: it is already on his screen");
});

test("what was typed while nobody listened (the plugin was restarted) is read from the end of the chat, and not counted twice", async () => {
  let tail: Array<{ item: unknown }> = [];
  const s = setup({}, { tail: () => tail });
  const id = await start(s);
  s.p.send("chat-1", userMessage("第一句", "m1"));
  await settle();
  tail = [{ item: { type: "user_message", text: "第一句", messageId: "m1" } }, { item: { type: "user_message", text: "第二句，插件没在听", messageId: "m2" } }];
  const again = createEngine({ ctx: s.w.ctx, paseo: s.p.paseo, deliver: null, log: () => {} });
  await again.scan(id);
  await settle();
  const said = read(s.w.root, id).filter((l: { kind: string; via?: string }) => l.kind === "said" && l.via === "chat-session").map((l: { text: string }) => l.text);
  assert.deepEqual(said, ["第一句", "第二句，插件没在听"]);
  await again.stop();
});

test("a finished turn writes how long the chat is and what the turn cost; the day's money counts it", async () => {
  const s = setup();
  const id = await start(s);
  s.p.send("chat-1", turnDone(61_000, 0.05));
  const t = load(s.w.root, id).chatTurn;
  assert.deepEqual([t.tokens, t.usd], [61_000, 0.05]);
  const day = counts(s.w.root, s.w.now(), s.w.ctx.policy).total.usd;
  assert.ok(day >= 0.05);
});

// ---- what is drawn into the chat -------------------------------------------------------------------------------

async function askOne(s: ReturnType<typeof setup>, id: string) {
  await ops.brief(s.w.ctx, id);
  const r = await ops.report(s.w.ctx, id, { status: "还没约", entry: "我看了一眼：还没约。", facts: [], next: { at: "2026-11-03 09:30", waitingFor: "等你去约", why: "他说今天搞定", earlyIf: [] }, ask: { title: "洗牙约上了吗？", line: "约上了告诉我哪天", options: ["约好了", "还没约", "不用盯了"] } });
  assert.equal(r.ok, true, r.text);
  await s.engine.runEnded({ to: id, status: "succeeded", text: "ok", agentId: "a1" });
}

test("a question is drawn once as a card with its buttons; answered, the same place becomes the line of his answer", async () => {
  const s = setup();
  const id = await start(s);
  await askOne(s, id);
  await s.engine.scan(id);
  const card = lines(s).filter((d) => d.item.kind === "affair-ask");
  assert.equal(card.length, 1, "drawn once");
  assert.deepEqual(card[0]!.item.data.options, ["约好了", "还没约", "不用盯了"]);
  assert.equal(card[0]!.item.data.affair, id);
  await s.engine.answered(id, `${id}-1`, "约好了");
  await s.engine.scan(id);
  const after = lines(s).filter((d) => d.item.id === card[0]!.item.id);
  assert.equal(after.length, 2, "the same id again");
  assert.equal(after[1]!.item.kind, "affair-line");
  assert.match(textOf(after[1]!), /你：约好了/);
  assert.equal(load(s.w.root, id).asks[0].via, "panel");
});

test("the look's result is a line in the chat; a line is drawn once; the title says he is needed", async () => {
  const s = setup();
  const id = await start(s);
  await askOne(s, id);
  await s.engine.scan(id);
  await s.engine.scan(id);
  const row = lines(s).filter((d) => d.item.kind === "affair-line" && /我看了一眼/.test(textOf(d)));
  assert.equal(row.length, 1);
  assert.match(titleOf(load(s.w.root, id), s.w.now(), s.w.ctx.policy), /^洗牙 · 要你定$/);
});

test("after a restart the chat is drawn again with the open question and the latest few lines, and no more", async () => {
  const s = setup();
  const id = await start(s);
  for (let i = 0; i < 5; i++) {
    await ops.note(s.w.ctx, id, { said: `第${i}句`, via: "popo" });
  }
  await askOne(s, id);
  await s.engine.scan(id);
  const first = lines(s).length;
  const again = createEngine({ ctx: s.w.ctx, paseo: s.p.paseo, deliver: null, log: () => {} });
  await again.scan(id);
  const redrawn = lines(s).slice(first);
  assert.ok(redrawn.some((d) => d.item.kind === "affair-ask"), "the question that is still open");
  assert.equal(redrawn.filter((d) => d.item.kind === "affair-line").length, DEFAULT_POLICY.chat.redraw, "and only the latest lines");
  await again.stop();
});

test("a question taken back is turned into a line that says it need not be answered", async () => {
  const s = setup();
  const id = await start(s);
  await askOne(s, id);
  await s.engine.scan(id);
  append(s.w.root, id, [{ kind: "ask.drop", id: `${id}-1` }], { now: s.w.now() });
  await s.engine.scan(id);
  const last = lines(s).at(-1)!;
  assert.equal(last.item.kind, "affair-line");
  assert.match(textOf(last), /不用答/);
});

// ---- the panel -----------------------------------------------------------------------------------------------------

test("the panel's sources: the affair's own link first, what is watched, references in what is remembered, once each; at most six and how many more", async () => {
  const w = world({ policy: { links: { gcp: "https://pm.example.invalid/issues/{ref}" }, linkHash: "gcp" } });
  const made = await ops.create(w.ctx, { title: "闪退 #987735", goal: "盯 #987735", said: "盯一下 #987735", link: "gcp:987735", noWait: true });
  const id = made.id as string;
  await ops.brief(w.ctx, id);
  const facts = Array.from({ length: 8 }, (_, i) => `提交 #${100001 + i} 已合并`);
  const r = await ops.report(w.ctx, id, { status: "等发布", entry: "我看了一眼：等发布。", facts: [...facts, "还是 #987735"], next: { at: "2026-11-03 09:30", waitingFor: "等发布", why: "他说明早", earlyIf: [] } });
  assert.equal(r.ok, true, r.text);
  const s = { ...load(w.root, id), lines: read(w.root, id) };
  const p = panelOf(w.root, s, w.now(), w.ctx.policy, linkContext(w.ctx.policy, s.link));
  assert.equal(p.sources.items.length, SOURCES_SHOWN);
  assert.equal(p.sources.items[0].label, "易协作 #987735");
  assert.equal(p.sources.items[0].href, "https://pm.example.invalid/issues/987735");
  assert.equal(p.sources.items.filter((i: { href: string }) => i.href?.endsWith("/987735")).length, 1, "the main ticket is not listed twice");
  assert.ok(p.sources.more >= 1);
  const plain = world({ policy: { links: {}, linkHash: "" } });
  const m2 = await ops.create(plain.ctx, { title: "洗牙", goal: "x", said: "盯", link: "gcp:555", noWait: true });
  const s2 = { ...load(plain.root, m2.id), lines: read(plain.root, m2.id) };
  const p2 = panelOf(plain.root, s2, plain.now(), plain.ctx.policy, linkContext(plain.ctx.policy, s2.link));
  assert.equal(p2.sources.items[0].href, null, "a kind with no address is listed and cannot be opened");
});

test("the panel's materials are what is in files/ and only that: his chat pictures are not there; what came to files/ from him is marked", async () => {
  const w = world();
  const made = await ops.create(w.ctx, { title: "牙", goal: "x", said: "盯", noWait: true });
  const id = made.id as string;
  let s = { ...load(w.root, id), lines: read(w.root, id) };
  assert.deepEqual(panelOf(w.root, s, w.now(), w.ctx.policy, linkContext(w.ctx.policy, null)).materials, { items: [], more: 0 });
  const dir = path.join(w.root, id, "files");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < MATERIALS_SHOWN + 2; i++) writeFileSync(path.join(dir, `整理-${i}.md`), "x");
  mkdirSync(path.join(dir, "子目录"), { recursive: true });
  const r = await ops.note(w.ctx, id, { said: "发个图", attachments: [{ type: "image", data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64").toString("base64"), mimeType: "image/png", name: "sms.png" }] });
  assert.equal(r.ok, true, r.text);
  s = { ...load(w.root, id), lines: read(w.root, id) };
  const m = panelOf(w.root, s, w.now(), w.ctx.policy, linkContext(w.ctx.policy, null)).materials;
  assert.equal(m.items.length, MATERIALS_SHOWN);
  assert.equal(m.more, 3, "a folder is not a thing in the list");
  const all = panelOf(w.root, s, w.now(), w.ctx.policy, linkContext(w.ctx.policy, null)).materials.items;
  assert.ok(all.every((i: { who: string }) => ["整理的", "你发的"].includes(i.who)));
});

test("nothing a person reads in the panel, the chat's lines or the first line of a chat names the machinery", async () => {
  const s = setup();
  const id = await start(s);
  await askOne(s, id);
  await ops.note(s.w.ctx, id, { said: "改成下周一", via: "popo" });
  await s.engine.scan(id);
  const p = s.engine.panel(load(s.w.root, id).workspaceId)!;
  const texts = [p.title, p.waiting.text, p.now.text, p.next.text, ...p.recent.map((r: { text: string }) => r.text), ...p.facts.map((f: { text: string }) => f.text), ...p.asks.flatMap((a: { title: string; line: string; options: string[] }) => [a.title, a.line, ...a.options]), ...p.sources.items.map((i: { label: string; status?: string }) => `${i.label} ${i.status ?? ""}`), "现在", "来源", "资料", "还没有", "这里不是事项。"];
  for (const t of texts) assert.doesNotMatch(t, MECHANISM, t);
  for (const why of ["first", "migrate", "rotate:cold", "rotate:long", "rotate:night"]) assert.doesNotMatch(noticeFor(why, "洗牙"), MECHANISM, why);
  for (const d of lines(s)) assert.doesNotMatch(JSON.stringify(d.item.data), MECHANISM, JSON.stringify(d.item.data));
  assert.equal(s.engine.panel("wks_nobody"), null, "a workspace that is not an affair's has no panel");
  assert.ok(s.engine.affairs().some((a: { id: string }) => a.id === id));
});

test("the prompt a chat is made with lets it know its affair and where the handbooks are, and says nothing that is not true", async () => {
  const s = setup();
  const id = await start(s);
  const text = chatPrompt(s.w.ctx, load(s.w.root, id));
  assert.match(text, new RegExp(`事项 ${id}`));
  assert.match(text, /note .*--mine/);
  assert.match(text, /别抄密码/, "pictures: only the points, as words, and nothing secret");
});
