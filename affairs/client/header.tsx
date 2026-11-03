import { useRpc } from "@getpaseo/plugin/client";
import type { PluginButtonIconProps, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useEffect } from "react";
import { View } from "react-native";
import { listRpc } from "../shared/rpc";

// The 进展 button on the header of each affair's workspace, and the first-time opening of the panel there. The client
// has to know which workspaces are affairs, so a sidebar item that is always mounted asks the plugin every few
// seconds and puts a button on each new one (a new affair has its button within seconds).

export const PANEL_ID = "progress";
const POLL_MS = 3000;
const OPENED = "affairs.opened.";

// Remembered per device, and only as a convenience: a cleared browser opens the panel once more, which is harmless.
const opened = (ws: string) => {
  try {
    return localStorage.getItem(OPENED + ws) === "1";
  } catch {
    return true;
  }
};
const markOpened = (ws: string) => {
  try {
    localStorage.setItem(OPENED + ws, "1");
  } catch {
    // no storage: not remembered
  }
};

export function installHeaders(client: PluginClientContext) {
  const registered = new Map<string, () => void>();

  /** Mounts when the workspace's header shows. The first time it is on a wide screen it opens the panel, here, in this workspace (never from the background, never on a phone where it would cover the chat). */
  function Icon({ workspaceId, layout, color, size }: PluginButtonIconProps) {
    useEffect(() => {
      if (layout.compact || opened(workspaceId)) return;
      markOpened(workspaceId);
      client.openPanel(PANEL_ID, { workspaceId, location: "explorer" });
    }, [workspaceId]);
    // The same picture as the host's own right-panel button: a frame with its right part set off.
    const w = size - 2;
    return (
      <View style={{ width: w, height: w * 0.85, borderWidth: 1.5, borderColor: color, borderRadius: 3 }}>
        <View style={{ position: "absolute", top: 0, bottom: 0, right: w * 0.3, width: 1.5, backgroundColor: color }} />
      </View>
    );
  }

  function Feeder(_props: PluginSidebarItemProps) {
    const list = useRpc(listRpc);
    useEffect(() => {
      const poll = () =>
        void list({})
          .then(({ items }) => {
            for (const { workspaceId } of items) {
              if (registered.has(workspaceId)) continue;
              const button = client.addHeaderButton({
                // a button id is lower-case letters, digits and hyphens
                id: `progress-${workspaceId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
                workspaceId,
                button: { title: "进展", label: "进展", icon: Icon, behavior: { kind: "action", onPress: () => client.openPanel(PANEL_ID, { workspaceId, location: "explorer" }) } },
              });
              registered.set(workspaceId, () => button.remove());
            }
          })
          .catch(() => {});
      poll();
      const timer = setInterval(poll, POLL_MS);
      return () => clearInterval(timer);
    }, []);
    return null;
  }

  const cleanup = client.addSidebarFooterItem({ id: "affairs-feeder", title: "事项", Component: Feeder });
  return () => {
    cleanup();
    registered.forEach((remove) => remove());
    registered.clear();
  };
}
