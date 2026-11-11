import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export function timeoutMs(value: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) return 0;
  return Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000 }[match[2]] ?? 0);
}

export const settingsDefinition = defineSettings({
  id: "automation-flow",
  scope: "host",
  version: 1,
  schema: z.object({
    allowedFlows: z.array(z.string()).default([]),
    orchestrationDir: z.string().min(1).optional(),
    defaultTimeout: z.string().refine((s) => timeoutMs(s) > 0 && timeoutMs(s) <= 3600000, "Use a duration from 1s to 1h").default("30m"),
  }),
});
export type Settings = z.output<typeof settingsDefinition.schema>;
