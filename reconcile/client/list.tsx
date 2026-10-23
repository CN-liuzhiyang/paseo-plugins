import { Pressable, Text, View } from "react-native";
import { durationText, GROUP_LABEL, SITUATION, type Group, type ListRow, type StripCell } from "../shared/graph";
import { BallChip } from "./chart";
import { Badge, tint, useUi } from "./ui";

// The list: items in groups by who has to act -- you, someone else, the system, you yourself
// developing -- not by health. Each row says in a line what the item is doing, shows how far it
// is along its route as a strip (one cell a stage, a narrow one for a detour), and who holds the
// ball, for how long, and what comes next. A row opens the item's page.

// "你 · 回答：…" -> "回答：…": the chip already says whose ball it is.
const whatOf = (label: string) => (label.includes(" · ") ? label.slice(label.indexOf(" · ") + 3) : "");

export const GROUP_ORDER: Group[] = ["me", "errors", "them", "system", "mine", "done"];

/**
 * How long, in words. A clock that starts when tracking began is "at least": it says so, and an item that was already over
 * when tracking began does not get a length made up for it.
 */
export function waitText(row: ListRow): string {
  if (row.group === "mine") return ""; // your own work is not something to nag about: no clock on it
  const w = row.waiting;
  if (w.ended) return w.ms !== null ? `${w.atLeast ? "至少用了" : "用了"} ${durationText(w.ms)}` : w.atLeast ? "追踪前就结束了" : "";
  return w.ms !== null ? `${w.atLeast ? "至少已等" : "已等"} ${durationText(w.ms)}` : "";
}

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
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", gap: 3, alignItems: "center", width: "100%" }}>
        {cells.map((x) =>
          x.node === "side" ? (
            <View key={x.key} style={{ width: 9, height: 5, borderRadius: 2, backgroundColor: ui.tone("warning") }} />
          ) : (
            <View key={x.key} style={{ flex: 1, height: 5, borderRadius: 2, backgroundColor: color(x.cell!) }} />
          ),
        )}
      </View>
      <Text style={ui.styles.small} numberOfLines={1}>
        {row.stageLabel}
        {row.side ? `（走过岔路：${row.side.label}）` : ""}
      </Text>
    </View>
  );
}

function RowView({ row, onOpen }: { row: ListRow; onOpen(caseId: string): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const s = SITUATION[row.situation];
  const color = ui.tone(s.tone);
  const finished = row.group === "done";
  const wait = waitText(row);
  const icon = (
    <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: color, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: c.surface0, fontWeight: "800", fontSize: 13 }}>{s.icon}</Text>
    </View>
  );
  const title = (
    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <Text style={[ui.styles.strong, { fontSize: 14 }]} numberOfLines={ui.compact ? 2 : 1}>
        {row.number} {row.title}
      </Text>
      <Text style={ui.styles.small} numberOfLines={2}>
        {row.headline}
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
  if (ui.compact) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`${row.number} ${row.title}`} onPress={() => onOpen(row.caseId)} style={{ flexDirection: "row", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border }}>
        {icon}
        <View style={{ flex: 1, gap: 4 }}>
          {title}
          <Strip row={row} />
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {finished ? null : <BallChip actor={row.who.actor} />}
            <Text style={ui.styles.small} numberOfLines={1}>
              {[finished ? "" : whatOf(row.who.label), wait].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </View>
      </Pressable>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${row.number} ${row.title}`} onPress={() => onOpen(row.caseId)} style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: c.border }}>
      {icon}
      <View style={{ flex: 1, minWidth: 0 }}>{title}</View>
      <View style={{ width: 190 }}>
        <Strip row={row} />
      </View>
      <View style={{ width: 200, gap: 2 }}>
        {finished ? null : (
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            <BallChip actor={row.who.actor} />
            <Text style={[ui.styles.small, { flexShrink: 1, color: c.foreground }]} numberOfLines={1}>
              {whatOf(row.who.label)}
            </Text>
          </View>
        )}
        {wait ? <Text style={ui.styles.small}>{wait}</Text> : null}
      </View>
      <View style={{ width: 170, gap: 1 }}>
        {row.next.map((n) => (
          <Text key={n} style={ui.styles.small} numberOfLines={1}>
            {n}
          </Text>
        ))}
      </View>
    </Pressable>
  );
}

export function GroupedList({ rows, onOpen, extra }: { rows: ListRow[]; onOpen(caseId: string): void; extra?: Partial<Record<Group, React.ReactNode>> }) {
  const ui = useUi();
  const c = ui.theme.colors;
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
      {GROUP_ORDER.map((g) => {
        const here = rows.filter((r) => r.group === g);
        if (here.length === 0 && g !== "me" && !extra?.[g]) return null;
        const label = GROUP_LABEL[g];
        return (
          <View key={g}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 10, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: c.surface2, borderBottomWidth: 1, borderBottomColor: c.border }}>
              <Text style={[ui.styles.strong, { fontSize: 14 }]}>
                {label.name}（{here.length}）
              </Text>
              <Text style={ui.styles.small}>{label.sub}</Text>
            </View>
            {extra?.[g]}
            {here.length === 0 && g === "me" && !extra?.[g] ? (
              <View style={{ padding: 14 }}>
                <Text style={ui.styles.muted}>现在没有要你做的。</Text>
              </View>
            ) : null}
            {here.map((row) => (
              <RowView key={row.caseId} row={row} onOpen={onOpen} />
            ))}
          </View>
        );
      })}
    </View>
  );
}
