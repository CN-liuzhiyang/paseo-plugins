import assert from "node:assert/strict";
import { test } from "node:test";
import { cardOf, runCardSchema } from "../shared/card";
import { cardSentence, rowSentence } from "../shared/bar";
import { formatCost } from "../shared/format";
import { foldEvents, costSoFar, runCost } from "../shared/run";
import { summarize } from "./runs";
import { runSummary } from "../shared/rpc";

const time = "2026-01-01T00:00:00.000Z";
function events(costs: unknown[], end?: unknown): unknown[] {
  const rows: unknown[] = [];
  const emit = (kind: string, data: object) => rows.push({ v: 1, seq: rows.length, ts: time, runId: "fixture", kind, ...data });
  emit("run.start", { flow: { name: "cost", phases: [], grants: [], inputs: {} }, input: {} });
  for (const [i, cost] of costs.entries()) {
    emit("call.start", { callId: `c${i}`, type: "ask", name: "cost", title: "检查", provider: "codex/example" });
    emit("call.end", { callId: `c${i}`, agentId: "same-agent", ok: true, durationMs: 1, output: {}, cost });
  }
  if (end !== undefined) emit("run.end", { outcome: "done", durationMs: 2, summary: "完成", cost: end, caveats: [] });
  return rows;
}
const snapshot = (usd: number | null, extra = {}) => ({ usd, inputTokens: 10, outputTokens: 1, ...extra });

test("cost display distinguishes estimate, unknown, incomplete, SDK zero and old numeric costs", () => {
  assert.equal(formatCost(0.87, { source: "local-estimate" }), "约 $0.87");
  assert.equal(formatCost(0.87, { estimated: true }), "约 $0.87");
  assert.equal(formatCost(null), "费用未知");
  assert.equal(formatCost(0, { unknown: true }), "费用未知");
  assert.equal(formatCost(0.87, { incomplete: true, source: "local-estimate" }), "费用未知");
  assert.equal(formatCost(0, { source: "sdk" }), "$0");
  assert.equal(formatCost(1), "$1.00");
});

test("folded snapshots replace per agent totals mid-run, including resets and repeated real estimate", () => {
  for (const [first, last] of [[1, 2], [2, 0.5], [0.8697412, 0.8697412]]) {
    const current = snapshot(last, { source: "local-estimate", scope: "session" });
    const run = foldEvents(events([
      { ...snapshot(first), agentTotal: snapshot(first) },
      { ...snapshot(last >= first ? last - first : last), agentTotal: current },
    ]));
    const total = costSoFar(run);
    assert.equal(total.usd, last);
    assert.equal(total.estimated, true);
    assert.equal(total.uncounted, 0);
    assert.deepEqual(run.calls.get("c1")!.end!.cost!.agentTotal, current);
    const card = cardOf("fixture", run, "running", Date.parse(time))!;
    assert.equal(card.costUsd, last);
    assert.equal(card.costEstimated, true);
    assert.equal(summarize("fixture", run, 1, Date.parse(time), 60_000).costEstimated, true);
  }
});

test("estimated and unknown flags survive fold, summary schema, card schema and both one-line views", () => {
  for (const [cost, label] of [
    [{ totalUsd: 0.8697412, agentCount: 1, partial: "", estimated: true }, "约 $0.87"],
    [{ totalUsd: 0, agentCount: 1, partial: "unknown price", unknown: true }, "费用未知"],
    [{ totalUsd: 0, agentCount: 1, partial: "", estimated: false }, "$0"],
    [{ totalUsd: null, agentCount: 1, partial: "" }, "费用未知"],
  ] as const) {
    const run = foldEvents(events([], cost));
    const summary = runSummary.parse(summarize("fixture", run, 1, Date.parse(time), 60_000));
    const card = runCardSchema.parse(summary.card);
    assert.equal(formatCost(summary.costUsd, { unknown: summary.costUnknown, estimated: summary.costEstimated }), label);
    assert.ok(cardSentence(card, Date.parse(time)).endsWith(label));
    assert.ok(rowSentence(card, Date.parse(time)).endsWith(label));
    assert.equal(formatCost(runCost(run).usd, runCost(run)), label);
  }
});

test("unknown and incomplete snapshots are counted once per agent; SDK zero is known", () => {
  for (const current of [snapshot(null), snapshot(0.5, { incomplete: true })]) {
    const run = foldEvents(events([
      { ...snapshot(1), agentTotal: snapshot(1) },
      { ...snapshot(null), agentTotal: current },
    ]));
    assert.equal(costSoFar(run).uncounted, 1);
    assert.equal(runCost(run).unknown, true);
    const summary = summarize("fixture", run, 1, Date.parse(time), 60_000);
    assert.equal(summary.costUnknown, true);
    assert.equal(formatCost(summary.costUsd, { unknown: summary.costUnknown }), "费用未知");
  }
  const run = foldEvents(events([snapshot(0, { source: "sdk" })]));
  assert.deepEqual(costSoFar(run), { usd: 0, uncounted: 0 });
  assert.equal(runCost(run).unknown, false);
});
