import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsDefinition = defineSettings({
  id: "context-files",
  scope: "host",
  version: 1,
  schema: z.object({
    // Absolute paths of the files appended to a new agent's system prompt, in order. Each file is
    // read at the moment the agent is created, so editing one takes effect for the next agent
    // without reloading the plugin.
    files: z.array(z.string()).default([]),
    // Providers that get the files. Providers without a model (the orchestration gate, the
    // reconcile inbox) never get them, whatever is listed here.
    providers: z.array(z.string()).default(["codex", "pi"]),
    // A Claude agent normally reads its own CLAUDE.md files, so the files are not added to it.
    // When CLAUDE.md loading is switched off for the session (CLAUDE_CODE_DISABLE_CLAUDE_MDS in
    // its environment), they are added after all.
    claudeWhenClaudeMdDisabled: z.boolean().default(true),
    // Environment variables added to every Claude session (create and resume), for example
    // CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 to turn off Claude Code's own memory.
    claudeEnv: z.record(z.string(), z.string()).default({}),
    // Only agents whose working directory is inside one of these directories get the files.
    // Empty: all agents. The hook sees no labels, so a directory is the way to scope a test.
    cwdPrefixes: z.array(z.string()).default([]),
    // A file longer than this many bytes is cut there and says so.
    maxFileBytes: z.number().int().min(1024).max(1024 * 1024).default(65536),
  }),
});

export type Settings = z.output<typeof settingsDefinition.schema>;
