import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAudit, defaultAuditDir } from "./server/audit";
import { consume, type Consumer } from "./server/consumer";
import { createDispatcher, larkOf, type Dispatcher } from "./server/dispatcher";
import { settingsDefinition, type Settings } from "./server/settings";

const log = (line: string) => console.log(`feishu: ${line}`);

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);
  // COMPAT(server.paseo): a fork-only extension point until upstream lands its own shape.
  // Feishu messages arrive from outside Paseo, so no hook or handler hands this plugin the API.
  const paseo = (server as PluginServerContext & { readonly paseo?: PaseoApi }).paseo;
  if (!paseo) {
    log("this Paseo host does not provide server.paseo; the plugin does nothing");
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
    const dispatcher = createDispatcher({ paseo, lark: larkOf(cli), readSettings, log, audit });
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
