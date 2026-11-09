import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { markOf, rowSentence } from "../shared/bar";
import { RUN_STATUS_LABEL, shortId } from "../shared/format";
import { PAGE_SENTENCE_MAX, pageRuns, whenOf } from "../shared/page";
import type { LogDirInfo, RunSummary } from "../shared/rpc";
import { useNow, useRunList } from "./data";
import { FlowList } from "./flow-list";
import { Banner, Card, FoldHead, useUi } from "./ui";

// What ran lately, in the flow bar's four groups -- 等你, 在跑, 停了, 完成 -- one line each. What is old,
// or was carried on by a later run, is folded under 更早的; the flows themselves are folded under 全部流程.

export function RunList({
  host,
  onOpen,
  onOpenFlow,
  onSettings,
}: {
  host: string;
  onOpen(runId: string): void;
  onOpenFlow(name: string): void;
  onSettings(): void;
}) {
  const ui = useUi();
  const { data, error } = useRunList();
  const live = data?.runs.some((run) => run.status === "running" || run.status === "starting") ?? false;
  const now = useNow(live);
  const page = data ? pageRuns(data.runs, now) : null;
  // One machine is not worth a line; a run that came from another one is.
  const elsewhere = data?.runs.some((run) => run.host !== null) ?? false;

  return (
    <ScrollView style={ui.styles.screen} contentContainerStyle={ui.styles.content}>
      <View style={[ui.styles.row, { justifyContent: "space-between" }]}>
        <View style={{ gap: 2 }}>
          <Text style={ui.styles.title}>流程</Text>
          {elsewhere ? <Text style={ui.styles.small}>{host}</Text> : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="设置" onPress={onSettings} style={{ padding: 6 }}>
          <Icon name="Settings" size={18} color={ui.theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {error ? (
        <Banner tone="danger" icon="TriangleAlert" title="刷新失败，下面是上一次读到的">
          <Text style={ui.styles.muted} selectable>
            {error}
          </Text>
        </Banner>
      ) : null}
      {!data ? (
        error ? null : <Text style={ui.styles.muted}>正在读取……</Text>
      ) : data.state === "config" ? (
        <Banner tone="danger" icon="TriangleAlert" title="不知道流程记录在哪">
          <Text style={ui.styles.text} selectable>
            {data.detail}
          </Text>
          <Text style={ui.styles.muted}>修好这个文件，或者在设置里填 logDir。</Text>
        </Banner>
      ) : data.state === "unreadable" ? (
        <Banner tone="danger" icon="TriangleAlert" title="读不了流程记录的目录">
          <Text style={ui.styles.text} selectable>
            {data.detail}
          </Text>
        </Banner>
      ) : data.runs.length === 0 ? (
        <Empty info={data.logDir} missing={data.state === "missing"} />
      ) : (
        <>
          {page!.groups.length === 0 ? <Text style={ui.styles.muted}>这几天没有跑过流程</Text> : null}
          {page!.groups.map((group) => (
            <View key={group.group} style={{ gap: 6 }}>
              <Text style={[ui.styles.small, { fontWeight: "700", color: group.group === "waiting" ? ui.tone("warning") : undefined }]}>
                {group.title} · {group.runs.length}
              </Text>
              <Card>
                {group.runs.map((run, index) => (
                  <Row key={run.runId} run={run} now={now} last={index === group.runs.length - 1} onOpen={onOpen} />
                ))}
              </Card>
            </View>
          ))}
          <Older runs={page!.older} now={now} onOpen={onOpen} trimmed={data.total > data.runs.length ? data.total : null} />
        </>
      )}
      <FlowList now={now} onOpen={onOpenFlow} onSettings={onSettings} />
    </ScrollView>
  );
}

function Older({ runs, now, trimmed, onOpen }: { runs: RunSummary[]; now: number; trimmed: number | null; onOpen(runId: string): void }) {
  const [open, setOpen] = useState(false);
  if (runs.length === 0 && trimmed === null) return null;
  return (
    <View style={{ gap: 6 }}>
      <FoldHead label={`更早的 · ${runs.length}${trimmed === null ? "" : `（共 ${trimmed} 次，只列了最近的）`}`} open={open} onPress={() => setOpen(!open)} />
      {open ? (
        <Card>
          {runs.map((run, index) => (
            <Row key={run.runId} run={run} now={now} last={index === runs.length - 1} onOpen={onOpen} />
          ))}
        </Card>
      ) : null}
    </View>
  );
}

function Empty({ info, missing }: { info: LogDirInfo | null; missing: boolean }) {
  const ui = useUi();
  return (
    <Banner tone="neutral" icon="Inbox" title="还没跑过流程">
      <Text style={ui.styles.text}>
        {missing ? "还没有哪次流程在这里留下过记录；流程要是在别处跑的，到设置里指一下位置。" : "让 agent 或在终端里跑一次，这里就有了。"}
      </Text>
      {info ? <Text style={ui.styles.small}>{info.runsDir}</Text> : null}
    </Banner>
  );
}

function sentence(run: RunSummary, now: number): string {
  if (run.status === "unreadable") return run.problem ?? RUN_STATUS_LABEL.unreadable;
  return run.card ? rowSentence(run.card, now, PAGE_SENTENCE_MAX) : (run.hero?.title ?? RUN_STATUS_LABEL[run.status]);
}

/** The line: the flow and what tells this run from the others, then what it is doing or how it ended, then when. */
export function Row({ run, now, last, onOpen }: { run: RunSummary; now: number; last: boolean; onOpen(runId: string): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const tone = run.hero?.tone ?? (run.card ? markOf(run.card).tone : "danger");
  const when = whenOf(run.startedAt, now) ?? "—";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${run.flowName ?? run.runId}，${sentence(run, now)}`}
      onPress={() => onOpen(run.runId)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: c.border,
        backgroundColor: pressed ? c.surface2 : "transparent",
      })}
    >
      <View style={{ width: 10, height: 10, borderRadius: 5, marginTop: 5, backgroundColor: ui.tone(tone) }} />
      <View style={{ flex: 1, minWidth: 0, flexDirection: ui.compact ? "column" : "row", alignItems: ui.compact ? "stretch" : "baseline", gap: ui.compact ? 2 : 12 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexShrink: 1 }}>
          <Text style={[ui.styles.strong, { flexShrink: 0 }]} numberOfLines={1}>
            {run.flowName ?? "（不是流程记录）"}
          </Text>
          <Text style={[ui.styles.muted, { flexShrink: 1 }]} numberOfLines={1}>
            {run.affairLabel ?? run.inputLabel ?? shortId(run.runId)}
          </Text>
        </View>
        <Text
          style={{ flex: ui.compact ? undefined : 1, color: tone === "neutral" || tone === "success" ? c.foregroundMuted : ui.tone(tone), fontSize: 13 }}
          numberOfLines={1}
        >
          {sentence(run, now)}
        </Text>
      </View>
      <Text style={[ui.styles.small, { marginTop: 2 }]}>{when}</Text>
    </Pressable>
  );
}
