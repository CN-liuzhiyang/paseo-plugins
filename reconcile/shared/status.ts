import type { Assessment, Commitment, SourceHealth } from "./model";

// What the controller reports each reconcile: status.json on disk, the overview RPC, the screen.
// Here and not in server/ because the client reads it: the plugin compiler keeps every server/
// module, type-only imports included, out of the client bundle.

export interface PlanEntry {
  at: string;
  kind: "card" | "deferred" | "commitment" | "skipped" | "note" | "held" | "expire" | "notice";
  person: string | null;
  summary: string;
}

/** How a plan entry's kind reads, on the screen and in plan.md. */
export const PLAN_LABEL: Record<PlanEntry["kind"], string> = {
  card: "发卡",
  deferred: "先不发",
  commitment: "承诺",
  skipped: "没建",
  note: "记事实",
  held: "挂起",
  expire: "到期",
  notice: "提醒",
};

/** A rules change the breaker held: how many commitments it would create, cancel, change and open again at once. */
export interface RulesHeld {
  fingerprint: string;
  newCommitments: number;
  dropped: number;
  changed: number;
  reopened: number;
  at: string;
}

export function describeChanges(c: Pick<RulesHeld, "newCommitments" | "dropped" | "changed" | "reopened">): string {
  const parts = [
    c.newCommitments > 0 ? `新建 ${c.newCommitments}` : "",
    c.dropped > 0 ? `撤掉 ${c.dropped}` : "",
    c.changed > 0 ? `改动 ${c.changed}` : "",
    c.reopened > 0 ? `重开 ${c.reopened}` : "",
  ].filter(Boolean);
  return `${parts.join("、") || "改动 0"} 条承诺`;
}

export interface StatusCase {
  caseId: string;
  title: string;
  url: string | null;
  status: string;
  closed: boolean;
  observedAt: string;
  assessment: Assessment | null;
  commitments: Array<{ id: string; title: string; status: Commitment["status"]; step: string; answer: string | null; reason: string | null }>;
  open: boolean;
  /** Why it is judged and shown (hot); see server/heat.ts. */
  hot: string[];
}

/**
 * What is wrong with the controller itself, for the page: late when it has not reconciled for two
 * of its periods, or when a reconcile has run for longer than any should (max of 10 minutes and
 * five periods: one stuck on a call that never returns); and the sources in trouble.
 */
export function troubleOf(status: Status): { late: boolean; stuck: boolean; sources: Status["sources"] } {
  const nowMs = Date.parse(status.now);
  const periodMs = status.tickSeconds * 1000;
  const stuck = status.ticking && status.tickStartedAt !== null && nowMs - Date.parse(status.tickStartedAt) > Math.max(10 * 60_000, 5 * periodMs);
  const late = stuck || (!status.ticking && (status.lastTickAt === null || nowMs - Date.parse(status.lastTickAt) > 2 * periodMs));
  return { late, stuck, sources: status.sources.filter((s) => s.state !== "ok" || s.lastError) };
}

export interface Status {
  instanceId: string;
  mode: "live" | "dry-run";
  now: string;
  lastTickAt: string | null;
  /** A reconcile is running now, and since when: a long one is not a stuck one, up to troubleOf's limit. */
  ticking: boolean;
  tickStartedAt: string | null;
  tickSeconds: number;
  sources: Array<{ id: string; state: SourceHealth["state"]; lastOkAt: string | null; lastError: string | null; nextPollAt: string | null; callsLastHour: number }>;
  rules: {
    fingerprint: string | null;
    files: string[];
    errors: Array<{ file: string; error: string }>;
    held: RulesHeld | null;
  };
  calendarYears: string[];
  problems: string[];
  cards: Array<{ id: string; person: string; title: string; agentId: string | null; status: string; raisedAt: string; questions: number; caseIds: string[] }>;
  cases: StatusCase[];
  /** Cases not judged this reconcile: nothing about them matters now. */
  cold: Array<{ caseId: string; title: string; status: string; observedAt: string }>;
  openCommitments: number;
  plan: PlanEntry[];
  evals: number;
  pushesToday: Record<string, number>;
}
