// Regenerate fixtures/committee.jsonl: a committee run on the fake executor,
// for readers of the event stream (the visualization plugin) to develop
// against without spending anything.
//
//   node test/make-fixture.mjs
//
// Four rounds at most: both members analyze, the assessor asks a question, one
// member's answer fails (a failed call.end, and the member keeps its
// position), the assessor asks again, both answer, and the third assessment
// converges in round three -- so the fixture holds concurrent calls, a failure, phases
// re-entered, agents announced mid-call, caveats and costs. Local paths are replaced so the file is the
// same on every machine.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFlow } from "../runtime/run.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { fakeExecutor, committeeAnswers } from "./fake-executor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const target = path.join(ROOT, "fixtures", "committee.jsonl");

const logDir = await mkdtemp(path.join(os.tmpdir(), "orch-fixture-"));
const executor = fakeExecutor({
  answer: committeeAnswers({ convergeAt: 3, fail: ["respond:codex/gpt-5.6-sol:1"] }),
  // Claude slower than Codex, as measured on real committees (CONVENTIONS R7).
  delayMs: (request) => (request.provider.startsWith("claude/") ? 120 : 40),
  usd: 0.0123,
});
const result = await runFlow(path.join(ROOT, "flows", "committee.mjs"), {
  input: { question: "Why does the build cache miss on every CI run?", committee: "cheap", rounds: 4, assessor: "worker" },
  roster: await loadRoster([ROLES_DIR]),
  executor,
  logDir,
  cwd: "D:/work/project",
  caller: "fake-caller-agent",
  // Found while the calls run (40-120ms), so the fixture shows call.agent.
  agentProbeDelays: [10, 20, 40],
});

// Only run.start names this machine: `source`, `pid`, `hostname`.
const lines = readEvents(result.events).map((event) =>
  JSON.stringify(
    event.kind === "run.start"
      ? { ...event, source: "/path/to/paseo-plugins/orchestration/flows/committee.mjs", pid: 4242, hostname: "fixture-host" }
      : event,
  ),
);
await writeFile(target, `${lines.join("\n")}\n`, "utf8");
const problems = checkEvents(readEvents(target), { strict: true, complete: true });
if (problems.length > 0) throw new Error(`the fixture does not conform:\n${problems.join("\n")}`);
console.log(`${target}: ${result.outcome}, ${readEvents(target).length} events`);
