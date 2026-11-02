import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { Card, Line } from "../shared/card";

// Four lines, in the host's colors: the name, what it is waiting for, how it stands, when it looks next. The look of a
// card in the app's own timeline -- a surface with a border -- and nothing of its own.

export function AffairCard({ item, theme, layout }: PluginTimelineItemProps<Card>) {
  const c = theme.colors;
  const { title, waiting, now, next, open } = item.data;
  const line = { color: c.foreground, fontSize: 14, lineHeight: 20 } as const;
  const label = { color: c.foregroundMuted, fontSize: 14, lineHeight: 20, width: 36 } as const;
  return (
    <View style={{ backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 10, padding: layout.compact ? 12 : 14, gap: 4, marginVertical: 6 }}>
      <Text style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: open ? c.foreground : c.foregroundMuted, fontSize: 14, lineHeight: 20, fontWeight: "500" }}>{waiting}</Text>
      {now ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Text style={label}>现在</Text>
          <Text style={[line, { flex: 1 }]}>{now}</Text>
        </View>
      ) : null}
      {next ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Text style={label}>下次</Text>
          <Text style={[line, { flex: 1 }]}>{next}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** A line: the time and what happened, in the conversation's own text size; red when it is something that was not as it should be. */
export function AffairLine({ item, theme }: PluginTimelineItemProps<Line>) {
  const c = theme.colors;
  const { text, tone } = item.data;
  return <Text style={{ color: tone === "red" ? c.statusDanger : c.foreground, fontSize: 15, lineHeight: 22, marginVertical: 4 }}>{text}</Text>;
}
