import type { PluginServerContext } from "@getpaseo/plugin/server";
import { paramsSchema, runFlow, type ActionRegistration } from "./server/flow";
import { settingsDefinition, timeoutMs } from "./server/settings";

// The released SDK predates registerAction; this is the part of the fork's contract we use.
type ActionHost = { registerAction?: (action: ActionRegistration) => void };

export default function contribute(server: PluginServerContext) {
  const registerAction = (server as PluginServerContext & ActionHost).registerAction;
  if (typeof registerAction !== "function") {
    console.info("automation-flow: host does not support actions");
    return () => {};
  }
  const settings = server.registerSettings(settingsDefinition);
  let closed = false;
  void (async () => {
    let timeout = "30m";
    try {
      const state = await settings.read();
      if (state.status === "ready") timeout = state.values.defaultTimeout;
      else console.info(`automation-flow: invalid settings: ${state.error}`);
    } catch (error) {
      console.info(`automation-flow: cannot read settings: ${String(error)}`);
    }
    if (closed) return;
    // The host publishes action metadata once. Timeout changes take effect after plugin reload.
    registerAction.call(server, {
      id: "flow.run", label: "Run flow", params: paramsSchema, defaultTimeoutMs: timeoutMs(timeout),
      async run(input, context) {
        const current = await settings.read();
        if (current.status !== "ready") throw new Error(`Invalid automation-flow settings: ${current.error}`);
        return runFlow(input, context, { ...current.values, defaultTimeout: timeout });
      },
    });
  })().catch((error) => console.error(`automation-flow: cannot register action: ${String(error)}`));
  return () => { closed = true; };
}
