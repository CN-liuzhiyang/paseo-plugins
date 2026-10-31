// The process the journal tests cut off: runs a step that cannot be taken back, which notes that it acted and then dies (or, given
// "live", lets the step finish), in a line whose journal may already hold what a write that was cut off leaves.
//
//   node test/tail-child.mjs <logDir> <lineage> <runId> <actions file> [die | live]

import { appendFileSync } from "node:fs";
import { runFlow } from "../runtime/run.mjs";
import { flow } from "../runtime/flow.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";

const [logDir, lineage, runId, actions, mode = "die"] = process.argv.slice(2);
const result = await runFlow(
  flow({
    name: "tail-child",
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    run: (_, $) =>
      $.step(
        "publish",
        () => {
          appendFileSync(actions, `${runId}\n`);
          if (mode === "die") process.exit(17);
          return { ok: true };
        },
        { once: true },
      ),
  }),
  { logDir, lineage, resumeOf: lineage, runId, roster: await loadRoster([ROLES_DIR]), executor: {}, caller: null },
);
console.log(JSON.stringify({ outcome: result.outcome, stop: result.stop }));
