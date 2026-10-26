import path from "node:path";
import type { Annotation, Assessment } from "../shared/model";
import { buildCapsule, writeCapsule, type Capsule, type CaptureInput, type ShownJudgment } from "./capsule";
import { loadConfig } from "./config";
import { shadow } from "./preview";
import { RULES_KEPT } from "./rules";
import { apply, emptyState, type JournalEvent } from "./state";
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

export interface BackfillResult {
  points: number;
  made: Array<{ file: string; capsule: Capsule }>;
  /** Moments the rules in use do not judge the item at (it is cold, dropped, or no rule is for it). */
  skipped: Array<{ caseId: string; at: string; why: string[] }>;
}

export interface BackfillOptions {
  /** The config in use. */
  configDir: string;
  /** The controller's data directory; read only. */
  dataDir: string;
  /** Where the capsules are written. */
  to: string;
}

export async function backfill(options: BackfillOptions): Promise<BackfillResult> {
  const config = loadConfig(options.configDir);
  const events = readEvents(options.dataDir);
  if (events.length === 0) throw new BackfillError(`数据目录里没有日志：${options.dataDir}`);
  // Folded from the start: a journal that begins later cannot say what the state was.
  if (events[0]!.seq !== 1) throw new BackfillError("日志不是从头开始的（第一条不是 seq 1）：补录要从头折叠，补不了");
  const points = backfillPoints(events);
  const rounds = new Map<string, BackfillPoint[]>();
  for (const p of points) rounds.set(`${p.start}|${p.at}`, [...(rounds.get(`${p.start}|${p.at}`) ?? []), p]);

  const state = emptyState();
  let cursor = 0;
  let instance: string | null = null;
  const result: BackfillResult = { points: points.length, made: [], skipped: [] };
  for (const round of [...rounds.values()].sort((a, b) => a[0]!.start - b[0]!.start)) {
    const { start, at } = round[0]!;
    for (; cursor < events.length && events[cursor]!.seq < start; cursor++) {
      apply(state, events[cursor]!);
      const e = events[cursor]!;
      if (e.type === "started") instance = e.instanceId;
    }
    const clock = { ms: Date.parse(at) };
    const judged = new Map<string, Omit<CaptureInput, "trigger" | "origin">>();
    const side = shadow(state, options.dataDir, config, clock, { dir: path.join(options.dataDir, RULES_KEPT), write: false }, (judgment) => judged.set(judgment.kase.id, judgment));
    await side.engine.tick();
    await side.engine.stop();
    for (const p of round) {
      const input = judged.get(p.caseId);
      if (!input) {
        result.skipped.push({ caseId: p.caseId, at: p.at, why: [...p.why] });
        continue;
      }
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
      result.made.push({ file: writeCapsule(options.to, capsule), capsule });
    }
  }
  return result;
}
