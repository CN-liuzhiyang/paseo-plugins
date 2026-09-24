import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { addMemberRpc, choicesRpc, removeMemberRpc, statusRpc } from "./shared/rpc";
import { settingsDefinition, type Settings } from "./shared/settings";
import { createAudit, defaultAuditDir } from "./server/audit";
import { consume, type Consumer } from "./server/consumer";
import { createIsolation, isClaude } from "./server/context";
import { createDispatcher, larkOf, type Dispatcher, type Stranger } from "./server/dispatcher";
import { readIncoming } from "./server/inbound";
import { createDirectory, type Directory } from "./server/directory";
import { createChannel, type ChannelDelivery } from "./server/channel";
import { botOpenId, chatMembers, fetchMessages, sendCard } from "./server/lark";
import { createPeople } from "./server/people";

const log = (line: string) => console.log(`feishu: ${line}`);
const REMEMBERED_STRANGERS = 20;
const BOT_ID_RETRY_MS = 60_000;

type Status = RpcOutput<typeof statusRpc>;

/** What the plugin keeps: <PASEO_HOME>/plugin-data/feishu. */
function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"), "plugin-data", "feishu");
}

/** Where a message's attachments are downloaded. */
function mediaRoot(): string {
  return path.join(dataRoot(), "media");
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);
  const strangers: Stranger[] = [];
  const people = createPeople(path.join(dataRoot(), "people.json"));

  // COMPAT(server.paseo): a fork-only extension point until upstream lands its own shape.
  // Feishu messages arrive from outside Paseo, so no hook or handler hands this plugin the API.
  const paseo = (server as PluginServerContext & { readonly paseo?: PaseoApi }).paseo;
  if (!paseo) {
    log("this Paseo host does not provide server.paseo; the plugin does nothing");
    server.handle(statusRpc, (): Status => ({
      state: "unsupported",
      detail: "这个 Paseo 版本没有 server.paseo 扩展点，插件不工作。",
      strangers: [],
      members: [],
      names: {},
      candidates: [],
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

  // COMPAT(registerChannel): a fork-only extension point until upstream lands its own shape.
  // A schedule whose delivery names this channel has its result posted to a routed chat.
  const host = server as PluginServerContext & {
    registerChannel?: (channel: { id: string; label?: string; deliver(delivery: ChannelDelivery): Promise<void> }) => void;
  };
  if (host.registerChannel) {
    host.registerChannel({
      id: "feishu",
      label: "飞书",
      deliver: createChannel({
        readSettings,
        send: (values, chatId, card, key) =>
          sendCard({ path: values.larkCli, profile: values.profile }, chatId, card, key),
        audit,
        log,
      }),
    });
  } else {
    log("this Paseo host has no server.registerChannel; scheduled results cannot be delivered to Feishu");
  }

  // Agents created without CLAUDE.md stay that way every time their session opens again.
  const isolation = createIsolation(paseo, log);
  server.before("agent.session_open", async ({ request }) => {
    if (!isClaude(request.provider)) return;
    const env = await isolation.envFor(request.agentId, request.env);
    return env ? { ...request, env } : undefined;
  });

  let active: { key: string; consumers: Consumer[]; dispatcher: Dispatcher; directory: Directory } | null = null;
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
    // Asked once per consumer; a failed ask is retried at most once a minute, not per message.
    let botId: Promise<string | null> | null = null;
    let botIdAskedAt = 0;
    const whoAmI = async (): Promise<string | null> => {
      if (botId === null || ((await botId) === null && Date.now() - botIdAskedAt > BOT_ID_RETRY_MS)) {
        botIdAskedAt = Date.now();
        botId = botOpenId(cli).catch((error: unknown) => {
          log(`cannot tell which @ is this bot: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
      }
      return botId;
    };
    void whoAmI();
    const directory = createDirectory({
      chatMembers: (chatId) => chatMembers(cli, chatId),
      senderName: async (messageId) => (await fetchMessages(cli, [messageId], null))[0]?.sender?.name ?? null,
      log,
    });
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
            lookup: (ids) => fetchMessages(cli, ids, null),
            mediaDir: (chatId, messageId) => path.join(mediaRoot(), chatId, messageId),
          },
          options,
        ),
      botId: whoAmI,
      people,
      directory,
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
    active = { key, consumers: [messages, clicks], dispatcher, directory };
  };

  let applying = Promise.resolve();
  const reapply = () => {
    applying = applying.then(apply).catch((error: unknown) => log(`apply settings: ${String(error)}`));
  };
  reapply();
  const unsubscribe = settings.subscribe(reapply);

  /** Everyone the settings screen shows, by name where Feishu gave one. */
  const peopleView = async (values: Settings | null) => {
    const members = await people.members().catch((error: unknown) => {
      log(`members cannot be read: ${String(error)}`);
      return [];
    });
    const names: Record<string, string> = {};
    const candidates: Array<{ openId: string; name: string; chatId: string }> = [];
    const directory = active?.directory;
    if (directory && values) {
      const known = new Set([...values.senders, ...members.map((member) => member.openId)]);
      const rosters = await Promise.all(
        values.routes.map(async (route) => ({ chatId: route.chatId, roster: await directory.members(route.chatId) })),
      );
      for (const { chatId, roster } of rosters) {
        for (const person of roster) {
          if (known.has(person.openId)) continue;
          known.add(person.openId);
          candidates.push({ ...person, chatId });
        }
      }
      for (const openId of [...values.senders, ...strangers.map((stranger) => stranger.senderId)]) {
        const name = directory.name(openId);
        if (name) names[openId] = name;
      }
    }
    for (const member of members) if (member.name) names[member.openId] = member.name;
    return { strangers: strangers.map((stranger) => ({ ...stranger })), members, names, candidates };
  };

  server.handle(statusRpc, async (): Promise<Status> => {
    const state = await settings.read();
    if (state.status !== "ready") return { state: "invalid", detail: state.error, ...(await peopleView(null)) };
    const view = await peopleView(state.values);
    const { larkCli, profile } = state.values;
    if (larkCli === "" || profile === "") {
      return { state: "unconfigured", detail: "填好 lark-cli 路径和 profile 才会开始收消息。", ...view };
    }
    const consumers = active?.consumers ?? [];
    if (consumers.length > 0 && consumers.every((consumer) => consumer.listening())) {
      return { state: "listening", detail: `正在用 profile「${profile}」收消息和卡片回调。`, ...view };
    }
    const why = consumers.map((consumer) => consumer.lastWords()).find((words) => words !== "") ?? "";
    return { state: "connecting", detail: why === "" ? "正在连接飞书……" : why, ...view };
  });

  // From the settings screen: whoever is at the daemon runs it, so nobody else is asked.
  server.handle(addMemberRpc, async ({ openId, name, chatId }) => {
    await people.add({ openId, name, by: "paseo", byName: "Paseo 设置", chatId, at: Date.now() });
    audit("feishu.people.added", { openId, name, chatId, operator: "paseo" });
    return {};
  });
  server.handle(removeMemberRpc, async ({ openId }) => {
    const removed = await people.remove(openId);
    if (removed) audit("feishu.people.removed", { openId, operator: "paseo" });
    return { removed };
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
