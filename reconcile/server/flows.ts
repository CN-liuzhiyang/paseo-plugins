import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { LauncherConfig, Policy } from "./config";
import type { FlowEnd, FlowRec, FlowResult, FlowState } from "../shared/model";
import type { RunProbe } from "./runs";
import { localParts } from "./time";
import { cleanText, hasUnsafe } from "./untrusted";

// Flows started for items. A rule asks for a run (output `run`), the engine records the intent first and
// starts the runtime's `orch.mjs run` as a detached process after, and reads what the runtime writes -- its
// claim and its events -- to know how it stands. Nothing here calls a model; what the run costs the flow spends.
//
// Three things keep a run from being started or paid for twice: the intent is on disk before the process is
// started (after a restart the engine knows it asked), the run id is made from what was asked for (the same
// request is always the same id), and the runtime takes the id with an exclusive create before it spends
// anything (a second process asked for the same id ends there). This file is the pure part: ids, limits, the
// table of what to do with a run in each state, and how a process is started.

/** The runtime's `RUN_ID` (orchestration/runtime/claim.mjs): what an id given with --run-id may look like. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const RUN_ID_LIMIT = 128;

/** Keys in the order of their names: the same input however it was written. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Which input a run was asked for with: the same input, written in another order, is the same. */
export const inputHashOf = (input: unknown): string => sha256(canonical(input)).slice(0, 16);

/**
 * The id of a run: made from what was asked for, so that the same request is always the same id.
 * `rc-<instance>-<12 hex>`, with `-r<round>` after the first round.
 */
export function runIdOf(instanceId: string, caseId: string, name: string, flow: string, key: string, round: number): string {
  const instance = instanceId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 24) || "x";
  const id = `rc-${instance}-${sha256(`${caseId}\0${name}\0${flow}\0${key}\0${round}`).slice(0, 12)}${round > 0 ? `-r${round}` : ""}`;
  if (!RUN_ID.test(id) || id.length > RUN_ID_LIMIT) throw new Error(`not a run id: ${id}`);
  return id;
}

// ---- limits ------------------------------------------------------------------------------------------

export type FlowLimits = Policy["flows"];

/** The day of an instant in the instance's zone. */
const dayOf = (iso: string, tz: string) => localParts(Date.parse(iso), tz).date;

/** What a finished run counts for in a budget: what it cost, and at least its ceiling when what it cost is not all known. */
export const costOf = (end: Pick<FlowEnd, "costUsd" | "costUnknown">, maxUsd: number): number => (end.costUnknown ? Math.max(end.costUsd, maxUsd) : end.costUsd);

/**
 * Why one more run may not be started now, in words; null when it may. `recs`: every run the controller knows,
 * `ahead`: the ones asked for earlier in this round whose intents are not written yet. The number of runs in a day is by the
 * instance's local date of their intents. What a day spent is what it was told: a run not over holds its ceiling whichever day it
 * began, and one that ended counts for the day it was recorded to have (when its cost became known), so a run that crosses midnight
 * is never counted as nothing. Concurrency is not a day's matter either: it frees as runs end.
 */
export function limitWhy(recs: FlowRec[], ahead: FlowRec[], limits: FlowLimits, ask: { caseId: string; maxUsd: number }, nowMs: number, tz: string): { why: string; until: "tomorrow" | "later" } | null {
  const today = localParts(nowMs, tz).date;
  const all = [...recs, ...ahead];
  const mine = all.filter((r) => dayOf(r.intentAt, tz) === today);
  if (mine.length >= limits.perDay) return { why: `今天流程已经起了 ${mine.length} 次（上限 ${limits.perDay}）`, until: "tomorrow" };
  const ofCase = mine.filter((r) => r.caseId === ask.caseId).length;
  if (ofCase >= limits.perCasePerDay) return { why: `这个事项今天流程已经起了 ${ofCase} 次（上限 ${limits.perCasePerDay}）`, until: "tomorrow" };
  // Finished (today) at what they cost, the others at the most they were counted at.
  const spent = all.reduce((sum, r) => sum + (r.ended ? (dayOf(r.ended.at, tz) === today ? costOf(r.ended, r.maxUsd) : 0) : r.maxUsd), 0);
  if (spent + ask.maxUsd > limits.usdPerDay) return { why: `今天流程花费已到 $${spent.toFixed(2)}（上限 $${limits.usdPerDay}），再起一个按 $${ask.maxUsd} 算会超`, until: "tomorrow" };
  const open = all.filter((r) => !r.ended).length;
  if (open >= limits.concurrent) return { why: `同时在跑的流程已经有 ${open} 个（上限 ${limits.concurrent}）`, until: "later" };
  return null;
}

// ---- what to do with a run ---------------------------------------------------------------------------

/** How long a state that may be a pause (a machine asleep) is looked at before it is taken for what it says. */
export const SUSPECT_MS = 30_000;
/** A run that stopped beating and wrote lines that could not be read is looked at this long before it is told as lost: what it says is not all there. */
export const UNREAD_SUSPECT_MS = 15 * 60_000;
/** A run id is started again (nothing came of the first start) at most this many extra times. */
export const MAX_RESTARTS = 2;
/** A failed start (the program did not run at all) is tried again at most this many times in all. */
export const MAX_SPAWN_FAILURES = 3;

export type Live = "starting" | "running" | "gate" | "slow";

export type Act =
  /** Nothing to do yet; `live` is how it stands for the page and the rule. */
  | { kind: "wait"; live: Live }
  /** Start the process (again), under the same run id. */
  | { kind: "launch" }
  /** It is over, or will never be: the record to write. */
  | { kind: "end"; end: Omit<FlowEnd, "at"> };

const endOf = (outcome: FlowEnd["outcome"], why: string, costUsd = 0, costKnown = true): Act => ({ kind: "end", end: { outcome, summary: null, costUsd, ...(costKnown ? {} : { costUnknown: true }), value: null, valueDropped: false, why } });

/**
 * The table: given a run the controller meant to start and what the runtime's files say of it, what to do.
 * `suspectSince`: when this state was first seen to be a doubtful one (a stale claim before the run began,
 * or a run that stopped beating) -- it is taken for real only when seen again after SUSPECT_MS. `suspect`
 * in the answer asks the caller to remember that moment.
 */
export function actFor(rec: FlowRec, probe: RunProbe, suspectSince: number | null, nowMs: number): { act: Act; suspect: boolean } {
  const calm = (act: Act) => ({ act, suspect: false });
  const sureAfter = (ms: number) => suspectSince !== null && nowMs - suspectSince >= ms;
  const sure = sureAfter(SUSPECT_MS);
  const started = rec.spawnedAt !== undefined;
  switch (probe.state) {
    case "ended": {
      const end = probe.end!;
      const outcome = end.outcome === "done" || end.outcome === "stopped" || end.outcome === "timeout" ? end.outcome : "failed";
      const why = outcome === "done" ? null : outcome === "stopped" ? (end.stop ?? "中止了") : outcome === "timeout" ? "超过了这次流程的总时限" : (end.error ? `${end.error.name}：${end.error.headline || end.error.message}`.slice(0, 300) : "失败了");
      return calm({
        kind: "end",
        end: {
          outcome,
          summary: end.summary,
          costUsd: probe.costUsd,
          ...(probe.costKnown ? {} : { costUnknown: true }),
          ...(Number.isFinite(end.at) && end.at > 0 ? { completedAt: new Date(end.at).toISOString() } : {}),
          value: end.value,
          valueDropped: end.valueDropped,
          why,
        },
      });
    }
    case "refused":
      return calm(endOf("refused", `运行时拒绝了：${probe.refused ?? "没有说原因"}`));
    case "pending":
      return calm({ kind: "wait", live: "starting" });
    case "absent": {
      // Not started yet (the intent is written, the process was not): start it. Started, and nothing has come of it
      // for long enough: start it again under the same id, which the runtime lets only one process hold.
      if (!started) return calm({ kind: "launch" });
      // Nothing is to be seen because the directory cannot be read, not because nothing ran: not a reason to start it again.
      if (!probe.reachable) return calm({ kind: "wait", live: "slow" });
      if (!probe.safeToRestart) return calm({ kind: "wait", live: "starting" });
      const restarts = (rec.spawnTries ?? 1) - 1;
      return restarts < MAX_RESTARTS ? calm({ kind: "launch" }) : calm(endOf("not-started", `起了 ${restarts + 1} 次，运行时一直没有出现`));
    }
    case "starting":
    case "unreadable":
      return calm({ kind: "wait", live: "starting" });
    case "dead-before-start":
    case "stalled-before-start":
      // Nothing was spent, and the runtime does not say it is safe to start again: it may have been asleep. Seen twice, then it is told.
      return sure ? calm(endOf("not-started", "运行时没走到开跑，占位就过期了；没有花钱")) : { act: { kind: "wait", live: "starting" }, suspect: true };
    case "lost": {
      // Lines it wrote could not be read: the silence may be a run that finished or went on in them, and what it spent is not all known.
      // A longer look, and then told as it is: broken, with its cost taken as at least the ceiling it was given.
      const partial = probe.unread > 0;
      if (!sureAfter(partial ? UNREAD_SUSPECT_MS : SUSPECT_MS)) return { act: { kind: "wait", live: "slow" }, suspect: true };
      const spent = probe.costUsd > 0 ? `；已花 $${probe.costUsd.toFixed(2)}${probe.costKnown ? "" : "（读到的部分）"}` : "";
      return calm(endOf("lost", `失联：心跳停了，之后再没有动静${partial ? "；它写的事件里有读不全的行，花了多少不知道" : ""}${spent}`, probe.costUsd, probe.costKnown));
    }
    case "running":
      return calm({ kind: "wait", live: probe.gate ? "gate" : probe.slow ? "slow" : "running" });
  }
}

/**
 * A flow that stops on purpose (`$.stop`) and says in its value that it did not get done what it was for -- `value.why`, a
 * sentence -- is a run that did not come to a result, however cleanly it ended ("could not reach the data, not looked at
 * this time"). The engine reads only that one field: a stop with no `why` (absent, empty, not a text) is a finished one,
 * as is every other outcome. Returns the sentence, cleaned for a line; null for any run that is not such a stop. A value
 * too large to be kept (`valueDropped`) is not there to be read: that stop reads as finished.
 */
export function unfinishedWhy(end: Pick<FlowEnd, "outcome" | "value">): string | null {
  if (end.outcome !== "stopped") return null;
  const value = end.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const why = cleanText((value as Record<string, unknown>).why, 300);
  // Only marks ("。", "...") is no sentence: it says nothing, so it is not a reason to call the run unfinished.
  return why !== null && /[\p{L}\p{N}]/u.test(why) ? why : null;
}

/**
 * A sentence of the flow's for a place that may draw Markdown or tags (a message): what makes a link, a tag or code is put in its
 * full-width form, so that it reads the same and is not drawn as one (a backslash would show as it is where nothing is drawn).
 */
const plainForMessage = (text: string): string =>
  text.replace(/[\[\]<>`]/g, (c) => ({ "[": "［", "]": "］", "<": "＜", ">": "＞", "`": "｀" })[c]!);

/** What a rule is told of a run. */
export function resultOf(rec: FlowRec, live: Live | null): FlowResult {
  const ended = rec.ended;
  // What the runtime's files say it is wins over the record of the start (which a failed write may have left out).
  const state: FlowState = rec.dismissed ? "dismissed" : ended ? ended.outcome : (live ?? (rec.spawnedAt ? "starting" : "queued"));
  return {
    state,
    runId: rec.runId,
    round: rec.round,
    startedAt: rec.spawnedAt ?? null,
    endedAt: ended ? (ended.completedAt ?? ended.at) : null,
    value: ended?.outcome === "done" || ended?.outcome === "stopped" ? ended.value : null,
    summary: ended?.summary ?? null,
    costUsd: ended?.costUsd ?? 0,
    why: ended?.why ?? null,
    endedOutcome: rec.dismissed ? (ended?.outcome ?? null) : null,
  };
}

/** What a rule is told of a request that was held back for now (no run exists). */
export const deferredResult = (why: string): FlowResult => ({ state: "deferred", runId: null, round: 0, startedAt: null, endedAt: null, value: null, summary: null, costUsd: 0, why, endedOutcome: null });

/** The word for a run that is not over and the controller reads as in trouble ("fail" is the runtime's, not this). */
export const WAITING_ON_YOU: ReadonlySet<FlowResult["state"]> = new Set(["failed", "timeout", "lost", "not-started", "refused"]);

// ---- telling a person --------------------------------------------------------------------------------

/** What a run that did not come to a result says, in a sentence. */
export function plainWhy(end: Pick<FlowEnd, "outcome" | "why">): string {
  switch (end.outcome) {
    case "lost":
      return "流程中途断了";
    case "not-started":
      return "流程没起来";
    case "refused":
      return "流程被运行时拒了";
    case "timeout":
      return "流程超时了";
    case "failed":
      return "流程失败了";
    default:
      return "流程没跑完";
  }
}

/** The one message for a run that ended: the rule's label, and the flow's own summary or why it did not come to a result. */
export function endedMessage(rec: Pick<FlowRec, "label" | "caseId">, end: FlowEnd): { title: string; text: string; status: "succeeded" | "failed" } {
  const number = `#${rec.caseId.slice(rec.caseId.lastIndexOf(":") + 1)}`;
  const unfinished = unfinishedWhy(end);
  // A stop that says it did not get done what it was for is read as that, in the flow's own words: not looked at this time, not "done".
  if (unfinished !== null) return { title: `${rec.label}没跑完`, text: `${number} ${rec.label}没跑完：${plainForMessage(cleanText(unfinished, 200) ?? unfinished).replace(/[。.]+$/u, "")}。详情在「事项追踪」里。`, status: "failed" };
  if (end.outcome === "done" || end.outcome === "stopped") {
    return { title: `${rec.label}好了`, text: `${number} ${rec.label}好了：${end.summary ?? (end.outcome === "done" ? "完成了" : "中止了")}。详情在「事项追踪」里。`, status: "succeeded" };
  }
  return { title: `${rec.label}没跑完`, text: `${number} ${rec.label}没跑完：${plainWhy(end)}${end.why ? `（${cleanText(end.why, 120)}）` : ""}，要自己看。`, status: "failed" };
}

// ---- the affair a run is for -------------------------------------------------------------------------

/** What `--affair` is given (orchestration/runtime/affair.mjs): the label, the item's address when it has a plain one, and the item's page. */
export function affairOf(rec: Pick<FlowRec, "caseId" | "stage" | "label">, url: string | null, screen: { plugin: string; screen: string }): Record<string, unknown> {
  const label = cleanText(rec.label, 120) ?? rec.caseId.slice(0, 120);
  const plain = url !== null && url.length <= 2048 && /^https?:\/\/[^\s/@]+(\/|$)/.test(url) && !hasUnsafe(url) ? url : null;
  const params: Record<string, string> = { case: rec.caseId.slice(0, 256) };
  if (rec.stage && !hasUnsafe(rec.stage)) params.stage = rec.stage.slice(0, 256);
  return { label, ...(plain ? { url: plain } : {}), link: { plugin: screen.plugin, screen: screen.screen, params } };
}

// ---- starting the process ----------------------------------------------------------------------------

export interface LaunchSpec {
  runId: string;
  /** The flow, by name: the runtime finds where it lives. */
  flow: string;
  timeout: string | null;
  /** Files the controller wrote for the run: its input, its affair, and where the runner's own output goes. */
  inputFile: string;
  affairFile: string;
  outFile: string;
  /** The runtime's log directory the process is told to use (ORCH_LOG_DIR), the one the run is read back from; null or absent: whatever it resolves itself. */
  logDir?: string | null;
}

export interface Launcher {
  /** Starts the runtime for the run, detached; resolves when the process exists, rejects when it could not be started. */
  start(spec: LaunchSpec): Promise<{ pid: number | null }>;
}

/**
 * The real one: `<command> run <flow> --run-id … --affair @… --input @… [--timeout …]`, no shell, no window, its own
 * process (not the plugin's child to wait for, nor killed with it: a plugin reload leaves the run going).
 */
export function createLauncher(config: LauncherConfig): Launcher {
  return {
    start(spec) {
      const [file, ...prefix] = config.command;
      const args = [...prefix, "run", spec.flow, "--run-id", spec.runId, "--affair", `@${spec.affairFile}`, "--input", `@${spec.inputFile}`, ...(spec.timeout ? ["--timeout", spec.timeout] : [])];
      return new Promise((resolve, reject) => {
        let out: number;
        try {
          out = openSync(spec.outFile, "a");
        } catch (error) {
          reject(error);
          return;
        }
        let child: ReturnType<typeof spawn>;
        try {
          // The log directory is told, not left to be resolved again by the process: the run's id is taken in a directory, and
          // the controller reads that one (a config that changed between would put the same id in two places).
          const env = spec.logDir ? { ...process.env, ORCH_LOG_DIR: spec.logDir } : process.env;
          child = spawn(file!, args, { shell: false, windowsHide: true, detached: true, stdio: ["ignore", out, out], env, ...(config.cwd ? { cwd: config.cwd } : {}) });
        } catch (error) {
          closeSync(out);
          reject(error);
          return;
        }
        child.once("error", (error) => {
          closeSync(out);
          reject(error);
        });
        child.once("spawn", () => {
          closeSync(out);
          child.unref();
          resolve({ pid: child.pid ?? null });
        });
      });
    },
  };
}

/** A launcher that only records what it was asked (the preview's, and tests'). */
export function recordingLauncher(): Launcher & { started: LaunchSpec[] } {
  const started: LaunchSpec[] = [];
  return {
    started,
    async start(spec) {
      started.push(spec);
      return { pid: null };
    },
  };
}
