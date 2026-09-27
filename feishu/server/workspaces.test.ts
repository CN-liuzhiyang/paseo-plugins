import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Route } from "../shared/settings";
import { createChatWorkspaces, createWorkspaceAssignments, memoryWorkspaceAssignments } from "./workspaces";

const route: Route = {
  chatId: "oc_person",
  name: "知洋的单聊",
  cwd: "/work",
  provider: "codex/gpt-6-sol",
  modeId: "default",
  instructions: "",
  claudeMd: false,
  replyWithoutMention: false,
  dailyReset: "",
};

function fakePaseo() {
  const snapshots = new Map<string, { id: string; workspaceDirectory: string; title: string; archivingAt: string | null }>();
  const created: string[] = [];
  const renamed: Array<{ id: string; title: string }> = [];
  const agents: Array<{ chatId: string; workspaceId: string; archivedAt: string | null }> = [];
  const ref = (id: string) => ({
    id,
    refresh: async () => snapshots.get(id) ?? null,
    setTitle: async (title: string) => {
      const snapshot = snapshots.get(id);
      if (!snapshot) throw new Error("workspace missing");
      snapshot.title = title;
      renamed.push({ id, title });
    },
    agents: { create: async () => ({ id: "agent" }) },
  });
  const paseo = {
    workspaces: {
      ref,
      create: async ({ source, title }: { source: { path: string }; title: string }) => {
        const id = `wks_${created.length + 1}`;
        snapshots.set(id, { id, workspaceDirectory: source.path, title, archivingAt: null });
        created.push(id);
        return ref(id);
      },
    },
    agents: {
      list: async ({ filter }: { filter: { labels: Record<string, string>; includeArchived?: boolean } }) => ({
        entries: agents
          .filter((agent) => agent.chatId === filter.labels["feishu-chat"])
          .filter((agent) => filter.includeArchived || agent.archivedAt === null)
          .map((agent) => ({ agent })),
      }),
    },
  };
  return { paseo, snapshots, created, renamed, agents };
}

test("each chat keeps a named workspace across plugin reloads, even with the same directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-workspaces-"));
  try {
    const file = path.join(directory, "workspaces.json");
    const fake = fakePaseo();
    const first = createChatWorkspaces({ paseo: fake.paseo as never, assignments: createWorkspaceAssignments(file), log: () => {} });
    const person = await first.forChat(route.chatId, route);
    const group = await first.forChat("oc_group", { ...route, chatId: "oc_group", name: "假期群" });
    assert.notEqual(person.id, group.id);
    assert.equal(fake.snapshots.get(person.id)?.title, "飞书：知洋的单聊");
    assert.equal(fake.snapshots.get(group.id)?.title, "飞书：假期群");

    const restarted = createChatWorkspaces({ paseo: fake.paseo as never, assignments: createWorkspaceAssignments(file), log: () => {} });
    assert.equal((await restarted.forChat(route.chatId, route)).id, person.id);
    assert.equal(fake.created.length, 2);
    assert.equal(JSON.parse(await readFile(file, "utf8")).workspaces[route.chatId], person.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an existing live chat workspace is adopted and renamed on upgrade", async () => {
  const fake = fakePaseo();
  fake.snapshots.set("wks_old", { id: "wks_old", workspaceDirectory: "/work", title: "master", archivingAt: null });
  fake.snapshots.set("wks_current", { id: "wks_current", workspaceDirectory: "/work", title: "master", archivingAt: null });
  fake.agents.push({ chatId: route.chatId, workspaceId: "wks_current", archivedAt: null });
  fake.agents.push({ chatId: route.chatId, workspaceId: "wks_old", archivedAt: "2026-09-26T00:00:00Z" });
  const assignments = memoryWorkspaceAssignments();
  const manager = createChatWorkspaces({ paseo: fake.paseo as never, assignments, log: () => {} });
  assert.equal((await manager.forChat(route.chatId, route)).id, "wks_current");
  assert.equal(await assignments.get(route.chatId), "wks_current");
  assert.deepEqual(fake.renamed, [{ id: "wks_current", title: "飞书：知洋的单聊" }]);
  assert.deepEqual(fake.created, []);
});

test("a chat whose last session was archived still reuses its workspace", async () => {
  const fake = fakePaseo();
  fake.snapshots.set("wks_previous", { id: "wks_previous", workspaceDirectory: "/work", title: "master", archivingAt: null });
  fake.agents.push({ chatId: route.chatId, workspaceId: "wks_previous", archivedAt: "2026-09-26T00:00:00Z" });
  const manager = createChatWorkspaces({ paseo: fake.paseo as never, assignments: memoryWorkspaceAssignments(), log: () => {} });
  assert.equal((await manager.forChat(route.chatId, route)).id, "wks_previous");
  assert.deepEqual(fake.created, []);
});

test("a changed working directory gets a new workspace without reusing the old one", async () => {
  const fake = fakePaseo();
  const assignments = memoryWorkspaceAssignments();
  const manager = createChatWorkspaces({ paseo: fake.paseo as never, assignments, log: () => {} });
  const old = await manager.forChat(route.chatId, route);
  const next = await manager.forChat(route.chatId, { ...route, cwd: "/new-work" });
  assert.notEqual(next.id, old.id);
  assert.equal(fake.snapshots.get(next.id)?.workspaceDirectory, "/new-work");
  assert.equal(await assignments.get(route.chatId), next.id);
});

test("a malformed assignment file is not overwritten", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-workspaces-"));
  try {
    const file = path.join(directory, "workspaces.json");
    await writeFile(file, "not JSON");
    const assignments = createWorkspaceAssignments(file);
    await assert.rejects(assignments.set(route.chatId, "wks_1"));
    assert.equal(await readFile(file, "utf8"), "not JSON");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
