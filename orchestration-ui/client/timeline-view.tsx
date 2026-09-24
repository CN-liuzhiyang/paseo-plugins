import { Pressable, Text, View } from "react-native";
import { formatShort } from "../shared/format";
import { callTitle, nodeState, type Graph } from "../shared/graph";
import { ms, type CallState, type RunState, type RunStatus } from "../shared/run";
import { useUi, type Tone } from "./ui";

// Where the time went: one bar per call on a shared axis, grouped by phase visit. Agents, scripts
// and gates each have a color; a bar that has not ended is faded and outlined.

const TYPE_TONE: Record<string, Tone> = { ask: "accent", do: "neutral", gate: "warning" };

export function TimelineView({
  graph,
  run,
  status,
  selected,
  onSelect,
}: {
  graph: Graph;
  run: RunState;
  status: RunStatus;
  selected: string;
  onSelect(key: string): void;
}) {
  const ui = useUi();
  const c = ui.theme.colors;
  const t0 = ms(run.startedAt) ?? graph.visits[0]?.t0 ?? graph.clock;
  const total = Math.max(1, graph.clock - t0);
  const pct = (at: number) => Math.min(100, Math.max(0, ((at - t0) / total) * 100));
  const label = ui.compact ? 112 : 200;

  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", height: 18, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <View style={{ width: label }} />
        <View style={{ flex: 1, position: "relative" }}>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <Text
              key={f}
              style={[
                ui.styles.small,
                { position: "absolute", fontSize: 11 },
                f === 1 ? { right: 0 } : f === 0 ? { left: 0 } : { left: `${f * 100}%`, transform: [{ translateX: -12 }] },
              ]}
            >
              {f === 0 ? "0" : formatShort(total * f)}
            </Text>
          ))}
        </View>
      </View>
      {graph.visits.map((visit) => (
        <View key={visit.key}>
          <Text style={[ui.styles.small, { fontWeight: "700", marginTop: 8 }]}>
            {visit.loose ? "阶段之外" : `${visit.title}${visit.round > 1 ? ` · 第 ${visit.round} 次` : ""}`}
          </Text>
          {[...visit.calls]
            .sort((a, b) => (ms(a.startedAt) ?? 0) - (ms(b.startedAt) ?? 0))
            .map((call) => (
              <Row
                key={call.callId}
                call={call}
                run={run}
                status={status}
                clock={graph.clock}
                pct={pct}
                labelWidth={label}
                selected={selected === call.callId}
                onSelect={onSelect}
              />
            ))}
        </View>
      ))}
      <View style={[ui.styles.row, { marginTop: 10, columnGap: 14, rowGap: 4 }]}>
        {(
          [
            ["accent", "agent", false],
            ["neutral", "脚本", false],
            ["warning", "人闸", false],
            ["danger", "失败", false],
            ["accent", "还没结束", true],
          ] as Array<[Tone, string, boolean]>
        ).map(([tone, label, open]) => (
          <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View
              style={{
                width: 16,
                height: 8,
                borderRadius: 2,
                backgroundColor: ui.tone(tone),
                opacity: open ? 0.45 : 1,
                borderWidth: open ? 1 : 0,
                borderStyle: "dashed",
                borderColor: ui.tone(tone),
              }}
            />
            <Text style={ui.styles.small}>{label}</Text>
          </View>
        ))}
        <Text style={ui.styles.small}>用来看时间花在哪，比如等人往往是大头。</Text>
      </View>
    </View>
  );
}

function Row({
  call,
  run,
  status,
  clock,
  pct,
  labelWidth,
  selected,
  onSelect,
}: {
  call: CallState;
  run: RunState;
  status: RunStatus;
  clock: number;
  pct(at: number): number;
  labelWidth: number;
  selected: boolean;
  onSelect(key: string): void;
}) {
  const ui = useUi();
  const c = ui.theme.colors;
  const state = nodeState(call, status);
  const start = ms(call.startedAt) ?? clock;
  const end = call.end ? (ms(call.end.at) ?? clock) : clock;
  const left = pct(start);
  const width = Math.max(0.4, pct(end) - left);
  const open = state === "running" || state === "waiting" || state === "interrupted";
  const color = ui.tone(state === "error" ? "danger" : (TYPE_TONE[call.type ?? "do"] ?? "neutral"));
  const took = call.end?.durationMs ?? end - start;
  const text = `${formatShort(took)}${state === "waiting" ? " 等人中" : state === "interrupted" ? " 没有结束记录" : ""}`;
  // The label goes after the bar while there is room, before it otherwise, inside a bar that fills the lane.
  const right = left + width;
  const place =
    right <= 72
      ? { left: `${right}%` as const, paddingLeft: 5 }
      : left >= 28
        ? { right: `${100 - left}%` as const, paddingRight: 5, textAlign: "right" as const }
        : { right: `${100 - right}%` as const, paddingRight: 6, textAlign: "right" as const, color: open ? c.foreground : c.surface0, fontWeight: "700" as const };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${callTitle(run, call)}，${text}`}
      onPress={() => onSelect(call.callId)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        minHeight: 24,
        borderRadius: 4,
        backgroundColor: selected ? c.surface2 : pressed ? c.surface1 : "transparent",
      })}
    >
      <Text style={[ui.styles.small, { width: labelWidth, paddingRight: 8, color: c.foreground }]} numberOfLines={1}>
        {callTitle(run, call)}
      </Text>
      <View style={{ flex: 1, height: 16, position: "relative", justifyContent: "center" }}>
        <View
          style={{
            position: "absolute",
            top: 1,
            height: 14,
            left: `${left}%`,
            width: `${width}%`,
            minWidth: 3,
            borderRadius: 3,
            backgroundColor: color,
            opacity: open ? 0.45 : 1,
            borderWidth: open ? 1 : 0,
            borderStyle: "dashed",
            borderColor: color,
          }}
        />
        <Text style={[{ position: "absolute", top: 0, fontSize: 11, color: c.foregroundMuted }, place]} numberOfLines={1}>
          {text}
        </Text>
      </View>
    </Pressable>
  );
}
