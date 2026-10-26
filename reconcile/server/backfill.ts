import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { Annotation, Assessment } from "../shared/model";
import { buildCapsule, capsulePath, loadCapsules, replaceExpect, writeCapsule, type Capsule, type CaptureInput, type ShownJudgment } from "./capsule";
import { loadConfig } from "./config";
import { canonical } from "./observe";
import { checkDirs, shadow } from "./preview";
import { loadRules, RULES_KEPT, type CtxCall, type LoadedRule } from "./rules";
import { apply, emptyState, flowKeyOf, type JournalEvent, type State } from "./state";
import { readEvents } from "./store";

// Capsules made after the fact, from the journal: the moments a controller would have kept a
// judgment at, found in what it wrote down; the state folded to just before each; the rules in
// use now asked, in the preview's in-memory engine, what they say there, and the capsule taped as
// they say it. They are not what was judged then: the rules may have been others, and the
// configuration is today's. They are what a replay needs to have something to hold a change
// against from the first day. Nothing is written to the data directory.

export class BackfillError extends Error {}

const ORDER = ["first", "stage", "questions", "notice", "error", "wrong"];

/** A moment worth a capsule: an item, the instant of the round, the journal position to fold to, and why. */
export interface BackfillPoint {
  caseId: string;
  at: string;
  start: number;
  why: Set<string>;
  /** The judgment the journal holds for it, when it holds one. */
  logged: ShownJudgment | null;
  annotation: Annotation | null;
}

const shownOf = (a: Assessment): ShownJudgment => ({ at: a.at, rule: a.rule, stage: a.stage, health: a.health, headline: a.headline, actor: a.next.actor, what: a.next.what });

/**
 * The moments in a journal a judgment would have been kept at: an item's first judgment, a change
 * of its stage, of whether its judgment failed, or of its notice; a question a rule made or took
 * back; a judgment said to be wrong. A round is told by the instant its writes carry, and the state
 * to fold to is the one before the round's judgments, which is what they saw.
 */
export function backfillPoints(events: JournalEvent[]): BackfillPoint[] {
  // The instant of a round is the `at` of its judgments, and the state to fold to is the one just
  // before the first of them: what the round's polling brought is in it, what the round wrote is not.
  const roundStart = new Map<string, number>();
  for (const e of events) if (e.type === "assessment") roundStart.set(e.assessment.at, Math.min(roundStart.get(e.assessment.at) ?? e.seq, e.seq));
  const points = new Map<string, BackfillPoint>();
  const put = (caseId: string, at: string, seq: number, why: string): BackfillPoint => {
    // A round that judged nothing of the item (a question made on a day nothing changed) has no such mark: before its own write.
    const from = roundStart.get(at) ?? seq;
    const key = `${caseId}@${at}`;
    const point = points.get(key) ?? { caseId, at, start: from, why: new Set<string>(), logged: null, annotation: null };
    point.start = Math.min(point.start, from);
    point.why.add(why);
    points.set(key, point);
    return point;
  };
  const last = new Map<string, Assessment>();
  const tracked = new Map<string, { caseId: string | null; by: string; status: string }>();
  for (const e of events) {
    if (e.type === "assessment") {
      const a = e.assessment;
      const was = last.get(a.caseId);
      const why = !was ? ["first"] : [was.stage !== a.stage && "stage", !!was.error !== !!a.error && "error", (was.notice ?? null) !== (a.notice ?? null) && "notice"].filter((w): w is string => !!w);
      last.set(a.caseId, a);
      for (const w of why) put(a.caseId, a.at, e.seq, w).logged = shownOf(a);
    } else if (e.type === "commitment.created") {
      const c = e.commitment;
      tracked.set(c.id, { caseId: c.caseId, by: c.origin.by, status: c.status });
      if (c.origin.by === "rule" && c.caseId) put(c.caseId, c.createdAt, e.seq, "questions");
    } else if (e.type === "commitment.changed") {
      const c = tracked.get(e.id);
      const status = e.patch.status;
      if (c && status) {
        const wasOpen = c.status === "scheduled" || c.status === "waiting";
        const isOpen = status === "scheduled" || status === "waiting";
        c.status = status;
        // Taken back (cancelled or no longer wanted), or opened again.
        if (c.by === "rule" && c.caseId && wasOpen !== isOpen && e.patch.updatedAt && (status === "cancelled" || isOpen)) put(c.caseId, e.patch.updatedAt, e.seq, "questions");
      }
    } else if (e.type === "annotation.added" && e.annotation.kind === "wrong") {
      put(e.annotation.caseId, e.annotation.at, e.seq, "wrong").annotation = e.annotation;
    }
  }
  return [...points.values()].sort((a, b) => a.start - b.start || Date.parse(a.at) - Date.parse(b.at) || a.caseId.localeCompare(b.caseId));
}

/**
 * Whether what `ctx.run(name, key)` gave in the preview's engine is what the controller was told at
 * that moment. The record of a run the journal holds an end for is; so is a request never made. A
 * run still going is not: how it stood (running, waiting, at a gate) was read from the runtime's
 * files, which a backfill has not got -- the engine in the preview says "waiting to start" of every
 * one. (A request held back for room, which the journal does not hold either, is taken as not made.)
 */
function runKnown(state: State, rule: LoadedRule, caseId: string, name: string, key: string): boolean {
  const flow = rule.flows?.[name]?.flow;
  if (flow === undefined) return true;
  const latest = state.flowKeys?.[flowKeyOf(caseId, name, flow, key)];
  const rec = latest ? state.flows?.[latest.runId] : undefined;
  return !rec || !!rec.ended || !!rec.dismissed;
}

const callText = (c: CtxCall) => `${c.m}(${c.args.map((a) => JSON.stringify(a)).join(", ")})`;

export interface BackfillResult {
  points: number;
  /** Written now. */
  made: Array<{ file: string; capsule: Capsule }>;
  /** Already there, with the very same inputs (a capsule is its inputs): left as it is. */
  existing: Array<{ file: string; capsule: Capsule }>;
  /**
   * Made earlier here for the same item and moment from other inputs (the rules in use then were
   * others): left, or taken away with `replace` -- and what a person wrote on it (`expect`) goes
   * to the new one first (carried), unless the new one already says another (kept: it is not taken away).
   */
  superseded: Array<{ file: string; capsule: Capsule; by: string; removed: boolean; carried: boolean; kept: "expect" | null }>;
  /** A capsule that could not be written because a file of its name is there and cannot be read: not overwritten (it may hold what a person wrote). */
  blocked: Array<{ file: string; capsule: Capsule }>;
  /** Moments the rules in use do not judge the item at (it is cold, dropped, or no rule is for it). */
  skipped: Array<{ caseId: string; at: string; why: string[] }>;
  /** Flows' states a rule read that a backfill cannot know (the run was still going): not taped, so a replay takes them as what the capsule lacks. */
  unknowable: Array<{ caseId: string; at: string; calls: string[] }>;
}

export interface BackfillOptions {
  /** The config in use. */
  configDir: string;
  /** The controller's data directory; read only. */
  dataDir: string;
  /** Where the capsules are written. */
  to: string;
  /** Compressed (the controller's own way); absent: plain JSON, which a repository shows the changes of. */
  gzip?: boolean;
  /** Take away what an earlier backfill into `to` made for the same moments from other inputs. */
  replace?: boolean;
  /** Ask the rules of this candidate (a directory laid out like the config's parts) instead of the rules in use: the capsules then hold what the candidate reads. */
  candidateDir?: string;
}

export async function backfill(options: BackfillOptions): Promise<BackfillResult> {
  if (options.candidateDir) {
    checkDirs(options.configDir, options.candidateDir);
    const errors = (await loadRules(loadConfig(options.configDir, options.candidateDir).rulesDir, null)).errors;
    if (errors.length > 0) throw new BackfillError(`候选的判断方法加载不上，补不了：${errors.map((e) => `${e.file}（${e.error.slice(0, 80)}）`).join("、")}`);
  }
  const config = loadConfig(options.configDir, options.candidateDir);
  const events = readEvents(options.dataDir);
  if (events.length === 0) throw new BackfillError(`数据目录里没有日志：${options.dataDir}`);
  // Folded from the start: a journal that begins later cannot say what the state was.
  if (events[0]!.seq !== 1) throw new BackfillError("日志不是从头开始的（第一条不是 seq 1）：补录要从头折叠，补不了");
  // And with nothing missing in the middle: a state folded over a gap is not one that ever was.
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.seq !== events[i - 1]!.seq + 1) throw new BackfillError(`日志中间缺了东西（seq ${events[i - 1]!.seq} 后面是 ${events[i]!.seq}）：折叠出来的状态不是真的，补不了`);
  }
  const points = backfillPoints(events);
  const rounds = new Map<string, BackfillPoint[]>();
  for (const p of points) rounds.set(`${p.start}|${p.at}`, [...(rounds.get(`${p.start}|${p.at}`) ?? []), p]);

  const state = emptyState();
  let cursor = 0;
  let instance: string | null = null;
  const result: BackfillResult = { points: points.length, made: [], existing: [], superseded: [], blocked: [], skipped: [], unknowable: [] };
  // What an earlier backfill left in `to`, by what it holds and by the moment it is of.
  const there = loadCapsules([options.to]).capsules;
  const byId = new Map(there.map((c) => [c.capsule.id, c] as const));
  const ofMoment = new Map<string, typeof there>();
  for (const c of there) if (c.capsule.origin === "backfill") ofMoment.set(`${c.capsule.case}|${c.capsule.at}`, [...(ofMoment.get(`${c.capsule.case}|${c.capsule.at}`) ?? []), c]);
  for (const round of [...rounds.values()].sort((a, b) => a[0]!.start - b[0]!.start)) {
    const { start, at } = round[0]!;
    for (; cursor < events.length && events[cursor]!.seq < start; cursor++) {
      apply(state, events[cursor]!);
      const e = events[cursor]!;
      if (e.type === "started") instance = e.instanceId;
    }
    const clock = { ms: Date.parse(at) };
    const judged = new Map<string, { input: Omit<CaptureInput, "trigger" | "origin">; dropped: string[] }>();
    // A candidate's rules are read from where they are (no last-good copy stands in for one that does not load: that was checked above).
    const side = shadow(state, options.dataDir, config, clock, options.candidateDir ? null : { dir: path.join(options.dataDir, RULES_KEPT), write: false }, (judgment) => {
      const known = (c: CtxCall) => c.m !== "run" || runKnown(state, judgment.rule, judgment.kase.id, String(c.args[0]), String(c.args[1]));
      judged.set(judgment.kase.id, { input: { ...judgment, calls: judgment.calls.filter(known) }, dropped: judgment.calls.filter((c) => !known(c)).map(callText) });
    });
    await side.engine.tick();
    await side.engine.stop();
    for (const p of round) {
      const { input, dropped } = judged.get(p.caseId) ?? {};
      if (!input) {
        result.skipped.push({ caseId: p.caseId, at: p.at, why: [...p.why] });
        continue;
      }
      if (dropped && dropped.length > 0) result.unknowable.push({ caseId: p.caseId, at: p.at, calls: dropped });
      const shown = state.assessments[p.caseId];
      const capsule = buildCapsule({
        ...input,
        trigger: ORDER.filter((w) => p.why.has(w)),
        origin: "backfill",
        instance,
        logged: p.logged,
        ...(p.annotation
          ? {
              shown: shown ? shownOf(shown) : null,
              correction: { annotation: p.annotation.id, said: p.annotation.said, what: p.annotation.what, expected: p.annotation.expected, at: p.annotation.at, by: p.annotation.by },
            }
          : {}),
      });
      const gzip = options.gzip ?? false;
      // Where this moment's capsule is now: already there, written now, or nowhere (a file of its name that cannot be read is in the way).
      let target = byId.get(capsule.id) ?? null;
      if (target) result.existing.push({ file: target.file, capsule: target.capsule });
      else {
        const file = capsulePath(options.to, capsule, gzip);
        if (existsSync(file)) result.blocked.push({ file, capsule });
        else {
          result.made.push({ file: writeCapsule(options.to, capsule, { gzip }), capsule });
          target = { file, capsule };
          byId.set(capsule.id, target);
        }
      }
      if (!target) continue;
      for (const old of ofMoment.get(`${capsule.case}|${capsule.at}`) ?? []) {
        if (old.capsule.id === capsule.id || result.superseded.some((x) => x.file === old.file)) continue;
        // What a person wrote on the old one goes to the new one before the old one is taken away; if
        // the new one already says another, the old one stays.
        let [removed, carried, kept] = [false, false, null as "expect" | null];
        if (options.replace) {
          const said = old.capsule.expect;
          if (!said) removed = true;
          else if (!target.capsule.expect) {
            replaceExpect(target.file, said);
            target.capsule.expect = said;
            [removed, carried] = [true, true];
          } else if (canonical(target.capsule.expect) === canonical(said)) removed = true;
          else kept = "expect";
          if (removed) rmSync(old.file, { force: true });
        }
        result.superseded.push({ file: old.file, capsule: old.capsule, by: capsule.id, removed, carried, kept });
      }
    }
  }
  return result;
}
