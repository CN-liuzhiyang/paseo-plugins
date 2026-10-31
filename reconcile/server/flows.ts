import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { LauncherConfig, Policy } from "./config";
import { CHECK_FAILED_WORDS, LINE_BUSY_WORDS, settleShort } from "../shared/graph";
import type { FlowEnd, FlowRec, FlowResult, FlowState, ResumeOffer } from "../shared/model";
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

/** A run that ended refused or not started at a known $0: nothing ran. */
export const ranNothing = (r: Pick<FlowRec, "ended">): boolean => r.ended !== undefined && (r.ended.outcome === "refused" || r.ended.outcome === "not-started") && r.ended.costUsd === 0 && !r.ended.costUnknown;

/** The day of an instant in the instance's zone. */
const dayOf = (iso: string, tz: string) => localParts(Date.parse(iso), tz).date;

/** What a finished run counts for in a budget: what it cost, and at least its ceiling when what it cost is not all known. */
export const costOf = (end: Pick<FlowEnd, "costUsd" | "costUnknown">, maxUsd: number): number => (end.costUnknown ? Math.max(end.costUsd, maxUsd) : end.costUsd);

/**
 * Why one more run may not be started now, in words; null when it may. `recs`: every run the controller knows,
 * `ahead`: the ones asked for earlier in this round whose intents are not written yet. The number of runs in a day is by the
 * instance's local date of their intents. What a day spent is what it was told: a run not over holds its ceiling whichever day it
 * began, and one that ended counts for the day it was recorded to have (when its cost became known), so a run that crosses midnight
 * is never counted as nothing. Concurrency is not a day's matter either: it frees as runs end. A run that ended refused or not started at a known
 * $0 is not one of the day's runs: nothing ran (10-30 a refused run took the item's one run of the day and held the person's retry). `byPerson`:
 * a person asked for it again by hand, so the item's own count does not hold it; the day's count, money and concurrency still do.
 */
export function limitWhy(recs: FlowRec[], ahead: FlowRec[], limits: FlowLimits, ask: { caseId: string; maxUsd: number; flow: string; title?: string; byPerson?: boolean }, nowMs: number, tz: string): { why: string; until: "tomorrow" | "later"; limit: NonNullable<FlowResult["limit"]> } | null {
  const today = localParts(nowMs, tz).date;
  // A flow with limits of its own is counted against those only, and in no one else's: the runs of the flows that have none are counted
  // against the general ones. Each side is its own room, so that neither can fill the other's.
  const byFlow = limits.byFlow ?? {};
  const own = Object.hasOwn(byFlow, ask.flow) ? byFlow[ask.flow] : undefined;
  const scope = (r: FlowRec) => (own ? r.flow === ask.flow : !Object.hasOwn(byFlow, r.flow));
  const lim = own ? { perDay: own.perDay, usdPerDay: own.usdPerDay, perCasePerDay: own.perCasePerDay ?? 4, concurrent: own.concurrent ?? 1 } : limits;
  // Named as people name it when the rule gave the flow a title.
  const what = own ? (ask.title ? `「${ask.title}」` : `「${ask.flow}」流程`) : "流程";
  const all = [...recs, ...ahead].filter(scope);
  const mine = all.filter((r) => dayOf(r.intentAt, tz) === today && !ranNothing(r));
  if (mine.length >= lim.perDay) return { why: `今天${what}已经起了 ${mine.length} 次（上限 ${lim.perDay}）`, until: "tomorrow", limit: "perDay" };
  const ofCase = mine.filter((r) => r.caseId === ask.caseId).length;
  if (!ask.byPerson && ofCase >= lim.perCasePerDay) return { why: `这个事项今天${what}已经起了 ${ofCase} 次（上限 ${lim.perCasePerDay}）`, until: "tomorrow", limit: "perCase" };
  // Finished (today) at what they cost, the others at the most they were counted at.
  const spent = all.reduce((sum, r) => sum + (r.ended ? (dayOf(r.ended.at, tz) === today ? costOf(r.ended, r.maxUsd) : 0) : r.maxUsd), 0);
  if (spent + ask.maxUsd > lim.usdPerDay) return { why: `今天${what}花费已到 $${spent.toFixed(2)}（上限 $${lim.usdPerDay}），再起一个按 $${ask.maxUsd} 算会超`, until: "tomorrow", limit: "usd" };
  const open = all.filter((r) => !r.ended).length;
  if (open >= lim.concurrent) return { why: `同时在跑的${what}已经有 ${open} 个（上限 ${lim.concurrent}）`, until: "later", limit: "concurrent" };
  return null;
}

/** What a person who pressed a button is told when the day's limits say no: how long to wait, not which limit. */
export const blockedText = (blocked: { until: "tomorrow" | "later" }): string => (blocked.until === "tomorrow" ? "今天的额度用完了，明天再点" : "已经有一个在跑，等它停了再点");

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
          // What it said about being carried on, for a run that did not come out whole (a finished one has none to give, and the runtime writes it as nothing).
          ...(outcome !== "done" && probe.resume ? { resume: probe.resume } : {}),
          ...(outcome === "stopped" && end.settle ? { settle: end.settle } : {}),
          ...(outcome === "stopped" && end.stopKind ? { stopKind: end.stopKind } : {}),
        },
      });
    }
    case "refused":
      // The line of runs still has a call out: not a failure, only too early, and the way to carry on stays as it was.
      if (LINE_BUSY.test(probe.refused ?? "")) return calm({ kind: "end", end: { outcome: "refused", summary: null, costUsd: 0, value: null, valueDropped: false, why: LINE_BUSY_WORDS, lineBusy: true } });
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
      const lost = endOf("lost", `失联：心跳停了，之后再没有动静${partial ? "；它写的事件里有读不全的行，花了多少不知道" : ""}${spent}`, probe.costUsd, probe.costKnown);
      // A run that was cut off still wrote its last word on being carried on (its `resume` events): the runtime carries it on only once it is sure the process is gone.
      return calm(probe.resume && lost.kind === "end" ? { kind: "end", end: { ...lost.end, resume: probe.resume } } : lost);
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
export function unfinishedWhy(end: Pick<FlowEnd, "outcome" | "value"> & Partial<Pick<FlowEnd, "settle" | "why" | "stopKind">>): string | null {
  if (end.outcome !== "stopped") return null;
  // A stop at a step that may or may not have been done is one too, whatever the flow's value says: nothing has come of it until a person says.
  if (end.settle) return settleShort(end.settle);
  const value = end.value;
  const why = value && typeof value === "object" && !Array.isArray(value) ? cleanText((value as Record<string, unknown>).why, 300) : null;
  // Only marks ("。", "...") is no sentence: it says nothing, so it is not a reason to call the run unfinished.
  if (why !== null && /[\p{L}\p{N}]/u.test(why)) return why;
  // An answer that never came right, and the flow did not catch it: the runtime stops the run there (value null), in a line of its own shape.
  // A stop that has its kind is read by it; the sentence is for files from before the field.
  return (end.stopKind ? end.stopKind === "check" : CHECK_STOP.test(end.why ?? "")) ? CHECK_FAILED_WORDS : null;
}

/** The runtime's refusal of a start whose line of runs is being written by another (EVENTS.md "日志", the line lock): it names the line and who holds it, and is told apart from any other refusal by its first words. */
const LINE_BUSY = /^the line of runs ".*" is being worked on by /u;

/** The line the runtime stops a run with when an agent's answer still did not pass after the corrections it was allowed (EVENTS.md `run.end`): `<step>：核对 N 轮还不过：<the first problem>`. */
const CHECK_STOP = /^[^：]{1,80}：核对 \d+ 轮还不过：/u;

/** What a place that may draw Markdown or tags (a message) draws from a character: a link, a tag, code, a mention, emphasis, a table, a heading. */
const DRAWN: Record<string, string> = { "[": "［", "]": "］", "<": "＜", ">": "＞", "`": "｀", "@": "＠", "*": "＊", "_": "＿", "~": "～", "|": "｜", "#": "＃" };

/**
 * A sentence of the flow's (its summary, the reason it stopped, the error it ended with) for a place that may draw Markdown or tags (a
 * message): what would be drawn is put in its full-width form, so that it reads the same and is not drawn as anything (a backslash
 * would show as it is where nothing is drawn). A bare address stays as it is: it shows as the address it is.
 */
const plainForMessage = (text: string): string => text.replace(/[\[\]<>`@*_~|#]/g, (c) => DRAWN[c]!);

/** How a run in trouble can be carried on, as the page shows it and the button does it. */
export interface CarryOn {
  /** The run to carry on. */
  from: string;
  flow: string;
  /** What the flow said about where it carries on from. */
  line: string;
  spends: "nothing" | "maybe";
  print?: string;
}

/**
 * How a run that did not come to a result can be carried on, by the controller's own record: what it said when it stopped (`ended.resume`), or, for a
 * round that was itself to carry one on and never got to run (refused, not started, nothing spent), what it was to carry on -- the word of that
 * run as it stands now (`fresh`, read by the caller), else the one the round was made with. Null for anything else. The page, the button and
 * the rule's `resumable` all come from here, so that they say the same.
 */
export function carryOnOf(rec: Pick<FlowRec, "runId" | "ended" | "resume">, fresh?: ResumeOffer | null): CarryOn | null {
  if (!rec.ended) return null;
  const offer = (o: ResumeOffer, from: string): CarryOn => ({ from, flow: o.flow, line: o.from, spends: o.spends, ...(o.print ? { print: o.print } : {}) });
  if (rec.ended.resume) return offer(rec.ended.resume, rec.runId);
  if (rec.resume && ranNothing(rec)) return offer(fresh ?? { flow: rec.resume.flow, from: rec.resume.line, spends: rec.resume.spends, ...(rec.resume.print ? { print: rec.resume.print } : {}) }, rec.resume.from);
  return null;
}

/** A run that came to no result, so that a person may ask for it again (and none that did). */
const RETRYABLE = new Set<string>(["failed", "timeout", "lost", "not-started", "refused"]);

/** A run that ended with nothing to go on: broken, or a stop that says it did not get done what it was for (`unfinishedWhy`). */
export const noResult = (end: Pick<FlowEnd, "outcome" | "value"> & Partial<Pick<FlowEnd, "settle" | "why" | "stopKind">>): boolean => RETRYABLE.has(end.outcome) || unfinishedWhy(end) !== null;

/**
 * What a rule is told of a run. `fresh`: the word of the run a refused carrying on was to carry on, as it stands now (see `carryOnOf`);
 * `ran`: the flow the runtime says ran, where it could be read (the run's own start), else the one the round was made to run.
 */
export function resultOf(rec: FlowRec, live: Live | null, read: { fresh?: ResumeOffer | null; ran?: string | null } = {}): FlowResult {
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
    resumedFrom: rec.resume?.from ?? null,
    ran: read.ran ?? rec.resume?.flow ?? rec.flow,
    // A run that stopped short and said how it could be carried on (or a carrying on that never ran, which is carried on again with the same word),
    // that nobody set aside and the rule does not take care of itself.
    resumable: ended && noResult(ended) && !rec.dismissed && !rec.selfRetry ? ((point) => (point ? { line: point.line, spends: point.spends } : null))(carryOnOf(rec, read.fresh)) : null,
  };
}

/** What a rule is told of a request that was held back for now (no run exists). */
export const deferredResult = (why: string, limit?: FlowResult["limit"]): FlowResult => ({ state: "deferred", runId: null, round: 0, startedAt: null, endedAt: null, value: null, summary: null, costUsd: 0, why, endedOutcome: null, resumedFrom: null, ran: null, resumable: null, ...(limit ? { limit } : {}) });

/** The word for a run that is not over and the controller reads as in trouble ("fail" is the runtime's, not this). */
export const WAITING_ON_YOU: ReadonlySet<FlowResult["state"]> = new Set(["failed", "timeout", "lost", "not-started", "refused"]);

// ---- telling a person --------------------------------------------------------------------------------

/** The request's name without the item's number it carries ("开发任务 · #7" is "开发任务"): the message says the number once, in front. */
const nameWithout = (label: string, number: string): string => label.split(number).join("").replace(/\s*[·・:：-]\s*$/u, "").replace(/^\s*[·・:：-]\s*/u, "").trim() || label;

/** A reason in a few words: the flow's short sentence when it gave one (its summary), else the long one cut. */
export const reasonShort = (summary: string | null, long: string | null, max = 40): string => {
  const short = summary ? cleanText(summary, max + 1) : null;
  return (short && [...short].length <= max ? short : (cleanText(long ?? summary, max) ?? "")).replace(/[。.]+$/u, "");
};
const shortReason = (summary: string | null, long: string | null, max = 40): string => plainForMessage(reasonShort(summary, long, max));

const ERRORED: Record<string, string> = { lost: "进程断了", "not-started": "没起来", refused: "没被接受", timeout: "超时", failed: "没成功" };

/** What became of a run in one word, as the message and the record of it say: 好了, 停了 (the flow stopped on purpose without getting done what it was for), 出错了. */
export const endedWord = (end: FlowEnd): "好了" | "停了" | "出错了" => (unfinishedWhy(end) !== null ? "停了" : end.outcome === "done" || end.outcome === "stopped" ? "好了" : "出错了");

/** The one message for a run that ended: the request's name, and in a line what became of it. The long version is on the item's page. */
export function endedMessage(rec: Pick<FlowRec, "label" | "caseId" | "selfRetry">, end: FlowEnd): { title: string; text: string; status: "succeeded" | "failed" } {
  const number = `#${rec.caseId.slice(rec.caseId.lastIndexOf(":") + 1)}`;
  const name = nameWithout(rec.label, number);
  const unfinished = unfinishedWhy(end);
  // A stop that says it did not get done what it was for is read as that, in the flow's own words: not looked at this time, not "done". The way
  // out is a button on the page (not for a run the rule takes care of itself: that one has no button).
  if (unfinished !== null) {
    const carryOn = end.resume && !rec.selfRetry && noResult(end) ? "处理好后在事项页点「接着跑」。" : "";
    return { title: `${name}停了`, text: `${number} ${name}停了：${shortReason(end.summary, unfinished)}。${carryOn}`, status: "failed" };
  }
  if (end.outcome === "done" || end.outcome === "stopped") {
    return { title: `${name}好了`, text: `${number} ${name}好了：${shortReason(end.summary ?? (end.outcome === "done" ? "完成了" : "中止了"), null, 60)}。`, status: "succeeded" };
  }
  const carryOn = end.resume && !rec.selfRetry && noResult(end) ? "处理好后在事项页点「接着跑」。" : "要人看，在事项页。";
  return { title: `${name}出错了`, text: `${number} ${name}出错了：${ERRORED[end.outcome] ?? "没成功"}。${carryOn}`, status: "failed" };
}

// ---- the affair a run is for -------------------------------------------------------------------------

/** The longest `affair.key` the runtime takes, in characters (code points). */
const AFFAIR_KEY_LIMIT = 256;
const KEY_HASH_CHARS = 32;

/**
 * The item's id as the runtime's identity for it: the id itself when it fits, otherwise its first characters and a
 * SHA-256 of the whole id, so that two long ids that differ only past the cut are still two keys. (`params.case`, the
 * link's copy, is cut at 256 as it always was; it is for going back to the page, not for telling items apart.)
 */
export function affairKeyOf(caseId: string): string {
  const chars = [...caseId];
  if (chars.length <= AFFAIR_KEY_LIMIT) return caseId;
  return `${chars.slice(0, AFFAIR_KEY_LIMIT - 1 - KEY_HASH_CHARS).join("")}~${sha256(caseId).slice(0, KEY_HASH_CHARS)}`;
}

/**
 * What `--affair` is given (orchestration/runtime/affair.mjs): the label, the item's address when it has a plain one, the item's page,
 * and the `key` the runtime tells the item's runs apart by (they share one Paseo workspace). The key is the item's id alone, so the
 * runs for one item are one affair whatever stage they were asked in; the stage is in the link, which the runtime would otherwise
 * take as the identity. This plugin never reads the key back or draws it.
 */
export function affairOf(rec: Pick<FlowRec, "caseId" | "stage" | "label">, url: string | null, screen: { plugin: string; screen: string }): Record<string, unknown> {
  const label = cleanText(rec.label, 120) ?? rec.caseId.slice(0, 120);
  const plain = url !== null && url.length <= 2048 && /^https?:\/\/[^\s/@]+(\/|$)/.test(url) && !hasUnsafe(url) ? url : null;
  const params: Record<string, string> = { case: rec.caseId.slice(0, 256) };
  if (rec.stage && !hasUnsafe(rec.stage)) params.stage = rec.stage.slice(0, 256);
  return { label, ...(plain ? { url: plain } : {}), link: { plugin: screen.plugin, screen: screen.screen, params }, key: affairKeyOf(rec.caseId) };
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
  /**
   * Set when the run carries on an earlier one: the process is `orch.mjs resume <resumeOf> --run-id …`, and the flow and its input are the ones
   * that run left in its resume point, which the runtime reads (`flow` and `inputFile` are then not used, and not written).
   */
  resumeOf?: string | null;
  /** With `resumeOf`: the fingerprint of the point the person was shown (`--expect`): the runtime starts nothing if the point it reads now has another. */
  expect?: string | null;
}

export interface Launcher {
  /** Starts the runtime for the run, detached; resolves when the process exists, rejects when it could not be started. */
  start(spec: LaunchSpec): Promise<{ pid: number | null }>;
}

/**
 * The real one: `<command> run <flow> --run-id … --affair @… --input @… [--timeout …]` (or, for a run that carries on another,
 * `<command> resume <earlier run> --run-id … --affair @… [--timeout …]`), no shell, no window, its own
 * process (not the plugin's child to wait for, nor killed with it: a plugin reload leaves the run going).
 */
export function createLauncher(config: LauncherConfig): Launcher {
  return {
    start(spec) {
      const [file, ...prefix] = config.command;
      const timeout = spec.timeout ? ["--timeout", spec.timeout] : [];
      const args = spec.resumeOf
        ? [...prefix, "resume", spec.resumeOf, "--run-id", spec.runId, "--affair", `@${spec.affairFile}`, ...timeout, ...(spec.expect ? ["--expect", spec.expect] : [])]
        : [...prefix, "run", spec.flow, "--run-id", spec.runId, "--affair", `@${spec.affairFile}`, "--input", `@${spec.inputFile}`, ...timeout];
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
