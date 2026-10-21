import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { OrchestrationSettings } from "./client/settings-screen";
import { RunsSurface, SCREEN_ID } from "./client/surface";

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings("orchestration-ui");
  const Screen = (props: PluginScreenProps) => (
    <RunsSurface {...props} openSettings={openSettings} openScreen={(input) => client.openScreen(input)} />
  );
  const cleanups = [
    client.addScreen({ id: SCREEN_ID, title: "编排运行", Component: Screen }),
    client.addSidebarHeaderItem({
      id: "runs",
      title: "编排运行",
      Component: ({ currentScreen, openScreen }: PluginSidebarItemProps) => (
        <SidebarRow icon="Workflow" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />
      ),
    }),
    client.addSettingsScreen({ id: "orchestration-ui", title: "编排运行", icon: "Workflow", Component: OrchestrationSettings }),
    client.addCommandCenterItem({
      id: "open-runs",
      title: "打开编排运行",
      icon: "Workflow",
      keywords: ["orchestration", "flow", "run", "编排", "运行"],
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
