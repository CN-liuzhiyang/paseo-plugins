import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCarrier } from "../server/carrier";
import { makeWorld } from "./helpers";
import type { Card } from "../shared/model";

// The cards' workspace: found again by the id the journal remembers and its directory, so a
// renamed workspace keeps its cards; only a missing or moved one is made anew, never one that
// could not be looked up.

const dir = path.join(os.tmpdir(), "reconcile-carrier-test", "workspace");
const card = { id: "card_000000000001", title: "#1 外放了吗？" } as Card;

function fakePaseo(existing: { id: string; title: string; directory: string } | null, refreshFails = false) {
  const calls = { created: 0, titled: [] as string[], agents: [] as string[] };
  const handle = (id: string) => ({
    id,
    async refresh() {
      if (refreshFails) throw new Error("daemon busy");
      return existing && existing.id === id ? { id, title: existing.title, workspaceDirectory: existing.directory, archivingAt: null } : null;
    },
    async setTitle(title: string) {
      calls.titled.push(title);
      if (existing) existing.title = title;
      return { title };
    },
    agents: {
      async create(options: { title: string }) {
        calls.agents.push(`${id}:${options.title}`);
        return { id: `agent-${calls.agents.length}` };
      },
    },
  });
  const paseo = {
    workspaces: {
      ref: (id: string) => handle(id),
      async create() {
        calls.created++;
        return handle("ws-new");
      },
    },
    agents: { ref: () => ({ archive: async () => {} }) },
  };
  return { paseo: paseo as never, calls };
}

test("the cards' workspace from before the rename is renamed in place, not replaced", async () => {
  const existing = { id: "ws-old", title: "事务", directory: dir };
  const { paseo, calls } = fakePaseo(existing);
  const remembered: string[] = [];
  const carrier = createCarrier({ paseo, workspaceDir: dir, workspaceId: () => "ws-old", rememberWorkspace: (id) => remembered.push(id), log: () => {} });
  await carrier.raise(card, { title: card.title, brief: "", questions: [] }, 1);
  assert.deepEqual(calls.titled, ["事项追踪"]);
  assert.equal(calls.created, 0, "no second workspace");
  assert.deepEqual(remembered, []);
  assert.deepEqual(calls.agents, ["ws-old:#1 外放了吗？"], "the card goes into the same workspace");
  await carrier.raise(card, { title: card.title, brief: "", questions: [] }, 2);
  assert.deepEqual(calls.titled, ["事项追踪"], "renamed once");
});

test("a workspace that is gone is made anew under the new name", async () => {
  const { paseo, calls } = fakePaseo(null);
  const remembered: string[] = [];
  const carrier = createCarrier({ paseo, workspaceDir: dir, workspaceId: () => "ws-old", rememberWorkspace: (id) => remembered.push(id), log: () => {} });
  await carrier.raise(card, { title: card.title, brief: "", questions: [] }, 1);
  assert.equal(calls.created, 1);
  assert.deepEqual(remembered, ["ws-new"]);
});

test("at the start the workspace gets its new name, before any card", async () => {
  const existing = { id: "ws-old", title: "事务", directory: dir };
  const { paseo, calls } = fakePaseo(existing);
  const carrier = createCarrier({ paseo, workspaceDir: dir, workspaceId: () => "ws-old", rememberWorkspace: () => {}, log: () => {} });
  await carrier.ensure!();
  assert.deepEqual(calls.titled, ["事项追踪"]);
  assert.deepEqual(calls.agents, []);
});

test("a name a person gave the workspace is kept", async () => {
  const existing = { id: "ws-old", title: "我的卡片", directory: dir };
  const { paseo, calls } = fakePaseo(existing);
  const carrier = createCarrier({ paseo, workspaceDir: dir, workspaceId: () => "ws-old", rememberWorkspace: () => {}, log: () => {} });
  await carrier.ensure!();
  await carrier.raise(card, { title: card.title, brief: "", questions: [] }, 1);
  assert.deepEqual(calls.titled, []);
  assert.equal(calls.created, 0);
});

test("failing to look up the workspace is not taken as gone: no second workspace, the card waits", async () => {
  const { paseo, calls } = fakePaseo({ id: "ws-old", title: "事项追踪", directory: dir }, true);
  const remembered: string[] = [];
  const carrier = createCarrier({ paseo, workspaceDir: dir, workspaceId: () => "ws-old", rememberWorkspace: (id) => remembered.push(id), log: () => {} });
  await assert.rejects(carrier.raise(card, { title: card.title, brief: "", questions: [] }, 1), /daemon busy/);
  assert.equal(calls.created, 0);
  assert.deepEqual(remembered, []);
});

test("the same directory written another way (case on Windows) is the same workspace", { skip: process.platform !== "win32" }, async () => {
  const { paseo, calls } = fakePaseo({ id: "ws-old", title: "事项追踪", directory: dir.toUpperCase() });
  const carrier = createCarrier({ paseo, workspaceDir: dir, workspaceId: () => "ws-old", rememberWorkspace: () => {}, log: () => {} });
  await carrier.raise(card, { title: card.title, brief: "", questions: [] }, 1);
  assert.equal(calls.created, 0);
});

test("the engine makes sure of the workspace when it starts, live only", async () => {
  const w = await makeWorld({ start: "2026-10-13 10:00" });
  try {
    assert.equal(w.ensured, 1);
    await w.restart("dry-run");
    assert.equal(w.ensured, 1);
  } finally {
    w.close();
  }
});
