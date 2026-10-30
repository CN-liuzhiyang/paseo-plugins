import type { Action, Annotation, Assessment, Card, Commitment, EvalKind, FlowEnd, FlowRec, Item, Note, Observation, ObserveRequest, SourceHealth } from "../shared/model";
import type { AskedAt, Request } from "./requests";
import { unfinishedWhy } from "./flows";
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
  | { type: "rules.held"; fingerprint: string; newCommitments: number; dropped?: number; changed?: number; reopened?: number; flows?: number }
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
  | { type: "request.handled"; id: string; outcome: "applied" | "proposed" | "asked" | "rejected"; detail: string; annotation: string | null; request?: Request; original?: string; vouch?: string; why?: string; waived?: true; question?: string; askedAt?: AskedAt }
  /** The intent to start a flow for a case, written before the process is started (server/flows.ts). */
  | { type: "flow.intent"; rec: FlowRec }
  /** The process was started (its pid, when the system gave one). */
  | { type: "flow.spawned"; runId: string; pid: number | null }
  /** Starting the process itself failed (no such program, no right to): nothing ran. */
  | { type: "flow.spawn-failed"; runId: string; error: string }
  /** The run came to an end, or was found to never come to one; `at` of the end is the event's. */
  | { type: "flow.ended"; runId: string; end: Omit<FlowEnd, "at"> }
  /** A person set a run aside: "mine" (they take it from here) or "fold" (just not shown). By run, not by case. */
  | { type: "flow.dismissed"; runId: string; how: "mine" | "fold"; by: string }
  /** A person asked for a run again: the next round of the key, whose intent follows in the same batch. For the record. */
  | { type: "flow.retry"; caseId: string; name: string; key: string; round: number; runId: string; by: string; estimateUsd: number }
  /**
   * A round that carries on the run `from` instead of starting the request's flow again, whose intent follows in the same batch: asked for by a
   * person (`by` their id), or a run someone started with `orch.mjs resume` that the controller took into the record (`by: "cli"`). `flow` is the flow that runs. For the record.
   */
  | { type: "flow.resume"; caseId: string; name: string; key: string; round: number; runId: string; from: string; flow: string; by: string }
  | { type: "started"; instanceId: string; mode: "live" | "dry-run"; pid: number; home: string };

export interface RulesDiff {
  /** The runs of flows the change of rules asks for in its first round, those a limit holds back for now too (the breaker counts them all). */
  flowRequests?: number;
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
  requests: Record<string, { outcome: "applied" | "proposed" | "asked" | "rejected"; detail: string; annotation: string | null; at: string; request?: Request; vouch?: string; why?: string; waived?: true; question?: string; askedAt?: AskedAt }>;
  /** By case: what its rule asks to have watched, and since when it asks that. Absent in states from before it was kept. */
  observing?: Record<string, { at: string; requests: ObserveRequest[] }>;
  /** The runs of flows started for cases, by run id. Absent in states from before flows were. */
  flows?: Record<string, FlowRec>;
  /** By "case\0name\0key": the latest round asked for and its run id; what makes "asked for once" outlast the run. */
  flowKeys?: Record<string, { round: number; runId: string }>;
}

/**
 * The key under which the latest round of a flow request is kept (State.flowKeys). A request is the rule's name for it, the flow
 * that name stands for and its key: a name that is made to stand for another flow is another request, not the old one's result.
 */
export const flowKeyOf = (caseId: string, name: string, flow: string, key: string) => `${caseId}\0${name}\0${flow}\0${key}`;

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
      state.rules.held = { fingerprint: event.fingerprint, newCommitments: event.newCommitments, dropped: event.dropped ?? 0, changed: event.changed ?? 0, reopened: event.reopened ?? 0, ...(event.flows ? { flows: event.flows } : {}), at: event.at };
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
      state.requests[event.id] = { outcome: event.outcome, detail: event.detail, annotation: event.annotation, at: event.at, ...(event.request ? { request: event.request } : {}), ...(event.vouch ? { vouch: event.vouch } : {}), ...(event.why ? { why: event.why } : {}), ...(event.waived ? { waived: true as const } : {}), ...(event.question ? { question: event.question } : {}), ...(event.askedAt ? { askedAt: event.askedAt } : {}) };
      return;
    case "workspace":
      state.workspaceId = event.workspaceId;
      return;
    case "observe.set":
      if (event.requests.length === 0) delete (state.observing ??= {})[event.caseId];
      else (state.observing ??= {})[event.caseId] = { at: event.at, requests: event.requests };
      return;
    case "flow.intent": {
      (state.flows ??= {})[event.rec.runId] = event.rec;
      const at = flowKeyOf(event.rec.caseId, event.rec.name, event.rec.flow, event.rec.key);
      const had = (state.flowKeys ??= {})[at];
      if (!had || had.round <= event.rec.round) state.flowKeys[at] = { round: event.rec.round, runId: event.rec.runId };
      return;
    }
    case "flow.spawned": {
      const rec = state.flows?.[event.runId];
      if (rec) Object.assign(rec, { spawnedAt: event.at, pid: event.pid, spawnTries: (rec.spawnTries ?? 0) + 1, spawnError: undefined });
      return;
    }
    case "flow.spawn-failed": {
      const rec = state.flows?.[event.runId];
      if (rec) Object.assign(rec, { spawnTries: (rec.spawnTries ?? 0) + 1, spawnError: event.error });
      return;
    }
    case "flow.ended": {
      const rec = state.flows?.[event.runId];
      if (!rec || rec.ended) return;
      rec.ended = { at: event.at, ...event.end };
      // A run that came to a result is not run again with this input; one that did not is, so it keeps it (a stop that says it did not get done what it was for did not).
      if ((event.end.outcome === "done" || event.end.outcome === "stopped") && unfinishedWhy(event.end) === null) rec.input = null;
      return;
    }
    case "flow.dismissed": {
      const rec = state.flows?.[event.runId];
      if (rec && !rec.dismissed) rec.dismissed = { how: event.how, by: event.by, at: event.at };
      return;
    }
    case "flow.retry":
    case "flow.resume":
      return;
    case "eval.candidate":
      state.evals += 1;
      return;
    case "started":
      return;
  }
}
