import type { Settings } from "../shared/settings";
import type { Audit } from "./audit";
import { deliveredCard } from "./cards";

/**
 * What Paseo hands an outbound channel when a run it was told to deliver finishes. Declared here
 * because the SDK this plugin builds against is upstream's, which does not have channels yet.
 */
export interface ChannelDelivery {
  to: string;
  idempotencyKey: string;
  source: { kind: "schedule"; scheduleId: string; scheduleName: string | null; runId: string };
  status: "succeeded" | "failed";
  text: string;
  agentId: string | null;
}

/** Where a delivery can go, as Paseo offers it to people choosing one: every routed chat, by name. */
export function destinationsOf(settings: Settings | null): Array<{ to: string; label: string }> {
  return (settings?.routes ?? []).map((route) => ({ to: route.chatId, label: route.name.trim() || route.chatId }));
}

/**
 * Delivers to routed chats only. Anyone who can create a schedule can name a delivery target,
 * agents included, so the routes are the list of chats this bot will post to on its own.
 */
export function createChannel(deps: {
  readSettings: () => Promise<Settings | null>;
  send: (settings: Settings, chatId: string, card: object, idempotencyKey: string) => Promise<string>;
  audit: Audit;
  log: (line: string) => void;
}) {
  return async function deliver(delivery: ChannelDelivery): Promise<void> {
    const settings = await deps.readSettings();
    if (!settings) throw new Error("the feishu plugin settings are invalid");
    if (settings.larkCli === "" || settings.profile === "") {
      throw new Error("the feishu plugin is not configured: set larkCli and profile");
    }
    const route = settings.routes.find((candidate) => candidate.chatId === delivery.to);
    if (!route) {
      throw new Error(`${delivery.to} has no route in the feishu plugin; only routed chats receive deliveries`);
    }
    const title = delivery.source.scheduleName?.trim() || "定时任务";
    const card = deliveredCard(title, delivery.status, delivery.text);
    const messageId = await deps.send(settings, route.chatId, card, delivery.idempotencyKey);
    deps.log(`delivered ${delivery.source.kind} run ${delivery.source.runId} to ${route.chatId} as ${messageId}`);
    deps.audit("feishu.delivery", {
      chatId: route.chatId,
      messageId,
      status: delivery.status,
      source: delivery.source,
      agentId: delivery.agentId,
    });
  };
}
