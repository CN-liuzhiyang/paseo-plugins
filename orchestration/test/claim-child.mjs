// One process of the "two processes, one run id" test: runs the advisor flow on
// a fake executor under the id and log directory it is given, and prints what
// happened as one JSON line. Spends nothing.
//
//   node test/claim-child.mjs <runId> <logDir> [delayMs]

import process from "node:process";
import advisor from "../flows/advisor.mjs";
import { runFlow, RunRefused } from "../runtime/run.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { fakeExecutor } from "./fake-executor.mjs";

const [runId, logDir, delay = "400"] = process.argv.slice(2);
const executor = fakeExecutor({
  delayMs: Number(delay),
  answer: () => ({ verdict: "v", reasoning: "r", recommendation: "do", whatWouldChangeMyMind: "w", confidence: "high" }),
});

try {
  const result = await runFlow(advisor, {
    roster: await loadRoster([ROLES_DIR]),
    executor,
    logDir,
    runId,
    cwd: "C:/work",
    caller: null,
    input: { question: "q", role: "fast" },
  });
  console.log(JSON.stringify({ ran: true, outcome: result.outcome, asks: executor.requests.length }));
} catch (error) {
  console.log(JSON.stringify({ ran: false, refused: error instanceof RunRefused, message: error.message, asks: executor.requests.length }));
}
