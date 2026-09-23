import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Every table that grants access ships empty: no senders means nobody gets in,
// no routes means a message from an allowed sender still starts nothing.
const route = z.object({
  chatId: z.string().startsWith("oc_"),
  cwd: z.string().min(1),
  // provider/model, e.g. "claude/claude-sonnet-5".
  provider: z.string().min(1),
  // Required: a provider's default mode can be one that runs tools unasked, and these prompts
  // come from outside. Pick the mode on purpose, e.g. "default" (Always Ask) for Claude.
  modeId: z.string().min(1),
  thinkingOptionId: z.string().min(1).optional(),
});

export const settingsDefinition = defineSettings({
  id: "feishu",
  scope: "host",
  version: 1,
  schema: z.object({
    // Absolute path to the lark-cli executable. On Windows point at the native
    // bin/lark-cli.exe inside the npm package, not the .cmd shim: spawning a
    // shim needs a shell, and a shell breaks both argument quoting and shutdown.
    larkCli: z.string().default(""),
    // lark-cli profile holding the bot's credentials; they never pass through here.
    profile: z.string().default(""),
    senders: z.array(z.string().startsWith("ou_")).default([]),
    routes: z.array(route).default([]),
  }),
});

export type Settings = z.output<typeof settingsDefinition.schema>;
export type Route = Settings["routes"][number];
