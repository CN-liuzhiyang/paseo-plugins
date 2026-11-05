import { Pressable, View } from "react-native";
import type { PanelData } from "../shared/panel";
import { tint, type Colors } from "../shared/look";
import { Words } from "./text";

// The block above the "现在": the run started for this affair, as one box -- its name, what it is doing or waiting for him to do,
// how long and what it cost, and the one button that fits (open the card to answer it; open the run's own page). Drawn from what
// the plugin sends; the hosts that cannot open an agent or a page of another plugin do not get the button.

type Navigation = {
  openAgent?: (input: { agentId: string }) => void;
  openPluginScreen?: (pluginId: string, screenId: string, params?: Record<string, string>) => void;
} | undefined;

// COMPAT(navigation.openPluginScreen): a fork-only way to open a screen of another plugin (the run's own page); without it there is no "看详情".
// The workspace goes along: the run's page, given one, shows the run in that workspace's 流程 tab and does not stay on the page of its own.
export function FlowBox({ flow, c, navigation, workspaceId }: { flow: NonNullable<PanelData["flow"]>; c: Colors; navigation: Navigation; workspaceId?: string }) {
  const waiting = flow.action?.kind === "approve";
  const color = flow.tone === "red" ? c.statusDanger : waiting ? c.statusWarning : flow.text === "做完了" ? c.statusSuccess : c.accent;
  const open = (() => {
    const action = flow.action;
    if (!action) return null;
    if (action.kind === "approve" && action.agentId && navigation?.openAgent) return { label: "去批准", primary: true, press: () => navigation.openAgent!({ agentId: action.agentId! }) };
    if (action.kind === "detail" && action.runId && navigation?.openPluginScreen) return { label: "看详情", primary: false, press: () => navigation.openPluginScreen!("orchestration-ui", "runs", { run: action.runId!, ...(workspaceId ? { workspace: workspaceId } : {}) }) };
    return null;
  })();
  return (
    <View testID="flow-box" style={{ borderWidth: 1, borderColor: c.border, borderLeftWidth: 3, borderLeftColor: color, borderRadius: 8, padding: 10, backgroundColor: waiting ? tint(c.statusWarning, "1f", c.surface1) : c.surface1, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Words style={{ color: c.foreground, fontSize: 13, fontWeight: "700", flexShrink: 0 }}>{flow.name}</Words>
        <Words style={{ color, fontSize: 14, lineHeight: 20, fontWeight: "600", flex: 1, minWidth: 0 }}>{flow.text}</Words>
      </View>
      {flow.detail ? <Words style={{ color: c.foreground, fontSize: 13, lineHeight: 18 }}>{flow.detail}</Words> : null}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, flex: 1, minWidth: 0 }}>{[flow.meta, flow.more ? `还有 ${flow.more} 次更早的` : ""].filter(Boolean).join("　")}</Words>
        {open ? (
          <Pressable testID="flow-button" accessibilityRole="button" onPress={open.press} style={{ borderWidth: 1, borderColor: open.primary ? c.accent : c.border, backgroundColor: open.primary ? c.accent : "transparent", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, flexShrink: 0 }}>
            <Words style={{ color: open.primary ? c.accentForeground : c.foreground, fontSize: 13, fontWeight: open.primary ? "600" : "400" }}>{open.label}</Words>
          </Pressable>
        ) : null}
      </View>
      {flow.stale ? <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{flow.stale}</Words> : null}
    </View>
  );
}
