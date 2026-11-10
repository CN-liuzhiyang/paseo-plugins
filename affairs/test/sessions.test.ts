import assert from "node:assert/strict";
import { test } from "node:test";
import { createEngine } from "../server/engine";
import { append } from "../server/lib/log.mjs";
import { panelSchema } from "../shared/panel";
import { sessionsOf } from "../server/lib/panel.mjs";
import * as ops from "../server/lib/ops.mjs";
import { world, emptyDirectory } from "./kit";

test("session titles, four states and activity survive archiving and sort by urgency then latest activity", () => {
  const state = { id: "sample", title: "示例事项", chatId: "main" };
  const time = (h: number) => new Date(Date.UTC(2026, 10, 9, h)).toISOString();
  const worker = (id: string, extra: any = {}) => ({ agent: { id, title: `示例事项：${id}`, labels: { "affairs.affair": "sample", "affairs.role": "dispatched" }, status: "idle", createdAt: time(1), ...extra } });
  const list = sessionsOf(state, [
    worker("archived", { archivedAt: time(12), status: "running", updatedAt: time(2) }),
    worker("main", { title: "示例事项：主对话", updatedAt: time(4) }),
    worker("error", { status: "error", archivedAt: time(12), pendingPermissions: [{}], updatedAt: time(5) }),
    worker("waiting", { pendingPermissions: [{}], updatedAt: time(3) }),
    worker("running", { status: "running", updatedAt: time(6) }),
    worker("starting", { status: "initializing", lastUserMessageAt: time(7) }),
    worker("closed", { title: "示例事项：", status: "closed", updatedAt: time(8) }),
    worker("blank", { title: "示例事项：  " }),
    worker("other-title", { title: "另一事项：检查", updatedAt: "invalid", lastUserMessageAt: time(9) }),
    worker("foreign", { labels: { "affairs.affair": "other" } }),
  ]);
  assert.deepEqual(list.map((s: any) => s.agentId), ["waiting", "error", "starting", "running", "other-title", "closed", "main", "archived", "blank"]);
  assert.deepEqual(list.map((s: any) => s.status), ["等你批", "出错", "干活中", "干活中", ...Array(5).fill("做完了")]);
  const byId = (id: string) => list.find((s: any) => s.agentId === id)!;
  assert.equal(byId("archived").title, "archived");
  assert.equal(byId("main").title, "示例事项：主对话");
  assert.equal(byId("closed").title, "示例事项：");
  assert.equal(byId("blank").title, "示例事项：  ");
  assert.equal(byId("other-title").title, "另一事项：检查");
  assert.equal(byId("other-title").at, time(9));
  assert.equal(byId("starting").at, time(7));
  assert.equal(byId("blank").at, time(1));
});

test("related sessions reuse the paged cost scan, include main, roles, status, project and cost, and sort by activity", async () => {
  for (const mode of ["drive", "watch"]) {
    const w = world();const id = "sessions";
    w.file("paseo.json", JSON.stringify({ projects: [], workspaces: [{ workspaceId: "headquarters" }], schedules: [], n: 0 }));
    append(w.root, id, [{ kind: "created", id, title: "改进工具" }, { kind: "mode", mode }, { kind: "workspace", workspaceId: "headquarters" }, { kind: "chat", agentId: "main", why: "first" }], { now: w.now() });
    const snapshots = Array.from({ length: 10 }, (_, i) => ({ agent: {
      id: `worker-${i}`, title: `改进工具：任务 ${i}`, labels: { "affairs.affair": id, "affairs.role": i === 2 ? "flow" : "dispatched" },
      status: i === 0 ? "running" : i === 1 ? "closed" : "idle", pendingPermissions: i === 3 ? [{}] : [], archivedAt: i === 4 ? "yes" : null,
      createdAt: new Date(w.now() - i * 1000).toISOString(), updatedAt: new Date(w.now() + i * 1000).toISOString(), provider: "claude", workspaceId: "code", lastUsage: i === 5 ? undefined : { totalCostUsd: i / 100 },
    }, project: { projectName: "code-project" } }));
    const main = { agent: { id: "main", title: "主对话", labels: {}, status: "closed", updatedAt: new Date(w.now() + 20_000).toISOString() }, project: { projectName: "事项" } };
    let scans = 0;
    const logs: string[] = [];
    const paseo: any = {
      agents: {
        list: async (q: any) => {
          if (!q.filter) return emptyDirectory();
          scans++;assert.equal(q.filter.includeArchived, true);assert.deepEqual(q.filter.labels, { "affairs.affair": id });
          return { entries: q.page.cursor ? snapshots.slice(5) : snapshots.slice(0, 5), pageInfo: { nextCursor: q.page.cursor ? null : "more" } };
        },
        ref: (agentId: string) => ({ refresh: async () => agentId === "main" ? main : snapshots.find((s) => s.agent.id === agentId),
          send: async () => {}, archive: async () => {}, timeline: { append: async () => {}, subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }), refetch: async () => ({ entries: [] }) } }),
      },
      workspaces: { ref: () => ({ setTitle: async () => {}, archive: async () => {}, agents: { create: async () => { throw new Error("main must stay"); } } }) },
    };
    const engine = createEngine({ ctx: w.ctx, paseo, deliver: null, log: (s) => logs.push(s) });
    try {
      await engine.scan(id);
      assert.deepEqual(logs, []);
      const panel = engine.panel("headquarters")!;
      const sessions = (panel as any).sessions;
      assert.equal(sessions.length, 11);assert.equal(sessions[0].agentId, "worker-3");assert.equal(sessions[1].agentId, "worker-0");
      assert.equal(sessions.find((s: any) => s.agentId === "main").role, "主对话");assert.equal(sessions.find((s: any) => s.agentId === "main").project, "事项");
      const byId = (name: string) => sessions.find((s: any) => s.agentId === name);
      assert.equal(byId("worker-2").role, "流程");assert.equal(byId("worker-0").role, "派活");
      for (const [n, status] of [[0, "干活中"], [1, "做完了"], [2, "做完了"], [3, "等你批"], [4, "做完了"]]) assert.equal(byId(`worker-${n}`).status, status);
      assert.equal(byId("worker-9").usd, 0.09);assert.equal(byId("worker-5").usd, undefined);assert.equal(byId("worker-2").project, "code-project");
      assert.ok(panelSchema.safeParse(panel).success);
      for (let i = 0; i < 3; i++) engine.panel("headquarters");
      assert.equal(scans, 2, "panel polling must not list agents again");assert.deepEqual(logs, []);
    } finally { await engine.stop(); }
  }
});

test("done and stopped affairs archive only quiet related sessions, retry busy, permission and archive failures, and keep their workspace", async () => {
  for (const done of [true, false]) {
    const w = world();const id = "put-away";
    w.file("paseo.json", JSON.stringify({ projects: [], workspaces: [{ workspaceId: "headquarters" }], schedules: [], n: 0 }));
    append(w.root, id, [{ kind: "created", id, title: "改进工具" }, { kind: "workspace", workspaceId: "headquarters" }, { kind: "chat", agentId: "main", why: "first" }], { now: w.now() });
    const agents: any[] = [
      { id: "main", status: "idle" }, { id: "closed", status: "closed" }, { id: "running", status: "running" },
      { id: "starting", status: "initializing" }, { id: "permission", status: "idle", pendingPermissions: [{}] },
      { id: "retry", status: "idle" }, { id: "archived", status: "closed", archivedAt: "yes" },
      { id: "foreign", status: "idle", labels: { "affairs.affair": "other" } },
    ].map((a) => ({ ...a, labels: a.labels ?? (a.id === "main" ? {} : { "affairs.affair": id, "affairs.role": "dispatched" }) }));
    let workspaceArchives = 0, creates = 0, refuse = true;const archives: string[] = [];
    const paseo: any = {
      agents: {
        list: async (q: any) => q.filter ? { entries: agents.filter((a) => a.id !== "main").map((agent) => ({ agent })) } : emptyDirectory(),
        ref: (agentId: string) => ({ refresh: async () => ({ agent: agents.find((a) => a.id === agentId) }), archive: async () => {
          if (agentId === "retry" && refuse) throw new Error("temporarily unavailable");
          archives.push(agentId);agents.find((a) => a.id === agentId).archivedAt = "yes";
        }, send: async () => {}, timeline: { append: async () => {}, subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }), refetch: async () => ({ entries: [] }) } }),
      },
      workspaces: { ref: () => ({ setTitle: async () => {}, archive: async () => { workspaceArchives++; }, agents: { create: async () => { creates++;return { id: "unwanted" }; } } }) },
    };
    const engine = createEngine({ ctx: w.ctx, paseo, deliver: null, log: () => {} });
    try {
      assert.ok((await ops.stop(w.ctx, id, { done })).ok);
      await engine.scan(id);assert.deepEqual(archives.sort(), ["closed", "main"]);
      agents.find((a) => a.id === "running").status = "idle";agents.find((a) => a.id === "starting").status = "closed";
      agents.find((a) => a.id === "permission").pendingPermissions = [];refuse = false;
      await engine.scan(id);await engine.scan(id);
      assert.deepEqual(archives.sort(), ["closed", "main", "permission", "retry", "running", "starting"]);
      await engine.stop();
      const restarted = createEngine({ ctx: w.ctx, paseo, deliver: null, log: () => {} });
      w.advance(10 * 86_400_000);await restarted.scan(id);await restarted.stop();
      assert.equal(archives.length, 6, "already archived sessions are not archived again after restart");
      assert.equal(creates, 0);assert.equal(workspaceArchives, 0);assert.equal(engine.panel("headquarters")!.mood, done ? "done" : "stopped");
    } finally { await engine.stop(); }
  }
});
