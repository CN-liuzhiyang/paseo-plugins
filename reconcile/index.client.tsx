import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { InboxRow } from "./client/attention";
import { InboxScreen, SCREEN_ID } from "./client/screen";
import { ReconcileSettings } from "./client/settings-screen";
import { ThreadCard } from "./client/thread-card";
import { THREAD_KIND, THREAD_VERSION, threadSchema } from "./shared/thread";

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings("reconcile");
  const Screen = (props: PluginScreenProps) => <InboxScreen {...props} openSettings={openSettings} />;
  const cleanups = [
    client.addScreen({ id: SCREEN_ID, title: "事项追踪", Component: Screen }),
    client.addSidebarHeaderItem({ id: "inbox", title: "事项追踪", Component: InboxRow }),
    client.addTimelineRenderer({ kind: THREAD_KIND, version: THREAD_VERSION, schema: threadSchema, Component: ThreadCard }),
    client.addSettingsScreen({ id: "reconcile", title: "事项追踪", icon: "Inbox", Component: ReconcileSettings }),
    client.addCommandCenterItem({
      id: "open-inbox",
      title: "打开事项追踪",
      icon: "Inbox",
      keywords: ["reconcile", "inbox", "事项追踪", "追踪", "事务", "对账", "问题卡"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
