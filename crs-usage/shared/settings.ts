import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export const settingsDefinition = defineSettings({
  id: "crs",
  scope: "host",
  version: 1,
  schema: z.object({
    allowedOrigins: z.array(z.string().url()).default([]),
    providerNames: z.array(z.string().min(1)).default([]),
    // Directory reference only; credentials never belong in settings.
    piConfigDir: z.string().default(""),
    spaPrefix: z
      .string()
      .regex(/^(?:|\/[a-zA-Z0-9_/-]*)$/)
      .default(""),
  }),
});
export type Settings = z.output<typeof settingsDefinition.schema>;
