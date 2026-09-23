import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { choicesRpc, statusRpc } from "./shared/rpc";
import { settingsDefinition, type Settings } from "./shared/settings";
import { createAudit, defaultAuditDir } from "./server/audit";
import { consume, type Consumer } from "./server/consumer";
import { createIsolation, isClaude } from "./server/context";
import { createDispatcher, larkOf, type Dispatcher, type Stranger } from "./server/dispatcher";
import { readIncoming } from "./server/inbound";
import { fetchMessages } from "./server/lark";

const log = (line: string) => console.log(`feishu: ${line}`);
const REMEMBERED_STRANGERS = 20;

type Status = RpcOutput<typeof statusRpc>;

/** Where a message's attachments are downloaded: <PASEO_HOME>/plugin-data/feishu/media/... */
function mediaRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"), "plugin-data", "feishu", "media");
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);
  const strangers: Stranger[] = [];

  // COMPAT(server.paseo): a fork-only extension point until upstream lands its own shape.
  // Feishu messages arrive from outside Paseo, so no hook or handler hands this plugin the API.
  const paseo = (server as PluginServerContext & { readonly paseo?: PaseoApi }).paseo;
  if (!paseo) {
    log("this Paseo host does not provide server.paseo; the plugin does nothing");
    server.handle(statusRpc, (): Status => ({
      state: "unsupported",
      detail: "这个 Paseo 版本没有 server.paseo 扩展点，插件不工作。",
      strangers: [],
    }));
    server.handle(choicesRpc, () => ({ providers: [] }));
    return () => {};
  }

  const readSettings = async (): Promise<Settings | null> => {
    const state = await settings.read();
    if (state.status === "ready") return state.values;
    log(`settings are invalid: ${state.error}`);
    return null;
  };

  const audit = createAudit({
    dir: async () => (await readSettings())?.auditDir || defaultAuditDir(),
    log,
  });

  // Agents created without CLAUDE.md stay that way every time their session opens again.
  const isolation = createIsolation(paseo, log);
  server.before("agent.session_open", async ({ request }) => {
    if (!isClaude(request.provider)) return;
    const env = await isolation.envFor(request.agentId, request.env);
    return env ? { ...request, env } : undefined;
  });

  let active: { key: string; consumers: Consumer[]; dispatcher: Dispatcher } | null = null;
  let stopped = false;

  const stopActive = async () => {
    const current = active;
    active = null;
    if (!current) return;
    current.dispatcher.stop();
    await Promise.all(current.consumers.map((consumer) => consumer.stop()));
  };

  // Senders and routes are read on every message, so editing them needs nothing here. Only the
  // lark-cli path and profile decide whether the consumer has to be replaced.
  const apply = async () => {
    const values = await readSettings();
    const key = values ? JSON.stringify([values.larkCli, values.profile]) : "";
    if (stopped || active?.key === key) return;
    await stopActive();
    if (!values || values.larkCli === "" || values.profile === "") {
      log("not configured: set larkCli and profile in the plugin settings");
      return;
    }
    const cli = { path: values.larkCli, profile: values.profile };
    const dispatcher = createDispatcher({
      paseo,
      lark: larkOf(cli),
      readSettings,
      log,
      audit,
      readIncoming: (event, options) =>
        readIncoming(
          event,
          {
            fetch: (ids, dir) => fetchMessages(cli, ids, dir),
            mediaDir: (chatId, messageId) => path.join(mediaRoot(), chatId, messageId),
          },
          options,
        ),
      isolate: isolation.add,
      onStranger: (stranger) => {
        const known = strangers.findIndex(
          (seen) => seen.senderId === stranger.senderId && seen.chatId === stranger.chatId,
        );
        if (known !== -1) strangers.splice(known, 1);
        strangers.unshift(stranger);
        strangers.length = Math.min(strangers.length, REMEMBERED_STRANGERS);
      },
    });
    const messages = consume({
      cli,
      eventKey: "im.message.receive_v1",
      onEvent: (event) => {
        void dispatcher.onMessage(event).catch((error: unknown) => log(`message: ${String(error)}`));
      },
      log,
    });
    // Button clicks on cards. Feishu hands each callback to one consumer per app, and lark-cli
    // acknowledges it; the card changes when this plugin patches it.
    const clicks = consume({
      cli,
      eventKey: "card.action.trigger",
      onEvent: (event) => {
        void dispatcher
          .onCardAction(event)
          .catch((error: unknown) => log(`card action: ${String(error)}`));
      },
      log,
    });
    active = { key, consumers: [messages, clicks], dispatcher };
  };

  let applying = Promise.resolve();
  const reapply = () => {
    applying = applying.then(apply).catch((error: unknown) => log(`apply settings: ${String(error)}`));
  };
  reapply();
  const unsubscribe = settings.subscribe(reapply);

  server.handle(statusRpc, async (): Promise<Status> => {
    const state = await settings.read();
    const known = strangers.map((stranger) => ({ ...stranger }));
    if (state.status !== "ready") return { state: "invalid", detail: state.error, strangers: known };
    const { larkCli, profile } = state.values;
    if (larkCli === "" || profile === "") {
      return { state: "unconfigured", detail: "填好 lark-cli 路径和 profile 才会开始收消息。", strangers: known };
    }
    const consumers = active?.consumers ?? [];
    if (consumers.length > 0 && consumers.every((consumer) => consumer.listening())) {
      return { state: "listening", detail: `正在用 profile「${profile}」收消息和卡片回调。`, strangers: known };
    }
    const why = consumers.map((consumer) => consumer.lastWords()).find((words) => words !== "") ?? "";
    return { state: "connecting", detail: why === "" ? "正在连接飞书……" : why, strangers: known };
  });

  server.handle(choicesRpc, async () => {
    // Right after the daemon starts, providers are still being discovered.
    const snapshot = await paseo.providers.waitForReady({ timeoutMs: 10_000 }).catch(() => paseo.providers.snapshot());
    const thinkingSets = snapshot.compactSnapshot?.thinkingSets ?? [];
    const compact = new Map((snapshot.compactSnapshot?.entries ?? []).map((entry) => [entry.provider, entry]));
    const providers = snapshot.entries
      .filter((entry) => entry.enabled !== false && entry.status === "ready")
      .map((entry) => {
        const models =
          entry.models?.map((model) => ({
            id: model.id,
            label: model.label,
            thinking: (model.thinkingOptions ?? []).map(({ id, label }) => ({ id, label })),
          })) ??
          (compact.get(entry.provider)?.models ?? []).map((model) => ({
            id: model.id,
            label: model.label,
            thinking: (model.thinkingSet === undefined ? [] : (thinkingSets[model.thinkingSet]?.options ?? [])).map(
              ({ id, label }) => ({ id, label }),
            ),
          }));
        return {
          id: entry.provider,
          label: entry.label ?? entry.provider,
          models,
          modes: (entry.modes ?? []).map(({ id, label }) => ({ id, label })),
        };
      });
    return { providers };
  });

  // Hooks return at once: a hook that waits on Feishu would hold up the agent operation behind it.
  server.on("agent.turn_ended", (event) => active?.dispatcher.onTurnEnded(event));
  server.on("agent.permission_requested", (event) => active?.dispatcher.onPermissionRequested(event));
  server.on("agent.permission_resolved", (event) => active?.dispatcher.onPermissionResolved(event));

  return async () => {
    stopped = true;
    unsubscribe();
    await applying;
    await stopActive();
    log("stopped");
  };
}
