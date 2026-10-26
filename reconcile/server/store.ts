import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { apply, emptyState, type EventBody, type JournalEvent, type State } from "./state";

// The journal: append-only JSONL, one file per month, plus an atomic snapshot of the folded
// state. One process writes. Events of one batch are fsynced before append() returns, so a
// caller that records an intent and then acts has the intent on disk first. A half-written
// last line (a crash mid-write) is skipped on replay, and closed off with a newline on open so
// the next batch does not weld onto it. A closed store refuses to write.
//
// The LOCK names the process holding the directory, and its holder touches it every tick. A
// LOCK is held while its process is alive and it was touched within staleLockMs: a pid alone
// can be reused by another process after a crash.

const SNAPSHOT_EVERY = 200;
const STALE_LOCK_MS = 10 * 60_000;

export interface StoreOptions {
  dir: string;
  now?: () => number;
  /** Whether a pid is still running; replaced in tests. */
  alive?: (pid: number) => boolean;
  /** A LOCK not touched for this long is stale, whatever its pid. */
  staleLockMs?: number;
}

export interface Store {
  readonly state: State;
  readonly dir: string;
  append(events: EventBody[]): JournalEvent[];
  snapshot(): void;
  /** Tells other processes this one still holds the directory. */
  touch(): void;
  close(): void;
  /** Lets go as a killed process would: no snapshot, the LOCK left behind. Tests stand a crash with it. */
  abandon(): void;
  readonly closed: boolean;
  /** Lines skipped on load because they did not parse. */
  readonly skipped: number;
  /** Why the snapshot was not used on load, if it was not. */
  readonly snapshotIgnored: string | null;
  /**
   * A store that rehearses (memoryStore): what it appended, kept in memory, and how far the journal
   * in `dir` it was read from goes (`upTo`, a seq). The page reads that journal up to there, then these.
   */
  readonly memory?: { upTo: number; events: readonly JournalEvent[] };
}

export class LockedError extends Error {}
export class StoreClosedError extends Error {}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const JOURNAL_FILE = /^\d{4}-\d{2}\.jsonl$/;

/**
 * The state a data directory holds, read without taking it: its snapshot and journal folded, as
 * the store opens them. Nothing is written, no LOCK is looked at, so it reads the directory of a
 * running controller too (a line it is writing just then is skipped like a torn one).
 */
export function readState(dir: string): { state: State; skipped: number; snapshotIgnored: string | null } {
  const state = emptyState();
  let skipped = 0;
  let snapshotIgnored: string | null = null;
  const snapshotPath = path.join(dir, "snapshot.json");
  if (existsSync(snapshotPath)) {
    try {
      Object.assign(state, JSON.parse(readFileSync(snapshotPath, "utf8")) as State);
    } catch (error) {
      // A torn snapshot (power lost after the rename) is not needed: the journal has everything.
      snapshotIgnored = (error as Error).message;
      Object.assign(state, emptyState());
    }
  }
  const journalDir = path.join(dir, "journal");
  const files = existsSync(journalDir) ? readdirSync(journalDir).filter((f) => JOURNAL_FILE.test(f)).sort() : [];
  for (const file of files) {
    const text = readFileSync(path.join(journalDir, file), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let event: JournalEvent;
      try {
        event = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      if (event.seq > state.seq) apply(state, event);
    }
  }
  return { state, skipped, snapshotIgnored };
}

/** Every event in a data directory's journal, in order; a line that does not parse is left out, as the store does. */
export function readEvents(dir: string): JournalEvent[] {
  const journalDir = path.join(dir, "journal");
  const files = existsSync(journalDir) ? readdirSync(journalDir).filter((f) => JOURNAL_FILE.test(f)).sort() : [];
  const events: JournalEvent[] = [];
  for (const file of files) {
    for (const line of readFileSync(path.join(journalDir, file), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as JournalEvent);
      } catch {
        // A torn line.
      }
    }
  }
  return events;
}

/**
 * A store that keeps its journal in memory, over a copy of a state: for an engine that only
 * rehearses (the preview's), whose events go nowhere but `events`. `journal`: the data directory
 * the state was read from, whose journal the page reads (only reads) for the history before.
 */
export function memoryStore(from: State, now: () => number, journal?: string): Store & { readonly events: JournalEvent[] } {
  const state = structuredClone(from);
  const events: JournalEvent[] = [];
  let closed = false;
  return {
    state,
    dir: journal ?? "(memory)",
    memory: { upTo: from.seq, events },
    events,
    skipped: 0,
    snapshotIgnored: null,
    get closed() {
      return closed;
    },
    append(bodies) {
      if (closed) throw new StoreClosedError("the memory journal is closed");
      const at = new Date(now()).toISOString();
      const added = bodies.map((body, i) => ({ v: 1, seq: state.seq + 1 + i, at, ...body }) as JournalEvent);
      for (const event of added) {
        apply(state, event);
        events.push(event);
      }
      return added;
    },
    snapshot() {},
    touch() {},
    abandon() {
      closed = true;
    },
    close() {
      closed = true;
    },
  };
}

/** Data directories open in this process: a second store on one would write the same journal. */
const openHere = new Set<string>();

export function openStore(options: StoreOptions): Store {
  const { dir } = options;
  const here = path.resolve(dir).toLowerCase();
  if (openHere.has(here)) throw new LockedError(`${dir} is already open in this process`);
  const now = options.now ?? Date.now;
  const alive = options.alive ?? isAlive;
  const staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
  const journalDir = path.join(dir, "journal");
  mkdirSync(journalDir, { recursive: true });

  const lockPath = path.join(dir, "LOCK");
  if (existsSync(lockPath)) {
    let holder: { pid?: number } = {};
    try {
      holder = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      // An unreadable lock is a stale lock.
    }
    const touched = (() => {
      try {
        return statSync(lockPath).mtimeMs;
      } catch {
        return 0;
      }
    })();
    if (typeof holder.pid === "number" && holder.pid !== process.pid && alive(holder.pid) && now() - touched < staleLockMs) {
      throw new LockedError(`${dir} is held by process ${holder.pid}`);
    }
    rmSync(lockPath, { force: true });
  }
  // Created only if absent: of two processes starting at once, one gets it.
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new LockedError(`${dir} was taken by another process just now`);
    throw error;
  }
  try {
    writeSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString() }));
  } finally {
    closeSync(lockFd);
  }
  const touch = () => {
    const t = new Date(now());
    try {
      utimesSync(lockPath, t, t);
    } catch {
      // Gone: close() or someone else removed it; nothing to tell.
    }
  };
  touch();

  const { state, skipped, snapshotIgnored } = readState(dir);
  const snapshotPath = path.join(dir, "snapshot.json");
  const files = readdirSync(journalDir).filter((f) => JOURNAL_FILE.test(f)).sort();
  const last = files[files.length - 1];
  if (last) {
    const text = readFileSync(path.join(journalDir, last), "utf8");
    if (text !== "" && !text.endsWith("\n")) writeFileSync(path.join(journalDir, last), "\n", { flag: "a" });
  }

  let sinceSnapshot = 0;
  let closed = false;
  const store: Store = {
    state,
    dir,
    get skipped() {
      return skipped;
    },
    get snapshotIgnored() {
      return snapshotIgnored;
    },
    get closed() {
      return closed;
    },
    append(bodies) {
      if (closed) throw new StoreClosedError(`the journal in ${dir} is closed`);
      if (bodies.length === 0) return [];
      const at = new Date(now()).toISOString();
      const events = bodies.map((body, i) => ({ v: 1, seq: state.seq + 1 + i, at, ...body }) as JournalEvent);
      const file = path.join(journalDir, `${at.slice(0, 7)}.jsonl`);
      const fd = openSync(file, "a");
      try {
        writeSync(fd, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      for (const event of events) apply(state, event);
      sinceSnapshot += events.length;
      if (sinceSnapshot >= SNAPSHOT_EVERY) store.snapshot();
      return events;
    },
    snapshot() {
      if (closed) throw new StoreClosedError(`the journal in ${dir} is closed`);
      const tmp = `${snapshotPath}.tmp`;
      const fd = openSync(tmp, "w");
      try {
        writeSync(fd, JSON.stringify(state));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, snapshotPath);
      sinceSnapshot = 0;
    },
    touch() {
      if (!closed) touch();
    },
    abandon() {
      closed = true;
      openHere.delete(here);
    },
    close() {
      if (closed) return;
      try {
        store.snapshot();
      } finally {
        closed = true;
        openHere.delete(here);
        try {
          const holder = JSON.parse(readFileSync(lockPath, "utf8"));
          if (holder.pid === process.pid) rmSync(lockPath);
        } catch {
          // Already gone.
        }
      }
    },
  };
  openHere.add(here);
  return store;
}
