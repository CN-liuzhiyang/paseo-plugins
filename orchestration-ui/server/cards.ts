import { watch as fsWatch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { CARD_KIND, CARD_VERSION, cardItemId, cardKey, cardOf, isFinished, urgentChange, type RunCard } from "../shared/card";
import { applyEvent, createRun, foldEvents, runStatus, type RunState } from "../shared/run";
import { checkProcess, localProbe, type Probe } from "./alive";
import { readFrom, readHeadLine, readTailLines } from "./lines";

// Cards in the conversations that started runs. This side watches <logDir>/runs, folds each run
// that a local Paseo agent started, and appends its card to that agent's timeline; appending
// again under the same id replaces the card where it is. The daemon keeps those items in memory
// only, so after a restart the cards of runs still going (or just finished) are appended again.
//
// What gets a card: run.start names a caller, was written on this machine (the caller id means
// nothing to another machine's daemon), and the daemon knows that agent. A caller the daemon has
// not loaded yet is tried again every few seconds until the run has been over a while.

const SUFFIX = ".jsonl";
/** File events for one run are handled together this long after the first. */
export const COALESCE_MS = 1_000;
/** Between two appends for one run, unless the change is urgent (see urgentChange). */
export const SPACING_MS = 2_000;
/** Unfinished runs are looked at again this often: a process can die without writing anything. */
export const RECHECK_MS = 5_000;
/** The whole directory is listed again this often, in case a file event went missing. */
export const RESCAN_MS = 30_000;
/** The first wait before trying an unknown caller again; doubles up to MAX_RETRY_MS. Each try is an error line in the daemon log. */
export const RETRY_MS = 30_000;
/** The longest wait between two tries. */
export const MAX_RETRY_MS = 10 * 60_000;
/** A run that ended longer ago than this gets no card when first seen (after a restart, say). */
export const RECENT_END_MS = 10 * 60_000;
/** Files not touched for this long are not looked at, and an unfinished run is given up on. */
export const HORIZON_MS = 24 * 60 * 60_000;
/** Past this a run is not folded for a card. */
const FOLD_LIMIT = 64 << 20;

export interface CardItem {
  type: "plugin";
  id: string;
  kind: string;
  version: number;
  data: RunCard;
}

/** Appends to an agent's timeline. Rejects with the daemon's error. */
export type AppendCard = (agentId: string, item: CardItem) => Promise<unknown>;

export interface CardFeedOptions {
  append: AppendCard;
  /** Where runs are, and how long a quiet run takes to count as lost; null runsDir when it cannot be resolved. */
  where(): Promise<{ runsDir: string | null; staleMs: number }>;
  now?: () => number;
  probe?: Probe;
  log?: (message: string) => void;
}

interface Tracked {
  runId: string;
  file: string;
  offset: number;
  run: RunState;
  caller: string;
  card: RunCard | null;
  /** The card last appended, and when. */
  sent: RunCard | null;
  sentAt: number;
  /** Not before this: an unknown caller, or an append that failed. */
  retryAt: number;
  failures: number;
  firstSeen: number;
}

/** The daemon's "Unknown agent '…'" and the client's wording of not found. */
export function isUnknownAgent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown agent|agent not found|not found: agent/i.test(message);
}

function parse(text: string | null | undefined): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function kindOf(value: unknown): unknown {
  return (value as { kind?: unknown } | null)?.kind;
}

export function createCardFeed({ append, where, now = Date.now, probe = localProbe, log = () => {} }: CardFeedOptions) {
  const tracked = new Map<string, Tracked>();
  /** Runs looked at and left alone: not ours, ended long ago, or done. */
  const settled = new Set<string>();
  let runsDir: string | null = null;
  let staleMs = 15 * 60_000;
  let chain: Promise<void> = Promise.resolve();

  /** One thing at a time: file reads and appends for a run never overlap. */
  function serial(work: () => Promise<void>): Promise<void> {
    chain = chain.then(work).catch((error: unknown) => log(`cards: ${String(error)}`));
    return chain;
  }

  async function consider(runId: string): Promise<Tracked | null> {
    const known = tracked.get(runId);
    if (known) return known;
    if (settled.has(runId) || runsDir === null) return null;
    const file = path.join(runsDir, `${runId}${SUFFIX}`);
    const head = parse(await readHeadLine(file).catch(() => null));
    // No complete first line yet: look again on the next event.
    if (head === null) return null;
    if (kindOf(head) !== "run.start") {
      settled.add(runId);
      return null;
    }
    const start = foldEvents([head]).start!;
    const local = start.hostname !== null && start.hostname.toLowerCase() === probe.hostname.toLowerCase();
    if (!start.caller || !local) {
      settled.add(runId);
      return null;
    }
    // After a restart: a run that ended a while ago keeps whatever card it has, or none.
    for (const line of await readTailLines(file).catch(() => [])) {
      const event = parse(line.text) as { kind?: unknown; ts?: unknown } | null;
      if (event?.kind !== "run.end") continue;
      const at = typeof event.ts === "string" ? Date.parse(event.ts) : NaN;
      if (!Number.isFinite(at) || now() - at > RECENT_END_MS) {
        settled.add(runId);
        return null;
      }
    }
    const entry: Tracked = {
      runId,
      file,
      offset: 0,
      run: createRun(),
      caller: start.caller,
      card: null,
      sent: null,
      sentAt: 0,
      retryAt: 0,
      failures: 0,
      firstSeen: now(),
    };
    tracked.set(runId, entry);
    return entry;
  }

  async function refresh(entry: Tracked): Promise<void> {
    const info = await stat(entry.file).catch(() => null);
    if (!info) {
      tracked.delete(entry.runId);
      settled.add(entry.runId);
      return;
    }
    if (info.size < entry.offset) {
      entry.offset = 0;
      entry.run = createRun();
    }
    if (info.size > FOLD_LIMIT) {
      tracked.delete(entry.runId);
      settled.add(entry.runId);
      log(`cards: ${entry.runId} is over ${FOLD_LIMIT} bytes; no card`);
      return;
    }
    // Look at the process before reading: one that wrote run.end and exited is then fully read.
    const proc = entry.run.end ? null : checkProcess(entry.run.start, probe);
    while (entry.offset < info.size) {
      const chunk = await readFrom(entry.file, entry.offset, 4 << 20);
      for (const line of chunk.lines) {
        const value = parse(line.text);
        if (value !== null) applyEvent(entry.run, value);
      }
      entry.offset = chunk.nextOffset;
      if (!chunk.more) break;
    }
    const at = now();
    const status = runStatus(entry.run, at, staleMs, entry.run.end ? null : proc);
    entry.card = cardOf(entry.runId, entry.run, status, at, { proc: entry.run.end ? null : proc });
  }

  /** Appends the card when it says something new and the spacing allows; settles a finished run. */
  async function deliver(entry: Tracked): Promise<void> {
    const card = entry.card;
    if (!card) return;
    const at = now();
    const fresh = entry.sent === null || cardKey(entry.sent) !== cardKey(card);
    if (fresh && at >= entry.retryAt && (urgentChange(entry.sent, card) || at - entry.sentAt >= SPACING_MS)) {
      try {
        await append(entry.caller, { type: "plugin", id: cardItemId(entry.runId), kind: CARD_KIND, version: CARD_VERSION, data: card });
        entry.sent = card;
        entry.sentAt = at;
        entry.failures = 0;
        entry.retryAt = 0;
      } catch (error) {
        entry.failures += 1;
        // Doubling waits: a caller that never comes back (archived) costs a handful of daemon
        // log lines, not one every 30 seconds for a day.
        entry.retryAt = at + Math.min(RETRY_MS * 2 ** (entry.failures - 1), MAX_RETRY_MS);
        if (isUnknownAgent(error)) {
          if (entry.failures === 1) log(`cards: agent ${entry.caller} is not loaded; run ${entry.runId} waits for it`);
        } else {
          log(`cards: appending run ${entry.runId} to ${entry.caller} failed: ${String(error)}`);
        }
      }
    }
    const over = isFinished(card.status) || (card.status === "lost" && card.lost?.procGone === true);
    const delivered = entry.sent !== null && cardKey(entry.sent) === cardKey(card);
    const endedAt = Date.parse(card.endedAt ?? card.lastEventAt ?? "");
    const gaveUp =
      (over && Number.isFinite(endedAt) && at - endedAt > RECENT_END_MS) || at - entry.firstSeen > HORIZON_MS;
    if ((over && delivered) || gaveUp) {
      tracked.delete(entry.runId);
      settled.add(entry.runId);
    }
  }

  async function handle(runId: string): Promise<void> {
    const entry = await consider(runId);
    if (!entry) return;
    await refresh(entry);
    if (tracked.has(runId)) await deliver(entry);
  }

  async function updateWhere(): Promise<void> {
    const next = await where();
    staleMs = next.staleMs;
    if (next.runsDir !== runsDir) {
      runsDir = next.runsDir;
      tracked.clear();
      settled.clear();
      if (runsDir) log(`cards: watching ${runsDir}`);
    }
  }

  /** Lists the directory and handles every run file touched within the horizon. */
  function scan(): Promise<void> {
    return serial(async () => {
      await updateWhere();
      if (!runsDir) return;
      const dir = runsDir;
      const names = await readdir(dir).catch(() => [] as string[]);
      const at = now();
      for (const name of names) {
        if (!name.endsWith(SUFFIX)) continue;
        const runId = name.slice(0, -SUFFIX.length);
        if (tracked.has(runId) || settled.has(runId)) continue;
        const info = await stat(path.join(dir, name)).catch(() => null);
        if (!info || at - info.mtimeMs > HORIZON_MS) {
          settled.add(runId);
          continue;
        }
        await handle(runId);
      }
    });
  }

  /** Looks again at every run being followed, changed or not. */
  function recheck(): Promise<void> {
    return serial(async () => {
      for (const runId of [...tracked.keys()]) await handle(runId);
    });
  }

  /** A file event, or anything else saying this run may have changed. */
  function touched(runIds: Iterable<string>): Promise<void> {
    return serial(async () => {
      for (const runId of runIds) await handle(runId);
    });
  }

  return {
    scan,
    recheck,
    touched,
    /** The card as last worked out, for a run being followed. */
    card(runId: string): RunCard | null {
      return tracked.get(runId)?.card ?? null;
    },
    get runsDir() {
      return runsDir;
    },
    /** For tests: what is being followed. */
    following(): string[] {
      return [...tracked.keys()];
    },
  };
}

export type CardFeed = ReturnType<typeof createCardFeed>;

/** A run's card read straight from its file, for one the feed is not following. */
export async function readCard(
  runsDir: string,
  runId: string,
  staleMs: number,
  { now = Date.now, probe = localProbe }: { now?: () => number; probe?: Probe } = {},
): Promise<RunCard | null> {
  const file = path.join(runsDir, `${runId}${SUFFIX}`);
  const info = await stat(file);
  if (info.size > FOLD_LIMIT) return null;
  const run = createRun();
  const proc = checkProcess(foldEvents([parse(await readHeadLine(file))]).start, probe);
  let offset = 0;
  while (offset < info.size) {
    const chunk = await readFrom(file, offset, 4 << 20);
    for (const line of chunk.lines) {
      const value = parse(line.text);
      if (value !== null) applyEvent(run, value);
    }
    offset = chunk.nextOffset;
    if (!chunk.more) break;
  }
  const at = now();
  const live = run.end ? null : proc;
  return cardOf(runId, run, runStatus(run, at, staleMs, live), at, { proc: live });
}

/**
 * Runs a feed: an initial scan, file events coalesced per run, a recheck of unfinished runs and
 * a slow rescan. Returns a stop function.
 */
export function startCardFeed(feed: CardFeed, { log = () => {} }: { log?: (message: string) => void } = {}): () => void {
  let stopped = false;
  let watcher: ReturnType<typeof fsWatch> | null = null;
  let watching: string | null = null;
  const dirty = new Set<string>();
  let flush: ReturnType<typeof setTimeout> | undefined;

  const rewatch = () => {
    const dir = feed.runsDir;
    if (dir === watching) return;
    watcher?.close();
    watcher = null;
    watching = dir;
    if (!dir) return;
    try {
      watcher = fsWatch(dir, (_event, name) => {
        if (stopped || !name || !String(name).endsWith(SUFFIX)) return;
        dirty.add(String(name).slice(0, -SUFFIX.length));
        flush ??= setTimeout(() => {
          flush = undefined;
          const runIds = [...dirty];
          dirty.clear();
          void feed.touched(runIds);
        }, COALESCE_MS);
      });
      watcher.on("error", (error) => {
        log(`cards: watching ${dir} failed (${String(error)}); the ${RESCAN_MS / 1000}s rescan still runs`);
        watcher?.close();
        watcher = null;
      });
    } catch (error) {
      // The directory may not exist yet: the rescan picks it up.
      watching = null;
      log(`cards: cannot watch ${dir} (${String(error)}); trying again on the next rescan`);
    }
  };

  const scan = () => void feed.scan().then(() => !stopped && rewatch());
  scan();
  const recheck = setInterval(() => void feed.recheck(), RECHECK_MS);
  const rescan = setInterval(scan, RESCAN_MS);
  return () => {
    stopped = true;
    clearInterval(recheck);
    clearInterval(rescan);
    clearTimeout(flush);
    watcher?.close();
  };
}
