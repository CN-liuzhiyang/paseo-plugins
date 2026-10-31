import { useRpc, useAgent, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { cardButton, cardSentence, markOf, nameOf, nameParts } from "../shared/bar";
import { isOver, type RunCard } from "../shared/card";
import { formatTime } from "../shared/format";
import { readCardRpc } from "../shared/rpc";
import { ms } from "../shared/run";
import { useNow } from "./data";
import { Button, UiProvider, useUi } from "./ui";

// The card in the conversation that started a run: one line. Which flow on what input, the one
// sentence about where it is or what it needs, and one button -- to the flow bar beside the
// conversation, or to the thing that waits for you (none once it has finished; the line opens it too).
// The daemon replaces the card as the run moves; while the run is live the card also asks for the
// latest itself, so its clock and state stay true.

const REFRESH_MS = 5_000;
const TICK_MS = 10_000;

export interface OpenRun {
  /**
   * Shows the run: beside the conversation when `aside`, otherwise in the workspace's 流程 tab. In
   * the workspace of the conversation when there is one.
   */
  (input: { runId: string; workspaceId: string | null; select: string; aside: boolean }): void;
}

type Freshness = { card: RunCard; failed: string | null };

/** The newer of the card in the timeline and the one last fetched. */
function newer(a: RunCard, b: RunCard | null): RunCard {
  if (!b) return a;
  return (ms(b.evaluatedAt) ?? 0) >= (ms(a.evaluatedAt) ?? 0) ? b : a;
}

function useLiveCard(initial: RunCard): Freshness {
  const read = useRpc(readCardRpc);
  const [fetched, setFetched] = useState<RunCard | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const card = newer(initial, fetched);
  const live = !isOver(card);
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const result = await read({ runId: initial.runId });
        if (cancelled) return;
        if (result.card) setFetched(result.card);
        setFailed(result.state === "ok" ? null : result.detail || result.state);
      } catch (error) {
        if (!cancelled) setFailed(String(error));
      }
      if (!cancelled) timer = setTimeout(tick, REFRESH_MS);
    };
    timer = setTimeout(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live, read, initial.runId]);
  return { card, failed };
}

function Card({ initial, agentId, openRun }: { initial: RunCard; agentId: string; openRun: OpenRun }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const { card, failed } = useLiveCard(initial);
  const live = !isOver(card);
  const now = useNow(live, TICK_MS);
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  const mark = markOf(card);
  const tone = ui.tone(mark.tone);
  const button = cardButton(card);
  const name = nameOf(card);
  const parts = nameParts(card);
  const sentence = cardSentence(card, now);
  const open = () => openRun({ runId: card.runId, workspaceId, select: button?.select ?? card.focus, aside: !ui.compact });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`流程 ${name}：${sentence}`}
      onPress={open}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderWidth: 1,
        borderColor: card.gate ? tone : c.border,
        borderLeftWidth: 3,
        borderLeftColor: tone,
        borderRadius: 8,
        backgroundColor: card.gate ? ui.tint("warning", 0.08) : c.surface1,
        paddingVertical: 6,
        paddingHorizontal: 10,
        marginVertical: 4,
      }}
    >
      <Icon name={mark.icon} size={14} color={tone} />
      <Text style={[ui.styles.muted, { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18 }]} numberOfLines={ui.compact ? 2 : 1}>
        <Text style={{ color: c.foreground, fontWeight: "600" }}>{parts.flow}</Text>
        {parts.label ? ` ${parts.label}` : ""}
        {` · ${sentence}`}
        {failed && live ? <Text style={ui.styles.small}>{` · ${formatTime(card.evaluatedAt, now)} 的状态`}</Text> : null}
      </Text>
      {button ? (
        <View>
          <Button small primary={card.gate !== null} label={button.label} onPress={open} />
        </View>
      ) : null}
    </Pressable>
  );
}

export function makeRunCard(openRun: OpenRun) {
  return function RunCardItem(props: PluginTimelineItemProps<RunCard>) {
    return (
      <UiProvider props={props}>
        <Card initial={props.item.data} agentId={props.agentId} openRun={openRun} />
      </UiProvider>
    );
  };
}
