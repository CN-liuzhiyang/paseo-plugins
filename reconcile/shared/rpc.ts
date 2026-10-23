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

// The page of one item: its stages, who has the ball, what is asked (shared/graph.ts GraphView).
// Typed on the client from the server's own type, like the status.
export const graphRpc = defineRpc({
  name: "reconcile.graph",
  input: z.object({ case: z.string().min(1).max(200) }),
  output: z.object({ ok: z.boolean(), detail: z.string(), graph: z.record(z.string(), z.unknown()).nullable() }),
});

// A question answered on the item's page. It is the same answer as on the question card, and
// whichever arrives first counts: `already` says the other got there first (detail tells what and
// where). `round` is the ask the page showed; one answers an option by its id, or writes words.
export const answerRpc = defineRpc({
  name: "reconcile.answer",
  input: z.object({
    commitmentId: z.string().min(1).max(100),
    round: z.number().int().min(0),
    option: z.string().min(1).max(100).optional(),
    text: z.string().max(2000).optional(),
  }),
  output: z.object({ ok: z.boolean(), already: z.boolean(), detail: z.string() }),
});

export const releaseRulesRpc = defineRpc({
  name: "reconcile.rules.release",
  input: z.object({ fingerprint: z.string() }),
  output: z.object({ ok: z.boolean(), detail: z.string() }),
});
