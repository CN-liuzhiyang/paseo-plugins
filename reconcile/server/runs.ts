import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunView } from "../shared/graph";
import { iso } from "./time";

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
// Honest limits: whether the process of an unfinished run is alive is answered by the claim alone (the
// runtime and orchestration-ui also look at the pid on the same machine, which shows a death sooner);
// a run whose process died reads as lost once its claim has gone stale, two minutes at most.

const CLAIM_FRESH_MS = 2 * 60_000;
/** Without a claim (an old file), a run is lost after this long without an event. */
const OLD_FILE_QUIET_MS = 15 * 60_000;
/** A run alive but with no event for this long is "maybe stuck"; a call with a longer timeout gets its timeout plus a margin. */
const QUIET_BASE_MS = 15 * 60_000;
const QUIET_MARGIN_MS = 5 * 60_000;
const SCAN_EVERY_MS = 3_000;
const HEAD_BYTES = 256 * 1024;
const CHUNK = 8 << 20;

export interface RunsDeps {
  runsDir: string;
  tz: string;
  now(): number;
  /** The plugin and screen an affair link must name to be this plugin's, and where a run's page is. */
  affair: { plugin: string; screen: string };
  view: { plugin: string; screen: string };
}

/** The same order the runtime and orchestration-ui use: ORCH_LOG_DIR, then the config file's logDir, then the default. */
export function resolveRunsDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const dir = (logDir: string) => path.join(logDir, "runs");
  if (env.ORCH_LOG_DIR) return dir(env.ORCH_LOG_DIR);
  const configHome = path.join(home, ".paseo-orchestration");
  const file = env.ORCH_CONFIG ?? path.join(configHome, "config.json");
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, "utf8");
      const value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as { logDir?: unknown };
      if (typeof value.logDir === "string" && value.logDir !== "") return dir(value.logDir);
    } catch {
      return null;
    }
  }
  return dir(path.join(configHome, "logs"));
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
  carrier: string | null;
  summary: string | null;
  agentId: string | null;
  end: { at: number; ok: boolean; error: { name: string; message: string } | null; usd: number; outcome: string | null } | null;
}

interface RunRec {
  runId: string;
  startedAt: number;
  flow: string;
  phases: Array<{ id: string; title: string }>;
  stage: string | null;
  caseId: string;
  phaseState: Map<string, "run" | "ok" | "bad">;
  calls: Map<string, CallRec>;
  lastAt: number;
  end: { outcome: string; summary: string | null; stop: string | null; error: { name: string; message: string } | null } | null;
}

const DURATION = /^(\d+)(s|m|h)$/;
const durationMs = (text: unknown): number | null => {
  const m = typeof text === "string" ? DURATION.exec(text) : null;
  return m ? Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"] : null;
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The item a run was started for, from `run.start.affair`; null for any other run. Not trusted: the file can be edited by anyone. */
export function caseOfStart(start: Record<string, unknown>, affair: RunsDeps["affair"]): { caseId: string; stage: string | null } | null {
  const link = obj(obj(start.affair)?.link);
  if (!link || link.plugin !== affair.plugin || link.screen !== affair.screen) return null;
  const params = obj(link.params);
  const caseId = str(params?.case);
  if (!caseId || caseId.length > 256 || /[\u0000-\u001f]/.test(caseId)) return null;
  const stage = str(params?.stage);
  return { caseId, stage: stage && stage.length <= 128 ? stage : null };
}

function fold(run: RunRec, e: Record<string, unknown>) {
  const at = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
  if (Number.isFinite(at)) run.lastAt = Math.max(run.lastAt, at);
  switch (e.kind) {
    case "phase.start":
      if (typeof e.phase === "string") run.phaseState.set(e.phase, "run");
      return;
    case "phase.end":
      if (typeof e.phase === "string") run.phaseState.set(e.phase, e.ok === false ? "bad" : "ok");
      return;
    case "call.start": {
      const id = str(e.callId);
      const type = e.type === "ask" || e.type === "do" || e.type === "gate" ? e.type : null;
      if (!id || !type) return;
      run.calls.set(id, {
        id,
        type,
        title: str(e.title) ?? str(e.name) ?? id,
        phase: str(e.phase),
        startedAt: Number.isFinite(at) ? at : run.startedAt,
        timeoutMs: durationMs(e.timeout),
        effects: str(e.effects),
        carrier: str(e.carrier),
        summary: str(e.summary),
        agentId: null,
        end: null,
      });
      return;
    }
    case "call.agent": {
      const call = run.calls.get(str(e.callId) ?? "");
      if (call && !call.agentId) call.agentId = str(e.agentId);
      return;
    }
    case "call.end": {
      const call = run.calls.get(str(e.callId) ?? "");
      if (!call || call.end) return;
      const error = obj(e.error);
      const cost = obj(e.cost);
      const output = obj(e.output);
      call.agentId ??= str(e.agentId);
      call.end = {
        at: Number.isFinite(at) ? at : call.startedAt,
        ok: e.ok === true,
        error: error ? { name: str(error.name) ?? "Error", message: str(error.message) ?? "" } : null,
        usd: typeof cost?.usd === "number" ? cost.usd : 0,
        outcome: call.type === "gate" ? str(output?.outcome) : null,
      };
      return;
    }
    case "run.end": {
      const stop = obj(e.stop);
      const error = obj(e.error);
      run.end = { outcome: str(e.outcome) ?? "failed", summary: str(e.summary), stop: str(stop?.reason), error: error ? { name: str(error.name) ?? "Error", message: str(error.message) ?? "" } : null };
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
const plainError = (e: { name: string; message: string }) => PLAIN[e.name] ?? (e.message ? `出错了：${e.message.split("\n")[0]!.slice(0, 120)}` : "出错了");

function viewOf(run: RunRec, claimMtime: number | null, deps: RunsDeps): RunView {
  const now = deps.now();
  const calls = [...run.calls.values()];
  const open = calls.filter((c) => !c.end);
  const gate = open.find((c) => c.type === "gate") ?? null;
  const ended = run.end !== null;
  // Alive is the claim's word; a file from before claims existed is read by how long it has been quiet.
  const alive = !ended && (claimMtime !== null ? now - claimMtime <= CLAIM_FRESH_MS : now - run.lastAt <= OLD_FILE_QUIET_MS);
  const limitMs = Math.max(QUIET_BASE_MS, ...open.map((c) => (c.timeoutMs ?? 0) + QUIET_MARGIN_MS));
  const quietMs = Math.max(0, now - run.lastAt);

  let situation: RunView["situation"];
  if (ended) situation = run.end!.outcome === "done" || run.end!.outcome === "stopped" ? "done" : "fail";
  else if (!alive) situation = "lost";
  else if (gate) situation = "me";
  else situation = quietMs > limitMs ? "slow" : "doing";

  const failedCall = [...calls].reverse().find((c) => c.end && !c.end.ok && c.end.error?.name !== "RunEnded");
  const errorSource = run.end?.error ?? failedCall?.end?.error ?? null;
  const error = situation === "fail" || situation === "lost" || situation === "slow" ? (errorSource ? { name: errorSource.name, plain: plainError(errorSource), raw: `${errorSource.name}: ${errorSource.message}`.slice(0, 500) } : null) : null;

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
    situation,
    outcome,
    step,
    steps,
    costUsd: done.reduce((sum, c) => sum + c.end!.usd, 0),
    quiet: ended ? null : { ms: quietMs, limitMs },
    gate: gate ? { callId: gate.id, summary: gate.summary || gate.title, since: iso(gate.startedAt, deps.tz), carrier: gate.carrier } : null,
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
}

export interface RunReader {
  /** The runs started for the item, newest first. */
  forCase(caseId: string): RunView[];
}

export function createRunReader(deps: RunsDeps): RunReader {
  const files = new Map<string, FileRec>();
  let scannedAt = -Infinity;

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
      }
      while (rec.offset < size) {
        let want = Math.min(CHUNK, size - rec.offset);
        let buffer: Buffer;
        let cut: number;
        for (;;) {
          buffer = Buffer.alloc(want);
          readSync(fd, buffer, 0, want, rec.offset);
          cut = buffer.lastIndexOf(0x0a);
          if (cut >= 0 || rec.offset + want >= size || want >= HEAD_BYTES * 8) break;
          want = Math.min(want * 2, size - rec.offset);
        }
        if (cut < 0) break;
        for (const line of buffer.subarray(0, cut + 1).toString("utf8").split("\n")) {
          if (line === "") continue;
          // Not this plugin's run: the rest of the file is not read.
          if (rec.owner === "none") break;
          let e: Record<string, unknown>;
          try {
            e = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (rec.owner === null) {
            // The first line of a run is its start.
            const owner = e.kind === "run.start" ? caseOfStart(e, deps.affair) : null;
            rec.owner = owner ?? "none";
            if (owner) {
              const flow = obj(e.flow);
              const phases = Array.isArray(flow?.phases) ? (flow!.phases as unknown[]).flatMap((p) => (obj(p) && typeof obj(p)!.id === "string" ? [{ id: obj(p)!.id as string, title: str(obj(p)!.title) ?? (obj(p)!.id as string) }] : [])) : [];
              const startedAt = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
              rec.run = {
                runId: file.replace(/\.jsonl$/, ""),
                startedAt: Number.isFinite(startedAt) ? startedAt : deps.now(),
                flow: str(flow?.name) ?? "（没有名字的流程）",
                phases,
                stage: owner.stage,
                caseId: owner.caseId,
                phaseState: new Map(),
                calls: new Map(),
                lastAt: Number.isFinite(startedAt) ? startedAt : deps.now(),
                end: null,
              };
            }
          } else if (rec.run) fold(rec.run, e);
        }
        rec.offset += cut + 1;
        if (rec.owner === "none") break;
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
    } catch {
      return;
    }
    for (const name of names) {
      let rec = files.get(name);
      if (!rec) files.set(name, (rec = { owner: null, run: null, offset: 0 }));
      // Another plugin's run, or one that has ended and been read: nothing more to learn from it.
      if (rec.owner === "none" || rec.run?.end) continue;
      readNew(name, rec);
    }
    for (const name of files.keys()) if (!names.includes(name)) files.delete(name);
  }

  return {
    forCase(caseId) {
      scan();
      const out: RunView[] = [];
      for (const [name, rec] of files) {
        if (!rec.run || rec.run.caseId !== caseId) continue;
        let mtime: number | null = null;
        if (!rec.run.end) {
          try {
            mtime = statSync(path.join(deps.runsDir, name.replace(/\.jsonl$/, ".claim"))).mtimeMs;
          } catch {
            mtime = null;
          }
        }
        out.push(viewOf(rec.run, mtime, deps));
      }
      return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
  };
}
