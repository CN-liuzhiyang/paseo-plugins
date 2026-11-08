import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { snapshotSchema } from "./snapshot";
export const inputSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) });
export const identitySchema = z.object({ id: z.string(), providers: z.array(z.string()) });
export const panelEntrySchema = identitySchema.extend({
  snapshot: snapshotSchema.nullable(),
  error: z.string().nullable(),
  successfulAt: z.string().nullable(),
  retryAt: z.string().nullable(),
  links: z.object({
    usage: z.string(),
    keys: z.string().nullable(),
    accounts: z.string().nullable(),
  }),
});
export type PanelEntry = z.infer<typeof panelEntrySchema>;
export const discoverRpc = defineRpc({
  name: "crs.discover",
  input: z.object({}),
  output: z.array(identitySchema),
});
export const panelRpc = defineRpc({
  name: "crs.panel",
  input: z.object({}),
  output: z.array(panelEntrySchema),
});
