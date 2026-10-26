import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME_SCREEN, RUN_SCREEN, type RunView } from "../shared/graph";
import { classify, parseDuration, pidFact, STALE_BASE_MS, staleAfterMs, type Probe, type RunState } from "../shared/liveness.mjs";
import { FLOW_VALUE_BYTES } from "../shared/model";
import { iso } from "./time";
import { agentIdOf, cleanText, hasUnsafe } from "./untrusted";

// The runs of flows started for an item, read from what the orchestration runtime writes
// (orchestration/EVENTS.md): one `<runsDir>/<runId>.jsonl` per run, and a `<runId>.claim` beside it
// whose modification time says whether the run is alive. Nothing here starts, stops or changes a run.
//
// Which item a run belongs to is what the caller put in `--affair` when it started the run: a link
// to this plugin's screen with `case` (and, when it knows, `stage`) among its params. No other
// connection is read. The reader does not depend on the runtime's code (a plugin cannot): it follows
// the contract, so what the contract adds later is ignored until this learns it, and what it leaves out
// of old files is read as the contract says.
//
// Whether a run is alive is not decided here: it is the runtime's own table, `shared/liveness.mjs`, a copy of
// orchestration/runtime/liveness.mjs made by `npm run sync:liveness` there, and the same facts the runtime reads
// (the claim's age and content, the holder's pid on the same machine) go into it.
//
// What the files say is not trusted (anyone who can write the log directory can write them): every text shown is
// cut and cleaned (untrusted.ts), an agent is opened only by an id that looks like one, and a file is read for as
// long as it takes to see whether it is this plugin's, and then only in bounded pieces.

const SCAN_EVERY_MS = 3_000;
/** The first line of a run, `run.start`, is read within this much; a file whose first line is longer is not ours. */
const HEAD_BYTES = 256 * 1024;
/** A line longer than this is not read: only its head is looked at (see passOver). */
const MAX_LINE = 4 << 20;
/** How much of the head of such a line is looked at: the runtime's fixed keys come first, a runId is at most 128 characters. */
const HEAD_OF_LINE = 1024;
const END_HEAD = /^\{"v":\d+,"seq":\d+,"ts":"([^"\\]{1,40})","runId":"[^"\\]{1,128}","kind":"run\.end","outcome":"(done|stopped|failed|timeout)"/;
/** Runs that have not been written to for this long are not read: a page shows what is recent. */
const RECENT_MS = 60 * 86_400_000;
/** What one run may cost in memory, however many events its file has. */
const MAX_CALLS = 2_000;
const MAX_PHASES = 200;

export interface RunsDeps {
  runsDir: string;
  tz: string;
  now(): number;
  /** The plugin and screen an affair link must name to be this plugin's, and where a run's page is. */
  affair: { plugin: string; screen: string };
  view: { plugin: string; screen: string };
  /** Whether a pid exists, on this machine; absent: asks the system. */
  probe?: Probe;
}

const localProbe = (): Probe => ({ hostname: os.hostname(), kill: (pid, signal) => process.kill(pid, signal) });

/**
 * The log directory, in the same order the runtime and orchestration-ui use: ORCH_LOG_DIR, then the config file's logDir, then
 * the default. Absolute: a run started under it is read from it later, whatever this process's working directory is then.
 */
export function resolveLogDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  if (env.ORCH_LOG_DIR) return path.resolve(env.ORCH_LOG_DIR);
  const configHome = path.join(home, ".paseo-orchestration");
  const file = env.ORCH_CONFIG ?? path.join(configHome, "config.json");
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, "utf8");
      const value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as { logDir?: unknown };
      if (typeof value.logDir === "string" && value.logDir !== "") return path.resolve(value.logDir);
    } catch {
      return null;
    }
  }
  return path.join(configHome, "logs");
}

export function resolveRunsDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const logDir = resolveLogDir(env, home);
  return logDir === null ? null : path.join(logDir, "runs");
}

// ---- reading the events ---------------------------------------------------------------------------

interface CallRec {
  id: string;
  type: "ask" | "do" | "gate";
  title: string;
  phase: string | null;
  startedAt: number;
  timeoutMs: number | null;
  effects: string | null;
  /** What kind of carrier a gate has (EVENTS.md): "provider" or "model". */
  carrier: string | null;
  summary: string | null;
  agentId: string | null;
  end: { at: number; ok: boolean; error: RunError | null; usd: number; outcome: string | null } | null;
}

interface RunRec {
  runId: string;
  startedAt: number;
  flow: string;
  phases: Array<{ id: string; title: string }>;
  stage: string | null;
  caseId: string;
  /** Who ran it, as run.start says: asked about when the run has no claim. */
  holder: { pid?: unknown; hostname?: unknown };
  phaseState: Map<string, "run" | "ok" | "bad">;
  calls: Map<string, CallRec>;
  lastAt: number;
  /** Lines too long to read that were not known by their head: what they said is missing from everything above. */
  unread: number;
  /** Calls that began after as many were kept as are (MAX_CALLS): their cost is missing from the sum. */
  skipped: number;
  /** `totalUsd` is the run.end's own sum of what the run cost (cost.totalUsd), null when the line did not give one or was not read. */
  end: { at: number; outcome: string; summary: string | null; stop: string | null; error: RunError | null; value: unknown; valueDropped: boolean; totalUsd: number | null } | null;
}

/** An error as the runtime reports it, cleaned: the whole message, and its first line for the plain sentence. */
interface RunError {
  name: string;
  message: string;
  headline: string;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const errorOf = (v: unknown): RunError | null => {
  const e = obj(v);
  return e ? { name: cleanText(e.name, 60) ?? "Error", message: cleanText(e.message, 300) ?? "", headline: cleanText(str(e.message)?.split("\n")[0], 120) ?? "" } : null;
};

/** The item a run was started for, from `run.start.affair`; null for any other run. Not trusted: the file can be edited by anyone. */
export function caseOfStart(start: Record<string, unknown>, affair: RunsDeps["affair"]): { caseId: string; stage: string | null } | null {
  const link = obj(obj(start.affair)?.link);
  if (!link || link.plugin !== affair.plugin || link.screen !== affair.screen) return null;
  const params = obj(link.params);
  const caseId = str(params?.case);
  if (!caseId || caseId.length > 256 || hasUnsafe(caseId)) return null;
  const stage = str(params?.stage);
  return { caseId, stage: stage && stage.length <= 128 && !hasUnsafe(stage) ? stage : null };
}

/** A run's result as far as it is kept: the value, or that it was past FLOW_VALUE_BYTES. */
function valueWithin(value: unknown): { value: unknown; dropped: boolean } {
  if (value === null) return { value: null, dropped: false };
  try {
    const text = JSON.stringify(value);
    if (text !== undefined && Buffer.byteLength(text, "utf8") <= FLOW_VALUE_BYTES) return { value: JSON.parse(text) as unknown, dropped: false };
  } catch {
    // not JSON-able: dropped like one that is too large
  }
  return { value: null, dropped: true };
}

function fold(run: RunRec, e: Record<string, unknown>) {
  const at = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
  if (Number.isFinite(at)) run.lastAt = Math.max(run.lastAt, at);
  switch (e.kind) {
    case "phase.start":
      if (typeof e.phase === "string" && (run.phaseState.has(e.phase) || run.phaseState.size < MAX_PHASES)) run.phaseState.set(e.phase, "run");
      return;
    case "phase.end":
      if (typeof e.phase === "string" && (run.phaseState.has(e.phase) || run.phaseState.size < MAX_PHASES)) run.phaseState.set(e.phase, e.ok === false ? "bad" : "ok");
      return;
    case "call.start": {
      const id = str(e.callId);
      const type = e.type === "ask" || e.type === "do" || e.type === "gate" ? e.type : null;
      if (!id || !type || id.length > 128) return;
      if (!run.calls.has(id) && run.calls.size >= MAX_CALLS) {
        run.skipped += 1;
        return;
      }
      run.calls.set(id, {
        id,
        type,
        title: cleanText(e.title) ?? cleanText(e.name) ?? cleanText(id) ?? "（没有名字的调用）",
        phase: str(e.phase),
        startedAt: Number.isFinite(at) ? at : run.startedAt,
        timeoutMs: parseDuration(str(e.timeout)),
        effects: str(e.effects),
        carrier: str(e.carrier),
        summary: cleanText(e.summary, 200),
        agentId: null,
        end: null,
      });
      return;
    }
    case "call.agent": {
      const call = run.calls.get(str(e.callId) ?? "");
      if (call && !call.agentId) call.agentId = agentIdOf(e.agentId);
      return;
    }
    case "call.end": {
      const call = run.calls.get(str(e.callId) ?? "");
      if (!call || call.end) return;
      const cost = obj(e.cost);
      const output = obj(e.output);
      call.agentId ??= agentIdOf(e.agentId);
      call.end = {
        at: Number.isFinite(at) ? at : call.startedAt,
        ok: e.ok === true,
        error: errorOf(e.error),
        usd: typeof cost?.usd === "number" && Number.isFinite(cost.usd) && cost.usd >= 0 ? cost.usd : 0,
        outcome: call.type === "gate" ? cleanText(output?.outcome, 40) : null,
      };
      return;
    }
    case "run.end": {
      const stop = obj(e.stop);
      // What the flow returned is kept up to a bound (a rule is handed it); past that only that it was too large.
      const value = e.value === undefined ? null : e.value;
      const kept = valueWithin(value);
      const total = obj(e.cost)?.totalUsd;
      run.end = { at: Number.isFinite(at) ? at : run.lastAt, outcome: cleanText(e.outcome, 40) ?? "failed", summary: cleanText(e.summary, 200), stop: cleanText(stop?.reason, 120), error: errorOf(e.error), value: kept.value, valueDropped: kept.dropped, totalUsd: typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null };
    }
  }
}

// ---- the view -------------------------------------------------------------------------------------

/** What an error name from the runtime means to a person. The raw one stays beside it. */
const PLAIN: Record<string, string> = {
  OutputMismatch: "agent 的回答不合约定的格式，这一步没拿到结果",
  RunTimeout: "超过了这次流程的总时限",
  PaseoCliError: "调用 Paseo 失败了（起 agent 或读它的状态时出错）",
  RunEnded: "流程结束的时候这一步还没做完",
  RunRefused: "流程没有起来：被拒绝了",
};
const plainError = (e: RunError) => PLAIN[e.name] ?? (e.headline ? `出错了：${e.headline}` : "出错了");

/** What the claim beside a run says: its age, and who holds it; null for a run without one. */
interface ClaimRead {
  mtimeMs: number;
  body: { pid?: unknown; hostname?: unknown; refused?: unknown } | null;
}

/** Who holds the run: whoever the claim names; what it does not say (or a claim that cannot be read) falls back to run.start. */
const holderOf = (body: ClaimRead["body"], run: Pick<RunRec, "holder">): { pid?: unknown; hostname?: unknown } => ({
  pid: typeof body?.pid === "number" ? body.pid : run.holder.pid,
  hostname: typeof body?.hostname === "string" ? body.hostname : run.holder.hostname,
});

function viewOf(run: RunRec, claim: ClaimRead | null, deps: RunsDeps, probe: Probe): RunView {
  const now = deps.now();
  const calls = [...run.calls.values()];
  const open = calls.filter((c) => !c.end);
  const gate = open.find((c) => c.type === "gate") ?? null;
  const ended = run.end !== null;
  const quietMs = Math.max(0, now - run.lastAt);
  const limitMs = staleAfterMs({ baseMs: STALE_BASE_MS, lastEventAtMs: run.lastAt, openCalls: open.map((c) => ({ startedAtMs: c.startedAt, timeoutMs: c.timeoutMs })) });

  // The runtime's own table, with the facts it reads: the claim's age and word, and whether the holder's pid is gone.
  const verdict = ended
    ? "ended"
    : classify({
        claim: claim ? { ageMs: now - claim.mtimeMs, refused: typeof claim.body?.refused === "string", unreadable: claim.body === null } : null,
        events: "open",
        pid: pidFact(holderOf(claim?.body ?? null, run), probe),
        quietMs,
      }).state;

  let situation: RunView["situation"];
  if (ended) situation = run.end!.outcome === "done" || run.end!.outcome === "stopped" ? "done" : "fail";
  else if (verdict === "refused") situation = "fail";
  // Something it wrote is missing here (a line too long to read): a quiet claim may be a run that is over, an open gate
  // may be one that was answered. Not told as a break or as waiting for you; told as it is.
  else if (run.unread > 0) situation = "unreadable";
  else if (verdict === "lost") situation = "lost";
  else if (gate) situation = "me";
  else situation = quietMs > limitMs ? "slow" : "doing";

  const failedCall = [...calls].reverse().find((c) => c.end && !c.end.ok && c.end.error?.name !== "RunEnded");
  const errorSource = run.end?.error ?? failedCall?.end?.error ?? (verdict === "refused" ? { name: "RunRefused", message: "", headline: "" } : null);
  const error = situation === "fail" || situation === "lost" || situation === "slow" ? (errorSource ? { name: errorSource.name, plain: plainError(errorSource), raw: `${errorSource.name}: ${errorSource.message}`.slice(0, 300) } : null) : null;

  const stateOfPhase = (id: string): RunView["steps"][number] => {
    const s = run.phaseState.get(id);
    if (s === "ok") return "ok";
    if (s === "bad") return "bad";
    if (s === "run") return situation === "lost" ? "lost" : situation === "slow" ? "slow" : gate && gate.phase === id ? "wait" : situation === "fail" || situation === "done" ? "bad" : "run";
    return ended && situation === "done" ? "skip" : "todo";
  };
  const steps = run.phases.map((p) => stateOfPhase(p.id));
  const currentAt = (() => {
    const running = run.phases.findIndex((p) => run.phaseState.get(p.id) === "run");
    if (running >= 0) return running;
    for (let i = run.phases.length - 1; i >= 0; i--) if (run.phaseState.has(run.phases[i]!.id)) return i;
    return -1;
  })();
  const step = currentAt >= 0 ? { index: currentAt + 1, total: run.phases.length, title: run.phases[currentAt]!.title } : null;

  const done = calls.filter((c) => c.end);
  // What already changed something outside: an agent allowed to write, a script's own action, a gate that let something through.
  const sideEffects = done
    .filter((c) => (c.type === "ask" && c.effects === "workspace") || (c.type === "do" && c.end!.ok) || (c.type === "gate" && c.end!.outcome === "allowed"))
    .map((c) => c.title.slice(0, 80));

  const end = run.end;
  const outcome = end ? (end.summary ?? (end.outcome === "done" ? "完成了" : end.outcome === "stopped" ? (end.stop ? `中止了：${end.stop}` : "中止了") : end.outcome === "timeout" ? "超过了总时限" : (error?.plain ?? "失败了"))) : null;

  return {
    runId: run.runId,
    stage: run.stage,
    flow: run.flow,
    startedAt: iso(run.startedAt, deps.tz),
    endedAt: end ? iso(end.at, deps.tz) : null,
    situation,
    unreadLines: run.unread,
    outcome,
    step,
    steps,
    costUsd: done.reduce((sum, c) => sum + c.end!.usd, 0),
    quiet: ended ? null : { ms: quietMs, limitMs },
    gate: gate ? { callId: gate.id, summary: gate.summary || gate.title, since: iso(gate.startedAt, deps.tz), kind: gate.carrier === "provider" || gate.carrier === "model" ? gate.carrier : null, agentId: gate.agentId } : null,
    error,
    stopReason: end?.stop ?? null,
    sideEffects,
    agentId: ended ? null : ((gate ?? [...open].reverse().find((c) => c.agentId))?.agentId ?? null),
    link: { plugin: deps.view.plugin, screen: deps.view.screen, params: { run: run.runId } },
    retry: null,
  };
}

// ---- the reader -----------------------------------------------------------------------------------

interface FileRec {
  /** Null while the first line is not complete yet; then the item the run belongs to, or "none". */
  owner: { caseId: string; stage: string | null } | "none" | null;
  run: RunRec | null;
  offset: number;
  /** Inside a line that was too long: what is left of it is passed over. */
  skipping: boolean;
}

/** What the runtime's files say of one run, by its id: its state in the runtime's own table, and what of it was read. */
export interface RunProbe {
  state: RunState;
  /** The table's word on starting it again under the same id: true in one case only (nothing came of a start long enough ago). */
  safeToRestart: boolean;
  /** Why the runner refused the id, when it did. */
  refused: string | null;
  /** The run as the page shows it, once its run.start has been read; null before. */
  view: RunView | null;
  /** The run.end, when there is one. */
  end: NonNullable<RunRec["end"]> | null;
  /** What the run cost: the run.end's own total when it gave one, else what the calls that ended cost. */
  costUsd: number;
  /**
   * Whether `costUsd` is all of it: not when lines of the events were too long to read, or calls were past the number kept, and the
   * run.end gave no total to go by. The money is spent either way; a budget must not count it as nothing.
   */
  costKnown: boolean;
  /** Lines of the run's events that were too long to read: what they said (a call's cost, a gate) is not in what was read. */
  unread: number;
  /** The directory the runs are read from could be listed (a directory that is not there yet is nothing to list, not trouble). */
  reachable: boolean;
  /** A gate is open: it waits for a person. */
  gate: boolean;
  /** Long quiet for a run that is alive. */
  slow: boolean;
}

export interface RunReader {
  /** The runs started for the item, newest first. */
  forCase(caseId: string): RunView[];
  /**
   * One run by its id, whoever it was started for: the runtime's table over its claim and events, with `spawnedAtMs`
   * (when this controller started its process; null if it does not know) to tell "just started" from "never came up".
   */
  probe(runId: string, spawnedAtMs: number | null): RunProbe;
}

/** The first line of a file: its text, "wait" while it is not written to the end, "long" when it does not end within the head. */
function firstLine(fd: number, size: number): { text: string; length: number } | "wait" | "long" {
  const want = Math.min(size, HEAD_BYTES);
  const buffer = Buffer.alloc(want);
  readSync(fd, buffer, 0, want, 0);
  const cut = buffer.indexOf(0x0a);
  if (cut >= 0) return { text: buffer.subarray(0, cut).toString("utf8"), length: cut + 1 };
  return size > HEAD_BYTES ? "long" : "wait";
}

export function createRunReader(deps: RunsDeps): RunReader {
  const files = new Map<string, FileRec>();
  const probe = deps.probe ?? localProbe();
  let scannedAt = -Infinity;
  /** Whether the last look at the directory could list it: a missing directory can (it has no runs), an unreadable one cannot. */
  let reachable = true;

  function startOf(file: string, rec: FileRec, line: string) {
    let e: Record<string, unknown>;
    try {
      e = obj(JSON.parse(line)) ?? {};
    } catch {
      e = {};
    }
    // The first line of a run is its start.
    const owner = e.kind === "run.start" ? caseOfStart(e, deps.affair) : null;
    rec.owner = owner ?? "none";
    if (!owner) return;
    const flow = obj(e.flow);
    const phases = Array.isArray(flow?.phases)
      ? (flow!.phases as unknown[]).slice(0, MAX_PHASES).flatMap((p) => (obj(p) && typeof obj(p)!.id === "string" && (obj(p)!.id as string).length <= 128 ? [{ id: obj(p)!.id as string, title: cleanText(obj(p)!.title, 80) ?? cleanText(obj(p)!.id, 80) ?? "—" }] : []))
      : [];
    const startedAt = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
    rec.run = {
      runId: file.replace(/\.jsonl$/, ""),
      startedAt: Number.isFinite(startedAt) ? startedAt : deps.now(),
      flow: cleanText(flow?.name, 80) ?? "（没有名字的流程）",
      phases,
      stage: owner.stage,
      caseId: owner.caseId,
      holder: { pid: e.pid, hostname: e.hostname },
      phaseState: new Map(),
      calls: new Map(),
      lastAt: Number.isFinite(startedAt) ? startedAt : deps.now(),
      unread: 0,
      skipped: 0,
      end: null,
    };
  }

  /**
   * A line too long to be read whole is still not passed over unseen: its head says what it is, in the shape the runtime
   * writes (runtime/events.mjs: v, seq, ts, runId, kind, then the event's own fields, `outcome` first in run.end).
   * A run.end is known by that, and the run is over however big its `value` is. Any other is counted, and what the
   * run says about itself is then not all there: the view says so (`unreadable`) instead of reading the gap as an end,
   * a break or a stop.
   */
  function passOver(run: RunRec, head: Buffer) {
    const m = END_HEAD.exec(head.toString("utf8", 0, HEAD_OF_LINE));
    if (!m) {
      run.unread += 1;
      return;
    }
    const at = Date.parse(m[1]!);
    run.lastAt = Math.max(run.lastAt, Number.isFinite(at) ? at : 0);
    run.end = { at: Number.isFinite(at) ? at : run.lastAt, outcome: m[2]!, summary: null, stop: null, error: null, value: null, valueDropped: true, totalUsd: null };
  }

  function readNew(file: string, rec: FileRec) {
    const full = path.join(deps.runsDir, file);
    let fd: number;
    try {
      fd = openSync(full, "r");
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < rec.offset) {
        // Not an append: read it all again.
        rec.offset = 0;
        rec.run = null;
        rec.owner = null;
        rec.skipping = false;
      }
      if (rec.owner === null) {
        // Whether the file is ours is the first line's answer, and only that much is read to get it.
        const first = firstLine(fd, size);
        if (first === "wait") return;
        if (first === "long") {
          rec.owner = "none";
          return;
        }
        startOf(file, rec, first.text);
        rec.offset = first.length;
      }
      if (rec.owner === "none") return;
      while (rec.offset < size) {
        const want = Math.min(MAX_LINE, size - rec.offset);
        const buffer = Buffer.alloc(want);
        readSync(fd, buffer, 0, want, rec.offset);
        if (rec.skipping) {
          const end = buffer.indexOf(0x0a);
          rec.offset += end < 0 ? want : end + 1;
          if (end >= 0) rec.skipping = false;
          continue;
        }
        const cut = buffer.lastIndexOf(0x0a);
        if (cut < 0) {
          // No end of line in a whole piece: a line too long to be read, whose rest is passed over after its head is looked at. Less than a piece: still being written.
          if (want < MAX_LINE) break;
          if (rec.run) passOver(rec.run, buffer);
          rec.skipping = true;
          rec.offset += want;
          continue;
        }
        for (const line of buffer.subarray(0, cut + 1).toString("utf8").split("\n")) {
          if (line === "" || !rec.run) continue;
          try {
            const e = obj(JSON.parse(line));
            if (e) fold(rec.run, e);
          } catch {
            // A line that is not json says nothing.
          }
        }
        rec.offset += cut + 1;
      }
    } finally {
      closeSync(fd);
    }
  }

  function scan() {
    const now = deps.now();
    if (now - scannedAt < SCAN_EVERY_MS) return;
    scannedAt = now;
    let names: string[];
    try {
      names = readdirSync(deps.runsDir).filter((n) => n.endsWith(".jsonl"));
      reachable = true;
    } catch (error) {
      reachable = (error as NodeJS.ErrnoException).code === "ENOENT";
      return;
    }
    const present = new Set(names);
    for (const name of names) {
      let rec = files.get(name);
      if (!rec) {
        rec = { owner: null, run: null, offset: 0, skipping: false };
        files.set(name, rec);
        // A file nobody has written to for long is history: not read, and not looked at again.
        try {
          if (now - statSync(path.join(deps.runsDir, name)).mtimeMs > RECENT_MS) rec.owner = "none";
        } catch {
          continue;
        }
      }
      // Another plugin's run, or one that has ended and been read: nothing more to learn from it.
      if (rec.owner === "none" || rec.run?.end) continue;
      readNew(name, rec);
    }
    for (const name of files.keys()) if (!present.has(name)) files.delete(name);
  }

  function claimOf(name: string): ClaimRead | null {
    const file = path.join(deps.runsDir, name.replace(/\.jsonl$/, ".claim"));
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return null;
    }
    try {
      const body = obj(JSON.parse(readFileSync(file, "utf8")));
      return { mtimeMs, body };
    } catch {
      // Being written, or not json: the table calls that "unreadable" and treats it as alive while it is fresh.
      return { mtimeMs, body: null };
    }
  }

  return {
    probe(runId, spawnedAtMs) {
      scan();
      const name = `${runId}.jsonl`;
      const run = files.get(name)?.run ?? null;
      const claim = run?.end ? null : claimOf(name);
      const now = deps.now();
      const verdict = run?.end
        ? { state: "ended" as RunState, safeToRestart: false }
        : classify({
            claim: claim ? { ageMs: now - claim.mtimeMs, refused: typeof claim.body?.refused === "string", unreadable: claim.body === null } : null,
            events: run ? "open" : "none",
            pid: pidFact(holderOf(claim?.body ?? null, run ?? { holder: {} }), probe),
            quietMs: run ? Math.max(0, now - run.lastAt) : 0,
            spawnedAgoMs: spawnedAtMs === null ? null : now - spawnedAtMs,
          });
      const view = run ? viewOf(run, claim, deps, probe) : null;
      return {
        state: verdict.state,
        safeToRestart: verdict.safeToRestart,
        refused: typeof claim?.body?.refused === "string" ? cleanText(claim.body.refused, 300) : null,
        view,
        end: run?.end ?? null,
        // What the runtime itself added up when it ended is the surest figure; the calls that were read are the least that was spent.
        costUsd: Math.max(run?.end?.totalUsd ?? 0, view?.costUsd ?? 0),
        costKnown: !run || run.end?.totalUsd != null || (run.unread === 0 && run.skipped === 0),
        unread: run?.unread ?? 0,
        reachable,
        gate: view?.gate != null,
        slow: view?.situation === "slow",
      };
    },
    forCase(caseId) {
      scan();
      const out: RunView[] = [];
      for (const [name, rec] of files) {
        if (!rec.run || rec.run.caseId !== caseId) continue;
        out.push(viewOf(rec.run, rec.run.end ? null : claimOf(name), deps, probe));
      }
      return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    },
  };
}

/**
 * Readers by log directory. A run is read where it was started (the directory its intent fixed), not where the config points
 * now: `forDir` makes the reader of a directory once, and `current` is the one the page lists runs from.
 */
export function createRunReaders(base: Omit<RunsDeps, "runsDir">, currentLogDir: string): { current: RunReader; forDir(logDir: string): RunReader } {
  const readers = new Map<string, RunReader>();
  const forDir = (logDir: string): RunReader => {
    const key = path.resolve(logDir);
    let reader = readers.get(key);
    if (!reader) {
      reader = createRunReader({ ...base, runsDir: path.join(key, "runs") });
      readers.set(key, reader);
    }
    return reader;
  };
  return { current: forDir(currentLogDir), forDir };
}

/**
 * What the plugin gives the engine to show and start flows, made once when it loads from the machine's config: the log directory (absolute,
 * for new runs), the runs of an item for its page (from that directory), and a probe that reads one run by its id from the directory its
 * intent fixed. Null when the config names no log directory that can be found.
 */
export function createRunsWiring(opts: { tz: string; now(): number; log(message: string): void; env?: NodeJS.ProcessEnv; home?: string }): {
  logDir: string;
  runs(caseId: string): RunView[];
  probe(runId: string, spawnedAtMs: number | null, logDir: string | null): RunProbe;
} | null {
  const logDir = resolveLogDir(opts.env, opts.home);
  if (logDir === null) return null;
  const readers = createRunReaders({ tz: opts.tz, now: opts.now, affair: HOME_SCREEN, view: RUN_SCREEN }, logDir);
  return {
    logDir,
    runs: (caseId) => {
      try {
        return readers.current.forCase(caseId);
      } catch (error) {
        opts.log(`reading the runs of ${caseId} failed: ${(error as Error).message}`);
        return [];
      }
    },
    probe: (runId, spawnedAtMs, runLogDir) => readers.forDir(runLogDir ?? logDir).probe(runId, spawnedAtMs),
  };
}
