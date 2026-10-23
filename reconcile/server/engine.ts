import { createHash } from "node:crypto";
import type { Config, Person } from "./config";
import type { Action, Assessment, Card, Commitment, Item, Observation, SourceHealth } from "../shared/model";
import { describeChanges, type PlanEntry, type Status } from "../shared/status";
import { backstopPassed, cardsToday, dueNow, mayReach, nextStep, type Due } from "./policy";
import { heatOf, listedAt } from "./heat";
import { linksOf, vocabularyOf, type FlagLink, type Vocabulary } from "./links";
import { fingerprintOf, judge, loadRules, makeContext, type CommitmentSpec, type RuleSet } from "./rules";
import type { ListedRow, Source } from "./sources/source";
import type { EventBody, RulesDiff } from "./state";
import type { Store } from "./store";
import { addDays, inWindow, iso, localParts, parseWindow } from "./time";

// One reconcile, every tick: poll the sources that are due, record what changed, judge every
// case with the current rules, keep the rule-made commitments in step, and ask people what is
// due -- subject to quiet hours and budgets. Everything up to raising a card is deterministic
// and spends no model tokens. In dry-run nothing leaves the process: the plan says what would.

export interface CardContent {
  title: string;
  brief: string;
  questions: Array<{ commitmentId: string; header: string; question: string; options: Array<{ id: string; label: string; description: string }>; allowOther: boolean }>;
}

export type CardAnswer =
  | { kind: "answers"; answers: Record<string, string>; via: string }
  | { kind: "dismissed"; via: string }
  | { kind: "typed"; text: string }
  | { kind: "closed" };

export interface Carrier {
  /** Starts the agent that shows the card; resolves to its id. */
  raise(card: Card, content: CardContent, attempt: number): Promise<string>;
  archive(agentId: string): Promise<void>;
}


export interface EngineDeps {
  store: Store;
  config: Config;
  sources: Source[];
  carrier: Carrier | null;
  mode: "live" | "dry-run";
  instanceId: string;
  home: string;
  tickSeconds: number;
  /** Shown at the top of every status, such as why a live setting only rehearses. */
  notices?: string[];
  /** The host's server.deliver; absent on a host without it. */
  deliver?: Deliver | null;
  now(): number;
  log(message: string): void;
  writeStatus(status: unknown): void;
}

export type Deliver = (channelId: string, message: { to: string; idempotencyKey: string; title: string; text: string; status: "succeeded" | "failed" }) => Promise<void>;

/** A card's message to one of its person's channels is tried this many times, once per reconcile. */
const MAX_NOTIFY_TRIES = 3;

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const commitmentId = (key: string) => `c_${hash(key).slice(0, 16)}`;
const CARRIER_RETRY_MS = 5 * 60_000;
const DAY = 86_400_000;
/** How a case's health sorts on the page: what is wrong first. */
/** Why the engine cancelled a rule's commitment; one cancelled for this is opened again when the rule wants it again. */
export const NOT_WANTED = "规则不再要求";

/** One change a rules change makes this round, kept apart so that the breaker can hold it. */
interface Gated {
  events: EventBody[];
  kind: "create" | "cancel" | "change" | "reopen" | "fact";
  person: string | null;
  /** What it does, for the plan: done, or held. */
  what: string;
}

const SEVERITY: Record<string, number> ={ conflict: 2, blocked: 3, stalled: 4, waiting: 5, "on-track": 6, done: 7 };

export function createEngine(deps: EngineDeps) {
  const { store, config } = deps;
  const tz = config.policy.tz;
  const calendar = config.calendar;
  let ruleset: RuleSet | null = null;
  let lastTickAt: number | null = null;
  let lastPlan: PlanEntry[] = [];
  let lastProblems: string[] = [];
  /** Why each case was hot at the last reconcile; empty when cold. */
  let lastHeat = new Map<string, string[]>();
  /** When each item was last read in full in this process; a hot item is read again after refreshHotMinutes. */
  const lastRead = new Map<string, number>();
  let ticking = false;
  let tickStartedAt: number | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  // Set when the plugin stops this engine: a tick in flight does nothing more after its next step.
  let stopped = false;
  let carrierRetryAt = 0;
  const state = store.state;

  // A stopped engine writes nothing, on any path (a source's failure included).
  const append = (events: EventBody[]) => (stopped ? [] : store.append(events));
  const nowIso = (ms: number) => iso(ms, tz);

  // ---- sources ----------------------------------------------------------------------------

  const sourceConfig = (id: string) => config.sources.find((s) => s.id === id)!;

  function intervalMs(id: string, nowMs: number): number {
    const s = sourceConfig(id);
    return (inWindow(nowMs, parseWindow(s.activeHours), tz, calendar) ? s.everyMinutes : s.offHoursEveryMinutes) * 60_000;
  }

  const freshWithin = (id: string, nowMs: number) => 3 * Math.max(intervalMs(id, nowMs), sourceConfig(id).offHoursEveryMinutes * 60_000);

  function fresh(id: string, nowMs: number): boolean {
    const health = state.sources[id]?.health;
    if (!health?.lastOkAt || health.state === "down") return false;
    return nowMs - Date.parse(health.lastOkAt) <= freshWithin(id, nowMs);
  }

  /**
   * What is not read recently enough to act on: a source not fresh, or one file of a file source
   * that keeps failing while the others are read (the source as a whole is then still ok).
   */
  function staleNow(nowMs: number): string[] {
    const out: string[] = [];
    for (const s of config.sources) {
      if (!fresh(s.id, nowMs)) {
        out.push(s.id);
        continue;
      }
      if (s.kind !== "flags") continue;
      const readAt = state.sources[s.id]?.health.readAt ?? {};
      for (const file of s.files) {
        const at = readAt[`${s.id}:${file.id}`];
        if (!at || nowMs - Date.parse(at) > freshWithin(s.id, nowMs)) out.push(`${s.id}:${file.id}`);
      }
    }
    return out;
  }

  /** What a commitment's uses may name besides items already read: a source, or a configured file. */
  const knownNames = new Set(config.sources.flatMap((s) => [s.id, ...(s.kind === "flags" ? s.files.map((f) => `${s.id}:${f.id}`) : [])]));
  /** Files switch keys come from: every case's links and heat are read from them. */
  const switchFiles = config.sources.flatMap((s) => (s.kind === "flags" && s.itemKind === "flags" ? s.files.map((f) => `${s.id}:${f.id}`) : []));
  /** What each case's last judgment read, and what each commitment says it rests on (null: the case's reads). */
  const lastReads = new Map<string, Set<string>>();
  const lastUses = new Map<string, string[] | null>();

  /** Of what is stale, what a judgment or a question resting on deps (unknown: everything) waits for. */
  function blockers(deps: Iterable<string> | undefined, stale: string[]): string[] {
    if (!deps) return stale;
    const on = [...deps];
    // A source stale holds what rests on any of its files; a file stale holds what rests on its source.
    return stale.filter((e) => on.some((d) => d === e || d.startsWith(`${e}:`) || e.startsWith(`${d}:`)));
  }

  function diffItem(before: Item, after: Item): Array<{ field: string; from: string; to: string }> {
    const changes: Array<{ field: string; from: string; to: string }> = [];
    const push = (field: string, from: string, to: string) => from !== to && changes.push({ field, from, to });
    push("title", before.title, after.title);
    push("status", before.status, after.status);
    push("closed", String(before.closed), String(after.closed));
    for (const field of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) push(`fields.${field}`, before.fields[field] ?? "", after.fields[field] ?? "");
    for (const role of new Set([...Object.keys(before.people), ...Object.keys(after.people)])) push(`people.${role}`, (before.people[role] ?? []).join(", "), (after.people[role] ?? []).join(", "));
    return changes;
  }

  function readMore(before: Item, after: Item): boolean {
    const extra = (item: Item) => JSON.stringify([item.text, item.revisions, item.incomplete ?? null, item.lastHumanAt, item.labels, item.url, item.parent]);
    return extra(before) !== extra(after);
  }

  async function pollSources(nowMs: number): Promise<void> {
    for (const source of deps.sources) {
      if (stopped) return;
      const current = state.sources[source.id];
      const health: SourceHealth = current?.health ?? { state: "never", lastOkAt: null, lastError: null, failures: 0, calls: [], nextPollAt: 0 };
      if (nowMs < health.nextPollAt) continue;
      const calls = health.calls.filter((t) => nowMs - t < 3_600_000);
      const callsLeft = sourceConfig(source.id).maxCallsPerHour - calls.length;
      if (callsLeft <= 0) {
        append([{ type: "source.state", id: source.id, health: { ...health, calls, nextPollAt: Math.min(...calls) + 3_600_000 } }]);
        continue;
      }
      const vocabulary = vocabularyOf(state.items, state.recent);
      const watch = watchedIds(source.id, nowMs, vocabulary);
      try {
        const poll = await source.poll({
          cursor: current?.cursor ?? null,
          watch,
          now: nowIso(nowMs),
          nowMs,
          callsLeft,
          decide: (row) => decide(row, nowMs, vocabulary),
          humanSince: nowIso(nowMs - config.policy.hot.recentDays * DAY),
        });
        if (stopped) return;
        const events: EventBody[] = [];
        for (const snapshot of poll.snapshots) {
          lastRead.set(snapshot.key, nowMs);
          const before = state.items[snapshot.key];
          if (before) {
            const changes = diffItem(before, snapshot);
            // What was read besides the record (text, commits, history) is kept, but is not an observation.
            if (changes.length === 0) {
              if (readMore(before, snapshot)) events.push({ type: "item.snapshot", item: snapshot });
              continue;
            }
            const obs: Observation = {
              id: hash(`${snapshot.key}\0${snapshot.sourceUpdatedAt}\0${JSON.stringify(changes)}`).slice(0, 16),
              at: snapshot.sourceUpdatedAt ?? snapshot.observedAt,
              seenAt: snapshot.observedAt,
              source: source.id,
              key: snapshot.key,
              kind: "changed",
              trust: "source",
              actor: null,
              changes,
              text: null,
            };
            events.push({ type: "obs", obs });
          }
          events.push({ type: "item.snapshot", item: snapshot });
        }
        const used = [...calls, ...Array.from({ length: poll.calls }, () => nowMs)];
        const next = poll.more ? nowMs + 60_000 : nowMs + intervalMs(source.id, nowMs);
        // Each file of a file source, when it was last read: one can fail while the others do not.
        const conf = sourceConfig(source.id);
        const readAt = conf.kind === "flags" ? { ...(health.readAt ?? {}), ...Object.fromEntries(poll.snapshots.map((s) => [s.key, nowIso(nowMs)])) } : undefined;
        // And since when each file that did not come has been failing.
        const got = new Set(poll.snapshots.map((s) => s.key));
        const failingSince =
          conf.kind === "flags"
            ? Object.fromEntries(conf.files.map((f) => `${source.id}:${f.id}`).filter((k) => !got.has(k)).map((k) => [k, health.failingSince?.[k] ?? nowIso(nowMs)]))
            : {};
        events.push({
          type: "source.state",
          id: source.id,
          cursor: poll.cursor,
          health: {
            state: "ok",
            lastOkAt: nowIso(nowMs),
            lastError: poll.errors.length > 0 ? poll.errors.join("; ").slice(0, 500) : null,
            failures: 0,
            calls: used,
            nextPollAt: next,
            ...(readAt ? { readAt } : {}),
            ...(Object.keys(failingSince).length > 0 ? { failingSince } : {}),
          },
        });
        append(events);
      } catch (error) {
        const message = (error as Error).message;
        const failures = health.failures + 1;
        const auth = (error as { auth?: boolean }).auth === true;
        const nextState: SourceHealth["state"] = auth || failures >= 3 ? "down" : "degraded";
        const backoff = Math.min(60, 2 ** Math.min(failures, 6)) * 60_000;
        const events: EventBody[] = [
          { type: "source.state", id: source.id, health: { ...health, state: nextState, lastError: message.slice(0, 500), failures, calls: [...calls, nowMs], nextPollAt: nowMs + backoff, downSince: health.downSince ?? nowIso(nowMs) } },
        ];
        const downSince = health.lastOkAt ? Date.parse(health.lastOkAt) : null;
        const evalKey = `eval:source-down:${source.id}:${health.lastOkAt ?? "never"}`;
        if (downSince !== null && nowMs - downSince > config.policy.sourceDownHours * 3_600_000 && !state.ledger[evalKey]) {
          events.push({ type: "eval.candidate", kind: "source-down-long", subject: source.id, detail: message.slice(0, 300) });
          events.push({ type: "action", action: { key: evalKey, kind: "note.set", subject: source.id, summary: "记评测候选：来源长时间不可用", status: "done", reason: null, at: nowIso(nowMs) } });
        }
        append(events);
        deps.log(`source ${source.id} failed (${failures}): ${message}`);
      }
    }
  }

  /** Native ids of items open commitments follow, for the source that owns them. */
  /** A hot item not read in full for refreshHotMinutes (when its source sets that). */
  function due(item: Item, nowMs: number): boolean {
    const refresh = (sourceConfig(item.source) as { refreshHotMinutes?: number }).refreshHotMinutes ?? 0;
    return refresh > 0 && nowMs - (lastRead.get(item.key) ?? Date.parse(item.observedAt)) >= refresh * 60_000;
  }

  function watchedIds(sourceId: string, nowMs: number, vocabulary: Vocabulary): string[] {
    const ids = new Set<string>();
    for (const c of Object.values(state.commitments)) {
      if (c.status !== "scheduled" && c.status !== "waiting") continue;
      if (c.caseId?.startsWith(`${sourceId}:`)) ids.add(c.caseId.slice(sourceId.length + 1));
    }
    // Hot items last read before items kept their text and commits, or not read for a while: read
    // them again (the list only shows what changed).
    for (const item of Object.values(state.items)) {
      if (item.source !== sourceId || item.kind === "flags") continue;
      if (item.text !== undefined && !due(item, nowMs)) continue;
      if (heatFor(item, nowMs, vocabulary).length > 0) ids.add(item.key.slice(sourceId.length + 1));
    }
    return [...ids];
  }

  // ---- hot and cold -----------------------------------------------------------------------

  const openCase = (caseId: string) => Object.values(state.commitments).some((c) => c.caseId === caseId && (c.status === "scheduled" || c.status === "waiting"));
  const configWatched = (key: string) =>
    config.sources.some((s) => s.kind === "gcp" && key.startsWith(`${s.id}:`) && s.watch.includes(Number(key.slice(s.id.length + 1))));

  const quietTitle = (title: string) => config.policy.coldTitles.some((t) => title.includes(t));

  function heatFor(item: Item, nowMs: number, vocabulary: Vocabulary, flags = linksOf(item, vocabulary)): string[] {
    const changedAt = flags.map((f) => f.changedAt).filter((t): t is string => !!t).sort().pop() ?? null;
    const woken = Object.values(state.notes[item.key] ?? {})
      .filter((n) => n.field.startsWith("woken."))
      .sort((a, b) => a.at.localeCompare(b.at))
      .pop();
    return heatOf(item, { nowMs, tz, policy: config.policy.hot, open: openCase(item.key), watched: configWatched(item.key), quiet: quietTitle(item.title), flagChangedAt: changedAt, woken: woken ? { at: woken.at, reason: woken.value } : null });
  }

  /** Per listed row: a full read for what is hot or about to be, a look at its history for what someone may have touched. */
  function decide(row: ListedRow, nowMs: number, vocabulary: Vocabulary): "full" | "people" | "skip" {
    const item = state.items[row.key];
    const quiet = quietTitle(row.title || item?.title || "");
    if (item) {
      const hot = heatFor(item, nowMs, vocabulary).length > 0;
      // An item read before items kept their text is read again once while hot; a hot item is
      // also read again now and then, for commits that reach a branch without the issue changing.
      if (hot) return row.changed || item.text === undefined || due(item, nowMs) ? "full" : "skip";
      const cared = row.status !== item.status || Object.entries(row.columns).some(([field, value]) => (item.fields[field] ?? "") !== value);
      if (cared) return "full";
    } else if (heatOf({ fields: row.columns, lastHumanAt: null }, { nowMs, tz, policy: config.policy.hot, open: false, watched: configWatched(row.key), quiet, flagChangedAt: null }).length > 0) {
      return "full";
    }
    // Who touched a container or a standing item does not matter: no history read for it.
    if (!row.changed || quiet) return "skip";
    const at = listedAt(row.updatedOn, tz);
    return at !== null && nowMs - at <= config.policy.hot.recentDays * DAY ? "people" : "skip";
  }

  // ---- rules and commitments --------------------------------------------------------------

  function toCommitment(spec: CommitmentSpec, caseId: string, rule: string, nowMs: number): Commitment {
    return {
      id: commitmentId(spec.key),
      key: spec.key,
      title: spec.title,
      domain: spec.domain,
      owner: spec.owner,
      caseId,
      trigger: { at: spec.trigger.at },
      ask: { person: spec.owner, header: spec.ask.header, question: spec.ask.question, options: spec.ask.options, allowOther: spec.ask.allowOther },
      brief: spec.brief,
      nag: spec.nag,
      backstop: { at: spec.backstop.at, outcome: "expire" },
      level: spec.level,
      origin: { by: "rule", who: rule },
      status: "scheduled",
      rounds: 0,
      lastAskedAt: null,
      answer: null,
      createdAt: nowIso(nowMs),
      updatedAt: nowIso(nowMs),
      reason: null,
    };
  }

  /** What a spec would change in an existing commitment; null when nothing. */
  function specPatch(c: Commitment, spec: CommitmentSpec): Partial<Commitment> | null {
    const patch: Partial<Commitment> = {};
    if (c.title !== spec.title) patch.title = spec.title;
    if (!("at" in c.trigger) || c.trigger.at !== spec.trigger.at) patch.trigger = { at: spec.trigger.at };
    if (c.backstop.at !== spec.backstop.at) patch.backstop = { at: spec.backstop.at, outcome: "expire" };
    if (c.brief !== spec.brief) patch.brief = spec.brief;
    const ask = { person: spec.owner, header: spec.ask.header, question: spec.ask.question, options: spec.ask.options, allowOther: spec.ask.allowOther };
    if (JSON.stringify(c.ask) !== JSON.stringify(ask)) patch.ask = ask;
    if (JSON.stringify(c.nag) !== JSON.stringify(spec.nag)) patch.nag = spec.nag;
    if (c.level !== spec.level) patch.level = spec.level;
    return Object.keys(patch).length > 0 ? patch : null;
  }

  async function currentRules(): Promise<{ set: RuleSet; changed: boolean }> {
    const { fingerprint } = fingerprintOf(config.rulesDir);
    if (!ruleset || ruleset.fingerprint !== fingerprint) {
      ruleset = await loadRules(config.rulesDir);
      for (const e of ruleset.errors) deps.log(`rule ${e.file}: ${e.error}`);
    }
    return { set: ruleset, changed: state.rules.fingerprint !== ruleset.fingerprint };
  }

  async function judgeAll(nowMs: number, plan: PlanEntry[]): Promise<void> {
    const { set, changed } = await currentRules();
    const firstLoad = state.rules.fingerprint === null;
    const vocabulary = vocabularyOf(state.items, state.recent);
    lastHeat = new Map();
    // Links and heat for every followed item first, so that a rule can see the others' this round.
    const links = new Map<string, FlagLink[]>();
    const hot = new Set<string>();
    for (const item of Object.values(state.items)) {
      if (!set.rules.some((r) => r.source === item.source)) continue;
      const flags = linksOf(item, vocabulary);
      links.set(item.key, flags);
      const heat = heatFor(item, nowMs, vocabulary, flags);
      lastHeat.set(item.key, heat);
      if (heat.length > 0) hot.add(item.key);
    }
    const inputs = {
      vocabulary,
      links,
      hot,
      assessments: state.assessments,
      nowMs,
      tz,
      calendar,
      items: state.items,
      recent: state.recent,
      notes: state.notes,
      commitments: state.commitments,
      fresh: (id: string) => fresh(id, nowMs),
    };
    const events: EventBody[] = [];
    // What a held rules change may not do: change commitments and record facts. A change that
    // turns out to be wrong then leaves nothing behind but its judgments.
    const gated: Gated[] = [];
    const staleList = staleNow(nowMs);
    const diff: RulesDiff = { changed: [], newCommitments: [], droppedCommitments: [], changedCommitments: [], reopenedCommitments: [] };
    const creations: Commitment[] = [];
    for (const item of Object.values(state.items)) {
      const rule = set.rules.find((r) => r.source === item.source);
      if (!rule) continue;
      const flags = links.get(item.key)!;
      // Cold: not judged; its last assessment stays as it was.
      if (!hot.has(item.key)) continue;
      const reads = new Set([item.source, ...switchFiles]);
      const ctx = makeContext({ ...inputs, reads }, rule.params);
      const judged = judge(rule, { id: item.key, primary: item, items: [item], flags }, ctx, set.fingerprint, (out) => {
        const unknown = out.commitments.flatMap((spec) => (spec.uses ?? []).filter((u) => !knownNames.has(u) && !state.items[u]));
        return unknown.length > 0 ? `uses 里的 ${unknown.map((u) => `"${u}"`).join("、")} 不是配置里的来源、文件或已有的数据项` : null;
      });
      lastReads.set(item.key, reads);
      for (const spec of judged.output?.commitments ?? []) lastUses.set(commitmentId(spec.key), spec.uses ? [item.source, ...spec.uses] : null);
      // Judged on what may be old: its own source, a switch file, or an item it looked up is not fresh.
      const assessment: Assessment = { ...judged.assessment, stale: blockers(reads, staleList).length > 0 };
      const before = state.assessments[item.key];
      const same = (a: Assessment | undefined, b: Assessment) =>
        a && a.stage === b.stage && a.health === b.health && a.headline === b.headline && a.next.what === b.next.what && a.next.actor === b.next.actor && (a.notice ?? null) === (b.notice ?? null) && a.error === b.error && a.stale === b.stale && a.rulesFingerprint === b.rulesFingerprint;
      if (!same(before, assessment)) {
        events.push({ type: "assessment", assessment });
        if (assessment.notice && assessment.notice !== (before?.notice ?? null)) plan.push({ at: nowIso(nowMs), kind: "notice", person: null, summary: `${item.key} 提醒：${assessment.notice}` });
        if (changed && before && before.headline !== assessment.headline) diff.changed.push({ caseId: item.key, before: before.headline, after: assessment.headline });
      }
      if (!judged.output) continue;
      for (const fact of judged.output.facts) {
        const note = state.notes[item.key]?.[fact.field];
        if (note?.value === fact.value) continue;
        gated.push({
          kind: "fact",
          person: null,
          what: `${item.key} 记下事实 ${fact.field} = ${fact.value}（${fact.evidence}）`,
          events: [{ type: "note.set", note: { key: item.key, field: fact.field, value: fact.value, kind: "fact", basis: "source-derived", by: rule.name, rules: set.fingerprint, at: nowIso(nowMs), evidence: fact.evidence } }],
        });
      }
      // A wake is a note on the other case; it makes that case hot from the next round on.
      for (const w of judged.output.wake ?? []) {
        if (w.caseId === item.key || !state.items[w.caseId]) continue;
        const field = `woken.${item.key}`;
        if (state.notes[w.caseId]?.[field]?.value === w.reason) continue;
        gated.push({
          kind: "fact",
          person: null,
          what: `${item.key} 叫醒 ${w.caseId}：${w.reason}`,
          events: [{ type: "note.set", note: { key: w.caseId, field, value: w.reason, kind: "fact", basis: "source-derived", by: rule.name, rules: set.fingerprint, at: nowIso(nowMs), evidence: `${item.key} 叫醒` } }],
        });
      }
      const wanted = new Set<string>();
      for (const spec of judged.output.commitments) {
        wanted.add(spec.key);
        const existing = state.commitments[commitmentId(spec.key)];
        const reopen = existing?.status === "cancelled" && existing.reason === NOT_WANTED && existing.origin.by === "rule";
        if (!existing || reopen) {
          if (Date.parse(spec.backstop.at) <= nowMs) {
            // Nothing could be asked before it expired; creating it would only record a miss.
            plan.push({ at: nowIso(nowMs), kind: "skipped", person: spec.owner, summary: `没${existing ? "重开" : "建"}：${spec.title} 的兜底时间 ${spec.backstop.at.slice(5, 16).replace("T", " ")} 已经过了` });
            continue;
          }
          const fresh = toCommitment(spec, item.key, rule.name, nowMs);
          if (!existing) {
            if (!creations.some((c) => c.key === spec.key)) creations.push(fresh);
            continue;
          }
          if (diff.reopenedCommitments!.includes(spec.key)) continue;
          // Wanted again after the rule had stopped wanting it: opened again as if new, under the
          // same id, so that its card and answers stay one thread. Rounds asked before go.
          const { id: _id, key: _key, createdAt: _createdAt, ...reopened } = fresh;
          const back: EventBody[] = [];
          for (let round = 1; round <= existing.rounds; round++) {
            back.push({ type: "action", action: action(`ask:${existing.id}:${round}`, "ask", existing.id, `重开前问过的这一轮作废：${existing.title}`, "superseded", null, nowMs) });
          }
          const what = `重开承诺：${spec.title}（规则又要它了；${describeStep(fresh)}）`;
          back.push({ type: "action", action: action(`reopen:${existing.id}:${existing.updatedAt}`, "commitment.ensure", existing.id, what, "done", null, nowMs) });
          gated.push({ kind: "reopen", person: spec.owner, what, events: [{ type: "commitment.changed", id: existing.id, patch: { ...reopened, updatedAt: nowIso(nowMs) } }, ...back] });
          diff.reopenedCommitments!.push(spec.key);
          continue;
        }
        if (existing.status !== "scheduled" && existing.status !== "waiting") continue;
        const patch = specPatch(existing, spec);
        if (!patch) continue;
        // A trigger moved into the future takes back the question already asked, and the record
        // that its rounds were asked, so that they are asked again from the new trigger.
        const takenBack: EventBody[] = [];
        if (patch.trigger && "at" in patch.trigger && Date.parse(patch.trigger.at) > nowMs && existing.status === "waiting") {
          patch.status = "scheduled";
          patch.rounds = 0;
          patch.lastAskedAt = null;
          for (let round = 1; round <= existing.rounds; round++) {
            takenBack.push({ type: "action", action: action(`ask:${existing.id}:${round}`, "ask", existing.id, `收回：${existing.title}（触发时间改到 ${patch.trigger.at.slice(5, 16).replace("T", " ")}）`, "superseded", null, nowMs) });
          }
        }
        gated.push({
          kind: "change",
          person: existing.owner,
          what: `改承诺：${existing.title}`,
          events: [{ type: "commitment.changed", id: existing.id, patch: { ...patch, updatedAt: nowIso(nowMs) } }, ...takenBack],
        });
        diff.changedCommitments!.push(existing.key);
      }
      for (const c of Object.values(state.commitments)) {
        if (c.caseId !== item.key || c.origin.by !== "rule" || c.origin.who !== rule.name || wanted.has(c.key)) continue;
        // Asked or not: when what it asked about is now known, the question goes (and its card closes).
        if (c.status === "scheduled" || c.status === "waiting") {
          gated.push({
            kind: "cancel",
            person: c.owner,
            what: `撤承诺：${c.title}（${NOT_WANTED}）`,
            events: [{ type: "commitment.changed", id: c.id, patch: { status: "cancelled", reason: NOT_WANTED, updatedAt: nowIso(nowMs) } }],
          });
          diff.droppedCommitments.push(c.key);
        }
      }
    }
    for (const c of creations) {
      const what = `建承诺：${c.title}（${describeStep(c)}）`;
      gated.push({
        kind: "create",
        person: c.owner,
        what,
        events: [
          { type: "commitment.created", commitment: c },
          { type: "action", action: action(`ensure:${c.key}`, "commitment.ensure", c.id, what, "done", null, nowMs) },
        ],
      });
    }
    diff.newCommitments = creations.map((c) => c.key);
    if (changed) {
      events.push(firstLoad ? { type: "rules.loaded", fingerprint: set.fingerprint, files: set.files } : { type: "rules.changed", from: state.rules.fingerprint, to: set.fingerprint, diff });
      // The breaker counts every change to commitments the new rules make at once: a wrong
      // condition takes questions back as easily as it adds them.
      const count = (kind: Gated["kind"]) => gated.filter((g) => g.kind === kind).length;
      const changes = { newCommitments: count("create"), dropped: count("cancel"), changed: count("change"), reopened: count("reopen") };
      const total = changes.newCommitments + changes.dropped + changes.changed + changes.reopened;
      if (!firstLoad && total > config.policy.ruleBreakerChanges && !state.rules.released.includes(set.fingerprint)) {
        events.push({ type: "rules.held", fingerprint: set.fingerprint, ...changes });
        events.push({ type: "eval.candidate", kind: "rule-breaker", subject: set.fingerprint, detail: `规则改动会一下子${describeChanges(changes)}` });
      }
    }
    append(events);
    const held = state.rules.held?.fingerprint === set.fingerprint;
    const done: EventBody[] = [];
    for (const g of gated) {
      if (held) {
        plan.push({ at: nowIso(nowMs), kind: "held", person: g.person, summary: `规则改动挂起，没做：${g.what}` });
        continue;
      }
      done.push(...g.events);
      plan.push({ at: nowIso(nowMs), kind: g.kind === "fact" ? "note" : "commitment", person: g.person, summary: g.what });
    }
    append(done);
  }

  const action = (key: string, kind: Action["kind"], subject: string, summary: string, status: Action["status"], reason: string | null, nowMs: number): Action => ({
    key,
    kind,
    subject,
    summary,
    status,
    reason,
    at: nowIso(nowMs),
  });

  function describeStep(c: Commitment): string {
    const step = nextStep(c, tz, calendar);
    if (!step) return c.status;
    const when = nowIso(step.atMs).slice(5, 16).replace("T", " ");
    if (step.what === "ask") return `${when} 问 ${personName(c.owner)}`;
    if (step.what === "nag") return `${when} 第 ${step.round} 次问`;
    if (step.what === "exhausted") return `问满了 ${c.nag.max} 次，${when} 到兜底`;
    return `${when} 到兜底`;
  }

  const personName = (id: string) => config.persons[id]?.name ?? id;

  // ---- asking -----------------------------------------------------------------------------

  function openCards(person?: string): Card[] {
    return Object.values(state.cards).filter((c) => (c.status === "pending" || c.status === "raised") && (!person || c.person === person));
  }

  /**
   * Each question's header on this card. The app keys answers by header, so two questions with
   * the same one (rules may repeat themselves) get "（2）", "（3）" on the later ones.
   */
  function headersOf(ids: string[]): Map<string, string> {
    const count = new Map<string, number>();
    const out = new Map<string, string>();
    for (const id of ids) {
      const c = state.commitments[id];
      if (!c) continue;
      const n = (count.get(c.ask.header) ?? 0) + 1;
      count.set(c.ask.header, n);
      out.set(id, n === 1 ? c.ask.header : `${c.ask.header}（${n}）`);
    }
    return out;
  }

  function contentOf(card: Card): CardContent {
    const headers = headersOf(card.commitments.map(({ id }) => id));
    const questions = card.commitments
      .map(({ id }) => state.commitments[id])
      .filter((c): c is Commitment => !!c)
      .map((c) => ({ commitmentId: c.id, header: headers.get(c.id)!, question: c.ask.question, options: c.ask.options, allowOther: c.ask.allowOther }));
    const briefs = card.commitments
      .map(({ id, round }) => {
        const c = state.commitments[id];
        if (!c) return null;
        const asked = round > 1 ? `（第 ${round} 次问，前面没有回答）` : "";
        return `### ${headers.get(c.id)}：${c.title}${asked}\n\n${c.brief}`;
      })
      .filter((b): b is string => !!b);
    return { title: card.title, brief: briefs.join("\n\n"), questions };
  }

  function cardTitle(commitments: Commitment[]): string {
    if (commitments.length === 1) return commitments[0]!.ask.question;
    const headers = headersOf(commitments.map((c) => c.id));
    return `${commitments.length} 件事要你回答：${commitments.map((c) => headers.get(c.id)).join("、")}`;
  }

  /**
   * A source, or one file of it, that has not been read for sourceDownHours: the admin is told on a
   * card with only 知道了, once per outage (it goes through quiet hours like any card). What rests
   * on it waits meanwhile, so without the card the silence would look like nothing to ask.
   */
  function outages(nowMs: number, plan: PlanEntry[]): void {
    const admin = Object.values(config.persons).find((p) => p.admin);
    const limitMs = config.policy.sourceDownHours * 3_600_000;
    const ongoing = new Set<string>();
    const events: EventBody[] = [];
    for (const s of config.sources) {
      const h = state.sources[s.id]?.health;
      if (!h) continue;
      const down = [...(h.downSince ? [[s.id, h.downSince] as const] : []), ...Object.entries(h.failingSince ?? {})];
      for (const [what, since] of down) {
        if (nowMs - Date.parse(since) < limitMs) continue;
        const key = `source-down:${what}:${since}`;
        ongoing.add(key);
        if (!admin) lastProblems.push(`${what} 从 ${since.slice(5, 16).replace("T", " ")} 起读不到，但 persons.json 里没有 admin，没人收故障卡`);
        if (!admin || state.commitments[commitmentId(key)]) continue;
        const at = since.slice(5, 16).replace("T", " ");
        const said = `${what} 从 ${at} 起读不到，依赖它的判断和提醒先停着`;
        events.push({
          type: "commitment.created",
          commitment: {
            id: commitmentId(key),
            key,
            title: `${what} 读不到`,
            domain: s.domain,
            owner: admin.id,
            caseId: null,
            trigger: { at: nowIso(nowMs) },
            ask: { person: admin.id, header: `${what} 故障`.slice(0, 40), question: said, options: [{ id: "ack", label: "知道了", description: "" }], allowOther: true },
            brief: [
              `来源 **${what}** 从 ${at} 起一直没读到，超过 ${config.policy.sourceDownHours} 小时了。依赖它的判断标着「数据可能过时」，要问的问题先不发；读到了会自动接上，这张卡不用回。`,
              "",
              "最后一次的错误：",
              "",
              "```",
              (h.lastError ?? "（没有记下）").slice(0, 500),
              "```",
              "",
              "常见原因：登录过期、地址变了、网络或服务器出了问题。",
            ].join("\n"),
            nag: { everyWorkdays: 1, at: "10:00", max: 1 },
            backstop: { at: nowIso(nowMs + 7 * DAY), outcome: "expire" },
            level: "push",
            origin: { by: "controller", who: "source-down" },
            status: "scheduled",
            rounds: 0,
            lastAskedAt: null,
            answer: null,
            createdAt: nowIso(nowMs),
            updatedAt: nowIso(nowMs),
            reason: null,
          },
        });
        plan.push({ at: nowIso(nowMs), kind: "notice", person: admin.id, summary: `告诉 ${admin.name}：${said}` });
      }
    }
    // An outage that is over: its card, if not answered yet, goes.
    for (const c of Object.values(state.commitments)) {
      if (c.origin.by !== "controller" || !c.key.startsWith("source-down:") || ongoing.has(c.key)) continue;
      if (c.status === "scheduled" || c.status === "waiting") events.push({ type: "commitment.changed", id: c.id, patch: { status: "cancelled", reason: "来源恢复了", updatedAt: nowIso(nowMs) } });
    }
    append(events);
  }

  async function askDue(nowMs: number, plan: PlanEntry[]): Promise<void> {
    outages(nowMs, plan);
    // Backstops first: an expired commitment is not asked again.
    const expiring: EventBody[] = [];
    for (const c of Object.values(state.commitments)) {
      if (!backstopPassed(c, nowMs)) continue;
      expiring.push({ type: "commitment.changed", id: c.id, patch: { status: "expired", reason: "到了兜底时间还没有回答", updatedAt: nowIso(nowMs) } });
      if (c.origin.by !== "controller") expiring.push({ type: "eval.candidate", kind: "commitment-expired", subject: c.id, detail: c.title });
      plan.push({ at: nowIso(nowMs), kind: "expire", person: c.owner, summary: `兜底到期${c.rounds === 0 ? "（一次都没问到）" : ""}：${c.title}` });
    }
    append(expiring);
    for (const card of openCards()) {
      if (card.commitments.every(({ id }) => state.commitments[id]?.status !== "waiting" && state.commitments[id]?.status !== "scheduled")) {
        append([{ type: "card.changed", id: card.id, patch: { status: "closed", reason: "上面的事都结束了", closedAt: nowIso(nowMs) } }]);
      }
    }

    // Cards that lost their carrier (a restart outside the person's hours) get one when they may
    // be reached again; the same card, so it does not count against the day's budget again.
    for (const card of openCards()) {
      if (card.status !== "pending" || card.agentId !== null || card.attempts === 0) continue;
      const person = config.persons[card.person];
      if (!person) continue;
      const domains = card.commitments.map(({ id }) => state.commitments[id]?.domain).filter((d): d is Commitment["domain"] => !!d);
      const verdict = mayReach(person, domains, 0, nowMs, calendar);
      if (!verdict.send) continue;
      plan.push({ at: nowIso(nowMs), kind: "card", person: card.person, summary: `补发卡片给 ${person.name}：「${card.title}」` });
      if (deps.mode === "dry-run" || !deps.carrier || nowMs < carrierRetryAt || stopped) continue;
      await startCarrier(card, nowMs);
    }

    // Messages to channels that failed: tried again, once per reconcile, while the card is up.
    if (deps.mode === "live") for (const card of openCards()) if (card.status === "raised" && card.agentId) await notify(card, nowMs);

    const ignored: EventBody[] = [];
    const byPerson = new Map<string, Due[]>();
    for (const c of Object.values(state.commitments)) {
      const step = nextStep(c, tz, calendar);
      // The controller's own statements ask nothing: one left unanswered is no candidate.
      if (step?.what === "exhausted" && c.status === "waiting" && c.lastAskedAt && c.origin.by !== "controller") {
        const key = `eval:nag-ignored:${c.id}`;
        if (!state.ledger[key]) {
          ignored.push({ type: "eval.candidate", kind: "nag-ignored", subject: c.id, detail: `${c.title}：问了 ${c.rounds} 次没有回答` });
          ignored.push({ type: "action", action: action(key, "note.set", c.id, "记评测候选：问了没人答", "done", null, nowMs) });
        }
      }
      const due = dueNow(c, nowMs, tz, calendar);
      if (!due) continue;
      if (state.ledger[`ask:${c.id}:${due.round}`]?.status === "done") continue;
      const list = byPerson.get(c.ask.person) ?? [];
      list.push(due);
      byPerson.set(c.ask.person, list);
    }
    append(ignored);

    // Nothing a rule asks goes out on data it rests on that may be old; it waits until that is read
    // again. Questions resting on other data go.
    const stale = staleNow(nowMs);
    if (stale.length > 0) {
      for (const [personId, dues] of byPerson) {
        const waiting = new Map<string, string[]>();
        const going = dues.filter((d) => {
          if (d.commitment.origin.by !== "rule") return true;
          const c = d.commitment;
          const on = blockers(lastUses.get(c.id) ?? (c.caseId ? lastReads.get(c.caseId) : undefined), stale);
          if (on.length === 0) return true;
          const k = on.join("、");
          waiting.set(k, [...(waiting.get(k) ?? []), c.ask.header]);
          return false;
        });
        for (const [on, headers] of waiting) plan.push({ at: nowIso(nowMs), kind: "deferred", person: personId, summary: `数据可能过时（${on}），先不问：${headers.join("、")}` });
        byPerson.set(personId, going);
      }
    }

    for (const [personId, dues] of byPerson) {
      if (dues.length === 0) continue;
      const person = config.persons[personId];
      if (!person) {
        plan.push({ at: nowIso(nowMs), kind: "deferred", person: personId, summary: `没有这个人的配置（persons.json）：${dues.map((d) => d.commitment.title).join("、")}` });
        continue;
      }
      const carried = openCards(personId).flatMap((card) => card.commitments).filter(({ id }) => !dues.some((d) => d.commitment.id === id) && state.commitments[id]?.status === "waiting");
      const verdict = mayReach(person, dues.map((d) => d.commitment.domain), cardsToday(Object.values(state.cards), person, nowMs), nowMs, calendar);
      const titles = dues.map((d) => `${d.commitment.ask.header}${d.why === "nag" ? `（第 ${d.round} 次）` : ""}`).join("、");
      if (!verdict.send) {
        const why = verdict.reason === "quiet" ? "不打扰时段" : "今天的推送用完了";
        plan.push({ at: nowIso(nowMs), kind: "deferred", person: personId, summary: `${why}，延到 ${nowIso(verdict.until).slice(5, 16).replace("T", " ")} 再问 ${person.name}：${titles}` });
        continue;
      }
      const all = [...dues.map((d) => ({ id: d.commitment.id, round: d.round })), ...carried];
      const commitments = all.map(({ id }) => state.commitments[id]!).filter(Boolean);
      const id = `card_${hash(JSON.stringify(all) + nowMs).slice(0, 12)}`;
      const card: Card = {
        id,
        person: personId,
        commitments: all,
        title: cardTitle(commitments),
        status: "pending",
        agentId: null,
        attempts: 0,
        archived: false,
        raisedAt: nowIso(nowMs),
        closedAt: null,
        reason: null,
      };
      plan.push({ at: nowIso(nowMs), kind: "card", person: personId, summary: `发问题卡给 ${person.name}：「${card.title}」（${all.length} 个问题${carried.length > 0 ? `，含 ${carried.length} 个上一张卡上没答的` : ""}）` });
      if (deps.mode === "dry-run") {
        for (const target of person.notify) plan.push({ at: nowIso(nowMs), kind: "card", person: personId, summary: `会发 ${labelOf(target)}：${card.title}` });
        continue;
      }
      if (!deps.carrier) {
        lastProblems.push("这个 Paseo 没有给插件提供 server.paseo，发不了卡片");
        continue;
      }
      if (nowMs < carrierRetryAt || stopped) continue;
      await raise(card, dues, nowMs);
    }
  }

  async function raise(card: Card, dues: Due[], nowMs: number): Promise<void> {
    // The cards this one takes over are closed only once it is up: if it fails, they stay.
    const previous = openCards(card.person);
    // As they were, for going back if the card cannot be raised (the state objects change below).
    const before = dues.map((d) => ({ status: d.commitment.status, rounds: d.commitment.rounds, lastAskedAt: d.commitment.lastAskedAt }));
    const intents: EventBody[] = [{ type: "card.created", card }];
    for (const d of dues) {
      intents.push({ type: "action", action: action(`ask:${d.commitment.id}:${d.round}`, "ask", d.commitment.id, `问 ${personName(card.person)}：${d.commitment.ask.question}`, "planned", null, nowMs) });
      intents.push({ type: "commitment.changed", id: d.commitment.id, patch: { status: "waiting", rounds: d.round, lastAskedAt: nowIso(nowMs), updatedAt: nowIso(nowMs) } });
    }
    append(intents);
    await startCarrier(card, nowMs, dues, previous, before);
  }

  async function startCarrier(card: Card, nowMs: number, dues: Due[] = [], replaces: Card[] = [], before: Array<Pick<Commitment, "status" | "rounds" | "lastAskedAt">> = []): Promise<void> {
    if (stopped) return;
    const attempt = card.attempts + 1;
    try {
      const agentId = await deps.carrier!.raise(card, contentOf(card), attempt);
      // Stopped while it was being raised: nothing may be written now, and the next engine raises
      // the card again, so this carrier would be one nobody tracks. It goes.
      if (stopped) {
        await deps.carrier!.archive(agentId).catch((error: unknown) => deps.log(`archiving ${agentId} after a stop failed: ${(error as Error).message}`));
        return;
      }
      append([
        { type: "card.changed", id: card.id, patch: { status: "raised", agentId, attempts: attempt } },
        ...dues.map((d) => ({ type: "action", action: action(`ask:${d.commitment.id}:${d.round}`, "ask", d.commitment.id, `问 ${personName(card.person)}：${d.commitment.ask.question}`, "done", null, nowMs) }) as EventBody),
        ...replaces.map((old) => ({ type: "card.changed", id: old.id, patch: { status: "closed", reason: `并进了新卡 ${card.id}`, closedAt: nowIso(nowMs) } }) as EventBody),
      ]);
      // Up: the same moment, to the person's channels. A failure there does not take the card back.
      await notify(card, nowMs);
    } catch (error) {
      const message = (error as Error).message;
      deps.log(`card ${card.id}: could not start its carrier: ${message}`);
      carrierRetryAt = nowMs + CARRIER_RETRY_MS;
      // A card re-raised for a carrier it lost stays open and waits for the next try; a new one is closed.
      const events: EventBody[] =
        dues.length === 0 && card.attempts > 0
          ? [{ type: "card.changed", id: card.id, patch: { status: "pending", agentId: null, attempts: attempt, reason: `起不了卡片：${message}` } }]
          : [{ type: "card.changed", id: card.id, patch: { status: "closed", attempts: attempt, reason: `起不了卡片：${message}`, closedAt: nowIso(nowMs) } }];
      dues.forEach((d, i) => {
        events.push({ type: "action", action: action(`ask:${d.commitment.id}:${d.round}`, "ask", d.commitment.id, `问 ${personName(card.person)}：${d.commitment.ask.question}`, "failed", message, nowMs) });
        // Back to how it was, so the next try asks the same round.
        const was = before[i];
        events.push({
          type: "commitment.changed",
          id: d.commitment.id,
          patch: was ? { status: was.status, rounds: was.rounds, lastAskedAt: was.lastAskedAt } : { status: d.round === 1 ? "scheduled" : "waiting", rounds: d.round - 1 },
        });
      });
      append(events);
      lastProblems.push(`发不了卡片：${message}`);
    }
  }

  const labelOf = (target: { channel: string; label?: string }) => target.label ?? target.channel;
  const notifyKey = (card: Card, target: { channel: string; to: string }) => `notify:${card.id}:${target.channel}:${target.to}`;

  /** What a card says on a channel where it cannot be answered: statements in full, questions with their options. */
  function notifyText(card: Card): string {
    const content = contentOf(card);
    const asks = content.questions.some((q) => q.options.length > 1);
    const parts = content.questions.map((q) => {
      const c = state.commitments[q.commitmentId];
      // A question with one option is a statement to acknowledge: all of it, the brief included.
      if (q.options.length === 1) return [q.question, ...(c?.brief ? ["", c.brief] : [])].join("\n");
      return [q.question, ...q.options.map((o) => `- ${o.label}${o.description ? `：${o.description}` : ""}`), ...(q.allowOther ? ["- 其他（自己写）"] : [])].join("\n");
    });
    return [...parts.map((p, i) => (content.questions.length > 1 ? `${i + 1}. ${p}` : p)), ...(asks ? ["在 Paseo「事务」里回答"] : [])].join("\n\n");
  }

  /**
   * Sends a raised card to each channel its person has, once per card: a carrier raised again for
   * the same card (a restart) does not send again, a new card does. Up to MAX_NOTIFY_TRIES tries,
   * one per reconcile; each try is in the ledger, and the channel gets a key stable per card.
   */
  async function notify(card: Card, nowMs: number): Promise<void> {
    const person = config.persons[card.person];
    if (!person || !deps.deliver || stopped) return;
    for (const target of person.notify) {
      const key = notifyKey(card, target);
      const before = state.ledger[key];
      if (before?.status === "done") continue;
      const tries = (before?.tries ?? 0) + 1;
      if (tries > MAX_NOTIFY_TRIES) continue;
      const summary = `发 ${labelOf(target)}：${card.title}`;
      try {
        await deps.deliver(target.channel, { to: target.to, idempotencyKey: `${deps.instanceId}:${key}`, title: card.title, text: notifyText(card), status: "succeeded" });
        append([{ type: "action", action: { ...action(key, "notify", card.id, summary, "done", null, nowMs), tries } }]);
      } catch (error) {
        const message = (error as Error).message;
        deps.log(`card ${card.id}: sending to ${target.channel} failed (${tries}): ${message}`);
        append([{ type: "action", action: { ...action(key, "notify", card.id, summary, "failed", message.slice(0, 300), nowMs), tries } }]);
      }
    }
  }

  async function archiveFinished(): Promise<void> {
    if (!deps.carrier || deps.mode === "dry-run") return;
    for (const card of Object.values(state.cards)) {
      if (card.archived || !card.agentId || (card.status !== "closed" && card.status !== "answered")) continue;
      try {
        await deps.carrier.archive(card.agentId);
      } catch (error) {
        deps.log(`card ${card.id}: archiving ${card.agentId} failed: ${(error as Error).message}`);
      }
      append([{ type: "card.changed", id: card.id, patch: { archived: true } }]);
    }
  }

  // ---- public -----------------------------------------------------------------------------

  return {
    /** After a start: cards whose carriers died with the previous process get new ones. */
    async recover(): Promise<void> {
      const nowMs = deps.now();
      append([{ type: "started", instanceId: deps.instanceId, mode: deps.mode, pid: process.pid, home: deps.home }]);
      if (deps.mode === "dry-run" || !deps.carrier) return;
      for (const card of openCards()) {
        if (card.agentId) {
          await deps.carrier.archive(card.agentId).catch((error: Error) => deps.log(`archiving the old carrier ${card.agentId} failed: ${error.message}`));
        }
        // Quiet hours hold for a card brought back too: outside them it waits, without a carrier.
        const person = config.persons[card.person];
        const domains = card.commitments.map(({ id }) => state.commitments[id]?.domain).filter((d): d is Commitment["domain"] => !!d);
        if (person && !mayReach(person, domains, 0, nowMs, calendar).send) {
          append([{ type: "card.changed", id: card.id, patch: { status: "pending", agentId: null, attempts: Math.max(card.attempts, 1) } }]);
          continue;
        }
        await startCarrier(card, nowMs);
      }
    },

    tick(): Promise<void> {
      if (stopped) return Promise.resolve();
      store.touch();
      if (ticking) return inFlight;
      ticking = true;
      inFlight = (async () => {
        const nowMs = deps.now();
        tickStartedAt = nowMs;
        const plan: PlanEntry[] = [];
        lastProblems = [];
        try {
          await pollSources(nowMs);
          if (!stopped) await judgeAll(nowMs, plan);
          if (!stopped) await askDue(nowMs, plan);
          if (!stopped) await archiveFinished();
        } catch (error) {
          deps.log(`tick failed: ${(error as Error).stack ?? error}`);
          lastProblems.push(`这次对账出错：${(error as Error).message}`);
        } finally {
          lastTickAt = nowMs;
          lastPlan = plan;
          ticking = false;
          if (!stopped) deps.writeStatus(status());
        }
      })();
      return inFlight;
    },

    /** Whether a reconcile is running right now. */
    busy(): boolean {
      return ticking;
    },

    /**
     * Stops for good: a tick in flight does no more after the step it is in, and none starts.
     * Resolves once the one in flight is over.
     */
    stop(): Promise<void> {
      stopped = true;
      return inFlight;
    },

    card(cardId: string): CardContent | null {
      const card = state.cards[cardId];
      if (!card || (card.status !== "pending" && card.status !== "raised")) return null;
      return contentOf(card);
    },

    /** A person answered (or closed) a card. Returns what to say back in the conversation. */
    answer(cardId: string, answer: CardAnswer): string {
      const card = state.cards[cardId];
      const nowMs = deps.now();
      if (!card || (card.status !== "pending" && card.status !== "raised")) return "这张卡已经结束了，这次的回答没有记下。";
      const at = nowIso(nowMs);
      if (answer.kind === "closed") {
        append([{ type: "card.changed", id: cardId, patch: { status: "closed", reason: "卡片被关掉了，没有回答", closedAt: at, archived: true } }]);
        return "";
      }
      if (answer.kind === "dismissed") {
        append([{ type: "card.changed", id: cardId, patch: { status: "closed", reason: "收起了，没有回答", closedAt: at } }]);
        return "**已收起**，没有记任何回答。到下次追问的时间会再问。";
      }
      const events: EventBody[] = [];
      const lines: string[] = [];
      const headers = headersOf(card.commitments.map(({ id }) => id));
      for (const { id } of card.commitments) {
        const c = state.commitments[id];
        if (!c || (c.status !== "waiting" && c.status !== "scheduled")) continue;
        let raw: string | undefined;
        if (answer.kind === "answers") raw = answer.answers[headers.get(id)!];
        else if (card.commitments.length === 1) raw = answer.text;
        if (raw === undefined || raw.trim() === "") continue;
        const option = c.ask.options.find((o) => o.label === raw);
        const recorded = { option: option?.id ?? null, label: option?.label ?? "其他", text: option ? null : raw, at, via: answer.kind === "answers" ? answer.via : "typed" };
        events.push({ type: "commitment.changed", id, patch: { status: "done", answer: recorded, reason: null, updatedAt: at } });
        events.push({
          type: "obs",
          obs: {
            id: hash(`${cardId}\0${id}`).slice(0, 16),
            at,
            seenAt: at,
            source: "ask",
            key: c.caseId ?? c.id,
            kind: "answer",
            trust: "human",
            actor: { name: personName(card.person), machine: false },
            changes: [],
            text: `${c.ask.question} → ${option ? option.label : raw}`,
          },
        });
        lines.push(`- ${headers.get(id)}：${option ? option.label : `「${raw}」`}`);
      }
      if (lines.length === 0) {
        if (answer.kind === "typed") {
          append([{ type: "card.changed", id: cardId, patch: { status: "closed", reason: "在对话里打了字，没法对应到具体问题", closedAt: at } }]);
          return "**这句话没法对应到某一个问题**（这张卡上有几个问题），所以没有记成回答。到下次追问的时间会再问，或者等新卡出来时在卡上选。";
        }
        append([{ type: "card.changed", id: cardId, patch: { status: "closed", reason: "回答是空的", closedAt: at } }]);
        return "回答是空的，什么都没记。";
      }
      events.push({ type: "card.changed", id: cardId, patch: { status: "answered", closedAt: at } });
      append(events);
      return [`**已记下**：`, ...lines, "", "接下来怎么跟，由规则在下一次对账时决定，可以在「事务」里看。"].join("\n");
    },

    /**
     * A test card for the admin, asked by the next reconcile like any other commitment -- so it
     * goes through quiet hours, the budget and the carrier, and shows whether the app renders
     * the question form. Not tied to any case.
     */
    testCard(): { ok: boolean; detail: string } {
      const admin = Object.values(config.persons).find((p) => p.admin);
      if (!admin) return { ok: false, detail: "persons.json 里没有 admin: true 的人" };
      const nowMs = deps.now();
      const key = `test:${nowMs}`;
      const c: Commitment = {
        id: commitmentId(key),
        key,
        title: "测试卡",
        domain: "work",
        owner: admin.id,
        caseId: null,
        trigger: { at: nowIso(nowMs) },
        ask: {
          person: admin.id,
          header: "测试",
          question: "「事务」测试卡：能看到选项、能选、能在「其他」里写字吗？",
          options: [
            { id: "ok", label: "都正常", description: "选了这张卡就结束" },
            { id: "odd", label: "看得到，但有地方不对", description: "哪里不对写在「其他」里更好" },
          ],
          allowOther: true,
        },
        brief: "这是一张测试卡，不对应任何事务。选一个答案，或者在「其他」里写一句话，回答会记进日志；不回答的话一天后自动过期。",
        nag: { everyWorkdays: 1, at: "10:00", max: 1 },
        backstop: { at: nowIso(nowMs + 24 * 3_600_000), outcome: "expire" },
        level: "push",
        origin: { by: "human", who: "test-card" },
        status: "scheduled",
        rounds: 0,
        lastAskedAt: null,
        answer: null,
        createdAt: nowIso(nowMs),
        updatedAt: nowIso(nowMs),
        reason: null,
      };
      append([{ type: "commitment.created", commitment: c }]);
      return { ok: true, detail: `给 ${admin.name} 排了一张测试卡，下一次对账发出（不打扰时段和每天的上限照样算）` };
    },

    releaseRules(fingerprint: string): boolean {
      if (state.rules.held?.fingerprint !== fingerprint) return false;
      append([{ type: "rules.released", fingerprint }]);
      return true;
    },

    status,
  };

  /** Channels a card should have gone to and did not, for the open cards; and a host that cannot send at all. */
  function notifyProblems(): string[] {
    const out: string[] = [];
    const wanted = Object.values(config.persons).flatMap((p) => p.notify.map(labelOf));
    if (wanted.length > 0 && !deps.deliver) out.push(`这个 daemon 不支持投递，${[...new Set(wanted)].join("、")} 收不到`);
    for (const card of openCards()) {
      for (const target of config.persons[card.person]?.notify ?? []) {
        const a = state.ledger[notifyKey(card, target)];
        if (a?.status !== "failed") continue;
        out.push(`${labelOf(target)} 没发出去：${a.reason ?? "不知道原因"}${(a.tries ?? 0) >= MAX_NOTIFY_TRIES ? `（试了 ${a.tries} 次，不再试）` : ""}`);
      }
    }
    return out;
  }

  function status(): Status {
    const nowMs = deps.now();
    const openCommitments = Object.values(state.commitments).filter((c) => c.status === "scheduled" || c.status === "waiting");
    const judged = Object.values(state.items).filter((item) => (ruleset?.rules ?? []).some((r) => r.source === item.source));
    const heat = (key: string) => lastHeat.get(key) ?? [];
    const cold = judged
      .filter((item) => heat(item.key).length === 0)
      .map((item) => ({ caseId: item.key, title: item.title, status: item.status, observedAt: item.observedAt }));
    const cases = judged.filter((item) => heat(item.key).length > 0).map((item) => {
      const assessment = state.assessments[item.key] ?? null;
      const commitments = Object.values(state.commitments)
        .filter((c) => c.caseId === item.key)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((c) => ({ id: c.id, title: c.title, status: c.status, step: describeStep(c), answer: c.answer ? (c.answer.text ?? c.answer.label) : null, reason: c.reason }));
      return {
        caseId: item.key,
        title: item.title,
        url: item.url,
        status: item.status,
        closed: item.closed,
        observedAt: item.observedAt,
        assessment,
        commitments,
        open: commitments.some((c) => c.status === "scheduled" || c.status === "waiting"),
        hot: heat(item.key),
      };
    });
    // Most urgent first: a rule error, then what is wrong, then what waits, then what is fine.
    const rank = (k: (typeof cases)[number]) => (k.assessment?.error ? 0 : k.commitments.some((c) => c.status === "waiting") ? 1 : (SEVERITY[k.assessment?.health ?? ""] ?? 9));
    cases.sort((a, b) => rank(a) - rank(b));
    return {
      instanceId: deps.instanceId,
      mode: deps.mode,
      now: nowIso(nowMs),
      lastTickAt: lastTickAt === null ? null : nowIso(lastTickAt),
      ticking,
      tickStartedAt: ticking && tickStartedAt !== null ? nowIso(tickStartedAt) : null,
      tickSeconds: deps.tickSeconds,
      sources: config.sources.map((s) => {
        const h = state.sources[s.id]?.health;
        return {
          id: s.id,
          state: h?.state ?? "never",
          lastOkAt: h?.lastOkAt ?? null,
          lastError: h?.lastError ?? null,
          nextPollAt: h?.nextPollAt ? nowIso(h.nextPollAt) : null,
          callsLastHour: h ? h.calls.filter((t) => nowMs - t < 3_600_000).length : 0,
        };
      }),
      rules: {
        fingerprint: ruleset?.fingerprint ?? state.rules.fingerprint,
        files: ruleset?.files ?? [],
        errors: ruleset?.errors ?? [],
        held: state.rules.held,
      },
      calendarYears: config.calendarYears,
      problems: [
        ...(deps.notices ?? []),
        ...lastProblems,
        ...notifyProblems(),
        ...Object.values(state.items)
          .filter((i) => (i.incomplete?.length ?? 0) > 0 && heat(i.key).length > 0)
          .map((i) => `${i.key} 有提交一直读不到，按读到的判断（不据此提醒）：${i.incomplete!.join("；").slice(0, 200)}`),
        ...config.calendar.missingYears([localParts(nowMs, tz).date, addDays(localParts(nowMs, tz).date, 60)]).map((y) => `日历缺 ${y} 年的节假日表，按周一到周五算`)],
      cards: openCards().map((c) => ({
        id: c.id,
        person: personName(c.person),
        title: c.title,
        agentId: c.agentId,
        status: c.status,
        raisedAt: c.raisedAt,
        questions: c.commitments.length,
        caseIds: [...new Set(c.commitments.map(({ id }) => state.commitments[id]?.caseId).filter((k): k is string => !!k))],
      })),
      cases,
      cold,
      openCommitments: openCommitments.length,
      plan: lastPlan,
      evals: state.evals,
      pushesToday: Object.fromEntries(Object.values(config.persons).map((p) => [p.name, cardsToday(Object.values(state.cards), p, nowMs)])),
    };
  }
}

export type Engine = ReturnType<typeof createEngine>;
export type EngineStatus = Status;
export type { PlanEntry };
