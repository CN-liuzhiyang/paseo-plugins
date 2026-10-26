// The objects the controller keeps. Facts come from outside (items, observations); what we add
// is notes and commitments; what we did is the ledger. Assessments are recomputed every
// reconcile and kept only so people can see the latest one. See README.md for the model.

export type Trust = "source" | "derived" | "human" | "agent";
export type Domain = "work" | "personal" | "family";

/** A cached view of something an outside system owns. The source is the authority, not this. */
export interface Item {
  key: string; // "<source id>:<native id>"
  source: string;
  kind: string;
  title: string;
  url: string | null;
  status: string;
  closed: boolean;
  /** Named fields the rules read, normalized to strings ("" when empty). */
  fields: Record<string, string>;
  /** People by role, e.g. { assignee: ["…"], qa: ["…", "…"] }. */
  people: Record<string, string[]>;
  parent: string | null;
  sourceUpdatedAt: string | null;
  observedAt: string;
  /** Plain text to search for names (title, description, fields), capped. */
  text?: string;
  /** Linked commits that could not be read, read after read: the item is kept without them. */
  incomplete?: string[];
  /** Changes in version control that the source links to this item, newest first. */
  revisions?: Revision[];
  /** The last change made by a person rather than an automation, when the source can tell. */
  lastHumanAt?: string | null;
  /** Free labels a source attaches, e.g. a flag file's environment and region. */
  labels?: Record<string, string>;
}

/** One commit, read once: where it landed and which names it brought in. */
export interface Revision {
  id: string; // as the source names it, e.g. "<repo>-<number>"
  repo: string;
  /** The configured branch it was committed on; null when none of them has it. */
  branch: string | null;
  /**
   * Every configured branch whose history has it, with the revision and time it got there: its
   * own for a commit made there, the copy's for one a branch got by copying another.
   */
  in?: Record<string, { rev: number; at: string }>;
  /**
   * For a branch made by copying from the one it was committed on: the latest copy into it as last
   * seen (its revision, time, and the revision copied from), whether it brought this one or not,
   * and when it was last seen to be the latest. Such a copy is a freeze: what it did not bring has
   * to be merged into that branch separately.
   */
  copied?: Record<string, { rev: number; at: string; from: number; seen: string }>;
  at: string;
  author: string;
  summary: string;
  /** Identifiers on added lines that no removed line has, each with the first such line. */
  added: Array<[string, string]>;
  /**
   * The files it changed, relative to the branch it was committed on (the repository's path when
   * not under it), with how: A added, M modified, D deleted, R replaced. Capped; absent in revisions
   * read before it was kept.
   */
  files?: Array<{ path: string; action: "A" | "M" | "D" | "R" }>;
}

/** What an observation can conclude: nothing found, something to look at, a failure, or too little to tell. */
export type ObserveVerdict = "no-signal" | "needs-look" | "hard-fail" | "insufficient-data";

/**
 * A rule's request that an observing source (a "command" source) watch something for a case:
 * every few minutes from `window.from` to `window.to`, then once at each of `reread` (minutes after
 * the window). `params` goes to the command as it is; the controller does not read it.
 */
export interface ObserveRequest {
  source: string;
  key: string;
  window: { from: string; to: string };
  reread: number[];
  params: Record<string, unknown>;
  /** When the controller took this request as it is (its source, key, window and params) on: what failed before then is not its. Absent in older ones. */
  since?: string;
}

/** "This source said this at that time." Append-only. */
export interface Observation {
  id: string; // source-native when there is one, else a content hash
  at: string; // when it happened, by the source
  seenAt: string;
  /** When the item was last read before, still without this change: it came after then. Absent in older ones. */
  readBefore?: string;
  source: string;
  key: string;
  kind: "changed" | "signal" | "answer" | "report";
  trust: Trust;
  actor: { name: string; machine: boolean } | null;
  changes: Array<{ field: string; from: string; to: string }>;
  text: string | null;
}

/** Something we know that the outside system does not record. */
export interface Note {
  key: string;
  field: string;
  value: string;
  kind: "fact" | "opinion";
  basis: "source-derived" | "human" | "agent";
  by: string;
  /** For a fact a rule wrote: the fingerprint of the rules that wrote it. */
  rules?: string;
  at: string;
  evidence: string | null;
}

export interface AskOption {
  id: string;
  label: string;
  description: string;
}

export interface Ask {
  person: string;
  /** Short, unique on one card: the app keys answers by it. */
  header: string;
  question: string;
  options: AskOption[];
  allowOther: boolean;
}

export type Trigger = { at: string } | { manual: true };

export interface Commitment {
  id: string;
  key: string; // the template key a rule ensures it by; a person-made one uses its id
  title: string;
  domain: Domain;
  owner: string;
  caseId: string | null;
  trigger: Trigger;
  ask: Ask;
  /** Context shown above the question: why it is asked, what is known. Markdown. */
  brief: string;
  nag: { everyWorkdays: number; at: string; max: number };
  backstop: { at: string; outcome: "expire" };
  level: "silent" | "push";
  origin: { by: "rule" | "human" | "agent" | "controller"; who: string };
  status: "scheduled" | "waiting" | "done" | "expired" | "cancelled";
  rounds: number;
  lastAskedAt: string | null;
  answer: { option: string | null; label: string; text: string | null; at: string; via: string } | null;
  createdAt: string;
  updatedAt: string;
  reason: string | null;
}

/**
 * What a person said about one item in a conversation, in force until taken back: stop following
 * it, do not ask about it until a day, or this judgment is wrong. It carries the words and who
 * said them, and one sentence takes it back.
 */
export interface Annotation {
  id: string;
  caseId: string;
  kind: "drop" | "hold" | "wrong";
  said: string;
  /** The person, by id in persons.json. */
  by: string;
  /** The agent whose conversation it was said in. */
  via: string | null;
  /** The person's own words in their own conversation, or a card they answered yes to. */
  how: "own-words" | "confirmed";
  at: string;
  /** hold: asking starts again on this day (YYYY-MM-DD, local). */
  until: string | null;
  /** hold: only this person's questions. */
  person: string | null;
  /** wrong: what is wrong, and what would be right. */
  what: string | null;
  expected: string | null;
  revoked: { at: string; said: string; by: string } | null;
}

/** One card: a question form for one person, one question per commitment. */
export interface Card {
  id: string;
  person: string;
  commitments: Array<{ id: string; round: number }>;
  title: string;
  status: "pending" | "raised" | "answered" | "closed";
  agentId: string | null;
  /** Carriers started for it; a restart starts a new one, since the old session died with the plugin. */
  attempts: number;
  /** Its carrier agent has been archived. */
  archived: boolean;
  raisedAt: string;
  closedAt: string | null;
  reason: string | null;
  /**
   * What the card said when it was put up (a hash of its content) and when, and which runs of its items were over by
   * then: a card whose words have changed since because another run of them ended is put up again with the new ones
   * (engine.ts pruneCards). Absent on older cards; `ended` absent on those from before it was kept.
   */
  shown?: { at: string; hash: string; ended?: string[] };
  /** A card asking the admin to confirm words said in a conversation; absent on a card of questions. */
  kind?: "confirm";
  /** Cut down from this card (questions came off it): sent and counted already as that one. */
  cutFrom?: string;
}

export interface Assessment {
  caseId: string;
  at: string;
  rule: string;
  rulesFingerprint: string;
  stage: string;
  health: "on-track" | "waiting" | "stalled" | "blocked" | "conflict" | "done";
  headline: string;
  /** `since`: when it became this actor's move, by the rule's evidence, when it said. */
  next: { actor: "me" | "them" | "system" | "nobody"; what: string; since?: string };
  /** Something that looks wrong, told as a statement (not a question); null when nothing does. */
  notice?: string | null;
  /** When it got to this stage by what the rule could see, when that was earlier than this judgment. */
  since?: string;
  stale: boolean;
  error: string | null;
}

/** superseded: an ask taken back (its trigger moved later), so that round may be asked again. */
export type ActionStatus = "planned" | "done" | "failed" | "in-doubt" | "suppressed" | "deferred" | "superseded";

export interface Action {
  key: string;
  kind: "ask" | "note.set" | "commitment.ensure" | "commitment.cancel" | "card.close" | "notify";
  subject: string;
  summary: string;
  status: ActionStatus;
  reason: string | null;
  at: string;
  /** For a notify: how many times it was tried. */
  tries?: number;
}

export interface SourceHealth {
  state: "ok" | "degraded" | "down" | "never";
  lastOkAt: string | null;
  lastError: string | null;
  failures: number;
  /** Instants (ms) of recent calls, for the hourly budget. */
  calls: number[];
  nextPollAt: number;
  /** For a source of several files: item key -> when that file was last read. */
  readAt?: Record<string, string>;
  /** Failing since then, without a read in between: one outage. */
  downSince?: string;
  /** For a source of several files: item key -> since when that file has failed to read. */
  failingSince?: Record<string, string>;
  /**
   * For an observing source: item key -> a request (its version) that was not read, in a run that
   * failed or one that gave nothing for it; retried on its own after `retryAt` (ms). `since`: since
   * when the command has given nothing for it while it did for others (what is told as that key's
   * outage; the source failing as a whole is told as the source's).
   */
  keyFailures?: Record<string, { request: string; since?: string; failures: number; error: string; retryAt: number }>;
}

export type EvalKind = "woke-noop" | "nag-ignored" | "commitment-expired" | "rule-breaker" | "source-down-long" | "budget-overflow" | "correction";

// ---- flows the controller started for an item (server/flows.ts) ----------------------------------

/** How a run came out: the runtime's own four, and the three the controller reaches when the runtime cannot say. */
export type FlowOutcome = "done" | "stopped" | "failed" | "timeout" | "lost" | "not-started" | "refused";

/** How a run ended, as the controller recorded it when it read or decided that. */
export interface FlowEnd {
  at: string;
  outcome: FlowOutcome;
  /** The flow's own one line (its `summarize`); null when it gave none, or the run has no result. */
  summary: string | null;
  /** The sum of the calls that ended; Claude-family only (the runtime's `run.end.cost.partial` says what is left out). */
  costUsd: number;
  /** What the flow returned, as the runtime wrote it; null when it has none, or `valueDropped`. */
  value: unknown;
  /** The result was too large to keep (more than FLOW_VALUE_BYTES): the rule gets the summary only. */
  valueDropped: boolean;
  /** Why, in words, when the run did not come to a result. */
  why: string | null;
}

/** One run of a flow the controller meant to start for an item: the intent, written before the process was. */
export interface FlowRec {
  runId: string;
  caseId: string;
  /** The rule's own name for it (rules.ts `flows`), and the flow the runtime is asked to run. */
  name: string;
  flow: string;
  key: string;
  /** 0 for the first; a person's "run it again" adds one. */
  round: number;
  /** The item's stage when the run was asked for: where its failure counts as the item's condition. */
  stage: string | null;
  label: string;
  /** What the run is called to the runtime (`affair.label`): the item, the stage and the label. */
  affairLabel: string;
  /** The person told when it ends (persons.json id); null: nobody. */
  owner: string | null;
  notify: boolean;
  /** The ceiling the day's budget counts it at while it runs; not enforced on the run. */
  maxUsd: number;
  timeout: string | null;
  /** What the flow is given; dropped once the run is done or stopped (a run that failed is run again with it). */
  input: Record<string, unknown> | null;
  inputHash: string;
  /** The fingerprint of the rules that asked for it. */
  rules: string;
  intentAt: string;
  spawnedAt?: string;
  pid?: number | null;
  /** Times the process was started for it (a start that failed counts), and why the last failed. */
  spawnTries?: number;
  spawnError?: string;
  ended?: FlowEnd;
  dismissed?: { how: "mine" | "fold"; by: string; at: string };
}

/** What a rule reads of a run (ctx.run). */
export type FlowState = "queued" | "starting" | "running" | "gate" | "slow" | "done" | "stopped" | "failed" | "timeout" | "lost" | "not-started" | "refused" | "dismissed" | "deferred";

export interface FlowResult {
  state: FlowState;
  /** Null when no run exists (state "deferred": asked for, held back). */
  runId: string | null;
  round: number;
  startedAt: string | null;
  endedAt: string | null;
  /** What the flow returned; null until it is done or stopped. */
  value: unknown;
  summary: string | null;
  costUsd: number;
  /** In words: why it did not come to a result, or why it was held back. */
  why: string | null;
  /** For a run a person set aside ("dismissed"): how it ended, or null when it has not. */
  endedOutcome: FlowOutcome | null;
}

/** The most of a run's result the controller keeps and hands to a rule. */
export const FLOW_VALUE_BYTES = 16 * 1024;
