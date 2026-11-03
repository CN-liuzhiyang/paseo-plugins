import type { ReactNode } from "react";
import { Pressable, View, type ViewStyle } from "react-native";
import type { PanelData } from "../shared/panel";
import { MOODS, tint, type Colors } from "../shared/look";
import { Words } from "./text";

// How the panel and the question cards look: the pieces they share, so one thing looks the same wherever it is. Only the
// theme's own colors are used (no color of ours), so light and dark both read; every Text still goes through ./text.

export const GAP = 18;

export const Dot = ({ color, size = 8 }: { color: string; size?: number }) => <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, flexShrink: 0 }} />;

/** The state of the affair: a colored dot and its word. "等你" is the loud one: a filled pill. */
export function StateBadge({ mood, c }: { mood: PanelData["mood"]; c: Colors }) {
  const m = MOODS[mood];
  const color = m.color(c);
  const loud = mood === "ask";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingHorizontal: loud ? 10 : 0, paddingVertical: loud ? 4 : 0, borderRadius: 999, backgroundColor: loud ? color : "transparent" }}>
      <Dot color={loud ? c.surface0 : color} />
      <Words style={{ color: loud ? c.surface0 : color, fontSize: 13, fontWeight: "700" }}>{m.label}</Words>
    </View>
  );
}

/** A block's small heading: grey, small, spaced, never louder than what is under it. */
export const Heading = ({ text, c }: { text: string; c: Colors }) => (
  <Words style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginTop: GAP, marginBottom: 8 }}>{text}</Words>
);

/** A small label on a grey ground. */
export const Tag = ({ text, c, color }: { text: string; c: Colors; color?: string }) => (
  <View style={{ backgroundColor: c.surface2, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, flexShrink: 0, maxWidth: "50%" }}>
    <Words style={{ color: color ?? c.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{text}</Words>
  </View>
);

/** A thin line between rows. */
export const Rule = ({ c }: { c: Colors }) => <View style={{ height: 1, backgroundColor: c.border, opacity: 0.6, marginVertical: 8 }} />;

/** A choice: the first is the filled one, the rest are outlined. */
export function ChoiceButton({ text, primary, c, onPress, disabled, picked, dim, testID }: { text: string; primary: boolean; c: Colors; onPress: () => void; disabled?: boolean; picked?: boolean; dim?: boolean; testID: string }) {
  const style: ViewStyle = {
    borderWidth: 1,
    borderColor: primary ? c.accent : picked ? c.accent : c.border,
    backgroundColor: primary ? c.accent : "transparent",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    maxWidth: "100%",
    opacity: dim ? 0.5 : 1,
  };
  return (
    <Pressable testID={testID} accessibilityRole="button" disabled={disabled} onPress={onPress} style={style}>
      <Words style={{ color: primary ? c.accentForeground : c.foreground, fontSize: 14, fontWeight: primary ? "600" : "400" }}>{text}</Words>
    </Pressable>
  );
}

/** A question for him as a card: a warm wash, rounded, the question first and large, the choices under it. */
export function QuestionCard({ c, title, line, children, size = 15, footer }: { c: Colors; title: string; line?: string; children: ReactNode; size?: number; footer?: ReactNode }) {
  return (
    <View style={{ backgroundColor: tint(c.statusWarning, "1f", c.surface1), borderColor: tint(c.statusWarning, "66", c.border), borderWidth: 1, borderRadius: 12, padding: 14, gap: 10, marginBottom: 10 }}>
      <Words style={{ color: c.statusWarning, fontSize: 11, fontWeight: "700", letterSpacing: 1 }}>要你定</Words>
      <Words style={{ color: c.foreground, fontSize: size, lineHeight: size + 6, fontWeight: "700" }}>{title}</Words>
      {line ? <Words style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{line}</Words> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{children}</View>
      {footer}
    </View>
  );
}
