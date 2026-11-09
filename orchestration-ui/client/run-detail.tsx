import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { numbersLine, reusedLead } from "../shared/detail";
import { RUN_STATUS_LABEL } from "../shared/format";
import { buildGraph, hero, inputLabel, type Hero } from "../shared/graph";
import { wakeLine } from "../shared/wake";
import { costSoFar, runStatus, type RunState, type RunStatus } from "../shared/run";
import { useNow, useRun, type RunSnapshot } from "./data";
import { AffairLink } from "./affair";
import { Drawer } from "./drawer";
import { EventsView } from "./events-view";
import { GraphView } from "./graph-view";
import { HERO_ICON, RUN_LOOK } from "./looks";
import { ResizableDrawer } from "./resize";
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

export function RunDetail({
  runId,
  initialSelect = null,
  onBack,
  onPick,
  action,
}: {
  runId: string;
  initialSelect?: string | null;
  onBack(): void;
  /** Told whenever the person selects a node, so the place can be kept. */
  onPick?(key: string): void;
  /** Shown beside the back link: another place to open this run. */
  action?: ReactNode;
}) {
  const ui = useUi();
  const snap = useRun(runId);
  const run = snap.run;
  const now = useNow(snap.polling);
  const status = runStatus(run, now, snap.staleMs, snap.process);
  const [tab, setTab] = useState<Tab>("graph");
  const [picked, setPicked] = useState<string | null>(initialSelect);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The key (the legend of the picture) is behind a "?" and off until asked for.
  const [legend, setLegend] = useState(false);
  // The row the drawer sits in; the drawer never takes so much that the graph has no room.
  const [containerWidth, setContainerWidth] = useState(1200);
  const top = run.start ? hero(run, status, now, { proc: snap.process, staleMs: snap.staleMs }) : null;
  // Nothing picked yet: the node the sentence is about, so the drawer answers it at once.
  const selected = picked ?? top?.select ?? "@start";
  // The run is folded in place; version is what says it changed.
  const graph = useMemo(() => buildGraph(run, status, now), [run, snap.version, status, now]);
  const lead = useMemo(() => reusedLead(graph), [graph]);
  const select = useCallback(
    (key: string) => {
      setPicked(key);
      onPick?.(key);
      if (ui.compact) setDrawerOpen(true);
    },
    [ui.compact, onPick],
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
      <View style={[ui.styles.row, { justifyContent: "space-between" }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="返回流程"
          onPress={onBack}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" }}
        >
          <Icon name="ArrowLeft" size={16} color={ui.theme.colors.foregroundMuted} />
          <Text style={ui.styles.muted}>流程</Text>
        </Pressable>
        {action}
      </View>
      <Notices snap={snap} />
      {!snap.loaded ? <Text style={ui.styles.muted}>正在读取……</Text> : null}
      {ready ? (
        <>
          <Header run={run} runId={runId} status={status} needsYou={top?.needsYou ?? false} />
          {top ? <HeroBar hero={top} status={status} remote={run.start?.host != null} /> : null}
          <Text style={ui.styles.muted}>{numbersLine(run, status, graph.clock, costSoFar(run).usd)}</Text>
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: ui.theme.colors.border }}>
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
              {tab !== "events" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="图例"
                  accessibilityState={{ expanded: legend }}
                  onPress={() => setLegend(!legend)}
                  style={{ marginLeft: "auto", paddingHorizontal: 8, paddingVertical: 4 }}
                >
                  <Icon name="CircleHelp" size={16} color={legend ? ui.theme.colors.foreground : ui.theme.colors.foregroundMuted} />
                </Pressable>
              ) : null}
            </View>
            {tab === "graph" ? (
              <GraphView graph={graph} run={run} status={status} selected={selected} follow={picked !== null || selected !== "@end"} lead={lead} legend={legend} onSelect={select} />
            ) : tab === "timeline" ? (
              <TimelineView graph={graph} run={run} status={status} selected={selected} lead={lead} legend={legend} onSelect={select} />
            ) : (
              <EventsView events={snap.events} run={run} now={now} onSelect={select} />
            )}
          </View>
          {run.wake ? <Text style={ui.styles.small}>{wakeLine(run.wake)}</Text> : null}
        </>
      ) : snap.loaded && snap.state === "ok" ? (
        <Banner tone="neutral" icon="Hourglass" title="刚开始">
          <Text style={ui.styles.text}>第一条记录还没写完，这里会自动刷新。</Text>
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
    <View
      style={{ flex: 1, flexDirection: "row", backgroundColor: ui.theme.colors.surface0 }}
      onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}
    >
      <View style={{ flex: 1, minWidth: 0 }}>{main}</View>
      {drawer ? <ResizableDrawer containerWidth={containerWidth}>{drawer}</ResizableDrawer> : null}
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
        <Banner tone="danger" icon="TriangleAlert" title={snap.state === "missing" ? "找不到这次流程的文件" : "读不了这次流程"}>
          <Text style={ui.styles.text} selectable>
            {snap.detail}
          </Text>
        </Banner>
      ) : null}
    </>
  );
}

function Header({ run, runId, status, needsYou }: { run: RunState; runId: string; status: RunStatus; needsYou: boolean }) {
  const ui = useUi();
  const look = RUN_LOOK[status];
  const label = inputLabel(run.start);
  const waiting = needsYou && status === "running";
  return (
    <View style={[ui.styles.row, { gap: 10 }]}>
      <Text style={[ui.styles.title, { fontSize: ui.compact ? 19 : 22 }]} selectable>
        {run.start?.flow.name ?? runId}
      </Text>
      {run.start?.affair ? (
        <AffairLink affair={run.start.affair} />
      ) : label ? (
        <Text style={[ui.styles.muted, { fontSize: 15, flexShrink: 1 }]} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
      <Badge tone={waiting ? "warning" : look.tone} icon={look.icon} label={waiting ? "等你" : RUN_STATUS_LABEL[status]} />
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
