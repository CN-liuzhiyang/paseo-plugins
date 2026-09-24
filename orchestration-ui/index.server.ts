import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listRunsRpc, readRunRpc, statusRpc } from "./shared/rpc";
import { settingsDefinition, type Settings } from "./shared/settings";
import { defaultHome, resolveLogDir } from "./server/logdir";
import { createRunIndex, readRun } from "./server/runs";

// Read-only: this side lists and reads <logDir>/runs/*.jsonl and nothing else. It starts no
// runs, answers no gates, and writes no files.

const DEFAULTS: Settings = { logDir: "", staleMinutes: 15 };

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);
  const index = createRunIndex();

  const current = async (): Promise<Settings> => {
    const state = await settings.read();
    if (state.status === "ready") return state.values;
    console.error(`orchestration-ui: settings are invalid, using defaults: ${state.error}`);
    return DEFAULTS;
  };
  const where = async () => {
    const values = await current();
    const resolved = await resolveLogDir({ override: values.logDir, env: process.env, home: defaultHome() });
    return { resolved, staleMs: values.staleMinutes * 60_000 };
  };

  server.handle(listRunsRpc, async ({ limit }) => {
    const { resolved, staleMs } = await where();
    if (!resolved.ok) return { state: "config" as const, detail: resolved.detail, logDir: null, runs: [], total: 0, staleMs };
    const listed = await index.list(resolved.info.runsDir, limit, staleMs);
    return { ...listed, logDir: resolved.info, staleMs };
  });

  server.handle(readRunRpc, async ({ runId, offset, probe }) => {
    const { resolved, staleMs } = await where();
    if (!resolved.ok) {
      return {
        state: "config" as const,
        detail: resolved.detail,
        events: [],
        badLines: [],
        nextOffset: offset,
        size: 0,
        reset: false,
        more: false,
        staleMs,
        process: null,
      };
    }
    return { ...(await readRun(resolved.info.runsDir, runId, offset, { check: probe })), staleMs };
  });

  server.handle(statusRpc, async () => {
    const { resolved } = await where();
    return resolved.ok ? { logDir: resolved.info, detail: "" } : { logDir: null, detail: resolved.detail };
  });

  return () => {};
}
