import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// What the settings screen asks the daemon side. Settings themselves are read and written
// through the settings RPCs Paseo registers for `settingsDefinition`. Members are the plugin's
// own record (server/people.ts), so they are read and changed here, and take effect at once.

const member = z.object({
  openId: z.string(),
  name: z.string(),
  by: z.string(),
  byName: z.string(),
  chatId: z.string(),
  at: z.number(),
});

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
        name: z.string().nullable(),
        chatId: z.string(),
        chatType: z.enum(["p2p", "group"]),
        why: z.enum(["sender", "route"]),
        at: z.number(),
      }),
    ),
    /** People let in from Feishu cards; see server/people.ts. */
    members: z.array(member),
    /** Names for the open_ids on this screen, where Feishu told the plugin one. */
    names: z.record(z.string(), z.string()),
    /** People in the routed chats who are neither admins nor members, to pick from by name. */
    candidates: z.array(z.object({ openId: z.string(), name: z.string(), chatId: z.string() })),
  }),
});

export const addMemberRpc = defineRpc({
  name: "feishu.members.add",
  input: z.object({ openId: z.string().startsWith("ou_"), name: z.string(), chatId: z.string() }),
  output: z.object({}),
});

export const removeMemberRpc = defineRpc({
  name: "feishu.members.remove",
  input: z.object({ openId: z.string() }),
  output: z.object({ removed: z.boolean() }),
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
