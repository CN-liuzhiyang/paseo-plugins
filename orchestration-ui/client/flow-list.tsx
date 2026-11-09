import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { isBroken, sortFlows, standing } from "../shared/flows";
import { flowStanding, whenOf } from "../shared/page";
import type { FlowRow } from "../shared/rpc";
import { useFlowList } from "./data";
import { Badge, Banner, Card, FoldHead, useUi } from "./ui";

// The flows that exist, folded under the runs: 全部流程 · 16. A line is the flow's name and how its newest run
// went -- "停了 · 10-30 · 7 次". What it is for, its phases, inputs and command are on its own page.

export function FlowList({ now, onOpen, onSettings }: { now: number; onOpen(name: string): void; onSettings(): void }) {
  const ui = useUi();
  const { data, error } = useFlowList();
  const [open, setOpen] = useState(false);
  if (!data) {
    return error ? (
      <Banner tone="danger" icon="TriangleAlert" title="读不到有哪些流程">
        <Text style={ui.styles.muted} selectable>
          {error}
        </Text>
      </Banner>
    ) : null;
  }
  const flows = sortFlows(data.flows);
  return (
    <View style={{ gap: 6 }}>
      {data.state === "fallback" ? (
        <Banner tone="warning" icon="TriangleAlert" title="只列得出跑过的流程">
          <Text style={ui.styles.text} selectable>
            {data.detail}
          </Text>
          <Pressable accessibilityRole="button" onPress={onSettings}>
            <Text style={[ui.styles.small, { color: ui.theme.colors.accent }]}>在设置里填 orchPath</Text>
          </Pressable>
        </Banner>
      ) : null}
      {error ? (
        <Text style={[ui.styles.small, { color: ui.tone("danger") }]} selectable>
          刷新失败，下面是上一次读到的：{error}
        </Text>
      ) : null}
      <FoldHead label={`全部流程 · ${flows.length}`} open={open} onPress={() => setOpen(!open)} />
      {open ? (
        flows.length === 0 ? (
          <Text style={ui.styles.muted}>{data.state === "ok" ? "运行时没有找到流程。" : "还没有跑过流程。"}</Text>
        ) : (
          <Card>
            {flows.map((flow, index) => (
              <Row key={`${flow.name}:${flow.file ?? ""}`} flow={flow} now={now} last={index === flows.length - 1} onOpen={onOpen} />
            ))}
          </Card>
        )
      ) : null}
    </View>
  );
}

function Row({ flow, now, last, onOpen }: { flow: FlowRow; now: number; last: boolean; onOpen(name: string): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const look = standing(flow);
  const run = flow.latest;
  const said = flowStanding(look.label, run ? whenOf(run.startedAt, now) : null, flow.runCount);
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
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: c.border,
        backgroundColor: pressed ? c.surface2 : "transparent",
      })}
    >
      {dot}
      <View style={{ flex: 1, minWidth: 0, flexDirection: ui.compact ? "column" : "row", alignItems: ui.compact ? "stretch" : "baseline", gap: ui.compact ? 2 : 12 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexShrink: 1 }}>
          <Text style={[ui.styles.strong, { flexShrink: 0 }]} numberOfLines={1}>
            {flow.name}
          </Text>
          {flow.problems.length > 0 && !isBroken(flow) ? <Badge tone="warning" icon="TriangleAlert" label="源码有问题" /> : null}
        </View>
        <Text
          style={{ flex: ui.compact ? undefined : 1, color: look.tone === "neutral" || look.tone === "success" ? c.foregroundMuted : ui.tone(look.tone), fontSize: 13 }}
          numberOfLines={1}
        >
          {isBroken(flow) ? `读不了：${flow.error}` : said}
        </Text>
      </View>
    </Pressable>
  );
}
