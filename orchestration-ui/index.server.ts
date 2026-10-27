import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listFlowsRpc, listRunsRpc, readCardRpc, readRunRpc, statusRpc, RUN_ID, RUN_LIST_LIMIT, type CardsState } from "./shared/rpc";
import { settingsDefinition, type Settings } from "./shared/settings";
import { createCatalog } from "./server/catalog";
import { flowRows } from "./server/flows";
import { createCardFeed, readCard, startCardFeed } from "./server/cards";
import { defaultHome, resolveLogDir } from "./server/logdir";
import { createRunIndex, readRun } from "./server/runs";

// Read-only toward the runs: this side lists and reads <logDir>/runs/*.jsonl and nothing else.
// It starts no runs, answers no gates, and writes no files. The one thing it writes is a card
// per run into the timeline of the Paseo agent that started it (daemon memory, see server/cards.ts).

const DEFAULTS: Settings = { logDir: "", staleMinutes: 15, orchPath: "", cards: true };

const NO_TIMELINE =
  "这个 Paseo 没有给插件 server 提供 server.paseo（目前只有 fork 版有），插件没法往对话里贴卡片。列表和流程视图照常可用。";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);
  const index = createRunIndex();
  const catalog = createCatalog();
  // COMPAT(server.paseo): a fork-only extension point until upstream lands its own shape.
  const paseo = (server as PluginServerContext & { readonly paseo?: PaseoApi }).paseo;

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

  const log = (message: string) => console.error(`orchestration-ui: ${message}`);
  const feed = paseo
    ? createCardFeed({
        append: (agentId, item) => paseo.agents.ref(agentId).timeline.append(item),
        where: async () => {
          const { resolved, staleMs } = await where();
          return { runsDir: resolved.ok ? resolved.info.runsDir : null, staleMs };
        },
        log,
      })
    : null;
  if (!paseo) log(NO_TIMELINE);

  let running: ReturnType<typeof startCardFeed> | null = null;
  let disposed = false;
  let cards: CardsState = { state: "unavailable", detail: NO_TIMELINE };
  const applySettings = async () => {
    if (!feed) return;
    const values = await current();
    // Stopped while the settings were read: starting now would leave timers nobody stops.
    if (disposed) return;
    if (values.cards) {
      if (running) running.rescan(); // logDir may have changed.
      else running = startCardFeed(feed, { log });
      cards = { state: "on", detail: "" };
    } else {
      running?.stop();
      running = null;
      cards = { state: "off", detail: "设置里关掉了：新的流程不再往发起对话里贴卡片。" };
    }
  };
  void applySettings();
  const unsubscribe = settings.subscribe(() => applySettings());

  server.handle(listRunsRpc, async ({ limit }) => {
    const { resolved, staleMs } = await where();
    if (!resolved.ok) return { state: "config" as const, detail: resolved.detail, logDir: null, runs: [], total: 0, staleMs };
    const listed = await index.list(resolved.info.runsDir, limit, staleMs);
    return { ...listed, logDir: resolved.info, staleMs };
  });

  server.handle(listFlowsRpc, async () => {
    const values = await current();
    const { resolved, staleMs } = await where();
    // The runs only say how each flow has gone; a log directory that cannot be read does not stop the list of flows.
    const runs = resolved.ok ? await index.list(resolved.info.runsDir, RUN_LIST_LIMIT, staleMs).catch(() => null) : null;
    return { ...flowRows(await catalog.get(values.orchPath), runs?.runs ?? []), orchPath: values.orchPath.trim() || null };
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

  server.handle(readCardRpc, async ({ runId }) => {
    // Only while the feed runs: a stopped feed keeps its last cards, which would never change again.
    const followed = running ? feed?.card(runId) : null;
    if (followed) return { state: "ok" as const, detail: "", card: followed };
    const { resolved, staleMs } = await where();
    if (!resolved.ok) return { state: "config" as const, detail: resolved.detail, card: null };
    if (!RUN_ID.test(runId)) return { state: "missing" as const, detail: "", card: null };
    try {
      return { state: "ok" as const, detail: "", card: await readCard(resolved.info.runsDir, runId, staleMs) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { state: "missing" as const, detail: `找不到流程 ${runId}`, card: null };
      return { state: "unreadable" as const, detail: String(error), card: null };
    }
  });

  server.handle(statusRpc, async () => {
    const { resolved } = await where();
    return resolved.ok ? { logDir: resolved.info, detail: "", cards } : { logDir: null, detail: resolved.detail, cards };
  });

  return () => {
    disposed = true;
    unsubscribe();
    running?.stop();
    running = null;
  };
}
