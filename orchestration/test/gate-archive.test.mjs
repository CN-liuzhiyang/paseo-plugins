// A card that was answered (yes, no) has its carrier agent archived, so its tab goes; one that could not be archived is a caveat and
// the run goes on.
//
//   node --test test/gate-archive.test.mjs        (from orchestration/)

import "./hermetic.mjs";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { flow } from "../runtime/flow.mjs";
import { runFlow } from "../runtime/run.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const carding = flow({ name: "carder", description: "d", phases: [], inputs: {}, grants: ["gate:deny"], run: async (_, $) => ({ outcome: (await $.gate({ title: "approve it?", content: "x\n", timeout: "1m" })).outcome }) });

const run = async (executor) => {
  const logDir = await tempDir("orch-gatearchive-");
  const result = await runFlow(carding, { roster, logDir, cwd: "C:/work", caller: null, gatePollMs: 5, executor });
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return { result, events };
};
const archives = (events) => events.filter((e) => e.kind === "call.archive");

test("an answered card (yes or no) has its carrier archived, and the events say so", async () => {
  for (const [carrier, outcome] of [["approve", "allowed"], ["typed", "denied"]]) {
    const executor = fakeExecutor({ carrier });
    const { result, events } = await run(executor);
    assert.equal(result.outcome, "done");
    assert.equal(result.value.outcome, outcome);
    assert.equal(executor.archivedAgents.length, 1, carrier);
    const [archive] = archives(events);
    assert.deepEqual([archive.ok, archive.code, archive.agentId], [true, null, executor.archivedAgents[0]]);
    assert.deepEqual(result.caveats.filter((c) => c.startsWith("archive:")), []);
  }
});

test("a carrier that cannot be archived is a caveat, and the run still comes out as the person decided", async () => {
  const executor = fakeExecutor({ carrier: "approve", archiveFails: "refuse" });
  const { result, events } = await run(executor);
  assert.equal(result.outcome, "done");
  assert.equal(result.value.outcome, "allowed");
  assert.deepEqual(executor.archivedAgents, []);
  assert.equal(archives(events)[0].ok, false);
  assert.equal(result.caveats.filter((c) => c.startsWith("archive:")).length, 1);
});

test("a card nobody answered (the run is stopped under it) is not archived by this", async () => {
  const executor = fakeExecutor({ carrier: "hang" });
  const logDir = await tempDir("orch-gatearchive-");
  const result = await runFlow(carding, { roster, logDir, cwd: "C:/work", caller: null, gatePollMs: 5, executor, timeout: "1s" }).catch((e) => ({ error: e }));
  assert.equal(result.outcome === "done", false);
  assert.deepEqual(executor.archivedAgents, []);
});
