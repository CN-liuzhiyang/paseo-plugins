import * as pluginClient from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Linking, type TextStyle } from "react-native";
import { QuestionCard, ChoiceButton } from "./look";
import { Words } from "./text";
import type { Ask, Line, Segment } from "../shared/card";
import { answerRpc } from "../shared/rpc";

/** Opens an outside address by the host's own opener (the desktop app's browser), else `Linking`. Only web addresses. */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const open = (pluginClient as { openExternalUrl?: unknown }).openExternalUrl;
  void (typeof open === "function" ? (open as (u: string) => Promise<void>)(url) : Linking.openURL(url)).catch(() => {});
}

/** Text in pieces: the pieces that have an address can be pressed to open it, in the host's link color; the rest is plain. */
export function Pieces({ text, parts, color, style }: { text: string; parts?: Segment[]; color: string; style: TextStyle | TextStyle[] }) {
  if (!parts?.some((p) => p.href)) return <Words style={style}>{text}</Words>;
  return (
    <Words style={style}>
      {parts.map((p, i) =>
        p.href ? (
          <Words key={i} accessibilityRole="link" onPress={() => openExternal(p.href!)} style={{ color, textDecorationLine: "underline" }}>
            {p.text}
          </Words>
        ) : (
          p.text
        ),
      )}
    </Words>
  );
}

/** A line in the chat: the time and what happened, in the chat's own text size; red when it is something that was not as it should be. */
export function AffairLine({ item, theme }: PluginTimelineItemProps<Line>) {
  const c = theme.colors;
  const { text, tone, parts } = item.data;
  return <Pieces text={text} parts={parts} color={c.accent} style={{ color: tone === "red" ? c.statusDanger : c.foregroundMuted, fontSize: 14, lineHeight: 21, marginVertical: 4 }} />;
}

/** A question for him, with its choices as buttons. Pressing one answers it; he can also just say it in the chat. */
export function AffairAsk({ item, theme, layout }: PluginTimelineItemProps<Ask>) {
  const c = theme.colors;
  const answer = useRpc(answerRpc);
  const { affair, id, title, line, options } = item.data;
  const [sent, setSent] = useState("");
  const press = (text: string) => {
    setSent(text);
    void answer({ affairId: affair, askId: id, text })
      .then((r) => !r.ok && setSent(""))
      .catch(() => setSent(""));
  };
  return (
    <QuestionCard
      c={c}
      title={title}
      line={line}
      size={layout.compact ? 15 : 16}
      footer={<Words style={{ color: c.foregroundMuted, fontSize: 12 }}>{sent ? "好，记下了" : "也可以直接跟我说"}</Words>}
    >
      {options.map((o, i) => (
        <ChoiceButton key={o} testID={`ask-${o}`} text={o} primary={i === 0} picked={sent === o} c={c} disabled={Boolean(sent)} dim={Boolean(sent) && sent !== o} onPress={() => press(o)} />
      ))}
    </QuestionCard>
  );
}
