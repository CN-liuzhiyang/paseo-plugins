import type { Item, ObserveRequest, ObserveVerdict } from "../shared/model";
import { iso } from "./time";

// What an observing source is asked to read and when, and what a rule is told it found.
// The command says what it concluded; whether that may be taken as found is the controller's to
// say. "Nothing found" stands only for a window watched to its end, on data read when a read was
// due and not lagging far behind what it covers. Anything less is "too little to tell": nothing
// seen is not nothing there. A problem the command found is never taken back this way; it is only
// marked as not current.

export const VERDICTS = ["no-signal", "needs-look", "hard-fail", "insufficient-data"] as const;

/** Why what was found is not current, as a code and in words; null: it is. */
export type NotCurrent = "none-yet" | "window-open" | "not-read" | "lagging";

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
}

const MIN = 60_000;

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

/** A read is wanted now: an instant one is wanted at has come since the last read. */
export function wanted(r: ObserveRequest, everyMs: number, nowMs: number, readAtMs: number | null): boolean {
  const due = lastDue(r, everyMs, nowMs);
  return due !== null && (readAtMs === null || readAtMs < due);
}

/**
 * What an observation comes to now. `r`: the request in force (null: none any more, the item's
 * own window is used and no read is wanted); `readAt`: when the item was last read. `graceMs`: how
 * long after a read was due it may still be on its way (a poll a few minutes late, a slow command);
 * `maxLagMs`: how far the data may lag behind the read and still count.
 */
export function conclude(
  r: ObserveRequest | null,
  item: Item | null,
  readAt: string | null,
  o: { everyMs: number; graceMs: number; maxLagMs: number; nowMs: number; tz: string },
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
  const base = { reported, readAt, freshUntil, window, numbers, notes };
  // What was read for another window of the same key (a step before) is not this one's.
  const other = r && item && (item.fields["window.from"] !== r.window.from || item.fields["window.to"] !== r.window.to);
  if (!item || !readAt || !reported || other) return { ...base, reported: other ? null : reported, numbers: other ? {} : numbers, notes: other ? [] : notes, freshUntil: other ? null : freshUntil, verdict: "insufficient-data", why: "none-yet", whyText: "还没读到" };
  const readMs = Date.parse(readAt);
  let why: NotCurrent | null = null;
  let whyText: string | null = null;
  const due = r ? lastDue(r, o.everyMs, o.nowMs) : null;
  if (due !== null && readMs < due && o.nowMs - due > o.graceMs) {
    why = "not-read";
    whyText = `${hm(due)} 该读的没读到（上次读到是 ${hm(readMs)}）`;
  } else if (!freshUntil || Number.isNaN(Date.parse(freshUntil)) || Date.parse(freshUntil) < readMs - o.maxLagMs) {
    why = "lagging";
    whyText = freshUntil && !Number.isNaN(Date.parse(freshUntil)) ? `数据只到 ${hm(Date.parse(freshUntil))}` : "不知道数据到了哪里";
  } else if (window && readMs < Date.parse(window.to)) {
    why = "window-open";
    whyText = `还没观察满（到 ${hm(Date.parse(window.to))}）`;
  }
  // Only "nothing found" needs everything to be in: a problem seen stays seen.
  const verdict: ObserveVerdict = why !== null && reported === "no-signal" ? "insufficient-data" : reported;
  return { ...base, verdict, why, whyText };
}
