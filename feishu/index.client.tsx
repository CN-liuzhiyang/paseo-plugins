import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FeishuSettings } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "feishu",
    title: "飞书",
    icon: "MessageCircle",
    Component: FeishuSettings,
  });
  return () => {};
}
