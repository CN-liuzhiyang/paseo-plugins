import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Every table that grants access ships empty: no senders means nobody gets in,
// no routes means a message from an allowed sender still starts nothing.
export const routeSchema = z.object({
  chatId: z.string().startsWith("oc_"),
  // What people call this chat; shown in the settings screen and told to the agent.
  name: z.string().default(""),
  cwd: z.string().min(1),
  // provider/model, e.g. "claude/claude-sonnet-5".
  provider: z.string().min(1),
  // Required: a provider's default mode can be one that runs tools unasked, and these prompts
  // come from outside. Pick the mode on purpose, e.g. "default" (Always Ask) for Claude.
  modeId: z.string().min(1),
  thinkingOptionId: z.string().min(1).optional(),
  // Standing instructions for this chat's agents, added to their system prompt.
  instructions: z.string().default(""),
  // Whether the agent reads CLAUDE.md files: the daemon user's global one, which can carry
  // private notes anyone in the chat may then read in a reply, and the workspace's own.
  // Claude only; other providers load their own instruction files regardless.
  claudeMd: z.boolean().default(false),
  // "HH:MM" in the daemon host's local time: the first message after it each day starts a new
  // conversation, as `/new` would, and the old one is archived. Empty keeps one conversation.
  dailyReset: z
    .string()
    .regex(/^(?:|(?:[01]\d|2[0-3]):[0-5]\d)$/, "HH:MM, e.g. 05:00")
    .default(""),
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
    // Also who may answer an agent's permission request from its card.
    senders: z.array(z.string().startsWith("ou_")).default([]),
    routes: z.array(routeSchema).default([]),
    // Where approval records go, one JSONL file per day. Empty means
    // <PASEO_HOME>/plugin-data/feishu/audit.
    auditDir: z.string().default(""),
  }),
});

export type Settings = z.output<typeof settingsDefinition.schema>;
export type Route = Settings["routes"][number];
