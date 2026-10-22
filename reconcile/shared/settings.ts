import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsDefinition = defineSettings({
  id: "reconcile",
  scope: "host",
  version: 1,
  schema: z.object({
    // Which deployment this is ("work", "family"); recorded in the journal and the status.
    instanceId: z.string().default(""),
    // The PASEO_HOME this controller is meant to run under. A daemon with another PASEO_HOME
    // (a dev daemon, a second install) only rehearses: it judges but raises no cards.
    home: z.string().default(""),
    // The private config: persons.json, sources.json, policy.json, calendar/, rules/.
    configDir: z.string().default(""),
    // dry-run judges and plans but starts nothing; live raises cards. A wrong home is dry-run whatever this says.
    mode: z.enum(["dry-run", "live"]).default("dry-run"),
    tickSeconds: z.number().int().min(15).max(3600).default(60),
    // Where the journal lives. Empty: <PASEO_HOME>/plugin-data/reconcile.
    dataDir: z.string().default(""),
  }),
});

export type Settings = z.output<typeof settingsDefinition.schema>;
