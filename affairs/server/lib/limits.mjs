import { listIds, read } from "./log.mjs";
import { localParts, parseLocal } from "./time.mjs";

// How often and how much may be looked: counted from the logs, so the same numbers hold whoever asks.

const HOUR = 3_600_000;

/** A run's end is one extra look, until that reason is taken up by a look. */
export const flowLook = (reasons) => reasons.some((why) => /^ring:flow:/.test(why));

/** The start of the current counting day: the last dayStartHour o'clock local. */
/** @returns {number} */
export function dayStart(now, tz, hour) {
  const p = localParts(now, tz);
  const today = /** @type {number} */ (parseLocal(`${p.date} ${String(hour).padStart(2, "0")}:00`, tz));
  return today <= now ? today : today - 86_400_000;
}

// Every look is counted from the line the command writes when it starts, a scheduled one as much as one a person asked for.
// The money is an estimate per look (policy.roles.<role>.estimateUsd, written on that line) until the real cost is known:
// a run that ended with a number of its own replaces the estimate.
function tally(lines, since) {
  const out = { looks: 0, usd: 0, bursts: 0, hour: 0, resetAt: 0 };
  let estimated = 0;
  let wakeSinceEnd = false;
  for (const l of lines) {
    const t = Date.parse(l.at);
    if (l.kind === "breaker.reset") out.resetAt = t;
    if (l.kind === "wake") wakeSinceEnd = true;
    if (l.kind === "wake.end" && !wakeSinceEnd && t >= since.day) {
      out.looks += 1;
      if (t >= since.hour) { out.hour += 1; out.bursts += 1; }
    }
    if (l.kind === "wake.end") wakeSinceEnd = false;
    if (l.kind === "wake" && t >= since.day) {
      out.looks += 1;
      estimated = typeof l.estUsd === "number" ? l.estUsd : 0;
      out.usd += estimated;
      if (t >= since.hour) {
        out.hour += 1;
        if (!(l.why?.length === 1 && l.why[0] === "time")) out.bursts += 1;
      }
    }
    // What the chat costs counts toward the day's money, so that the looks stop first; the chat itself is never stopped.
    if (l.kind === "chat.turn" && t >= since.day && typeof l.usd === "number") out.usd += l.usd;
    if (l.kind === "wake.end" && t >= since.day && typeof l.usd === "number") {
      out.usd += l.usd - estimated;
      estimated = 0;
    }
  }
  return out;
}

export function counts(root, now, policy) {
  const since = { day: dayStart(now, policy.tz, policy.limits.dayStartHour), hour: now - HOUR };
  /** @type {Record<string, { looks: number, usd: number, bursts: number, hour: number, resetAt: number }>} */
  const per = {};
  const total = { looks: 0, usd: 0, hour: 0 };
  for (const id of listIds(root)) {
    const t = tally(read(root, id), since);
    per[id] = t;
    total.looks += t.looks;
    total.usd += t.usd;
    total.hour += t.hour;
  }
  return { per, total, since };
}

/** Whether one more look may start now. `force` is a person asking for one more today; it does not lift the total. */
export function mayLook(root, id, now, policy, { force = false } = {}) {
  const lim = policy.limits;
  const { per, total, since } = counts(root, now, policy);
  const mine = per[id] ?? { looks: 0, usd: 0 };
  const next = since.day + 86_400_000;
  const tomorrow = `明早 ${lim.dayStartHour} 点`;
  if (total.looks >= lim.totalPerDay || total.usd >= lim.totalUsdPerDay) return { ok: false, until: next, text: `今天一共看了 ${total.looks} 次，${tomorrow}接着看` };
  if (!force && mine.looks >= lim.perAffairPerDay) return { ok: false, until: next, text: `今天看了 ${mine.looks} 次，${tomorrow}接着看` };
  if (!force && mine.usd >= lim.perAffairUsdPerDay) return { ok: false, until: next, text: `今天花到上限了（$${lim.perAffairUsdPerDay}），${tomorrow}接着看。要多看就说「今天再看一次」` };
  return { ok: true };
}

/** Looking far too often: everything stops (the plugin pauses the schedules) until a person says go on. */
export function tripped(root, now, policy, id = "") {
  const lim = policy.limits;
  const { per, total } = counts(root, now, policy);
  // Someone said "go on" for this one: it is not stopped again for an hour (it can still be stopped by the day's limits).
  if (id && per[id]?.resetAt && now - per[id].resetAt < HOUR) return { tripped: false, text: "" };
  if (total.hour > lim.breakerPerHour) return { tripped: true, text: `一小时内看了 ${total.hour} 次，比平时多得多` };
  const noisy = Object.entries(per).find(([k, t]) => (!id || k === id) && t.bursts > lim.burstPerAffairPerHour);
  if (noisy) return { tripped: true, text: `${noisy[0]} 一小时内被催着看了 ${noisy[1].bursts} 次` };
  return { tripped: false, text: "" };
}
