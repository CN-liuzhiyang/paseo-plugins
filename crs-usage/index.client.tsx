import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { UsageScreen } from "./client/usage-screen";
import { SettingsScreen } from "./client/settings-screen";
import { discoverRpc } from "./shared/rpc";

function UsageItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const discover = useRpc(discoverRpc);
  const query = useQuery({
    queryKey: ["crs-discover"],
    queryFn: () => discover({}),
    refetchInterval: 30000,
  });
  if (!query.data?.length) return null;
  return (
    <SidebarRow
      icon="ChartNoAxesCombined"
      active={currentScreen?.screenId === "usage"}
      onPress={() => openScreen({ screenId: "usage" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addTheme({
    id: "crs-midnight",
    name: "CRS 夜色",
    appearance: "dark",
    colors: {
      background: "#0b0e14",
      foreground: "#e6edf7",
      raised: "#121722",
      control: "#171d2b",
      border: "#222b3d",
      accent: "#38bdf8",
      mutedForeground: "#7d8aa3",
      ring: "#818cf8",
    },
  });
  client.addScreen({ id: "usage", title: "CRS 用量与管理", Component: UsageScreen });
  client.addSidebarHeaderItem({ id: "usage", title: "CRS 用量与管理", Component: UsageItem });
  client.addSettingsScreen({
    id: "crs",
    title: "CRS 用量",
    icon: "ChartNoAxesCombined",
    Component: SettingsScreen,
  });
  return () => {};
}
