import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { formatDuration, RUN_STATUS_LABEL } from "../shared/format";
import { buildGraph, headline, hero, inputLabel, type Hero } from "../shared/graph";
import { caveatsOf, hasUncountedCodex, ms, runStatus, type RunState, type RunStatus } from "../shared/run";
import { useNow, useRun, type RunSnapshot } from "./data";
import { Drawer, spendText } from "./drawer";
import { EventsView } from "./events-view";
import { GraphView } from "./graph-view";
import { HERO_ICON, RUN_LOOK } from "./looks";
import { TimelineView } from "./timeline-view";
import { Badge, Banner, OpenAgent, ProvideUi, useUi } from "./ui";

// One run in four layers. On top one sentence: what it is doing, how it ended, whether anything
// is yours to do, with the one button that does it. Under it a row of numbers. Then the run as a
// flow (or a timeline, or the raw events), and beside it whatever node is selected. Evidence --
// prompts, schemas, raw JSON, pids -- stays folded in that drawer.

type Tab = "graph" | "timeline" | "events";

const TABS: Array<[Tab, string]> = [
  ["graph", "流程图"],
  ["timeline", "时间线"],
  ["events", "事件"],
];

const DRAWER_WIDTH = 380;

export function RunDetail({ runId, onBack }: { runId: string; onBack(): void }) {
  const ui = useUi();
  const snap = useRun(runId);
  const run = snap.run;
  const now = useNow(snap.polling);
  const status = runStatus(run, now, snap.staleMs, snap.process);
  const [tab, setTab] = useState<Tab>("graph");
  const [picked, setPicked] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const top = run.start ? hero(run, status, now, { proc: snap.process, staleMs: snap.staleMs }) : null;
  // Nothing picked yet: the node the sentence is about, so the drawer answers it at once.
  const selected = picked ?? top?.select ?? "@start";
  // The run is folded in place; version is what says it changed.
  const graph = useMemo(() => buildGraph(run, status, now), [run, snap.version, status, now]);
  const select = useCallback(
    (key: string) => {
      setPicked(key);
      if (ui.compact) setDrawerOpen(true);
    },
    [ui.compact],
  );

  const ready = snap.loaded && (run.start !== null || run.eventCount > 0);
  const drawer = ready ? (
    <Drawer
      selected={selected}
      run={run}
      events={snap.events}
      graph={graph}
      status={status}
      now={now}
      proc={snap.process}
      staleMs={snap.staleMs}
      runId={runId}
      onSelect={select}
    />
  ) : null;

  const main = (
    <ScrollView style={ui.styles.screen} contentContainerStyle={ui.styles.content}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="返回运行列表"
        onPress={onBack}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" }}
      >
        <Icon name="ArrowLeft" size={16} color={ui.theme.colors.foregroundMuted} />
        <Text style={ui.styles.muted}>全部运行</Text>
      </Pressable>
      <Notices snap={snap} />
      {!snap.loaded ? <Text style={ui.styles.muted}>正在读取……</Text> : null}
      {ready ? (
        <>
          <Header run={run} runId={runId} status={status} />
          {top ? <HeroBar hero={top} status={status} remote={run.start?.host != null} /> : null}
          <Numbers run={run} status={status} graphClock={graph.clock} onSelect={select} />
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: ui.theme.colors.border }}>
              {TABS.map(([key, label]) => (
                <Pressable
                  key={key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: tab === key }}
                  onPress={() => setTab(key)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                    marginBottom: -1,
                    borderBottomWidth: 2,
                    borderBottomColor: tab === key ? ui.theme.colors.foreground : "transparent",
                  }}
                >
                  <Text
                    style={{
                      color: tab === key ? ui.theme.colors.foreground : ui.theme.colors.foregroundMuted,
                      fontSize: 13,
                      fontWeight: tab === key ? "700" : "500",
                    }}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {tab === "graph" ? (
              <GraphView graph={graph} run={run} status={status} selected={selected} follow={picked !== null || selected !== "@end"} onSelect={select} />
            ) : tab === "timeline" ? (
              <TimelineView graph={graph} run={run} status={status} selected={selected} onSelect={select} />
            ) : (
              <EventsView events={snap.events} run={run} now={now} onSelect={select} />
            )}
          </View>
          <Text style={ui.styles.small}>
            {!snap.polling ? "运行已结束，不再刷新。" : status === "lost" ? "每 5 秒看一次有没有新事件。" : "正在跟踪新事件，自动刷新。"}
          </Text>
        </>
      ) : snap.loaded && snap.state === "ok" ? (
        <Banner tone="neutral" icon="Hourglass" title="文件是空的">
          <Text style={ui.styles.text}>运行刚创建了文件，第一条事件还没写完。这里会自动刷新。</Text>
        </Banner>
      ) : null}
    </ScrollView>
  );

  if (ui.compact) {
    return (
      <>
        {main}
        <Modal title="详情" open={drawerOpen && drawer !== null} onOpenChange={setDrawerOpen}>
          <Modal.Content>
            <ProvideUi ui={ui}>{drawer}</ProvideUi>
          </Modal.Content>
        </Modal>
      </>
    );
  }
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: ui.theme.colors.surface0 }}>
      <View style={{ flex: 1, minWidth: 0 }}>{main}</View>
      {drawer ? (
        <View style={{ width: DRAWER_WIDTH, borderLeftWidth: 1, borderLeftColor: ui.theme.colors.border, backgroundColor: ui.theme.colors.surface1 }}>
          <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 48 }}>{drawer}</ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function Notices({ snap }: { snap: RunSnapshot }) {
  const ui = useUi();
  return (
    <>
      {snap.error ? (
        <Banner tone="danger" icon="TriangleAlert" title="刷新失败，下面是上一次读到的内容">
          <Text style={ui.styles.muted} selectable>
            {snap.error}
          </Text>
        </Banner>
      ) : null}
      {snap.loaded && snap.state !== null && snap.state !== "ok" ? (
        <Banner tone="danger" icon="TriangleAlert" title={snap.state === "missing" ? "找不到这次运行的文件" : "读不了这次运行"}>
          <Text style={ui.styles.text} selectable>
            {snap.detail}
          </Text>
        </Banner>
      ) : null}
    </>
  );
}

function Header({ run, runId, status }: { run: RunState; runId: string; status: RunStatus }) {
  const ui = useUi();
  const look = RUN_LOOK[status];
  const label = inputLabel(run.start);
  return (
    <View style={{ gap: 2 }}>
      <View style={[ui.styles.row, { gap: 10 }]}>
        <Text style={[ui.styles.title, { fontSize: ui.compact ? 19 : 22 }]} selectable>
          {run.start?.flow.name ?? runId}
        </Text>
        {label ? (
          <Text style={[ui.styles.muted, { fontSize: 15, flexShrink: 1 }]} numberOfLines={1}>
            {label}
          </Text>
        ) : null}
        <Badge tone={look.tone} icon={look.icon} label={RUN_STATUS_LABEL[status]} />
      </View>
      {run.start?.flow.description ? (
        <Text style={ui.styles.small} numberOfLines={2}>
          {run.start.flow.description}
        </Text>
      ) : null}
    </View>
  );
}

/** L0: the sentence. Tinted by what it means, with the one thing to do on the right. */
function HeroBar({ hero: top, status, remote }: { hero: Hero; status: RunStatus; remote: boolean }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const color = ui.tone(top.tone);
  const icon = top.needsYou && status !== "lost" ? "Hand" : HERO_ICON[status];
  const action = top.action ? <OpenAgent agentId={top.action.agentId} remote={remote} label={top.action.label} primary /> : null;
  return (
    <View
      style={{
        backgroundColor: ui.tint(top.tone, 0.12),
        borderWidth: 1,
        borderColor: ui.tint(top.tone, 0.35),
        borderRadius: 12,
        padding: ui.compact ? 12 : 16,
        flexDirection: ui.compact ? "column" : "row",
        gap: 14,
        alignItems: ui.compact ? "stretch" : "center",
      }}
      accessibilityRole="summary"
    >
      <View style={{ flexDirection: "row", gap: 12, flex: ui.compact ? undefined : 1, minWidth: 0 }}>
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            backgroundColor: color,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={icon} size={18} color={c.surface0} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ color, fontSize: 12, fontWeight: "700" }}>{top.kicker}</Text>
          <Text style={{ color: c.foreground, fontSize: ui.compact ? 16 : 18, fontWeight: "700", lineHeight: ui.compact ? 22 : 25 }} selectable>
            {top.title}
          </Text>
          {top.subtitle ? (
            <Text style={[ui.styles.muted, { marginTop: 2 }]} selectable>
              {top.subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {action}
    </View>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  const ui = useUi();
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
      <Text style={ui.styles.small}>{label}</Text>
      {typeof children === "string" ? <Text style={ui.styles.text}>{children}</Text> : children}
    </View>
  );
}

function Numbers({
  run,
  status,
  graphClock,
  onSelect,
}: {
  run: RunState;
  status: RunStatus;
  graphClock: number;
  onSelect(key: string): void;
}) {
  const ui = useUi();
  const started = ms(run.startedAt);
  const took = run.end?.durationMs ?? (started === null ? null : graphClock - started);
  // As run.end counts them: calls that had an agent (one agent may serve several rounds).
  const agents = run.end?.cost?.agentCount ?? [...run.calls.values()].filter((call) => call.agentId !== null).length;
  const gates = [...run.calls.values()].filter((call) => call.type === "gate");
  const caveats = caveatsOf(run);
  const codex = hasUncountedCodex(run) || [...run.calls.values()].some((call) => call.ask?.provider.startsWith("codex/") && !call.end);
  return (
    <View style={[ui.styles.row, { columnGap: 20, rowGap: 6 }]}>
      <Stat label={status === "running" ? "已运行" : status === "lost" ? "失联前跑了" : "用时"}>{formatDuration(took)}</Stat>
      <Stat label="花费">
        <Text style={ui.styles.text}>
          {spendText(run)}
          {codex ? <Text style={ui.styles.small}>  不含 Codex</Text> : null}
        </Text>
      </Stat>
      <Stat label="agent">{`${agents} 个`}</Stat>
      {gates.length > 0 ? <Stat label="人闸">{gates.map((gate) => headline(gate, status) ?? "没有结束记录").join("、")}</Stat> : null}
      {caveats.length > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => onSelect("@start")}>
          <Text style={{ color: ui.tone("warning"), fontSize: 13, textDecorationLine: "underline", textDecorationStyle: "dotted" }}>
            ⚠ {caveats.length} 条约束没被机械强制
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
