import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as ops from "../server/lib/ops.mjs";
import { append, load, read } from "../server/lib/log.mjs";
import { canResume, claimFile, eventsFile, flowFinishedMessage, readStatus } from "../server/lib/flows.mjs";
import { flowBlockOf } from "../server/lib/panel.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { createChats, type ChatPaseo } from "../server/chat";
import { createEngine } from "../server/engine";
import { rotationReason } from "../server/lib/chat.mjs";
import { checkReport, buildFacts } from "../server/lib/check.mjs";
import { world } from "./kit";

const POINT = { flow: "do-it", input: { version: 1 }, from: "从补丁接着做", spends: "maybe" };
const statusModule = pathToFileURL(path.resolve(import.meta.dirname, "../../orchestration/runtime/status.mjs")).href;

async function setup(limits = {}) {
  const w = world();
  const logs = path.join(w.dir, "logs");
  mkdirSync(path.join(logs, "runs"), { recursive: true });
  const orch = path.join(w.dir, "orch.mjs");
  const prepare = path.join(w.dir, "prepare.mjs");
  writeFileSync(orch, `if (process.argv[2] === "status") { const {runStatus} = await import(${JSON.stringify(statusModule)}); console.log(JSON.stringify(runStatus({dir:process.env.ORCH_LOG_DIR,runId:process.argv[3]}))); } else if (process.argv[2] === "gate-carrier") console.log(JSON.stringify({carrier:"model",family:"test",provider:"test/model"}));`);
  writeFileSync(prepare, 'console.log(JSON.stringify({value:{},summary:"ok"}));');
  process.env.AFFAIR_NODE = process.execPath;
  delete process.env.ORCH_LOG_DIR;
  w.ctx.policy = { ...w.ctx.policy, homes: { gcp: w.dir }, limits: { ...DEFAULT_POLICY.limits, ...limits }, flows: { orch, logDir: logs, "do-it": { kinds: ["gcp"], prepare, timeout: "30h" } } };
  const id = (await ops.create(w.ctx, { title: "示例修复", link: "gcp:700", noWait: true })).id as string;
  const put = (entries: any[]) => append(w.root, id, entries, { now: w.now(), tz: w.ctx.policy.tz });
  put([{ kind: "cleared", void: true }]);
  const run = "previous";
  put([{ kind: "flow", flow: "do-it", runId: run, events: eventsFile(logs, run), timeoutMs: 10000, by: "human" }]);
  const event = (kind: string, extra = {}) => ({ v: 1, ts: new Date().toISOString(), runId: run, kind, ...extra });
  const ended = (resume: any = POINT, outcome = "stopped") => writeFileSync(eventsFile(logs, run), [event("run.start", { flow: { name: "do-it", phases: [] } }), event("run.end", { outcome, resume, stop: { reason: "补丁没批" }, cost: { totalUsd: 0.03 }, summary: "方案已写好" })].map((e, seq) => JSON.stringify({ ...e, seq })).join("\n") + "\n");
  ended();
  const readSt = () => readStatus({ orch, logDir: logs, runId: run });
  const launched: Array<{ args: string[]; options: any }> = [];
  w.ctx.flowWaitMs = 100;
  w.ctx.flowStart = ((_node: string, args: string[], options: any) => {
    launched.push({ args, options });
    const next = args[args.indexOf("--run-id") + 1];
    const child = Object.assign(new EventEmitter(), { pid: 111, unref() {} });
    if (args.includes("--expect") && args[args.indexOf("--expect") + 1] !== (w.ctx.flowNow.get(run)?.st?.resume?.print ?? "")) {
      writeFileSync(claimFile(logs, next), JSON.stringify({ refused: "the resume point is not the one that was shown" }));
      queueMicrotask(() => child.emit("exit", 2));
    } else writeFileSync(eventsFile(logs, next), JSON.stringify(event("run.start", { runId: next, flow: { name: "do-it", phases: [] } })) + "\n");
    return child;
  }) as any;
  return { w, id, put, run, logs, orch, ended, readSt, launched };
}

test("flow end bypasses the affair's spent budget at request, panel and brief; time still stops", async () => {
  const s = await setup({ perAffairUsdPerDay: 0.5 });
  s.put([{ kind: "chat.turn", usd: 0.97 }]);
  const before = s.w.calls().filter((a) => a[1] === "run-once").length;
  await ops.flowSync(s.w.ctx, s.id);
  assert.equal(s.w.calls().filter((a) => a[1] === "run-once").length, before + 1);
  const engine = createEngine({ ctx: s.w.ctx, paseo: null, deliver: null, log() {} });
  assert.doesNotMatch(engine.panel(load(s.w.root, s.id).workspaceId)!.next.text, /今天花到上限/);
  s.w.advance(11 * 60_000); // the earlier clearance has expired: brief has to check for itself
  const brief = await ops.brief({ ...s.w.ctx, by: "look" }, s.id);
  assert.equal(brief.ok, true, brief.text);
  assert.match(brief.text, /流程 do-it 结束了/);
  assert.match(brief.text, /限额：还能看/);
  const other = await setup({ perAffairUsdPerDay: 0.5 });
  other.put([{ kind: "chat.turn", usd: 0.97 }]);
  assert.equal((await ops.requestLook(other.w.ctx, other.id, "time")).ok, false);
  assert.equal((await ops.brief({ ...other.w.ctx, by: "look" }, other.id)).ok, false);
});

test("flow end still stops at the global limit", async () => {
  const s = await setup({ perAffairUsdPerDay: 0.5, totalUsdPerDay: 0.8 });
  s.put([{ kind: "chat.turn", usd: 0.97 }]);
  await ops.flowSync(s.w.ctx, s.id);
  assert.equal(read(s.w.root, s.id).find((l: any) => l.kind === "flow.look").ok, false);
  assert.equal((await ops.brief({ ...s.w.ctx, by: "look" }, s.id)).ok, false);
});

test("flow end can also exceed the affair's look count, while a time look cannot", async () => {
  const s = await setup({ perAffairPerDay: 0 });
  assert.equal((await ops.requestLook(s.w.ctx, s.id, "time")).ok, false);
  await ops.flowSync(s.w.ctx, s.id);
  assert.equal(read(s.w.root, s.id).find((l: any) => l.kind === "flow.look").ok, true);
  s.w.advance(11 * 60_000);
  assert.equal((await ops.brief({ ...s.w.ctx, by: "look" }, s.id)).ok, true);
});

function chats(s: Awaited<ReturnType<typeof setup>>) {
  let state = "idle";
  let missing = false;
  let archived = false;
  const sent: Array<{ id: string; text: string; options: any }> = [];
  let hear: (e: any) => void = () => {};
  const paseo = { agents: { ref: (id: string) => ({
    refresh: async () => missing ? null : { agent: { status: state, archivedAt: archived ? "yes" : null } },
    send: async (text: string, options: any) => { sent.push({ id, text, options }); hear({ event: { type: "timeline", item: { type: "user_message", text, messageId: options.messageId } } }); },
    archive: async () => {}, timeline: { append: async () => {}, refetch: async () => ({ entries: [] }), subscribe: (h: any) => { hear = h; return Object.assign(() => {}, { ready: Promise.resolve() }); } },
  }) }, workspaces: { ref: () => ({ agents: { create: async () => ({ id: "chat" }) } }) } } as ChatPaseo;
  const make = () => createChats({ ctx: s.w.ctx, paseo, state: () => ({ ...load(s.w.root, s.id), lines: read(s.w.root, s.id) }), write: (_id, entries) => void s.put(entries), view: () => ({ rows: [], asks: [] }), log() {} });
  s.put([{ kind: "chat", agentId: "current-chat" }]);
  return { make, sent, busy: (v: string) => state = v, missing: () => missing = true, archived: () => archived = true };
}

test("tell the current chat once after the look reports, across repeated scans and restart; template cannot authorize a flow", async () => {
  const s = await setup();
  const c = chats(s);
  const chat = c.make();
  await chat.listen(s.id);
  await ops.flowSync(s.w.ctx, s.id);
  await chat.tellFinished(s.id);
  assert.equal(c.sent.length, 0, "the look has not updated now yet");
  s.put([{ kind: "wake", why: [`ring:flow:${s.run}`] }, { kind: "report", status: "补丁没批，等反馈", entry: "方案已写好", verdict: "pass" }]);
  await chat.tellFinished(s.id);
  await chat.tellFinished(s.id);
  await c.make().tellFinished(s.id);
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].id, "current-chat");
  for (const text of ["停了", "$0.030", "运行目录", "可以接着跑", "不要再起任何东西"]) assert.ok(c.sent[0].text.includes(text), text);
  assert.equal(load(s.w.root, s.id).said.length, 0, "a plugin notification is never his word");
  assert.equal(read(s.w.root, s.id).filter((l: any) => l.kind === "flow.told").length, 1);
  chat.stop();
});

test("blocked look still tells; a busy chat waits; missing and archived chats are recorded as not sent", async () => {
  for (const absent of ["busy", "missing", "archived"] as const) {
    const s = await setup({ totalUsdPerDay: 0 });
    s.ended(null);
    const c = chats(s);
    await ops.flowSync(s.w.ctx, s.id);
    const chat = c.make();
    if (absent === "busy") c.busy("running"); else c[absent]();
    await chat.tellFinished(s.id);
    assert.equal(c.sent.length, 0);
    if (absent === "busy") {
      assert.equal(read(s.w.root, s.id).filter((l: any) => l.kind === "flow.told").length, 0);
      c.busy("idle");
      await chat.tellFinished(s.id);
      assert.equal(c.sent.length, 1);
      assert.match(c.sent[0].text, /不能接着跑.*--again/);
    } else assert.equal(read(s.w.root, s.id).find((l: any) => l.kind === "flow.told").ok, false);
  }
});

test("a failed look still tells the chat its run ended", async () => {
  for (const readBrief of [true, false]) {
    const s = await setup(); const c = chats(s);
    await ops.flowSync(s.w.ctx, s.id);
    if (readBrief) s.put([{ kind: "wake", why: [`ring:flow:${s.run}`] }]);
    s.put([{ kind: "wake.end", state: "failed" }]);
    await c.make().tellFinished(s.id);
    assert.equal(c.sent.length, 1, "even a failure before reading brief must be reported");
  }
});

test("an unavailable runtime status is not reported as a missing resume point", async () => {
  const s = await setup(); await ops.flowSync(s.w.ctx, s.id);
  const state = load(s.w.root, s.id);
  const text = flowFinishedMessage(s.w.ctx, state, state.flows[0], null);
  assert.match(text, /没拿到能否接着跑的状态/);
  assert.doesNotMatch(text, /没有能接着做的位置/);
});

test("resume button requires an explicit unsuccessful end and a declared point; it survives a restart", async () => {
  const s = await setup();
  await ops.flowSync(s.w.ctx, s.id);
  const state = load(s.w.root, s.id);
  assert.equal(flowBlockOf(state, s.w.now())!.action!.kind, "resume");
  const st = await s.readSt();
  for (const bad of [{ ...st, state: "lost" }, { ...st, state: "running" }, { ...st, outcome: "done" }, { ...st, resume: null }]) {
    assert.equal(canResume(bad), false);
    assert.notEqual(flowBlockOf({ ...state, flows: [{ ...state.flows[0], outcome: "" }] }, s.w.now(), new Map([[s.run, { st: bad }]]))!.action!.kind, "resume");
  }
});

test("resume spawns detached with the shown fingerprint and no caller identity; an expired fingerprint gets Chinese refusal", async () => {
  const s = await setup(); await ops.flowSync(s.w.ctx, s.id);
  Object.assign(process.env, { PASEO_AGENT_ID: "parent", PASEO_AGENT_CWD: "parent-dir", PASEO_WORKSPACE_ID: "parent-workspace", PASEO_HOME: "keep-this-home" });
  try {
    const r = await ops.resumeFlow(s.w.ctx, s.id, { runId: s.run, expect: "0000000000000000" });
    assert.equal(r.ok, false); assert.match(r.text, /位置变了.*刷新/);
    const print = (await s.readSt()).resume.print;
    const good = await ops.resumeFlow(s.w.ctx, s.id, { runId: s.run, expect: print });
    assert.equal(good.ok, true, good.text);
    const { args, options } = s.launched.at(-1)!;
    assert.deepEqual(args.slice(1, 3), ["resume", s.run]);
    assert.equal(args[args.indexOf("--expect") + 1], print);
    assert.equal(options.detached, true); assert.equal(options.stdio, "ignore");
    assert.equal(options.cwd, s.w.dir); assert.equal(options.env.PASEO_HOME, "keep-this-home");
    for (const name of ["PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID"]) assert.equal(options.env[name], undefined);
    assert.equal(load(s.w.root, s.id).flows.at(-1).resumeOf, s.run);
    assert.equal((await ops.resumeFlow(s.w.ctx, s.id, { runId: s.run, expect: print })).ok, false, "the new run is still on");
  } finally { for (const name of ["PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID", "PASEO_HOME"]) delete process.env[name]; }
});

test("chat resumes need this turn's real words; looks, missing evidence, forged words, old words and reuse are refused", async () => {
  const s = await setup(); await ops.flowSync(s.w.ctx, s.id);
  const c = { ...s.w.ctx, by: "chat", chatFor: s.id };
  assert.equal((await ops.flow({ ...c, by: "look" }, s.id, "", { resume: true })).ok, false);
  assert.equal((await ops.flow(c, s.id, "", { resume: true })).ok, false);
  const forged = await ops.hear(s.w.ctx, s.id, "接着跑", { fromAgent: true });
  assert.equal((await ops.flow(c, s.id, "", { resume: true, saidSeq: forged.seq })).ok, false);
  const old = await ops.hear(s.w.ctx, s.id, "接着跑");
  s.w.advance(1000); s.put([{ kind: "chat", agentId: "chat" }, { kind: "chat.turn", agentId: "chat", tokens: 100 }]);
  assert.match((await ops.flow(c, s.id, "", { resume: true, saidSeq: old.seq })).text, /之前那几轮/);
  const said = await ops.hear(s.w.ctx, s.id, "接着跑吧");
  const good = await ops.flow(c, s.id, "", { resume: true, saidSeq: said.seq });
  assert.equal(good.ok, true, good.text);
  assert.equal(s.launched.at(-1)!.args[s.launched.at(-1)!.args.indexOf("--expect") + 1], (await s.readSt()).resume.print);
});

test("flow listing and brief say whether the last stop can continue, without guessing", async () => {
  const s = await setup();
  assert.match((await ops.flow(s.w.ctx, s.id)).text, /能续的停下/);
  s.ended(null);
  assert.match((await ops.flow(s.w.ctx, s.id)).text, /没有能接着做的位置.*--again/);
  assert.equal((await ops.flow(s.w.ctx, s.id, "", { resume: true })).ok, false);
});

test("rotation waits while the runtime says a flow is still going", async () => {
  const s = await setup();
  s.put([{ kind: "chat", agentId: "chat" }, { kind: "chat.turn", agentId: "chat", tokens: 200000 }]);
  s.w.advance(24 * 60 * 60_000);
  const state = load(s.w.root, s.id);
  assert.match(rotationReason(state, s.w.now(), s.w.ctx.policy), /^rotate:/);
  assert.equal(rotationReason({ ...state, flowRunning: true }, s.w.now(), s.w.ctx.policy), "");
});
