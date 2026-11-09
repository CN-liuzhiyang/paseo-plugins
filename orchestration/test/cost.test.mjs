import "./hermetic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { runFlow } from "../runtime/run.mjs";
import { paseoExecutor } from "../runtime/executor.mjs";
import { runStatus } from "../runtime/status.mjs";
import { flow, define, text } from "../runtime/flow.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

const step = define({ name: "cost", effects: "none", timeout: "1m", returns: { answer: text() }, prompt: () => "answer" });
const snap = (usd, extra = {}) => ({ usd, inputTokens: 100, outputTokens: 10, ...extra });
function midStatus(result, events) {
  writeFileSync(result.events, events.filter((e) => e.kind !== "run.end").map((e) => JSON.stringify(e)).join("\n") + "\n");
  return runStatus({ dir: path.dirname(path.dirname(result.events)), runId: result.runId });
}
async function measure(snapshots, { rounds = false, timeout = false } = {}) {
  let turn = 0;
  const base = fakeExecutor({ answer: () => ({ answer: "first" }) });
  const executor = { ...base,
    send: async () => { turn += 1; return timeout ? new Promise(() => {}) : rounds ? { f1: "fixed" } : { answer: "next" }; },
    inspect: async () => ({ status: "idle", usage: snapshots[turn] }),
  };
  const target = flow({ name: "cost-test", description: "d", phases: [], inputs: {}, grants: [], run: async (_, $) => {
    const first = await $.ask(step, {}, { role: "fast", ...(rounds ? { check: (v) => v.answer === "first" ? [{ at: "/answer", say: "fix" }] : [] } : {}) });
    if (!rounds) await $.again(first, "continue");
  } });
  const result = await runFlow(target, { roster: await loadRoster([ROLES_DIR]), logDir: await tempDir("orch-cost-"), cwd: "C:/work", caller: null, agentProbeDelays: [], executor, ...(timeout ? { timeout: "1s" } : {}) });
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return { result, events };
}

test("两轮累计 $1、$2 不收成 $3", async () => {
  for (const rounds of [false, true]) {
    const { result, events } = await measure([snap(1), snap(2)], { rounds });
    assert.equal(result.outcome, "done");
    assert.equal(result.cost.totalUsd, 2);
    assert.equal(result.cost.agentCount, 1);
    assert.equal(events.findLast((e) => e.kind === "call.end").cost.usd, rounds ? 2 : 1);
    assert.equal(events.findLast((e) => e.kind === "call.end").cost.agentTotal.usd, 2);
  }
});

test("snapshot reset replaces the agent total and starts a new call baseline", async () => {
  const { result, events } = await measure([snap(2), snap(0.5)]);
  assert.equal(result.cost.totalUsd, 0.5);
  assert.equal(events.findLast((e) => e.kind === "call.end").cost.usd, 0.5);
  assert.equal(midStatus(result, events).costUsd, 0.5);
});

test("null and incomplete snapshots mark the run unknown; estimates and SDK zero stay distinct", async () => {
  for (const usage of [snap(null), snap(0.5, { incomplete: true }), null]) {
    const { result, events } = await measure([snap(1), usage]);
    assert.equal(result.cost.unknown, true);
    assert.match(result.cost.partial, /unknown/);
    if (usage?.usd == null) assert.equal(events.findLast((e) => e.kind === "call.end").cost.usd, null);
    assert.equal(midStatus(result, events).costUnknown, true);
  }
  const { result } = await measure([snap(0, { source: "sdk" }), snap(0, { source: "sdk" })]);
  assert.equal(result.cost.totalUsd, 0);
  assert.equal(result.cost.unknown, false);
  assert.equal(result.cost.estimated, false);
});

test("timeout during correction settles only the latest cumulative snapshot", async () => {
  const { result, events } = await measure([snap(1), snap(2)], { rounds: true, timeout: true });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.cost.totalUsd, 2);
  assert.equal(events.findLast((e) => e.kind === "call.end").cost.usd, 2);
});

test("real cumulative snapshot replay stays 0.8697412 and estimated when repeated", async () => {
  const raw = { InputTokens: 3476401, CachedTokens: 3330432, OutputTokens: 24476, CostUsd: 0.8697412, CostSource: "local-estimate", TokenUsageScope: "session" };
  const ex = paseoExecutor({ cli: { runPaseoJson: async () => ({ LastUsage: raw }) } });
  const usage = (await ex.inspect("fixture")).usage;
  assert.equal(usage.inputTokens, 3476401);
  assert.equal(usage.scope, "session");
  const { result, events } = await measure([usage, usage]);
  assert.equal(result.cost.totalUsd, 0.8697412);
  assert.equal(result.cost.estimated, true);
  assert.equal(events.findLast((e) => e.kind === "call.end").cost.usd, 0);
  // An interrupted event stream must agree with the final total.
  const status = midStatus(result, events);
  assert.equal(status.costUsd, 0.8697412);
  assert.equal(status.costEstimated, true);
});

test("executor preserves old numeric usage, null, incomplete and source metadata", async () => {
  for (const [raw, expected] of [
    [{ CostUsd: 0, InputTokens: 2 }, { usd: 0, inputTokens: 2, outputTokens: null }],
    [{ CostUsd: null, HasUnknownModelCost: true, CostSource: "local-estimate", TokenUsageScope: "session" }, { usd: null, inputTokens: null, outputTokens: null, incomplete: true, source: "local-estimate", scope: "session" }],
  ]) {
    const ex = paseoExecutor({ cli: { runPaseoJson: async () => ({ LastUsage: raw }) } });
    assert.deepEqual((await ex.inspect("fixture")).usage, expected);
  }
});
