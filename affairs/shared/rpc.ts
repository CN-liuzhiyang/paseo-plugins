import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { panelSchema } from "./panel";

// The client asks the plugin for three things: which workspaces are affairs (to put the 进展 button on them), the
// panel of one, and to answer a question from its card.

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

export const answerRpc = defineRpc({
  name: "affairs.answer",
  input: z.object({ affairId: z.string(), askId: z.string(), text: z.string() }),
  output: z.object({ ok: z.boolean(), text: z.string() }),
});
