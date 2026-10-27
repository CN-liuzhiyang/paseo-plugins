import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsDefinition = defineSettings({
  id: "orchestration-ui",
  scope: "host",
  version: 1,
  schema: z.object({
    // Where the runtime writes; runs are read from <logDir>/runs. Empty resolves the way the
    // runtime does: ORCH_LOG_DIR, then logDir in ~/.paseo-orchestration/config.json, then
    // ~/.paseo-orchestration/logs. Set it when the daemon's environment differs from the shell
    // that runs the flows.
    logDir: z.string().default(""),
    // A run with no run.end that has been quiet this long reads as lost, unless an open call's
    // own timeout says it may legitimately take longer.
    staleMinutes: z.number().int().min(1).max(24 * 60).default(15),
    // Where the runtime's orch.mjs is (paseo-plugins/orchestration/runtime/orch.mjs). The list of flows is asked
    // of it -- `orch.mjs list` -- because a plugin is installed on its own and cannot import the runtime. Empty:
    // the page shows the flows that have run, and says the rest cannot be listed.
    orchPath: z.string().default(""),
    // Put a live card for each run into the conversation of the Paseo agent that started it.
    cards: z.boolean().default(true),
  }),
});

export type Settings = z.output<typeof settingsDefinition.schema>;
