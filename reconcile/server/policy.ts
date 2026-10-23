import type { Person } from "./config";
import type { Card, Commitment, Domain } from "../shared/model";
import { addDays, addWorkdays, localParts, nextInWindow, zoned, type Calendar } from "./time";

// should_wake, the deterministic half: given what the commitments want and what has been done,
// may a card go to this person now? Pure functions of (state, now); no model, no I/O.

export interface Due {
  commitment: Commitment;
  round: number;
  /** Why now: the first ask, a nag after no answer, or the same round again after a hold took it off its card. */
  why: "first" | "nag" | "again";
  /** Asked again: the hold it was asked again after, so that the ledger tells this ask from the first. */
  after?: string;
}

/**
 * When a commitment next wants something, and what. Null when it wants nothing more.
 * `again`: when the hold that took this question off its card, after it was asked, ends. The same
 * round is asked again then -- the question was on a card the person was told not to mind, so it
 * does not count as a nag, and a question asked its last round is not lost to the hold.
 */
export function nextStep(c: Commitment, tz: string, calendar: Calendar, again: number | null = null): { atMs: number; what: "ask" | "nag" | "again" | "backstop" | "exhausted"; round: number } | null {
  if (c.status !== "scheduled" && c.status !== "waiting") return null;
  const backstop = Date.parse(c.backstop.at);
  if (c.status === "scheduled") {
    if (!("at" in c.trigger)) return { atMs: backstop, what: "backstop", round: 0 };
    return { atMs: Math.min(Date.parse(c.trigger.at), backstop), what: Date.parse(c.trigger.at) <= backstop ? "ask" : "backstop", round: 1 };
  }
  if (again !== null && c.lastAskedAt && again < backstop) return { atMs: again, what: "again", round: c.rounds };
  if (c.rounds >= c.nag.max || !c.lastAskedAt) return { atMs: backstop, what: c.rounds >= c.nag.max ? "exhausted" : "backstop", round: c.rounds };
  const nag = addWorkdays(Date.parse(c.lastAskedAt), c.nag.everyWorkdays, c.nag.at, tz, calendar);
  return nag < backstop ? { atMs: nag, what: "nag", round: c.rounds + 1 } : { atMs: backstop, what: "backstop", round: c.rounds };
}

export function dueNow(c: Commitment, nowMs: number, tz: string, calendar: Calendar, again: number | null = null): Due | null {
  if (c.level === "silent") return null;
  const step = nextStep(c, tz, calendar, again);
  if (!step || step.atMs > nowMs) return null;
  if (step.what === "ask") return { commitment: c, round: 1, why: "first" };
  if (step.what === "nag") return { commitment: c, round: step.round, why: "nag" };
  if (step.what === "again") return { commitment: c, round: step.round, why: "again" };
  return null;
}

export function backstopPassed(c: Commitment, nowMs: number): boolean {
  return (c.status === "scheduled" || c.status === "waiting") && Date.parse(c.backstop.at) <= nowMs;
}

export type Verdict = { send: true } | { send: false; until: number; reason: "quiet" | "budget" };

/** Whether a card may go to this person now, for commitments of these domains; `cap` is the day's budget the count is against. */
export function mayReach(person: Person, domains: Domain[], cardsToday: number, nowMs: number, calendar: Calendar, cap = person.pushPerDay): Verdict {
  let until = nowMs;
  for (const domain of new Set(domains)) {
    const window = person.windows[domain];
    if (window) until = Math.max(until, nextInWindow(nowMs, window, person.tz, calendar));
  }
  if (until > nowMs) return { send: false, until, reason: "quiet" };
  if (cardsToday >= cap) {
    const tomorrow = addDays(localParts(nowMs, person.tz).date, 1);
    return { send: false, until: nextMorning(tomorrow, person, domains, calendar), reason: "budget" };
  }
  return { send: true };
}

function nextMorning(date: string, person: Person, domains: Domain[], calendar: Calendar): number {
  const midnight = zoned(date, "00:00", person.tz);
  let until = midnight;
  for (const domain of new Set(domains)) {
    const window = person.windows[domain];
    if (window) until = Math.max(until, nextInWindow(midnight, window, person.tz, calendar));
  }
  return until;
}

/**
 * When a question that wants asking at `dueMs` reaches the person: from then, or now if that is
 * later, the first moment `mayReach` lets a card go -- their quiet hours for its domain, and the
 * day's budget as it stands (a later day's starts empty). Questions due together go on one card,
 * so that moves nothing. What the page says is next is this, and asking goes by the same verdict.
 */
export function reachesAt(person: Person, domain: Domain, dueMs: number, nowMs: number, cards: Card[], calendar: Calendar, confirm: boolean, cap: number): { atMs: number; why: "quiet" | "budget" | null } {
  let atMs = Math.max(dueMs, nowMs);
  let why: "quiet" | "budget" | null = null;
  for (let i = 0; i < 31; i++) {
    const verdict = mayReach(person, [domain], confirm ? confirmsToday(cards, person, atMs) : cardsToday(cards, person, atMs), atMs, calendar, cap);
    if (verdict.send) return { atMs, why };
    atMs = verdict.until;
    why ??= verdict.reason;
  }
  return { atMs, why };
}

/** Cards of questions raised for a person on their local today; one that never got a carrier did not reach them, and one cut down from another is that one. */
export function cardsToday(cards: Card[], person: Person, nowMs: number): number {
  return raisedToday(cards.filter((card) => card.kind !== "confirm"), person, nowMs);
}

/** Confirmation cards raised for a person on their local today: a budget of their own. */
export function confirmsToday(cards: Card[], person: Person, nowMs: number): number {
  return raisedToday(cards.filter((card) => card.kind === "confirm"), person, nowMs);
}

function raisedToday(cards: Card[], person: Person, nowMs: number): number {
  const today = localParts(nowMs, person.tz).date;
  return cards.filter((card) => card.person === person.id && !card.cutFrom && !(card.status === "closed" && card.agentId === null) && localParts(Date.parse(card.raisedAt), person.tz).date === today).length;
}
