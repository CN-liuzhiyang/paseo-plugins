import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCarrier } from "../server/carrier";
import type { Card } from "../shared/model";

// The cards' workspace: found again by the id the journal remembers and its directory, so a
// renamed workspace keeps its cards; only a missing or moved one is made anew.

const dir = path.join(os.tmpdir(), "reconcile-carrier-test", "workspace");
const card = { id: "card_000000000001", title: "#1 外放了吗？" } as Card;

function fakePaseo(existing: { id: string; title: string; directory: string } | null) {
  const calls = { created: 0, titled: [] as string[], agents: [] as string[] };
  const handle = (id: string) => ({
    id,
    async refresh() {
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
