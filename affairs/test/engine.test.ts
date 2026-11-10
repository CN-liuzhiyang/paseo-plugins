import { createWatch } from "./kit";
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { append, load, logFile, read } from "../server/lib/log.mjs";
import * as ops from "../server/lib/ops.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { createEngine, idOfWatch, type Deliver } from "../server/engine";
import { titleOf } from "../server/lib/workspace.mjs";
import { emptyDirectory, iso, world } from "./kit";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup(policyOver: Record<string, unknown> = {}) {
  const w = world({ policy: { push: { ...DEFAULT_POLICY.push, to: "p2p:me" }, ...policyOver } });
  const calls = { woken: [] as string[], created: [] as Array<Record<string, unknown>>, titles: [] as string[], archived: 0, appended: [] as Array<{ chat: string; item: any }>, subscribed: [] as Array<{ chat: string; handler: (e: any) => void }>, pushed: [] as Array<{ text: string; key: string }> };
  const tail: { entries: Array<{ item: any }> } = { entries: [] };
  const status = { value: "idle" };
  const paseo = {
    agents: {
      list: emptyDirectory,
      ref: (id: string) => ({
        send: async () => {}, refresh: async () => ({ agent: { status: status.value } }),
        archive: async () => void calls.woken.push(id),
        timeline: {
          append: async (item: any) => void calls.appended.push({ chat: id, item }),
          subscribe: (handler: (e: any) => void) => {
            calls.subscribed.push({ chat: id, handler });
            return Object.assign(() => {}, { ready: Promise.resolve() });
          },
          refetch: async () => tail,
        },
      }),
    },
    workspaces: {
      ref: () => ({
        setTitle: async (t: string | null) => void calls.titles.push(String(t)),
        archive: async () => void (calls.archived += 1),
        agents: { create: async (o: Record<string, unknown>) => (calls.created.push(o), { id: `agent-${calls.created.length}` }) },
      }),
    },
  };
  const state = { deliverFails: false };
  const logs: string[] = [];
  const deliver: Deliver = async (_channel, m) => {
    if (state.deliverFails) throw new Error("popo down");
    calls.pushed.push({ text: m.text, key: m.idempotencyKey });
  };
  const engine = createEngine({ ctx: w.ctx, paseo, deliver, log: (message) => void logs.push(message), lookDelaysMs: [0, 0, 0] });
  return { w, calls, engine, state, status, tail, logs };
}

const start = async (s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) => {
  const made = await createWatch(s.w.ctx, { id: "dental", title: "洗牙", goal: "约上洗牙", said: "帮我盯一下洗牙", noWait: true, ...extra });
  await s.engine.scan(made.id);
  return made.id as string;
};

/** A look that reports; `end` is the run being delivered (which also draws and pushes), left off to draw later. */
const report = async (s: ReturnType<typeof setup>, id: string, over: Record<string, unknown> = {}, end = true) => {
  await ops.brief(s.w.ctx, id);
  const r = await ops.report(s.w.ctx, id, { status: "还没约", entry: "还没约。", facts: [], next: { at: "2026-11-03 09:30", waitingFor: "等你去约", why: "他说今天搞定", earlyIf: [] }, ...over });
  assert.equal(r.ok, true, r.text);
  if (end) await s.engine.runEnded({ to: id, status: "succeeded", text: "ok", agentId: "a1" });
};

test("a new affair gets one chat in its workspace: its id and a long cache in the environment, its label, no first message; once", async () => {
  const s = setup();
  const id = await start(s);
  await s.engine.scan(id);
  assert.equal(s.calls.created.length, 1);
  const made = s.calls.created[0] as { env: Record<string, string>; labels: Record<string, string>; prompt?: string; config: { provider: string; systemPrompt: string } };
  assert.deepEqual(made.env, { AFFAIR_ID: id, CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" });
  assert.equal(made.labels["affairs.chat"], id);
  assert.equal(made.prompt, undefined, "an empty chat costs nothing until he speaks");
  assert.match(made.config.systemPrompt, new RegExp(`brief ${id} --chat`));
  assert.equal(load(s.w.root, id).chatId, "agent-1");
  assert.equal(s.calls.subscribed.length, 1, "and it is listened to, once");
  const lines = s.calls.appended.filter((a) => a.chat === "agent-1").map((a) => a.item.data.text);
  assert.ok(lines.some((t: string) => t.startsWith("开始盯「洗牙」")), "it starts with a line that says what was started");
});

test("the sidebar title follows the log: a day when the next look is days away, ✓ when it ended", async () => {
  const s = setup();
  const id = await start(s);
  await report(s, id, { next: { at: "2026-11-12 09:00", waitingFor: "2月2日再看", why: "他说三个月后", earlyIf: [] } });
  await s.engine.scan(id);
  assert.equal(s.calls.titles.at(-1), "洗牙 · 11月12日");
  await ops.stop(s.w.ctx, id);
  await s.engine.scan(id);
  assert.equal(s.calls.titles.at(-1), "✓ 洗牙");
  const n = s.calls.titles.length;
  await s.engine.scan(id);
  assert.equal(s.calls.titles.length, n, "the title is set when it changes, not on every scan");
});

const labelCalls = (s: ReturnType<typeof setup>) => s.w.calls().filter((c) => c[0] === "workspace" && c[1] === "label");
const editPaseo = (s: ReturnType<typeof setup>, edit: (db: any) => void) => {
  const db = s.w.paseo();
  edit(db);
  writeFileSync(path.join(s.w.dir, "paseo.json"), JSON.stringify(db));
};

test("workspace labels follow the log: new, done, reopened and stopped; personal labels stay", async () => {
  const s = setup();
  const id = await start(s);
  const workspaceId = load(s.w.root, id).workspaceId;
  const labels = () => s.w.paseo().workspaces[0].labels;
  assert.deepEqual(labels(), ["事项"]);
  assert.deepEqual(labelCalls(s), [
    ["workspace", "label", workspaceId, "事项", "--color", "sky", "--json"],
    ["workspace", "label", workspaceId, "事项·办完", "--remove", "--json"],
  ]);
  editPaseo(s, (db) => db.workspaces[0].labels.push("my-label"));
  await ops.stop(s.w.ctx, id, { done: true, evidence: "办完了" });
  await s.engine.scan(id);
  assert.deepEqual(labels(), ["my-label", "事项·办完"]);
  assert.deepEqual(labelCalls(s)[2], ["workspace", "label", workspaceId, "事项·办完", "--color", "emerald", "--json"]);
  await ops.resume(s.w.ctx, id);
  await s.engine.scan(id);
  assert.deepEqual(labels(), ["my-label", "事项"]);
  await ops.stop(s.w.ctx, id);
  await s.engine.scan(id);
  assert.deepEqual(labels(), ["my-label", "事项·办完"]);
  const before = labelCalls(s).length;
  await s.engine.scan(id);
  assert.equal(labelCalls(s).length, before, "already aligned: no more CLI calls");
  assert.equal(load(s.w.root, id).labelShown, "事项·办完");
  assert.deepEqual(read(s.w.root, id).filter((l) => l.kind === "workspace" && l.label).map((l) => l.label), ["事项", "事项·办完", "事项", "事项·办完"]);
  const restarted = createEngine({ ctx: s.w.ctx, paseo: null, deliver: null, log: () => {} });
  await restarted.scan(id);
  assert.equal(labelCalls(s).length, before, "shown value survives an engine restart");
});

test("old affairs get their workspace label on the first scan, even if the title already agrees", async () => {
  for (const done of [false, true]) {
    const s = setup();
    const made = await createWatch(s.w.ctx, { id: "old-affair", title: "旧事项", noWait: true });
    if (done) {
      await ops.stop(s.w.ctx, made.id, { done: true });
      append(s.w.root, made.id, [{ kind: "workspace", title: "✓ 旧事项" }], { now: s.w.now() });
    }
    editPaseo(s, (db) => { db.workspaces[0].labels = ["my-label", done ? "事项" : "事项·办完"]; });
    assert.equal(load(s.w.root, made.id).labelShown, "");
    await s.engine.scan(made.id);
    assert.deepEqual(s.w.paseo().workspaces[0].labels, ["my-label", done ? "事项·办完" : "事项"]);
    assert.equal(s.calls.titles.length, 0);
  }
});

test("an old CLI is tried only once across concurrent scans; titles and chats still follow the log", async () => {
  const s = setup();
  const made = await createWatch(s.w.ctx, { id: "old-cli", title: "旧版本", noWait: true });
  await createWatch(s.w.ctx, { id: "other-affair", title: "另一件事", noWait: true });
  editPaseo(s, (db) => { db.labelsUnsupported = true; });
  await s.engine.scanAll();
  await ops.stop(s.w.ctx, made.id);
  await s.engine.scanAll();
  assert.equal(labelCalls(s).length, 1);
  assert.equal(s.logs.filter((l) => l === "工作区标签：要新版 Paseo（workspace label）").length, 1);
  assert.equal(s.calls.titles.at(-1), "✓ 旧版本");
  assert.equal(s.calls.created.length, 2, "both chats are created despite the old CLI");
  assert.equal(load(s.w.root, made.id).labelShown, "");
});

test("other label errors surface and are retried without recording a successful alignment", async () => {
  const s = setup();
  const made = await createWatch(s.w.ctx, { id: "label-error", title: "出错", noWait: true });
  editPaseo(s, (db) => { db.labelsError = "connection lost"; });
  await s.engine.scan(made.id);
  assert.ok(s.logs.some((l) => /connection lost/.test(l)));
  assert.equal(load(s.w.root, made.id).labelShown, "");
  editPaseo(s, (db) => { delete db.labelsError; });
  await s.engine.scan(made.id);
  assert.deepEqual(s.w.paseo().workspaces[0].labels, ["事项"]);
  assert.equal(load(s.w.root, made.id).labelShown, "事项");
  assert.equal(labelCalls(s).length, 3);
});

test("archived affairs and affairs without a workspace are skipped; a replacement workspace gets labeled", async () => {
  const s = setup();
  const id = await start(s);
  const before = labelCalls(s).length;
  append(s.w.root, id, [{ kind: "workspace", archived: true }], { now: s.w.now() });
  await s.engine.scan(id);
  assert.equal(labelCalls(s).length, before);
  // Restoring a workspace must not reuse the shown value from the archived one.
  await ops.resume(s.w.ctx, id);
  await s.engine.scan(id);
  assert.deepEqual(s.w.paseo().workspaces[1].labels, ["事项"]);
  assert.equal(labelCalls(s).length, before + 2);
});

test("an ended affair keeps its workspace and panel, including after three days and when resumed", async () => {
  const s = setup();
  const quiet = await start(s);
  await createWatch(s.w.ctx, { id: "other-2", title: "牙冠", noWait: true });
  await s.engine.scanAll();
  s.w.advance(40 * DAY);
  await s.engine.scanAll();
  assert.equal(s.calls.archived, 0, "watching is never archived, however long it has been");
  await ops.stop(s.w.ctx, quiet);
  s.w.advance(2 * DAY);
  await s.engine.scan(quiet);
  assert.equal(s.calls.archived, 0, "not yet three days");
  await ops.resume(s.w.ctx, quiet);
  s.w.advance(2 * DAY);
  await s.engine.scan(quiet);
  assert.equal(s.calls.archived, 0, "taken up again inside the three days");
  await ops.stop(s.w.ctx, quiet);
  s.w.advance(3 * DAY + HOUR);
  await s.engine.scan(quiet);
  assert.equal(s.calls.archived, 0);
  assert.equal(load(s.w.root, quiet).archived, false);
  assert.equal(s.engine.panel(load(s.w.root, quiet).workspaceId)!.mood, "stopped");
  const again = await ops.resume(s.w.ctx, quiet);
  assert.equal(again.ok, true, again.text);
  assert.equal(load(s.w.root, quiet).status, "watching");
  assert.equal(s.w.paseo().workspaces.length, 2, "the original workspace stays available");
});

test("a question is pushed once, with its number; answered before the push it is not pushed at all", async () => {
  const s = setup();
  const id = await start(s);
  await report(s, id, { ask: { title: "洗牙约上了吗？", line: "约上了告诉我哪天", options: ["约好了", "还没约", "不用盯了"] } });
  await s.engine.scan(id);
  await s.engine.scan(id);
  assert.equal(s.calls.pushed.length, 1);
  assert.match(s.calls.pushed[0]!.text, /洗牙约上了吗？[\s\S]*1 约好了 {2}2 还没约 {2}3 不用盯了[\s\S]*（dental）/);
  const second = await createWatch(s.w.ctx, { id: "other-3", title: "体检", noWait: true });
  await report(s, second.id, { ask: { title: "体检约了吗？", options: ["约了"] } }, false);
  await ops.answer(s.w.ctx, second.id, `${second.id}-1`, "约了");
  await s.engine.scan(second.id);
  assert.equal(s.calls.pushed.length, 1, "already answered in the app: nothing to push");
});

test("at most five pushes a day; the rest wait for the next day", async () => {
  const s = setup();
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    const made = await createWatch(s.w.ctx, { id: `thing-${i}`, title: `事${i}`, noWait: true });
    ids.push(made.id);
  }
  for (const id of ids) {
    await report(s, id, { ask: { title: `${id} 要你定`, options: ["好"] } });
    await s.engine.scan(id);
    s.w.advance(11 * 60_000);
  }
  assert.equal(s.calls.pushed.length, 5);
  s.w.advance(DAY);
  await s.engine.scanAll();
  assert.equal(s.calls.pushed.length, 7, "the next day the two that waited go out");
});

test("a private matter is not pushed at night; it goes out at eight", async () => {
  const s = setup();
  const id = await start(s, { domain: "personal" });
  await report(s, id, { ask: { title: "洗牙约上了吗？", options: ["约好了"] } }, false);
  s.w.at(iso("2026-11-02 23:30"));
  await s.engine.scan(id);
  assert.equal(s.calls.pushed.length, 0);
  s.w.at(iso("2026-11-03 08:05"));
  await s.engine.scan(id);
  assert.equal(s.calls.pushed.length, 1);
});

test("a push that fails is written down once and not tried on every scan", async () => {
  const s = setup();
  const id = await start(s);
  await report(s, id, { ask: { title: "洗牙约上了吗？", options: ["约好了"] } });
  s.state.deliverFails = true;
  await s.engine.scan(id);
  await s.engine.scan(id);
  assert.equal(read(s.w.root, id).filter((l) => l.kind === "push").length, 1);
});

test("finished by the look: one push that says what shows it and how to take it back; stopped by the person: none", async () => {
  const s = setup();
  const id = await start(s);
  await ops.note(s.w.ctx, id, { said: "约好了，下周三" });
  await ops.brief(s.w.ctx, id);
  await ops.report(s.w.ctx, id, { entry: "办完了。", finish: { kind: "done", summary: "飞书任务 11-11 勾掉了", evidence: { quote: "约好了，下周三", from: `said:${load(s.w.root, id).said.at(-1).seq}` } } });
  await s.engine.scan(id);
  assert.equal(s.calls.pushed.length, 1);
  assert.match(s.calls.pushed[0]!.text, /洗牙办完了 ✓ 飞书任务 11-11 勾掉了。不对就回「还没完」/);
  const other = await createWatch(s.w.ctx, { id: "other-5", title: "体检", noWait: true });
  await ops.stop(s.w.ctx, other.id);
  await s.engine.scan(other.id);
  assert.equal(s.calls.pushed.length, 1);
});

test("a run that ends: noted; what came in meanwhile is looked at again; three that never reported ask for help", async () => {
  const s = setup();
  const id = await start(s);
  await ops.brief(s.w.ctx, id);
  await ops.note(s.w.ctx, id, { said: "改成下周一看", by: "user" });
  const before = s.w.calls().filter((c) => c[1] === "run-once").length;
  await s.engine.runEnded({ to: id, status: "succeeded", text: "ok", agentId: "a" });
  await s.engine.settle();
  assert.equal(s.w.calls().filter((c) => c[1] === "run-once").length, before + 1, "said while it ran: one more look");
  for (let i = 0; i < 2; i++) {
    s.w.advance(HOUR);
    await ops.brief(s.w.ctx, id);
    await s.engine.runEnded({ to: id, status: "failed", text: "崩溃库连不上", agentId: "a" });
  }
  const ask = load(s.w.root, id).asks.find((a: { title: string }) => a.title.endsWith("没看成"));
  assert.ok(ask, "three looks without a report");
  assert.deepEqual(ask.options, ["好了", "不用盯了"]);
});

test("at start, a look that came due while nothing ran is made once; a plan that disagrees is put right", async () => {
  const s = setup();
  const id = await start(s);
  await report(s, id);
  s.w.advance(3 * DAY);
  const before = s.w.calls().filter((c) => c[1] === "run-once").length;
  await s.engine.start();
  await s.engine.stop();
  assert.equal(s.w.calls().filter((c) => c[1] === "run-once").length, before + 1);
  await createAgain(s, id);
  assert.equal(s.w.calls().filter((c) => c[1] === "run-once").length, before + 1, "not again for the same missed time once it ran");
});

async function createAgain(s: ReturnType<typeof setup>, id: string) {
  append(s.w.root, id, [{ kind: "wake", why: ["catchup"], gapMinutes: 0 }], { now: s.w.now() });
  const e2 = createEngine({ ctx: s.w.ctx, paseo: null, deliver: null, log: () => {} });
  await e2.start();
  await e2.stop();
}

test("the panel is drawn from the log, and says when the day's looks are used up", async () => {
  const s = setup();
  const id = await start(s);
  await report(s, id);
  const ws = load(s.w.root, id).workspaceId;
  const p = s.engine.panel(ws)!;
  assert.equal(p.waiting.text, "等你去约");
  assert.match(p.next.text, /^明天 9:30 看$/);
  s.w.advance(10 * 60_000);
  await ops.brief(s.w.ctx, id);
  assert.equal(s.engine.panel(ws)!.next.text, "正在看一眼…", "while a look is on, the panel does not show the fallback time as if it were the plan");
  append(s.w.root, id, [{ kind: "wake.end", state: "ok", usd: 0 }], { now: s.w.now() });
  // The looks the schedule starts count as much as any: the day runs out, and the card says the number that really was.
  for (let i = 0; i < 8; i++) {
    s.w.advance(10 * 60_000);
    const b = await ops.brief(s.w.ctx, id);
    if (b.ok) await ops.report(s.w.ctx, id, { status: `x${i}`, entry: "还没变", facts: [], next: { at: "2026-11-03 09:30", waitingFor: "等你去约", why: "他说今天搞定", earlyIf: [] } });
    append(s.w.root, id, [{ kind: "wake.end", state: "ok", usd: 0 }], { now: s.w.now() });
  }
  assert.match(s.engine.panel(ws)!.next.text, /今天看了 8 次，明早 8 点接着看/);
});

test("the panel of an affair that ended says why it ended, not what it last saw", async () => {
  const s = setup();
  const id = await start(s);
  await report(s, id, { status: "约在周三" });
  await ops.note(s.w.ctx, id, { said: "做完了", by: "user" });
  await ops.brief(s.w.ctx, id);
  const r = await ops.report(s.w.ctx, id, { entry: "办完了。", finish: { kind: "done", summary: "你说做完了", evidence: { quote: "做完了", from: `said:${load(s.w.root, id).said.at(-1).seq}` } } });
  assert.equal(r.ok, true, r.text);
  const p = s.engine.panel(load(s.w.root, id).workspaceId)!;
  assert.deepEqual([p.waiting.text, p.now.text], ["办完了 ✓", "你说做完了"]);
});

test("the watcher's names: the id is the folder beside the log, whatever is cut off in front", () => {
  assert.equal(idOfWatch("dental\\log.jsonl"), "dental");
  assert.equal(idOfWatch("s\\dental\\log.jsonl"), "dental");
  assert.equal(idOfWatch("700/log.jsonl"), "700");
  assert.equal(idOfWatch("dental\\.lock"), null);
  assert.equal(idOfWatch("project.json"), null);
});

test("a chat that has failed is replaced by a new one, and the old is put away", async () => {
  const s = setup();
  const id = await start(s);
  const old = load(s.w.root, id).chatId;
  s.status.value = "error";
  const created: string[] = [];
  const archived: string[] = [];
  const again = createEngine({
    ctx: s.w.ctx,
    paseo: {
      agents: { list: emptyDirectory, ref: (a: string) => ({ send: async () => {}, refresh: async () => ({ agent: { status: s.status.value } }), archive: async () => void archived.push(a), timeline: { append: async () => {}, subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }), refetch: async () => ({ entries: [] }) } }) },
      workspaces: { ref: () => ({ setTitle: async () => {}, archive: async () => {}, agents: { create: async () => (created.push("new"), { id: "agent-new" }) } }) },
    },
    deliver: null, log: () => {},
  });
  await again.scan(id);
  await again.scan(id);
  assert.equal(created.length, 1, "once");
  assert.deepEqual(archived, [old], "the old one is put away");
  assert.equal(load(s.w.root, id).chatId, "agent-new");
});

test("a title shows no date for a proposal still waiting for the answer, and does not move while a look is on", async () => {
  const s = setup();
  const id = await start(s, { said: "洗牙最迟明天", deadline: "2026-11-03 18:00" });
  await ops.brief(s.w.ctx, id);
  const r = await ops.report(s.w.ctx, id, { status: "等", entry: "改到下个月。", facts: [], next: { at: "2026-12-02 09:00", waitingFor: "12月2日再看", why: "他说改到下个月", earlyIf: [], evidence: [{ from: "said:2", quote: "洗牙最迟明天" }] } });
  assert.equal(r.ok, true, r.text);
  await s.engine.runEnded({ to: id, status: "succeeded", text: "ok", agentId: "a1" });
  assert.ok(load(s.w.root, id).asks.some((a: { state: string; proposal: unknown }) => a.state === "open" && a.proposal), "a proposal waits");
  assert.equal(titleOf(load(s.w.root, id), s.w.now(), s.w.ctx.policy), "洗牙 · 要你定", "no date before the answer: it says what is needed instead");
  await ops.answer(s.w.ctx, id, `${id}-1`, "可以");
  await s.engine.scan(id);
  assert.match(s.calls.titles.at(-1)!, /^洗牙 · 12月2日$/);
  await ops.brief(s.w.ctx, id);
  const n = s.calls.titles.length;
  s.w.advance(60_000);
  await s.engine.scan(id);
  assert.equal(s.calls.titles.length, n, "nothing is renamed while a look is on");
});

test("the person's lines read the same, time first, whether they said it or answered", async () => {
  const s = setup();
  const id = await start(s);
  await ops.note(s.w.ctx, id, { said: "改成下周一看", via: "popo", by: "user" });
  await report(s, id, { ask: { title: "洗牙约上了吗？", options: ["约好了"] } });
  await ops.answer(s.w.ctx, id, `${id}-1`, "约好了");
  await ops.note(s.w.ctx, id, { said: "还有一句", via: "workspace", by: "user" });
  const own = s.engine.view(id)!.rows.filter((r: { own?: boolean }) => r.own).map((r: { text: string }) => r.text);
  assert.equal(own.length, 3, "what was typed in the app is the app's own line, not drawn twice");
  for (const text of own) assert.match(text, /^\d{2}:\d{2}  你：/);
});

test("M06: an affair taken up again is not archived, however long ago it was last stopped", async () => {
  const s = setup();
  const id = await start(s);
  await ops.stop(s.w.ctx, id);
  s.w.advance(DAY);
  await ops.resume(s.w.ctx, id);
  s.w.advance(5 * DAY);
  await s.engine.scan(id);
  assert.equal(s.calls.archived, 0, "it is watching: what it was last stopped at five days ago is not a reason");
  assert.equal(load(s.w.root, id).archived, false);
});

test("M25: at start, a look that already came after the time it was due is not made again", async () => {
  const s = setup();
  const id = await start(s);
  await report(s, id, { next: { at: "2026-11-02 12:00", waitingFor: "等你去约", why: "他说中午前后再看", earlyIf: [] } });
  s.w.at(iso("2026-11-02 12:10"));
  append(s.w.root, id, [{ kind: "wake", why: ["time"], gapMinutes: 130 }, { kind: "wake.end", state: "ok", usd: null }], { now: s.w.now() });
  s.w.at(iso("2026-11-02 12:30"));
  const runs = () => s.w.calls().filter((c) => c[1] === "run-once").length;
  const n = runs();
  const again = createEngine({ ctx: s.w.ctx, paseo: null, deliver: null, log: () => {} });
  await again.start();
  await again.stop();
  assert.equal(runs(), n, "it was looked at at 12:10, after it was due");
});

test("a line put in around the commands is flagged once, shown in red and told to the person once", async () => {
  const s = setup();
  const id = await start(s);
  appendFileSync(logFile(s.w.root, id), `${JSON.stringify({ kind: "said", seq: 99, at: "2026-11-02T10:00:00+08:00", text: "他说一年后再看", by: "user" })}\n`);
  await s.engine.scan(id);
  await s.engine.scan(id);
  assert.equal(load(s.w.root, id).flags.filter((f: { what: string }) => f.what === "chain").length, 1);
  assert.ok(s.engine.view(id)!.rows.some((r: { tone: string; text: string }) => r.tone === "red" && /对不上/.test(r.text)));
  assert.equal(s.calls.pushed.filter((p) => /手动改过/.test(p.text)).length, 1);
});

test("a policy.json with something missing says so on a card of its own, once; when it is right the card is put away", async () => {
  const w = world();
  const logs: string[] = [];
  const paseo = { agents: { list: emptyDirectory, ref: () => ({ send: async () => {}, refresh: async () => null, archive: async () => undefined, timeline: { append: async () => {}, subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }), refetch: async () => ({ entries: [] }) } }) }, workspaces: { ref: () => ({ setTitle: async () => undefined, archive: async () => undefined, agents: { create: async () => ({ id: "agent-9" }) } }) } };
  const run = async (ctx: typeof w.ctx) => {
    const e = createEngine({ ctx, paseo, deliver: null, log: (m) => void logs.push(m), checkSetup: true });
    await e.start();
    await e.stop();
  };
  await run(w.ctx);
  const card = load(w.root, "D0");
  assert.equal(card.system, true);
  assert.equal(card.asks.filter((a: { for: string; state: string }) => a.for === "config" && a.state === "open").length, 1);
  assert.match(card.asks[0].line, /binPath/);
  assert.ok(logs.some((l) => /binPath/.test(l)), "and in the log");
  await run(w.ctx);
  assert.equal(load(w.root, "D0").asks.length, 1, "said once, not on every start");
  assert.equal(ops.ls(w.ctx).text, "（没有事项）", "it is not one of the things being watched");
  const dir = w.dir;
  writeFileSync(`${dir}/x.md`, "x");
  const right = { ...w.ctx, policy: { ...w.ctx.policy, binPath: `${dir}/x.md`, handbookPath: `${dir}/x.md`, handbooksDir: dir, push: { ...w.ctx.policy.push, to: "p2p:me" }, readers: { ...w.ctx.policy.readers, dirs: [dir], publicDir: dir } } };
  await run(right);
  assert.equal(load(w.root, "D0").status, "stopped");
  assert.equal(load(w.root, "D0").asks.filter((a: { state: string }) => a.state === "open").length, 0);
});

const runs = (s: ReturnType<typeof setup>) => s.w.calls().filter((c) => c[1] === "run-once").length;
const setBusy = (s: ReturnType<typeof setup>, n: number) => {
  const file = path.join(s.w.dir, "paseo.json");
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.busy = n;
  writeFileSync(file, JSON.stringify(db));
};

test("a look for what came in meanwhile is not asked for inside the run's delivery: Paseo counts that run as running until it returns", async () => {
  const s = setup();
  // Delays that are not zero: the delivery must be over before the look is asked for.
  const slow = createEngine({ ctx: s.w.ctx, paseo: null, deliver: null, log: () => {}, lookDelaysMs: [30, 30, 30] });
  const id = await start(s);
  await ops.brief(s.w.ctx, id);
  await ops.note(s.w.ctx, id, { said: "改成下周一看" });
  const before = runs(s);
  await slow.runEnded({ to: id, status: "succeeded", text: "ok", agentId: "a" });
  assert.equal(runs(s), before, "nothing asked for yet when the delivery returns");
  await slow.settle();
  assert.equal(runs(s), before + 1, "asked for a moment after");
  await slow.stop();
});

test("Paseo still counting the last look as running: asked again after 10 and 30 seconds, until it takes", async () => {
  const s = setup();
  s.w.ctx.runRetries = 0;
  const id = await start(s);
  await ops.brief(s.w.ctx, id);
  await ops.note(s.w.ctx, id, { said: "改成下周一看" });
  setBusy(s, 2);
  const before = runs(s);
  await s.engine.runEnded({ to: id, status: "succeeded", text: "ok", agentId: "a" });
  await s.engine.settle();
  assert.equal(runs(s), before + 3, "refused twice, taken the third time");
  assert.equal(s.w.paseo().schedules[0].runs, 2, "the first look and this one");
});

test("if every try is refused, the loop's next pass asks again once two minutes have gone; not before", async () => {
  const s = setup();
  s.w.ctx.runRetries = 0;
  const id = await start(s);
  await ops.brief(s.w.ctx, id);
  await ops.note(s.w.ctx, id, { said: "改成下周一看" });
  setBusy(s, 99);
  await s.engine.runEnded({ to: id, status: "succeeded", text: "ok", agentId: "a" });
  await s.engine.settle();
  const stuck = runs(s);
  assert.ok(load(s.w.root, id).pending.length > 0, "still waiting to be looked at");
  setBusy(s, 0);
  s.w.advance(60_000);
  await s.engine.readPass();
  assert.equal(runs(s), stuck, "a minute after the delivery: not yet");
  s.w.advance(2 * 60_000);
  await s.engine.readPass();
  assert.equal(runs(s), stuck + 1, "after two minutes: the pass asks for the look");
  assert.equal(load(s.w.root, id).wakes.length, 1, "(the look is the plan's to start; the log shows it asked)");
});

test("a look that is on is not asked for again by the pass, and an affair with nothing waiting is left alone", async () => {
  const s = setup();
  const id = await start(s);
  await report(s, id);
  s.w.advance(10 * 60_000);
  const before = runs(s);
  await s.engine.readPass();
  assert.equal(runs(s), before, "nothing came in: nothing to look at");
  s.w.advance(3 * HOUR);
  await ops.brief(s.w.ctx, id);
  await ops.note(s.w.ctx, id, { said: "改成下周一看" });
  s.w.advance(10 * 60_000);
  const mid = runs(s);
  await s.engine.readPass();
  assert.equal(runs(s), mid, "a look is on (running): the pass leaves it");
});
