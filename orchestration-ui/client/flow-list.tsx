import { Pressable, Text, View } from "react-native";
import { formatTime } from "../shared/format";
import { isBroken, phaseLine, sortFlows, standing } from "../shared/flows";
import type { FlowRow } from "../shared/rpc";
import { useFlowList } from "./data";
import { Badge, Banner, useUi } from "./ui";

// The flows that exist, above the runs: a person opening this page wants to know first what can be run here, and
// second what has run. A row is the flow's name and its own description, the phases it goes through, and how its
// newest run ended; a flow nobody has run says so.

const ORIGIN_LABEL: Record<FlowRow["origin"], string | null> = { shipped: "内置", config: "自有", seen: "只在运行记录里见过" };

export function FlowList({ now, onOpen, onSettings }: { now: number; onOpen(name: string): void; onSettings(): void }) {
  const ui = useUi();
  const { data, error } = useFlowList();
  if (!data) {
    return error ? (
      <Banner tone="danger" icon="TriangleAlert" title="读不到有哪些流程">
        <Text style={ui.styles.muted} selectable>
          {error}
        </Text>
      </Banner>
    ) : (
      <Text style={ui.styles.muted}>正在读取有哪些流程……</Text>
    );
  }
  const flows = sortFlows(data.flows);
  return (
    <View style={{ gap: 10 }}>
      {data.state === "fallback" ? (
        <Banner tone="warning" icon="TriangleAlert" title="列不出所有的流程，下面只有跑过的">
          <Text style={ui.styles.text} selectable>
            {data.detail}
          </Text>
          <Pressable accessibilityRole="button" onPress={onSettings}>
            <Text style={[ui.styles.small, { color: ui.theme.colors.accent }]}>
              在设置里填 orchPath（paseo-plugins/orchestration/runtime/orch.mjs 的路径）
            </Text>
          </Pressable>
        </Banner>
      ) : null}
      {error ? (
        <Text style={[ui.styles.small, { color: ui.tone("danger") }]} selectable>
          刷新失败，下面是上一次读到的：{error}
        </Text>
      ) : null}
      <View style={ui.styles.row}>
        <Text style={ui.styles.heading}>流程</Text>
        <Text style={ui.styles.small}>{flows.length} 个</Text>
      </View>
      {flows.length === 0 ? (
        <Text style={ui.styles.muted}>
          {data.state === "ok" ? "运行时没有找到任何流程：flows/ 和 config.json 的 flowsDirs 里都是空的。" : "还没有跑过任何流程。"}
        </Text>
      ) : (
        <View
          style={{
            borderWidth: 1,
            borderColor: ui.theme.colors.border,
            borderRadius: 12,
            overflow: "hidden",
            backgroundColor: ui.theme.colors.surface1,
          }}
        >
          {flows.map((flow, index) => (
            <Row key={`${flow.name}:${flow.file ?? ""}`} flow={flow} now={now} last={index === flows.length - 1} onOpen={onOpen} />
          ))}
        </View>
      )}
    </View>
  );
}

function Row({ flow, now, last, onOpen }: { flow: FlowRow; now: number; last: boolean; onOpen(name: string): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const look = standing(flow);
  const origin = ORIGIN_LABEL[flow.origin];
  const phases = phaseLine(flow);
  const run = flow.latest;
  const when = run?.startedAt ? formatTime(run.startedAt, now) : null;
  const dot = (
    <View
      style={{
        width: 10,
        height: 10,
        borderRadius: 5,
        marginTop: 5,
        backgroundColor: flow.latest || isBroken(flow) ? ui.tone(look.tone) : "transparent",
        borderWidth: flow.latest || isBroken(flow) ? 0 : 1,
        borderColor: c.border,
      }}
    />
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`查看流程 ${flow.name}，${look.label}`}
      onPress={() => onOpen(flow.name)}
      style={({ pressed }) => ({
        flexDirection: ui.compact ? "column" : "row",
        alignItems: ui.compact ? "stretch" : "center",
        gap: ui.compact ? 6 : 14,
        paddingHorizontal: 14,
        paddingVertical: 11,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: c.border,
        backgroundColor: pressed ? c.surface2 : "transparent",
      })}
    >
      <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", flex: 1, minWidth: 0 }}>
        {dot}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <Text style={[ui.styles.strong, { flexShrink: 0 }]} numberOfLines={1}>
              {flow.name}
            </Text>
            {origin ? <Text style={ui.styles.small}>{origin}</Text> : null}
            {flow.problems.length > 0 && !isBroken(flow) ? <Badge tone="warning" icon="TriangleAlert" label="源码有问题" /> : null}
          </View>
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }} numberOfLines={2}>
            {isBroken(flow) ? `读不了：${flow.error}` : flow.description || "（没有说明）"}
          </Text>
          {phases ? (
            <Text style={ui.styles.small} numberOfLines={1}>
              {phases}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ paddingLeft: ui.compact ? 20 : 0, width: ui.compact ? undefined : 200, alignItems: ui.compact ? "flex-start" : "flex-end", gap: 2 }}>
        <Text style={{ color: look.tone === "neutral" || look.tone === "success" ? c.foreground : ui.tone(look.tone), fontSize: 13, fontWeight: "600" }}>
          {look.label}
        </Text>
        <Text style={ui.styles.small}>
          {run ? `${when ?? "—"} · 共 ${flow.runCount} 次` : isBroken(flow) ? "" : "从没有运行记录"}
        </Text>
      </View>
    </Pressable>
  );
}
