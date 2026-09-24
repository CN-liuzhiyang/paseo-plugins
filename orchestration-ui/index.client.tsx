import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { OrchestrationSettings } from "./client/settings-screen";
import { RunsSurface } from "./client/surface";

export default function contribute(client: PluginClientContext) {
  const Surface = (props: PluginSurfaceProps) => (
    <RunsSurface {...props} openSettings={() => client.openSettings("orchestration-ui")} />
  );
  client.addSurface("runs", Surface);
  client.addSidebarItem({ id: "runs", title: "编排运行", icon: "Workflow", surface: "runs" });
  client.addSettingsScreen({ id: "orchestration-ui", title: "编排运行", icon: "Workflow", Component: OrchestrationSettings });
  client.addCommandCenterItem({
    id: "open-runs",
    title: "打开编排运行",
    icon: "Workflow",
    keywords: ["orchestration", "flow", "run", "编排", "运行"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("runs");
    },
  });
  return () => {};
}
