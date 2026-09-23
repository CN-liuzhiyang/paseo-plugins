import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// What the settings screen asks the daemon side. Settings themselves are read and written
// through the settings RPCs Paseo registers for `settingsDefinition`; these only report.

export const statusRpc = defineRpc({
  name: "feishu.status",
  input: z.object({}),
  output: z.object({
    /** unsupported: no server.paseo on this host. unconfigured: no lark-cli or profile. */
    state: z.enum(["unsupported", "unconfigured", "invalid", "connecting", "listening"]),
    detail: z.string(),
    /** Messages turned away lately, newest first, so an operator can let them in. */
    strangers: z.array(
      z.object({
        senderId: z.string(),
        chatId: z.string(),
        chatType: z.enum(["p2p", "group"]),
        why: z.enum(["sender", "route"]),
        at: z.number(),
      }),
    ),
  }),
});

const choice = z.object({ id: z.string(), label: z.string() });

export const choicesRpc = defineRpc({
  name: "feishu.choices",
  input: z.object({}),
  output: z.object({
    providers: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        models: z.array(choice.extend({ thinking: z.array(choice) })),
        modes: z.array(choice),
      }),
    ),
  }),
});
