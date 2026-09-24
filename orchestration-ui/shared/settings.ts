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
  }),
});

export type Settings = z.output<typeof settingsDefinition.schema>;
