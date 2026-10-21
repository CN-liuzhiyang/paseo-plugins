import { useRpc, useAgent, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { isFinished, type RunCard } from "../shared/card";
import { formatDuration, formatTime, formatUsd } from "../shared/format";
import { readCardRpc } from "../shared/rpc";
import { ms } from "../shared/run";
import { useNow } from "./data";
import { HERO_ICON } from "./looks";
import { PhaseStrip } from "./run-list";
import { Badge, Button, UiProvider, useUi } from "./ui";

// The card in the conversation that started a run. Read in three seconds: what flow on what
// input and in what state; one sentence about what it is doing, what it needs from you, or how
// it ended; how far through the phases, for how long and at what cost; and the one or two
// buttons that take you to the run. The daemon replaces the card as the run moves; while the run
// is live the card also asks for the latest itself, so its clock and state stay true.

const REFRESH_MS = 5_000;

export interface OpenRun {
  /** Opens the run, in the workspace of the conversation when there is one. */
  (input: { runId: string; workspaceId: string | null; select: string }): void;
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
  const live = !isFinished(card.status);
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

function Numbers({ card, now }: { card: RunCard; now: number }) {
  const ui = useUi();
  const started = ms(card.startedAt);
  const took =
    card.durationMs ?? (started === null ? null : (isFinished(card.status) || card.status === "lost" ? (ms(card.lastEventAt) ?? now) : now) - started);
  const parts = [
    took === null ? null : `${isFinished(card.status) ? "用时" : "已运行"} ${formatDuration(took)}`,
    card.costUsd === null ? null : `${formatUsd(card.costUsd)}${card.costNote && !isFinished(card.status) ? " 起" : ""}`,
  ].filter(Boolean);
  return <Text style={ui.styles.small}>{parts.join(" · ")}</Text>;
}

/** The line under the sentence: how long the gate has waited, or how the run went quiet. */
function Detail({ card, now }: { card: RunCard; now: number }) {
  const ui = useUi();
  if (card.gate) {
    const since = ms(card.gate.since);
    const text = [
      since === null ? null : `已等 ${formatDuration(now - since)}`,
      card.gate.timeout ? `${card.gate.timeout} 内没人处理，人闸按过期拒绝` : null,
    ]
      .filter(Boolean)
      .join("，");
    return text ? <Text style={[ui.styles.small, { color: ui.tone("warning") }]}>{text}</Text> : null;
  }
  if (card.status === "lost") {
    const last = ms(card.lastEventAt);
    return (
      <Text style={[ui.styles.small, { color: ui.tone("warning") }]}>
        {last === null ? "" : `${formatDuration(now - last)}没有新事件。`}它起的 agent 没有被停掉，可能还在跑、还在花钱。
      </Text>
    );
  }
  return null;
}

function Card({ initial, agentId, openRun }: { initial: RunCard; agentId: string; openRun: OpenRun }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const { card, failed } = useLiveCard(initial);
  const live = !isFinished(card.status);
  const now = useNow(live);
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  const tone = ui.tone(card.tone);
  const name = [card.flow ?? "编排运行", card.label].filter(Boolean).join(" · ");
  const open = (select: string) => openRun({ runId: card.runId, workspaceId, select });
  return (
    <View
      accessibilityLabel={`编排运行 ${name}：${card.kicker}，${card.title}`}
      style={{
        borderWidth: 1,
        borderColor: card.gate ? tone : c.border,
        borderLeftWidth: 4,
        borderLeftColor: tone,
        borderRadius: 10,
        backgroundColor: card.gate ? ui.tint("warning", 0.08) : c.surface1,
        padding: 12,
        gap: 8,
        marginVertical: 4,
      }}
    >
      <View style={[ui.styles.row, { justifyContent: "space-between" }]}>
        <View style={[ui.styles.row, { flexShrink: 1, minWidth: 0 }]}>
          <Icon name={HERO_ICON[card.status]} size={14} color={tone} />
          <Badge tone={card.tone} label={card.kicker} />
          <Text style={[ui.styles.muted, { flexShrink: 1 }]} numberOfLines={1}>
            {name}
          </Text>
        </View>
        <Numbers card={card} now={now} />
      </View>
      <Text style={[ui.styles.strong, { fontSize: 15, lineHeight: 21 }]} selectable>
        {card.title}
      </Text>
      <Detail card={card} now={now} />
      <PhaseStrip strip={card.strip ?? []} status={card.status} />
      {card.strip && card.strip.length > 0 ? (
        <Text style={ui.styles.small} numberOfLines={2}>
          {card.strip.map((segment) => segment.title).join(" → ")}
        </Text>
      ) : null}
      <View style={[ui.styles.row, { gap: 8 }]}>
        {card.gate ? <Button icon="ShieldCheck" label="去审批" primary onPress={() => open(card.gate!.callId)} /> : null}
        <Button icon="Workflow" label="打开运行" primary={!card.gate} onPress={() => open(card.focus)} />
      </View>
      {failed && live ? (
        <Text style={ui.styles.small}>
          编排运行插件没有响应（{failed}），上面是 {formatTime(card.evaluatedAt, now)} 时的状态。
        </Text>
      ) : null}
    </View>
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
