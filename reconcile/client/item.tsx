import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { clockText, cutText, durationText, ledgerText, resumeNote, retryCost, RETRY_LABEL, SITUATION, troubleLine, type AskView, type GraphView, type HistoryLine, type RunView, type Visit } from "../shared/graph";
import { answerRpc, flowRpc, graphRpc } from "../shared/rpc";
import { BallChip, ChartLegend, StageChart, StageRail, StageStrip } from "./chart";
import { go, jumpOf } from "./jump";
import { Banner, Button, Fold, openExternal, OpenAgent, ScreenLink, TextLink, tint, useUi } from "./ui";

// The page of one item. The bar says whether it wants you, what is going on, and who has the ball; when a flow stopped, the way out
// (carry on, start over, take it over) is in the bar. A question waiting is answered right under it (the same answer as on its
// card). Then the route in one line and, in tabs, what happened, the chart of stages and the evidence. What it is tied to and what
// you said about it stand beside, only when there is something. The thing to approve is on the approval card, which the bar opens.

const POLL_MS = 5_000;
type GraphReply = RpcOutput<typeof graphRpc>;

function useGraph(caseId: string): { view: GraphView | null; error: string | null; gone: boolean; refresh(): void } {
  const graph = useRpc(graphRpc);
  const [state, setState] = useState<{ view: GraphView | null; error: string | null; gone: boolean }>({ view: null, error: null, gone: false });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const reply: GraphReply = await graph({ case: caseId });
        if (!cancelled) setState({ view: reply.graph as unknown as GraphView | null, error: null, gone: !reply.ok && reply.graph === null });
      } catch (error) {
        if (!cancelled) setState((current) => ({ ...current, error: String(error) }));
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [graph, caseId, nonce]);
  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

// ---- the top bar ------------------------------------------------------------------------------

function Glyph({ situation, size = 36 }: { situation: GraphView["situation"]; size?: number }) {
  const ui = useUi();
  const s = SITUATION[situation];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: ui.tone(s.tone), alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: ui.theme.colors.surface0, fontWeight: "800", fontSize: size * 0.44 }}>{s.icon}</Text>
    </View>
  );
}

type Done = (note: { ok: boolean; text: string }) => void;

/** The runs a person may do something about, the newest first: the first is the bar's, the others stand under it. */
const inTrouble = (view: GraphView): RunView[] => view.runs.filter((r) => (r.actions?.length ?? 0) > 0);

function Hero({ view, onDone }: { view: GraphView; onDone: Done }) {
  const ui = useUi();
  const s = SITUATION[view.situation];
  const color = ui.tone(s.tone);
  const gate = view.runs.find((r) => r.gate);
  const trouble = inTrouble(view)[0];
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: tint(color, 0.45), backgroundColor: tint(color, 0.1), padding: ui.compact ? 12 : 16, gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
        <Glyph situation={view.situation} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color, fontSize: 12, fontWeight: "700" }}>{view.hero.kicker}</Text>
          <Text style={{ color: ui.theme.colors.foreground, fontSize: ui.compact ? 16 : 19, fontWeight: "700", lineHeight: ui.compact ? 22 : 26 }} selectable>
            {view.hero.line}
          </Text>
          {view.hero.sub ? (
            <Text style={ui.styles.muted} selectable>
              {view.hero.sub}
            </Text>
          ) : null}
        </View>
      </View>
      {view.marks.map((m) => {
        // Something that looks wrong (stale data, the rule's own notice) is shown loud; what a person said is shown quiet.
        const loud = m.kind === "stale" || m.kind === "notice" || m.kind === "unread";
        return (
          <View key={m.kind + m.line} style={{ borderRadius: 8, borderWidth: 1, borderColor: loud ? tint(ui.tone("warning"), 0.6) : ui.theme.colors.border, backgroundColor: ui.theme.colors.surface1, paddingHorizontal: 10, paddingVertical: 6 }}>
            <Text style={[ui.styles.small, { color: loud ? ui.tone("warning") : ui.theme.colors.foregroundMuted }]} selectable>
              {loud ? "⚠ " : ""}
              {m.line}
            </Text>
          </View>
        );
      })}
      {gate?.gate?.agentId ? <OpenAgent agentId={gate.gate.agentId} label="去批准" primary /> : null}
      {trouble ? <Ways run={trouble} onDone={onDone} /> : null}
    </View>
  );
}

// ---- a run in trouble: the way out ------------------------------------------------------------

/**
 * What a person may do with a flow that stopped, failed or broke: one main button ("接着跑" when the flow said where it could carry on from,
 * else "从头重跑"), and, as words beside it, the others: start over, take it over ("我自己来"), fold it away, and the whole of the reason.
 */
function Ways({ run, onDone, withLine = false }: { run: RunView; onDone: Done; withLine?: boolean }) {
  const ui = useUi();
  const flow = useRpc(flowRpc);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const actions = run.actions ?? [];
  if (actions.length === 0) return null;
  const press = async (action: "resume" | "retry" | "mine" | "fold") => {
    setBusy(true);
    try {
      const reply = await flow({ runId: run.runId, action });
      onDone({ ok: reply.ok, text: reply.detail });
    } catch (error) {
      onDone({ ok: false, text: String(error) });
    } finally {
      setBusy(false);
    }
  };
  const resume = actions.includes("resume");
  const retry = actions.includes("retry");
  const whole = [run.why ? cutText(run.why, 600) : "", ...(run.settle?.commands ?? []), ledgerText(run.ledger), retry ? retryCost(run) : "", run.costUsd > 0 ? `已花 $${run.costUsd.toFixed(2)}` : ""].filter(Boolean);
  return (
    <View style={{ gap: 8 }}>
      {withLine ? (
        <Text style={ui.styles.strong} selectable>
          {troubleLine(run)}
        </Text>
      ) : null}
      <View style={[ui.styles.row, { gap: 10, alignItems: "center" }]}>
        {resume ? <Button icon="Play" primary label="接着跑" disabled={busy} onPress={() => void press("resume")} /> : retry ? <Button icon="RotateCw" primary label={RETRY_LABEL} disabled={busy} onPress={() => void press("retry")} /> : null}
        {!resume && !retry && run.situation === "slow" && run.agentId ? <OpenAgent agentId={run.agentId} label="打开那个 agent" primary /> : null}
        {resume ? (
          <Text style={[ui.styles.small, { flexShrink: 1 }]} selectable>
            {resumeNote(run)}
          </Text>
        ) : null}
      </View>
      <View style={[ui.styles.row, { gap: 14 }]}>
        {resume && retry ? <TextLink label={RETRY_LABEL} disabled={busy} onPress={() => void press("retry")} /> : null}
        <TextLink label="我自己来" disabled={busy} onPress={() => void press("mine")} />
        <TextLink label="收起" disabled={busy} onPress={() => void press("fold")} />
        {whole.length > 0 ? <TextLink label={`原因全文 ${open ? "▾" : "▸"}`} onPress={() => setOpen((value) => !value)} /> : null}
      </View>
      {open ? (
        <View style={{ gap: 2 }}>
          {whole.map((line) => (
            <Text key={line} style={ui.styles.small} selectable>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ---- answering a question here ----------------------------------------------------------------

export function AskPanel({ ask, onDone }: { ask: AskView; onDone(note: { ok: boolean; text: string }): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const answer = useRpc(answerRpc);
  const [chosen, setChosen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const color = ui.tone("warning");
  const chosenLabel = ask.options.find((o) => o.id === chosen)?.label;
  const submit = () => {
    if (busy) return;
    if (chosen === null && text.trim() === "") return onDone({ ok: false, text: "先选一个答案，或者写一句" });
    setBusy(true);
    answer({ commitmentId: ask.commitmentId, round: ask.round, ...(chosen !== null ? { option: chosen } : { text: text.trim() }) }).then(
      (reply) => {
        setBusy(false);
        onDone({ ok: reply.ok, text: reply.detail });
      },
      (error: unknown) => {
        setBusy(false);
        onDone({ ok: false, text: `没记下：${String(error)}` });
      },
    );
  };
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: color, backgroundColor: c.surface1, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 6, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: tint(color, 0.12) }}>
        <Text style={{ color, fontSize: 12, fontWeight: "700" }}>问你{ask.round > 1 ? ` · 第 ${ask.round} 次` : ""}</Text>
      </View>
      <View style={{ padding: 12, gap: 8 }}>
        <Text style={[ui.styles.strong, { fontSize: 15 }]} selectable>
          {ask.question}
        </Text>
        {ask.brief ? (
          <Text style={ui.styles.muted} selectable>
            {ask.brief}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {ask.options.map((o) => (
            <Pressable
              key={o.id}
              accessibilityRole="button"
              accessibilityState={{ selected: chosen === o.id }}
              accessibilityLabel={o.label}
              onPress={() => setChosen(chosen === o.id ? null : o.id)}
              style={{ flexGrow: 1, flexBasis: ui.compact ? "100%" : "46%", borderRadius: 8, borderWidth: chosen === o.id ? 2 : 1, borderColor: chosen === o.id ? c.foreground : c.border, backgroundColor: chosen === o.id ? c.surface2 : c.surface1, paddingHorizontal: 12, paddingVertical: 8, gap: 1 }}
            >
              <Text style={ui.styles.strong}>{o.label}</Text>
              {o.description ? <Text style={ui.styles.small}>{o.description}</Text> : null}
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {ask.allowOther ? (
            <TextInput
              value={text}
              onChangeText={(t: string) => {
                setText(t);
                if (t !== "") setChosen(null);
              }}
              placeholder="选项都不对？写一句"
              placeholderTextColor={c.foregroundMuted}
              accessibilityLabel="自己写答案"
              style={{ flexGrow: 1, flexBasis: 200, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, color: c.foreground, paddingHorizontal: 10, paddingVertical: 7, fontSize: 14 }}
            />
          ) : null}
          <Button icon="Check" primary label={busy ? "正在记…" : chosenLabel ? `提交：${chosenLabel}` : "提交"} disabled={busy} onPress={submit} />
        </View>
      </View>
    </View>
  );
}

// ---- the side: what it is tied to, what you said ----------------------------------------------------

const KIND_LABEL: Record<string, string> = { parent: "父单", child: "子单", requires: "前置", provides: "提供给", "same-key": "同开关" };

function SideHeading({ children }: { children: string }) {
  const ui = useUi();
  return <Text style={[ui.styles.small, { fontWeight: "700", marginTop: 4 }]}>{children}</Text>;
}

/** Whether there is anything for the side to say. */
const hasSide = (view: GraphView): boolean => view.links.length > 0 || view.said.length > 0;

function Side({ view, openCase }: { view: GraphView; openCase(caseId: string): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  return (
    <View style={{ gap: 8 }}>
      {view.links.length > 0 ? <SideHeading>关联的事项</SideHeading> : null}
      {view.links.map((l) => (
        <View key={`${l.kind}${l.number}`} style={{ gap: 1 }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <View style={{ paddingHorizontal: 6, borderRadius: 4, backgroundColor: c.surface2 }}>
              <Text style={ui.styles.small}>{KIND_LABEL[l.kind] ?? l.kind}</Text>
            </View>
            {l.caseId ? (
              <Pressable accessibilityRole="link" accessibilityLabel={`打开 ${l.number}`} onPress={() => openCase(l.caseId!)}>
                <Text style={{ color: c.accent, fontSize: 13, fontWeight: "600" }}>{l.number} ↗</Text>
              </Pressable>
            ) : (
              <Text style={ui.styles.strong}>{l.number}</Text>
            )}
            {l.state ? <Text style={ui.styles.small}>{SITUATION[l.state.situation].name} · {l.state.stageLabel}</Text> : <Text style={ui.styles.small}>不在追踪</Text>}
          </View>
          {l.label ? <Text style={ui.styles.small}>{l.label}</Text> : null}
          {l.state ? <Text style={ui.styles.small} numberOfLines={2}>{l.state.line}</Text> : null}
        </View>
      ))}
      {view.said.length > 0 ? <SideHeading>你在对话里说过的</SideHeading> : null}
      {view.said.map((s) => (
        <View key={s.id} style={{ borderLeftWidth: 3, borderLeftColor: s.inForce ? ui.tone("accent") : c.border, paddingLeft: 8, gap: 1 }}>
          <Text style={[s.inForce ? ui.styles.text : ui.styles.muted, { fontSize: 13 }]} selectable>
            「{s.said}」
          </Text>
          <Text style={ui.styles.small}>
            {s.by} {clockText(s.at)} 说 · {s.label}
            {s.until ? ` 到 ${s.until}` : ""}
            {s.how === "confirmed" ? " · 在卡片上确认的" : s.how === "confirmed-here" ? " · 在对话里确认的" : ""}
            {s.inForce ? " · 说一句就撤" : s.revokedAt ? ` · ${clockText(s.revokedAt)} 撤了` : " · 过期了"}
          </Text>
        </View>
      ))}
    </View>
  );
}

function StageDetail({ view, selected, onClose }: { view: GraphView; selected: string; onClose(): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const nowMs = Date.parse(view.now);
  const back = <Button icon="ArrowLeft" label="回到这个事项" onPress={onClose} />;
  if (selected === "future") {
    const route = view.graph.normal;
    const reached = Math.max(-1, ...view.visits.filter((v) => !v.superseded).map((v) => route.indexOf(v.stage)));
    const rest = route.slice(reached + 1).map((id) => view.graph.stages.find((s) => s.id === id)!).filter(Boolean);
    return (
      <View style={{ gap: 8 }}>
        <Text style={ui.styles.heading}>后面还有 {rest.length} 步</Text>
        <Text style={ui.styles.small}>还没到；每一步走到的标志</Text>
        {rest.map((s) => (
          <View key={s.id} style={{ gap: 2 }}>
            <Text style={ui.styles.strong}>{s.label}</Text>
            <Text style={ui.styles.muted}>{s.done ?? (s.end ? "终点" : "—")}</Text>
          </View>
        ))}
        {back}
      </View>
    );
  }
  const v: Visit | undefined = view.visits.find((x) => x.id === selected);
  if (!v) return back;
  const meta = view.graph.stages.find((s) => s.id === v.stage);
  return (
    <View style={{ gap: 8 }}>
      <Text style={ui.styles.heading}>
        {meta?.label ?? v.stage}
        {v.round > 1 ? ` · 第 ${v.round} 次` : ""}
      </Text>
      <Text style={ui.styles.small}>
        {meta?.side ? `岔路：${meta.when ?? ""} · ` : ""}
        {v.inferred ? "开始追踪前就过了的一步" : v.cur ? "现在在这" : meta?.end ? "终点" : "走过了"}
      </Text>
      {v.inferred ? (
        <Text style={ui.styles.muted}>开始追踪（{view.trackingSince ? clockText(view.trackingSince) : "—"}）时，这个事项已经过了这一步，所以没有记录；它在图上是按常规路线补出来的。</Text>
      ) : (
        <>
          <View style={{ gap: 3 }}>
            <Text style={ui.styles.small}>
              进来：{v.from ? clockText(v.from) : "—"}
              {v.fromKind === "happened" ? `（按单子上的证据；${v.observedAt ? clockText(v.observedAt) : "后来"} 才检查到）` : v.before ? "（只知道不晚于这个时间）" : "（这一次检查看到的时间）"}
            </Text>
            <Text style={ui.styles.small}>出去：{v.to ? clockText(v.to) : v.cur ? "还在这" : "—"}</Text>
            <Text style={ui.styles.small}>
              用时：{v.durationMs !== null ? durationText(v.durationMs) : "—"}
              {v.cur ? "，进行中" : ""}
            </Text>
          </View>
          <Text style={[ui.styles.small, { fontWeight: "700" }]}>这段里球在谁手里（系统自己判断的）</Text>
          {v.balls.map((b, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <BallChip actor={b.actor} />
              <Text style={[ui.styles.small, { flex: 1, color: c.foreground }]}>{b.what}</Text>
              <Text style={ui.styles.small}>{durationText(Math.max(0, (b.to ? Date.parse(b.to) : nowMs) - Date.parse(b.from)))}</Text>
            </View>
          ))}
          <Text style={[ui.styles.small, { fontWeight: "700" }]}>{v.cur || !v.lastHeadline ? "到下一步的标志" : "走的时候的样子"}</Text>
          <Text style={ui.styles.muted} selectable>
            {v.cur || !v.lastHeadline ? (meta?.done ?? "—") : v.lastHeadline}
          </Text>
          {v.skipped.length > 0 ? <Text style={ui.styles.muted}>没在这些步骤停过：{v.skipped.map((s) => view.graph.stages.find((x) => x.id === s.stage)?.label ?? s.stage).join("、")}。{v.skipped[0]!.why}</Text> : null}
          {v.cause === "rules-changed" ? <Text style={ui.styles.muted}>这一步是判断方法更新以后改判出来的。</Text> : null}
          {v.before ? <Banner tone="warning" icon="Info" title="开始追踪之前的部分，时间是推的" /> : null}
          {v.evidence.length > 0 ? (
            <Fold label={`这段里记下的事实（${v.evidence.length}）`}>
              {v.evidence.map((e, i) => (
                <Text key={i} style={ui.styles.small} selectable>
                  {clockText(e.at)} {e.field} = {e.value}
                  {e.evidence ? `（${e.evidence}）` : ""}
                </Text>
              ))}
            </Fold>
          ) : null}
        </>
      )}
      {back}
    </View>
  );
}

// ---- the tabs -------------------------------------------------------------------------------

function History({ view }: { view: GraphView }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const color: Record<string, string> = { stage: c.accent, ask: ui.tone("warning"), answer: ui.tone("warning"), said: ui.tone("accent"), rules: c.foregroundMuted, error: ui.tone("danger"), run: c.accent, note: c.foregroundMuted };
  const lines = view.history.filter((h) => !h.inner);
  if (lines.length === 0) return <Text style={ui.styles.muted}>日志里还没有这个事项的经过。</Text>;
  return (
    <View style={{ gap: 0 }}>
      {lines.map((h, i) => (
        <HistoryRow key={i} h={h} dot={color[h.kind] ?? c.border} last={i === lines.length - 1} />
      ))}
    </View>
  );
}

/** One line of what happened; what stands behind it (the reason, the whole of a look's finding) opens on a press. */
function HistoryRow({ h, dot, last }: { h: HistoryLine; dot: string; last: boolean }) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const body = (
    <View style={{ flex: 1, gap: 1 }}>
      <Text style={[ui.styles.small, { fontFamily: ui.styles.mono.fontFamily }]}>{clockText(h.at)}</Text>
      <Text style={[ui.styles.text, { fontSize: 13 }]} selectable={!h.detail}>
        {h.line}
        {h.detail ? <Text style={ui.styles.small}>{open ? "  ▾" : "  ▸"}</Text> : null}
      </Text>
      {open && h.detail ? (
        <Text style={ui.styles.small} selectable>
          {h.detail}
        </Text>
      ) : null}
    </View>
  );
  return (
    <View style={{ flexDirection: "row", gap: 10, paddingBottom: 8 }}>
      <View style={{ alignItems: "center", width: 12, paddingTop: 5 }}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: dot }} />
        {last ? null : <View style={{ flex: 1, width: 1, backgroundColor: ui.theme.colors.border, marginTop: 3 }} />}
      </View>
      {h.detail ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={open ? "收起详情" : "看详情"} onPress={() => setOpen((value) => !value)} style={{ flex: 1 }}>
          {body}
        </Pressable>
      ) : (
        body
      )}
    </View>
  );
}

function Evidence({ view }: { view: GraphView }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const row = (a: string, b: string, raw?: string | null) => (
    <View key={a + b} style={{ flexDirection: ui.compact ? "column" : "row", gap: ui.compact ? 1 : 12, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Text style={[ui.styles.small, { width: ui.compact ? undefined : 150 }]}>{a}</Text>
      <Text style={[ui.styles.text, { flex: 1, fontSize: 13 }]} selectable>
        {b}
      </Text>
      {raw ? (
        <Text style={[ui.styles.small, { flex: 1, fontFamily: ui.styles.mono.fontFamily }]} selectable>
          {raw}
        </Text>
      ) : null}
    </View>
  );
  const inner = view.history.filter((h) => h.inner);
  return (
    <View style={{ gap: 8 }}>
      {view.tag ? <Text style={ui.styles.small}>来源标签：{view.tag}</Text> : null}
      {view.evidence.waitFrom ? <Text style={ui.styles.small}>已等多久怎么算的：{view.evidence.waitFrom}</Text> : null}
      <View>
        {view.evidence.facts.length === 0 ? <Text style={ui.styles.muted}>没有记下的事实。</Text> : view.evidence.facts.map((f) => row(f.field, f.value, f.evidence ? `${f.evidence}（${clockText(f.at)}）` : clockText(f.at)))}
      </View>
      <Fold label="这条业务的全部阶段（包括这一单没走的岔路）">
        {view.graph.stages.map((s) => (
          <Text key={s.id} style={ui.styles.small}>
            <Text style={{ fontWeight: "700", color: c.foreground }}>{s.label}</Text>
            <Text style={{ fontFamily: ui.styles.mono.fontFamily }}> {s.id}</Text>
            {view.evidence.stages.find((x) => x.id === s.id)?.named === false ? "（规则里没有给名字）" : ""}
            {s.side ? `（岔路：${s.when ?? ""}）` : ""}
            {s.end ? `（终点${s.endKind === "dropped" ? "：不盯了" : s.endKind === "other" ? "：不跟了" : ""}）` : ""}
            {s.done ? `：${s.done}` : ""}
          </Text>
        ))}
      </Fold>
      <Fold label={`接下来会做什么（${view.schedule.length}）`}>
        {view.schedule.map((x, i) => (
          <Text key={i} style={ui.styles.small} selectable>
            {x.at ? clockText(x.at) : "现在"}　{x.line}
          </Text>
        ))}
      </Fold>
      {inner.length > 0 ? (
        <Fold label={`系统自己的记录（${inner.length}）`}>
          {inner.map((h, i) => (
            <Text key={i} style={ui.styles.small} selectable>
              {clockText(h.at)}　{h.line}
            </Text>
          ))}
        </Fold>
      ) : null}
      <Fold label="各来源上次读到">
        {view.evidence.sources.map((s) => (
          <Text key={s.id} style={ui.styles.small}>
            {s.id}：{s.state}，上次读到 {s.lastOkAt ? clockText(s.lastOkAt) : "从没"}，下次 {s.nextPollAt ? clockText(s.nextPollAt) : "—"}
          </Text>
        ))}
        {view.evidence.rule ? (
          <Text style={ui.styles.small}>
            判断方法 {view.evidence.rule.name}，指纹 {view.evidence.rule.fingerprint}
          </Text>
        ) : null}
      </Fold>
    </View>
  );
}

// ---- the page -------------------------------------------------------------------------------

type Tab = "history" | "graph" | "evidence";

export function ItemPage({ caseId, onBack, openCase, onChanged }: { caseId: string; onBack(): void; openCase(caseId: string): void; onChanged(): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const { view, error, gone, refresh } = useGraph(caseId);
  // What happened comes first: the question people ask of a page like this is "what has been going on".
  const [tab, setTab] = useState<Tab>("history");
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string; title?: string } | null>(null);
  const askAt = useRef(0);
  useEffect(() => {
    setSelected(null);
    setNote(null);
    setTab("history");
  }, [caseId]);

  const openRun = useCallback(
    (run: RunView) => {
      const jump = jumpOf({ navigation: ui.navigation, hostId: ui.hostId, routes: ui.routes, plugin: run.link.plugin, screen: run.link.screen, params: run.link.params });
      if (jump.how === "none") {
        setNote({ ok: false, title: "打不开这次流程", text: "这个版本的 Paseo 不能从这里跳过去；到「流程」页里按运行号找它：" + run.runId });
        return;
      }
      // The web route loads the page again; the host's own way does not.
      go(jump, run.link, (url) => (globalThis as { location?: { assign(url: string): void } }).location?.assign(url));
    },
    [ui.navigation, ui.hostId, ui.routes],
  );

  // What is said up here is only what is not so by itself: that the data is old, and that nothing is being asked for real.
  const stale = view?.marks.some((m) => m.kind === "stale") ?? false;
  const aside = view ? [stale ? `${clockText(view.now)} 读取` : "", view.mode === "dry-run" ? "演练" : ""].filter(Boolean).join(" · ") : "";
  const back = (
    <View style={[ui.styles.row, { justifyContent: "space-between" }]}>
      <Button icon="ArrowLeft" label="事项追踪" onPress={onBack} />
      {aside ? <Text style={[ui.styles.small, stale ? { color: ui.tone("warning") } : null]}>{aside}</Text> : null}
    </View>
  );
  if (!view) {
    return (
      <View style={{ gap: ui.styles.pad }}>
        {back}
        {gone ? <Banner tone="warning" icon="TriangleAlert" title="没有这个事项" /> : error ? <Banner tone="danger" icon="TriangleAlert" title="读不到这个事项" /> : <Text style={ui.styles.muted}>正在读取……</Text>}
        {error ? <Text style={ui.styles.small}>{error}</Text> : null}
      </View>
    );
  }
  const asks = view.current.asks;
  const done: Done = (n) => {
    setNote(n);
    refresh();
    onChanged();
  };
  const trouble = inTrouble(view);
  const newest = view.runs.find((r) => r.own !== false) ?? view.runs[0];
  const side = selected ? <StageDetail view={view} selected={selected} onClose={() => setSelected(null)} /> : hasSide(view) ? <Side view={view} openCase={openCase} /> : null;
  const chart = ui.compact ? <StageRail view={view} selected={selected} onSelect={setSelected} openRun={openRun} /> : <StageChart view={view} selected={selected} onSelect={setSelected} openRun={openRun} />;
  const anyBefore = view.visits.some((v) => v.before && !v.superseded);
  const main = (
    <View style={{ gap: ui.compact ? 12 : 14, flex: 1, minWidth: 0 }}>
      <View style={[ui.styles.row, { gap: 8, justifyContent: "space-between", flexWrap: "nowrap" }]}>
        <View style={[ui.styles.row, { gap: 8, flexShrink: 1, flexWrap: "nowrap", alignItems: "baseline" }]}>
          <Text style={[ui.styles.title, { fontSize: ui.compact ? 18 : 22 }]}>{view.number}</Text>
          <Text style={[ui.styles.strong, { flexShrink: 1, fontSize: 15 }]} selectable>
            {view.title}
          </Text>
        </View>
        {view.url ? <TextLink label="单子 ↗" onPress={() => openExternal(view.url!)} /> : null}
      </View>
      {error ? <Banner tone="warning" icon="TriangleAlert" title="刷新失败，下面是上一次读到的" /> : null}
      <Hero view={view} onDone={done} />
      {note ? (
        <Banner tone={note.ok ? "success" : "warning"} icon={note.ok ? "Check" : "Info"} title={note.title ?? (note.ok ? "好了" : "没成")}>
          <Text style={ui.styles.text} selectable>
            {note.text}
          </Text>
        </Banner>
      ) : null}
      {trouble.slice(1).map((r) => (
        <View key={r.runId} style={{ borderRadius: 10, borderWidth: 1, borderColor: ui.tone("warning"), backgroundColor: c.surface1, padding: 10 }}>
          <Ways run={r} withLine onDone={done} />
        </View>
      ))}
      {asks.map((a) => (
        <AskPanel
          key={`${a.commitmentId}:${a.round}`}
          ask={a}
          onDone={(n) => {
            setNote(n);
            askAt.current = Date.now();
            refresh();
            onChanged();
          }}
        />
      ))}
      <View style={{ gap: 8 }}>
        <StageStrip view={view} />
        {newest ? (
          <View style={ui.styles.row}>
            <ScreenLink plugin={newest.link.plugin} screen={newest.link.screen} params={newest.link.params} label="这次流程" />
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 4, borderBottomWidth: 1, borderBottomColor: c.border }}>
        {([["history", "经过"], ["graph", "阶段"], ["evidence", "证据"]] as const).map(([k, l]) => (
          <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: tab === k }} onPress={() => setTab(k)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: tab === k ? c.foreground : "transparent" }}>
            <Text style={{ color: tab === k ? c.foreground : c.foregroundMuted, fontWeight: tab === k ? "700" : "400", fontSize: 14 }}>{l}</Text>
          </Pressable>
        ))}
      </View>
      {tab === "history" ? (
        <History view={view} />
      ) : tab === "graph" ? (
        <View style={{ gap: 8 }}>
          {chart}
          <ChartLegend note={anyBefore ? `虚线灰底框和标「追踪前」「至少」「约」的时间：${view.trackingSince ? clockText(view.trackingSince) : ""} 开始追踪之前的部分，按单子上的日期推的，或者没有记录，不是实测的。` : null} />
          {view.deviations.length > 0 ? (
            <Text style={ui.styles.small}>
              {view.deviations.map((d) => `${view.graph.stages.find((s) => s.id === d.from)?.label ?? d.from} → ${view.graph.stages.find((s) => s.id === d.to)?.label ?? d.to}：${d.kind === "skip" ? "跳过" : d.kind === "back" ? "打回" : "岔路"}${d.why ? `（${d.why}）` : ""}`).join("；")}
            </Text>
          ) : null}
        </View>
      ) : (
        <Evidence view={view} />
      )}
      {/* On a phone the side comes under the tabs. */}
      {ui.compact && side ? <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12 }}>{side}</View> : null}
    </View>
  );
  return (
    <View style={{ gap: ui.styles.pad }}>
      {back}
      {!ui.compact && side ? (
        <View style={{ flexDirection: "row", gap: 18, alignItems: "flex-start" }}>
          {main}
          <View style={{ width: 340, borderLeftWidth: 1, borderLeftColor: c.border, paddingLeft: 16 }}>{side}</View>
        </View>
      ) : (
        main
      )}
    </View>
  );
}
