import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { panelSchema } from "./panel";

// The client asks the plugin for four things: which workspaces are affairs (to put the 进展 button on them), the
// panel of one, a file of its folder to draw, and to answer a question from its card.

export const listRpc = defineRpc({
  name: "affairs.list",
  input: z.object({}),
  output: z.object({ items: z.array(z.object({ id: z.string(), workspaceId: z.string() })) }),
});

export const panelRpc = defineRpc({
  name: "affairs.panel",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ panel: panelSchema.nullable() }),
});

// One file of the affair's files/ folder: a picture as data to draw (not above a size), a text as its first part, anything
// else as what it is. `path` is where it is on the machine the plugin runs on.
export const fileRpc = defineRpc({
  name: "affairs.file",
  input: z.object({ workspaceId: z.string(), name: z.string() }),
  output: z.object({
    ok: z.boolean(),
    kind: z.enum(["image", "text", "other"]),
    mime: z.string(),
    size: z.number(),
    dataUrl: z.string().optional(),
    text: z.string().optional(),
    truncated: z.boolean(),
    path: z.string(),
  }),
});

export const answerRpc = defineRpc({
  name: "affairs.answer",
  input: z.object({ affairId: z.string(), askId: z.string(), text: z.string() }),
  output: z.object({ ok: z.boolean(), text: z.string() }),
});

export const resumeFlowRpc = defineRpc({
  name: "affairs.resume-flow",
  input: z.object({ affairId: z.string(), runId: z.string(), expect: z.string().regex(/^[0-9a-f]{16}$/) }),
  output: z.object({ ok: z.boolean(), text: z.string() }),
});
