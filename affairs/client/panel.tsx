import { useRpc } from "@getpaseo/plugin/client";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { PanelData } from "../shared/panel";
import { answerRpc, materialRpc, panelRpc } from "../shared/rpc";
import { Pieces, openExternal } from "./card";
import { Clip, Words } from "./text";

// The 进展 panel beside an affair's chat: now / sources / materials. It only draws what the plugin sends and asks again
// every few seconds while it is on screen; it keeps nothing and does nothing when it opens (it is also mounted while the sidebar is shut).

const POLL_MS = 4000;

export function Panel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const c = theme.colors;
  const load = useRpc(panelRpc);
  const answer = useRpc(answerRpc);
  const material = useRpc(materialRpc);
  const [open, setOpen] = useState<{ name: string; text: string; truncated: boolean } | null>(null);
  const [panel, setPanel] = useState<PanelData | null | undefined>(undefined);
  const [showRecent, setShowRecent] = useState(false);
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

  const heading = (text: string) => <Words style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.5, marginTop: 18, marginBottom: 6 }}>{text}</Words>;
  const body = { color: c.foreground, fontSize: 14, lineHeight: 20 } as const;
  const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 } as const;
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

  const recent = panel.recent;
  const last = recent[recent.length - 1];
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 14, paddingBottom: 28 }}>
      {heading("现在")}
      {panel.asks.map((a) => (
        <View key={a.id} style={{ backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 10, padding: 12, gap: 8, marginBottom: 10 }}>
          <Words style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>{a.title}</Words>
          {a.line ? <Words style={muted}>{a.line}</Words> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {a.options.map((o) => (
              <Pressable
                key={o}
                testID={`panel-ask-${o}`}
                onPress={() => void answer({ affairId: panel.id, askId: a.id, text: o }).then(() => load({ workspaceId }).then((r) => setPanel(r.panel)))}
                style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, maxWidth: "100%" }}
              >
                <Words style={{ color: c.foreground, fontSize: 14 }}>{o}</Words>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
      <Pieces text={panel.waiting.text} parts={panel.waiting.parts} color={c.accent} style={{ ...body, fontWeight: "600" }} />
      {panel.now.text ? <Pieces text={panel.now.text} parts={panel.now.parts} color={c.accent} style={{ ...body, marginTop: 2 }} /> : null}
      {panel.next.text ? <Words style={{ ...muted, marginTop: 6 }}>下次　{panel.next.text}</Words> : null}
      {panel.spent ? <Words style={{ ...muted, marginTop: 2 }}>{panel.spent}</Words> : null}
      {last ? (
        <>
          <Words style={{ ...muted, marginTop: 6 }}>最近　{last.text}</Words>
          {toggle(showRecent ? "收起 ›" : "展开最近的经过 ›", () => setShowRecent(!showRecent))}
        </>
      ) : null}
      {showRecent
        ? recent.map((r) => <Pieces key={r.key} text={r.text} parts={r.parts} color={c.accent} style={{ ...muted, color: r.tone === "red" ? c.statusDanger : c.foregroundMuted, marginTop: 4 }} />)
        : null}
      {panel.facts.length ? toggle(showFacts ? "收起记住的 ›" : `记住的 ${panel.facts.length} 条 ›`, () => setShowFacts(!showFacts)) : null}
      {showFacts ? panel.facts.map((f, i) => <Pieces key={i} text={`· ${f.text}`} parts={f.parts} color={c.accent} style={{ ...muted, marginTop: 4 }} />) : null}

      {heading("来源")}
      {panel.sources.items.length === 0 ? <Words style={muted}>还没有</Words> : null}
      {panel.sources.items.map((s, i) => (
        // the name and what was read on the left, taking the width that is left and folding its lines; the time on the right, never squeezed
        <View key={i} style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Pressable disabled={!s.href} onPress={() => s.href && openExternal(s.href)}>
              <Words style={{ ...body, color: s.href ? c.accent : c.foreground, textDecorationLine: s.href ? "underline" : "none" }}>{s.label}</Words>
            </Pressable>
            {s.status ? <Clip text={s.status} full={s.full} style={muted} /> : null}
          </View>
          {s.at ? <Words style={{ ...muted, flexShrink: 0 }}>{s.at}</Words> : null}
        </View>
      ))}
      {panel.sources.more ? <Words style={muted}>还有 {panel.sources.more} 项</Words> : null}

      {heading("资料")}
      {panel.materials.items.length === 0 ? <Words style={muted}>还没有</Words> : null}
      {panel.materials.items.map((m, i) => (
        <View key={i} style={{ marginBottom: 6 }}>
          <Pressable
            testID={`material-${m.name}`}
            onPress={() => (open?.name === m.name ? setOpen(null) : void material({ workspaceId, name: m.name }).then((r) => setOpen({ name: m.name, text: r.text, truncated: r.truncated })))}
            style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}
          >
            <Words style={{ ...body, flex: 1, color: c.accent }}>{m.name}</Words>
            <Words style={{ ...muted, flexShrink: 0 }}>
              {m.who} · {m.at}
            </Words>
          </Pressable>
          {open?.name === m.name ? (
            <View style={{ backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 4 }}>
              <Words selectable style={{ ...muted, color: c.foreground }}>
                {open.text}
                {open.truncated ? "\n…（只显示前面一部分）" : ""}
              </Words>
            </View>
          ) : null}
        </View>
      ))}
      {panel.materials.more ? <Words style={muted}>还有 {panel.materials.more} 个</Words> : null}
    </ScrollView>
  );
}
