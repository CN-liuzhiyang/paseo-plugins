import { useRpc } from "@getpaseo/plugin/client";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import type { PanelData } from "../shared/panel";
import { tint } from "../shared/look";
import { answerRpc, panelRpc, resumeFlowRpc } from "../shared/rpc";
import { Pieces, openExternal } from "./card";
import { FlowBox } from "./flow";
import { Materials, What, useFiles } from "./files";
import { ChoiceButton, Dot, Heading, OtherAnswer, QuestionCard, Rule, Section, StateBadge } from "./look";
import { Sessions, SessionSummary } from "./sessions";
import { Timeline } from "./timeline";
import { Clip, Words } from "./text";

const POLL_MS = 4000;
// COMPAT(navigation.openFile): a fork-only way to open a machine file in the workspace.
type OpenFile = (input: { workspaceId: string; path: string }) => void;

export function Panel({ theme, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const c = theme.colors;
  const load = useRpc(panelRpc);
  const answer = useRpc(answerRpc);
  const resumeFlow = useRpc(resumeFlowRpc);
  const [resuming, setResuming] = useState(false);
  const [flowReply, setFlowReply] = useState("");
  const files = useFiles(workspaceId, (navigation as { openFile?: OpenFile } | undefined)?.openFile);
  const [panel, setPanel] = useState<PanelData | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const once = () => void load({ workspaceId }).then((r) => alive && setPanel(r.panel)).catch(() => {});
    once();
    const timer = setInterval(once, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [workspaceId]);
  const body = { color: c.foreground, fontSize: 14, lineHeight: 20 } as const;
  const muted = { color: c.foregroundMuted, fontSize: 12, lineHeight: 18 } as const;
  if (!panel) return <View style={{ flex: 1, backgroundColor: c.surface0, padding: 16 }}><Words style={muted}>{panel === undefined ? "…" : "这里不是事项。"}</Words></View>;

  const steps = panel.stepList ?? [];
  const sourceColor = (s: PanelData["sources"]["items"][number]) => s.tone === "bad" ? c.statusDanger : s.tone === "ok" ? c.statusSuccess : c.foregroundMuted;
  const done = steps.filter((s) => s.state === "done").length;
  const budget = panel.budget;
  const sourceCount = panel.sources.items.length + panel.sources.more;
  const section = { affairId: panel.id, c };
  const notes = (items: PanelData["facts"], lines: number) => items.map((n, i) => <Clip key={i} text={n.text} parts={n.parts} linkColor={c.accent} onLink={openExternal} lines={lines} style={muted} />);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ paddingBottom: 28 }}>
      {panel.what ? <What key={panel.id} what={panel.what} files={files} c={c} /> : null}
      <View style={{ padding: 16, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <StateBadge mood={panel.mood} c={c} />
        <Pieces text={panel.waiting.text} parts={panel.waiting.parts} color={c.accent} style={{ color: c.foreground, fontSize: 17, lineHeight: 24, fontWeight: "700" }} />
        {panel.now.text ? <Pieces text={panel.now.text} parts={panel.now.parts} color={c.accent} style={body} /> : null}
        {panel.next.text ? <Words style={muted}>下次　{panel.next.text}</Words> : null}
        {budget ? <View style={{ gap: 5, marginTop: 4 }}>
          {budget.cap !== undefined && budget.cap > 0 ? <View accessibilityLabel={`额度已用 ${Math.round(budget.usd / budget.cap * 100)}%`} style={{ height: 6, borderRadius: 3, backgroundColor: c.surface2, overflow: "hidden" }}><View style={{ height: 6, borderRadius: 3, width: `${Math.min(100, Math.max(0, budget.usd / budget.cap * 100))}%`, backgroundColor: budget.usd / budget.cap > 0.8 ? c.statusWarning : c.accent }} /></View> : null}
          <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 4 }}>
            <Words style={{ ...muted, color: c.foreground, fontVariant: ["tabular-nums"] }}>{`$${budget.usd.toFixed(2)}${budget.cap !== undefined ? ` / $${budget.cap}` : ""}`}</Words>
            {budget.unknown ? <Words style={muted}>另 {budget.unknown} 个会话花费不明</Words> : null}
          </View>
        </View> : panel.spent ? <Words style={muted}>{panel.spent}</Words> : null}
      </View>
      {panel.flow || flowReply || panel.asks.length ? <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
        {panel.flow ? <><Heading text="流程" c={c} /><FlowBox flow={panel.flow} c={c} workspaceId={workspaceId} navigation={navigation as Parameters<typeof FlowBox>[0]["navigation"]} busy={resuming} hideStale={Boolean(flowReply)} resume={() => {
          const action = panel.flow?.action;
          if (!action?.runId || !action.expect || resuming) return;
          setResuming(true);
          void resumeFlow({ affairId: panel.id, runId: action.runId, expect: action.expect }).then(async (r) => {
            setFlowReply(r.text);
            setPanel((await load({ workspaceId })).panel);
          }).catch(() => setFlowReply("没连上，请过一会儿再试。")).finally(() => setResuming(false));
        }} /></> : null}
        {flowReply ? <Words style={muted}>{flowReply}</Words> : null}
        {panel.asks.map((a) => {
          const send = (text: string) => void answer({ affairId: panel.id, askId: a.id, text }).then((r) => { if (!r.ok) setFlowReply(r.text); return load({ workspaceId }).then((r) => setPanel(r.panel)); });
          return <QuestionCard key={a.id} c={c} title={a.title} line={a.line} footer={<OtherAnswer c={c} testID={`panel-ask-other-${a.id}`} onSend={send} />}>
            {a.options.map((o, i) => <ChoiceButton key={o} testID={`panel-ask-${o}`} text={o} primary={i === 0} c={c} onPress={() => send(o)} />)}
          </QuestionCard>;
        })}
      </View> : null}

      <Section key={`${panel.id}-sources`} {...section} name="sources" title="来源" count={sourceCount || undefined} defaultOpen={sourceCount > 0} disabled={!sourceCount} summary={sourceCount ? <>
        {panel.sources.items.slice(0, 3).map((s, i) => <View key={i} style={{ backgroundColor: s.tone === "bad" ? tint(c.statusDanger, "1f", c.surface2) : c.surface1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, maxWidth: "100%" }}><Words numberOfLines={1} style={{ ...muted, fontSize: 11, color: s.tone === "bad" ? c.statusDanger : c.foregroundMuted }}>{[s.label, s.status].filter(Boolean).join(" ")}</Words></View>)}
        {sourceCount > 3 ? <Words style={muted}>+{sourceCount - 3}</Words> : null}
      </> : <Words style={muted}>还没接</Words>}>
        {panel.sources.items.map((s, i) => <View key={i}>
          {i ? <Rule c={c} /> : null}
          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
            <View style={{ paddingTop: 6 }}><Dot color={sourceColor(s)} /></View>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
                <Words numberOfLines={1} accessibilityRole={s.href ? "link" : undefined} onPress={s.href ? () => openExternal(s.href!) : undefined} style={{ ...body, fontSize: 13, fontWeight: "600", color: s.href ? c.accent : c.foreground }}>{s.label}{s.href ? " ↗" : ""}</Words>
                {s.status && s.status.length <= 24 ? <Words numberOfLines={1} style={{ ...muted, color: s.tone ? sourceColor(s) : c.foreground, flex: 1 }}>{s.status}</Words> : <View style={{ flex: 1 }} />}
                {s.at ? <Words style={{ ...muted, flexShrink: 0 }}>{s.at}</Words> : null}
              </View>
              {s.full || (s.status && s.status.length > 24) ? <Clip text={s.full ?? s.status!} lines={2} style={{ ...muted, color: c.foreground }} /> : null}
            </View>
          </View>
        </View>)}
        {panel.sources.more ? <Words style={{ ...muted, marginTop: 6 }}>还有 {panel.sources.more} 项</Words> : null}
      </Section>

      {steps.length || panel.steps?.length ? <Section key={`${panel.id}-steps`} {...section} name="steps" title="步骤" count={steps.length ? `${done}/${steps.length}` : undefined} defaultOpen summaryAlways summary={<View style={{ flexDirection: "row", flexShrink: 1, gap: 3 }}>{steps.map((s, i) => <View key={i} style={{ height: 4, width: 12, flexShrink: 1, borderRadius: 2, backgroundColor: s.state === "done" ? c.statusSuccess : s.state === "now" ? c.accent : s.state === "blocked" ? c.statusDanger : c.border }} />)}</View>}>
        {steps.map((s, i) => {
          const color = s.state === "done" ? c.statusSuccess : s.state === "blocked" ? c.statusDanger : s.state === "now" ? c.accent : c.border;
          const checked = s.state === "done" && s.number === undefined;
          return <View key={i} style={{ flexDirection: "row", gap: 10, paddingBottom: i === steps.length - 1 ? 0 : 10 }}>
            <View style={{ width: 20, alignItems: "center" }}>
              {i < steps.length - 1 ? <View style={{ position: "absolute", top: 20, bottom: -10, width: 2, backgroundColor: s.state === "done" ? tint(c.statusSuccess, "66", c.border) : c.border }} /> : null}
              <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: checked ? 0 : 2, borderColor: color, backgroundColor: checked ? color : c.surface0, alignItems: "center", justifyContent: "center" }}><Words style={{ color: checked ? c.surface0 : s.state === "todo" ? c.foregroundMuted : color, fontSize: 11, fontWeight: "700" }}>{checked ? "✓" : s.number ?? i + 1}</Words></View>
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Words style={{ fontSize: 13, lineHeight: 20, fontWeight: s.state === "todo" ? "400" : "600", color: s.state === "todo" ? c.foregroundMuted : c.foreground }}>{s.title}</Words>
              {s.note || s.state === "blocked" ? <Clip text={s.note || "原因未说明"} lines={1} style={{ ...muted, color: s.state === "blocked" ? c.statusDanger : c.foregroundMuted }} /> : null}
              {notes(s.notes, 1)}
            </View>
          </View>;
        })}
        {!steps.length ? panel.steps?.map((s, i) => <Words key={i} style={muted}>{s}</Words>) : null}
      </Section> : null}

      {panel.sessions.length ? <Section key={`${panel.id}-sessions`} {...section} name="sessions" title="会话" count={panel.sessions.length} defaultOpen={panel.sessions.some((s) => s.status === "等你批" || s.status === "干活中")} summaryAlways summary={<SessionSummary sessions={panel.sessions} c={c} />}>
        <Sessions sessions={panel.sessions} c={c} openAgent={navigation?.openAgent} />
      </Section> : null}
      <Section key={`${panel.id}-events`} {...section} name="events" title="经过" defaultOpen summary={<Words style={muted}>{panel.events.items[0]?.when}</Words>}>
        <Timeline events={panel.events.items} c={c} files={files} embedded />
      </Section>
      {panel.facts.length ? <Section key={`${panel.id}-facts`} {...section} name="facts" title="记下的" count={panel.facts.length} defaultOpen={false}><View style={{ gap: 8 }}>{notes(panel.facts, 2)}</View></Section> : null}
      {panel.materials.items.length ? <Section key={`${panel.id}-materials`} {...section} name="materials" title="资料" count={panel.materials.items.length + panel.materials.more} defaultOpen={false}><Materials items={panel.materials.items} more={panel.materials.more} files={files} c={c} /></Section> : null}
    </ScrollView>
  );
}
