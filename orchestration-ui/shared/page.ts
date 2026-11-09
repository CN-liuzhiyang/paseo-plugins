// The 流程 page's list of what has run lately: the flow bar's four groups (等你 / 在跑 / 停了 / 完成), one line
// each, and whatever is too old or already carried on by a later run folded away. Pure; `now` is handed in.

import { BAR_ORDER, BAR_TITLE, groupOf, supersededRuns, type BarGroup } from "./bar";
import type { RunSummary } from "./rpc";

/** A finished run older than this is under "更早的". */
export const PAGE_DONE_DAYS = 3;
/** A run that stopped or failed stays up front this long, unless a later run carried it on. */
export const PAGE_STOPPED_DAYS = 7;

const DAY = 24 * 60 * 60_000;

export interface PageGroup {
  group: BarGroup;
  title: string;
  runs: RunSummary[];
}

export interface PageRuns {
  groups: PageGroup[];
  /** Newest first: too old, carried on by a later run, or not a run file at all. */
  older: RunSummary[];
}

function lastAt(run: RunSummary): number {
  return Date.parse(run.card?.endedAt ?? run.lastEventAt ?? run.startedAt ?? "") || 0;
}

export function pageRuns(runs: readonly RunSummary[], now: number): PageRuns {
  const superseded = supersededRuns(runs);
  const front: Array<{ group: BarGroup; run: RunSummary }> = [];
  const older: RunSummary[] = [];
  for (const run of runs) {
    const card = run.card;
    if (!card || superseded.has(run.runId)) {
      older.push(run);
      continue;
    }
    const group = groupOf(card);
    const age = lastAt(run) === 0 ? 0 : now - lastAt(run);
    if ((group === "done" && age > PAGE_DONE_DAYS * DAY) || (group === "stopped" && age > PAGE_STOPPED_DAYS * DAY)) older.push(run);
    else front.push({ group, run });
  }
  const newest = (a: RunSummary, b: RunSummary) => (Date.parse(b.startedAt ?? "") || 0) - (Date.parse(a.startedAt ?? "") || 0);
  return {
    groups: BAR_ORDER.map((group) => ({
      group,
      title: BAR_TITLE[group],
      runs: front.filter((entry) => entry.group === group).map((entry) => entry.run).sort(newest),
    })).filter((entry) => entry.runs.length > 0),
    older: older.sort(newest),
  };
}

/** "停了 · 10-30 · 7 次": a flow's newest run, when, and how many there are; the date is the caller's to format. */
export function flowStanding(label: string, when: string | null, count: number): string {
  return [label, when, count > 0 ? `${count} 次` : null].filter(Boolean).join(" · ");
}
