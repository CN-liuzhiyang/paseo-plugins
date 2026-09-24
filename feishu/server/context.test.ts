import assert from "node:assert/strict";
import { test } from "node:test";
import type { Route } from "../shared/settings";
import { contextOf, createIsolation, systemPrompt } from "./context";

const route: Route = {
  chatId: "oc_1",
  name: "家里",
  cwd: "/home",
  provider: "claude/claude-sonnet-5",
  modeId: "default",
  instructions: "你是家里的管家。",
  claudeMd: false,
  dailyReset: "",
};

test("by default a Claude agent reads no CLAUDE.md, and is labelled so it stays that way", () => {
  assert.deepEqual(contextOf(route), {
    env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
    labels: { "feishu-claude-md": "off" },
  });
  assert.deepEqual(contextOf({ ...route, claudeMd: true }), { env: {}, labels: {} });
  // The switch is Claude's; another provider is left as it is rather than half-configured.
  assert.deepEqual(contextOf({ ...route, provider: "codex/gpt-6" }), { env: {}, labels: {} });
});

test("the system prompt says where the agent is, and carries the route's instructions", () => {
  const p2p = systemPrompt(route, "p2p");
  assert.match(p2p, /飞书单聊「家里」/);
  assert.match(p2p, /你是家里的管家。$/);
  assert.ok(!p2p.includes("群里"));
  const group = systemPrompt({ ...route, instructions: "" }, "group");
  assert.match(group, /群里的每个人都看得到你的回复/);
});

test("an agent labelled without CLAUDE.md opens without it after a restart", async () => {
  const listed: unknown[] = [];
  const isolation = createIsolation(
    {
      agents: {
        list: async (input: unknown) => {
          listed.push(input);
          return {
            entries: [{ agent: { id: "a-old" } }],
            pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
          };
        },
      },
    } as never,
    () => {},
  );
  assert.deepEqual(await isolation.envFor("a-old", { KEEP: "1" }), { KEEP: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
  assert.equal(await isolation.envFor("someone-else", {}), null);
  isolation.add("a-new");
  assert.deepEqual(await isolation.envFor("a-new", {}), { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
  assert.deepEqual((listed[0] as { filter: unknown }).filter, {
    labels: { "feishu-claude-md": "off" },
    includeArchived: true,
  });
});

test("if the list cannot be read, sessions still open", async () => {
  const logs: string[] = [];
  const isolation = createIsolation(
    { agents: { list: async () => Promise.reject(new Error("daemon busy")) } } as never,
    (line) => logs.push(line),
  );
  assert.equal(await isolation.envFor("a", {}), null);
  assert.match(logs.join("\n"), /daemon busy/);
});
