// The right to write a line of runs: `<logDir>/lines/<lineage>.lock`.
//
// A line is a run and the runs that carry it on; they share one journal (journal.mjs) and the journal is read once, when a run starts.
// Two runs of a line working at once would each read the same "nothing done yet", and a step that cannot be taken back would be done by
// both. `orch.mjs resume` already takes a stop only once, but that is one way in; `runFlow` can be called by anything with a lineage,
// and so can `orch.mjs settle`. So the line itself is held, by whoever writes to it, from before it reads the journal until nothing it
// started can write any more -- for a run that has ended, until the last step that cannot be taken back has returned.
//
// The file says who holds it ({ pid, hostname, runId, startedAt }) and is made with an exclusive create, which the file system makes
// atomic. As with a run's claim (claim.mjs), the pid is evidence of death only: a holder on this machine whose pid is gone is dead, and
// its lock may be taken over; a holder whose pid is there, or that is on another machine, is taken to be working, however long ago it
// began. That is the safe side for a step that cannot be taken back -- a person removes a lock they know to be left over. A lock that
// cannot be read is one being written, until it is some seconds old: then it was left by a process that died between making the file and
// writing into it, and holds nothing.

import { closeSync, mkdirSync, openSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pidFact } from "./liveness.mjs";

/** `<logDir>/lines/<lineage>.lock` */
export const lineLockFile = (dir, lineage) => path.join(dir, "lines", `${lineage}.lock`);

/** A takeover that has been going this long is left over from a process that died in the middle of it. */
const TAKEOVER_STALE_MS = 10_000;

/** A lock that cannot be read (empty, torn) and has not been touched for this long was left by a process that died while making it. */
const UNREADABLE_STALE_MS = 5_000;

/**
 * What the file system says while another process is making or removing the lock: on Windows a file that is being deleted, and is still open
 * in a reader, can be neither opened nor read for a moment (EPERM, or EBUSY). The line is taken to be held, after a short wait and a second look.
 */
const HELD_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const PAUSE_MS = 25;

/** The file system calls that are made on the lock, for a test to make fail. */
export const lineIo = {
  open: (file) => openSync(file, "wx"),
  write: (fd, text) => writeFileSync(fd, text),
  pause: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
};

/** The line is held by another. `holder` is what the lock says, or null when it could not be read; `blocked` is the error that kept it from being looked at. */
export class LineBusy extends Error {
  constructor(lineage, file, holder, blocked = null) {
    const who = holder
      ? `run ${holder.runId} (pid ${holder.pid} on ${holder.hostname}, since ${holder.startedAt})`
      : `someone whose lock cannot be read (it may be being written${blocked ? `; ${blocked.code}` : ""})`;
    super(
      `the line of runs "${lineage}" is being worked on by ${who}: one run of a line writes at a time, because they share what was done. ` +
        `Try again when it has ended; if its process is gone and this stays, remove ${file}`,
    );
    this.name = "LineBusy";
    this.lineage = lineage;
    this.holder = holder;
  }
}

const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const parse = (text) => {
  try {
    const body = JSON.parse(text);
    return body !== null && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
};

/**
 * Take the line, or throw LineBusy. `release()` gives it back (idempotent, and never takes away a lock that has since become someone
 * else's). `probe` is for tests: { hostname, kill }.
 *
 * @param {{ dir: string, lineage: string, runId: string, probe?: { hostname: string, kill: (pid: number, signal: 0) => unknown } }} options
 */
export function takeLine({ dir, lineage, runId, probe = { hostname: os.hostname(), kill: process.kill } }) {
  const file = lineLockFile(dir, lineage);
  const info = JSON.stringify({ pid: process.pid, hostname: os.hostname(), runId, lineage, startedAt: new Date().toISOString() });
  const mine = () => read(file) === info;
  const release = () => {
    try {
      if (mine()) unlinkSync(file);
    } catch {
      // Already gone, or not ours any more.
    }
    try {
      // The directory is not left behind empty; one that another lock is in is not removed.
      rmdirSync(path.dirname(file));
    } catch {
      // Not empty, or gone.
    }
  };
  let blocked = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd;
    try {
      // Made each time: a release may have taken the empty directory away since the last look.
      mkdirSync(path.dirname(file), { recursive: true });
      fd = lineIo.open(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (HELD_CODES.has(error.code)) {
        blocked = error;
        lineIo.pause(PAUSE_MS);
        continue;
      }
      if (error.code !== "EEXIST") throw error;
      let text;
      try {
        text = read(file);
      } catch (readError) {
        if (!HELD_CODES.has(readError.code)) throw readError;
        blocked = readError;
        lineIo.pause(PAUSE_MS);
        continue;
      }
      if (text === null) continue; // Released between the two looks.
      const holder = parse(text);
      // Only a holder that is known to be gone gives the line up. A lock that cannot be read is one being written -- unless it has been
      // left that way, by a process that died between making the file and writing into it.
      if (holder === null ? !leftUnreadable(file) : pidFact(holder, probe) !== "gone") throw new LineBusy(lineage, file, holder);
      takeOver(file, text);
      continue;
    }
    try {
      try {
        lineIo.write(fd, info);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      // Made and not written: left alone it would look like a lock being written, for good.
      try {
        unlinkSync(file);
      } catch {
        // Gone already.
      }
      throw error;
    }
    return { file, runId, release };
  }
  let holder = null;
  try {
    holder = parse(read(file) ?? "");
  } catch {
    // Still cannot be read: said by `blocked`.
  }
  throw new LineBusy(lineage, file, holder, blocked);
}

const leftUnreadable = (file) => {
  try {
    return Date.now() - statSync(file).mtimeMs > UNREADABLE_STALE_MS;
  } catch {
    return false; // Gone, or not to be looked at: the next look finds out.
  }
};

// Remove a lock whose holder is gone. Two processes may find the same dead lock together, and the one that removes it second must not
// remove the live lock the first one made in its place: so one at a time (an exclusive `.takeover`), and the lock is removed only if it
// still says what it said when it was judged dead.
function takeOver(file, dead) {
  const guard = `${file}.takeover`;
  let fd;
  try {
    fd = openSync(guard, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(guard).mtimeMs > TAKEOVER_STALE_MS) unlinkSync(guard);
    } catch {
      // Gone already.
    }
    return; // The caller looks at the lock again.
  }
  closeSync(fd);
  try {
    if (read(file) === dead) unlinkSync(file);
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // Gone already.
    }
  }
}
