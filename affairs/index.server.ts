import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadPolicy, defaultRoot } from "./server/lib/policy.mjs";
import { makeCtx } from "./server/lib/ops.mjs";
import { settingsDefinition } from "./shared/settings";
import { createConversations } from "./server/conversation";
import { createEngine, type Deliver, type PaseoLike } from "./server/engine";

// Affairs: one thing someone asked to have watched, with a workspace of its own. The affair command writes each
// affair's log; this plugin draws it (the conversation at the top of the workspace, the sidebar title), carries the
// questions, pushes what must reach the person, and takes in the schedules' "run finished" deliveries.

const log = (message: string) => console.error(`affairs: ${message}`);

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);
  // COMPAT(server.paseo, server.deliver, server.registerChannel): fork-only extension points; without them the plugin only draws.
  const host = server as PluginServerContext & {
    readonly paseo?: PaseoApi;
    deliver?: Deliver;
    registerChannel?: (channel: { id: string; label?: string; deliver(delivery: { to: string; status: "succeeded" | "failed"; text: string; agentId: string | null }): Promise<void> }) => void;
  };
  let engine: ReturnType<typeof createEngine> | null = null;
  let disposed = false;
  let generation = 0;

  const conversations = createConversations({
    view: (id) => engine?.view(id) ?? null,
    said: async (id, text, sent) => await engine?.said(id, text, sent),
    answered: async (id, qid, text) => void (await engine?.answered(id, qid, text)),
  });
  server.registerProvider(conversations.registration);

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
    const next = createEngine({ ctx, paseo: paseo ?? null, deliver: typeof host.deliver === "function" ? (channel, message) => host.deliver!(channel, message) : null, refresh: conversations.refresh, log, checkSetup: true });
    engine = next;
    await next.start();
    log(`started (root ${root}${paseo ? "" : ", no server.paseo: nothing is drawn"})`);
  }

  void start().catch((error: unknown) => log(`not started: ${(error as Error).stack ?? error}`));
  const unsubscribe = settings.subscribe(() => void start().catch((error: unknown) => log(`restart failed: ${(error as Error).message}`)));

  return () => {
    disposed = true;
    unsubscribe();
    return engine?.stop();
  };
}
