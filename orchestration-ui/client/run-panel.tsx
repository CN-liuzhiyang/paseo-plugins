import { useAgent, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { RunSummary } from "../shared/rpc";
import { useRunList } from "./data";
import { defaultRun, type FocusStore } from "./focus";
import { RUN_LOOK } from "./looks";
import { RunDetail } from "./run-detail";
import { Banner, Button, UiProvider, useUi } from "./ui";

// The workspace's 流程 tab. A run started by an agent puts that agent and every agent it asks
// into the same workspace, so the run sits here as a tab beside them: to an agent and back is one
// tab switch each way. On top, the runs started from this workspace; below, the one picked --
// the same view as the sidebar screen.

const MAX_CHIPS = 8;

/** Reports whether one caller lives in this workspace; renders nothing. */
function Member({ caller, workspaceId, report }: { caller: string; workspaceId: string; report(caller: string, inside: boolean): void }) {
  const where = useAgent(caller, (agent) => agent.workspaceId);
  useEffect(() => report(caller, where === workspaceId), [caller, where, workspaceId, report]);
  return null;
}

function Chip({ run, active, onPress }: { run: RunSummary; active: boolean; onPress(): void }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const tone = run.hero?.tone ?? RUN_LOOK[run.status].tone;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${run.flowName ?? run.runId} ${run.inputLabel ?? ""}`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? c.foreground : c.border,
        backgroundColor: active ? c.surface2 : c.surface1,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ui.tone(tone) }} />
      <Text style={{ color: c.foreground, fontSize: 12, fontWeight: active ? "700" : "500" }} numberOfLines={1}>
        {[run.flowName ?? "（读不出来）", run.inputLabel].filter(Boolean).join(" · ")}
      </Text>
      {run.needsYou ? <Text style={{ color: ui.tone("warning"), fontSize: 12, fontWeight: "700" }}>需要你</Text> : null}
    </Pressable>
  );
}

function Panel({ workspaceId, focus, openAll }: { workspaceId: string; focus: FocusStore; openAll(): void }) {
  const ui = useUi();
  const { data, error } = useRunList();
  const current = useSyncExternalStore(
    focus.subscribe,
    () => focus.get(workspaceId),
    () => focus.get(workspaceId),
  );
  const [members, setMembers] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback((caller: string, inside: boolean) => {
    setMembers((before) => {
      if (before.has(caller) === inside) return before;
      const next = new Set(before);
      if (inside) next.add(caller);
      else next.delete(caller);
      return next;
    });
  }, []);
  const runs = data?.runs ?? [];
  const callers = [...new Set(runs.flatMap((run) => (run.caller ? [run.caller] : [])))];
  const mine = runs.filter((run) => (run.caller && members.has(run.caller)) || run.runId === current?.runId);
  const shown = current?.runId ?? defaultRun(mine)?.runId ?? null;
  const onPick = useCallback(
    (key: string) => {
      if (shown) focus.remember(workspaceId, shown, key);
    },
    [focus, workspaceId, shown],
  );

  const probes = callers.map((caller) => <Member key={caller} caller={caller} workspaceId={workspaceId} report={report} />);
  if (shown === null) {
    return (
      <ScrollView style={ui.styles.screen} contentContainerStyle={ui.styles.content}>
        {probes}
        {error ? <Banner tone="danger" icon="TriangleAlert" title="读不到流程列表"><Text style={ui.styles.text}>{error}</Text></Banner> : null}
        {data && data.state !== "ok" ? (
          <Banner tone="warning" icon="FolderX" title="不知道流程记录在哪"><Text style={ui.styles.text}>{data.detail}</Text></Banner>
        ) : null}
        {!data && !error ? <Text style={ui.styles.muted}>正在读取……</Text> : null}
        {data?.state === "ok" ? (
          <Banner tone="neutral" icon="Workflow" title="这个 workspace 里还没有流程">
            <Text style={ui.styles.text}>
              在这里的 agent 里跑 flow（orch.mjs run …），它就会出现在这个标签里，发起它的对话里也会有一张卡片。终端里跑的流程没有发起对话，只在全部流程里。
            </Text>
          </Banner>
        ) : null}
        <Button icon="List" label="打开全部流程" onPress={openAll} />
      </ScrollView>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: ui.theme.colors.surface0 }}>
      {probes}
      {mine.length > 1 ? (
        <ScrollView
          horizontal
          style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: ui.theme.colors.border }}
          contentContainerStyle={{ gap: 6, padding: 8 }}
        >
          {mine.slice(0, MAX_CHIPS).map((run) => (
            <Chip key={run.runId} run={run} active={run.runId === shown} onPress={() => focus.open(workspaceId, run.runId, null)} />
          ))}
          {mine.length > MAX_CHIPS ? <Button label={`其余 ${mine.length - MAX_CHIPS} 个 ›`} onPress={openAll} /> : null}
        </ScrollView>
      ) : null}
      <View style={{ flex: 1 }}>
        <RunDetail
          key={`${shown}:${current?.runId === shown ? current.nonce : 0}`}
          runId={shown}
          initialSelect={current?.runId === shown ? current.select : null}
          onBack={openAll}
          onPick={onPick}
        />
      </View>
    </View>
  );
}

export function makeRunsPanel({ focus, openAll }: { focus: FocusStore; openAll(): void }) {
  return function RunsPanel(props: PluginWorkspacePanelProps) {
    return (
      <UiProvider props={props}>
        <Panel workspaceId={props.workspaceId} focus={focus} openAll={openAll} />
      </UiProvider>
    );
  };
}
