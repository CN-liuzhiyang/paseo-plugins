import type { PluginServerContext } from "@getpaseo/plugin/server";
import { settingsDefinition } from "./shared/settings";
import { discoverRpc, inputSchema, panelRpc } from "./shared/rpc";
import { UsageService } from "./server/service";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);
  const service = new UsageService(async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : settingsDefinition.schema.parse({});
  });
  server.registerUsageSource({
    id: "crs",
    label: "CRS",
    input: inputSchema,
    discover: (scope) => service.discover(scope),
    fetch: (input) => service.fetch(input),
  });
  server.handle(discoverRpc, () => service.identities());
  server.handle(panelRpc, () => service.panel());
  return () => service.close();
}
