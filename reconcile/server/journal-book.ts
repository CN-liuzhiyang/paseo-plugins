import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";
import { answeredWhere, type Annotation, type Assessment, type Commitment, type Note } from "../shared/model";
import type { Ball, Cause, HistoryLine } from "../shared/graph";
import { clip, KIND_LABEL } from "./requests";
import type { JournalEvent } from "./state";
import { iso, zoned } from "./time";

// What the page of an item needs from the past, read from the journal: the stages an item went
// through and when. The state keeps only the last assessment of each item, but the journal has
// them all, so the history is a fold over its `assessment` events -- an old journal needs nothing
// added. The book reads the journal files once and then only what was appended since (the files
// are append-only), and keeps a small chain per item, not the events.
//
// A stay in a stage ends when a judgment names another stage. Why it changed (`cause`) is read
// from what happened between the two judgments: a person's word on the item (said, or a
// correction), else, when the rules changed at the same moment and no data of the item (or of a
// file every item reads) was read in between, the new rules; else the world (data, or time).
// "Rules changed" is a reading of that coincidence, not a proof: a change of rules that came in the
// same reconcile as a real change of the item's data looks like data, and a real change that came
// just as the rules did, without the data being read, looks like the rules. The screen names it so.

const CHUNK = 8 << 20;
/** Newest entries kept per item for its history and its facts. */
const KEEP = 300;

export interface AssessRec {
  seq: number;
  at: string;
  stage: string;
  health: Assessment["health"];
  headline: string;
  actor: Ball;
  what: string;
  fp: string;
  error: string | null;
  notice: string | null;
  stale: boolean;
  /** When it got to this stage by the rule's own evidence, if the rule said and it was not later than the judgment. */
  since: string | null;
  /** When it became the actor's move by the rule's own evidence, the same way. */
  ballSince: string | null;
  rule: string;
}

export interface BallSeg {
  actor: Ball;
  what: string;
  /** When it became theirs: the rule's `next.since` when it could be, else `seen`. */
  from: string;
  /** The judgment that first saw it theirs. */
  seen: string;
  /**
   * It became theirs in the first judgment by changed rules: when it would have become theirs is
   * not known from when it was seen (data read in the meantime does not tell either: the rules in use
   * before were judging it all along and did not hand it over).
   */
  cause: "rules-changed" | null;
}

export interface RawVisit {
  stage: string;
  /** The reconcile that first saw the item in this stage. */
  observed: string;
  happened: string | null;
  cause: Cause | null;
  /** Judged so, then again by changed rules: the stage was not one the item took. */
  superseded: boolean;
  headline: string;
  lastHeadline: string;
  balls: BallSeg[];
}

export interface Fmt {
  stage(id: string): string;
  person(id: string): string;
}

export interface RawEntry {
  at: string;
  seq: number;
  kind: HistoryLine["kind"];
  text(f: Fmt): string;
  detail: string | null;
}

export interface NoteRec {
  field: string;
  value: string;
  evidence: string | null;
  at: string;
  by: string;
  seq: number;
}

export interface Chain {
  caseId: string;
  first: AssessRec | null;
  /** The last judgment that was not an error. */
  last: AssessRec | null;
  errorSince: string | null;
  visits: RawVisit[];
  /** Something this item reads changed since `last`. */
  dataSince: boolean;
  saidSince: { drop: boolean; wrong: boolean };
  notes: NoteRec[];
  entries: RawEntry[];
}

export interface JournalBook {
  /** Reads what was appended since the last call. */
  refresh(): void;
  chain(caseId: string): Chain | undefined;
}

const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const WALL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * An instant a rule wrote, in the instance's zone and the way the journal stores times. A rule may
 * write it with an offset, in UTC ("Z"), or as a wall clock with none; the last is read in the
 * instance's zone, not the machine's. Null for what is not a time.
 */
export function instantOf(text: string, tz: string): string | null {
  const wall = OFFSET.test(text) ? null : WALL.exec(text.trim());
  const ms = wall ? zoned(wall[1]!, wall[2]!, tz) + Number(wall[3] ?? 0) * 1000 : Date.parse(text);
  return Number.isNaN(ms) ? null : iso(ms, tz);
}

const PREFIX = /^\{"v":1,"seq":(\d+),"at":"([^"]+)","type":"([^"]+)"/;
const SNAPSHOT_KEY = /"item":\{"key":"([^"]+)","source":"([^"]+)"/;

const WANTED = new Set(["assessment", "item.snapshot", "note.set", "commitment.created", "commitment.changed", "action", "annotation.added", "annotation.revoked"]);

/**
 * `shared`: the ids of sources whose items every item reads (switch files, version files): a
 * change in one is a change in the data of all. `memory`: a rehearsing store's (Store.memory): the
 * journal in `dir` is read up to its `upTo`, then its events.
 */
export function createJournalBook(dir: string, shared: ReadonlySet<string>, tz: string, memory?: { upTo: number; events: readonly JournalEvent[] }): JournalBook {
  const journalDir = path.join(dir, "journal");
  let eaten = 0;
  const offsets = new Map<string, number>();
  const chains = new Map<string, Chain>();
  const commitments = new Map<string, { caseId: string | null; owner: string; title: string }>();
  const annotations = new Map<string, { caseId: string; kind: Annotation["kind"] }>();

  const chainOf = (caseId: string): Chain => {
    let found = chains.get(caseId);
    if (!found) {
      found = { caseId, first: null, last: null, errorSince: null, visits: [], dataSince: false, saidSince: { drop: false, wrong: false }, notes: [], entries: [] };
      chains.set(caseId, found);
    }
    return found;
  };
  const entry = (chain: Chain, e: RawEntry) => {
    chain.entries.push(e);
    if (chain.entries.length > KEEP) chain.entries.splice(0, chain.entries.length - KEEP);
  };

  function assessed(seq: number, a: Assessment) {
    const chain = chainOf(a.caseId);
    // Read as an instant, in the instance's zone: a rule may write it in UTC or without an offset.
    const sinceAt = a.since ? instantOf(a.since, tz) : null;
    const since = sinceAt && Date.parse(sinceAt) <= Date.parse(a.at) ? sinceAt : null;
    const ballAt = a.next.since ? instantOf(a.next.since, tz) : null;
    const ballSince = ballAt && Date.parse(ballAt) <= Date.parse(a.at) ? ballAt : null;
    const rec: AssessRec = { seq, at: a.at, stage: a.stage, health: a.health, headline: a.headline, actor: a.next.actor, what: a.next.what, fp: a.rulesFingerprint, error: a.error, notice: a.notice ?? null, stale: a.stale, since, ballSince, rule: a.rule };
    chain.first ??= rec;
    if (rec.error !== null) {
      if (chain.errorSince === null) {
        chain.errorSince = rec.at;
        entry(chain, { at: rec.at, seq, kind: "error", text: () => `检查出错：${clip(rec.error!, 120)}`, detail: null });
      }
      return;
    }
    if (chain.errorSince !== null) {
      chain.errorSince = null;
      entry(chain, { at: rec.at, seq, kind: "error", text: () => "检查恢复了", detail: null });
    }
    const last = chain.last;
    // A stage is not entered before the one before it was: a `since` that says so is not believed.
    const notBefore = (at: string | null, visits: RawVisit[]): string | null => {
      const before = visits.filter((v) => !v.superseded).pop();
      const from = before ? (before.happened ?? before.observed) : null;
      return at && (!from || Date.parse(at) >= Date.parse(from)) ? at : null;
    };
    // Nor is a move someone's before the stay began, or before the move before it was another's.
    const notBeforeMs = (at: string | null, floor: string): string | null => (at && Date.parse(at) >= Date.parse(floor) ? at : null);
    const start = (cause: Cause | null) => {
      const happened = notBefore(rec.since, chain.visits);
      const ballFrom = happened ? (notBeforeMs(rec.ballSince, happened) ?? happened) : rec.at;
      chain.visits.push({ stage: rec.stage, observed: rec.at, happened, cause, superseded: false, headline: rec.headline, lastHeadline: rec.headline, balls: [{ actor: rec.actor, what: rec.what, from: ballFrom, seen: rec.at, cause: last && rec.fp !== last.fp ? "rules-changed" : null }] });
    };
    if (!last) {
      start(null);
      entry(chain, { at: rec.at, seq, kind: "stage", text: (f) => `开始追踪，在「${f.stage(rec.stage)}」`, detail: rec.headline });
    } else if (rec.stage !== last.stage) {
      const cause: Cause = chain.saidSince.drop ? "said" : chain.saidSince.wrong ? "correction" : rec.fp !== last.fp && !chain.dataSince ? "rules-changed" : "data";
      if (cause === "rules-changed") {
        const before = chain.visits[chain.visits.length - 1];
        if (before) before.superseded = true;
      }
      start(cause);
      const from = last.stage;
      entry(chain, {
        at: rec.at,
        seq,
        kind: cause === "rules-changed" ? "rules" : "stage",
        text: (f) => (cause === "rules-changed" ? `判断方法更新后改判：「${f.stage(from)}」→「${f.stage(rec.stage)}」` : `进了「${f.stage(rec.stage)}」`),
        detail: rec.headline,
      });
    } else {
      const visit = chain.visits[chain.visits.length - 1];
      if (visit) {
        visit.lastHeadline = rec.headline;
        if (visit.happened === null) visit.happened = notBefore(rec.since, chain.visits.slice(0, -1));
        const balls = visit.balls;
        const ball = balls[balls.length - 1];
        // Where the turn of one holder that has its segment at `end` began (what it was doing may have changed since).
        const turnOf = (end: number) => {
          let j = end;
          while (j > 0 && balls[j - 1]!.actor === balls[end]!.actor) j--;
          return j;
        };
        // The rule's evidence of when the move became the holder's: not before the turn before began
        // (nor the stay), and what is drawn of that turn after then was, by it, not that turn's.
        const handOver = (before: number, at: string) => {
          while (balls.length - 1 > before && Date.parse(balls[balls.length - 1]!.from) > Date.parse(at)) balls.pop();
        };
        if (ball && ball.actor !== rec.actor) {
          const before = turnOf(balls.length - 1);
          const from = notBeforeMs(rec.ballSince, balls[before]!.from) ?? rec.at;
          handOver(before, from);
          balls.push({ actor: rec.actor, what: rec.what, from, seen: rec.at, cause: rec.fp !== last.fp ? "rules-changed" : null });
        } else if (ball && ball.what !== rec.what) balls.push({ actor: rec.actor, what: rec.what, from: rec.at, seen: rec.at, cause: null });
        else if (ball && rec.ballSince) {
          // Evidence given later (by rules that say it now): the turn began then.
          const i = turnOf(balls.length - 1);
          const before = i > 0 ? turnOf(i - 1) : -1;
          const earlier = notBeforeMs(rec.ballSince, before >= 0 ? balls[before]!.from : (visit.happened ?? visit.observed));
          if (earlier && Date.parse(earlier) < Date.parse(balls[i]!.from)) {
            const turn = balls.splice(i);
            if (before >= 0) handOver(before, earlier);
            turn[0]!.from = earlier;
            balls.push(...turn);
          }
        }
      }
    }
    chain.last = rec;
    chain.dataSince = false;
    chain.saidSince = { drop: false, wrong: false };
  }

  function handle(type: string, seq: number, at: string, line: string) {
    if (type === "item.snapshot") {
      const m = SNAPSHOT_KEY.exec(line.slice(0, 600));
      let key = m?.[1];
      let source = m?.[2];
      if (!key) {
        const item = (JSON.parse(line) as { item: { key: string; source: string } }).item;
        key = item.key;
        source = item.source;
      }
      if (source && shared.has(source)) for (const chain of chains.values()) chain.dataSince = true;
      else if (key) {
        const chain = chains.get(key);
        if (chain) chain.dataSince = true;
      }
      return;
    }
    const e = JSON.parse(line) as Record<string, unknown>;
    switch (type) {
      case "assessment":
        assessed(seq, e.assessment as Assessment);
        return;
      case "note.set": {
        const n = e.note as Note;
        const chain = chainOf(n.key);
        chain.notes.push({ field: n.field, value: n.value, evidence: n.evidence, at: n.at, by: n.by, seq });
        if (chain.notes.length > KEEP) chain.notes.splice(0, chain.notes.length - KEEP);
        return;
      }
      case "commitment.created": {
        const c = e.commitment as Commitment;
        commitments.set(c.id, { caseId: c.caseId, owner: c.owner, title: c.title });
        if (c.caseId && c.origin.by === "rule") {
          const when = "at" in c.trigger ? c.trigger.at.slice(5, 16).replace("T", " ") : null;
          entry(chainOf(c.caseId), { at: at, seq, kind: "ask", text: () => `排了：${when ? `${when} 问` : "到时候问"}「${c.title}」`, detail: c.ask.question });
        }
        return;
      }
      case "commitment.changed": {
        const info = commitments.get(e.id as string);
        if (!info?.caseId) return;
        const patch = e.patch as Partial<Commitment>;
        const chain = chainOf(info.caseId);
        if (patch.answer) {
          const a = patch.answer;
          const said = a.text ?? a.label;
          const where = answeredWhere(a.via);
          entry(chain, { at: a.at, seq, kind: "answer", text: (f) => `${f.person(info.owner)}${where}回答：${clip(said, 80)}`, detail: null });
        } else if (patch.status === "cancelled" || patch.status === "expired") {
          const why = patch.reason;
          entry(chain, {
            at,
            seq,
            kind: "ask",
            text: () => `「${info.title}」${patch.status === "expired" ? "到兜底时间没人答，记成过期" : "不用问了"}${why ? `（${why}）` : ""}`,
            detail: null,
          });
        }
        return;
      }
      case "action": {
        const a = e.action as { key: string; kind: string; status: string; summary: string };
        if (a.kind !== "ask" || a.status !== "done") return;
        const [, cid, round] = a.key.split(":");
        const info = cid ? commitments.get(cid) : undefined;
        if (!info?.caseId) return;
        entry(chainOf(info.caseId), { at, seq, kind: "ask", text: () => `${a.summary.replace(/^问 /, "问了 ")}${round && round !== "1" ? `（第 ${round} 次）` : ""}`, detail: null });
        return;
      }
      case "annotation.added": {
        const a = e.annotation as Annotation;
        annotations.set(a.id, { caseId: a.caseId, kind: a.kind });
        const chain = chainOf(a.caseId);
        if (a.kind === "drop") chain.saidSince.drop = true;
        if (a.kind === "wrong") chain.saidSince.wrong = true;
        entry(chain, { at: a.at, seq, kind: "said", text: (f) => `${f.person(a.by)}说：「${clip(a.said, 80)}」（${KIND_LABEL[a.kind]}）`, detail: null });
        return;
      }
      case "annotation.revoked": {
        const known = annotations.get(e.id as string);
        if (!known) return;
        const chain = chainOf(known.caseId);
        if (known.kind === "drop") chain.saidSince.drop = true;
        entry(chain, { at, seq, kind: "said", text: (f) => `${f.person(e.by as string)}撤了一条（${KIND_LABEL[known.kind]}）：「${clip(e.said as string, 80)}」`, detail: null });
      }
    }
  }

  function eat(text: string) {
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const m = PREFIX.exec(line);
      if (!m || !WANTED.has(m[3]!)) continue;
      // Written after the rehearsing store's state was read: not its history (its own events follow).
      if (memory && Number(m[1]) > memory.upTo) continue;
      try {
        handle(m[3]!, Number(m[1]), m[2]!, line);
      } catch {
        // A line that does not parse is one the store skipped as well.
      }
    }
  }

  function readFile(file: string): boolean {
    const full = path.join(journalDir, file);
    const fd = openSync(full, "r");
    try {
      const size = fstatSync(fd).size;
      let offset = offsets.get(file) ?? 0;
      if (size < offset) return false;
      while (offset < size) {
        let want = Math.min(CHUNK, size - offset);
        let buffer: Buffer;
        let cut: number;
        for (;;) {
          buffer = Buffer.alloc(want);
          readSync(fd, buffer, 0, want, offset);
          cut = buffer.lastIndexOf(0x0a);
          if (cut >= 0 || offset + want >= size) break;
          want = Math.min(want * 2, size - offset);
        }
        // Only complete lines: the last one may be being written.
        if (cut < 0) break;
        eat(buffer.subarray(0, cut + 1).toString("utf8"));
        offset += cut + 1;
        offsets.set(file, offset);
      }
      return true;
    } finally {
      closeSync(fd);
    }
  }

  return {
    refresh() {
      // A read that fails (a file another process holds for a moment, one replaced between the listing and the open)
      // leaves what is read as it was and is tried again at the next call: a page never fails for it.
      try {
        const files = existsSync(journalDir) ? readdirSync(journalDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort() : [];
        for (const file of files) {
          if (!readFile(file)) {
            // A file got shorter: not an append. Read everything again.
            offsets.clear();
            chains.clear();
            commitments.clear();
            annotations.clear();
            eaten = 0;
            for (const again of files) readFile(again);
            break;
          }
        }
      } catch {
        // see above
      }
      for (; memory && eaten < memory.events.length; eaten++) {
        const e = memory.events[eaten]!;
        if (!WANTED.has(e.type)) continue;
        try {
          handle(e.type, e.seq, e.at, JSON.stringify(e));
        } catch {
          // as a line that does not parse
        }
      }
    },
    chain: (caseId) => chains.get(caseId),
  };
}
