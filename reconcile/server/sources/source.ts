import type { Domain, Item } from "../../shared/model";

// What a source is to the core. A source normalizes what an outside system says into item
// snapshots; the core diffs them against the last ones and records the changes. A source gets
// no store and cannot notify anyone; it only answers polls.

export interface PollInput {
  cursor: unknown;
  /** Native ids the core also wants read this time (followed by commitments, not by the source's own query). */
  watch: string[];
  now: string;
  nowMs: number;
  /** Calls this poll may make before the hourly budget is spent. */
  callsLeft: number;
  /**
   * What to do with a listed row, for a source that lists before it reads: read it in full,
   * only look at who changed it last ("people"), or leave it. Absent: read what changed.
   */
  decide?(row: ListedRow): "full" | "people" | "skip";
  /** For "people": a change by a person at or after this instant makes the row worth a full read. */
  humanSince?: string;
}

/** One row of a source's list: enough to decide whether the item is worth a full read. */
export interface ListedRow {
  key: string;
  title: string;
  status: string;
  /** As the source lists it; compared with the last full read. */
  updatedOn: string;
  changed: boolean;
  /** The configured list columns, by the field name a full read gives them. */
  columns: Record<string, string>;
}

export interface Poll {
  snapshots: Item[];
  cursor: unknown;
  calls: number;
  /** Per-item failures that did not fail the poll; those items are retried next time. */
  errors: string[];
  /** More is waiting than the budget allowed this time. */
  more: boolean;
}

export interface Source {
  id: string;
  domain: Domain;
  poll(input: PollInput): Promise<Poll>;
}
