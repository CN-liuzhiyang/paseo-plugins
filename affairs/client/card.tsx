import * as pluginClient from "@getpaseo/plugin/client";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Linking, Text, View, type TextStyle } from "react-native";
import type { Card, Line, Segment } from "../shared/card";

/** Opens an outside address by the host's own opener (the desktop app's browser), else `Linking`. Only web addresses. */
function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const open = (pluginClient as { openExternalUrl?: unknown }).openExternalUrl;
  void (typeof open === "function" ? (open as (u: string) => Promise<void>)(url) : Linking.openURL(url)).catch(() => {});
}

/** Text in pieces: the pieces that have an address can be pressed to open it, in the host's link color; the rest is plain. */
function Pieces({ text, parts, color, style }: { text: string; parts?: Segment[]; color: string; style: TextStyle | TextStyle[] }) {
  if (!parts?.some((p) => p.href)) return <Text style={style}>{text}</Text>;
  return (
    <Text style={style}>
      {parts.map((p, i) =>
        p.href ? (
          <Text key={i} accessibilityRole="link" onPress={() => openExternal(p.href!)} style={{ color, textDecorationLine: "underline" }}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}

// Four lines, in the host's colors: the name, what it is waiting for, how it stands, when it looks next. The look of a
// card in the app's own timeline -- a surface with a border -- and nothing of its own.

export function AffairCard({ item, theme, layout }: PluginTimelineItemProps<Card>) {
  const c = theme.colors;
  const { title, waiting, now, next, open, parts } = item.data;
  const line = { color: c.foreground, fontSize: 14, lineHeight: 20 } as const;
  const label = { color: c.foregroundMuted, fontSize: 14, lineHeight: 20, width: 36 } as const;
  return (
    <View style={{ backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 10, padding: layout.compact ? 12 : 14, gap: 4, marginVertical: 6 }}>
      <Pieces text={title} parts={parts?.title} color={c.accent} style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }} />
      <Pieces text={waiting} parts={parts?.waiting} color={c.accent} style={{ color: open ? c.foreground : c.foregroundMuted, fontSize: 14, lineHeight: 20, fontWeight: "500" }} />
      {now ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Text style={label}>现在</Text>
          <Pieces text={now} parts={parts?.now} color={c.accent} style={[line, { flex: 1 }]} />
        </View>
      ) : null}
      {next ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Text style={label}>下次</Text>
          <Pieces text={next} parts={parts?.next} color={c.accent} style={[line, { flex: 1 }]} />
        </View>
      ) : null}
    </View>
  );
}

/** A line: the time and what happened, in the conversation's own text size; red when it is something that was not as it should be. */
export function AffairLine({ item, theme }: PluginTimelineItemProps<Line>) {
  const c = theme.colors;
  const { text, tone, parts } = item.data;
  return <Pieces text={text} parts={parts} color={c.accent} style={{ color: tone === "red" ? c.statusDanger : c.foreground, fontSize: 15, lineHeight: 22, marginVertical: 4 }} />;
}
