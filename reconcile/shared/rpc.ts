import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// The screen asks the daemon side for one thing, the controller's status (server/engine.ts
// status()), and can ask it to reconcile now or to release a held rules change. The status is
// typed on the client from the server's own type; the wire schema only says it is an object.

export const overviewRpc = defineRpc({
  name: "reconcile.overview",
  input: z.object({}),
  output: z.object({
    state: z.enum(["running", "config", "stopped"]),
    detail: z.string(),
    status: z.record(z.string(), z.unknown()).nullable(),
  }),
});

export const tickRpc = defineRpc({
  name: "reconcile.tick",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), detail: z.string() }),
});

export const testCardRpc = defineRpc({
  name: "reconcile.test-card",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), detail: z.string() }),
});

export const releaseRulesRpc = defineRpc({
  name: "reconcile.rules.release",
  input: z.object({ fingerprint: z.string() }),
  output: z.object({ ok: z.boolean(), detail: z.string() }),
});
