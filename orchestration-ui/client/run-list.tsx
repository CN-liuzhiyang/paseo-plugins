import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { formatTime, formatUsd, RUN_STATUS_LABEL, shortId } from "../shared/format";
import type { LogDirInfo, RunSummary } from "../shared/rpc";
import { useNow, useRunList } from "./data";
import { LOG_DIR_SOURCE, RUN_LOOK, VISIT_LOOK } from "./looks";
import { Banner, Block, useUi } from "./ui";

// Every run, sorted by whether it needs you: a gate waiting or a run gone quiet first, then what
// is running, then what ended. A row is the flow, the input that tells it apart, how far each
// phase got, and the same sentence the detail view opens with.

const LAUNCH = "node <paseo-plugins>/orchestration/runtime/orch.mjs run <flow.mjs> --<输入> ...";

type Group = { key: string; title: string; runs: RunSummary[] };

function grouped(runs: RunSummary[]): Group[] {
  const needs: RunSummary[] = [];
  const live: RunSummary[] = [];
  const ended: RunSummary[] = [];
  for (const run of runs) {
    if (run.needsYou) needs.push(run);
    else if (run.status === "running" || run.status === "starting") live.push(run);
    else ended.push(run);
  }
  return [
    { key: "needs", title: "需要你处理", runs: needs },
    { key: "live", title: "运行中", runs: live },
    { key: "ended", title: "最近结束", runs: ended },
  ].filter((group) => group.runs.length > 0);
}

export function RunList({ host, onOpen, onSettings }: { host: string; onOpen(runId: string): void; onSettings(): void }) {
  const ui = useUi();
  const { data, error } = useRunList();
  const live = data?.runs.some((run) => run.status === "running" || run.status === "starting") ?? false;
  const now = useNow(live);

  return (
    <ScrollView style={ui.styles.screen} contentContainerStyle={ui.styles.content}>
      <View style={{ gap: 4 }}>
        <Text style={ui.styles.title}>编排运行</Text>
        {data?.logDir ? <Where host={host} info={data.logDir} total={data.total} shown={data.runs.length} onSettings={onSettings} /> : null}
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
        <View
          style={{
            borderWidth: 1,
            borderColor: ui.theme.colors.border,
            borderRadius: 12,
            overflow: "hidden",
            backgroundColor: ui.theme.colors.surface1,
          }}
        >
          {grouped(data.runs).map((group) => (
            <View key={group.key}>
              <View
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  backgroundColor: group.key === "needs" ? ui.tint("warning", 0.12) : ui.theme.colors.surface2,
                  borderBottomWidth: 1,
                  borderBottomColor: ui.theme.colors.border,
                }}
              >
                <Text style={[ui.styles.small, { fontWeight: "700", color: group.key === "needs" ? ui.tone("warning") : undefined }]}>
                  {group.title} · {group.runs.length}
                </Text>
              </View>
              {group.runs.map((run) => (
                <Row key={run.runId} run={run} now={now} onOpen={onOpen} />
              ))}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// The runs are files on one daemon's disk; with several hosts connected, the host is what tells
// you whose runs these are.
function Where({ host, info, total, shown, onSettings }: { host: string; info: LogDirInfo; total: number; shown: number; onSettings(): void }) {
  const ui = useUi();
  return (
    <View style={ui.styles.row}>
      <Text style={[ui.styles.small, { fontWeight: "700" }]}>{host}</Text>
      <Text style={ui.styles.small} selectable>
        · {info.runsDir}
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

function Strip({ run }: { run: RunSummary }) {
  const ui = useUi();
  const c = ui.theme.colors;
  if (!run.strip || run.strip.length === 0) {
    const look = RUN_LOOK[run.status];
    return (
      <View style={{ flexDirection: "row", gap: 3 }}>
        <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: run.strip ? ui.tone(look.tone) : c.border }} />
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", gap: 3 }} accessibilityLabel={run.strip.map((s) => `${s.title}：${VISIT_LOOK[s.state].label}`).join("，")}>
      {run.strip.map((segment, index) => {
        const look = VISIT_LOOK[segment.state];
        const empty = segment.state === "pending" || segment.state === "skipped";
        // Hosts may give "running" and "done" near-identical colors; a running segment is half-filled.
        const running = segment.state === "running";
        return (
          <View
            key={index}
            style={{
              flex: 1,
              height: 6,
              borderRadius: 3,
              backgroundColor: empty ? "transparent" : running ? ui.tint(look.tone, 0.35) : ui.tone(look.tone),
              borderWidth: empty || running ? 1 : 0,
              borderStyle: segment.state === "skipped" ? "dashed" : "solid",
              borderColor: running ? ui.tone(look.tone) : c.border,
            }}
          />
        );
      })}
    </View>
  );
}

function sentence(run: RunSummary): string | null {
  if (run.status === "unreadable") return run.problem;
  return run.hero?.title ?? run.activity;
}

function Row({ run, now, onOpen }: { run: RunSummary; now: number; onOpen(runId: string): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const look = RUN_LOOK[run.status];
  const tone = run.hero?.tone ?? look.tone;
  // A note means the figure leaves something out (Codex, calls still open): it is a lower bound.
  const cost = run.costUsd === null ? "—" : `${run.costNote ? "至少 " : ""}${formatUsd(run.costUsd)}`;
  const when = run.startedAt ? formatTime(run.startedAt, now) : "—";
  const label = (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexShrink: 1 }}>
      <Text style={[ui.styles.strong, { flexShrink: 0 }]} numberOfLines={1}>
        {run.flowName ?? "（不是运行记录）"}
      </Text>
      <Text style={[ui.styles.muted, { flexShrink: 1 }]} numberOfLines={1}>
        {run.inputLabel ?? shortId(run.runId)}
      </Text>
    </View>
  );
  const said = (
    <Text style={{ color: tone === "neutral" || tone === "success" ? c.foregroundMuted : ui.tone(tone), fontSize: 13 }} numberOfLines={2}>
      {sentence(run) ?? RUN_STATUS_LABEL[run.status]}
    </Text>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开运行 ${run.flowName ?? run.runId}，${RUN_STATUS_LABEL[run.status]}`}
      onPress={() => onOpen(run.runId)}
      style={({ pressed }) => ({
        flexDirection: ui.compact ? "column" : "row",
        alignItems: ui.compact ? "stretch" : "center",
        gap: ui.compact ? 6 : 14,
        paddingHorizontal: 14,
        paddingVertical: 11,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
        backgroundColor: pressed ? c.surface2 : "transparent",
      })}
    >
      <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", flex: 1, minWidth: 0 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, marginTop: 5, backgroundColor: ui.tone(tone) }} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {label}
          {said}
        </View>
      </View>
      <View style={{ width: ui.compact ? undefined : 180, paddingLeft: ui.compact ? 20 : 0 }}>
        <Strip run={run} />
      </View>
      <View style={{ flexDirection: "row", gap: 14, paddingLeft: ui.compact ? 20 : 0, justifyContent: ui.compact ? "flex-start" : "flex-end" }}>
        <Text style={[ui.styles.small, { width: ui.compact ? undefined : 64, textAlign: ui.compact ? "left" : "right" }]}>{cost}</Text>
        <Text style={[ui.styles.small, { width: ui.compact ? undefined : 92, textAlign: ui.compact ? "left" : "right" }]}>
          {when}
        </Text>
      </View>
    </Pressable>
  );
}
