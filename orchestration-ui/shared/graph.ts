// A run drawn as a flow: phase visits are boxes, calls are nodes inside them, time runs left to
// right, overlap stacks, re-entered phases fold into an inferred loop. Plus the one sentence at
// the top of the detail view (hero) and the one line under each node (headline).
//
// Pure and derived from shared/run.ts only, so the daemon (list rows) and the app (detail view)
// say the same thing. Nothing here decides whether a run is running or lost; that is runStatus.

import { formatDuration, formatUsd, GATE_OUTCOME_LABEL, activity } from "./format";
import {
  callStatus,
  gateVerdict,
  ms,
  openCalls,
  phaseTitle,
  type CallState,
  type PhaseDecl,
  type ProcessCheck,
  type RunStart,
  type RunState,
  type RunStatus,
} from "./run";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** A call's state as a node shows it: a gate still open is waiting on a person, not running. */
export type NodeState = "ok" | "error" | "running" | "waiting" | "interrupted";

export type VisitState = "done" | "running" | "waiting" | "failed" | "stopped" | "interrupted";

/** A box on the graph: one phase visit, or calls outside every phase (no frame). */
export interface GraphVisit {
  key: string;
  phase: string | null;
  title: string;
  round: number;
  t0: number;
  /** null while open. */
  t1: number | null;
  ok: boolean | null;
  loose: boolean;
  calls: CallState[];
}

export type Wave = { kind: "calls"; calls: CallState[] } | { kind: "group"; key: string; calls: CallState[] };

export interface Stage {
  visit: GraphVisit;
  state: VisitState;
  waves: Wave[];
  durationMs: number;
}

/** Stages whose time spans overlap; more than one means they ran side by side. */
export type Column = Stage[];

export type Piece =
  | { kind: "input"; key: typeof START; label: string }
  | { kind: "column"; stages: Column }
  | { kind: "loop"; title: string; rounds: Column[][] }
  | { kind: "ghost"; phase: PhaseDecl; text: string }
  | { kind: "end"; key: typeof END; label: string; tone: Tone; dashed: boolean };

export interface Graph {
  /** Left to right: input, the run, phases never entered, the ending. */
  pieces: Piece[];
  visits: GraphVisit[];
  /** "N 个脚本步骤" nodes by key. */
  groups: Map<string, CallState[]>;
  /** Every selectable key to the index of the piece that holds it, for scrolling it into view. */
  pieceOf: Map<string, number>;
  /** The time "now" means for this run: see runClock. */
  clock: number;
}

export const START = "@start";
export const END = "@end";

/**
 * The time a run's durations run up to. A running run is measured to now; a run that ended,
 * or went quiet and is lost, stopped at its last event, and counting on to now would claim it
 * kept going.
 */
export function runClock(run: RunState, status: RunStatus, now: number): number {
  if (status === "running" || status === "starting") return now;
  return ms(run.end?.at ?? run.lastEventAt) ?? now;
}

export function nodeState(call: CallState, status: RunStatus): NodeState {
  const state = callStatus(call, status);
  if (state === "running" && call.type === "gate") return "waiting";
  return state;
}

// ---- words ------------------------------------------------------------------------------

/** "claude/claude-opus-5-5" → "opus-5-5". */
export function shortModel(provider: string | null | undefined): string {
  if (!provider) return "";
  const model = provider.split("/")[1] ?? provider;
  return model.replace(/^claude-/, "");
}

/**
 * The title a node shows. Older runtimes wrote the step name in brackets ("[advise]",
 * "[draft] #100231") because the same string named the agent in the sidebar; that reads as
 * "<phase> · advise" here.
 */
export function callTitle(run: RunState, call: CallState): string {
  const bracketed = /^\[([^\]]+)\]\s*(.*)$/.exec(call.title.trim());
  if (!bracketed) return call.title;
  const [, step, rest] = bracketed;
  const phase = phaseTitle(run, call.phase);
  const what = rest ? `${step} ${rest}` : step!;
  return phase ? `${phase} · ${what}` : what;
}

/** "reviewer · opus-5-5" for an agent, what a gate asks of people; a script's own name stays in the drawer. */
export function callWho(call: CallState): string | null {
  if (call.type === "ask") {
    const model = shortModel(call.ask?.provider);
    return [call.ask?.role, model].filter(Boolean).join(" · ") || null;
  }
  if (call.type === "gate") return "在 Paseo 的权限卡片上批";
  return null;
}

function trunc(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describedAs(schema: unknown, key: string): string | null {
  if (!isObj(schema) || !isObj(schema.properties)) return null;
  const field = schema.properties[key];
  return isObj(field) && typeof field.description === "string" && field.description ? field.description : null;
}

function fieldLine(key: string, value: unknown, schema: unknown): string | null {
  const label = describedAs(schema, key);
  if (typeof value === "string") return value ? trunc(value, 80) : null;
  if (typeof value === "boolean") return `${label ? trunc(label, 14) : key}：${value ? "是" : "否"}`;
  if (typeof value === "number") return `${label ? trunc(label, 14) : key}：${value}`;
  if (Array.isArray(value)) return `${label ? trunc(label, 14) : key}：${value.length} 项`;
  return null;
}

/** Checks a script returned, counted: `[{ passed }]` or `[{ ok }]`. */
function checkCount(output: unknown): string | null {
  if (!Array.isArray(output)) return null;
  const checks = output.filter(
    (item): item is Record<string, unknown> => isObj(item) && (typeof item.passed === "boolean" || typeof item.ok === "boolean"),
  );
  if (checks.length === 0) return null;
  const bad = checks.filter((item) => (item.passed ?? item.ok) === false).length;
  return bad > 0 ? `${bad} 项不过 · ${checks.length - bad} 项通过` : `${checks.length} 项全部通过`;
}

/**
 * The one line under a node. A step that names its headline field gets that field; otherwise a
 * guess: counted checks, the first short string, boolean or list in the output, the gate's verdict.
 */
export function headline(call: CallState, status: RunStatus): string | null {
  const state = nodeState(call, status);
  if (call.type === "gate") {
    if (!call.end) return state === "waiting" ? "等你批准" : null;
    if (!call.end.ok) return "人闸出错";
    const outcome = gateVerdict(call)?.outcome;
    if (outcome === "expired") return "过期，按拒绝处理";
    if (outcome === "denied") return "被拒绝";
    return outcome ? (GATE_OUTCOME_LABEL[outcome] ?? outcome) : null;
  }
  if (!call.end || !call.end.ok) return null;
  const output = call.end.output;
  const schema = call.ask?.schema;
  const named = call.ask?.headline;
  if (named && isObj(output) && named in output) {
    const line = fieldLine(named, output[named], schema);
    if (line) return line;
  }
  const checks = checkCount(output);
  if (checks) return checks;
  if (Array.isArray(output)) return `返回 ${output.length} 项`;
  if (typeof output === "string") return output ? trunc(output, 60) : null;
  if (isObj(output)) {
    // A script's own verdict reads better as a word than as "ok：是".
    const verdict = typeof output.passed === "boolean" ? output.passed : typeof output.ok === "boolean" ? output.ok : null;
    if (call.type === "do" && verdict !== null) return verdict ? "通过" : "不通过";
    for (const [key, value] of Object.entries(output)) {
      if (typeof value === "string" && (value === "" || value.length > 80)) continue;
      if (isObj(value) || value === null) continue;
      const line = fieldLine(key, value, schema);
      if (line) return line;
    }
  }
  return null;
}

/** The input value that best tells this run from the others: a ticket number, a question. */
export function inputLabel(start: RunStart | null): string | null {
  const input = start?.input;
  if (!isObj(input)) return typeof input === "string" && input ? trunc(input, 40) : null;
  const numbered = ["ticket", "issue", "pr", "bug", "id"];
  const worded = ["question", "topic", "task", "title", "goal", "subject", "query", "prompt", "name"];
  for (const key of numbered) {
    const value = input[key];
    if ((typeof value === "string" && value) || typeof value === "number") {
      return /^\d+$/.test(String(value)) ? `#${value}` : trunc(String(value), 40);
    }
  }
  for (const key of worded) if (typeof input[key] === "string" && input[key]) return trunc(input[key] as string, 40);
  // Otherwise the first plain value, in the order the flow declared its inputs.
  const declared = isObj(start?.flow.inputs) && isObj(start!.flow.inputs.properties) ? Object.keys(start!.flow.inputs.properties) : [];
  const keys = [...declared, ...Object.keys(input).filter((key) => !declared.includes(key))];
  for (const key of keys) {
    const value = input[key];
    if ((typeof value === "string" && value) || typeof value === "number") return trunc(String(value), 40);
  }
  return null;
}

// ---- visits -----------------------------------------------------------------------------

function callT0(call: CallState, fallback: number): number {
  const started = ms(call.startedAt);
  if (started !== null) return started;
  const ended = ms(call.end?.at ?? null);
  return ended === null ? fallback : ended - (call.end?.durationMs ?? 0);
}

function callT1(call: CallState): number | null {
  return call.end ? ms(call.end.at) : null;
}

/**
 * Phase visits and the calls outside them, in the order they began. A call outside every phase
 * joins the unframed run of scripts before it when both are `do`; anything else starts its own.
 * A call naming a phase that was not open when it began has no box to go in and is shown as
 * outside one too, rather than dropped.
 */
export function graphVisits(run: RunState): GraphVisit[] {
  const base = ms(run.startedAt) ?? 0;
  type Entry = { order: number; visit: number } | { order: number; call: CallState };
  const entries: Entry[] = [
    ...run.visits.map((visit, index) => ({ order: visit.order, visit: index })),
    ...run.callOrder
      .map((id) => run.calls.get(id)!)
      .filter((call) => call.visit === null)
      .map((call) => ({ order: call.order, call })),
  ];
  entries.sort((a, b) => a.order - b.order);
  const out: GraphVisit[] = [];
  for (const entry of entries) {
    if ("visit" in entry) {
      const visit = run.visits[entry.visit]!;
      out.push({
        key: `@v${entry.visit}`,
        phase: visit.phase,
        title: phaseTitle(run, visit.phase) ?? visit.phase,
        round: visit.round,
        t0: ms(visit.startedAt) ?? base,
        t1: ms(visit.endedAt),
        ok: visit.ok,
        loose: false,
        calls: visit.callIds.map((id) => run.calls.get(id)!),
      });
      continue;
    }
    const call = entry.call;
    const last = out.at(-1);
    if (last?.loose && call.type === "do" && last.calls.every((other) => other.type === "do")) last.calls.push(call);
    else out.push({ key: `@l${call.callId}`, phase: null, title: "阶段之外", round: 1, t0: callT0(call, base), t1: null, ok: null, loose: true, calls: [call] });
  }
  for (const visit of out) {
    if (!visit.loose) continue;
    const ends = visit.calls.map(callT1);
    visit.t1 = ends.every((end) => end !== null) ? Math.max(...(ends as number[])) : null;
    visit.t0 = Math.min(...visit.calls.map((call) => callT0(call, base)));
  }
  return out;
}

export function visitState(visit: GraphVisit, run: RunState, status: RunStatus): VisitState {
  const states = visit.calls.map((call) => nodeState(call, status));
  if (states.includes("waiting")) return "waiting";
  const stop = run.end?.outcome === "stopped" ? run.end.stop?.phase : null;
  if (stop && stop === visit.phase && run.visits.filter((other) => other.phase === stop).length === visit.round) return "stopped";
  const live = status === "running" || status === "starting";
  if (!visit.loose && visit.t1 === null) return live ? "running" : "interrupted";
  if (states.includes("running")) return "running";
  if (visit.ok === false || states.includes("error")) return "failed";
  if (states.includes("interrupted")) return "interrupted";
  return "done";
}

/** Items whose [t0, t1) spans overlap share a group; the groups follow one another. */
export function waves<T>(items: readonly T[], t0: (item: T) => number, t1: (item: T) => number): T[][] {
  const sorted = [...items].sort((a, b) => t0(a) - t0(b));
  const out: T[][] = [];
  let end = -Infinity;
  for (const item of sorted) {
    const current = out.at(-1);
    if (current && t0(item) < end) {
      current.push(item);
      end = Math.max(end, t1(item));
    } else {
      out.push([item]);
      end = t1(item);
    }
  }
  return out;
}

/** A box's calls in waves; two or more single scripts in a row become one "N 个脚本步骤" node. */
export function stageWaves(visit: GraphVisit, clock: number): Wave[] {
  const out: Wave[] = [];
  for (const wave of waves(visit.calls, (call) => callT0(call, visit.t0), (call) => callT1(call) ?? clock)) {
    const last = out.at(-1);
    if (wave.length === 1 && wave[0]!.type === "do" && last) {
      if (last.kind === "group") {
        last.calls.push(wave[0]!);
        continue;
      }
      if (last.calls.length === 1 && last.calls[0]!.type === "do") {
        out[out.length - 1] = { kind: "group", key: `@g${last.calls[0]!.callId}`, calls: [last.calls[0]!, wave[0]!] };
        continue;
      }
    }
    out.push({ kind: "calls", calls: wave });
  }
  return out;
}

// ---- layout -----------------------------------------------------------------------------

type Laid = { kind: "column"; column: GraphVisit[] } | { kind: "loop"; phases: string[]; rounds: GraphVisit[][][] };

/**
 * Re-entered phases fold into a loop. From a phase's first visit up to the first phase its first
 * round did not include, every visit that starts a new column alone goes into the loop, one row
 * per entry into that phase. The flow declares no loops, so this is inferred; a shape it does not
 * recognize stays laid out flat, with every visit still in it.
 */
function foldLoops(columns: GraphVisit[][], visits: GraphVisit[]): Laid[] {
  const single = (column: GraphVisit[] | undefined) => (column && column.length === 1 && !column[0]!.loose ? column[0]! : null);
  const entries = (phase: string) => visits.filter((visit) => visit.phase === phase).length;
  const out: Laid[] = [];
  let i = 0;
  while (i < columns.length) {
    const head = single(columns[i]);
    if (head && head.round === 1 && entries(head.phase!) > 1) {
      const rounds: GraphVisit[][][] = [];
      const phases = [head.phase!];
      let current = [columns[i]!];
      let j = i + 1;
      for (; j < columns.length; j++) {
        const next = single(columns[j]);
        if (!next) break;
        if (next.phase === head.phase) {
          rounds.push(current);
          current = [columns[j]!];
        } else if (rounds.length === 0) {
          if (!phases.includes(next.phase!)) phases.push(next.phase!);
          current.push(columns[j]!);
        } else if (phases.includes(next.phase!)) {
          current.push(columns[j]!);
        } else break;
      }
      rounds.push(current);
      if (rounds.length > 1) {
        out.push({ kind: "loop", phases, rounds });
        i = j;
        continue;
      }
    }
    out.push({ kind: "column", column: columns[i]! });
    i += 1;
  }
  return out;
}

const END_LOOK: Record<RunStatus, { label: string; tone: Tone }> = {
  done: { label: "完成", tone: "success" },
  stopped: { label: "停下", tone: "warning" },
  failed: { label: "失败", tone: "danger" },
  timeout: { label: "超时", tone: "danger" },
  running: { label: "进行中", tone: "accent" },
  starting: { label: "启动中", tone: "neutral" },
  lost: { label: "失联", tone: "warning" },
};

export function buildGraph(run: RunState, status: RunStatus, now: number): Graph {
  const clock = runClock(run, status, now);
  const visits = graphVisits(run);
  const stage = (visit: GraphVisit): Stage => ({
    visit,
    state: visitState(visit, run, status),
    waves: stageWaves(visit, clock),
    durationMs: Math.max(0, (visit.t1 ?? clock) - visit.t0),
  });
  const columns = waves(visits, (visit) => visit.t0, (visit) => visit.t1 ?? clock);
  const pieces: Piece[] = [{ kind: "input", key: START, label: inputLabel(run.start) ?? "输入" }];
  for (const laid of foldLoops(columns, visits)) {
    if (laid.kind === "column") pieces.push({ kind: "column", stages: laid.column.map(stage) });
    else {
      const title = laid.phases.map((phase) => phaseTitle(run, phase) ?? phase).join(" ⇄ ");
      pieces.push({ kind: "loop", title, rounds: laid.rounds.map((round) => round.map((column) => column.map(stage))) });
    }
  }
  const entered = new Set([...run.visits.map((visit) => visit.phase), ...[...run.calls.values()].map((call) => call.phase)]);
  const live = status === "running" || status === "starting";
  for (const phase of run.start?.flow.phases ?? []) {
    if (!entered.has(phase.id)) pieces.push({ kind: "ghost", phase, text: live ? "还没到" : "没有进入" });
  }
  const end = END_LOOK[status];
  pieces.push({ kind: "end", key: END, label: end.label, tone: end.tone, dashed: live });

  const groups = new Map<string, CallState[]>();
  const pieceOf = new Map<string, number>();
  const note = (index: number, stages: Stage[]) => {
    for (const { visit, waves: inside } of stages) {
      pieceOf.set(visit.key, index);
      for (const wave of inside) {
        if (wave.kind === "group") {
          groups.set(wave.key, wave.calls);
          pieceOf.set(wave.key, index);
        }
        for (const call of wave.calls) pieceOf.set(call.callId, index);
      }
    }
  };
  pieces.forEach((piece, index) => {
    if (piece.kind === "input" || piece.kind === "end") pieceOf.set(piece.key, index);
    else if (piece.kind === "column") note(index, piece.stages);
    else if (piece.kind === "loop") for (const round of piece.rounds) for (const column of round) note(index, column);
  });
  return { pieces, visits, groups, pieceOf, clock };
}

// ---- the sentence at the top ------------------------------------------------------------

export interface Hero {
  tone: Tone;
  /** A few words above the title: "需要你处理", "完成 · 用时 3 分". */
  kicker: string;
  title: string;
  subtitle: string | null;
  /** The one thing to do about it, when there is one: open the agent that holds it. */
  action: { label: string; agentId: string } | null;
  /** What the detail view selects first. */
  select: string;
  /** A person has to act: a gate is waiting, or the run is lost and its agents may still run. */
  needsYou: boolean;
}

function quoted(run: RunState, calls: CallState[]): string {
  return calls.map((call) => `「${callTitle(run, call)}」`).join("、");
}

export function hero(
  run: RunState,
  status: RunStatus,
  now: number,
  { proc = null, staleMs = null }: { proc?: ProcessCheck | null; staleMs?: number | null } = {},
): Hero {
  const calls = run.callOrder.map((id) => run.calls.get(id)!);
  const open = openCalls(run);
  const started = ms(run.startedAt);
  const clock = runClock(run, status, now);
  const end = run.end;
  const agentAction = (call: CallState | undefined, label: string) =>
    call?.agentId ? { label, agentId: call.agentId } : null;

  if (!run.start) {
    return { tone: "neutral", kicker: "启动中", title: "文件已创建，第一条事件还没写完", subtitle: null, action: null, select: START, needsYou: false };
  }
  if (status === "running" || status === "starting") {
    const gate = open.find((call) => call.type === "gate");
    if (gate) {
      const waited = ms(gate.startedAt);
      const others = open.filter((call) => call !== gate);
      const timeout = gate.gate?.timeout;
      const subtitle = [
        waited === null ? null : `已等 ${formatDuration(now - waited)}`,
        timeout ? `${timeout} 内没人处理，人闸按过期拒绝` : null,
      ]
        .filter(Boolean)
        .join("，");
      return {
        tone: "warning",
        kicker: "需要你处理",
        title: `等你审批：${callTitle(run, gate)}`,
        subtitle: `${subtitle}${subtitle ? "。" : ""}${others.length ? `同时在跑：${quoted(run, others)}。` : ""}` || null,
        action: agentAction(gate, "在 Paseo 打开审批卡片"),
        select: gate.callId,
        needsYou: true,
      };
    }
    const doing = open.length > 0 ? `正在${quoted(run, open)}` : (activity(run, status, now, { proc, staleMs }) ?? "运行中");
    return {
      tone: "accent",
      kicker: "运行中",
      title: doing,
      subtitle: started === null ? null : `已运行 ${formatDuration(now - started)}`,
      action: agentAction(open.find((call) => call.agentId), "打开这个 agent"),
      select: open[0]?.callId ?? START,
      needsYou: false,
    };
  }
  if (status === "lost") {
    const last = ms(run.lastEventAt);
    const where = open.map((call) => {
      const model = shortModel(call.ask?.provider);
      return `「${callTitle(run, call)}」${model ? `（${model}）` : ""}`;
    });
    const agents = open.some((call) => call.agentId) ? "那个 agent 没有被停掉，可能还在跑、还在花钱。" : "";
    const quiet = last === null ? "" : `，${formatDuration(now - last)}没有新事件`;
    return {
      tone: "warning",
      kicker: "失联",
      title:
        proc && !proc.alive
          ? `运行进程不在了（pid ${proc.pid}），不会再有结果`
          : "不知道它还在不在跑：很久没有新事件，也没有结局",
      subtitle: `最后在做：${where.join("、") || "调用之间（脚本自己的代码）"}${quiet}。${agents}`,
      action: agentAction(open.find((call) => call.agentId), "打开那个 agent 看看"),
      select: open[0]?.callId ?? END,
      needsYou: true,
    };
  }
  const took = end?.durationMs ?? (started === null ? null : clock - started);
  if (status === "done") {
    return {
      tone: "success",
      kicker: `完成 · 用时 ${formatDuration(took)}`,
      title: end?.summary || "完成",
      subtitle: end?.summary ? null : "flow 没有给一句话结果；结果在「结局」里。",
      action: null,
      select: END,
      needsYou: false,
    };
  }
  if (status === "stopped") {
    const reason = end?.stop?.reason || null;
    const where = end?.stop?.phase ? `在「${phaseTitle(run, end.stop.phase)}」` : "在阶段之外";
    return {
      tone: "warning",
      kicker: "停下",
      title: end?.summary || reason || "flow 停下了，没有说明原因",
      subtitle: `${end?.summary && reason ? `${reason}。` : ""}flow ${where}主动停下（$.stop），不是出错。`,
      action: null,
      select: END,
      needsYou: false,
    };
  }
  // failed, timeout
  const failed = calls.find((call) => call.end && !call.end.ok);
  const kicker = status === "timeout" ? "超时" : "失败";
  if (failed) {
    const cost = failed.end?.cost?.usd;
    const who = [failed.ask?.role, shortModel(failed.ask?.provider)].filter(Boolean).join(" · ");
    const spent = cost != null && failed.type === "ask" ? `，花了 ${formatUsd(cost)}` : "";
    return {
      tone: "danger",
      kicker,
      title: `「${callTitle(run, failed)}」没拿到结果：${failed.end?.error?.message || failed.end?.error?.name || "出错"}`,
      subtitle:
        end?.summary ||
        (failed.type === "ask"
          ? `${who}${spent}。重跑前可以先打开它看卡在哪。`
          : failed.type === "gate"
            ? "人闸自己出了错，不是有人拒绝。"
            : "脚本动作出错。"),
      action: agentAction(failed, "打开那个 agent"),
      select: failed.callId,
      needsYou: false,
    };
  }
  return {
    tone: "danger",
    kicker,
    title: end?.error ? `${end.error.name}：${end.error.message}` : status === "timeout" ? "超出了运行的总时限" : "运行失败",
    subtitle: end?.summary ?? null,
    action: null,
    select: END,
    needsYou: false,
  };
}

// ---- the list's phase strip -------------------------------------------------------------

export type StripState = VisitState | "pending" | "skipped";

/** One segment per declared phase, colored by its latest visit. */
export function phaseStrip(run: RunState, status: RunStatus): Array<{ title: string; state: StripState }> {
  const live = status === "running" || status === "starting";
  const visits = graphVisits(run);
  return run.phaseOrder.map((id) => {
    const phase = run.phases.get(id)!;
    const latest = visits.filter((visit) => visit.phase === id).at(-1);
    return { title: phase.title, state: latest ? visitState(latest, run, status) : live ? "pending" : "skipped" };
  });
}
