// A run as orchestration/EVENTS.md (v1) describes it, folded from its event stream.
//
// Pure and runtime-neutral: the daemon folds a file to summarize it for the list, the app folds
// the same events for the detail view, and both must agree on what a run's state is. Unknown
// kinds and unknown fields are ignored, as the contract requires; a line that breaks a known
// kind's shape is kept as a problem rather than guessed at.

export type Outcome = "done" | "stopped" | "failed" | "timeout";
/**
 * `running` and `lost` are both "no run.end": which one depends on how long the file has been
 * quiet (see staleAfterMs). `starting` is a file whose first line is not complete yet.
 */
export type RunStatus = Outcome | "running" | "lost" | "starting";

export interface ErrorInfo {
  name: string;
  message: string;
}

export interface Fence {
  mode: string | null;
  enforced: boolean;
  note: string;
}

export interface Cost {
  usd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface PhaseDecl {
  id: string;
  title: string;
}

export interface Flow {
  name: string;
  description: string;
  phases: PhaseDecl[];
  inputs: unknown;
  grants: string[];
}

export interface RunStart {
  flow: Flow;
  source: string | null;
  input: unknown;
  caller: string | null;
  cwd: string | null;
  host: string | null;
  /** The runtime's process and machine; absent in files written before they were added. */
  pid: number | null;
  hostname: string | null;
}

export interface RunEnd {
  at: string;
  outcome: Outcome;
  value: unknown;
  stop: { reason: string; phase: string | null } | null;
  error: ErrorInfo | null;
  durationMs: number | null;
  cost: { totalUsd: number | null; agentCount: number | null; partial: string | null } | null;
  caveats: string[];
  /** Newer runtimes: the flow's own one-line result. */
  summary: string | null;
}

export interface AskInfo {
  role: string | null;
  provider: string;
  thinking: string | null;
  effects: string | null;
  fence: Fence | null;
  prompt: string | null;
  schema: unknown;
  schemaFingerprint: string | null;
  timeout: string | null;
  /** Newer runtimes: which output field is the call's one line. */
  headline: string | null;
}

export interface GateInfo {
  brief: string | null;
  content: string | null;
  sha256: string | null;
  timeout: string | null;
  /** Where the carrier agent writes, the path the person sees on the card. */
  holdPath: string | null;
  provider: string | null;
  fence: Fence | null;
}

export interface CallEnd {
  at: string;
  ok: boolean;
  durationMs: number | null;
  output: unknown;
  error: ErrorInfo | null;
  agentId: string | null;
  cost: Cost | null;
}

export type CallType = "ask" | "do" | "gate";

export interface CallState {
  callId: string;
  /** `null` for a call.end whose call.start was never seen. */
  type: CallType | null;
  name: string;
  title: string;
  phase: string | null;
  /** Which entry into its phase this call belongs to, from 1; 0 outside a phase. */
  round: number;
  /** Index into run.visits of the phase visit that was open when the call began; null outside one. */
  visit: number | null;
  /** Position in the stream when this call was first seen, to order it against phase visits. */
  order: number;
  startedAt: string | null;
  ask: AskInfo | null;
  gate: GateInfo | null;
  end: CallEnd | null;
  /** From call.agent while the call runs, or from call.end. */
  agentId: string | null;
  caveats: string[];
}

export interface PhaseState {
  id: string;
  title: string;
  /** False for a phase that events name but run.start did not declare. */
  declared: boolean;
  starts: number;
  ends: number;
  failedEnds: number;
  firstStartAt: string | null;
  lastStartAt: string | null;
  lastEndAt: string | null;
  callIds: string[];
}

/** One phase.start…phase.end: a phase entered n times has n visits. */
export interface PhaseVisit {
  phase: string;
  /** Which entry into the phase this is, from 1. */
  round: number;
  startedAt: string;
  endedAt: string | null;
  ok: boolean | null;
  callIds: string[];
  order: number;
}

export interface LogEntry {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface Caveat {
  callId: string | null;
  text: string;
}

export interface RunState {
  runId: string | null;
  start: RunStart | null;
  startedAt: string | null;
  lastEventAt: string | null;
  lastSeq: number | null;
  eventCount: number;
  phaseOrder: string[];
  phases: Map<string, PhaseState>;
  visits: PhaseVisit[];
  /** Per phase, the visits entered and not yet left, innermost last. */
  openVisits: Map<string, number[]>;
  callOrder: string[];
  calls: Map<string, CallState>;
  caveats: Caveat[];
  logs: LogEntry[];
  end: RunEnd | null;
  /** Lines that broke the contract. Shown to the reader, never fatal. */
  problems: string[];
  /** Kinds this reader does not know, with counts. Ignored by contract; counted for honesty. */
  unknownKinds: Record<string, number>;
}

const MAX_PROBLEMS = 50;

export function createRun(): RunState {
  return {
    runId: null,
    start: null,
    startedAt: null,
    lastEventAt: null,
    lastSeq: null,
    eventCount: 0,
    phaseOrder: [],
    phases: new Map(),
    visits: [],
    openVisits: new Map(),
    callOrder: [],
    calls: new Map(),
    caveats: [],
    logs: [],
    end: null,
    problems: [],
    unknownKinds: {},
  };
}

// ---- tolerant field readers -------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function errorOf(value: unknown): ErrorInfo | null {
  if (!isObj(value)) return null;
  return { name: str(value.name) ?? "Error", message: str(value.message) ?? "" };
}
function costOf(value: unknown): Cost | null {
  if (!isObj(value)) return null;
  return { usd: num(value.usd), inputTokens: num(value.inputTokens), outputTokens: num(value.outputTokens) };
}
function fenceOf(value: unknown): Fence | null {
  if (!isObj(value)) return null;
  return { mode: str(value.mode), enforced: value.enforced === true, note: str(value.note) ?? "" };
}
function flowOf(value: unknown): Flow {
  const flow = isObj(value) ? value : {};
  const phases = Array.isArray(flow.phases)
    ? flow.phases.flatMap((phase): PhaseDecl[] => {
        if (!isObj(phase) || str(phase.id) === null) return [];
        return [{ id: phase.id as string, title: str(phase.title) ?? (phase.id as string) }];
      })
    : [];
  return {
    name: str(flow.name) ?? "(未命名 flow)",
    description: str(flow.description) ?? "",
    phases,
    inputs: flow.inputs ?? null,
    grants: Array.isArray(flow.grants) ? flow.grants.filter((grant): grant is string => typeof grant === "string") : [],
  };
}

// ---- folding ----------------------------------------------------------------------------

function problem(run: RunState, text: string): void {
  if (run.problems.length < MAX_PROBLEMS) run.problems.push(text);
  else if (run.problems.length === MAX_PROBLEMS) run.problems.push("……更多问题不再列出");
}

function phaseFor(run: RunState, id: string, at: string | null): PhaseState {
  let phase = run.phases.get(id);
  if (!phase) {
    phase = {
      id,
      title: id,
      declared: false,
      starts: 0,
      ends: 0,
      failedEnds: 0,
      firstStartAt: null,
      lastStartAt: null,
      lastEndAt: null,
      callIds: [],
    };
    run.phases.set(id, phase);
    run.phaseOrder.push(id);
    if (run.start) problem(run, `${at ?? "?"}：阶段「${id}」没有在 run.start.flow.phases 里声明`);
  }
  return phase;
}

function callFor(run: RunState, callId: string): CallState {
  let call = run.calls.get(callId);
  if (!call) {
    call = {
      callId,
      type: null,
      name: callId,
      title: callId,
      phase: null,
      round: 0,
      visit: null,
      order: run.eventCount,
      startedAt: null,
      ask: null,
      gate: null,
      end: null,
      agentId: null,
      caveats: [],
    };
    run.calls.set(callId, call);
    run.callOrder.push(callId);
  }
  return call;
}

/** Fold one parsed line into the run. Anything not an object is a problem, not a crash. */
export function applyEvent(run: RunState, raw: unknown): void {
  if (!isObj(raw)) {
    problem(run, "有一行不是 JSON 对象");
    return;
  }
  const kind = str(raw.kind);
  const ts = str(raw.ts);
  const seq = num(raw.seq);
  if (kind === null || ts === null) {
    problem(run, `第 ${seq ?? "?"} 条事件缺少 kind 或 ts`);
    return;
  }
  if (raw.v !== 1) {
    // A newer version changed meanings; show it rather than silently mis-read it.
    problem(run, `第 ${seq ?? "?"} 条事件的契约版本是 ${JSON.stringify(raw.v)}，这里只认识 v1`);
  }
  if (seq !== null && run.lastSeq !== null && seq !== run.lastSeq + 1) {
    problem(run, `事件序号从 ${run.lastSeq} 跳到 ${seq}`);
  }
  if (seq !== null) run.lastSeq = seq;
  run.eventCount += 1;
  run.lastEventAt = ts;
  if (run.runId === null) run.runId = str(raw.runId);

  switch (kind) {
    case "run.start": {
      if (run.start) {
        problem(run, `第 ${seq ?? "?"} 条事件是第二个 run.start，已忽略`);
        return;
      }
      if (run.eventCount !== 1) problem(run, "run.start 不是第一条事件");
      const flow = flowOf(raw.flow);
      run.start = {
        flow,
        source: str(raw.source),
        input: raw.input ?? null,
        caller: str(raw.caller),
        cwd: str(raw.cwd),
        host: str(raw.host),
        pid: num(raw.pid),
        hostname: str(raw.hostname),
      };
      run.startedAt = ts;
      // Declared phases come first, in declared order, even the ones never entered.
      const seen = run.phaseOrder;
      run.phaseOrder = [];
      for (const decl of flow.phases) {
        const existing = run.phases.get(decl.id);
        if (existing) {
          existing.title = decl.title;
          existing.declared = true;
        } else {
          run.phases.set(decl.id, {
            id: decl.id,
            title: decl.title,
            declared: true,
            starts: 0,
            ends: 0,
            failedEnds: 0,
            firstStartAt: null,
            lastStartAt: null,
            lastEndAt: null,
            callIds: [],
          });
        }
        run.phaseOrder.push(decl.id);
      }
      for (const id of seen) if (!run.phaseOrder.includes(id)) run.phaseOrder.push(id);
      return;
    }
    case "phase.start":
    case "phase.end": {
      const id = str(raw.phase);
      if (id === null) {
        problem(run, `第 ${seq ?? "?"} 条 ${kind} 没有 phase`);
        return;
      }
      const phase = phaseFor(run, id, ts);
      const open = run.openVisits.get(id) ?? [];
      run.openVisits.set(id, open);
      if (kind === "phase.start") {
        phase.starts += 1;
        phase.firstStartAt ??= ts;
        phase.lastStartAt = ts;
        open.push(run.visits.length);
        run.visits.push({ phase: id, round: phase.starts, startedAt: ts, endedAt: null, ok: null, callIds: [], order: run.eventCount });
      } else {
        phase.ends += 1;
        phase.lastEndAt = ts;
        if (raw.ok === false) phase.failedEnds += 1;
        const visit = open.pop();
        if (visit === undefined) problem(run, `${ts}：阶段「${id}」没有开着就结束了`);
        else Object.assign(run.visits[visit]!, { endedAt: ts, ok: raw.ok === true });
      }
      return;
    }
    case "call.start": {
      const callId = str(raw.callId);
      if (callId === null) {
        problem(run, `第 ${seq ?? "?"} 条 call.start 没有 callId`);
        return;
      }
      if (run.calls.get(callId)?.startedAt) problem(run, `调用 ${callId} 开始了两次`);
      const call = callFor(run, callId);
      const type = str(raw.type);
      call.type = type === "ask" || type === "do" || type === "gate" ? type : null;
      if (call.type === null) problem(run, `调用 ${callId} 的类型「${type ?? ""}」不认识`);
      call.name = str(raw.name) ?? callId;
      call.title = str(raw.title) ?? call.name;
      call.startedAt = ts;
      const phaseId = str(raw.phase);
      call.phase = phaseId;
      if (phaseId !== null) {
        const phase = phaseFor(run, phaseId, ts);
        phase.callIds.push(callId);
        call.round = Math.max(phase.starts, 1);
        // The innermost visit of that phase still open; none when the phase was not entered.
        const visit = run.openVisits.get(phaseId)?.at(-1);
        if (visit !== undefined) {
          call.visit = visit;
          call.round = run.visits[visit]!.round;
          run.visits[visit]!.callIds.push(callId);
        }
      }
      if (call.type === "ask") {
        call.ask = {
          role: str(raw.role),
          provider: str(raw.provider) ?? "?",
          thinking: str(raw.thinking),
          effects: str(raw.effects),
          fence: fenceOf(raw.fence),
          prompt: str(raw.prompt),
          schema: raw.schema ?? null,
          schemaFingerprint: str(raw.schemaFingerprint),
          timeout: str(raw.timeout),
          headline: str(raw.headline),
        };
      } else if (call.type === "gate") {
        call.gate = {
          brief: str(raw.brief),
          content: str(raw.content),
          sha256: str(raw.sha256),
          timeout: str(raw.timeout),
          holdPath: str(raw.holdPath),
          provider: str(raw.provider),
          fence: fenceOf(raw.fence),
        };
      }
      return;
    }
    case "call.agent": {
      const callId = str(raw.callId);
      const agentId = str(raw.agentId);
      if (callId === null || agentId === null) {
        problem(run, `第 ${seq ?? "?"} 条 call.agent 缺少 callId 或 agentId`);
        return;
      }
      if (!run.calls.has(callId)) problem(run, `调用 ${callId} 没有 call.start 就有了 call.agent`);
      const call = callFor(run, callId);
      if (call.agentId !== null) problem(run, `调用 ${callId} 有不止一条 call.agent`);
      if (call.end) problem(run, `调用 ${callId} 的 call.agent 在 call.end 之后`);
      call.agentId = agentId;
      return;
    }
    case "call.end": {
      const callId = str(raw.callId);
      if (callId === null) {
        problem(run, `第 ${seq ?? "?"} 条 call.end 没有 callId`);
        return;
      }
      if (!run.calls.has(callId)) problem(run, `调用 ${callId} 没有 call.start 就结束了`);
      const call = callFor(run, callId);
      if (call.end) problem(run, `调用 ${callId} 结束了两次`);
      call.end = {
        at: ts,
        ok: raw.ok === true,
        durationMs: num(raw.durationMs),
        output: raw.output ?? null,
        error: errorOf(raw.error),
        agentId: str(raw.agentId),
        cost: costOf(raw.cost),
      };
      call.agentId ??= call.end.agentId;
      return;
    }
    case "caveat": {
      const text = str(raw.text);
      if (text === null) return;
      const callId = str(raw.callId);
      run.caveats.push({ callId, text });
      if (callId !== null) callFor(run, callId).caveats.push(text);
      return;
    }
    case "log": {
      const level = str(raw.level);
      run.logs.push({
        at: ts,
        level: level === "warn" || level === "error" ? level : "info",
        message: str(raw.message) ?? "",
      });
      return;
    }
    case "run.end": {
      if (run.end) problem(run, "run.end 出现了两次，以后一次为准");
      const outcome = str(raw.outcome);
      const known: Outcome[] = ["done", "stopped", "failed", "timeout"];
      if (!known.includes(outcome as Outcome)) {
        problem(run, `run.end 的结局「${outcome ?? ""}」不认识，按失败显示`);
      }
      const stop = isObj(raw.stop) ? { reason: str(raw.stop.reason) ?? "", phase: str(raw.stop.phase) } : null;
      const cost = isObj(raw.cost)
        ? { totalUsd: num(raw.cost.totalUsd), agentCount: num(raw.cost.agentCount), partial: str(raw.cost.partial) }
        : null;
      run.end = {
        at: ts,
        outcome: known.includes(outcome as Outcome) ? (outcome as Outcome) : "failed",
        value: raw.value ?? null,
        stop,
        error: errorOf(raw.error),
        durationMs: num(raw.durationMs),
        cost,
        caveats: Array.isArray(raw.caveats) ? raw.caveats.filter((c): c is string => typeof c === "string") : [],
        summary: str(raw.summary),
      };
      return;
    }
    default:
      run.unknownKinds[kind] = (run.unknownKinds[kind] ?? 0) + 1;
  }
}

export function foldEvents(events: readonly unknown[], run: RunState = createRun()): RunState {
  for (const event of events) applyEvent(run, event);
  return run;
}

// ---- derived views ----------------------------------------------------------------------

export function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/**
 * Durations as the runtime writes them in `timeout`. The contract does not fix a format, so this
 * accepts what people write ("90s", "30m", "1h30m", "500ms", "2d") and a bare number of
 * milliseconds; anything else is `null` and the caller falls back to its default.
 */
export function parseDuration(text: string | null): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const unit: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const parts = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== trimmed.replace(/\s+/g, "")) return null;
  return parts.reduce((sum, part) => sum + Number(part[1]) * unit[part[2]], 0);
}

export function openCalls(run: RunState): CallState[] {
  return run.callOrder.map((id) => run.calls.get(id)!).filter((call) => call.startedAt !== null && call.end === null);
}

/** Grace on top of an open call's own timeout: the runtime needs a moment to write call.end. */
export const STALE_GRACE_MS = 2 * 60_000;

/**
 * How long a run without run.end may stay quiet before it reads as lost. A run that is waiting
 * on a call is quiet for as long as that call may legitimately take, so an open call with a
 * readable timeout raises the bar to that timeout; otherwise the configured base applies.
 */
export function staleAfterMs(run: RunState, baseMs: number): number {
  let limit = baseMs;
  for (const call of openCalls(run)) {
    const timeout = parseDuration(call.ask?.timeout ?? call.gate?.timeout ?? null);
    const started = ms(call.startedAt);
    const last = ms(run.lastEventAt);
    if (timeout === null || started === null || last === null) continue;
    // Measured from the last event, like the base: the call may time out this far after it began.
    limit = Math.max(limit, started + timeout + STALE_GRACE_MS - last);
  }
  return limit;
}

/**
 * Whether the runtime's process still exists, as the daemon found it. Only the daemon on the
 * run's own machine can look; `null` means nobody could, and the quiet-time threshold decides.
 */
export interface ProcessCheck {
  pid: number;
  alive: boolean;
}

export function runStatus(run: RunState, now: number, baseMs: number, proc: ProcessCheck | null = null): RunStatus {
  if (run.end) return run.end.outcome;
  if (!run.start) return "starting";
  // A process that is gone will never write run.end; one that is there is still running, however quiet.
  if (proc) return proc.alive ? "running" : "lost";
  const last = ms(run.lastEventAt);
  if (last === null) return "lost";
  return now - last > staleAfterMs(run, baseMs) ? "lost" : "running";
}

export type PhaseStatus =
  | "pending" // run still going, phase not entered yet
  | "skipped" // run over, phase never entered
  | "running"
  | "done"
  | "failed" // a phase.end with ok:false
  | "stopped" // run.end.stop.phase names it
  | "interrupted"; // entered, never left, and the run is over or lost

export function phaseStatus(run: RunState, phase: PhaseState, status: RunStatus): PhaseStatus {
  const over = status !== "running" && status !== "starting";
  if (run.end?.outcome === "stopped" && run.end.stop?.phase === phase.id) return "stopped";
  const entered = phase.starts > 0 || phase.callIds.length > 0;
  if (!entered) return over ? "skipped" : "pending";
  if (phase.failedEnds > 0) return "failed";
  const open = phase.starts > phase.ends || phase.callIds.some((id) => run.calls.get(id)?.end === null);
  if (open) return over ? "interrupted" : "running";
  return "done";
}

export type CallStatus = "running" | "ok" | "error" | "interrupted";

export function callStatus(call: CallState, status: RunStatus): CallStatus {
  if (call.end) return call.end.ok ? "ok" : "error";
  return status === "running" || status === "starting" ? "running" : "interrupted";
}

/** Gate verdict fields, read as loosely as the rest. */
export interface GateVerdict {
  outcome: string | null;
  approved: boolean | null;
  by: string | null;
  waitedMs: number | null;
  reason: string | null;
  askedAt: string | null;
  decidedAt: string | null;
  agentReport: unknown;
  agentStatusAtDecision: string | null;
  sha256: string | null;
}

export function gateVerdict(call: CallState): GateVerdict | null {
  const output = call.end?.output;
  if (!isObj(output)) return null;
  return {
    outcome: str(output.outcome),
    approved: typeof output.approved === "boolean" ? output.approved : null,
    by: str(output.by),
    waitedMs: num(output.waitedMs),
    reason: str(output.reason),
    askedAt: str(output.askedAt),
    decidedAt: str(output.decidedAt),
    agentReport: output.agentReport ?? null,
    agentStatusAtDecision: str(output.agentStatusAtDecision),
    sha256: str(output.sha256),
  };
}

export function providerFamily(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return provider.split("/")[0] ?? null;
}

/** Codex agents report a cost of 0: it was not counted, not free. */
export function costUncounted(call: CallState): boolean {
  return call.end !== null && providerFamily(call.ask?.provider) === "codex" && (call.end.cost?.usd ?? 0) === 0;
}

/** What the calls ended so far cost; the only figure there is before run.end. */
export function costSoFar(run: RunState): { usd: number; uncounted: number } {
  let usd = 0;
  let uncounted = 0;
  for (const call of run.calls.values()) {
    if (call.type !== "ask") continue;
    if (costUncounted(call) || (call.end && call.end.cost?.usd == null)) uncounted += 1;
    else usd += call.end?.cost?.usd ?? 0;
  }
  return { usd, uncounted };
}

/** Some finished Codex call reported the 0 that means "not counted". */
export function hasUncountedCodex(run: RunState): boolean {
  for (const call of run.calls.values()) if (costUncounted(call)) return true;
  return false;
}

/** Deduplicated caveats: run.end's list once it exists, otherwise what has been reported. */
export function caveatsOf(run: RunState): string[] {
  if (run.end && run.end.caveats.length > 0) return run.end.caveats;
  return [...new Set(run.caveats.map((caveat) => caveat.text))];
}

export function phaseTitle(run: RunState, id: string | null): string | null {
  if (id === null) return null;
  return run.phases.get(id)?.title ?? id;
}
