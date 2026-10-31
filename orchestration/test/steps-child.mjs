// The process the steps tests kill: runs commit-then-backfill and dies inside one of its steps, leaving what a run that is cut off leaves.
//
//   node test/steps-child.mjs <logDir> <runId> <dir> <commit | backfill> [<agent to tell when it ends>]

import { runFlow } from "../runtime/run.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { commitThenBackfill } from "./steps-flows.mjs";
import { fakeExecutor } from "./fake-executor.mjs";

const [logDir, runId, dir, dieIn, notify] = process.argv.slice(2);
const result = await runFlow(commitThenBackfill({ dieIn }), {
  logDir,
  runId,
  input: { dir },
  roster: await loadRoster([ROLES_DIR]),
  executor: fakeExecutor({ carrier: "input" }),
  cwd: dir,
  caller: null,
  ...(notify ? { notify } : {}),
  gatePollMs: 5,
});
// Only reached if the flow did not die where it was told to.
console.log(JSON.stringify({ outcome: result.outcome }));
