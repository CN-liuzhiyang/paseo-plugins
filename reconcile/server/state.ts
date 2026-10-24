import type { Action, Annotation, Assessment, Card, Commitment, EvalKind, Item, Note, Observation, ObserveRequest, SourceHealth } from "../shared/model";
import type { Request } from "./requests";
import type { RulesHeld } from "../shared/status";

// Every change to the controller's state is one event in the journal; the state is the fold of
// them. The reducer is the only code that changes state, so replaying the journal rebuilds it.

export type EventBody =
  | { type: "item.snapshot"; item: Item }
  | { type: "obs"; obs: Observation }
  | { type: "note.set"; note: Note }
  | { type: "assessment"; assessment: Assessment }
  | { type: "commitment.created"; commitment: Commitment }
  | { type: "commitment.changed"; id: string; patch: Partial<Commitment> }
  | { type: "card.created"; card: Card }
  | { type: "card.changed"; id: string; patch: Partial<Card> }
  | { type: "action"; action: Action }
  | { type: "source.state"; id: string; cursor?: unknown; health: SourceHealth }
  | { type: "rules.loaded"; fingerprint: string; files: string[] }
  | { type: "rules.changed"; from: string | null; to: string; diff: RulesDiff }
  // dropped / changed / reopened: absent in journals from before the breaker counted them.
  | { type: "rules.held"; fingerprint: string; newCommitments: number; dropped?: number; changed?: number; reopened?: number }
  | { type: "rules.released"; fingerprint: string }
  /** A rule file that does not load: since when (kept while it stays broken), and the copy that runs instead (null: none). */
  | { type: "rules.broken"; file: string; error: string; fallback: string | null; since: string }
  | { type: "rules.mended"; file: string }
  /** The controller saved a copy of a rule file (its sha256, and the source its rule judges); sha256 null: the copy is gone. */
  | { type: "rules.kept"; file: string; sha256: string | null; source?: string }
  | { type: "workspace"; workspaceId: string }
  /** What a case's rule asks observing sources to watch now (none: nothing). */
  | { type: "observe.set"; caseId: string; requests: ObserveRequest[] }
  | { type: "eval.candidate"; kind: EvalKind; subject: string; detail: string }
  | { type: "annotation.added"; annotation: Annotation }
  | { type: "annotation.revoked"; id: string; said: string; by: string }
  /** A request from a conversation, handled: its outcome, and for one waiting on a card, the request itself. */
  | { type: "request.handled"; id: string; outcome: "applied" | "proposed" | "rejected"; detail: string; annotation: string | null; request?: Request; original?: string; vouch?: string; why?: string }
  | { type: "started"; instanceId: string; mode: "live" | "dry-run"; pid: number; home: string };

export interface RulesDiff {
  changed: Array<{ caseId: string; before: string | null; after: string }>;
  newCommitments: string[];
  droppedCommitments: string[];
  changedCommitments?: string[];
  reopenedCommitments?: string[];
}

export type JournalEvent = EventBody & { v: 1; seq: number; at: string };

const RECENT = 50;

export interface State {
  seq: number;
  items: Record<string, Item>;
  /** The latest observations per key, newest last; the journal keeps all of them. */
  recent: Record<string, Observation[]>;
  notes: Record<string, Record<string, Note>>;
  commitments: Record<string, Commitment>;
  cards: Record<string, Card>;
  assessments: Record<string, Assessment>;
  ledger: Record<string, Action>;
  sources: Record<string, { cursor: unknown; health: SourceHealth }>;
  /** broken: absent in states from before it was kept. */
  /** broken, kept: absent in states from before they were kept. A broken file "" is a rules directory with no file in it. */
  rules: { fingerprint: string | null; held: RulesHeld | null; released: string[]; broken?: Record<string, RuleBroken>; kept?: Record<string, { sha256: string; source?: string }> };
  workspaceId: string | null;
  evals: number;
  annotations: Record<string, Annotation>;
  /**
   * vouch: for words taken as the person's own, the message of theirs that vouched for them and the
   * item it names (one request a message, or one an item it names). why: for words not taken as
   * theirs, why not; only here, the receipt does not say.
   */
  requests: Record<string, { outcome: "applied" | "proposed" | "rejected"; detail: string; annotation: string | null; at: string; request?: Request; vouch?: string; why?: string }>;
  /** By case: what its rule asks to have watched, and since when it asks that. Absent in states from before it was kept. */
  observing?: Record<string, { at: string; requests: ObserveRequest[] }>;
}

export interface RuleBroken {
  error: string;
  /** When the copy that runs instead was saved; null: nothing of the file runs. */
  fallback: string | null;
  since: string;
}

export function emptyState(): State {
  return {
    seq: 0,
    items: {},
    recent: {},
    notes: {},
    commitments: {},
    cards: {},
    assessments: {},
    ledger: {},
    sources: {},
    rules: { fingerprint: null, held: null, released: [], broken: {} },
    workspaceId: null,
    evals: 0,
    annotations: {},
    requests: {},
  };
}

export function apply(state: State, event: JournalEvent): void {
  state.seq = event.seq;
  switch (event.type) {
    case "item.snapshot":
      state.items[event.item.key] = event.item;
      return;
    case "obs": {
      const list = (state.recent[event.obs.key] ??= []);
      list.push(event.obs);
      if (list.length > RECENT) list.splice(0, list.length - RECENT);
      return;
    }
    case "note.set":
      (state.notes[event.note.key] ??= {})[event.note.field] = event.note;
      return;
    case "assessment":
      state.assessments[event.assessment.caseId] = event.assessment;
      return;
    case "commitment.created":
      state.commitments[event.commitment.id] = event.commitment;
      return;
    case "commitment.changed": {
      const found = state.commitments[event.id];
      if (found) Object.assign(found, event.patch);
      return;
    }
    case "card.created":
      state.cards[event.card.id] = event.card;
      return;
    case "card.changed": {
      const found = state.cards[event.id];
      if (found) Object.assign(found, event.patch);
      return;
    }
    case "action":
      state.ledger[event.action.key] = event.action;
      return;
    case "source.state": {
      const current = state.sources[event.id];
      state.sources[event.id] = { cursor: "cursor" in event ? event.cursor : current?.cursor ?? null, health: event.health };
      return;
    }
    case "rules.loaded":
      state.rules.fingerprint = event.fingerprint;
      return;
    case "rules.changed":
      state.rules.fingerprint = event.to;
      // The held version is gone (put back, or changed again): nothing is held for it any more.
      if (state.rules.held && state.rules.held.fingerprint !== event.to) state.rules.held = null;
      return;
    case "rules.held":
      state.rules.held = { fingerprint: event.fingerprint, newCommitments: event.newCommitments, dropped: event.dropped ?? 0, changed: event.changed ?? 0, reopened: event.reopened ?? 0, at: event.at };
      return;
    case "rules.released":
      state.rules.released.push(event.fingerprint);
      if (state.rules.held?.fingerprint === event.fingerprint) state.rules.held = null;
      return;
    case "rules.broken":
      (state.rules.broken ??= {})[event.file] = { error: event.error, fallback: event.fallback, since: event.since };
      return;
    case "rules.mended":
      if (state.rules.broken) delete state.rules.broken[event.file];
      return;
    case "rules.kept":
      if (event.sha256 === null) delete (state.rules.kept ??= {})[event.file];
      else (state.rules.kept ??= {})[event.file] = { sha256: event.sha256, ...(event.source ? { source: event.source } : {}) };
      return;
    case "annotation.added":
      state.annotations[event.annotation.id] = event.annotation;
      return;
    case "annotation.revoked": {
      const found = state.annotations[event.id];
      if (found && !found.revoked) found.revoked = { at: event.at, said: event.said, by: event.by };
      return;
    }
    case "request.handled":
      state.requests[event.id] = { outcome: event.outcome, detail: event.detail, annotation: event.annotation, at: event.at, ...(event.request ? { request: event.request } : {}), ...(event.vouch ? { vouch: event.vouch } : {}), ...(event.why ? { why: event.why } : {}) };
      return;
    case "workspace":
      state.workspaceId = event.workspaceId;
      return;
    case "observe.set":
      if (event.requests.length === 0) delete (state.observing ??= {})[event.caseId];
      else (state.observing ??= {})[event.caseId] = { at: event.at, requests: event.requests };
      return;
    case "eval.candidate":
      state.evals += 1;
      return;
    case "started":
      return;
  }
}
