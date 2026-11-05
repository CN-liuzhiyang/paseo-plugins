import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";
import { Text, View } from "react-native";

// A page of a run that was opened for a workspace (`workspace` among the params, by whoever asked from that workspace -- the affairs
// panel's "看详情"): the run belongs in that workspace's own 流程 tab, so this page does not stay. It asks for the tab once, and says
// so in a line for the moment before the host has switched; a host that cannot open it leaves the person the run on this page.

export function ToWorkspace({ props, workspaceId, runId, node, open, stay }: { props: PluginScreenProps; workspaceId: string; runId: string; node: string | null; open(workspaceId: string, runId: string, node: string | null): void; stay(): void }) {
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    try {
      open(workspaceId, runId, node);
    } catch (error) {
      console.warn("orchestration-ui: cannot open the workspace tab, showing the run here", error);
      stay();
    }
  }, [open, stay, workspaceId, runId, node]);
  return (
    <View style={{ padding: 24 }}>
      <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 14 }}>正在这件事的工作区里打开…</Text>
    </View>
  );
}
