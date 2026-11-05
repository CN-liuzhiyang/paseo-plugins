import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as ops from "../server/lib/ops.mjs";
import { claimFile, eventsFile, marksOf } from "../server/lib/flows.mjs";
import { append, load, read } from "../server/lib/log.mjs";
import { eventsOf } from "../server/lib/events.mjs";
import { linkContext } from "../server/lib/links.mjs";
import { flowBlockOf } from "../server/lib/panel.mjs";
import { rowsOf } from "../server/lib/view.mjs";
import { scratch, world } from "./kit";

// Following a run the affair started: the steps written into the log (once each), the sentence in the chat, the block on the
// panel, the row under 经过, and one look when it ends. The runtime is its own `status` command (test/orch-status.mjs) over
// claim and events files that the tests write, so what is drawn is what a run in each state looks like to it.

const HOUR = 3_600_000;
const MECHANISM = /runId|phase|gate|caveat|provider|orch|claim|callId|workspace|agent|会话|叫醒|校验|读数/i;

function setup() {
  const home = scratch("flow-follow-");
  const logDir = path.join(home, "logs");
  mkdirSync(path.join(logDir, "runs"), { recursive: true });
  process.env.ORCH_LOG_DIR = logDir;
  process.env.AFFAIR_NODE = process.execPath;
  const w = world({ policy: { homes: { gcp: home }, links: { gcp: "https://tickets.example/{ref}" }, flows: { orch: path.join(import.meta.dirname, "orch-status.mjs"), "do-it": { kinds: ["gcp"], prepare: path.join(import.meta.dirname, "orch-status.mjs"), timeout: "30h" } } } });
  return { w, logDir, home };
}

async function ticket(w: ReturnType<typeof world>) {
  const made = await ops.create(w.ctx, { title: "#700 某某闪退", link: "gcp:#700", said: "帮我盯一下 #700", noWait: true });
  assert.equal(made.ok, true, made.text);
  FIRST.set(w, w.calls().filter((c) => c[0] === "schedule" && c[1] === "run-once").length);
  return made.id as string;
}

const RUN = "run-1";
let seq = 0;
const ev = (kind: string, rest: Record<string, unknown> = {}) => ({ v: 1, seq: seq++, ts: new Date().toISOString(), runId: RUN, kind, ...rest });
const events = (logDir: string, list: Array<Record<string, unknown>>, { claimAgeMs = 5_000, runId = RUN }: { claimAgeMs?: number | null; runId?: string } = {}) => {
  writeFileSync(eventsFile(logDir, runId), list.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (claimAgeMs !== null) {
    const file = claimFile(logDir, runId);
    writeFileSync(file, JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }));
    const at = new Date(Date.now() - claimAgeMs);
    utimesSync(file, at, at);
  }
};
const start = () => ev("run.start", { flow: { name: "do-it", phases: [{ id: "plan", title: "写方案" }, { id: "patch", title: "出补丁" }] } });
const gateStart = (callId = "c2", title = "批准 #700 的修复方案，开始出补丁？") => ev("call.start", { callId, type: "gate", name: "gate", title, phase: "plan" });
const gateAgent = (callId = "c2") => ev("call.agent", { callId, agentId: "carrier-1" });
const gateEnd = (outcome: string, extra: Record<string, unknown> = {}) =>
  ev("call.end", { callId: "c2", ok: true, output: { outcome, approved: outcome === "allowed", agentId: "carrier-1", askedAt: new Date().toISOString(), decidedAt: new Date().toISOString(), reason: null, ...extra }, agentId: "carrier-1" });
const runEnd = (outcome: string, rest: Record<string, unknown> = {}) => ev("run.end", { outcome, durationMs: 240000, cost: { totalUsd: 2.4, agentCount: 3, partial: "" }, ...rest });

/** The run is in the log as started a moment ago by the person. */
function started(w: ReturnType<typeof world>, id: string, logDir: string) {
  seq = 0;
  append(w.root, id, [{ kind: "flow", flow: "do-it", runId: RUN, events: eventsFile(logDir, RUN), timeoutMs: 30 * HOUR, by: "human" }], { now: w.now() });
}
const marks = (w: ReturnType<typeof world>, id: string) => read(w.root, id).filter((l: { kind: string }) => l.kind === "flow.mark") as Array<{ key: string; text: string; tone: string }>;
/** Looks asked for since the affair was made (making it asks for the first). */
const looks = (w: ReturnType<typeof world>) => w.calls().filter((c) => c[0] === "schedule" && c[1] === "run-once").length - FIRST.get(w)!;
const FIRST = new WeakMap<object, number>();
const stateOf = (w: ReturnType<typeof world>, id: string) => ({ ...load(w.root, id), lines: read(w.root, id) });

test("a card waiting, the answer and the end are each written down once, however often the run is looked at", async () => {
  const { w, logDir } = setup();
  const id = await ticket(w);
  started(w, id, logDir);

  events(logDir, [start(), ev("phase.start", { phase: "plan" })]);
  assert.equal(await ops.flowSync(w.ctx, id), false, "nothing to write yet");
  assert.deepEqual(marks(w, id), []);

  events(logDir, [start(), ev("phase.start", { phase: "plan" }), gateStart(), gateAgent()]);
  assert.equal(await ops.flowSync(w.ctx, id), true);
  await ops.flowSync(w.ctx, id);
  assert.deepEqual(marks(w, id).map((m) => m.key), ["gate:c2:waiting"]);
  assert.match(marks(w, id)[0].text, /^等你批：/);

  events(logDir, [start(), gateStart(), gateAgent(), gateEnd("allowed")]);
  await ops.flowSync(w.ctx, id);
  await ops.flowSync(w.ctx, id);
  assert.deepEqual(marks(w, id).map((m) => m.key), ["gate:c2:waiting", "gate:c2:allowed"]);
  assert.match(marks(w, id)[1].text, /：批了$/);
  assert.equal(looks(w), 0, "a card answered is no reason for a look");

  events(logDir, [start(), gateStart(), gateAgent(), gateEnd("allowed"), runEnd("done", { summary: "提交了 r123，单子已回填" })], { claimAgeMs: 9_000_000 });
  await ops.flowSync(w.ctx, id);
  await ops.flowSync(w.ctx, id);
  assert.deepEqual(marks(w, id).map((m) => m.key), ["gate:c2:waiting", "gate:c2:allowed", "end"]);
  const end = load(w.root, id).flows[0];
  assert.deepEqual([end.outcome, end.summary, end.costUsd], ["done", "提交了 r123，单子已回填", 2.4]);
  assert.match(marks(w, id)[2].text, /^做完了：提交了 r123，单子已回填 · \$2\.40$/);
  assert.equal(looks(w), 1, "one look when it ended, and not again for the second sighting");
  assert.ok(read(w.root, id).some((l: { kind: string; why?: string }) => l.kind === "ring" && l.why === `flow:${RUN}`), "and the look is told what for");
});

test("an answer seen only after it was given still leaves the waiting before it; each way a card can come out is told in his words", async () => {
  const { w, logDir } = setup();
  const id = await ticket(w);
  started(w, id, logDir);
  events(logDir, [start(), gateStart(), gateAgent(), gateEnd("denied", { reason: "方案太大" })]);
  await ops.flowSync(w.ctx, id);
  assert.deepEqual(marks(w, id).map((m) => [m.key, m.tone]), [["gate:c2:waiting", "normal"], ["gate:c2:denied", "red"]]);
  assert.match(marks(w, id)[1].text, /：没批，方案太大$/);
  const words = (state: string) => marksOf({ state: "running", gates: [{ callId: "c9", title: "批准补丁", state }] }).at(-1)!.text;
  assert.equal(words("expired"), "批准补丁：没批，过期了");
  assert.equal(words("mismatch"), "批准补丁：没批成");
  assert.equal(words("error"), "批准补丁：没批成");
  assert.equal(words("allowed"), "批准补丁：批了");
});

test("how a run ends: stopped, failed and timed out are red and say why; a run whose keeper is gone is called lost only if it stays so", async () => {
  for (const [outcome, rest, pattern] of [
    ["stopped", { stop: { reason: "补丁没批", kind: "flow", step: null } }, /^停了：补丁没批 · \$2\.40$/],
    ["failed", { error: { name: "Boom", message: "编译不过" } }, /^出错停了：编译不过/],
    ["timeout", { error: { name: "Timeout", message: "x" } }, /^超时停了/],
  ] as const) {
    const { w, logDir } = setup();
    const id = await ticket(w);
    started(w, id, logDir);
    events(logDir, [start(), runEnd(outcome, rest)], { claimAgeMs: 9_000_000 });
    await ops.flowSync(w.ctx, id);
    const end = marks(w, id).find((m) => m.key === "end")!;
    assert.match(end.text, pattern, outcome);
    assert.equal(end.tone, "red");
    assert.equal(looks(w), 1);
  }

  const { w, logDir } = setup();
  const id = await ticket(w);
  started(w, id, logDir);
  events(logDir, [start(), gateStart(), gateAgent()], { claimAgeMs: 10 * 60_000 });
  await ops.flowSync(w.ctx, id);
  assert.equal(marks(w, id).some((m) => m.key === "end"), false, "stale for the moment: a machine that slept looks like this");
  w.advance(40_000);
  await ops.flowSync(w.ctx, id);
  assert.match(marks(w, id).find((m) => m.key === "end")!.text, /^没了下文/);
  assert.equal(load(w.root, id).flows[0].outcome, "lost");
});

test("a run the runtime refused after it was started is taken back, and drawn nowhere", async () => {
  const { w, logDir } = setup();
  const id = await ticket(w);
  started(w, id, logDir);
  writeFileSync(claimFile(logDir, RUN), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), refused: "no such flow" }));
  assert.equal(await ops.flowSync(w.ctx, id), true);
  assert.equal(load(w.root, id).flows[0].failed, "no such flow");
  assert.equal(rowsOf(stateOf(w, id), w.now(), w.ctx.policy).some((r: { key: string }) => r.key[0] === "w"), false);
});

test("the chat has one line for the run, in the same place whatever happens to it, in words a person reads", async () => {
  const { w, logDir } = setup();
  const id = await ticket(w);
  started(w, id, logDir);
  const rowOf = () => {
    const rows = rowsOf(stateOf(w, id), w.now(), w.ctx.policy, { flowNow: w.ctx.flowNow }).filter((r: { key: string }) => r.key[0] === "w");
    assert.equal(rows.length, 1, "one line for the run");
    return rows[0] as { key: string; text: string; tone: string };
  };
  const key = rowOf().key;

  events(logDir, [start(), ev("phase.start", { phase: "plan" })]);
  await ops.flowSync(w.ctx, id);
  w.advance(4 * 60_000);
  assert.match(rowOf().text, /do-it · 写方案 · 4 分钟$/);

  events(logDir, [start(), ev("phase.start", { phase: "plan" }), gateStart(), gateAgent()]);
  await ops.flowSync(w.ctx, id);
  assert.match(rowOf().text, /do-it · 等你批：批准 #700 的修复方案/);
  assert.equal(rowOf().tone, "warn", "he is asked to do something: the line is drawn in the warm color");

  events(logDir, [start(), gateStart(), gateAgent(), gateEnd("denied")]);
  await ops.flowSync(w.ctx, id);
  events(logDir, [start(), gateStart(), gateAgent(), gateEnd("denied"), runEnd("stopped", { stop: { reason: "方案没批", kind: "flow", step: null } })], { claimAgeMs: 9_000_000 });
  await ops.flowSync(w.ctx, id);
  const done = rowOf();
  assert.equal(done.key, key, "the same line is put again");
  assert.equal(done.tone, "red");
  assert.match(done.text, /do-it · 停了：方案没批/);
  for (const text of [rowOf().text]) assert.doesNotMatch(text, MECHANISM);

  // After a restart nothing is remembered but the log: the line still says how it came out.
  w.ctx.flowNow.clear();
  assert.match(rowOf().text, /do-it · 停了：方案没批/);
});

test("the panel: a block above 现在 while the run is on and for a day after, with the button that fits", async () => {
  const { w, logDir } = setup();
  const id = await ticket(w);
  started(w, id, logDir);
  events(logDir, [start(), ev("phase.start", { phase: "plan" })]);
  await ops.flowSync(w.ctx, id);
  let block = flowBlockOf(stateOf(w, id), w.now(), w.ctx.flowNow)!;
  assert.deepEqual([block.name, block.text, block.action?.kind, block.more, block.stale], ["do-it", "写方案", "detail", 0, ""]);

  events(logDir, [start(), gateStart(), gateAgent()]);
  await ops.flowSync(w.ctx, id);
  block = flowBlockOf(stateOf(w, id), w.now(), w.ctx.flowNow)!;
  assert.equal(block.text, "等你批");
  assert.match(block.detail, /修复方案/, "the card he is asked to answer is the line under it");
  assert.ok([...block.text].length <= 20 && [...block.name].length <= 20);
  assert.deepEqual(block.action, { kind: "approve", agentId: "carrier-1" }, "the button opens the card");

  w.advance(5 * 60_000);
  events(logDir, [start(), gateStart(), gateAgent(), gateEnd("allowed"), runEnd("done", { summary: "做完了的结果" })], { claimAgeMs: 9_000_000 });
  await ops.flowSync(w.ctx, id);
  block = flowBlockOf(stateOf(w, id), w.now(), w.ctx.flowNow)!;
  assert.equal(block.text, "做完了");
  assert.equal(block.detail, "做完了的结果");
  assert.equal(block.tone, "normal");
  assert.deepEqual(block.action, { kind: "detail", runId: RUN });
  assert.match(block.meta, /\$2\.40/);
  assert.match(block.stale, /「现在」还是流程结束之前的/, "the 现在 below has not been written since the run ended");
  for (const text of [block.name, block.text, block.detail, block.meta, block.stale]) assert.doesNotMatch(text, MECHANISM);

  // A look reads the result and hands in a new 现在: the hint goes.
  append(w.root, id, [{ kind: "report", from: "look", verdict: "recorded", status: "新的现在", entry: "看过了" }], { now: w.now() });
  assert.equal(flowBlockOf(stateOf(w, id), w.now(), w.ctx.flowNow)!.stale, "");
  // A day later the block is gone.
  assert.equal(flowBlockOf(stateOf(w, id), w.now() + 25 * HOUR, w.ctx.flowNow), null);
  assert.equal(flowBlockOf({ ...stateOf(w, id), flows: [] }, w.now(), w.ctx.flowNow), null);
});

test("under 经过 a run is one row, and its steps are under it", async () => {
  const { w, logDir } = setup();
  const id = await ticket(w);
  await ops.hear(w.ctx, id, "好，用 do-it 做");
  started(w, id, logDir);
  events(logDir, [start(), gateStart(), gateAgent(), gateEnd("allowed"), gateStart("c3", "批准补丁"), runEnd("done", { summary: "完成" })], { claimAgeMs: 9_000_000 });
  await ops.flowSync(w.ctx, id);
  const s = stateOf(w, id);
  const items = eventsOf(s, w.now(), w.ctx.policy, linkContext(w.ctx.policy, s.link), { labelOf: (tool: string) => ({ name: tool }) }).items.filter((r: { kind: string }) => r.kind === "flow");
  assert.equal(items.length, 1);
  const [row] = items;
  assert.equal(row.label, "流程 · do-it");
  assert.match(row.text, /^做完了/);
  assert.equal(row.children.length, 5, "started, waiting, answered, waiting again, ended");
  assert.match(row.children[0].text, /^起了/);
  assert.match(row.children.at(-1).text, /^做完了/);
  for (const text of [row.label, row.text, ...row.children.map((k: { text: string }) => k.text)]) assert.doesNotMatch(text, MECHANISM);
});

test("the brief tells of the runs, and of the ones that ended after the 现在 was written", async () => {
  const { w, logDir } = setup();
  const id = await ticket(w);
  started(w, id, logDir);
  events(logDir, [start(), gateStart(), gateAgent(), gateEnd("allowed"), runEnd("done", { summary: "完成" })], { claimAgeMs: 9_000_000 });
  await ops.flowSync(w.ctx, id);
  const look = await ops.brief({ ...w.ctx, by: "look" }, id);
  assert.match(look.text, /## 起过的流程\n- do-it（.*）：做完了：完成/);
  assert.match(look.text, /流程 do-it .*结束了，这句是在那之前写的/);
  const chat = await ops.brief({ ...w.ctx, by: "chat", chatFor: id }, id, { chat: true });
  assert.match(chat.text, /## 起过的流程/);
  assert.match(chat.text, /流程 do-it .*结束了/);
});

test("the engine follows the run on its own pass: the steps are written, the view and the panel show them, and it stops asking when the run is over", async () => {
  const { createEngine } = await import("../server/engine");
  const { w, logDir } = setup();
  const id = await ticket(w);
  started(w, id, logDir);
  const engine = createEngine({ ctx: w.ctx, paseo: null, deliver: null, log: () => {} });
  events(logDir, [start(), gateStart(), gateAgent()]);
  await engine.scan(id);
  assert.deepEqual(marks(w, id).map((m) => m.key), ["gate:c2:waiting"]);
  const view = engine.view(id)!;
  assert.equal(view.rows.filter((r) => r.key[0] === "w").length, 1);
  assert.match(view.rows.find((r) => r.key[0] === "w")!.text, /等你批/);
  const panel = engine.panel(String(load(w.root, id).workspaceId))!;
  assert.equal(panel.flow?.action?.kind, "approve");
  assert.match(panel.flow!.text, /^等你批/);

  events(logDir, [start(), gateStart(), gateAgent(), gateEnd("allowed"), runEnd("done")], { claimAgeMs: 9_000_000 });
  await engine.scan(id);
  assert.equal(load(w.root, id).flows[0].outcome, "done");
  const before = read(w.root, id).length;
  await engine.scan(id);
  assert.equal(read(w.root, id).length, before, "nothing more is written once it is over");
  await engine.stop();
});
