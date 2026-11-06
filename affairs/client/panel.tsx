import { useRpc } from "@getpaseo/plugin/client";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { PanelData } from "../shared/panel";
import { answerRpc, panelRpc, resumeFlowRpc } from "../shared/rpc";
import { Pieces, openExternal } from "./card";
import { FlowBox } from "./flow";
import { Materials, useFiles } from "./files";
import { ChoiceButton, Heading, QuestionCard, Rule, StateBadge, Tag } from "./look";
import { Timeline } from "./timeline";
import { Clip, Words } from "./text";

// The 进展 panel beside an affair's chat: now / what happened / sources / materials. It only draws what the plugin sends and asks again
// every few seconds while it is on screen; it keeps nothing and does nothing when it opens (it is also mounted while the sidebar is shut).

const POLL_MS = 4000;

// COMPAT(navigation.openFile): a fork-only way to open a file of the machine as a tab of the workspace; a host without it shows the file in the panel.
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
  const [showFacts, setShowFacts] = useState(false);
  useEffect(() => {
    let alive = true;
    const once = () =>
      void load({ workspaceId })
        .then((r) => alive && setPanel(r.panel))
        .catch(() => {});
    once();
    const timer = setInterval(once, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [workspaceId]);

  const heading = (text: string) => <Heading text={text} c={c} />;
  const body = { color: c.foreground, fontSize: 14, lineHeight: 20 } as const;
  const muted = { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 } as const;
  const toggle = (text: string, onPress: () => void) => (
    <Pressable onPress={onPress}>
      <Words style={{ color: c.accent, fontSize: 13, marginTop: 4 }}>{text}</Words>
    </Pressable>
  );

  if (panel === undefined)
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0, padding: 14 }}>
        <Words style={muted}>…</Words>
      </View>
    );
  if (panel === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0, padding: 14 }}>
        <Words style={muted}>这里不是事项。</Words>
      </View>
    );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 14, paddingBottom: 28 }}>
      <StateBadge mood={panel.mood} c={c} />
      {panel.flow ? heading("流程") : null}
      {panel.flow ? <FlowBox flow={panel.flow} c={c} workspaceId={workspaceId} navigation={navigation as Parameters<typeof FlowBox>[0]["navigation"]} busy={resuming} resume={() => {
        const action = panel.flow?.action;
        if (!action?.runId || !action.expect || resuming) return;
        setResuming(true);
        void resumeFlow({ affairId: panel.id, runId: action.runId, expect: action.expect }).then(async (r) => {
          setFlowReply(r.text);
          setPanel((await load({ workspaceId })).panel);
        }).catch(() => setFlowReply("没连上，请过一会儿再试。")).finally(() => setResuming(false));
      }} /> : null}
      {flowReply ? <Words style={muted}>{flowReply}</Words> : null}
      {heading("现在")}
      {panel.asks.map((a) => (
        <QuestionCard key={a.id} c={c} title={a.title} line={a.line}>
          {a.options.map((o, i) => (
            <ChoiceButton
              key={o}
              testID={`panel-ask-${o}`}
              text={o}
              primary={i === 0}
              c={c}
              onPress={() => void answer({ affairId: panel.id, askId: a.id, text: o }).then((r) => { if (!r.ok) setFlowReply(r.text); return load({ workspaceId }).then((r) => setPanel(r.panel)); })}
            />
          ))}
        </QuestionCard>
      ))}
      <Pieces text={panel.waiting.text} parts={panel.waiting.parts} color={c.accent} style={{ color: c.foreground, fontSize: 17, lineHeight: 24, fontWeight: "700" }} />
      {panel.now.text ? <Pieces text={panel.now.text} parts={panel.now.parts} color={c.accent} style={{ ...body, marginTop: 6 }} /> : null}
      {panel.next.text ? <Words style={{ ...muted, marginTop: 8 }}>下次　{panel.next.text}</Words> : null}
      {panel.spent ? <Words style={{ ...muted, marginTop: 2 }}>{panel.spent}</Words> : null}
      {panel.facts.length ? toggle(showFacts ? "收起记住的 ›" : `记住的 ${panel.facts.length} 条 ›`, () => setShowFacts(!showFacts)) : null}
      {showFacts ? panel.facts.map((f, i) => <Pieces key={i} text={`· ${f.text}`} parts={f.parts} color={c.accent} style={{ ...muted, marginTop: 4 }} />) : null}

      <Timeline events={panel.events.items} c={c} files={files} />

      {heading("来源")}
      {panel.sources.items.length === 0 ? <Words style={muted}>还没有</Words> : null}
      {panel.sources.items.map((s, i) => (
        <View key={i}>
          {i > 0 ? <Rule c={c} /> : null}
          {/* the name and what was read on the left, taking the width that is left and folding its lines; the time on the right, never squeezed */}
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              {s.href ? (
                <Pressable onPress={() => openExternal(s.href!)} accessibilityRole="link">
                  <Words style={{ ...body, color: c.accent, fontWeight: "700", textDecorationLine: "underline" }}>↗ {s.label}</Words>
                </Pressable>
              ) : (
                <View style={{ flexDirection: "row" }}>
                  <Tag text={s.label} c={c} />
                </View>
              )}
              {s.status ? <Clip text={s.status} full={s.full} style={{ ...muted, color: s.status === "读不到" ? c.statusDanger : c.foreground }} /> : null}
            </View>
            {s.at ? <Words style={{ ...muted, flexShrink: 0 }}>{s.at}</Words> : null}
          </View>
        </View>
      ))}
      {panel.sources.more ? <Words style={{ ...muted, marginTop: 6 }}>还有 {panel.sources.more} 项</Words> : null}

      {heading("资料")}
      <Materials items={panel.materials.items} more={panel.materials.more} files={files} c={c} />
    </ScrollView>
  );
}
