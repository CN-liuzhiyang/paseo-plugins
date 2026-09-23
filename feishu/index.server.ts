import type { PluginServerContext } from "@getpaseo/plugin/server";

// The dispatcher lands here: spawn one `lark-cli event consume` per event key
// (im.message.receive_v1, card.action.trigger), drop senders outside the
// allowlist, route by chat_id. The design and the list of traps that look like
// they work and do not are in README.md.
//
// Until then this only proves the plugin compiles, loads, and stops cleanly on
// the daemon it is installed into.
export default function contribute(_server: PluginServerContext) {
  console.log("feishu: loaded (skeleton; consuming no events)");
  return () => console.log("feishu: stopped");
}
