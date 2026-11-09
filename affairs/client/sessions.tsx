import { Pressable, View } from "react-native";
import type { PanelData } from "../shared/panel";
import { tint, type Colors } from "../shared/look";
import { Dot, Tag } from "./look";
import { Words } from "./text";

type Session = PanelData["sessions"][number];
const order = { 等你批: 0, 干活中: 1, 做完了: 2, 已关闭: 3 };
const colorOf = (s: Session, c: Colors) => s.status === "等你批" ? c.statusWarning : s.status === "干活中" ? c.accent : s.status === "做完了" ? c.statusSuccess : c.foregroundMuted;

export function SessionPill({ text, color, c }: { text: string; color: string; c: Colors }) {
  return <View style={{ backgroundColor: tint(color, "1f", c.surface2), borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, flexShrink: 0 }}><Words style={{ color, fontSize: 11, fontWeight: "700" }}>{text}</Words></View>;
}

export function SessionSummary({ sessions, c }: { sessions: Session[]; c: Colors }) {
  const waiting = sessions.filter((s) => s.status === "等你批").length;
  const running = sessions.filter((s) => s.status === "干活中").length;
  return waiting || running ? <>
    {waiting ? <SessionPill text={`${waiting} 等你批`} color={c.statusWarning} c={c} /> : null}
    {running ? <SessionPill text={`${running} 干活中`} color={c.accent} c={c} /> : null}
  </> : <>
    <View style={{ flexDirection: "row", gap: 3, flexShrink: 1 }}>{sessions.map((s) => <Dot key={s.agentId} color={s.status === "已关闭" ? c.border : c.statusSuccess} size={6} />)}</View>
    <Words style={{ color: c.foregroundMuted, fontSize: 12 }}>{sessions.every((s) => s.status === "已关闭") ? "都已关闭" : "都做完了"}</Words>
  </>;
}

export function Sessions({ sessions, c, openAgent }: { sessions: Session[]; c: Colors; openAgent?: (input: { agentId: string }) => void }) {
  const sorted = [...sessions].sort((a, b) => order[a.status] - order[b.status]);
  const main = sorted.find((s) => s.role === "主对话");
  const rest = sorted.filter((s) => s !== main);
  const row = (s: Session, primary = false) => {
    const color = colorOf(s, c);
    const live = s.status === "等你批" || s.status === "干活中";
    const content = <>
      <View style={{ width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center", flexShrink: 0, backgroundColor: s.status === "等你批" ? color : s.status === "做完了" ? tint(color, "1f", c.surface2) : "transparent", ...(s.status === "已关闭" ? { borderWidth: 1.5, borderColor: c.border } : {}) }}>
        {s.status === "干活中" ? <Dot color={color} size={8} /> : <Words style={{ color: s.status === "等你批" ? c.accentForeground : color, fontSize: 11, fontWeight: "800" }}>{s.status === "等你批" ? "!" : s.status === "做完了" ? "✓" : ""}</Words>}
      </View>
      <Words numberOfLines={1} style={{ flex: 1, minWidth: 0, color: s.status === "已关闭" ? c.foregroundMuted : c.foreground, fontSize: 13, fontWeight: primary ? "600" : "400" }}>{s.title}</Words>
      {s.role === "流程" ? <Tag text="流程" c={c} /> : null}
      {live ? <SessionPill text={s.status} color={color} c={c} /> : null}
      {s.usd !== undefined ? <Words style={{ color: c.foregroundMuted, fontSize: 12, flexShrink: 0, fontVariant: ["tabular-nums"] }}>{`$${s.usd.toFixed(2)}`}</Words> : null}
      {openAgent ? <Words style={{ color: c.foregroundMuted, fontSize: 16, flexShrink: 0 }}>›</Words> : null}
    </>;
    const style = { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 8, paddingHorizontal: primary ? 10 : 0, borderRadius: 8, ...(primary ? { backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, marginBottom: 6 } : {}) } as const;
    return openAgent ? <Pressable key={s.agentId} testID={`session-${s.agentId}`} accessibilityRole="button" accessibilityLabel={`打开 ${s.title}，${s.status}`} onPress={() => openAgent({ agentId: s.agentId })} style={style}>{content}</Pressable> : <View key={s.agentId} testID={`session-${s.agentId}`} style={style}>{content}</View>;
  };
  return <>
    {main ? row(main, true) : null}
    {rest.length ? <Words style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600", marginTop: 6, marginBottom: 2 }}>派出去的 {rest.length}</Words> : null}
    {rest.map((s) => row(s))}
  </>;
}
