import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { formatAgo, formatDuration, formatTime, formatUsd, RUN_STATUS_LABEL, shortId } from "../shared/format";
import type { LogDirInfo, RunSummary } from "../shared/rpc";
import { ms } from "../shared/run";
import { useNow, useRunList } from "./data";
import { LOG_DIR_SOURCE, RUN_LOOK } from "./looks";
import { Badge, Banner, Block, useUi } from "./ui";

const LAUNCH = "node <paseo-plugins>/orchestration/runtime/orch.mjs eval <script.mjs>";

export function RunList({ onOpen, onSettings }: { onOpen(runId: string): void; onSettings(): void }) {
  const ui = useUi();
  const { data, error } = useRunList();
  const live = data?.runs.some((run) => run.status === "running" || run.status === "starting") ?? false;
  const now = useNow(live);

  return (
    <ScrollView style={ui.styles.screen} contentContainerStyle={ui.styles.content}>
      <View style={{ gap: 4 }}>
        <Text style={ui.styles.title}>编排运行</Text>
        {data?.logDir ? <Where info={data.logDir} total={data.total} shown={data.runs.length} onSettings={onSettings} /> : null}
      </View>
      {error ? (
        <Banner tone="danger" icon="TriangleAlert" title="刷新失败，下面是上一次读到的列表">
          <Text style={ui.styles.muted} selectable>
            {error}
          </Text>
        </Banner>
      ) : null}
      {!data ? (
        error ? null : <Text style={ui.styles.muted}>正在读取运行记录……</Text>
      ) : data.state === "config" ? (
        <Banner tone="danger" icon="TriangleAlert" title="不知道运行记录在哪">
          <Text style={ui.styles.text} selectable>
            {data.detail}
          </Text>
          <Text style={ui.styles.muted}>修好这个文件，或者在插件设置里直接填 logDir。</Text>
        </Banner>
      ) : data.state === "unreadable" ? (
        <Banner tone="danger" icon="TriangleAlert" title="运行记录的目录读不了">
          <Text style={ui.styles.text} selectable>
            {data.detail}
          </Text>
        </Banner>
      ) : data.runs.length === 0 ? (
        <Empty info={data.logDir} missing={data.state === "missing"} />
      ) : (
        <View style={{ gap: 8 }}>
          {data.runs.map((run) => (
            <Row key={run.runId} run={run} now={now} onOpen={onOpen} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function Where({ info, total, shown, onSettings }: { info: LogDirInfo; total: number; shown: number; onSettings(): void }) {
  const ui = useUi();
  return (
    <View style={ui.styles.row}>
      <Text style={ui.styles.muted} selectable>
        {info.runsDir}
      </Text>
      <Text style={ui.styles.small}>
        （{LOG_DIR_SOURCE[info.source]}）· {total > shown ? `最近 ${shown} 次，共 ${total} 次` : `共 ${total} 次`}
      </Text>
      <Pressable accessibilityRole="button" onPress={onSettings}>
        <Text style={[ui.styles.small, { color: ui.theme.colors.accent }]}>改位置</Text>
      </Pressable>
    </View>
  );
}

function Empty({ info, missing }: { info: LogDirInfo | null; missing: boolean }) {
  const ui = useUi();
  return (
    <Banner tone="neutral" icon="Inbox" title="还没有运行记录">
      <Text style={ui.styles.text}>
        {missing
          ? `目录 ${info?.runsDir ?? "runs"} 还不存在：还没有哪次运行在这里写过事件，或者 logDir 指错了地方。`
          : `目录 ${info?.runsDir ?? "runs"} 是空的。`}
      </Text>
      <Text style={ui.styles.text}>
        编排运行时每跑一次 flow，就在这个目录写一个 {"<runId>.jsonl"}。在终端里，或者让一个 agent 跑一次，例如：
      </Text>
      <Block text={LAUNCH} />
      <Text style={ui.styles.muted}>
        只有按运行事件契约（orchestration/EVENTS.md）写事件的运行时才会出现在这里；logDir 下按天写的审计日志不是运行记录。
        flow 在另一台机器、或用另一个 logDir 跑的，要在插件设置里把位置指过去。
      </Text>
    </Banner>
  );
}

function Row({ run, now, onOpen }: { run: RunSummary; now: number; onOpen(runId: string): void }) {
  const ui = useUi();
  const look = RUN_LOOK[run.status];
  const started = ms(run.startedAt);
  const elapsed =
    run.durationMs ??
    (started === null
      ? null
      : run.status === "running"
        ? now - started
        : run.status === "lost"
          ? (ms(run.lastEventAt) ?? started) - started
          : null);
  const facts = [
    run.startedAt ? `开始 ${formatTime(run.startedAt, now)}` : null,
    elapsed === null ? null : `${run.status === "running" ? "已运行" : run.status === "lost" ? "失联前跑了" : "耗时"} ${formatDuration(elapsed)}`,
    run.costUsd === null ? null : `成本 ${formatUsd(run.costUsd)}${run.costNote ? "（不全）" : ""}`,
    run.flowName === null ? null : run.caller ? `发起方 agent ${shortId(run.caller)}` : "从终端发起",
    run.host ? `主机 ${run.host}` : null,
  ].filter((fact): fact is string => fact !== null);

  let why: string | null = null;
  if (run.status === "stopped" && run.stop) {
    why = `停在「${run.stop.phaseTitle ?? "阶段之外"}」：${run.stop.reason || "（没有说明原因）"}`;
  } else if ((run.status === "failed" || run.status === "timeout") && run.error) {
    why = `${run.error.name}：${run.error.message}`;
  } else if (run.status === "running" || run.status === "lost" || run.status === "starting") {
    why = run.activity;
  } else if (run.status === "unreadable") {
    why = run.problem;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开运行 ${run.flowName ?? run.runId}，${RUN_STATUS_LABEL[run.status]}`}
      onPress={() => onOpen(run.runId)}
      style={({ pressed }) => [ui.styles.card, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={ui.styles.row}>
        <Badge tone={look.tone} icon={look.icon} label={RUN_STATUS_LABEL[run.status]} />
        <Text style={ui.styles.strong}>{run.flowName ?? "（不是运行记录）"}</Text>
        <Text style={ui.styles.small}>{shortId(run.runId)}</Text>
        {run.status === "running" && run.lastEventAt ? (
          <Text style={ui.styles.small}>最新事件 {formatAgo(run.lastEventAt, now)}</Text>
        ) : null}
      </View>
      {run.description ? (
        <Text style={ui.styles.muted} numberOfLines={ui.compact ? 2 : 1}>
          {run.description}
        </Text>
      ) : null}
      {facts.length > 0 ? <Text style={ui.styles.small}>{facts.join(" · ")}</Text> : null}
      {why ? (
        <Text style={{ color: ui.tone(run.status === "running" ? "neutral" : look.tone), fontSize: 13 }} numberOfLines={3}>
          {why}
        </Text>
      ) : null}
    </Pressable>
  );
}
