import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRef, useState } from "react";
import { Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { clockText, durationText, layoutOf, SITUATION, type Ball, type GraphView, type Piece, type RunView, type StageMeta, type Visit } from "../shared/graph";
import { tint, useUi, type Tone } from "./ui";

// The chart of one item: the stages it went through, left to right, with the one it is in
// marked and coloured by whose ball it is. Only flex and borders (the plugin SDK has no SVG):
// every line is a View with a border. Alignment rests on one number: a stage box's header is
// 33 high and every connector sits 16 from the top of its row. A detour hangs under the line,
// a way back is a dashed box around the stretch walked again, and what has not come is one
// ghost box. On a phone the same visits stand in a column.

const BOX = 268;
const EDGE = 28;
const HEAD = 33;
const MID = 16;
/** Half of a detour's drop: the connector is two corners, each this high. */
const HALF = 18;

const stageOf = (view: GraphView, id: string): StageMeta => view.graph.stages.find((s) => s.id === id) ?? { id, label: "已经没有的一步", named: false, next: [], side: true, when: null, end: false, endKind: null, done: null };

export function Dot({ kind, tone }: { kind: "ok" | "cur" | "no"; tone?: Tone }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const color = kind === "ok" ? c.statusSuccess : kind === "cur" ? ui.tone(tone ?? "accent") : c.border;
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: kind === "no" ? undefined : color, borderWidth: kind === "no" ? 1.5 : 0, borderColor: color }} />;
}

const BALL_TEXT: Record<Ball, string> = { me: "你", them: "别人", system: "系统", nobody: "没有" };
const BALL_TONE: Record<Ball, Tone> = { me: "warning", them: "neutral", system: "accent", nobody: "neutral" };

export function BallChip({ actor, label }: { actor: Ball; label?: string }) {
  const ui = useUi();
  const color = ui.tone(BALL_TONE[actor]);
  return (
    <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5, backgroundColor: tint(color, 0.16), alignSelf: "flex-start" }}>
      <Text style={{ color, fontSize: 11, fontWeight: "700" }}>{label ?? BALL_TEXT[actor]}</Text>
    </View>
  );
}

/** How long a visit says it took, in the words that fit what is known of it. */
export function visitSpan(v: Visit): string {
  if (v.inferred) return "追踪前";
  if (v.durationMs === null) return "";
  const text = durationText(v.durationMs);
  if (v.cur) return `已 ${text}`;
  if (v.before) return v.fromKind === "happened" ? `约 ${text}` : `至少 ${text}`;
  return text;
}

function Edge({ dash = false }: { dash?: boolean }) {
  const ui = useUi();
  return <View style={{ width: EDGE, height: 0, marginTop: MID, borderTopWidth: 1, borderColor: ui.theme.colors.border, borderStyle: dash ? "dashed" : "solid" }} />;
}

/** From the line down to a detour box, and back up from it: two corners each, the second one lower. */
function Elbow({ down }: { down: boolean }) {
  const ui = useUi();
  const line = ui.theme.colors.border;
  const half = EDGE / 2;
  const corner = (side: "tr" | "bl" | "br" | "tl", top: number) => ({
    width: half,
    height: HALF,
    marginTop: top,
    borderColor: line,
    ...(side === "tr" ? { borderTopWidth: 1, borderRightWidth: 1, borderTopRightRadius: 6 } : {}),
    ...(side === "bl" ? { borderBottomWidth: 1, borderLeftWidth: 1, borderBottomLeftRadius: 6 } : {}),
    ...(side === "br" ? { borderBottomWidth: 1, borderRightWidth: 1, borderBottomRightRadius: 6 } : {}),
    ...(side === "tl" ? { borderTopWidth: 1, borderLeftWidth: 1, borderTopLeftRadius: 6 } : {}),
  });
  return (
    <View style={{ flexDirection: "row", width: EDGE }}>
      {down ? <View style={corner("tr", MID)} /> : <View style={corner("br", MID + HALF)} />}
      {down ? <View style={corner("bl", MID + HALF)} /> : <View style={corner("tl", MID)} />}
    </View>
  );
}

function Terminal({ label, sub, tone, dashed = false, onPress, selected = false }: { label: string; sub?: string; tone?: Tone; dashed?: boolean; onPress?: () => void; selected?: boolean }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const color = tone ? ui.tone(tone) : c.border;
  const body = (
    <View style={{ marginTop: 2, paddingHorizontal: 12, height: 28, borderRadius: 14, borderWidth: selected ? 2 : 1, borderColor: color, borderStyle: dashed ? "dashed" : "solid", backgroundColor: c.surface1, flexDirection: "row", alignItems: "center", gap: 6 }}>
      {tone === "success" ? <Dot kind="ok" /> : null}
      <Text style={{ color: tone ? color : c.foregroundMuted, fontSize: 12, fontWeight: "700" }}>{label}</Text>
      {sub ? <Text style={ui.styles.small}>{sub}</Text> : null}
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

function BallLines({ v, nowMs }: { v: Visit; nowMs: number }) {
  const ui = useUi();
  if (v.balls.length === 0) return null;
  return (
    <View style={{ gap: 3 }}>
      {v.balls.map((b, i) => {
        const endMs = b.to ? Date.parse(b.to) : nowMs;
        const span = b.from ? durationText(Math.max(0, endMs - Date.parse(b.from))) : "";
        const now = v.cur && i === v.balls.length - 1;
        return (
          <View key={`${b.from}${i}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
            <BallChip actor={b.actor} />
            <Text style={[ui.styles.small, { flex: 1, color: ui.theme.colors.foreground, fontWeight: now ? "700" : "400" }]}>{b.what}</Text>
            <Text style={ui.styles.small}>{span}</Text>
          </View>
        );
      })}
    </View>
  );
}

function StageBox({ v, view, selected, onSelect, nowMs }: { v: Visit; view: GraphView; selected: boolean; onSelect(id: string): void; nowMs: number }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const meta = stageOf(view, v.stage);
  const tone = SITUATION[view.situation].tone;
  const border = v.cur ? ui.tone(tone) : selected ? c.foreground : c.border;
  const dotKind = v.inferred ? "no" : v.cur ? "cur" : "ok";
  const name = meta.label + (v.round > 1 ? ` · 第 ${v.round} 次` : "");
  const detail = v.inferred ? "开始追踪时已经过了这一步，没有记录。" : v.cur ? (meta.done ? `到下一步的标志：${meta.done}` : "") : v.lastHeadline;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}，点开看细节`}
      onPress={() => onSelect(v.id)}
      style={{
        width: BOX,
        borderRadius: 10,
        borderWidth: v.cur || selected ? 2 : 1,
        borderColor: border,
        borderStyle: v.inferred ? "dashed" : "solid",
        backgroundColor: meta.side ? tint(ui.tone("warning"), 0.08) : v.before ? c.surface2 : c.surface1,
        overflow: "hidden",
      }}
    >
      <View style={{ height: HEAD, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <Dot kind={dotKind} tone={tone} />
        <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
          {name}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={ui.styles.small}>{visitSpan(v)}</Text>
      </View>
      <View style={{ padding: 10, gap: 6 }}>
        <BallLines v={v} nowMs={nowMs} />
        {detail ? (
          <Text style={ui.styles.small} numberOfLines={3}>
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function RunCard({ run, onOpen }: { run: RunView; onOpen: () => void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const tone: Tone = run.situation === "fail" ? "danger" : run.situation === "me" || run.situation === "lost" || run.situation === "slow" || run.situation === "unreadable" || run.situation === "unchecked" ? "warning" : run.situation === "done" ? "success" : "accent";
  const color = ui.tone(tone);
  const stepColor = (s: RunView["steps"][number]) => (s === "ok" ? c.statusSuccess : s === "bad" ? c.statusDanger : s === "wait" || s === "slow" || s === "lost" ? c.statusWarning : s === "run" ? c.accent : c.border);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`流程 ${run.flow}，打开`} onPress={onOpen} style={{ width: BOX, borderRadius: 10, borderWidth: 1.5, borderStyle: "dashed", borderColor: color, backgroundColor: c.surface1, padding: 8, gap: 5 }}>
      <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
        <View style={{ paddingHorizontal: 5, borderRadius: 4, backgroundColor: tint(color, 0.16) }}>
          <Text style={{ color, fontSize: 11, fontWeight: "700" }}>流程</Text>
        </View>
        <Text style={[ui.styles.strong, { flexShrink: 1 }]} numberOfLines={1}>
          {run.flow}
        </Text>
        <View style={{ flex: 1 }} />
        <Icon name="ArrowUpRight" size={13} color={color} />
      </View>
      {run.steps.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 3 }}>
          {run.steps.map((s, i) => (
            <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: stepColor(s) }} />
          ))}
        </View>
      ) : null}
      <Text style={ui.styles.small} numberOfLines={2}>
        {run.step ? `第 ${run.step.index}${run.step.total ? `/${run.step.total}` : ""} 步 ${run.step.title} · ` : ""}${run.costUsd.toFixed(2)}
      </Text>
      {run.unreadLines > 0 ? (
        <Text style={[ui.styles.small, { color }]} numberOfLines={2}>
          记录有 {run.unreadLines} 行太长没读，{run.endedAt ? "花费可能少算" : "看不出它走到哪了"}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** A question waiting, hung under the stage it is asked in. */
function AskTag({ view, onPress }: { view: GraphView; onPress?: () => void }) {
  const ui = useUi();
  const ask = view.current.ask;
  if (!ask) return null;
  const color = ui.tone("warning");
  return (
    <Pressable disabled={!onPress} accessibilityRole={onPress ? "button" : "text"} accessibilityLabel="问你的问题，在上面答" onPress={onPress} style={{ width: BOX, borderRadius: 10, borderWidth: 1, borderColor: color, backgroundColor: ui.theme.colors.surface1, padding: 8, gap: 2 }}>
      <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
        <View style={{ paddingHorizontal: 5, borderRadius: 4, backgroundColor: tint(color, 0.16) }}>
          <Text style={{ color, fontSize: 11, fontWeight: "700" }}>问题</Text>
        </View>
        <Text style={[ui.styles.strong, { flexShrink: 1 }]} numberOfLines={1}>
          问你：{ask.header}
        </Text>
      </View>
      <Text style={ui.styles.small}>
        {ask.askedAt ? `${clockText(ask.askedAt)} 问的 · ` : ""}等你回答
      </Text>
    </Pressable>
  );
}

function Hang({ children }: { children: React.ReactNode }) {
  const ui = useUi();
  return (
    <View style={{ alignItems: "center" }}>
      <View style={{ width: 1, height: 12, backgroundColor: ui.theme.colors.border }} />
      <View style={{ gap: 6 }}>{children}</View>
    </View>
  );
}

interface Ctx {
  view: GraphView;
  selected: string | null;
  onSelect(id: string | null): void;
  nowMs: number;
  openRun(run: RunView): void;
  focusAsk?: () => void;
  onCurX(x: number): void;
}

function PieceView({ p, ctx }: { p: Piece; ctx: Ctx }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const { view } = ctx;
  switch (p.k) {
    case "stage":
    case "dip": {
      const v = p.v;
      const runs = v.cur ? view.runs.filter((r) => r.stage === v.stage || (r.stage === null && v.cur)) : [];
      const hangs = v.cur && (runs.length > 0 || view.current.ask);
      const box = (
        <View onLayout={v.cur ? (e) => ctx.onCurX(e.nativeEvent.layout.x) : undefined} style={{ alignItems: "center" }}>
          <StageBox v={v} view={view} selected={ctx.selected === v.id} onSelect={ctx.onSelect} nowMs={ctx.nowMs} />
          {hangs ? (
            <Hang>
              {view.current.ask ? <AskTag view={view} onPress={ctx.focusAsk} /> : null}
              {runs.map((r) => (
                <RunCard key={r.runId} run={r} onOpen={() => ctx.openRun(r)} />
              ))}
            </Hang>
          ) : null}
        </View>
      );
      if (p.k === "dip")
        return (
          <View style={{ marginTop: 4 }}>
            <Text style={{ color: ui.tone("warning"), fontSize: 11, fontWeight: "700", marginBottom: 3 }}>岔路{p.when ? `：${p.when}` : ""}</Text>
            {box}
          </View>
        );
      return box;
    }
    case "skip":
      return (
        <View style={{ width: BOX - 60, borderRadius: 10, borderWidth: 1, borderStyle: "dashed", borderColor: c.border, padding: 10, gap: 4 }}>
          <View style={{ flexDirection: "row", gap: 7, alignItems: "center" }}>
            <Dot kind="no" />
            <Text style={[ui.styles.strong, { color: c.foregroundMuted }]}>{p.stage.label}</Text>
            <Text style={ui.styles.small}>跳过</Text>
          </View>
          <Text style={ui.styles.small}>没在这一步停：{p.why}</Text>
        </View>
      );
    case "loop":
      return (
        <View style={{ borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: c.accent, padding: 10, gap: 8 }}>
          <Text style={{ color: c.accent, fontSize: 12, fontWeight: "700" }}>↻ {p.label}</Text>
          {p.rounds.map((row, i) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              <Text style={[ui.styles.small, { color: c.accent, marginTop: 8 }]}>第 {i + 1} 次</Text>
              <Seq pieces={row} ctx={ctx} />
            </View>
          ))}
        </View>
      );
    case "end": {
      const tone: Tone | undefined = p.stage.endKind === "done" ? "success" : undefined;
      return <Terminal label={p.stage.label} sub={p.v.from ? clockText(p.v.from) : undefined} tone={tone} dashed={p.stage.endKind !== "done"} selected={ctx.selected === p.v.id} onPress={() => ctx.onSelect(ctx.selected === p.v.id ? null : p.v.id)} />;
    }
    case "future":
      return (
        <Pressable accessibilityRole="button" accessibilityLabel="后面还有几步" onPress={() => ctx.onSelect(ctx.selected === "future" ? null : "future")} style={{ width: 150, borderRadius: 10, borderWidth: ctx.selected === "future" ? 2 : 1, borderStyle: "dashed", borderColor: ctx.selected === "future" ? c.foreground : c.border, padding: 10, gap: 3 }}>
          <Text style={[ui.styles.strong, { color: c.foregroundMuted }]}>后面还有 {p.stages.length} 步</Text>
          {p.stages.map((s) => (
            <Text key={s.id} style={ui.styles.small}>
              ○ {s.label}
            </Text>
          ))}
        </Pressable>
      );
    case "endghost":
      return <Terminal label="结束" dashed />;
  }
}

const dashedBetween = (a: Piece, b: Piece) => b.k === "skip" || a.k === "skip" || b.k === "future" || b.k === "endghost";

function Seq({ pieces, ctx }: { pieces: Piece[]; ctx: Ctx }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      {pieces.map((p, i) => {
        const prev = pieces[i - 1];
        return (
          <View key={i} style={{ flexDirection: "row", alignItems: "flex-start" }}>
            {prev ? prev.k === "dip" ? <Elbow down={false} /> : p.k === "dip" ? <Elbow down /> : <Edge dash={dashedBetween(prev, p)} /> : null}
            <PieceView p={p} ctx={ctx} />
          </View>
        );
      })}
    </View>
  );
}

export function StageChart({ view, selected, onSelect, openRun, focusAsk }: { view: GraphView; selected: string | null; onSelect(id: string | null): void; openRun(run: RunView): void; focusAsk?: () => void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const scroll = useRef<{ scrollTo(options: { x: number; animated?: boolean }): void } | null>(null);
  const [width, setWidth] = useState(0);
  const [content, setContent] = useState(0);
  const [offset, setOffset] = useState(0);
  const curX = useRef<number | null>(null);
  const scrolledToCur = useRef(false);
  const pieces = layoutOf(view.visits, view.graph.stages);
  const nowMs = Date.parse(view.now);
  const more = content > width + 4;
  const left = more && offset > 4;
  const right = more && offset + width < content - 4;

  const settle = (w: number, x: number | null) => {
    // Opens with the stage it is in in view: the way there is behind, the way on is a click away.
    if (scrolledToCur.current || x === null || w === 0) return;
    scrolledToCur.current = true;
    scroll.current?.scrollTo({ x: Math.max(0, x - 40), animated: false });
  };
  const ctx: Ctx = {
    view,
    selected,
    onSelect,
    nowMs,
    openRun,
    focusAsk,
    onCurX: (x) => {
      curX.current = x;
      settle(width, x);
    },
  };
  const hint = (text: string, on: boolean, go: () => void) =>
    on ? (
      <Pressable accessibilityRole="button" accessibilityLabel={text} onPress={go} style={{ paddingHorizontal: 10, paddingVertical: 2, borderRadius: 999, backgroundColor: tint(c.accent, 0.12) }}>
        <Text style={{ color: c.accent, fontSize: 12 }}>{text}</Text>
      </Pressable>
    ) : (
      <View />
    );
  return (
    <View style={{ gap: 8 }}>
      {more ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          {hint("← 左边还有", left, () => scroll.current?.scrollTo({ x: Math.max(0, offset - 360), animated: true }))}
          {hint("右边还有，横向滚动 →", right, () => scroll.current?.scrollTo({ x: offset + 360, animated: true }))}
        </View>
      ) : null}
      <ScrollView
        ref={scroll as never}
        horizontal
        showsHorizontalScrollIndicator
        onLayout={(e: { nativeEvent: { layout: { width: number } } }) => {
          setWidth(e.nativeEvent.layout.width);
          settle(e.nativeEvent.layout.width, curX.current);
        }}
        onContentSizeChange={(w: number) => setContent(w)}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => setOffset(e.nativeEvent.contentOffset.x)}
        scrollEventThrottle={64}
        contentContainerStyle={{ paddingVertical: 6, paddingRight: 24 }}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
          <Terminal label={view.trackingSince ? `${clockText(view.trackingSince)} 开始追踪` : "开始"} dashed />
          {pieces.length > 0 ? <Edge /> : null}
          <Seq pieces={pieces} ctx={ctx} />
        </View>
      </ScrollView>
      <ChartLegend />
    </View>
  );
}

function ChartLegend() {
  const ui = useUi();
  const c = ui.theme.colors;
  const swatch = (style: object) => <View style={[{ width: 14, height: 10, borderRadius: 3, borderWidth: 1, borderColor: c.border }, style]} />;
  const item = (node: React.ReactNode, text: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      {node}
      <Text style={ui.styles.small}>{text}</Text>
    </View>
  );
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
      {item(<Dot kind="ok" />, "走过")}
      {item(swatch({ borderColor: ui.tone("accent"), borderWidth: 2 }), "现在在这（颜色 = 球在谁手里）")}
      {item(swatch({ borderStyle: "dashed" }), "还没到 / 跳过")}
      {item(swatch({ borderColor: ui.tone("warning"), backgroundColor: tint(ui.tone("warning"), 0.1) }), "岔路：常规路线外多走的一步")}
      {item(swatch({ borderColor: c.accent, borderStyle: "dashed" }), "↻ 打回")}
      {item(swatch({ backgroundColor: c.surface2, borderStyle: "dashed" }), "开始追踪前（时间是推的）")}
    </View>
  );
}

// ---- the phone: the same visits, top to bottom ----------------------------------------------------

export function StageRail({ view, selected, onSelect, openRun, focusAsk }: { view: GraphView; selected: string | null; onSelect(id: string | null): void; openRun(run: RunView): void; focusAsk?: () => void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const tone = SITUATION[view.situation].tone;
  const nowMs = Date.parse(view.now);
  const visits = view.visits.filter((v) => !v.superseded);
  const walked = new Set(visits.map((v) => v.stage));
  const stopped = visits.some((v) => stageOf(view, v.stage).end);
  const rest = stopped ? [] : view.graph.normal.filter((id) => !walked.has(id) && !visits.some((v) => view.graph.normal.indexOf(v.stage) > view.graph.normal.indexOf(id))).map((id) => stageOf(view, id));
  const loops = visits.filter((v) => v.round > 1).length;
  return (
    <View style={{ gap: 0 }}>
      {loops > 0 ? <Text style={{ color: c.accent, fontSize: 12, fontWeight: "700", marginBottom: 4 }}>↻ 打回 {loops} 次</Text> : null}
      {visits.map((v, i) => {
        const meta = stageOf(view, v.stage);
        const last = i === visits.length - 1 && rest.length === 0;
        const balls = v.balls[v.balls.length - 1];
        const runs = v.cur ? view.runs : [];
        return (
          <View key={v.id} style={{ flexDirection: "row", gap: 10, backgroundColor: v.cur ? tint(ui.tone(tone), 0.1) : undefined, borderRadius: 8, paddingVertical: 4 }}>
            <View style={{ alignItems: "center", width: 14, paddingTop: 5 }}>
              <Dot kind={v.inferred ? "no" : v.cur ? "cur" : "ok"} tone={tone} />
              {last ? null : <View style={{ flex: 1, width: 1, backgroundColor: c.border, marginTop: 3 }} />}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`${meta.label}，点开看细节`} onPress={() => onSelect(selected === v.id ? null : v.id)} style={{ flex: 1, gap: 3, paddingBottom: 8, borderLeftWidth: meta.side ? 3 : 0, borderLeftColor: ui.tone("warning"), paddingLeft: meta.side ? 8 : 0 }}>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "baseline" }}>
                {meta.side ? <Text style={{ color: ui.tone("warning"), fontSize: 11 }}>岔路</Text> : null}
                <Text style={[ui.styles.strong, { flexShrink: 1, color: v.inferred ? c.foregroundMuted : c.foreground }]}>
                  {meta.label}
                  {v.round > 1 ? ` · ${v.round}` : ""}
                </Text>
                <View style={{ flex: 1 }} />
                <Text style={ui.styles.small}>{v.cur ? `${visitSpan(v)} · 进行中` : visitSpan(v)}</Text>
              </View>
              {v.inferred ? null : (
                <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
                  {v.cur && balls ? <BallChip actor={balls.actor} /> : null}
                  <Text style={[ui.styles.small, { flex: 1 }]}>{v.cur ? (balls?.what ?? "") : v.lastHeadline}</Text>
                </View>
              )}
              {v.cur && view.current.ask ? <Text style={{ color: ui.tone("warning"), fontSize: 12, fontWeight: "700" }}>问你：{view.current.ask.header} · 等你回答</Text> : null}
              {runs.map((r) => (
                <RunCard key={r.runId} run={r} onOpen={() => openRun(r)} />
              ))}
            </Pressable>
          </View>
        );
      })}
      {rest.map((s, i) => (
        <View key={s.id} style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ alignItems: "center", width: 14, paddingTop: 5 }}>
            <Dot kind="no" />
            {i === rest.length - 1 ? null : <View style={{ flex: 1, width: 1, borderLeftWidth: 1, borderStyle: "dashed", borderColor: c.border, marginTop: 3 }} />}
          </View>
          <View style={{ flex: 1, flexDirection: "row", paddingBottom: 8 }}>
            <Text style={[ui.styles.strong, { color: c.foregroundMuted, flex: 1 }]}>{s.label}</Text>
            <Text style={ui.styles.small}>还没到</Text>
          </View>
        </View>
      ))}
    </View>
  );
}
