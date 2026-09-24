import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Pressable, Text, View, type ScrollView as NativeScrollView } from "react-native";
import { formatShort } from "../shared/format";
import {
  callTitle,
  callWho,
  headline,
  nodeState,
  type Column,
  type Graph,
  type Piece,
  type Stage,
  type Wave,
} from "../shared/graph";
import type { CallState, RunState, RunStatus } from "../shared/run";
import { KIND_LOOK, NODE_LOOK, VISIT_LOOK } from "./looks";
import { useUi, type Tone } from "./ui";

// The run as a flow, drawn with flex and borders only: the plugin SDK has no SVG. Time runs left
// to right; boxes that overlapped in time stack inside a bracket; a phase entered again sits in a
// dashed "↻ N 轮" container, one row per round. Arrows say "after", never "used the output of".

const NODE_WIDTH = 184;

interface Ctx {
  run: RunState;
  status: RunStatus;
  /** What open durations count to (shared/graph.ts runClock). */
  clock: number;
  selected: string;
  onSelect(key: string): void;
}

const GraphContext = createContext<Ctx | null>(null);

function useGraph(): Ctx {
  const ctx = useContext(GraphContext);
  if (!ctx) throw new Error("useGraph outside GraphView");
  return ctx;
}

export interface GraphViewProps {
  graph: Graph;
  run: RunState;
  status: RunStatus;
  selected: string;
  /** Scroll the selection into view. Off while the selection is only the default ending: the shape matters more then. */
  follow: boolean;
  onSelect(key: string): void;
}

export function GraphView({ graph, run, status, selected, follow, onSelect }: GraphViewProps) {
  const scroll = useRef<NativeScrollView>(null);
  const boxes = useRef(new Map<number, { x: number; width: number }>());
  const view = useRef({ width: 0, x: 0 });
  const revealed = useRef<string | null>(null);
  // A live run's graph is rebuilt every tick; revealing must follow the selection, not the ticks,
  // or it would pull the view back each second while someone scrolls.
  const pieceOf = useRef(graph.pieceOf);
  pieceOf.current = graph.pieceOf;

  // Bring the selected node's piece into view when it is off to either side, once per selection.
  const reveal = useCallback(() => {
    if (!follow || revealed.current === selected) return;
    const index = pieceOf.current.get(selected);
    const box = index === undefined ? undefined : boxes.current.get(index);
    const { width, x } = view.current;
    if (!box || width === 0) return;
    revealed.current = selected;
    if (box.x >= x && box.x + box.width <= x + width) return;
    // As little as it takes, so as much as possible of what came before stays in view.
    const to = box.x < x || box.width > width ? box.x - 16 : box.x + box.width - width + 16;
    scroll.current?.scrollTo({ x: Math.max(0, to), animated: true });
  }, [selected, follow]);
  useEffect(() => {
    reveal();
  }, [reveal]);

  const live = status === "running" || status === "starting";
  const ctx = useMemo<Ctx>(() => ({ run, status, clock: graph.clock, selected, onSelect }), [run, status, graph.clock, selected, onSelect]);
  const parts: ReactNode[] = [];
  graph.pieces.forEach((piece, index) => {
    if (index > 0) parts.push(<Edge key={`e${index}`} dashed={piece.kind === "ghost"} />);
    parts.push(
      <View
        key={`p${index}`}
        onLayout={(event) => {
          const { x, width } = event.nativeEvent.layout;
          boxes.current.set(index, { x, width });
          if (graph.pieceOf.get(selected) === index) reveal();
        }}
      >
        <PieceView piece={piece} />
      </View>,
    );
  });

  return (
    <GraphContext.Provider value={ctx}>
      <View style={{ gap: 8 }}>
        <ScrollView
          ref={scroll}
          horizontal
          onLayout={(event) => {
            view.current.width = event.nativeEvent.layout.width;
            reveal();
          }}
          onScroll={(event) => {
            view.current.x = event.nativeEvent.contentOffset.x;
          }}
          scrollEventThrottle={32}
          contentContainerStyle={{ paddingVertical: 14, paddingHorizontal: 2 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center" }}>{parts}</View>
        </ScrollView>
        <Legend live={live} />
      </View>
    </GraphContext.Provider>
  );
}

function PieceView({ piece }: { piece: Piece }) {
  const ui = useUi();
  const { selected, onSelect } = useGraph();
  const c = ui.theme.colors;
  switch (piece.kind) {
    case "input":
      return (
        <Terminal
          caption="输入"
          label={piece.label}
          tone="neutral"
          dashed={false}
          selected={selected === piece.key}
          onPress={() => onSelect(piece.key)}
        />
      );
    case "end":
      return (
        <Terminal
          caption="结局"
          label={piece.label}
          tone={piece.tone}
          dashed={piece.dashed}
          selected={selected === piece.key}
          onPress={() => onSelect(piece.key)}
        />
      );
    case "ghost":
      return (
        <View
          style={{ borderWidth: 1.5, borderStyle: "dashed", borderColor: c.border, borderRadius: 12, minWidth: 120 }}
          accessibilityLabel={`阶段 ${piece.phase.title}，${piece.text}`}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 7 }}>
            <Dot color={c.border} />
            <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{piece.phase.title}</Text>
          </View>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, paddingHorizontal: 10, paddingBottom: 10 }}>{piece.text}</Text>
        </View>
      );
    case "column":
      return <ColumnView column={piece.stages} inLoop={false} />;
    case "loop":
      return (
        <View
          style={{
            borderWidth: 1.5,
            borderStyle: "dashed",
            borderColor: c.foregroundMuted,
            borderRadius: 12,
            paddingTop: 12,
            paddingBottom: 8,
            paddingHorizontal: 10,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ backgroundColor: c.surface2, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 }}>
              <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "700" }}>
                ↻ {piece.title} · {piece.rounds.length} 轮
              </Text>
            </View>
            <Text style={ui.styles.small}>按阶段重新进入推断</Text>
          </View>
          {piece.rounds.map((round, index) => (
            <View key={index} style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={[ui.styles.small, { width: 48, textAlign: "right", paddingRight: 8 }]}>第 {index + 1} 轮</Text>
              {round.map((column, at) => (
                <View key={at} style={{ flexDirection: "row", alignItems: "center" }}>
                  {at > 0 ? <Edge /> : null}
                  <ColumnView column={column} inLoop />
                </View>
              ))}
            </View>
          ))}
        </View>
      );
  }
}

function ColumnView({ column, inLoop }: { column: Column; inLoop: boolean }) {
  const ui = useUi();
  const stages = column.map((stage) => <StageView key={stage.visit.key} stage={stage} inLoop={inLoop} />);
  if (column.length === 1) return stages[0]!;
  const bracket = (side: "left" | "right") => ({
    width: 8,
    alignSelf: "stretch" as const,
    marginVertical: 18,
    borderColor: ui.theme.colors.border,
    borderWidth: 2,
    ...(side === "left"
      ? { borderRightWidth: 0, borderTopLeftRadius: 6, borderBottomLeftRadius: 6 }
      : { borderLeftWidth: 0, borderTopRightRadius: 6, borderBottomRightRadius: 6 }),
  });
  return (
    <View style={{ gap: 2 }}>
      <Text style={[ui.styles.small, { paddingLeft: 14 }]}>并行 · {column.length} 路同时在跑</Text>
      <View style={{ flexDirection: "row" }}>
        <View style={bracket("left")} />
        <View style={{ gap: 10, paddingHorizontal: 6, alignItems: "flex-start" }}>{stages}</View>
        <View style={bracket("right")} />
      </View>
    </View>
  );
}

const FRAME_TONE: Partial<Record<Stage["state"], Tone>> = {
  running: "accent",
  waiting: "warning",
  failed: "danger",
  stopped: "warning",
};

function StageView({ stage, inLoop }: { stage: Stage; inLoop: boolean }) {
  const ui = useUi();
  const { selected, onSelect } = useGraph();
  const c = ui.theme.colors;
  const { visit } = stage;
  const body = (
    <View style={{ padding: visit.loose ? 0 : 8, alignItems: "center" }}>
      {stage.waves.map((wave, index) => (
        <View key={index} style={{ alignItems: "center" }}>
          {index > 0 ? <View style={{ width: 2, height: 12, backgroundColor: c.border }} /> : null}
          <WaveView wave={wave} />
        </View>
      ))}
      {stage.waves.length === 0 ? <Text style={[ui.styles.small, { padding: 4 }]}>没有调用（阶段里只跑了脚本自己的代码）</Text> : null}
    </View>
  );
  if (visit.loose) return body;
  const tone = FRAME_TONE[stage.state];
  const look = VISIT_LOOK[stage.state];
  const isSelected = selected === visit.key;
  return (
    <View
      style={{
        borderWidth: isSelected ? 2 : 1.5,
        borderStyle: stage.state === "running" && !isSelected ? "dashed" : "solid",
        borderColor: isSelected ? c.foreground : tone ? ui.tone(tone) : c.border,
        borderRadius: 12,
        backgroundColor: c.surface1,
        minWidth: 150,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`阶段 ${visit.title}，${look.label}`}
        onPress={() => onSelect(visit.key)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 10,
          paddingVertical: 7,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
        }}
      >
        <Dot color={ui.tone(look.tone)} />
        <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
          {visit.title}
          {visit.round > 1 && !inLoop ? ` · 第 ${visit.round} 次` : ""}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, marginLeft: "auto", paddingLeft: 8 }}>
          {stage.state === "done" ? formatShort(stage.durationMs) : `${look.label} · ${formatShort(stage.durationMs)}`}
        </Text>
      </Pressable>
      {body}
    </View>
  );
}

function WaveView({ wave }: { wave: Wave }) {
  if (wave.kind === "group") return <GroupNode keyName={wave.key} calls={wave.calls} />;
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {wave.calls.map((call) => (
        <CallNode key={call.callId} call={call} />
      ))}
    </View>
  );
}

function statusLine(call: CallState, status: RunStatus, clock: number): string {
  const state = nodeState(call, status);
  const look = NODE_LOOK[state];
  const started = Date.parse(call.startedAt ?? "");
  const took = call.end?.durationMs ?? (Number.isNaN(started) ? null : clock - started);
  if (state === "ok") return `${look.mark} ${formatShort(took)}`;
  if (state === "error") return `${look.mark} ${call.end?.error?.name.replace(/Error$/, "") || "失败"} · ${formatShort(took)}`;
  if (state === "running") return `${look.mark} 运行中 ${formatShort(took)}`;
  if (state === "waiting") return `${look.mark} 等人 ${formatShort(took)}`;
  return `${look.mark} 没有结束记录`;
}

function Frame({
  tone,
  selected,
  strong,
  open = false,
  label,
  onPress,
  children,
}: {
  tone: Tone | null;
  selected: boolean;
  strong: boolean;
  /** Still going: outlined dashed, the same "not finished" as the ending and the timeline. */
  open?: boolean;
  label: string;
  onPress(): void;
  children: ReactNode;
}) {
  const ui = useUi();
  const c = ui.theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        width: NODE_WIDTH,
        borderWidth: selected || strong || open ? 2 : 1,
        borderStyle: open && !selected ? "dashed" : "solid",
        borderColor: selected ? c.foreground : tone ? ui.tone(tone) : c.border,
        borderRadius: 9,
        paddingHorizontal: 9,
        paddingVertical: 7,
        gap: 3,
        backgroundColor: strong && tone ? ui.tint(tone, 0.1) : c.surface0,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

function Kind({ label, tone }: { label: string; tone: Tone }) {
  const ui = useUi();
  return (
    <View style={{ backgroundColor: ui.tint(tone, 0.16), borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
      <Text style={{ color: tone === "neutral" ? ui.theme.colors.foregroundMuted : ui.tone(tone), fontSize: 10, fontWeight: "800" }}>
        {label}
      </Text>
    </View>
  );
}

function CallNode({ call }: { call: CallState }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const { run, status, clock, selected: current, onSelect } = useGraph();
  const selected = current === call.callId;
  const state = nodeState(call, status);
  const look = NODE_LOOK[state];
  const kind = call.type ? KIND_LOOK[call.type] : { label: "?", tone: "neutral" as Tone, name: "未知类型" };
  const title = callTitle(run, call);
  const who = callWho(call);
  const line = headline(call, status);
  const unfenced = call.ask?.fence ? !call.ask.fence.enforced : false;
  const tone: Tone | null = state === "ok" ? null : look.tone;
  return (
    <Frame
      tone={tone}
      selected={selected}
      strong={state === "waiting" || state === "error"}
      open={state === "running"}
      label={`${kind.name} ${title}，${look.label}`}
      onPress={() => onSelect(call.callId)}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
        <Kind label={kind.label} tone={kind.tone} />
        <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600", flex: 1 }} numberOfLines={2}>
          {title}
        </Text>
        {unfenced ? <Icon name="ShieldAlert" size={12} color={ui.tone("warning")} /> : null}
      </View>
      {who && who !== title ? (
        <Text style={ui.styles.small} numberOfLines={1}>
          {who}
        </Text>
      ) : null}
      <Text style={{ color: ui.tone(look.tone), fontSize: 12, fontWeight: "600" }}>{statusLine(call, status, clock)}</Text>
      {line ? (
        <View style={{ backgroundColor: c.surface2, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3, marginTop: 1 }}>
          <Text style={{ color: c.foreground, fontSize: 12, lineHeight: 16 }} numberOfLines={2}>
            {line}
          </Text>
        </View>
      ) : null}
    </Frame>
  );
}

function GroupNode({ keyName, calls }: { keyName: string; calls: CallState[] }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const { status, selected: current, onSelect } = useGraph();
  const selected = current === keyName;
  const states = calls.map((call) => nodeState(call, status));
  const bad = states.filter((state) => state === "error").length;
  const running = states.includes("running");
  const lost = states.includes("interrupted");
  const took = calls.reduce((sum, call) => sum + (call.end?.durationMs ?? 0), 0);
  const tone: Tone = bad ? "danger" : running ? "accent" : lost ? "warning" : "success";
  const summary = bad ? `✕ ${bad} 步失败` : running ? "● 运行中" : lost ? "? 有步骤没有结束记录" : "✓ 全部完成";
  return (
    <Frame
      tone={tone === "success" ? null : tone}
      selected={selected}
      strong={bad > 0}
      open={running}
      label={`${calls.length} 个脚本步骤，${summary}`}
      onPress={() => onSelect(keyName)}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Kind label="脚本" tone="neutral" />
        <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{calls.length} 个脚本步骤</Text>
      </View>
      <Text style={{ color: ui.tone(tone), fontSize: 12, fontWeight: "600" }}>
        {summary} · {formatShort(took)}
      </Text>
      {calls.map((call) => {
        const state = nodeState(call, status);
        return (
          <Text key={call.callId} style={ui.styles.small} numberOfLines={1}>
            <Text style={{ color: ui.tone(NODE_LOOK[state].tone) }}>{state === "ok" ? "✓" : NODE_LOOK[state].mark}</Text> {call.title}
          </Text>
        );
      })}
    </Frame>
  );
}

function Terminal({
  caption,
  label,
  tone,
  dashed,
  selected,
  onPress,
}: {
  caption: string;
  label: string;
  tone: Tone;
  dashed: boolean;
  selected: boolean;
  onPress(): void;
}) {
  const ui = useUi();
  const c = ui.theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${caption}：${label}`}
      onPress={onPress}
      style={({ pressed }) => ({
        borderRadius: 999,
        borderWidth: selected ? 2 : 1.5,
        borderStyle: dashed ? "dashed" : "solid",
        borderColor: selected ? c.foreground : tone === "neutral" ? c.border : ui.tone(tone),
        backgroundColor: tone === "neutral" ? c.surface1 : ui.tint(tone, 0.12),
        paddingHorizontal: 14,
        paddingVertical: 8,
        maxWidth: 150,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={ui.styles.small}>{caption}</Text>
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "700" }} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

function Edge({ dashed = false }: { dashed?: boolean }) {
  const ui = useUi();
  const color = ui.theme.colors.border;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", width: 28 }}>
      {dashed ? (
        <View style={{ flex: 1, flexDirection: "row", gap: 3 }}>
          {[0, 1, 2].map((n) => (
            <View key={n} style={{ flex: 1, height: 2, backgroundColor: color }} />
          ))}
        </View>
      ) : (
        <View style={{ flex: 1, height: 2, backgroundColor: color }} />
      )}
      <View
        style={{
          width: 0,
          height: 0,
          borderTopWidth: 5,
          borderBottomWidth: 5,
          borderLeftWidth: 6,
          borderTopColor: "transparent",
          borderBottomColor: "transparent",
          borderLeftColor: color,
        }}
      />
    </View>
  );
}

function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

function Legend({ live }: { live: boolean }) {
  const ui = useUi();
  const item = (tone: Tone, label: string) => (
    <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <Dot color={ui.tone(tone)} />
      <Text style={ui.styles.small}>{label}</Text>
    </View>
  );
  return (
    <View style={[ui.styles.row, { columnGap: 14, rowGap: 4 }]}>
      {item("success", "完成")}
      {live ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ width: 14, height: 10, borderRadius: 3, borderWidth: 1.5, borderStyle: "dashed", borderColor: ui.tone("accent") }} />
          <Text style={ui.styles.small}>虚线框：还在跑</Text>
        </View>
      ) : null}
      {item("warning", "等人 / 没有结束记录")}
      {item("danger", "失败")}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Icon name="ShieldAlert" size={12} color={ui.tone("warning")} />
        <Text style={ui.styles.small}>只读没有被机械强制</Text>
      </View>
      <Text style={ui.styles.small}>→ 箭头只表示先后，不表示数据流向</Text>
      <Text style={ui.styles.small}>↻ 轮次是按阶段重新进入推断的</Text>
    </View>
  );
}
