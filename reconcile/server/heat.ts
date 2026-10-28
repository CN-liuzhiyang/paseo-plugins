import type { Item } from "../shared/model";
import { localParts, zoned } from "./time";

// Hot or cold. A hot item is judged every reconcile and shown; a cold one is left alone -- not
// judged, not shown, not read again -- until something that matters about it changes. Hot is
// any of: an open commitment, watched, changed by a person lately, a date field near today, a
// linked flag key changed lately. Everything else is an old item nobody is working on.

export interface HeatPolicy {
  recentDays: number;
  dateWindowDays: number;
  dateFields: string[];
}

export interface HeatInputs {
  nowMs: number;
  tz: string;
  policy: HeatPolicy;
  open: boolean;
  watched: boolean;
  /** When a flag key linked to the item last changed. */
  flagChangedAt: string | null;
  /** Its title marks it as a container or a standing item: only a commitment or the watch list count. */
  quiet?: boolean;
  /** The latest time another case woke this one, and why. */
  woken?: { at: string; reason: string } | null;
  /** A flow started for it is still running: its result is judged when it comes. */
  flowing?: boolean;
  /** It is a matter a person told the controller to follow (source desk) and it has not ended: hot until it does, whatever else is or is not the case. */
  standing?: boolean;
}

const DAY = 86_400_000;

/** The first YYYY-MM-DD at the start of a field, as noon in the zone (so a day either side is whole). */
function dateOf(value: string | undefined, tz: string): number | null {
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? "")?.[1];
  return date ? zoned(date, "12:00", tz) : null;
}

/** Why the item is hot; empty when it is cold. */
export function heatOf(item: Pick<Item, "fields" | "lastHumanAt">, inputs: HeatInputs): string[] {
  const { nowMs, tz, policy } = inputs;
  const reasons: string[] = [];
  if (inputs.open) reasons.push("有没问完的问题");
  if (inputs.watched) reasons.push("在关注列表里");
  if (inputs.flowing) reasons.push("有流程在跑");
  if (inputs.standing) reasons.push("你交代的事，结束前一直盯着");
  if (inputs.quiet) return reasons;
  if (item.lastHumanAt && nowMs - Date.parse(item.lastHumanAt) <= policy.recentDays * DAY) reasons.push(`${item.lastHumanAt.slice(5, 10)} 有人改过`);
  const today = zoned(localParts(nowMs, tz).date, "12:00", tz);
  for (const field of policy.dateFields) {
    const at = dateOf(item.fields[field], tz);
    if (at !== null && Math.abs(at - today) <= policy.dateWindowDays * DAY) {
      reasons.push(`${field} ${item.fields[field]!.slice(5, 10)} 在前后 ${policy.dateWindowDays} 天内`);
      break;
    }
  }
  if (inputs.flagChangedAt && nowMs - Date.parse(inputs.flagChangedAt) <= policy.recentDays * DAY) reasons.push(`关联的开关 ${inputs.flagChangedAt.slice(5, 10)} 变过`);
  if (inputs.woken && nowMs - Date.parse(inputs.woken.at) <= policy.recentDays * DAY) reasons.push(`${inputs.woken.reason}（${inputs.woken.at.slice(5, 10)}）`);
  return reasons;
}

/** A listed row's local "YYYY-MM-DD HH:mm" (or an ISO instant) as ms; null when unreadable. */
export function listedAt(value: string, tz: string): number | null {
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(value.trim());
  if (local) return zoned(local[1]!, local[2]!, tz);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
