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
export function FlowBox({ flow, c, navigation, workspaceId, resume, busy, hideStale }: { flow: NonNullable<PanelData["flow"]>; c: Colors; navigation: Navigation; workspaceId?: string; resume?: () => void; busy?: boolean; hideStale?: boolean }) {
  const waiting = flow.action?.kind === "approve";
  const color = flow.tone === "red" ? c.statusDanger : waiting ? c.statusWarning : flow.text === "做完了" ? c.statusSuccess : c.accent;
  type Button = { label: string; primary: boolean; press: () => void };
  const detail = (runId?: string): Button | null => runId && navigation?.openPluginScreen ? { label: "看详情", primary: false, press: () => navigation.openPluginScreen!("orchestration-ui", "runs", { run: runId, ...(workspaceId ? { workspace: workspaceId } : {}) }) } : null;
  const buttons: Button[] = (() => {
    const action = flow.action;
    if (!action) return [];
    if (action.kind === "resume" && resume) return [detail(action.runId), { label: busy ? "正在接着跑…" : action.spends === "maybe" ? "接着跑（会再花钱）" : "接着跑", primary: false, press: resume }].filter((b): b is Button => b !== null);
    if (action.kind === "approve" && action.agentId && navigation?.openAgent) return [{ label: "去批准", primary: true, press: () => navigation.openAgent!({ agentId: action.agentId! }) }];
    if (action.kind === "detail") return [detail(action.runId)].filter((b): b is Button => b !== null);
    return [];
  })();
  return (
    <View testID="flow-box" style={{ borderWidth: 1, borderColor: c.border, borderLeftWidth: 3, borderLeftColor: color, borderRadius: 8, padding: 10, backgroundColor: waiting ? tint(c.statusWarning, "1f", c.surface1) : c.surface1, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Words style={{ color: c.foreground, fontSize: 13, fontWeight: "700", flexShrink: 0 }}>{flow.name}</Words>
        <Words style={{ color, fontSize: 14, lineHeight: 20, fontWeight: "600", flex: 1, minWidth: 0 }}>{flow.text}</Words>
      </View>
      {flow.detail ? <Words style={{ color: c.foreground, fontSize: 13, lineHeight: 18 }}>{flow.detail}</Words> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: 8, rowGap: 6 }}>
        <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, flexShrink: 0 }}>{flow.meta}</Words>
        {buttons.length ? (
          <View style={{ flexDirection: "row", gap: 8, marginLeft: "auto" }}>
            {buttons.map((open) => (
              <Pressable key={open.label} testID="flow-button" accessibilityRole="button" disabled={busy} onPress={open.press} style={{ borderWidth: 1, borderColor: open.primary ? c.accent : c.border, backgroundColor: open.primary ? c.accent : "transparent", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Words style={{ color: open.primary ? c.accentForeground : c.foreground, fontSize: 13, fontWeight: open.primary ? "600" : "400" }}>{open.label}</Words>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
      {flow.note ? <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{flow.note}</Words> : null}
      {flow.more ? <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{`还有 ${flow.more} 次更早的`}</Words> : null}
      {flow.stale && !hideStale ? <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{flow.stale}</Words> : null}
    </View>
  );
}
