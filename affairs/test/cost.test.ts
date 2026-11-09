import assert from "node:assert/strict";
import { test } from "node:test";
import { append, fold, load, read } from "../server/lib/log.mjs";
import { budgetOf, budgetText, costIncrement, spendOf } from "../server/lib/drive.mjs";
import { dispatchCosts } from "../server/lib/dispatch.mjs";
import { panelOf, sessionsOf, flowBlockOf } from "../server/lib/panel.mjs";
import { linkContext } from "../server/lib/links.mjs";
import { panelSchema } from "../shared/panel";
import { world, emptyDirectory } from "./kit";

test("cumulative $1 then $2 charges $2; reset, missing, incomplete, SDK zero and old numeric snapshots", () => {
  const first = costIncrement({ totalCostUsd: 1, costSource: "local-estimate" }, null);
  const second = costIncrement({ totalCostUsd: 2, costSource: "local-estimate" }, first.usdTotal);
  assert.equal(first.usd + second.usd, 2);
  assert.equal(second.estimated, true);
  assert.equal(costIncrement({ totalCostUsd: 0.5 }, 2).usd, 0.5);
  for (const usage of [undefined, {}, { totalCostUsd: null }, { totalCostUsd: 3, hasUnknownModelCost: true }]) assert.equal(costIncrement(usage, 2).unknown, true);
  assert.deepEqual(costIncrement(undefined, 2), { usd: 0, usdTotal: 2, unknown: true });
  assert.deepEqual(costIncrement({ totalCostUsd: 0, costSource: "sdk" }, null), { usd: 0, usdTotal: 0, unknown: false, estimated: false });
  assert.deepEqual(costIncrement({ totalCostUsd: 2 }, 1), { usd: 1, usdTotal: 2, unknown: false, estimated: false });
});

test("dispatch records source-only changes once, folds metadata across reloads and preserves the subtotal through missing usage", async () => {
  const w = world();
  const id = "cost";
  append(w.root, id, [{ kind: "created", id, title: "费用" }, { kind: "dispatched", agentId: "worker" }], { now: w.now() });
  let usage: any = { totalCostUsd: 1, costSource: "sdk" };
  const paseo = { agents: { list: emptyDirectory, ref: () => ({ refresh: async () => ({ agent: { lastUsage: usage } }) }) } };
  const scan = () => dispatchCosts(w.ctx, id, paseo);
  const costs = () => read(w.root, id).filter((l: any) => l.kind === "dispatch.cost");
  const state = () => ({ ...load(w.root, id), lines: read(w.root, id) });
  await scan(); await scan();
  assert.equal(costs().length, 1);
  usage = { ...usage, costSource: "local-estimate" };
  await scan(); await scan();
  assert.equal(costs().length, 2);
  assert.equal(costs()[1].usd, 0);
  assert.equal(costs()[1].estimated, true);
  assert.equal(load(w.root, id).dispatched[0].estimated, true);
  assert.deepEqual(spendOf(state()), { usd: 1, unknown: 0, estimated: true });
  usage = { ...usage, costSource: "sdk" };
  await scan(); await scan();
  assert.equal(costs().length, 3);
  assert.equal(costs()[2].estimated, false);
  assert.deepEqual(spendOf(state()), { usd: 1, unknown: 0 });
  usage = { totalCostUsd: 2, costSource: "local-estimate", hasUnknownModelCost: true };
  await scan();
  assert.deepEqual(spendOf(state()), { usd: 2, unknown: 1, estimated: true });
  const beforeMissing = costs().length;
  usage = undefined;
  await scan(); await scan();
  assert.equal(costs().length, beforeMissing, "unchanged missing usage must not append the same metadata repeatedly");
  assert.deepEqual(spendOf(state()), { usd: 2, unknown: 1, estimated: true });
  assert.equal(load(w.root, id).dispatched[0].estimated, true);
  usage = { totalCostUsd: 2 };
  await scan(); await scan();
  assert.deepEqual(spendOf(state()), { usd: 2, unknown: 0 });
  assert.equal(costs().reduce((sum: number, l: any) => sum + l.usd, 0), 2);
});

test("optional dispatch metadata leaves old logs readable and missing metadata retains a known estimate", () => {
  const base = [{ kind: "dispatched", agentId: "worker" }, { kind: "dispatch.cost", agentId: "worker", usd: 1, usdTotal: 1, unknown: false }];
  assert.equal(fold(base).dispatched[0].estimated, undefined);
  const latest = fold([...base, { kind: "dispatch.cost", agentId: "worker", usd: 0, usdTotal: 1, unknown: false, estimated: true }, { kind: "dispatch.cost", agentId: "worker", usd: 0, usdTotal: 1, unknown: true }]).dispatched[0];
  assert.equal(latest.estimated, true);
  assert.equal(latest.unknown, true);
});

test("session amounts and optional estimate flags survive panel schema; missing and incomplete prices omit amounts", () => {
  const w = world();
  append(w.root, "cost", [{ kind: "created", id: "cost", title: "费用" }], { now: w.now() });
  const state = { ...load(w.root, "cost"), lines: read(w.root, "cost") };
  const snapshots = [
    ["estimated", { totalCostUsd: 0.8697412, costSource: "local-estimate" }],
    ["incomplete", { totalCostUsd: 1, costSource: "local-estimate", hasUnknownModelCost: true }],
    ["missing", undefined], ["null", { totalCostUsd: null }],
    ["free", { totalCostUsd: 0, costSource: "sdk" }], ["old", { totalCostUsd: 1 }],
  ].map(([id, lastUsage]) => ({ agent: { id, labels: { "affairs.affair": "cost" }, createdAt: new Date(w.now()).toISOString(), lastUsage } }));
  const result = panelSchema.parse(panelOf(w.root, state, w.now(), w.ctx.policy, linkContext(w.ctx.policy, null), { sessions: snapshots }));
  const byId = (id: string) => result.sessions.find((s) => s.agentId === id)!;
  assert.equal(byId("estimated").usd, 0.8697412);
  assert.equal(byId("estimated").estimated, true);
  for (const id of ["incomplete", "missing", "null"]) assert.equal(byId(id).usd, undefined);
  assert.equal(byId("free").usd, 0);
  assert.equal(byId("free").estimated, undefined);
  assert.equal(byId("old").usd, 1);
  assert.equal(byId("old").estimated, undefined);
  assert.equal(sessionsOf(state, snapshots).length, 6);
  const legacy = { ...result, budget: { usd: 1, cap: 5 }, sessions: [byId("old")] };
  assert.ok(panelSchema.safeParse(legacy).success, "both estimate fields are optional");
});

test("budget estimate metadata survives schema, retains exact unknown-session text and clears when SDK confirms the snapshot", () => {
  const w = world();
  append(w.root, "cost", [
    { kind: "created", id: "cost", title: "费用" }, { kind: "budget", usd: 5 },
    { kind: "chat.turn", agentId: "main", usd: 1, usdTotal: 1, estimated: true },
    { kind: "dispatched", agentId: "unknown" },
  ], { now: w.now() });
  const state = { ...load(w.root, "cost"), lines: read(w.root, "cost") };
  const panel = panelSchema.parse(panelOf(w.root, state, w.now(), w.ctx.policy, linkContext(w.ctx.policy, null)));
  assert.deepEqual(panel.budget, { usd: 1, cap: 5, unknown: 1, estimated: true });
  assert.equal(panel.spent, "已花 $1.0000（含估算） / 已批 $5；另有 1 个会话花费不明");
  assert.deepEqual(budgetOf({}, state), panel.budget);
  const missing = { ...state, lines: [...state.lines, { kind: "chat.turn", agentId: "main", usd: 0, usdTotal: 1, unknown: true }] };
  assert.deepEqual(spendOf(missing), { usd: 1, unknown: 2, estimated: true }, "missing usage keeps the previous subtotal's source");
  const confirmed = { ...state, lines: [...state.lines, { kind: "chat.turn", agentId: "main", usd: 0, usdTotal: 1, estimated: false }] };
  assert.equal(spendOf(confirmed).estimated, undefined);
  assert.ok(!budgetText({}, confirmed).includes("含估算"));
});

test("live and restored flow status flags reach budget and panel cost metadata", () => {
  const state = { flows: [{ runId: "run", flow: "build", at: "2026-01-01T00:00:00.000Z", marks: [], costUsd: null }], lines: [], facts: [] };
  const flowNow = new Map([["run", { st: { state: "running", costUsd: 1, costEstimated: true } }]]);
  assert.deepEqual(spendOf(state, flowNow), { usd: 1, unknown: 0, estimated: true });
  assert.match(flowBlockOf(state, Date.parse("2026-01-01T00:00:01.000Z"), flowNow)!.meta, /约 \$1/);
  flowNow.get("run")!.st = { state: "running", costUsd: 1, costEstimated: true, costUnknown: true } as any;
  assert.equal(spendOf(state, flowNow).unknown, 1);
  assert.ok(!flowBlockOf(state, Date.parse("2026-01-01T00:00:01.000Z"), flowNow)!.meta.includes("$"));
});
