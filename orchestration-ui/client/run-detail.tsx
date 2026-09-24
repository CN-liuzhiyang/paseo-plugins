import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type ScrollView as NativeScrollView } from "react-native";
import {
  activity,
  formatDuration,
  formatTime,
  formatUsd,
  PHASE_STATUS_LABEL,
  RUN_STATUS_LABEL,
} from "../shared/format";
import {
  caveatsOf,
  costSoFar,
  hasUncountedCodex,
  ms,
  phaseStatus,
  phaseTitle,
  runStatus,
  type CallState,
  type PhaseState,
  type PhaseStatus,
  type ProcessCheck,
  type RunState,
  type RunStatus,
} from "../shared/run";
import { CallCard } from "./call-card";
import { useNow, useRun } from "./data";
import { PHASE_LOOK, RUN_LOOK } from "./looks";
import { Value } from "./value";
import { AgentRef, Badge, Banner, CopyButton, Fact, Fold, Section, useUi } from "./ui";

// One run, organized the way the flow declared it: every phase in order, entered or not, and
// under each the calls it made. The top says how it ended (or what it is doing) in one line.

/** Grants that let a run act for a person or destroy something; worth a second look. */
const WIDE_GRANTS = new Set(["archive", "gate:allow", "gate:deny"]);
/** Past this many calls, finished phases start folded. */
const FOLD_AFTER_CALLS = 12;

/** Where each phase block sits in the scroll content, for the progress strip to jump to. */
interface Anchors {
  section: number;
  phases: Map<string, number>;
}

export function RunDetail({ runId, onBack }: { runId: string; onBack(): void }) {
  const ui = useUi();
  const snap = useRun(runId);
  const run = snap.run;
  const now = useNow(snap.polling);
  const status = runStatus(run, now, snap.staleMs, snap.process);
  const remote = run.start?.host != null;
  const scroll = useRef<NativeScrollView>(null);
  const anchors = useRef<Anchors>({ section: 0, phases: new Map() });
  const [jump, setJump] = useState<{ id: string; n: number } | null>(null);
  const jumpTo = useCallback((id: string) => {
    setJump((current) => ({ id, n: (current?.n ?? 0) + 1 }));
    const y = anchors.current.phases.get(id);
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, anchors.current.section + y - 8), animated: true });
  }, []);

  return (
    <ScrollView ref={scroll} style={ui.styles.screen} contentContainerStyle={ui.styles.content}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="返回运行列表"
        onPress={onBack}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" }}
      >
        <Icon name="ArrowLeft" size={16} color={ui.theme.colors.foregroundMuted} />
        <Text style={ui.styles.muted}>全部运行</Text>
      </Pressable>

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
      {!snap.loaded ? <Text style={ui.styles.muted}>正在读取……</Text> : null}

      {snap.loaded && (run.start || run.eventCount > 0) ? (
        <>
          <Header run={run} runId={runId} status={status} polling={snap.polling} />
          <Outcome run={run} status={status} now={now} proc={snap.process} staleMs={snap.staleMs} />
          <PhaseStrip run={run} status={status} onJump={jumpTo} />
          <Facts run={run} status={status} now={now} runId={runId} proc={snap.process} />
          <Caveats run={run} />
          {run.start ? (
            <Section title="输入">
              <View style={ui.styles.card}>
                <Value value={run.start.input} schema={run.start.flow.inputs} />
              </View>
            </Section>
          ) : null}
          {run.end && run.end.value != null ? (
            <Section title={run.end.outcome === "stopped" ? "停下时给出的结果" : "结果"}>
              <View style={ui.styles.card}>
                <Value value={run.end.value} />
              </View>
            </Section>
          ) : null}
          <Phases run={run} status={status} now={now} remote={remote} anchors={anchors.current} jump={jump} />
          <Logs run={run} now={now} />
          <Problems run={run} />
        </>
      ) : snap.loaded && snap.state === "ok" ? (
        <Banner tone="neutral" icon="Hourglass" title="文件是空的">
          <Text style={ui.styles.text}>运行刚创建了文件，第一条事件还没写完。这里会自动刷新。</Text>
        </Banner>
      ) : null}
    </ScrollView>
  );
}

function Header({ run, runId, status, polling }: { run: RunState; runId: string; status: RunStatus; polling: boolean }) {
  const ui = useUi();
  const look = RUN_LOOK[status];
  return (
    <View style={{ gap: 6 }}>
      <View style={ui.styles.row}>
        <Text style={ui.styles.title} selectable>
          {run.start?.flow.name ?? runId}
        </Text>
        <Badge tone={look.tone} icon={look.icon} label={RUN_STATUS_LABEL[status]} solid />
      </View>
      {run.start?.flow.description ? (
        <Text style={ui.styles.muted} selectable>
          {run.start.flow.description}
        </Text>
      ) : null}
      <Text style={ui.styles.small}>
        {!polling ? "运行已结束，不再刷新" : status === "lost" ? "每 5 秒看一次有没有新事件" : "正在跟踪新事件，自动刷新"}
      </Text>
    </View>
  );
}

function Outcome({
  run,
  status,
  now,
  proc,
  staleMs,
}: {
  run: RunState;
  status: RunStatus;
  now: number;
  proc: ProcessCheck | null;
  staleMs: number;
}) {
  const ui = useUi();
  const end = run.end;
  const doing = activity(run, status, now, { proc, staleMs });
  // Where a failed or timed-out run was when it died.
  const where = run.phaseOrder
    .map((id) => run.phases.get(id)!)
    .filter((phase) => ["failed", "interrupted"].includes(phaseStatus(run, phase, status)))
    .map((phase) => `「${phase.title}」`);
  switch (status) {
    case "done":
      return (
        <Banner tone="success" icon="CircleCheck" title={`完成，用时 ${formatDuration(end?.durationMs ?? null)}`} />
      );
    case "stopped": {
      const title = end?.stop?.phase ? `在「${phaseTitle(run, end.stop.phase)}」停下` : "在阶段之外停下";
      return (
        <Banner tone="warning" icon="CircleStop" title={title}>
          <Text style={ui.styles.text} selectable>
            {end?.stop?.reason || "flow 没有说明为什么停下。"}
          </Text>
          <Text style={ui.styles.small}>停下是 flow 主动的决定（$.stop），不是出错。之后的阶段没有进入。</Text>
        </Banner>
      );
    }
    case "failed":
    case "timeout":
      return (
        <Banner
          tone="danger"
          icon={status === "timeout" ? "TimerOff" : "CircleX"}
          title={status === "timeout" ? "超出了运行的总时限" : `失败${end?.error ? `：${end.error.name}` : ""}`}
        >
          {end?.error ? (
            <Text style={ui.styles.text} selectable>
              {end.error.message}
            </Text>
          ) : null}
          {where.length > 0 ? <Text style={ui.styles.small}>出事时在阶段{where.join("、")}。</Text> : null}
        </Banner>
      );
    case "running":
      return (
        <Banner tone="accent" icon="Loader" title="运行中">
          <Text style={ui.styles.text}>{doing}</Text>
        </Banner>
      );
    case "lost":
      return proc && !proc.alive ? (
        <Banner tone="warning" icon="Unplug" title="失联：运行进程已经不在了">
          <Text style={ui.styles.text}>{doing}</Text>
          <Text style={ui.styles.small}>
            daemon 在本机查过 pid {proc.pid}，进程不存在：它崩溃了或被结束了，不会再写 run.end。
          </Text>
        </Banner>
      ) : (
        <Banner tone="warning" icon="Unplug" title="失联：不知道它还在不在跑">
          <Text style={ui.styles.text}>{doing}</Text>
          <Text style={ui.styles.small}>
            {run.start?.pid == null
              ? "这个文件没有记下运行进程的 pid，只能按安静了多久来猜。"
              : "运行在另一台主机上，这里查不了它的进程，只能按安静了多久来猜。"}
            运行进程可能已经退出（崩溃、被结束、机器休眠）。如果它只是在等一个很久的调用，一有新事件这里就会自动变回「运行中」。
          </Text>
        </Banner>
      );
    case "starting":
      return (
        <Banner tone="neutral" icon="Hourglass" title="启动中">
          <Text style={ui.styles.text}>{doing}</Text>
        </Banner>
      );
  }
}

function Facts({
  run,
  status,
  now,
  runId,
  proc,
}: {
  run: RunState;
  status: RunStatus;
  now: number;
  runId: string;
  proc: ProcessCheck | null;
}) {
  const ui = useUi();
  const start = run.start;
  const started = ms(run.startedAt);
  const duration =
    run.end?.durationMs ??
    (started === null ? null : status === "running" ? now - started : (ms(run.lastEventAt) ?? started) - started);
  const cost = run.end?.cost;
  const soFar = costSoFar(run);
  const codex = hasUncountedCodex(run);
  return (
    <View style={ui.styles.card}>
      <Fact label="开始">{formatTime(run.startedAt, now)}</Fact>
      <Fact label={status === "running" ? "已运行" : status === "lost" ? "失联前跑了" : "耗时"}>{formatDuration(duration)}</Fact>
      <Fact label="成本">
        <View style={{ gap: 2 }}>
          <Text style={ui.styles.text}>
            {run.end
              ? cost
                ? `${formatUsd(cost.totalUsd)}${cost.agentCount != null ? `（${cost.agentCount} 个 agent）` : ""}`
                : "运行没有报告成本"
              : `${formatUsd(soFar.usd)}（已结束调用的合计，运行结束才有总数）`}
          </Text>
          {cost?.partial ? <Text style={ui.styles.small}>{cost.partial}</Text> : null}
          {codex && !cost?.partial?.includes("Codex") ? (
            <Text style={ui.styles.small}>Codex agent 的成本读出来是 0，没有计入。</Text>
          ) : null}
          {!run.end && soFar.uncounted > 0 ? <Text style={ui.styles.small}>{soFar.uncounted} 个调用的成本未计入。</Text> : null}
        </View>
      </Fact>
      <Fact label="发起方">
        {start?.caller ? <AgentRef agentId={start.caller} remote={false} /> : <Text style={ui.styles.text}>终端（没有发起方 agent）</Text>}
      </Fact>
      <Fact label="主机">{start?.host ?? "本机"}</Fact>
      {start ? <Fact label="运行进程">{processText(run, proc)}</Fact> : null}
      {start ? (
        <Fact label="权限">
          {start.flow.grants.length === 0 ? (
            <Text style={ui.styles.text}>没有声明</Text>
          ) : (
            <View style={ui.styles.row}>
              {start.flow.grants.map((grant) => (
                <Badge key={grant} tone={WIDE_GRANTS.has(grant) ? "warning" : "neutral"} label={grant} />
              ))}
            </View>
          )}
        </Fact>
      ) : null}
      {start?.cwd ? <Fact label="工作目录">{start.cwd}</Fact> : null}
      {start?.source ? <Fact label="flow 文件">{start.source}</Fact> : null}
      <Fact label="运行 id">
        <View style={ui.styles.row}>
          <Text style={ui.styles.mono} selectable>
            {run.runId ?? runId}
          </Text>
          <CopyButton text={run.runId ?? runId} />
        </View>
      </Fact>
    </View>
  );
}

function processText(run: RunState, proc: ProcessCheck | null): string {
  const start = run.start!;
  if (start.pid === null) return "没有记录（写这个文件的运行时版本还不记 pid）";
  const where = `pid ${start.pid}${start.hostname ? ` · ${start.hostname}` : ""}`;
  if (run.end) return where;
  if (proc) return `${where} · ${proc.alive ? "还在" : "已退出"}`;
  return `${where} · 不在这台主机上，查不了`;
}

/** Every declared phase in one line, so "where is it now" needs no scrolling. */
function PhaseStrip({ run, status, onJump }: { run: RunState; status: RunStatus; onJump(id: string): void }) {
  const ui = useUi();
  const phases = run.phaseOrder.map((id) => run.phases.get(id)!);
  if (phases.length === 0) return null;
  return (
    <View style={[ui.styles.row, { gap: 4 }]} accessibilityRole="list" accessibilityLabel="阶段进度">
      {phases.map((phase, index) => {
        const state: PhaseStatus = phaseStatus(run, phase, status);
        const look = PHASE_LOOK[state];
        const color = ui.tone(look.tone);
        const active = state === "running" || state === "stopped" || state === "failed" || state === "interrupted";
        return (
          <View key={phase.id} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {index > 0 ? <Icon name="ChevronRight" size={12} color={ui.theme.colors.foregroundMuted} /> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`跳到阶段 ${phase.title}，${PHASE_STATUS_LABEL[state]}`}
              onPress={() => onJump(phase.id)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: active || state === "done" ? color : ui.theme.colors.border,
                borderStyle: state === "skipped" || state === "pending" ? "dashed" : "solid",
                backgroundColor: active ? ui.theme.colors.surface2 : ui.theme.colors.surface1,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Icon name={look.icon} size={14} color={color} />
              <Text style={{ color: ui.theme.colors.foreground, fontSize: 13, fontWeight: active ? "700" : "500" }}>
                {phase.title}
              </Text>
              <Text style={{ color, fontSize: 12 }}>{PHASE_STATUS_LABEL[state]}</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function Caveats({ run }: { run: RunState }) {
  const ui = useUi();
  const caveats = caveatsOf(run);
  if (caveats.length === 0) return null;
  return (
    <Section title={`没有被机械强制的约束（${caveats.length}）`}>
      <View style={[ui.styles.card, { borderLeftWidth: 3, borderLeftColor: ui.tone("warning") }]}>
        <Text style={ui.styles.small}>这些约束只写在 prompt 里、或靠 agent 自觉，运行时没法保证。</Text>
        {caveats.map((text) => (
          <Text key={text} style={ui.styles.text} selectable>
            ⚠ {text}
          </Text>
        ))}
      </View>
    </Section>
  );
}

function Phases({
  run,
  status,
  now,
  remote,
  anchors,
  jump,
}: {
  run: RunState;
  status: RunStatus;
  now: number;
  remote: boolean;
  anchors: Anchors;
  jump: { id: string; n: number } | null;
}) {
  const ui = useUi();
  const phases = run.phaseOrder.map((id) => run.phases.get(id)!);
  const unphased = run.callOrder.map((id) => run.calls.get(id)!).filter((call) => call.phase === null);
  const finished = phases.filter((phase) => phaseStatus(run, phase, status) === "done").length;
  const many = run.calls.size > FOLD_AFTER_CALLS;
  // Calls outside every phase sit where they happened: before the phases if the run began with them.
  const firstPhase = Math.min(...phases.map((phase) => ms(phase.firstStartAt) ?? Infinity));
  const outsideFirst = unphased.length > 0 && (ms(unphased[0]!.startedAt) ?? Infinity) < firstPhase;
  const outside =
    unphased.length > 0 ? (
      <Section title="阶段之外的调用">
        <View style={{ gap: 8 }}>
          {unphased.map((call) => (
            <CallCard key={call.callId} call={call} status={status} now={now} remote={remote} />
          ))}
        </View>
      </Section>
    ) : null;
  return (
    <>
      {outsideFirst ? outside : null}
      <View onLayout={(event) => (anchors.section = event.nativeEvent.layout.y)}>
      <Section
        title="阶段"
        trailing={phases.length > 0 ? <Text style={ui.styles.small}>{`${finished} / ${phases.length} 完成`}</Text> : undefined}
      >
        {phases.length === 0 ? <Text style={ui.styles.muted}>这个 flow 没有声明阶段。</Text> : null}
        {phases.map((phase, index) => (
          <PhaseBlock
            key={phase.id}
            run={run}
            phase={phase}
            index={index}
            status={status}
            now={now}
            remote={remote}
            foldDone={many}
            onLayout={(y) => anchors.phases.set(phase.id, y)}
            jump={jump}
          />
        ))}
      </Section>
      </View>
      {outsideFirst ? null : outside}
    </>
  );
}

function PhaseBlock({
  run,
  phase,
  index,
  status,
  now,
  remote,
  foldDone,
  onLayout,
  jump,
}: {
  run: RunState;
  phase: PhaseState;
  index: number;
  status: RunStatus;
  now: number;
  remote: boolean;
  foldDone: boolean;
  onLayout(y: number): void;
  jump: { id: string; n: number } | null;
}) {
  const ui = useUi();
  const state = phaseStatus(run, phase, status);
  const look = PHASE_LOOK[state];
  const [open, setOpen] = useState(() => !(foldDone && state === "done"));
  // Jumping here from the progress strip unfolds it.
  useEffect(() => {
    if (jump?.id === phase.id) setOpen(true);
  }, [jump, phase.id]);
  const calls = phase.callIds.map((id) => run.calls.get(id)!);
  const first = ms(phase.firstStartAt);
  const last = state === "running" ? now : ms(phase.lastEndAt);
  const meta = [
    phase.starts > 1 ? `进入 ${phase.starts} 次` : null,
    first !== null && last !== null ? formatDuration(last - first) : null,
    calls.length > 0 ? `${calls.length} 个调用` : null,
    phase.id !== phase.title ? phase.id : null,
  ].filter(Boolean);
  const rounds = groupByRound(calls);

  return (
    <View style={{ flexDirection: "row", gap: 10 }} onLayout={(event) => onLayout(event.nativeEvent.layout.y)}>
      <View style={{ alignItems: "center", width: 22 }}>
        <Icon name={look.icon} size={20} color={ui.tone(look.tone)} />
        <View style={{ flex: 1, width: 2, backgroundColor: ui.theme.colors.border, marginTop: 4 }} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 8, paddingBottom: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`阶段 ${phase.title}，${PHASE_STATUS_LABEL[state]}`}
          onPress={() => setOpen((value) => !value)}
          style={{ gap: 2 }}
        >
          <View style={ui.styles.row}>
            <Text style={ui.styles.strong}>
              {index + 1}. {phase.title}
            </Text>
            <Badge tone={look.tone} label={PHASE_STATUS_LABEL[state]} />
            {!phase.declared ? <Badge tone="warning" label="flow 没声明这个阶段" /> : null}
            {calls.length > 0 ? (
              <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={ui.theme.colors.foregroundMuted} />
            ) : null}
          </View>
          {meta.length > 0 ? <Text style={ui.styles.small}>{meta.join(" · ")}</Text> : null}
        </Pressable>
        {calls.length === 0 ? (
          <Text style={ui.styles.muted}>
            {state === "pending"
              ? "还没开始"
              : state === "skipped"
                ? "这次运行没有进入这个阶段"
                : state === "stopped"
                  ? "在这里停下，没有调用"
                  : "没有调用（阶段里只跑了脚本自己的代码）"}
          </Text>
        ) : open ? (
          rounds.map(([round, group]) => (
            <View key={round} style={{ gap: 8 }}>
              {rounds.length > 1 ? <Text style={ui.styles.small}>第 {round} 轮</Text> : null}
              {group.map((call) => (
                <CallCard key={call.callId} call={call} status={status} now={now} remote={remote} />
              ))}
            </View>
          ))
        ) : null}
      </View>
    </View>
  );
}

function groupByRound(calls: CallState[]): Array<[number, CallState[]]> {
  const groups = new Map<number, CallState[]>();
  for (const call of calls) {
    const group = groups.get(call.round) ?? [];
    group.push(call);
    groups.set(call.round, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b);
}

function Logs({ run, now }: { run: RunState; now: number }) {
  const ui = useUi();
  if (run.logs.length === 0) return null;
  const warns = run.logs.filter((log) => log.level === "warn").length;
  const errors = run.logs.filter((log) => log.level === "error").length;
  const counts = [warns ? `${warns} 条警告` : null, errors ? `${errors} 条错误` : null].filter(Boolean).join("，");
  return (
    <Fold label={`日志 ${run.logs.length} 条`} hint={counts || undefined} initiallyOpen={errors > 0}>
      <View style={[ui.styles.card, { gap: 4 }]}>
        {run.logs.map((log, index) => (
          <View key={index} style={{ flexDirection: "row", gap: 8 }}>
            <Text style={ui.styles.small}>{formatTime(log.at, now)}</Text>
            <Text
              style={{
                color: log.level === "error" ? ui.tone("danger") : log.level === "warn" ? ui.tone("warning") : ui.theme.colors.foreground,
                fontSize: 13,
                flex: 1,
              }}
              selectable
            >
              {log.message}
            </Text>
          </View>
        ))}
      </View>
    </Fold>
  );
}

function Problems({ run }: { run: RunState }) {
  const ui = useUi();
  const unknown = Object.entries(run.unknownKinds);
  if (run.problems.length === 0 && unknown.length === 0) return null;
  return (
    <Fold
      label="读取时的问题"
      hint={[
        run.problems.length ? `${run.problems.length} 处不合契约` : null,
        unknown.length ? `${unknown.length} 种不认识的事件（已忽略）` : null,
      ]
        .filter(Boolean)
        .join("，")}
    >
      <View style={[ui.styles.card, { gap: 4 }]}>
        {run.problems.map((text, index) => (
          <Text key={index} style={{ color: ui.tone("warning"), fontSize: 13 }} selectable>
            {text}
          </Text>
        ))}
        {unknown.map(([kind, count]) => (
          <Text key={kind} style={ui.styles.muted}>
            不认识的事件 {kind} × {count}：按契约忽略
          </Text>
        ))}
      </View>
    </Fold>
  );
}
