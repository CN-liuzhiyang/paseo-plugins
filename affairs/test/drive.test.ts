import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { append, fold, load, read } from "../server/lib/log.mjs";
import * as ops from "../server/lib/ops.mjs";
import { budgetGate, budgetQuestion, budgetText, spendOf } from "../server/lib/drive.mjs";
import { dispatch, dispatchCosts, dispatchOpen } from "../server/lib/dispatch.mjs";
import { stepLines, workSteps } from "../server/lib/steps.mjs";
import { chatPrompt } from "../server/lib/chat.mjs";
import { refreshWork } from "../server/lib/workdir-git.mjs";
import { panelOf } from "../server/lib/panel.mjs";
import { linkContext } from "../server/lib/links.mjs";
import { createChats } from "../server/chat";
import { world, emptyDirectory } from "./kit";

afterEach(() => { delete process.env.PASEO_AGENT_ID; delete process.env.FAKE_PASEO_LABELS; });

function fixture() {
  const w = world();
  w.ctx.policy = { ...w.ctx.policy, workDir: path.join(w.dir, "work") };
  const id = "drive-example";
  const put = (entries: any[]) => append(w.root, id, entries, { now: w.now() });
  put([{ kind: "created", id, title: "改进工具", projects: [], workdir: w.dir }, { kind: "workspace", workspaceId: "workspace", projectId: "project" }, { kind: "chat", agentId: "main-chat", why: "first" }]);
  const state = () => ({ ...load(w.root, id, w.ctx.policy), lines: read(w.root, id) });
  refreshWork(w.ctx, state());
  const main = () => { process.env.PASEO_AGENT_ID = "main-chat"; return { ...w.ctx, by: "chat", chatFor: id }; };
  return { w, id, put, state, main };
}

test("default mode follows the primary kind, including old logs; an explicit mode survives policy and link changes", async () => {
  const f = fixture();
  assert.equal(f.state().mode, "drive");
  assert.equal(fold([{ kind: "created", links: ["gcp:example", "github:example/repo#1"] }], { watchKinds: ["gcp"] }).mode, "watch");
  assert.equal(fold([{ kind: "created", links: ["github:example/repo#1", "gcp:example"] }], { watchKinds: ["gcp"] }).mode, "drive");
  assert.equal(fold([{ kind: "created", links: [] }], { watchKinds: [] }).mode, "drive");
  f.put([{ kind: "mode", mode: "watch" }, { kind: "link", action: "add", link: "github:example/repo#1" }]);
  assert.equal(f.state().mode, "watch");
});

test("a drive affair has no schedule; only his actual line can switch it to watching and pause it again", async () => {
  const w = world();
  const created = await ops.create(w.ctx, { id: "unlinked", title: "自己的事", noWait: true });
  assert.ok(created.ok, created.text);
  assert.equal(load(w.root, created.id).mode, "drive");
  assert.ok(!w.calls().some((c) => c[0] === "schedule"));
  assert.equal((await ops.mode(w.ctx, created.id, "watch", { saidSeq: "999" })).ok, false);
  const heard = await ops.hear(w.ctx, created.id, "先盯着");
  assert.ok((await ops.mode(w.ctx, created.id, "watch", { saidSeq: heard.seq })).ok);
  const schedule = load(w.root, created.id).scheduleId;
  assert.equal(w.paseo().schedules.find((s: any) => s.id === schedule).status, "active");
  const said = await ops.hear(w.ctx, created.id, "改为我来推");
  assert.ok((await ops.mode(w.ctx, created.id, "drive", { saidSeq: said.seq })).ok);
  assert.equal(w.paseo().schedules.find((s: any) => s.id === schedule).status, "paused");
  assert.equal((await ops.requestLook(w.ctx, created.id, "pending")).ok, false);
});

test("budgets require his line and its number, reject agent words and undone evidence, and preserve cumulative spend", async () => {
  const f = fixture();
  const heard = await ops.hear(f.w.ctx, f.id, "给你 20 美元");
  const ctx = f.main();
  assert.equal((await ops.budget(ctx, f.id, 30, { saidSeq: heard.seq })).ok, false);
  assert.ok((await ops.budget(ctx, f.id, 20, { saidSeq: heard.seq })).ok);
  f.put([{ kind: "said", text: "100 美元", by: "look", via: "chat-agent" }]);
  assert.equal((await ops.budget(ctx, f.id, 100, { saidSeq: f.state().lastSeq })).ok, false);
  f.put([{ kind: "undo", target: heard.seq }]);
  assert.equal((await ops.budget(ctx, f.id, 20, { saidSeq: heard.seq })).ok, false);
  assert.equal(f.state().budget.usd, 20);
});

test("README checklists show done, next, owner and acceptance; no section asks for a plan; watch keeps reader steps", async () => {
  const f = fixture();
  const file = path.join(f.w.ctx.policy.workDir, f.id, "README.md");
  assert.match(readFileSync(file, "utf8"), /写步骤和估算 → 他批/);
  writeFileSync(file, "## 步骤\n\n- [x] 设计（谁：我；验收：设计批准）\n- [ ] 实现（谁：派；验收：相关测试通过）\n- [ ] 部署（谁：他；验收：批准）\n\n## 决定\n- [ ] 不属于步骤\n");
  assert.equal(workSteps(f.state(), f.w.ctx.policy).length, 3);
  const result = await ops.brief(f.main(), f.id, { chat: true });
  assert.match(result.text, /前面 1 步已完成/);
  assert.match(result.text, /实现（谁：派；验收：相关测试通过）/);
  assert.match(result.text, /部署（谁：他；验收：批准）/);
  writeFileSync(file, "## 决定\n- [ ] 假步骤\n");
  assert.match(stepLines(f.state(), f.w.now(), f.w.ctx.policy).join("\n"), /还没有步骤/);
  const watching = { ...f.state(), modeExplicit: true, mode: "watch", stepRead: { at: new Date(f.w.now()).toISOString(), steps: [{ title: "外部读数", state: "now", who: "wait" }] } };
  assert.match(stepLines(watching, f.w.now(), f.w.ctx.policy).join("\n"), /外部读数/);
});

test("chat, live flow and dispatch increments add up; unknown costs are named without estimates", () => {
  const f = fixture();
  f.put([{ kind: "chat.turn", agentId: "main-chat", usd: 1, usdTotal: 1 }, { kind: "dispatched", agentId: "worker" }, { kind: "dispatch.cost", agentId: "worker", usd: 2, usdTotal: 2, unknown: false }, { kind: "dispatched", agentId: "unknown-worker" }, { kind: "flow", flow: "build", runId: "flow-one" }]);
  f.w.ctx.flowNow.set("flow-one", { st: { costUsd: 3 } });
  assert.deepEqual(spendOf(f.state(), f.w.ctx.flowNow), { usd: 6, unknown: 1 });
  assert.match(budgetText(f.w.ctx, f.state()), /另有 1 个会话花费不明/);
});

test("no budget, exhausted budget and expiry refuse dispatch and flow before launching; watching is exempt", async () => {
  const f = fixture();
  const ctx = f.main();
  for (const entries of [[], [{ kind: "budget", usd: 1 }, { kind: "chat.turn", agentId: "main-chat", usd: 1 }], [{ kind: "budget", usd: 100, until: "2026-11-01" }]]) {
    f.put(entries);
    const before = f.w.calls().length;
    assert.match((await dispatch(ctx, f.id, {})).text || "", /额度/);
    assert.match((await ops.flow(ctx, f.id, "example")).text, /额度/);
    assert.equal(f.w.calls().slice(before).filter((c) => c[0] === "run").length, 0);
  }
  f.put([{ kind: "mode", mode: "watch" }]);
  assert.equal(budgetGate(ctx, f.state()), "");
});

test("80 percent asks once for each grant, including after a restart", () => {
  const f = fixture();
  f.put([{ kind: "budget", usd: 10 }, { kind: "chat.turn", agentId: "main-chat", usd: 8 }]);
  const q = budgetQuestion(f.w.ctx, f.state());
  assert.ok(q);f.put([q]);
  assert.equal(budgetQuestion(f.w.ctx, f.state()), null);
  f.put([{ kind: "budget", usd: 9 }]);
  assert.ok(budgetQuestion(f.w.ctx, f.state()));
});

test("an answered budget card grants its exact option, while stop blocks new spending", async () => {
  const f = fixture();f.put([{ kind: "budget", usd: 10 }, { kind: "chat.turn", agentId: "main-chat", usd: 8 }]);
  let q = budgetQuestion(f.w.ctx, f.state())!;f.put([q]);
  assert.ok((await ops.answer(f.w.ctx, f.id, q.id, "加到 $20", "panel")).ok);
  assert.equal(f.state().budget.usd, 20);
  f.put([{ kind: "chat.turn", agentId: "main-chat", usd: 8 }]);
  q = budgetQuestion(f.w.ctx, f.state())!;f.put([q]);
  assert.ok((await ops.answer(f.w.ctx, f.id, q.id, "先停", "panel")).ok);
  assert.match(budgetGate(f.w.ctx, f.state()), /先停/);
});

test("mode and cumulative money appear in status, index and panel with README steps", () => {
  const f = fixture();f.put([{ kind: "budget", usd: 10 }, { kind: "chat.turn", agentId: "main-chat", usd: 2 }]);refreshWork(f.w.ctx, f.state());
  assert.match(readFileSync(path.join(f.w.ctx.policy.workDir, f.id, "status.md"), "utf8"), /mode: "drive"/);
  assert.match(readFileSync(path.join(f.w.ctx.policy.workDir, "INDEX.md"), "utf8"), /我来推/);
  const panel = panelOf(f.w.root, f.state(), f.w.now(), f.w.ctx.policy, linkContext(f.w.ctx.policy, null));
  assert.equal(panel.mode, "我来推");assert.match(panel.steps.join("\n"), /写步骤和估算/);assert.match(panel.spent, /2.0000.*10/);assert.equal(panel.next.text, "");
});

test("ask uses existing questions, permits attached callers and the current main, rejects look and strangers; answers queue progress", async () => {
  const f = fixture();
  const question = { title: "部署吗", line: "检查通过", options: ["部署", "先停"], recommend: "先停", why: "等确认窗口", push: true };
  assert.equal((await ops.ask(f.w.ctx, f.id, question)).ok, false);
  const main = f.main();
  const opened = await ops.ask(main, f.id, question);assert.ok(opened.ok, opened.text);
  assert.equal(f.state().asks.length, 1);assert.match(f.state().asks[0].line, /推荐：先停/);
  const his = await ops.hear(f.w.ctx, f.id, "先停");
  assert.ok((await ops.answer(main, f.id, opened.id, "", "chat", { saidSeq: his.seq })).ok);
  assert.ok(f.state().lines.some((l: any) => l.kind === "drive.ready"));
  f.put([{ kind: "attached", agentId: "attached-chat" }]);process.env.PASEO_AGENT_ID = "attached-chat";
  assert.ok((await ops.ask({ ...f.w.ctx, by: "attached" }, f.id, question)).ok);
  f.put([{ kind: "schedule", scheduleId: "plan" }]);process.env.FAKE_PASEO_LABELS = JSON.stringify({ "paseo.schedule-id": "plan" });
  assert.equal((await ops.ask(f.w.ctx, f.id, question)).ok, false);
});

test("dispatch approves MCP parameters with labels, finish subscription and file-first prompt without creating an agent", async () => {
  const f = fixture();f.put([{ kind: "budget", usd: 20 }]);
  assert.equal((await dispatch(f.w.ctx, f.id, {})).ok, false);
  const ctx = f.main();const calls: string[][] = [];
  ctx.run = async (args: string[]) => { calls.push(args);return { stdout: JSON.stringify(args[0] === "workspace" ? { workspaceId: "other-workspace" } : { agentId: "worker" }), stderr: "", exitCode: 0 }; };
  const contract = path.join(f.w.dir, "contract.md");writeFileSync(contract, "契约");
  const cwd = path.join(f.w.dir, "checkout");
  const made = await dispatch(ctx, f.id, { contract, provider: "claude/example", thinking: "high", mode: "bypassPermissions", cwd });assert.ok(made.ok, made.text);
  assert.equal(calls.length, 1);assert.equal(calls[0][0], "workspace");
  const args = made.createAgent!;
  assert.equal(args.workspaceId, "other-workspace");assert.equal(args.provider, "claude/example");
  assert.deepEqual(args.labels, { "affairs.affair": f.id, "affairs.role": "dispatched" });
  assert.deepEqual(args.settings, { thinkingOptionId: "high", modeId: "bypassPermissions" });assert.equal(args.notifyOnFinish, true);
  assert.equal(args.initialPrompt, `先完整读派活说明 ${contract}，再读这件事的 README ${path.join(f.w.ctx.policy.workDir, f.id, "README.md")}，照说明做。`);
  assert.deepEqual(JSON.parse(made.text!.slice(made.text!.indexOf("{"))), args);
  assert.equal(f.state().dispatched.length, 0);assert.equal(f.state().lines.at(-1).kind, "dispatch.approved");
});

test("session-open creation guard rejects no budget, spent budget, expiry and watch mode; approval is checked again at creation", async () => {
  const f = fixture();const request = { reason: "create", labels: { "affairs.affair": f.id } };
  assert.throws(() => dispatchOpen(f.w.ctx, request), /先请他批额度/);
  f.put([{ kind: "budget", usd: 1 }]);assert.equal(dispatchOpen(f.w.ctx, request), request);
  const contract = path.join(f.w.dir, "contract.md");writeFileSync(contract, "契约");
  assert.ok((await dispatch(f.main(), f.id, { contract, provider: "claude/example" })).ok);
  f.put([{ kind: "chat.turn", agentId: "main-chat", usd: 1 }]);
  assert.throws(() => dispatchOpen(f.w.ctx, request), /额度已用完/);
  f.put([{ kind: "budget", usd: 2, until: "2000-01-01" }]);assert.throws(() => dispatchOpen(f.w.ctx, request), /过期/);
  f.put([{ kind: "budget", usd: 2 }, { kind: "mode", mode: "watch" }]);assert.throws(() => dispatchOpen(f.w.ctx, request), /只有我来推/);
  f.put([{ kind: "mode", mode: "drive" }, { kind: "hold", on: true }]);assert.throws(() => dispatchOpen(f.w.ctx, request), /已停下/);
});

test("session-open leaves unlabelled creations and existing sessions unchanged, including when the plugin is starting", () => {
  const f = fixture();
  for (const reason of ["resume", "refresh", "import"]) {
    const request = { reason, labels: { "affairs.affair": f.id }, env: { keep: "yes" }, mcpServers: { other: {} } };
    assert.equal(dispatchOpen(f.w.ctx, request), request);assert.equal(dispatchOpen(null, request), request);
  }
  const ordinary = { reason: "create", labels: {}, env: { keep: "yes" } };
  assert.equal(dispatchOpen(null, ordinary), ordinary);
  assert.throws(() => dispatchOpen(null, { ...ordinary, labels: { "affairs.affair": f.id } }), /没准备好/);
});

test("tagged agents are discovered across pages and restart, then charged once without an approval receipt", async () => {
  const f = fixture();const queries: any[] = [];
  const worker = { id: "worker", labels: { "affairs.affair": f.id, "affairs.role": "dispatched" }, provider: "claude", model: "example", workspaceId: "workspace", lastUsage: { totalCostUsd: 2 } };
  const oldMain = { ...worker, id: "old-main", labels: { "affairs.affair": f.id, "affairs.chat": f.id } };
  const paseo = { agents: {
    list: async (q: any) => { queries.push(q);return { entries: q.page.cursor ? [{ agent: worker }] : [{ agent: oldMain }], pageInfo: { nextCursor: q.page.cursor ? null : "second" } }; },
    ref: (id: string) => { assert.equal(id, "worker", "legacy main already has chat.turn accounting");return { refresh: async () => ({ agent: worker }) }; },
  } };
  await dispatchCosts(f.w.ctx, f.id, paseo);await dispatchCosts(f.w.ctx, f.id, paseo);
  assert.deepEqual(queries[0].filter, { labels: { "affairs.affair": f.id }, includeArchived: true });
  assert.equal(f.state().dispatched.length, 1);assert.equal(f.state().dispatched[0].model, "claude/example");
  assert.equal(f.state().lines.filter((l: any) => l.kind === "dispatch.cost").length, 1);
  assert.deepEqual(spendOf(f.state()), { usd: 2, unknown: 0 });
});

test("dispatched cumulative dollars only add increments and never treat an idle middle turn as a hand-in", async () => {
  const f = fixture();f.put([{ kind: "dispatched", agentId: "worker" }]);
  let usage: any = { totalCostUsd: 2 };
  const paseo = { agents: { list: emptyDirectory, ref: () => ({ refresh: async () => ({ agent: { status: "idle", lastUsage: usage } }) }) } };
  await dispatchCosts(f.w.ctx, f.id, paseo);await dispatchCosts(f.w.ctx, f.id, paseo);
  assert.equal(f.state().lines.filter((l: any) => l.kind === "dispatch.cost").length, 1);
  usage = { totalCostUsd: 3, hasUnknownModelCost: true };await dispatchCosts(f.w.ctx, f.id, paseo);
  assert.deepEqual(spendOf(f.state()), { usd: 3, unknown: 1 });
  usage = undefined;await dispatchCosts(f.w.ctx, f.id, paseo);usage = { totalCostUsd: 3 };await dispatchCosts(f.w.ctx, f.id, paseo);
  assert.deepEqual(spendOf(f.state()), { usd: 3, unknown: 0 }, "a closed snapshot with no usage must not charge the earlier total twice");
  assert.equal(f.state().lines.filter((l: any) => l.kind === "dispatch.told").length, 0);
});

function chatsFixture() {
  const f = fixture();const sent: any[] = [];let busy = false;const worker: any = { status: "idle", pendingPermissions: [] };
  const paseo: any = { agents: { list: emptyDirectory, ref: (id: string) => ({ refresh: async () => ({ agent: id === "worker" ? worker : { status: busy ? "running" : "idle" } }), send: async (text: string, options: any) => { sent.push({ text, ...options }); } }) } };
  const restart = () => createChats({ ctx: f.w.ctx, paseo, state: f.state, write: (_id, entries) => { f.put(entries); }, log: () => {}, changed: () => {}, view: () => null });
  return { ...f, chats: restart(), restart, sent, worker, busy: (value: boolean) => { busy = value; } };
}

test("idle drive reminders wait 12 hours, wait for a busy main and survive restart", async () => {
  const f = chatsFixture();
  await f.chats.tellDrive(f.id);assert.equal(f.sent.length, 0);
  f.w.advance(12 * 3_600_000);f.busy(true);await f.chats.tellDrive(f.id);assert.equal(f.sent.length, 0);
  f.busy(false);await f.chats.tellDrive(f.id);assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /接着推/);await f.restart().tellDrive(f.id);assert.equal(f.sent.length, 1);
});

test("an active flow blocks idle progress using runtime status; its proven end permits a later reminder", async () => {
  const f = chatsFixture();const runtime = path.join(f.w.dir, "runtime.mjs");writeFileSync(runtime, 'console.log(JSON.stringify({state:"running"}));');f.w.ctx.policy.flows = { ...f.w.ctx.policy.flows, orch: runtime };
  f.put([{ kind: "flow", flow: "build", runId: "running-flow" }]);f.w.advance(13 * 3_600_000);
  await f.chats.tellDrive(f.id);assert.equal(f.sent.length, 0);
  f.put([{ kind: "flow.mark", runId: "running-flow", key: "end", outcome: "done", costUsd: 0 }]);f.w.advance(13 * 3_600_000);
  await f.chats.tellDrive(f.id);assert.equal(f.sent.length, 1);
});

test("a newly created drive affair starts its plan immediately and does not claim an answer arrived", async () => {
  const f = chatsFixture();f.put([{ kind: "drive.ready", reason: "created" }]);await f.chats.tellDrive(f.id);
  assert.equal(f.sent.length, 1);assert.match(f.sent[0].text, /先写步骤和估算/);assert.doesNotMatch(f.sent[0].text, /刚答了问题/);
  await f.restart().tellDrive(f.id);assert.equal(f.sent.length, 1);
});

test("waiting asks remind no more than once per day; a real answer resumes progress once", async () => {
  const f = chatsFixture();f.put([{ kind: "asked", id: "q", title: "确认", options: ["好", "停"] }]);
  await f.chats.tellDrive(f.id);assert.equal(f.sent.length, 0);f.w.advance(24 * 3_600_000);
  await f.chats.tellDrive(f.id);await f.chats.tellDrive(f.id);assert.equal(f.sent.length, 1);assert.match(f.sent[0].text, /提醒他/);
  f.w.advance(24 * 3_600_000);await f.chats.tellDrive(f.id);assert.equal(f.sent.length, 2);
  f.put([{ kind: "answered", id: "q", answer: "好" }, { kind: "drive.ready", reason: "answered" }]);
  await f.chats.tellDrive(f.id);await f.chats.tellDrive(f.id);assert.equal(f.sent.length, 3);assert.match(f.sent[2].text, /他刚答了问题/);
});

test("drive opening includes its short handbook and configured pointer, watch does not", () => {
  const f = fixture();f.w.ctx.policy.handbookPath = path.resolve("handbook.md");f.w.ctx.policy.driveHandbook = "private-drive-handbook.md";
  const prompt = chatPrompt(f.w.ctx, f.state());assert.match(prompt, /必须问他的/);assert.match(prompt, /private-drive-handbook.md/);
  const watch = chatPrompt(f.w.ctx, { ...f.state(), mode: "watch", modeExplicit: true });assert.doesNotMatch(watch, /必须问他的|private-drive-handbook.md/);
  assert.ok(Buffer.byteLength(readFileSync("drive.chat.md", "utf8")) <= 2048);
});
