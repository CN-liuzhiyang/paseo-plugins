import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadPolicy, defaultRoot } from "./server/lib/policy.mjs";
import { makeCtx } from "./server/lib/ops.mjs";
import { settingsDefinition } from "./shared/settings";
import { answerRpc, fileRpc, listRpc, panelRpc } from "./shared/rpc";
import type { PanelData } from "./shared/panel";
import { createEngine, type Deliver, type PaseoLike } from "./server/engine";

// Affairs: one thing someone asked to have watched, with a workspace of its own. The affair command writes each
// affair's log; this plugin keeps the chat of each affair (a real session of the model), draws into it what happened
// and the question waiting, serves the 进展 panel beside it, pushes what must reach the person, and takes in the
// schedules' "run finished" deliveries.

const log = (message: string) => console.error(`affairs: ${message}`);

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);
  // COMPAT(server.paseo, server.deliver, server.registerChannel): fork-only extension points; without them the plugin only serves the panel.
  const host = server as PluginServerContext & {
    readonly paseo?: PaseoApi;
    deliver?: Deliver;
    registerChannel?: (channel: { id: string; label?: string; deliver(delivery: { to: string; status: "succeeded" | "failed"; text: string; agentId: string | null }): Promise<void> }) => void;
  };
  let engine: ReturnType<typeof createEngine> | null = null;
  let disposed = false;
  let generation = 0;

  server.handle(listRpc, () => ({ items: engine?.affairs() ?? [] }));
  server.handle(panelRpc, ({ workspaceId }) => ({ panel: (engine?.panel(workspaceId) ?? null) as PanelData | null }));
  server.handle(fileRpc, ({ workspaceId, name }) => engine?.file(workspaceId, name) ?? { ok: false, kind: "other" as const, mime: "", size: 0, truncated: false, path: "" });
  server.handle(answerRpc, async ({ affairId, askId, text }) => {
    if (!engine) return { ok: false, text: "事项还没准备好" };
    await engine.answered(affairId, askId, text);
    return { ok: true, text: "" };
  });

  host.registerChannel?.({
    id: "affairs",
    label: "事项",
    deliver: async (delivery) => void (await engine?.runEnded(delivery)),
  });

  async function start() {
    const mine = ++generation;
    await engine?.stop();
    engine = null;
    const state = await settings.read();
    if (disposed || mine !== generation) return;
    const root = (state.status === "ready" && state.values.root) || defaultRoot();
    mkdirSync(root, { recursive: true });
    const paseo = host.paseo as unknown as PaseoLike | undefined;
    // A daemon with its own home (a dev instance) is named on the command the looks run, so they reach that one.
    const home = process.env.PASEO_HOME;
    const own = home && path.resolve(home).toLowerCase() !== path.resolve(os.homedir(), ".paseo").toLowerCase();
    const ctx = makeCtx({ root, policy: loadPolicy(root), ...(own ? { paseoHome: home } : {}) });
    const next = createEngine({ ctx, paseo: paseo ?? null, deliver: typeof host.deliver === "function" ? (channel, message) => host.deliver!(channel, message) : null, log, checkSetup: true });
    engine = next;
    await next.start();
    log(`started (root ${root}${paseo ? "" : ", no server.paseo: no chat is kept"})`);
  }

  void start().catch((error: unknown) => log(`not started: ${(error as Error).stack ?? error}`));
  const unsubscribe = settings.subscribe(() => void start().catch((error: unknown) => log(`restart failed: ${(error as Error).message}`)));

  return () => {
    disposed = true;
    unsubscribe();
    return engine?.stop();
  };
}
