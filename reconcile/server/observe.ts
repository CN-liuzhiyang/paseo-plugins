import { createHash } from "node:crypto";
import type { Item, ObserveRequest, ObserveVerdict } from "../shared/model";
import { iso } from "./time";

// What an observing source is asked to read and when, and what a rule is told it found.
// The command says what it concluded; whether that may be taken as found is the controller's to
// say. "Nothing found" stands only for a window watched to its end, on data read when a read was
// due and not lagging far behind what it covers. Anything less is "too little to tell": nothing
// seen is not nothing there. A problem the command found is never taken back this way; it is only
// marked as not current.
//
// What was read is for one request: its source, key, window and params (its version). A request
// changed in any of them is another one, read anew; what was read for the one before is not its.
// A request is read until its deadline (its last due read, or when it was taken on if later, and
// the grace after); a read not made by then is not made, and the rule is told so.

export const VERDICTS = ["no-signal", "needs-look", "hard-fail", "insufficient-data"] as const;

/** Why what was found is not current, as a code and in words; null: it is. "gave-up": a read owed was not made by the deadline, and is not tried again. */
export type NotCurrent = "none-yet" | "window-open" | "not-read" | "lagging" | "gave-up";

export interface Concluded {
  /** What the rule goes by: the command's, unless it said nothing was found when that cannot be told. */
  verdict: ObserveVerdict;
  /** What the command said; null when nothing was read yet. */
  reported: ObserveVerdict | null;
  why: NotCurrent | null;
  whyText: string | null;
  /** When it was last read, and up to when the data it read went. */
  readAt: string | null;
  freshUntil: string | null;
  window: { from: string; to: string } | null;
  /** What the command found, as it gave it (the controller does not read it). */
  numbers: Record<string, unknown>;
  notes: string[];
  /** Why a read owed did not come (the command's error), when one did not and that is known. */
  failure: string | null;
}

const MIN = 60_000;

/** JSON with an object's keys in order: the same params however they were written. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Which request a read was for: its source, key, window and params. */
export function requestVersion(r: Pick<ObserveRequest, "source" | "key" | "window" | "params">): string {
  const window = [Date.parse(r.window.from), Date.parse(r.window.to)];
  return createHash("sha256").update(canonical([r.source, r.key, window, r.params])).digest("hex").slice(0, 16);
}

/** The last instant (ms) at or before now a read is wanted at: every `everyMs` from the window's start, its end, then each reread. */
export function lastDue(r: ObserveRequest, everyMs: number, nowMs: number): number | null {
  const from = Date.parse(r.window.from);
  const to = Date.parse(r.window.to);
  if (nowMs < from) return null;
  if (nowMs < to) return from + Math.floor((nowMs - from) / everyMs) * everyMs;
  const after = r.reread.map((m) => to + m * MIN).filter((t) => t <= nowMs);
  return Math.max(to, ...after);
}

/** The next instant (ms) after now a read is wanted at; null when none is left. */
export function nextDue(r: ObserveRequest, everyMs: number, nowMs: number): number | null {
  const from = Date.parse(r.window.from);
  const to = Date.parse(r.window.to);
  if (nowMs < from) return from;
  if (nowMs < to) return Math.min(to, from + (Math.floor((nowMs - from) / everyMs) + 1) * everyMs);
  const after = r.reread.map((m) => to + m * MIN).filter((t) => t > nowMs);
  return after.length > 0 ? Math.min(...after) : null;
}

/** When a request has no read left to want. */
export const endOf = (r: ObserveRequest): number => Date.parse(r.window.to) + Math.max(0, ...r.reread) * MIN;

/** When the request was taken on (ms); 0 when that is not known. */
const sinceOf = (r: ObserveRequest): number => Date.parse(r.since ?? "") || 0;

/** Until when a request is read: its last due read, or when it was taken on if later (a past window), and the grace after. */
export const deadlineOf = (r: ObserveRequest, graceMs: number): number => Math.max(endOf(r), sinceOf(r)) + graceMs;

/** A request still read: its window begun, its deadline not passed. What schedules reads and what tells of an outage both go by it. */
export const live = (r: ObserveRequest, graceMs: number, nowMs: number): boolean => Date.parse(r.window.from) <= nowMs && nowMs <= deadlineOf(r, graceMs);

/** A read is wanted now: an instant one is wanted at has come since the last read. */
export function wanted(r: ObserveRequest, everyMs: number, nowMs: number, readAtMs: number | null): boolean {
  const due = lastDue(r, everyMs, nowMs);
  return due !== null && (readAtMs === null || readAtMs < due);
}

/**
 * What an observation comes to now. `r`: the request in force (null: none any more, the item's
 * own window is used and no read is wanted); `readAt`: when the item was last read. `graceMs`: how
 * long after a read was due it may still be on its way (a poll a few minutes late, a slow command);
 * `maxLagMs`: how far the data may lag behind the read and still count; `failure`: why the last
 * read of it failed, if it did; `occupied`: its key is read for another case's request.
 */
export function conclude(
  r: ObserveRequest | null,
  item: Item | null,
  readAt: string | null,
  o: { everyMs: number; graceMs: number; maxLagMs: number; nowMs: number; tz: string; failure?: string | null; occupied?: boolean },
): Concluded {
  const reported = item && (VERDICTS as readonly string[]).includes(item.fields.verdict ?? "") ? (item.fields.verdict as ObserveVerdict) : null;
  const window = r?.window ?? (item?.fields["window.from"] && item.fields["window.to"] ? { from: item.fields["window.from"], to: item.fields["window.to"] } : null);
  let numbers: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(item?.fields.numbers || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) numbers = parsed as Record<string, unknown>;
  } catch {
    // kept as it came, so it parses; a hand-made item that does not is read as nothing found out
  }
  const notes: string[] = [];
  for (let i = 0; item?.fields[`notes.${i}`] !== undefined; i++) notes.push(item.fields[`notes.${i}`]!);
  const hm = (ms: number) => iso(ms, o.tz).slice(5, 16).replace("T", " ");
  const freshUntil = item?.fields.freshUntil || null;
  const failure = o.failure ?? null;
  const because = failure ? `：${failure}` : "";
  const base = { reported, readAt, freshUntil, window, numbers, notes, failure: null };
  const deadline = r ? deadlineOf(r, o.graceMs) : null;
  // What was read for another request of the same key (a step before, other params) is not this one's.
  const other = r && item && item.fields.request !== requestVersion(r);
  if (!item || !readAt || !reported || other) {
    const over = deadline !== null && o.nowMs > deadline;
    return {
      ...base,
      ...(other ? { reported: null, numbers: {}, notes: [], freshUntil: null, readAt: null } : {}),
      failure,
      verdict: "insufficient-data",
      why: over ? "gave-up" : "none-yet",
      // Its key read for another case's request: its own was never tried.
      whyText: o.occupied ? "这个 key 被另一个事项占用，没有读" : over ? `一直没读到，${hm(deadline)} 以后不再读了${because}` : `还没读到${because}`,
    };
  }
  const readMs = Date.parse(readAt);
  let why: NotCurrent | null = null;
  let whyText: string | null = null;
  const due = r ? lastDue(r, o.everyMs, o.nowMs) : null;
  const unread = due !== null && readMs < due;
  if (unread && deadline !== null && o.nowMs > deadline) {
    why = "gave-up";
    whyText = `${hm(due)} 该读的一直没读成，${hm(deadline)} 以后不再读了（上次读到是 ${hm(readMs)}）${because}`;
  } else if (unread && o.nowMs - Math.max(due, r ? sinceOf(r) : 0) > o.graceMs) {
    // Owed from when it was due, or from when the request was taken on, if that was later.
    why = "not-read";
    whyText = `${hm(due)} 该读的没读到（上次读到是 ${hm(readMs)}）${because}`;
  } else if (!freshUntil || Number.isNaN(Date.parse(freshUntil)) || Date.parse(freshUntil) < readMs - o.maxLagMs) {
    why = "lagging";
    whyText = freshUntil && !Number.isNaN(Date.parse(freshUntil)) ? `数据只到 ${hm(Date.parse(freshUntil))}` : "不知道数据到了哪里";
  } else if (window && readMs < Date.parse(window.to)) {
    why = "window-open";
    whyText = `还没观察满（到 ${hm(Date.parse(window.to))}）`;
  }
  // Only "nothing found" needs everything to be in: a problem seen stays seen.
  const verdict: ObserveVerdict = why !== null && reported === "no-signal" ? "insufficient-data" : reported;
  return { ...base, failure: why === "not-read" || why === "gave-up" ? failure : null, verdict, why, whyText };
}
