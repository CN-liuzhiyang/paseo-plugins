import { Text, View } from "react-native";
import {
  askLine,
  byLabel,
  CALL_TYPE_LABEL,
  callStatusText,
  fenceLabel,
  formatDuration,
  formatTime,
  formatUsd,
} from "../shared/format";
import { callStatus, costUncounted, gateVerdict, ms, type CallState, type RunStatus } from "../shared/run";
import { CALL_ICON, CALL_LOOK, GATE_TONE } from "./looks";
import { Json, Value } from "./value";
import { AgentRef, Badge, Banner, Block, Fold, useUi, type Tone } from "./ui";

// One call: an agent answering a step (ask), the script doing something itself (do), or a person
// deciding (gate). The summary is always visible; the prompt and raw JSON are folded evidence.

export function CallCard({ call, status, now, remote }: { call: CallState; status: RunStatus; now: number; remote: boolean }) {
  const ui = useUi();
  const state = callStatus(call, status);
  const verdict = call.type === "gate" ? gateVerdict(call) : null;
  const tone: Tone = verdict?.outcome ? (GATE_TONE[verdict.outcome] ?? "neutral") : CALL_LOOK[state].tone;
  const icon = call.type ? CALL_ICON[call.type] : "CircleHelp";
  const started = ms(call.startedAt);
  const duration = call.end?.durationMs ?? (state === "running" && started !== null ? now - started : null);
  const cost = call.end?.cost;

  return (
    <View style={[ui.styles.card, { borderLeftWidth: 3, borderLeftColor: ui.tone(tone) }]}>
      <View style={ui.styles.row}>
        <Badge tone="neutral" icon={icon} label={call.type ? CALL_TYPE_LABEL[call.type]! : "未知类型"} />
        <Text style={[ui.styles.strong, { flexShrink: 1 }]} selectable>
          {call.title}
        </Text>
        {call.name !== call.title && call.type !== "gate" ? <Text style={ui.styles.small}>{call.name}</Text> : null}
      </View>

      <View style={ui.styles.row}>
        <Badge tone={tone} icon={verdict?.outcome ? undefined : CALL_LOOK[state].icon} label={callStatusText(call, status)} solid={state === "running"} />
        <Text style={ui.styles.small}>
          {[
            state === "running" ? `已 ${formatDuration(duration)}` : duration === null ? null : formatDuration(duration),
            call.startedAt ? `开始 ${formatTime(call.startedAt, now)}` : "没有 call.start",
            cost?.usd != null ? (costUncounted(call) ? "成本未计入（Codex 读出来是 0）" : `成本 ${formatUsd(cost.usd)}`) : null,
            cost?.inputTokens != null ? `${cost.inputTokens} / ${cost.outputTokens ?? "?"} tokens` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>

      {call.ask ? <AskHeader call={call} /> : null}
      {state === "interrupted" ? (
        <Text style={{ color: ui.tone("warning"), fontSize: 13 }}>
          这个调用开始了，但运行{status === "lost" ? "失联" : "结束"}前没有写下它的结束记录，不知道结果。
        </Text>
      ) : null}
      {call.end?.error ? (
        <Banner tone="danger" icon="CircleX" title={call.end.error.name}>
          <Text style={ui.styles.text} selectable>
            {call.end.error.message}
          </Text>
        </Banner>
      ) : null}

      {call.type === "gate" ? <GateBody call={call} state={state} now={now} /> : <Output call={call} />}

      {call.caveats.length > 0 ? (
        <View style={{ gap: 2 }}>
          {[...new Set(call.caveats)].map((text) => (
            <Text key={text} style={{ color: ui.tone("warning"), fontSize: 13 }} selectable>
              ⚠ {text}
            </Text>
          ))}
        </View>
      ) : null}

      {call.agentId ? (
        <View style={{ gap: 2 }}>
          <Text style={ui.styles.small}>{call.type === "gate" ? "承载审批的 agent" : "agent"}</Text>
          <AgentRef agentId={call.agentId} remote={remote} />
        </View>
      ) : call.type === "ask" && state === "running" ? (
        <Text style={ui.styles.small}>还不知道是哪个 agent：运行时还没发出 call.agent。</Text>
      ) : null}

      {call.ask?.prompt ? (
        <Fold label="Prompt" hint={`${call.ask.prompt.length} 字`}>
          <Block text={call.ask.prompt} />
        </Fold>
      ) : null}
      {call.ask?.schema ? (
        <Fold label="输出 schema" hint={call.ask.schemaFingerprint ?? undefined}>
          <Json value={call.ask.schema} />
        </Fold>
      ) : null}
      {call.end ? (
        <Fold label="完整输出 JSON">
          <Json value={call.end.output} />
        </Fold>
      ) : null}
    </View>
  );
}

function AskHeader({ call }: { call: CallState }) {
  const ui = useUi();
  const ask = call.ask!;
  const fence = fenceLabel(call);
  const enforced = ask.fence?.enforced === true;
  return (
    <View style={{ gap: 4 }}>
      <Text style={ui.styles.muted} selectable>
        {askLine(call)}
        {ask.timeout ? ` · 时限 ${ask.timeout}` : ""}
      </Text>
      {fence ? (
        <View style={ui.styles.row}>
          <Badge tone={enforced ? "success" : "warning"} icon={enforced ? "ShieldCheck" : "ShieldAlert"} label={fence} />
          {ask.fence?.note ? (
            <Text style={[ui.styles.small, { flexShrink: 1 }]} selectable>
              {ask.fence.note}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Output({ call }: { call: CallState }) {
  const ui = useUi();
  if (!call.end || !call.end.ok) return null;
  const output = call.end.output;
  if (output === null || output === undefined) {
    return <Text style={ui.styles.muted}>{call.type === "do" ? "没有返回值" : "没有输出"}</Text>;
  }
  return (
    <View style={{ gap: 4 }}>
      <Text style={ui.styles.small}>{call.type === "do" ? "返回值" : "输出"}</Text>
      <Value value={output} schema={call.ask?.schema} />
    </View>
  );
}

function GateBody({ call, state, now }: { call: CallState; state: ReturnType<typeof callStatus>; now: number }) {
  const ui = useUi();
  const gate = call.gate;
  const verdict = gateVerdict(call);
  return (
    <View style={{ gap: 8 }}>
      {state === "running" ? (
        <Text style={ui.styles.text}>
          正在等人在 Paseo 的权限请求里裁决{gate?.timeout ? `（时限 ${gate.timeout}）` : ""}。这里只读，不能批准。
        </Text>
      ) : null}
      {verdict ? (
        <View style={{ gap: 4 }}>
          <Text style={ui.styles.text} selectable>
            {verdict.approved === true ? "批准人" : "裁决人"}：{byLabel(verdict.by)}
          </Text>
          <Text style={ui.styles.small}>
            {[
              verdict.waitedMs !== null ? `等了 ${formatDuration(verdict.waitedMs)}` : null,
              verdict.askedAt ? `提请 ${formatTime(verdict.askedAt, now)}` : null,
              verdict.decidedAt ? `裁决 ${formatTime(verdict.decidedAt, now)}` : null,
              verdict.agentStatusAtDecision ? `裁决时 agent 状态 ${verdict.agentStatusAtDecision}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {verdict.reason ? (
            <Text style={ui.styles.text} selectable>
              理由：{verdict.reason}
            </Text>
          ) : null}
          {verdict.outcome === "mismatch" ? (
            <Text style={{ color: ui.tone("danger"), fontSize: 13 }}>
              裁决时的原文指纹和提请时不一致：被批的不是这份原文。
            </Text>
          ) : null}
          {verdict.agentReport != null ? (
            <Fold label="agent 的报告">
              <Value value={verdict.agentReport} />
            </Fold>
          ) : null}
        </View>
      ) : null}
      {gate?.brief ? (
        <View style={{ gap: 2 }}>
          <Text style={ui.styles.small}>给审批人的说明</Text>
          <Text style={ui.styles.text} selectable>
            {gate.brief}
          </Text>
        </View>
      ) : null}
      {gate?.content != null ? (
        <Fold label="待批原文" hint={gate.sha256 ? `sha256 ${gate.sha256.slice(0, 12)}…` : undefined}>
          <Block text={gate.content} />
        </Fold>
      ) : null}
    </View>
  );
}
