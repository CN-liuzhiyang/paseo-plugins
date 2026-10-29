import type { ListRow } from "./graph";
import type { Annotation, Assessment, Commitment, SourceHealth } from "./model";

// What the controller reports each reconcile: status.json on disk, the overview RPC, the screen.
// Here and not in server/ because the client reads it: the plugin compiler keeps every server/
// module, type-only imports included, out of the client bundle.

export interface PlanEntry {
  at: string;
  kind: "card" | "deferred" | "commitment" | "skipped" | "note" | "held" | "expire" | "notice" | "said" | "flow";
  person: string | null;
  summary: string;
}

/** How a plan entry's kind reads, on the screen and in plan.md. */
export const PLAN_LABEL: Record<PlanEntry["kind"], string> = {
  card: "发卡",
  deferred: "先不发",
  commitment: "排上",
  skipped: "没排",
  note: "记事实",
  held: "先停着",
  expire: "到期",
  notice: "提醒",
  said: "对话里说的",
  flow: "流程",
};

/** A rules change the breaker held: how many commitments it would create, cancel, change and open again at once. */
export interface RulesHeld {
  fingerprint: string;
  newCommitments: number;
  dropped: number;
  changed: number;
  reopened: number;
  /** Runs of flows it would start at once; absent in a hold from before they were counted. */
  flows?: number;
  at: string;
}

export function describeChanges(c: Pick<RulesHeld, "newCommitments" | "dropped" | "changed" | "reopened"> & { flows?: number }): string {
  const parts = [
    c.newCommitments > 0 ? `新排 ${c.newCommitments}` : "",
    c.dropped > 0 ? `收回 ${c.dropped}` : "",
    c.changed > 0 ? `改动 ${c.changed}` : "",
    c.reopened > 0 ? `重新排上 ${c.reopened}` : "",
  ].filter(Boolean);
  const asks = `${parts.join("、") || "改动 0"} 个要问的问题`;
  return c.flows && c.flows > 0 ? `${parts.length > 0 ? `${asks}，` : ""}起 ${c.flows} 个流程（要花钱）` : asks;
}

export interface StatusSaid {
  id: string;
  caseId: string;
  title: string;
  kind: Annotation["kind"];
  /** How the kind reads: 不再追踪, 先别问, 判断错了, 交代, 补一句. */
  label: string;
  said: string;
  by: string;
  at: string;
  until: string | null;
  how: "own-words" | "confirmed" | "confirmed-here";
  inForce: boolean;
  revokedAt: string | null;
}

/** One look of a matter a person told (desk.log): when, what it read, the status it left, and the time it chose for the next. */
export interface StatusPass {
  n: number;
  at: string;
  looked: string;
  status: string;
  next: string;
}

/** A question asked and waiting for an answer: its number is what a reply names (engine.ts questionNumbers). */
export interface StatusQuestion {
  no: string;
  commitmentId: string;
  /** The item it is about; null for what the controller asks of itself. */
  item: string | null;
  itemTitle: string | null;
  header: string;
  question: string;
  options: string[];
  allowOther: boolean;
  /** When it was last asked (put on a card). */
  askedAt: string | null;
  /** How many times it has been asked. */
  round: number;
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
  /** What the list shows of it (shared/graph.ts); null when the item is unknown to the book. */
  row: ListRow | null;
  /** A matter a person told: its last three looks, oldest first (the log keeps ten); absent for the rest. */
  passes?: StatusPass[];
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

/**
 * How many things want the person now: the items in the list's group "要你做的", and the cards raised that belong to no item (the test card).
 * The sidebar's number, and the same as what the page shows under that heading.
 */
export function attentionOf(status: Pick<Status, "cases" | "cards">): number {
  const items = status.cases.filter((k) => k.row?.group === "me").length;
  const loose = status.cards.filter((c) => c.agentId && c.caseIds.length === 0).length;
  return items + loose;
}

/** The number as the sidebar's badge writes it: "9+" past nine, so that the badge stays small. */
export const countLabel = (count: number): string => (count > 9 ? "9+" : String(count));

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
    /** fallback: the file does not load, and the copy of it that last did (saved then) runs instead. */
    errors: Array<{ file: string; error: string; fallback?: string }>;
    held: RulesHeld | null;
  };
  calendarYears: string[];
  problems: string[];
  cards: Array<{ id: string; person: string; title: string; agentId: string | null; status: string; raisedAt: string; questions: number; caseIds: string[] }>;
  cases: StatusCase[];
  /** The questions waiting for an answer, oldest first, with their numbers. */
  questions: StatusQuestion[];
  /** Cases not judged this reconcile: nothing about them matters now. */
  cold: Array<{ caseId: string; title: string; status: string; observedAt: string }>;
  openCommitments: number;
  plan: PlanEntry[];
  /** The runs of flows started for items that are not over, and those over in the last three days. */
  flows: Array<{ runId: string; caseId: string; label: string; round: number; state: string; intentAt: string; endedAt: string | null; costUsd: number; why: string | null }>;
  evals: number;
  pushesToday: Record<string, number>;
  /** Confirmation cards raised today, per admin; they have their own budget (policy.confirmPerDay). */
  confirmsToday: Record<string, number>;
  /**
   * What people said in conversations about items: those in force, and those taken back in the
   * last 7 days. A session reads this to find the id to take one back by.
   */
  said: StatusSaid[];
}
