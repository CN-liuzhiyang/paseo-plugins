import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  activity,
  byLabel,
  EFFECTS_LABEL,
  formatDuration,
  formatShort,
  formatTime,
  formatUsd,
  GATE_OUTCOME_LABEL,
} from "../shared/format";
import { callTitle, headline, nodeState, shortModel, START, END, visitState, type Graph, type GraphVisit } from "../shared/graph";
import {
  caveatsOf,
  costSoFar,
  costUncounted,
  gateVerdict,
  hasUncountedCodex,
  ms,
  phaseTitle,
  type CallState,
  type ProcessCheck,
  type RunState,
  type RunStatus,
} from "../shared/run";
import { GATE_TONE, KIND_LOOK, NODE_LOOK, VISIT_LOOK } from "./looks";
import { Json, Value } from "./value";
import { AgentRef, Badge, Block, CopyButton, Fact, Fold, OpenAgent, useUi, type Tone } from "./ui";

// What the selected node says, in the order a person asks: what came of it, who did it, what it
// cost, whether its limits held, where to look further. The prompt, schema and raw JSON are folded
// evidence at the bottom.

/** Grants that let a run act for a person or destroy something; worth a second look. */
const WIDE_GRANTS = new Set(["archive", "gate:allow", "gate:deny"]);

export interface DrawerProps {
  selected: string;
  run: RunState;
  events: readonly unknown[];
  graph: Graph;
  status: RunStatus;
  now: number;
  proc: ProcessCheck | null;
  staleMs: number;
  runId: string;
  onSelect(key: string): void;
}

export function Drawer(props: DrawerProps) {
  const { selected, run, graph } = props;
  if (selected === START) return <StartDrawer {...props} />;
  if (selected === END) return <EndDrawer {...props} />;
  const group = graph.groups.get(selected);
  if (group) return <GroupDrawer {...props} calls={group} />;
  const visit = graph.visits.find((candidate) => candidate.key === selected);
  if (visit) return <VisitDrawer {...props} visit={visit} />;
  const call = run.calls.get(selected);
  if (call) return <CallDrawer {...props} call={call} />;
  return <Empty />;
}

function Empty() {
  const ui = useUi();
  return <Text style={ui.styles.muted}>点图上的节点看详情。</Text>;
}

function Head({ title, children }: { title: string; children?: ReactNode }) {
  const ui = useUi();
  return (
    <View style={{ gap: 4 }}>
      <Text style={[ui.styles.heading, { fontSize: 17 }]} selectable>
        {title}
      </Text>
      {children ? <View style={[ui.styles.row, { gap: 6 }]}>{children}</View> : null}
    </View>
  );
}

function Sec({ label, children }: { label: string; children: ReactNode }) {
  const ui = useUi();
  return (
    <View style={{ gap: 6 }}>
      <Text style={[ui.styles.small, { fontWeight: "700" }]}>{label}</Text>
      {children}
    </View>
  );
}

function Box({ tone, children }: { tone?: Tone; children: ReactNode }) {
  const ui = useUi();
  const c = ui.theme.colors;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: tone ? ui.tone(tone) : c.border,
        backgroundColor: tone ? ui.tint(tone, 0.1) : c.surface1,
        borderRadius: 8,
        padding: 10,
        gap: 6,
      }}
    >
      {children}
    </View>
  );
}

function Pill({ tone, label }: { tone: Tone; label: string }) {
  const ui = useUi();
  return (
    <View style={{ backgroundColor: ui.tint(tone, 0.16), borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
      <Text style={{ color: tone === "neutral" ? ui.theme.colors.foregroundMuted : ui.tone(tone), fontSize: 12, fontWeight: "700" }}>
        {label}
      </Text>
    </View>
  );
}

function Meta({ text }: { text: string }) {
  const ui = useUi();
  return <Text style={ui.styles.small}>{text}</Text>;
}

/** Label and value in two columns. */
function Kv({ rows }: { rows: Array<[string, ReactNode] | null> }) {
  const ui = useUi();
  return (
    <View style={{ gap: 4 }}>
      {rows.map((row) =>
        row ? (
          <View key={row[0]} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
            <Text style={[ui.styles.muted, { width: 64 }]}>{row[0]}</Text>
            <View style={{ flex: 1, minWidth: 0 }}>
              {typeof row[1] === "string" ? (
                <Text style={ui.styles.text} selectable>
                  {row[1]}
                </Text>
              ) : (
                row[1]
              )}
            </View>
          </View>
        ) : null,
      )}
    </View>
  );
}

// ---- the run's two ends -----------------------------------------------------------------

function StartDrawer({ run, now, proc, runId }: DrawerProps) {
  const ui = useUi();
  const start = run.start;
  const caveats = caveatsOf(run);
  if (!start) return <Empty />;
  return (
    <View style={{ gap: 16 }}>
      <Head title="这次运行">
        <Meta text={[start.flow.name, start.flow.description].filter(Boolean).join(" · ")} />
      </Head>
      <Sec label="输入">
        <Box>
          <Value value={start.input} schema={start.flow.inputs} />
        </Box>
      </Sec>
      {caveats.length > 0 ? (
        <Sec label={`没被机械强制的约束（${caveats.length}，整次运行只说这一遍）`}>
          <Text style={ui.styles.small}>这些只写在 prompt 里、或靠 agent 自觉，运行时没法保证。图上带盾牌标记的节点受它们影响。</Text>
          {caveats.map((text) => (
            <Box key={text} tone="warning">
              <Text style={ui.styles.text} selectable>
                {text}
              </Text>
            </Box>
          ))}
        </Sec>
      ) : null}
      <Logs run={run} now={now} />
      <Fold label="运行详情（证据）">
        <View style={[ui.styles.card, { gap: 6 }]}>
          <Fact label="开始">{formatTime(run.startedAt, now)}</Fact>
          <Fact label="发起方">
            {start.caller ? <AgentRef agentId={start.caller} remote={false} /> : <Text style={ui.styles.text}>终端（没有发起方 agent）</Text>}
          </Fact>
          <Fact label="主机">{start.host ?? "本机"}</Fact>
          <Fact label="运行进程">{processText(run, proc)}</Fact>
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
          {start.cwd ? <Fact label="工作目录">{start.cwd}</Fact> : null}
          {start.source ? <Fact label="flow 文件">{start.source}</Fact> : null}
          <Fact label="运行 id">
            <View style={ui.styles.row}>
              <Text style={ui.styles.mono} selectable>
                {run.runId ?? runId}
              </Text>
              <CopyButton text={run.runId ?? runId} />
            </View>
          </Fact>
        </View>
      </Fold>
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

function Logs({ run, now }: { run: RunState; now: number }) {
  const ui = useUi();
  if (run.logs.length === 0) return null;
  const warns = run.logs.filter((log) => log.level === "warn").length;
  const errors = run.logs.filter((log) => log.level === "error").length;
  const counts = [warns ? `${warns} 条警告` : null, errors ? `${errors} 条错误` : null].filter(Boolean).join("，");
  return (
    <Fold label={`flow 写的日志 ${run.logs.length} 条`} hint={counts || undefined} initiallyOpen={errors > 0}>
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

const OUTCOME_WORD = { done: "完成", stopped: "停下", failed: "失败", timeout: "超时" } as const;

function EndDrawer({ run, events, status, now, proc, staleMs }: DrawerProps) {
  const ui = useUi();
  const end = run.end;
  if (!end) {
    return (
      <View style={{ gap: 12 }}>
        <Head title="还没有结局" />
        <Text style={ui.styles.text}>
          {status === "lost"
            ? proc && !proc.alive
              ? "运行进程已经不在了，不会再写结局。"
              : "很久没有新事件，也没有结局：运行进程可能已经退出。一有新事件这里会自动恢复。"
            : "运行结束时这里给出结果。"}
        </Text>
        <Box>
          <Text style={ui.styles.muted}>{activity(run, status, now, { proc, staleMs })}</Text>
        </Box>
      </View>
    );
  }
  const cost = end.cost;
  const raw = [...events].reverse().find((event) => (event as { kind?: unknown } | null)?.kind === "run.end");
  return (
    <View style={{ gap: 16 }}>
      <Head title={`结局：${OUTCOME_WORD[end.outcome]}`}>
        <Meta
          text={[
            `用时 ${formatDuration(end.durationMs)}`,
            cost ? `${formatUsd(cost.totalUsd)}${cost.agentCount != null ? `（${cost.agentCount} 个 agent）` : ""}` : "没有报告成本",
          ].join(" · ")}
        />
      </Head>
      {end.summary ? (
        <Sec label="一句话结果（flow 给出）">
          <Box>
            <Text style={ui.styles.text} selectable>
              {end.summary}
            </Text>
          </Box>
        </Sec>
      ) : null}
      {end.outcome === "stopped" ? (
        <Sec label={end.stop?.phase ? `在「${phaseTitle(run, end.stop.phase)}」停下` : "在阶段之外停下"}>
          <Box tone="warning">
            <Text style={ui.styles.text} selectable>
              {end.stop?.reason || "flow 没有说明为什么停下。"}
            </Text>
          </Box>
          <Text style={ui.styles.small}>停下是 flow 主动的决定（$.stop），不是出错。之后的阶段没有进入。</Text>
        </Sec>
      ) : null}
      {end.error ? (
        <Sec label="错误">
          <Box tone="danger">
            <Text style={ui.styles.text} selectable>
              {end.error.name}：{end.error.message}
            </Text>
          </Box>
        </Sec>
      ) : null}
      {end.value != null ? (
        <Sec label={end.outcome === "stopped" ? "停下时给出的结果" : "flow 返回的结果"}>
          <Box>
            <Value value={end.value} />
          </Box>
        </Sec>
      ) : null}
      {cost?.partial ? <Text style={ui.styles.small}>成本说明：{cost.partial}</Text> : null}
      {hasUncountedCodex(run) && !cost?.partial?.includes("Codex") ? (
        <Text style={ui.styles.small}>Codex agent 的成本读出来是 0，没有计入。</Text>
      ) : null}
      {raw ? (
        <Fold label="run.end 原文">
          <Json value={raw} />
        </Fold>
      ) : null}
    </View>
  );
}

// ---- boxes and groups -------------------------------------------------------------------

function CallLink({ call, run, status, onSelect }: { call: CallState; run: RunState; status: RunStatus; onSelect(key: string): void }) {
  const ui = useUi();
  const state = nodeState(call, status);
  const line = headline(call, status);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onSelect(call.callId)}
      style={({ pressed }) => [ui.styles.card, { padding: 10, gap: 2, opacity: pressed ? 0.75 : 1 }]}
    >
      <View style={[ui.styles.row, { gap: 6 }]}>
        <Text style={{ color: ui.tone(NODE_LOOK[state].tone), fontSize: 12, fontWeight: "700" }}>{NODE_LOOK[state].mark}</Text>
        <Text style={[ui.styles.strong, { flexShrink: 1 }]}>{callTitle(run, call)}</Text>
      </View>
      {line ? <Text style={ui.styles.muted}>{line}</Text> : null}
    </Pressable>
  );
}

function VisitDrawer({ run, status, graph, visit, onSelect }: DrawerProps & { visit: GraphVisit }) {
  const ui = useUi();
  const state = visitState(visit, run, status);
  const look = VISIT_LOOK[state];
  const cost = visit.calls.reduce((sum, call) => sum + (call.end?.cost?.usd ?? 0), 0);
  return (
    <View style={{ gap: 16 }}>
      <Head title={`${visit.title}${visit.round > 1 ? ` · 第 ${visit.round} 次` : ""}`}>
        <Pill tone={look.tone} label={look.label} />
        <Meta text={`阶段 · ${formatDuration((visit.t1 ?? graph.clock) - visit.t0)} · ${formatUsd(cost)}`} />
      </Head>
      <Sec label="这一段做了">
        {visit.calls.length === 0 ? <Text style={ui.styles.muted}>没有调用（阶段里只跑了脚本自己的代码）。</Text> : null}
        {visit.calls.map((call) => (
          <CallLink key={call.callId} call={call} run={run} status={status} onSelect={onSelect} />
        ))}
      </Sec>
    </View>
  );
}

function GroupDrawer({ run, status, calls }: DrawerProps & { calls: CallState[] }) {
  const ui = useUi();
  return (
    <View style={{ gap: 16 }}>
      <Head title={`${calls.length} 个脚本步骤`}>
        <Meta text={`${phaseTitle(run, calls[0]!.phase) ?? "阶段之外"} · 脚本自己做的事（$.do），不起 agent、不花 token`} />
      </Head>
      {calls.map((call) => {
        const state = nodeState(call, status);
        return (
          <Fold
            key={call.callId}
            label={`${NODE_LOOK[state].mark} ${call.title}`}
            hint={formatShort(call.end?.durationMs ?? null)}
            initiallyOpen={state === "error"}
          >
            <Box tone={state === "error" ? "danger" : undefined}>
              {call.end?.error ? (
                <Text style={ui.styles.text} selectable>
                  {call.end.error.name}：{call.end.error.message}
                </Text>
              ) : call.end ? (
                <Value value={call.end.output} />
              ) : (
                <Text style={ui.styles.muted}>{NODE_LOOK[state].label}</Text>
              )}
            </Box>
          </Fold>
        );
      })}
    </View>
  );
}

// ---- one call ---------------------------------------------------------------------------

function CallDrawer({ run, status, graph, call, onSelect }: DrawerProps & { call: CallState }) {
  const ui = useUi();
  const state = nodeState(call, status);
  const remote = run.start?.host != null;
  const kind = call.type ? KIND_LOOK[call.type] : null;
  const started = ms(call.startedAt);
  const took = call.end?.durationMs ?? (started === null ? null : graph.clock - started);
  const verdict = call.type === "gate" ? gateVerdict(call) : null;
  const pill: { tone: Tone; label: string } = verdict?.outcome
    ? { tone: GATE_TONE[verdict.outcome] ?? "neutral", label: GATE_OUTCOME_LABEL[verdict.outcome] ?? verdict.outcome }
    : NODE_LOOK[state];
  const visit = call.visit === null ? null : run.visits[call.visit];
  const where = visit ? `${phaseTitle(run, visit.phase)}${visit.round > 1 ? ` 第 ${visit.round} 次` : ""}` : "阶段之外";
  return (
    <View style={{ gap: 16 }}>
      <Head title={callTitle(run, call)}>
        <Pill tone={pill.tone} label={pill.label} />
        <Meta text={[kind?.name ?? "未知类型", where, formatDuration(took)].join(" · ")} />
      </Head>
      {call.type === "gate" ? (
        <GateBody call={call} state={state} remote={remote} />
      ) : call.type === "ask" ? (
        <AskBody call={call} state={state} status={status} took={took} remote={remote} onSelect={onSelect} />
      ) : (
        <DoBody call={call} state={state} status={status} />
      )}
    </View>
  );
}

function Interrupted({ status, agent }: { status: RunStatus; agent: boolean }) {
  const ui = useUi();
  return (
    <Box tone="warning">
      <Text style={ui.styles.text}>
        运行{status === "lost" ? "失联" : "结束"}前没写下这个调用的结束记录，不知道结果。
        {agent ? "那个 agent 没被停掉，可能还在跑。" : ""}
      </Text>
    </Box>
  );
}

function AskBody({
  call,
  state,
  status,
  took,
  remote,
  onSelect,
}: {
  call: CallState;
  state: ReturnType<typeof nodeState>;
  status: RunStatus;
  took: number | null;
  remote: boolean;
  onSelect(key: string): void;
}) {
  const ui = useUi();
  const ask = call.ask!;
  const cost = call.end?.cost;
  const enforced = ask.fence?.enforced === true;
  const effects = ask.effects === null ? "影响范围未声明" : (EFFECTS_LABEL[ask.effects] ?? ask.effects);
  return (
    <>
      {call.end?.ok ? (
        <Sec label="结论">
          <Box>
            <Value value={call.end.output} schema={ask.schema} />
          </Box>
        </Sec>
      ) : null}
      {call.end && !call.end.ok ? (
        <Sec label="出了什么事">
          <Box tone="danger">
            <Text style={ui.styles.text} selectable>
              {call.end.error ? `${call.end.error.name}：${call.end.error.message}` : "调用失败，没有错误说明"}
            </Text>
          </Box>
        </Sec>
      ) : null}
      {state === "running" ? (
        <Sec label="现在">
          <Box tone="accent">
            <Text style={ui.styles.text}>
              已经跑了 {formatDuration(took)}
              {ask.timeout ? `，时限 ${ask.timeout}` : ""}。
            </Text>
          </Box>
        </Sec>
      ) : null}
      {state === "interrupted" ? <Interrupted status={status} agent={call.agentId !== null} /> : null}
      <Sec label="谁做的">
        <Kv
          rows={[
            ["角色", ask.role ?? "（没有角色，直接指定模型）"],
            ["模型", `${ask.provider}${ask.thinking ? ` · thinking ${ask.thinking}` : ""}`],
            [
              "花费",
              cost?.usd == null
                ? call.end
                  ? "没有报告"
                  : state === "running"
                    ? "还没结束"
                    : "不知道（没有结束记录）"
                : `${costUncounted(call) ? "未计入（Codex 报 0）" : formatUsd(cost.usd)}${
                    cost.inputTokens != null ? ` · ${cost.inputTokens} / ${cost.outputTokens ?? "?"} tokens` : ""
                  }`,
            ],
            [
              "约束",
              <View style={[ui.styles.row, { gap: 6 }]}>
                <Pill tone={enforced ? "success" : "warning"} label={enforced ? "机械强制" : "只是请求"} />
                <Text style={ui.styles.muted}>{effects}</Text>
              </View>,
            ],
            ask.timeout ? ["时限", ask.timeout] : null,
          ]}
        />
        {!enforced && ask.fence ? (
          <Pressable accessibilityRole="button" onPress={() => onSelect(START)}>
            <Text style={[ui.styles.small, { color: ui.tone("warning") }]}>⚠ 这一步的约束没有被机械强制；整次运行的说明在「输入」里 ›</Text>
          </Pressable>
        ) : null}
      </Sec>
      {call.agentId ? (
        <OpenAgent agentId={call.agentId} remote={remote} wide />
      ) : state === "running" ? (
        <Text style={ui.styles.small}>还不知道是哪个 agent：运行时通常在调用开始后几秒到一分钟内找到它。</Text>
      ) : null}
      <Sec label="证据">
        {ask.prompt ? (
          <Fold label="Prompt" hint={`${ask.prompt.length} 字`}>
            <Block text={ask.prompt} />
          </Fold>
        ) : null}
        {ask.schema ? (
          <Fold label="输出 schema" hint={ask.schemaFingerprint ?? undefined}>
            <Json value={ask.schema} />
          </Fold>
        ) : null}
        {call.end ? (
          <Fold label="完整输出 JSON">
            <Json value={call.end.output} />
          </Fold>
        ) : null}
        {ask.fence ? (
          <Fold label="栅栏说明" hint={ask.fence.mode ?? undefined}>
            <Block text={[`模式：${ask.fence.mode ?? "未知"}`, `机械强制：${enforced ? "是" : "否"}`, ask.fence.note].filter(Boolean).join("\n")} />
          </Fold>
        ) : null}
        {call.agentId ? (
          <View style={ui.styles.row}>
            <Text style={ui.styles.small}>agent id</Text>
            <Text style={ui.styles.mono} selectable>
              {call.agentId}
            </Text>
            <CopyButton text={call.agentId} />
          </View>
        ) : null}
      </Sec>
    </>
  );
}

function GateBody({ call, state, remote }: { call: CallState; state: ReturnType<typeof nodeState>; remote: boolean }) {
  const ui = useUi();
  const gate = call.gate;
  const verdict = gateVerdict(call);
  return (
    <>
      {state === "waiting" ? (
        <Box tone="warning">
          <Text style={ui.styles.text}>
            <Text style={{ fontWeight: "700" }}>你要做的：</Text>在 Paseo 的权限卡片上批准或拒绝。这里只读，不能批。
          </Text>
          {gate?.timeout ? <Text style={ui.styles.small}>{gate.timeout} 内没人处理，人闸按过期拒绝。</Text> : null}
          {call.agentId ? (
            <OpenAgent agentId={call.agentId} remote={remote} label="在 Paseo 打开审批卡片" primary wide />
          ) : (
            <Text style={ui.styles.small}>承载审批卡片的 agent 还没起来。</Text>
          )}
        </Box>
      ) : null}
      {state === "interrupted" ? <Interrupted status="lost" agent={call.agentId !== null} /> : null}
      {call.end && !call.end.ok ? (
        <Box tone="danger">
          <Text style={ui.styles.text} selectable>
            人闸自己出了错：{call.end.error ? `${call.end.error.name}：${call.end.error.message}` : "没有错误说明"}
          </Text>
        </Box>
      ) : null}
      {verdict ? (
        <Sec label="判定">
          <Kv
            rows={[
              [verdict.approved === true ? "批准人" : "裁决人", byLabel(verdict.by)],
              verdict.waitedMs !== null ? ["等了", formatDuration(verdict.waitedMs)] : null,
              verdict.reason ? ["理由", verdict.reason] : null,
              verdict.agentStatusAtDecision ? ["载体状态", verdict.agentStatusAtDecision] : null,
            ]}
          />
          {verdict.outcome === "mismatch" ? (
            <Text style={{ color: ui.tone("danger"), fontSize: 13 }}>裁决时的原文指纹和提请时不一致：被批的不是这份原文。</Text>
          ) : null}
          {verdict.agentReport != null ? (
            <Fold label="载体 agent 的报告">
              <Value value={verdict.agentReport} />
            </Fold>
          ) : null}
        </Sec>
      ) : null}
      {gate?.brief ? (
        <Sec label="给审批人的说明">
          <Box>
            <Text style={ui.styles.text} selectable>
              {gate.brief}
            </Text>
          </Box>
        </Sec>
      ) : null}
      {call.agentId && state !== "waiting" ? <OpenAgent agentId={call.agentId} remote={remote} label="在 Paseo 中打开承载审批的 agent" wide /> : null}
      <Sec label="证据">
        {gate?.content != null ? (
          <Fold label="待批原文" hint={gate.sha256 ? `sha256 ${gate.sha256.slice(0, 12)}…` : undefined}>
            <Block text={gate.content} />
          </Fold>
        ) : null}
        <Fold label="载体 agent 与暂存路径">
          <Json
            value={{
              provider: gate?.provider ?? null,
              model: shortModel(gate?.provider) || null,
              agentId: call.agentId,
              holdPath: gate?.holdPath ?? null,
              fence: gate?.fence ?? null,
              timeout: gate?.timeout ?? null,
            }}
          />
        </Fold>
        {call.end ? (
          <Fold label="判定对象原文">
            <Json value={call.end.output} />
          </Fold>
        ) : null}
      </Sec>
    </>
  );
}

function DoBody({ call, state, status }: { call: CallState; state: ReturnType<typeof nodeState>; status: RunStatus }) {
  const ui = useUi();
  return (
    <>
      {call.end?.ok ? (
        <Sec label="返回值">
          <Box>
            {call.end.output == null ? <Text style={ui.styles.muted}>没有返回值</Text> : <Value value={call.end.output} />}
          </Box>
        </Sec>
      ) : null}
      {call.end && !call.end.ok ? (
        <Sec label="出了什么事">
          <Box tone="danger">
            <Text style={ui.styles.text} selectable>
              {call.end.error ? `${call.end.error.name}：${call.end.error.message}` : "动作失败，没有错误说明"}
            </Text>
          </Box>
        </Sec>
      ) : null}
      {state === "running" ? <Text style={ui.styles.muted}>正在执行。</Text> : null}
      {state === "interrupted" ? <Interrupted status={status} agent={false} /> : null}
      <Kv rows={[call.name !== call.title ? ["动作名", call.name] : null]} />
      <Text style={ui.styles.small}>脚本动作是 flow 自己的代码，不起 agent、不花 token。</Text>
    </>
  );
}

/** The spend so far, in words, for the numbers row. */
export function spendText(run: RunState): string {
  if (run.end) {
    const cost = run.end.cost;
    return cost ? formatUsd(cost.totalUsd) : "没有报告";
  }
  const soFar = costSoFar(run);
  return `${formatUsd(soFar.usd)}（已结束的调用）`;
}
