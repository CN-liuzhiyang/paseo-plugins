import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { InboxScreen, SCREEN_ID } from "./client/screen";
import { ReconcileSettings } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings("reconcile");
  const Screen = (props: PluginScreenProps) => <InboxScreen {...props} openSettings={openSettings} />;
  const cleanups = [
    client.addScreen({ id: SCREEN_ID, title: "事务", Component: Screen }),
    client.addSidebarHeaderItem({
      id: "inbox",
      title: "事务",
      Component: ({ currentScreen, openScreen }: PluginSidebarItemProps) => (
        <SidebarRow icon="Inbox" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />
      ),
    }),
    client.addSettingsScreen({ id: "reconcile", title: "事务", icon: "Inbox", Component: ReconcileSettings }),
    client.addCommandCenterItem({
      id: "open-inbox",
      title: "打开事务",
      icon: "Inbox",
      keywords: ["reconcile", "inbox", "事务", "对账", "问题卡"],
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
