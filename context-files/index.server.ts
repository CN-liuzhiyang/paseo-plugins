import { readFile } from "node:fs/promises";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { settingsDefinition, type Settings } from "./shared/settings";
import { inject, wantsFiles } from "./server/inject";

// Appends files to the system prompt of every new agent, read when the agent is created. It
// changes nothing else, and a file it cannot read is skipped with a log line: creating an agent
// never fails because of this plugin.

const log = (message: string) => console.error(`context-files: ${message}`);

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);

  const current = async (): Promise<Settings | null> => {
    try {
      const state = await settings.read();
      if (state.status === "ready") return state.values;
      log(`settings are invalid, injecting nothing: ${state.error}`);
    } catch (error) {
      log(`cannot read settings, injecting nothing: ${String(error)}`);
    }
    return null;
  };

  const offCreate = server.before("agent.create", async ({ request }) => {
    try {
      const values = await current();
      if (!values) return;
      const { config } = request;
      const input = { provider: config.provider, cwd: config.cwd, existing: config.systemPrompt, env: request.env };
      if (!wantsFiles(values, input)) return;
      const result = await inject(values, input, (path) => readFile(path));
      for (const { path, why } of result.skipped) log(`skipped ${path}: ${why}`);
      if (result.systemPrompt === undefined) return;
      log(`${config.provider}: added ${result.added.length} file(s)`);
      return { ...request, config: { ...config, systemPrompt: result.systemPrompt } };
    } catch (error) {
      log(`agent.create left unchanged: ${String(error)}`);
      return;
    }
  });

  // The session's environment is not stored with the agent, so this runs on resume too.
  const offOpen = server.before("agent.session_open", async ({ request }) => {
    try {
      if (request.provider.split("/")[0] !== "claude") return;
      const values = await current();
      if (!values || Object.keys(values.claudeEnv).length === 0) return;
      return { ...request, env: { ...request.env, ...values.claudeEnv } };
    } catch (error) {
      log(`agent.session_open left unchanged: ${String(error)}`);
      return;
    }
  });

  return () => {
    offCreate();
    offOpen();
  };
}
