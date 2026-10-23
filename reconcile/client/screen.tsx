import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { overviewRpc, releaseRulesRpc, testCardRpc, tickRpc } from "../shared/rpc";
import { describeChanges, PLAN_LABEL, troubleOf, type PlanEntry, type Status, type StatusCase } from "../shared/status";
import { Badge, Banner, Block, Button, Fold, OpenAgent, Section, UiProvider, useUi, type Tone } from "./ui";

// 「事务」: what wants you first -- problems, questions waiting for you (each one opens its card),
// what will be asked later -- then one line on whether the controller is alive, the plan of the
// last reconcile, and the cases nothing is asked about. The alive line moves to the top, red and
// opened, when the controller has not reconciled for two of its periods (a reconcile still
// running is not that) or a source is in trouble. Cases come most urgent first: the engine sorts
// them by rule error, question waiting, then health.

export const SCREEN_ID = "inbox";
const POLL_MS = 5_000;

type Overview = RpcOutput<typeof overviewRpc>;
type Case = StatusCase;

function useOverview(): { data: Overview | null; error: string | null; refresh(): void } {
  const overview = useRpc(overviewRpc);
  const [state, setState] = useState<{ data: Overview | null; error: string | null }>({ data: null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const data = await overview({});
        if (!cancelled) setState({ data, error: null });
      } catch (error) {
        if (!cancelled) setState((current) => ({ data: current.data, error: String(error) }));
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [overview, nonce]);
  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

const ago = (isoText: string | null, nowMs: number) => {
  if (!isoText) return "从没";
  const minutes = Math.round((nowMs - Date.parse(isoText)) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 120) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
};
const clock = (isoText: string) => isoText.slice(5, 16).replace("T", " ");

const HEALTH: Record<string, { tone: Tone; label: string }> = {
  "on-track": { tone: "neutral", label: "在走" },
  waiting: { tone: "accent", label: "在等" },
  stalled: { tone: "warning", label: "停住了" },
  blocked: { tone: "danger", label: "卡住" },
  conflict: { tone: "danger", label: "对不上" },
  done: { tone: "success", label: "结束" },
};

const SOURCE: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: "success", label: "正常" },
  degraded: { tone: "warning", label: "在重试" },
  down: { tone: "danger", label: "不可用" },
  never: { tone: "neutral", label: "还没读过" },
};

export function InboxScreen(props: PluginScreenProps & { openSettings(): void }) {
  return (
    <UiProvider props={props}>
      <Inbox openSettings={props.openSettings} />
    </UiProvider>
  );
}

function Inbox({ openSettings }: { openSettings(): void }) {
  const ui = useUi();
  const { data, error, refresh } = useOverview();
  const tick = useRpc(tickRpc);
  const release = useRpc(releaseRulesRpc);
  const testCard = useRpc(testCardRpc);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const status = data?.status as Status | null | undefined;

  const run = (label: string, action: () => Promise<{ ok: boolean; detail: string }>) => {
    setBusy(label);
    setNote(null);
    action().then(
      (result) => {
        setBusy(null);
        setNote(result.detail ? { ok: result.ok, text: result.detail } : null);
        refresh();
      },
      (e: unknown) => {
        setBusy(null);
        setNote({ ok: false, text: String(e) });
      },
    );
  };

  return (
    <ScrollView style={ui.styles.screen} contentContainerStyle={ui.styles.content}>
      <View style={[ui.styles.row, { justifyContent: "space-between" }]}>
        <View style={ui.styles.row}>
          <Text style={ui.styles.title}>事项追踪</Text>
          {/* Whether it asks at all, before anything else: an empty list while rehearsing means nothing. */}
          {status ? <Badge tone={status.mode === "live" ? "success" : "warning"} label={status.mode === "live" ? "发卡中" : "演练（不发卡）"} /> : null}
        </View>
        <View style={ui.styles.row}>
          <Button icon="RefreshCw" label={busy === "tick" ? "正在检查…" : "现在检查"} disabled={busy !== null || !status} onPress={() => run("tick", () => tick({}))} />
          <Button icon="FlaskConical" label={busy === "test" ? "正在排…" : "发测试卡"} disabled={busy !== null || !status} onPress={() => run("test", () => testCard({}))} />
          <Button icon="Settings" label="设置" onPress={openSettings} />
        </View>
      </View>
      {error ? (
        <Banner tone="danger" icon="TriangleAlert" title="刷新失败，下面是上一次读到的">
          <Text style={ui.styles.muted} selectable>
            {error}
          </Text>
        </Banner>
      ) : null}
      {note ? (
        <Banner tone={note.ok ? "accent" : "warning"} icon="Info" title={note.ok ? "好了" : "没做成"}>
          <Text style={ui.styles.muted} selectable>
            {note.text}
          </Text>
        </Banner>
      ) : null}
      {!data ? (
        error ? null : <Text style={ui.styles.muted}>正在读取……</Text>
      ) : !status ? (
        <Banner tone={data.state === "config" ? "danger" : "neutral"} icon={data.state === "config" ? "TriangleAlert" : "Pause"} title={data.state === "config" ? "配置有问题，控制器没有起来" : "控制器没有在跑"}>
          {data.detail ? (
            <Text style={ui.styles.text} selectable>
              {data.detail}
            </Text>
          ) : null}
          <Text style={ui.styles.muted}>在插件设置里填 configDir 和 home；改了设置会自动重启控制器。</Text>
        </Banner>
      ) : (
        <Body status={status} busy={busy} onRelease={(fingerprint) => run("release", () => release({ fingerprint }))} />
      )}
    </ScrollView>
  );
}

function Alive({ status }: { status: Status }) {
  const ui = useUi();
  const nowMs = Date.parse(status.now);
  const { late, stuck, sources } = troubleOf(status);
  const bad = late || sources.length > 0;
  const tick = status.ticking
    ? `正在检查（${ago(status.tickStartedAt, nowMs)}开始）${stuck ? "，太久了，控制器可能卡住了" : ""}`
    : `上次检查 ${ago(status.lastTickAt, nowMs)}${late ? "，超过两个周期没检查，控制器可能卡住了" : ""}`;
  return (
    <View style={[ui.styles.card, { borderColor: bad ? ui.tone("danger") : ui.theme.colors.border }]}>
      <View style={ui.styles.row}>
        <Text style={[ui.styles.small, bad ? { color: ui.tone("danger"), fontWeight: "700" } : null]}>
          {tick}；{sources.length === 0 ? "来源都正常" : `${sources.length} 个来源有问题`}
        </Text>
      </View>
      <Fold key={bad ? "bad" : "ok"} label={`来源（${status.sources.length}）`} initiallyOpen={bad}>
        {status.sources.map((s) => (
          <View key={s.id} style={ui.styles.row}>
            <Badge tone={SOURCE[s.state]?.tone ?? "neutral"} label={SOURCE[s.state]?.label ?? s.state} />
            <Text style={ui.styles.small}>
              {s.id}：上次读到 {ago(s.lastOkAt, nowMs)}
              {s.nextPollAt ? `，下次 ${clock(s.nextPollAt)}` : ""}，近一小时 {s.callsLastHour} 次调用
            </Text>
            {s.lastError ? (
              <Text style={[ui.styles.small, { color: ui.tone(s.state === "ok" ? "warning" : "danger") }]} selectable>
                {s.lastError}
              </Text>
            ) : null}
          </View>
        ))}
      </Fold>
    </View>
  );
}

const planLine = (p: PlanEntry) => `${clock(p.at)}  [${PLAN_LABEL[p.kind] ?? p.kind}] ${p.summary}`;

function CaseRow({ kase, cardAgent }: { kase: Case; cardAgent?: string | null }) {
  const ui = useUi();
  const a = kase.assessment;
  const health = a ? (a.error ? { tone: "danger" as Tone, label: "判断出错" } : (HEALTH[a.health] ?? { tone: "neutral" as Tone, label: a.health })) : { tone: "neutral" as Tone, label: "未判断" };
  const open = kase.commitments.filter((c) => c.status === "scheduled" || c.status === "waiting");
  return (
    <View style={ui.styles.card}>
      <View style={ui.styles.row}>
        <Badge tone={health.tone} label={health.label} />
        {a?.stale ? <Badge tone="warning" label="数据可能过时" /> : null}
        <Text style={[ui.styles.strong, { flexShrink: 1 }]} selectable>
          {kase.title}
        </Text>
      </View>
      <Text style={ui.styles.text} selectable>
        {a?.error ? a.error : (a?.headline ?? kase.status)}
      </Text>
      {a?.notice ? (
        <Text style={ui.styles.small} selectable>
          ⚠ {a.notice}
        </Text>
      ) : null}
      {open.map((c) => (
        <Text key={c.id} style={ui.styles.small}>
          · {c.title}：{c.step}
        </Text>
      ))}
      <View style={ui.styles.row}>
        {cardAgent ? <OpenAgent agentId={cardAgent} label="打开问题卡回答" primary /> : null}
        {kase.url ? (
          <Text style={ui.styles.small} selectable>
            {kase.url}
          </Text>
        ) : null}
      </View>
      {kase.hot.length > 0 || kase.commitments.some((c) => c.answer || (c.status !== "scheduled" && c.status !== "waiting")) ? (
        <Fold label="详情">
          {kase.hot.length > 0 ? <Text style={ui.styles.small}>为什么在看：{kase.hot.join("；")}</Text> : null}
          {kase.commitments.map((c) => (
            <Text key={c.id} style={ui.styles.small} selectable>
              {c.title}：{c.status}
              {c.answer ? `，回答「${c.answer}」` : ""}
              {c.reason ? `（${c.reason}）` : ""}
            </Text>
          ))}
        </Fold>
      ) : null}
    </View>
  );
}

function Body({ status, busy, onRelease }: { status: Status; busy: string | null; onRelease(fingerprint: string): void }) {
  const ui = useUi();
  const raised = status.cards.filter((c) => c.agentId);
  const cardOf = (caseId: string) => raised.find((c) => c.caseIds.includes(caseId))?.agentId ?? null;
  const waitingOnMe = status.cases.filter((k) => k.commitments.some((c) => c.status === "waiting"));
  // Cards not about any case: the test card.
  const loose = raised.filter((c) => c.caseIds.length === 0);
  const scheduled = status.cases.filter((k) => k.open && !waitingOnMe.includes(k));
  const quiet = status.cases.filter((k) => !k.open && k.assessment?.health !== "done" && !k.assessment?.error);
  const errors = status.cases.filter((k) => !k.open && k.assessment?.error);
  const finished = status.cases.filter((k) => !k.open && k.assessment?.health === "done");
  const held = status.rules.held;
  const said = status.said ?? [];
  const { late, sources } = troubleOf(status);
  const alarm = late || sources.length > 0;
  const notes = status.plan.filter((p) => p.kind === "note");
  const acts = status.plan.filter((p) => p.kind !== "note");

  return (
    <>
      {alarm ? <Alive status={status} /> : null}
      {status.problems.map((p) => (
        <Banner key={p} tone="warning" icon="TriangleAlert" title={p} />
      ))}
      {held ? (
        <Banner tone="warning" icon="ShieldAlert" title={`判断方法改了，先停着：它会一下子${describeChanges(held)}`}>
          <Text style={ui.styles.muted}>现状已经按新的判断方法在算，但要问的问题一个没动（不排新的、不收回、不改、不重新排），新判断要记的事实也没记，不会因此发卡或收卡。看一下下面计划里「先停着」的几条，确认没问题再放行。</Text>
          <Button icon="Check" label={busy === "release" ? "正在放行…" : "放行这一版判断方法"} disabled={busy !== null} onPress={() => onRelease(held.fingerprint)} />
        </Banner>
      ) : null}
      {status.rules.errors.length > 0 ? (
        <Banner tone="danger" icon="FileWarning" title="有判断方法的文件没加载">
          {status.rules.errors.map((e) => (
            <Text key={e.file} style={ui.styles.small} selectable>
              {e.file}：{e.error}
            </Text>
          ))}
        </Banner>
      ) : null}

      <Section title={`要你回答（${waitingOnMe.length + loose.length}）`}>
        {loose.map((card) => (
          <View key={card.id} style={ui.styles.card}>
            <Text style={ui.styles.strong}>{card.title}</Text>
            <Text style={ui.styles.small}>
              {clock(card.raisedAt)} 发给 {card.person}
            </Text>
            <OpenAgent agentId={card.agentId!} label="打开问题卡回答" primary />
          </View>
        ))}
        {waitingOnMe.length + loose.length === 0 ? <Text style={ui.styles.muted}>现在没有要你回答的。</Text> : waitingOnMe.map((k) => <CaseRow key={k.caseId} kase={k} cardAgent={cardOf(k.caseId)} />)}
      </Section>

      <Section title={`到时候会问（${scheduled.length}）`}>
        {scheduled.length === 0 ? <Text style={ui.styles.muted}>没有排着的。</Text> : scheduled.map((k) => <CaseRow key={k.caseId} kase={k} />)}
      </Section>

      {said.length > 0 ? (
        <Section title={`对话里说过的（${said.filter((a) => a.inForce).length} 条在生效）`}>
          {said.map((a) => (
            <View key={a.id} style={ui.styles.card}>
              <Text style={a.inForce ? ui.styles.strong : ui.styles.muted}>
                {a.caseId.slice(a.caseId.lastIndexOf(":") + 1)}「{a.label}」{a.until ? `到 ${a.until}` : ""}
                {a.inForce ? "" : a.revokedAt ? `（${clock(a.revokedAt)} 撤了）` : "（过期了）"}
              </Text>
              <Text style={ui.styles.small} selectable>
                {a.by} {clock(a.at)} 说：「{a.said}」{a.how === "confirmed" ? "（在卡片上确认的）" : ""} · {a.id}
              </Text>
            </View>
          ))}
          <Text style={ui.styles.muted}>要撤掉一条，在对话里说一句（比如"刚才那条不要了"）。</Text>
        </Section>
      ) : null}

      {alarm ? null : <Alive status={status} />}

      <Fold label={`这一轮检查${status.mode === "live" ? "做了" : "打算做"}的事（${acts.length}）`} initiallyOpen={status.mode !== "live"}>
        {acts.length === 0 ? <Text style={ui.styles.muted}>没有要做的。</Text> : <Block text={acts.map(planLine).join("\n")} />}
        {notes.length > 0 ? (
          <Fold label={`另外记下 ${notes.length} 条事实`}>
            <Block text={notes.map(planLine).join("\n")} />
          </Fold>
        ) : null}
      </Fold>

      {errors.length > 0 ? (
        <Section title={`判断出错（${errors.length}）`}>
          {errors.map((k) => (
            <CaseRow key={k.caseId} kase={k} />
          ))}
        </Section>
      ) : null}
      <Fold label={`在看着、还不用问（${quiet.length}）`}>
        {quiet.map((k) => (
          <CaseRow key={k.caseId} kase={k} />
        ))}
      </Fold>
      <Fold label={`结束了（${finished.length}）`}>
        {finished.map((k) => (
          <CaseRow key={k.caseId} kase={k} />
        ))}
      </Fold>
      <Text style={ui.styles.small}>
        另有 {status.cold.length} 个事项是冷的：没有要问的、最近没人动、日期不在近期、关联的开关也没变，所以不判断、不显示；其中任何一样变了会自动回来。
      </Text>
      <Text style={ui.styles.small}>
        {status.instanceId ? `实例 ${status.instanceId} · ` : ""}每 {status.tickSeconds} 秒检查一次 · 判断方法 {status.rules.fingerprint?.slice(0, 12) ?? "—"}（{status.rules.files.join("、") || "没有判断文件"}） · 评测候选 {status.evals} 条 · 今天发卡{" "}
        {Object.entries(status.pushesToday)
          .map(([name, n]) => `${name} ${n}`)
          .join("、")}
      </Text>
    </>
  );
}
