import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { GROUP_LABEL, SITUATION, type Group, type ListRow, type StripCell } from "../shared/graph";
import { arrange, statusLine } from "./list-model";
import { Badge, tint, useUi } from "./ui";

// The list: items in groups by who has to act -- you, someone else, the system, you yourself
// developing -- not by health. A row is two lines: the item, and where it is, whose ball it is and
// for how long; on a wide screen a strip shows how far it is along its route (one cell a stage, a
// narrow one for a detour). A row opens the item's page.

function Strip({ row }: { row: ListRow }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const tone = ui.tone(SITUATION[row.situation].tone);
  const color = (cell: StripCell) => (cell === "cur" ? tone : cell === "done" ? c.statusSuccess : cell === "todo" ? c.border : tint(c.statusSuccess, 0.35));
  const cells: Array<{ key: string; node: "cell" | "side"; cell?: StripCell }> = [];
  row.strip.forEach((cell, i) => {
    cells.push({ key: `c${i}`, node: "cell", cell });
    if (row.side && row.side.after === i) cells.push({ key: "side", node: "side" });
  });
  return (
    <View style={{ flexDirection: "row", gap: 3, alignItems: "center", width: "100%" }}>
      {cells.map((x) =>
        x.node === "side" ? (
          <View key={x.key} style={{ width: 9, height: 5, borderRadius: 2, backgroundColor: ui.tone("warning") }} />
        ) : (
          <View key={x.key} style={{ flex: 1, height: 5, borderRadius: 2, backgroundColor: color(x.cell!) }} />
        ),
      )}
    </View>
  );
}

function RowView({ row, onOpen }: { row: ListRow; onOpen(caseId: string): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const s = SITUATION[row.situation];
  const color = ui.tone(s.tone);
  const finished = row.group === "done";
  const icon = (
    <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: color, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: c.surface0, fontWeight: "800", fontSize: 13 }}>{s.icon}</Text>
    </View>
  );
  const text = (
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text style={[ui.styles.strong, { fontSize: 14 }]} numberOfLines={ui.compact ? 2 : 1}>
        {row.number} {row.title}
      </Text>
      <Text style={ui.styles.small} numberOfLines={1}>
        {statusLine(row)}
      </Text>
      {row.notice ? (
        <Text style={[ui.styles.small, { color: ui.tone("warning") }]} numberOfLines={2}>
          ⚠ {row.notice}
        </Text>
      ) : null}
      {row.stale ? (
        <View style={{ flexDirection: "row" }}>
          <Badge tone="warning" label="数据可能过时" />
        </View>
      ) : null}
    </View>
  );
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${row.number} ${row.title}`} onPress={() => onOpen(row.caseId)} style={{ flexDirection: "row", alignItems: "center", gap: ui.compact ? 10 : 14, paddingVertical: 10, paddingHorizontal: ui.compact ? 0 : 14, borderBottomWidth: 1, borderBottomColor: c.border }}>
      {icon}
      {text}
      {ui.compact || finished ? null : (
        <View style={{ width: 190 }}>
          <Strip row={row} />
        </View>
      )}
    </Pressable>
  );
}

export function GroupedList({ rows, onOpen, extra }: { rows: ListRow[]; onOpen(caseId: string): void; extra?: Partial<Record<Group, React.ReactNode>> }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const [older, setOlder] = useState(false);
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
      {arrange(rows, older, extra ?? {}).map(({ group: g, total, shown, hidden }) => (
        <View key={g}>
          <View style={{ flexDirection: "row", alignItems: "baseline", paddingHorizontal: 14, paddingVertical: 8, backgroundColor: c.surface2, borderBottomWidth: 1, borderBottomColor: c.border }}>
            <Text style={[ui.styles.strong, { fontSize: 14 }]}>
              {GROUP_LABEL[g].name}（{total}）
            </Text>
          </View>
          {extra?.[g]}
          {shown.map((row) => (
            <RowView key={row.caseId} row={row} onOpen={onOpen} />
          ))}
          {hidden > 0 ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`更早的 ${hidden} 个`} onPress={() => setOlder(true)} style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
              <Text style={ui.styles.muted}>更早的 {hidden} 个 ▸</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}
