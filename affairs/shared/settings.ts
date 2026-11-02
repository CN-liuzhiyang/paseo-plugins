import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsDefinition = defineSettings({
  id: "affairs",
  scope: "host",
  version: 1,
  schema: z.object({
    // Where the affairs live (one folder each, policy.json beside them). Empty: ~/affairs, or $AFFAIRS_HOME.
    root: z.string().default(""),
  }),
});

export type Settings = z.output<typeof settingsDefinition.schema>;
