// A process that is in the middle of a step that cannot be taken back: it notes that it began, and waits for the file `go` before it finishes.
//
//   node test/line-child.mjs <logDir> <lineage> <runId> <dir>

import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runFlow } from "../runtime/run.mjs";
import { flow } from "../runtime/flow.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";

const [logDir, lineage, runId, dir] = process.argv.slice(2);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await runFlow(
  flow({
    name: "line-child",
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    run: (_, $) =>
      $.step(
        "publish",
        async () => {
          appendFileSync(path.join(dir, "acts.txt"), `${runId}\n`);
          appendFileSync(path.join(dir, "started.txt"), "x");
          while (!existsSync(path.join(dir, "go"))) await wait(20);
          return { ok: true };
        },
        { once: true },
      ),
  }),
  { logDir, lineage, resumeOf: lineage, runId, roster: await loadRoster([ROLES_DIR]), executor: {}, caller: null },
);
