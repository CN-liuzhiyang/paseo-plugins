// The Paseo workspace an affair's agents and gate cards go in.
//
// Without this, every `$.ask` and every gate card opens a workspace of its own
// (an untitled one per directory), and a person looking for what one affair is
// doing has to open them all. With an affair, the runs for it share one
// workspace per directory, titled with the affair's label. The design, the
// measurements it rests on and what is open: docs/affair-workspace.md.
//
// A workspace is found again by a registry file, not by its title: titles are
// not unique and a person may rename one. `<logDir>/workspaces/<hash>.json`
// says, for one (affair key, directory), which workspace id the first run
// made; before it is used the daemon is asked whether that id still exists
// (an archived workspace is gone from the list, and a new one is made).
// `paseo workspace create` does not look for an existing one -- run twice it
// makes two -- so the look-and-make is done under a lock file, which is what
// keeps two runs of one affair, even in two processes, from making two.
//
// Nothing here may fail a run. ensureWorkspace throws; the runner turns that
// into a caveat and carries on as it did before this existed.

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** How long to wait for another run's look-and-make before giving up on the shared workspace. */
export const LOCK_WAIT_MS = 30_000;
/** A lock older than this was left by a process that died holding it. Longer than the two CLI calls it covers can take. */
export const LOCK_STALE_MS = 180_000;
const LOCK_POLL_MS = 200;

/** `<logDir>/workspaces` */
export const workspacesDir = (dir) => path.join(dir, "workspaces");

/**
 * What identifies an affair, for sharing a workspace: the caller's `key` when
 * it gave one, otherwise the item's link (plugin, screen and every param),
 * otherwise its url. Null when it has none of them: a label alone is not an
 * identity, two different items can read the same.
 *
 * @param {{ key?: string, link?: { plugin: string, screen: string, params?: Record<string, string> }, url?: string } | null} affair
 * @returns {string | null}
 */
export function affairKey(affair) {
  if (!affair) return null;
  if (typeof affair.key === "string") return `key:${affair.key}`;
  if (affair.link) {
    const params = Object.entries(affair.link.params ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `link:${JSON.stringify([affair.link.plugin, affair.link.screen, params])}`;
  }
  if (typeof affair.url === "string") return `url:${affair.url}`;
  return null;
}

/** Directories compared as the file system would: Windows ignores case and the kind of slash. */
export function samePath(a, b) {
  const norm = (p) => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/**
 * The workspace's title: the affair's label, and for a directory other than
 * the run's own, the directory's name after it, so that two workspaces of one
 * affair can be told apart.
 */
export function workspaceTitle(label, cwd, runCwd) {
  return samePath(cwd, runCwd) ? label : `${label} · ${path.basename(path.resolve(cwd))}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LockTimeout extends Error {
  constructor(file, waitedMs) {
    super(`another run has held ${file} for ${Math.round(waitedMs / 1000)}s`);
    this.name = "LockTimeout";
  }
}

/** Run `fn` holding the lock file (`wx`: of any number of processes, one creates it). */
async function withLock(file, { waitMs, staleMs, pollMs }, fn) {
  mkdirSync(path.dirname(file), { recursive: true });
  const startedAt = Date.now();
  for (;;) {
    let fd;
    try {
      fd = openSync(file, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Left by a process that died inside the look-and-make. Racy if two
      // waiters take it at once; a stale lock is rare, and the cost of the race
      // is the second workspace this exists to prevent, not a failed run.
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) unlinkSync(file);
      } catch {
        // Gone already, or not ours to remove: the next turn of the loop finds out.
      }
      const waited = Date.now() - startedAt;
      if (waited >= waitMs) throw new LockTimeout(file, waited);
      await sleep(pollMs);
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(file);
      } catch {
        // Removed under us (a clean-up): nothing left to release.
      }
    }
  }
}

function readEntry(file) {
  try {
    const entry = JSON.parse(readFileSync(file, "utf8"));
    return typeof entry?.workspaceId === "string" ? entry : null;
  } catch {
    // Absent, or half-written by a crash: as good as absent, and rewritten below.
    return null;
  }
}

/**
 * The workspace for (key, cwd): the one the registry names if the daemon still
 * has it, otherwise a new one, recorded. Throws when the daemon cannot be
 * asked, the workspace cannot be made, or the lock stays taken.
 *
 * @param {{ dir: string, key: string, cwd: string, title: string, runId: string,
 *           executor: { listWorkspaces: () => Promise<Array<{ workspaceId: string }>>,
 *                       createWorkspace: (request: { cwd: string, title: string }) => Promise<{ workspaceId: string }> },
 *           lock?: { waitMs?: number, staleMs?: number, pollMs?: number } }} options
 * @returns {Promise<{ workspaceId: string, created: boolean, unrecorded?: string }>} `unrecorded`: made, but the registry could not be written (why)
 */
export async function ensureWorkspace({ dir, key, cwd, title, runId, executor, lock = {} }) {
  const normalized = process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
  const name = createHash("sha256").update(`${key}\0${normalized}`).digest("hex").slice(0, 32);
  const file = path.join(workspacesDir(dir), `${name}.json`);
  const lockOptions = { waitMs: lock.waitMs ?? LOCK_WAIT_MS, staleMs: lock.staleMs ?? LOCK_STALE_MS, pollMs: lock.pollMs ?? LOCK_POLL_MS };

  return withLock(`${file}.lock`, lockOptions, async () => {
    const entry = readEntry(file);
    // The id alone: the daemon may spell the directory its own way, and the
    // registry's name already says which directory this is for.
    if (entry && (await executor.listWorkspaces()).some((row) => row.workspaceId === entry.workspaceId)) {
      return { workspaceId: entry.workspaceId, created: false };
    }
    const made = await executor.createWorkspace({ cwd, title });
    const record = { key, cwd, title, workspaceId: made.workspaceId, createdAt: new Date().toISOString(), runId };
    // Written beside and renamed over: a reader sees the old entry or the new one, never half of one.
    const next = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(next, JSON.stringify(record, null, 2), "utf8");
      renameSync(next, file);
    } catch (error) {
      // The workspace exists; this run uses it. Only the next run will not find it, which the caller says.
      return { workspaceId: made.workspaceId, created: true, unrecorded: error.message };
    }
    return { workspaceId: made.workspaceId, created: true };
  });
}
