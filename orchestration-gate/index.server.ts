import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGateProvider } from "./server/provider";

// One thing: the `orch-gate` provider, the human gate's carrier. No settings, no RPCs,
// no client side; the card is Paseo's own permission card.

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createGateProvider());
  return () => {};
}
