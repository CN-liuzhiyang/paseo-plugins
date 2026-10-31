// A flow that the steps tests run in more than one process: a step that cannot be taken back, authorised by a card that asks for a
// code, and a second one after it. `dieIn` kills the process inside the named step, the way a machine that goes down does.

import { appendFileSync } from "node:fs";
import path from "node:path";
import { flow, text } from "../runtime/flow.mjs";

/**
 * @param {{ dieIn?: "commit" | "backfill" | null, probe?: "none" | "done" | "not-done" }} [options] what the backfill's probe finds
 */
export function commitThenBackfill({ dieIn = null, probe = "none" } = {}) {
  return flow({
    name: "commit-then-backfill",
    description: "d",
    phases: [],
    inputs: { dir: text() },
    grants: ["gate:deny"],
    async run(input, $) {
      const note = (line) => appendFileSync(path.join(input.dir, "log.txt"), `${line}\n`);
      const commit = await $.step(
        "commit",
        (given) => {
          note(`commit with code ${given.input}`);
          if (dieIn === "commit") process.exit(7);
          return { committed: true, revision: 12 };
        },
        {
          once: true,
          // The card that authorises the commit is part of getting to it, not of the act: asked before the step is written as begun.
          before: async () => {
            const given = await $.gate({ title: "approve the commit", content: "the diff", timeout: "1m", input: { label: "code" } });
            if (!given.approved) $.stop("the commit was not approved");
            return given;
          },
        },
      );
      await $.step(
        "backfill",
        () => {
          note(`backfill of ${commit.revision}`);
          if (dieIn === "backfill") process.exit(7);
          return { ok: true, by: "step" };
        },
        {
          once: true,
          ...(probe === "done" ? { probe: () => ({ done: true, value: { ok: true, by: "probe" } }) } : probe === "not-done" ? { probe: () => ({ done: false }) } : {}),
        },
      );
      return { revision: commit.revision };
    },
  });
}
