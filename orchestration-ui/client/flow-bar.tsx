import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { barAffair, barGroups, barRows, clip, groupOf, markOf, nameOf, nameParts, rowAction, rowSentence, stateWord, type BarGroup, type BarRun } from "../shared/bar";
import { cardOf } from "../shared/card";
import { formatBrief, formatUsd } from "../shared/format";
import { runStatus } from "../shared/run";
import { compactStages, stageRows, type StageRow, type Talk } from "../shared/stages";
import { stewardRow } from "../shared/wake";
import { affairTarget, openPluginScreenOf, type Affair } from "../shared/affair";
import { follow } from "./affair";
import { useNow, useRun } from "./data";
import type { FocusStore } from "./focus";
import { STAGE_LOOK } from "./looks";
import { Banner, Button, UiProvider, useUi } from "./ui";
import { useWorkspaceRuns } from "./workspace-runs";

// The flow bar: this workspace's runs, beside the conversation. What needs you first, what is
// running, what stopped; the ones that finished are folded away. A row is the flow's name and one
// short sentence, with at most one button. Pressing a row opens that run in the bar: its phases,
// and a button on each to the conversation it held. The whole picture is the 流程 tab, one press
// away from there.

const TICK_MS = 10_000;

export interface BarActions {
  /** The run's full picture, in the workspace's 流程 tab. */
  openFull(workspaceId: string, runId: string, select: string | null): void;
  /** The page listing every run. */
  openAll(): void;
}

function useAffairOpener(affair: Affair | null) {
  const ui = useUi();
  const openScreen = openPluginScreenOf(ui.navigation);
  if (!affair) return null;
  const target = affairTarget(affair, { hostId: ui.hostId, routes: ui.routes, hostOpensScreens: openScreen !== null });
  return target.kind === "none" ? null : () => follow(target, openScreen);
}

function Row({ item, now, onOpen }: { item: BarRun; now: number; onOpen(): void }) {
  const ui = useUi();
  const { card, run } = item;
  const openAffair = useAffairOpener(run.affairLabel === null ? null : { label: run.affairLabel, url: null, link: run.affairLink });
  const mark = markOf(card);
  const action = rowAction(card, openAffair !== null);
  const name = nameOf(card);
  const parts = nameParts(card);
  const openAgent = ui.navigation?.openAgent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}：${rowSentence(card, now)}`}
      onPress={onOpen}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 6,
        paddingHorizontal: 8,
        borderRadius: 8,
        backgroundColor: item.group === "waiting" ? ui.tint("warning", 0.1) : pressed ? ui.theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={mark.icon} size={14} color={ui.tone(mark.tone)} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={[ui.styles.strong, { fontSize: 13 }]} numberOfLines={1}>
          {parts.flow}
          {parts.label ? <Text style={{ color: ui.theme.colors.foregroundMuted, fontWeight: "400" }}>{` ${parts.label}`}</Text> : null}
        </Text>
        <Text style={[ui.styles.small, item.group === "waiting" ? { color: ui.tone("warning") } : null]} numberOfLines={2}>
          {rowSentence(card, now)}
        </Text>
      </View>
      {action?.kind === "approve" && openAgent && !card.remote ? (
        <Button small primary label="去批准" onPress={() => openAgent({ agentId: action.agentId })} />
      ) : null}
      {action?.kind === "affair" && openAffair ? <Button small label="事项页" onPress={openAffair} /> : null}
    </Pressable>
  );
}

function GroupHeading({ group, title, count, folded, onToggle }: { group: BarGroup; title: string; count: number; folded: boolean; onToggle?(): void }) {
  const ui = useUi();
  const color = group === "waiting" ? ui.tone("warning") : ui.theme.colors.foregroundMuted;
  const text = group === "done" ? `${title} · 近 24 小时 ${count}` : title;
  const inner = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8 }}>
      {onToggle ? <Icon name={folded ? "ChevronRight" : "ChevronDown"} size={13} color={color} /> : null}
      <Text style={{ color, fontSize: 12, fontWeight: "700" }}>{text}</Text>
    </View>
  );
  return onToggle ? (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: !folded }} accessibilityLabel={`${folded ? "展开" : "收起"}${text}`} onPress={onToggle}>
      {inner}
    </Pressable>
  ) : (
    inner
  );
}

function StageLine({ row, remote }: { row: StageRow; remote: boolean }) {
  const ui = useUi();
  const look = STAGE_LOOK[row.state];
  const openAgent = remote ? undefined : ui.navigation?.openAgent;
  const talk = (entry: Talk) =>
    openAgent ? <Button key={entry.callId} small primary={entry.waiting} label={entry.waiting ? "去批准" : "对话"} onPress={() => openAgent({ agentId: entry.agentId })} /> : null;
  const single = row.talks.length === 1 ? row.talks[0]! : null;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: ui.tone(look.tone), fontSize: 13, fontWeight: "700", width: 14, textAlign: "center" }}>{look.mark}</Text>
        <Text style={[ui.styles.text, { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18 }, row.state === "pending" || row.state === "skipped" ? { color: ui.theme.colors.foregroundMuted } : null]} numberOfLines={2}>
          {row.title}
          {row.note ? <Text style={{ color: row.state === "waiting" ? ui.tone("warning") : ui.theme.colors.foregroundMuted }}>{` · ${row.note}`}</Text> : null}
        </Text>
        {single ? talk(single) : null}
      </View>
      {row.talks.length > 1
        ? row.talks.map((entry) => (
            <View key={entry.callId} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 22 }}>
              <Text style={[ui.styles.small, { flex: 1, minWidth: 0 }]} numberOfLines={1}>
                {clip(entry.label ?? "", 24)}
              </Text>
              {talk(entry)}
            </View>
          ))
        : null}
    </View>
  );
}

function Opened({ runId, workspaceId, actions, onBack }: { runId: string; workspaceId: string; actions: BarActions; onBack(): void }) {
  const ui = useUi();
  const snap = useRun(runId);
  const now = useNow(snap.polling, 1_000);
  const run = snap.run;
  const status = runStatus(run, now, snap.staleMs, snap.process);
  const card = run.start ? cardOf(runId, run, status, now, { proc: snap.process }) : null;
  const openAffair = useAffairOpener(run.start?.affair ?? null);
  if (!snap.loaded || !card) {
    return (
      <View style={{ gap: 10 }}>
        <Back label="流程" onBack={onBack} />
        {snap.error ? <Text style={ui.styles.small}>读不到这次流程：{snap.error}</Text> : <Text style={ui.styles.muted}>正在读取……</Text>}
      </View>
    );
  }
  const mark = markOf(card);
  const name = [card.flow ?? "流程", card.label === null ? null : clip(card.label, 40)].filter(Boolean).join(" · ");
  const rows = compactStages(stageRows(run, status));
  const group = groupOf(card);
  const started = card.startedAt === null ? NaN : Date.parse(card.startedAt);
  const lastAt = Date.parse(card.endedAt ?? card.lastEventAt ?? "");
  const took = card.durationMs ?? (Number.isFinite(started) ? (card.status === "running" || card.status === "starting" ? now : lastAt) - started : null);
  const meta = [took === null || !Number.isFinite(took) ? null : formatBrief(took), card.costUsd === null ? null : formatUsd(card.costUsd)].filter(Boolean).join(" · ");
  const stopped = group === "stopped";
  const steward = stewardRow(run.wake);
  const openAgent = card.remote ? undefined : ui.navigation?.openAgent;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Back label={name} onBack={onBack} />
        </View>
        <Text style={{ color: ui.tone(mark.tone), fontSize: 12, fontWeight: "700" }}>{stateWord(card)}</Text>
      </View>
      {/* What is happening and what waits are in the rows below; only an ending needs a sentence. */}
      {stopped || group === "done" ? (
        <Text style={[ui.styles.text, { fontSize: 13, lineHeight: 19 }]} numberOfLines={5} selectable>
          {card.title}
        </Text>
      ) : null}
      {meta ? <Text style={ui.styles.small}>{meta}</Text> : null}
      <View style={{ gap: 8 }}>
        {rows.map((row) => (
          <StageLine key={row.key} row={row} remote={card.remote} />
        ))}
      </View>
      {steward ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={[ui.styles.small, { flex: 1, minWidth: 0 }]}>{steward.text}</Text>
          {openAgent ? <Button small label="对话" onPress={() => openAgent({ agentId: steward.agentId })} /> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button small label="看完整的图" onPress={() => actions.openFull(workspaceId, runId, card.focus)} />
        {stopped && openAffair ? <Button small label="事项页" onPress={openAffair} /> : null}
      </View>
    </View>
  );
}

function Back({ label, onBack }: { label: string; onBack(): void }) {
  const ui = useUi();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="回到流程列表" onPress={onBack} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name="ArrowLeft" size={15} color={ui.theme.colors.foregroundMuted} />
      <Text style={[ui.styles.strong, { flexShrink: 1, fontSize: 13 }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function Panel({ workspaceId, focus, actions }: { workspaceId: string; focus: FocusStore; actions: BarActions }) {
  const ui = useUi();
  const { data, error, mine, superseded, probes } = useWorkspaceRuns(workspaceId);
  const opened = useSyncExternalStore(
    focus.subscribe,
    () => focus.get(workspaceId)?.runId ?? null,
    () => focus.get(workspaceId)?.runId ?? null,
  );
  const [foldedDone, setFoldedDone] = useState(true);
  const now = useNow(true, TICK_MS);
  const rows = barRows(mine, superseded, now);
  const groups = barGroups(rows);
  const affair = barAffair(rows);
  const openAffair = useAffairOpener(affair ? { label: affair.label, url: null, link: affair.link } : null);
  const loading = data === null && error === null;
  return (
    <View style={{ flex: 1, backgroundColor: ui.theme.colors.surface0 }}>
      {probes}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 10, gap: 12, paddingBottom: 32 }}>
        {opened ? (
          <Opened key={opened} runId={opened} workspaceId={workspaceId} actions={actions} onBack={() => focus.clear(workspaceId)} />
        ) : (
          <>
            {affair ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 }}>
                <Text style={[ui.styles.small, { flex: 1, minWidth: 0 }]} numberOfLines={1}>
                  事项 {affair.label}
                </Text>
                {openAffair ? <Button small label="事项页" onPress={openAffair} /> : null}
              </View>
            ) : null}
            {error ? (
              <Banner tone="danger" icon="TriangleAlert" title="读不到流程列表">
                <Text style={ui.styles.small}>{error}</Text>
              </Banner>
            ) : null}
            {data && data.state !== "ok" ? (
              <Banner tone="warning" icon="FolderX" title="不知道流程记录在哪">
                <Text style={ui.styles.small}>{data.detail}</Text>
              </Banner>
            ) : null}
            {loading ? <Text style={ui.styles.muted}>正在读取……</Text> : null}
            {data?.state === "ok" && groups.length === 0 ? <Text style={[ui.styles.muted, { paddingHorizontal: 8 }]}>这里还没跑过流程</Text> : null}
            {groups.map((entry) => (
              <View key={entry.group} style={{ gap: 2 }}>
                <GroupHeading
                  group={entry.group}
                  title={entry.title}
                  count={entry.rows.length}
                  folded={entry.group === "done" && foldedDone}
                  onToggle={entry.group === "done" ? () => setFoldedDone((value) => !value) : undefined}
                />
                {entry.group === "done" && foldedDone
                  ? null
                  : entry.rows.map((item) => (
                      <Row key={item.run.runId} item={item} now={now} onOpen={() => focus.open(workspaceId, item.run.runId, null)} />
                    ))}
              </View>
            ))}
            <Pressable accessibilityRole="link" accessibilityLabel="全部流程" onPress={actions.openAll} style={{ paddingHorizontal: 8 }}>
              <Text style={[ui.styles.small, { color: ui.theme.colors.accent }]}>全部流程 ›</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </View>
  );
}

export function makeFlowBar({ focus, actions }: { focus: FocusStore; actions: BarActions }) {
  return function FlowBar(props: PluginWorkspacePanelProps) {
    return (
      <UiProvider props={props}>
        <Panel workspaceId={props.workspaceId} focus={focus} actions={actions} />
      </UiProvider>
    );
  };
}
