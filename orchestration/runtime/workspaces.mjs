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

import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** How long to wait for another run's look-and-make before giving up on the shared workspace. */
export const LOCK_WAIT_MS = 30_000;
/** A lock older than this was left by a process that died holding it. Longer than the two CLI calls it covers can take. */
export const LOCK_STALE_MS = 180_000;
const LOCK_POLL_MS = 200;
/** The longest title Paseo is sent, in characters (code points). */
export const TITLE_LIMIT = 120;

/** `<logDir>/workspaces` */
export const workspacesDir = (dir) => path.join(dir, "workspaces");

/**
 * What the lock file's contents are written through. A seam for tests (a write
 * that fails after the file exists); nothing else touches it.
 */
export const lockIo = { write: (fd, text) => writeSync(fd, text) };

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

/**
 * A directory as the file system would compare it: absolute, and on Windows
 * without regard to case or the kind of slash. The one spelling that a run's
 * cache of resolved workspaces and the registry's file name are both made
 * from; what is shown and what is given to a command stays the directory as it
 * was written.
 */
export function normalizeDir(dir) {
  const resolved = path.resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export const samePath = (a, b) => normalizeDir(a) === normalizeDir(b);

/** `text` cut to `limit` characters (code points), never in the middle of a surrogate pair. */
export const cutTitle = (text, limit = TITLE_LIMIT) => {
  const chars = [...text];
  return chars.length > limit ? chars.slice(0, limit).join("") : text;
};

/**
 * The workspace's title, as it is sent and as it is recorded: the affair's
 * label, and for a directory other than the run's own the directory's name
 * after it, so that two workspaces of one affair can be told apart. When the
 * whole is too long it is the label that gives way, not the name.
 */
export function workspaceTitle(label, cwd, runCwd) {
  if (samePath(cwd, runCwd)) return cutTitle(label);
  const suffix = ` · ${path.basename(path.resolve(cwd))}`;
  const room = TITLE_LIMIT - [...suffix].length;
  return room > 0 ? `${cutTitle(label, room)}${suffix}` : cutTitle(suffix.trimStart());
}

/**
 * The `error.code` of the JSON error object the CLI prints, or null. The object is pretty-printed over
 * several lines and the CLI may print other lines around it ("Using workspace <id>" before, a deprecation
 * warning before that, as measured), so it is looked for: from each line that starts with `{`, the longest run
 * of lines that parses.
 */
function jsonErrorCode(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines.length > 100) return null;
  for (let start = 0; start < lines.length; start += 1) {
    if (!lines[start].startsWith("{")) continue;
    for (let end = lines.length; end > start; end -= 1) {
      try {
        const code = JSON.parse(lines.slice(start, end).join("\n"))?.error?.code;
        return typeof code === "string" ? code : null;
      } catch {
        // Not that stretch; a shorter one, or a later line, may be the object.
      }
    }
  }
  return null;
}

/**
 * Whether an error from starting an agent is Paseo refusing the workspace
 * before it made the agent, and which way:
 *   "gone"  the workspace is not there (`WORKSPACE_NOT_FOUND`: archived, or never was)
 *   "flag"  this CLI does not know `--workspace` (an older one)
 * or null for anything else, which is not ours to retry: an agent that began
 * and then failed has spent something, and doing it again would spend it twice.
 *
 * Both were measured (docs/affair-workspace.md, test/fixtures/paseo-refusals.json): exit code 1, no agent made.
 * The first is the JSON error on stderr behind a "Using workspace" line, the second the argument
 * parser's own line. Only the error's `code` counts, never words that appear in it: a failure whose message
 * or whose agent's title mentions WORKSPACE_NOT_FOUND is not this. The `m` flag lets the parser's line
 * be preceded by others (a deprecation warning); it still has to start a line.
 */
export function workspaceRefusal(error) {
  if (error?.name !== "PaseoCliError" || typeof error.exitCode !== "number" || error.exitCode === 0) return null;
  const raw = `${error.stderr ?? ""}`.trim() || `${error.stdout ?? ""}`.trim();
  if (jsonErrorCode(raw) === "WORKSPACE_NOT_FOUND") return "gone";
  return /^error: unknown option '--workspace'/m.test(raw) ? "flag" : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LockTimeout extends Error {
  constructor(file, waitedMs) {
    super(`another run has held ${file} for ${Math.round(waitedMs / 1000)}s`);
    this.name = "LockTimeout";
  }
}

/**
 * Remove the lock file if it is ours. Every holder writes a token into its lock;
 * only the one whose token is in the file removes it, so a holder whose lock
 * was taken over as stale does not remove the new holder's. (Read and remove are
 * two steps, so this narrows the race, it does not close it: docs/affair-workspace.md.)
 * `token` null: the file was just made here and its contents never written, so it is ours without asking.
 */
function release(file, token) {
  try {
    if (token !== null && JSON.parse(readFileSync(file, "utf8")).token !== token) return;
    unlinkSync(file);
  } catch {
    // Gone already, or taken over and rewritten: not ours to remove.
  }
}

/** Run `fn` holding the lock file (`wx`: of any number of processes, one creates it). */
export async function withLock(file, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, pollMs = LOCK_POLL_MS } = {}, fn) {
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
    // From here the file is ours, whatever happens to writing into it.
    const token = randomUUID();
    try {
      try {
        lockIo.write(fd, JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      // Writing or closing failed with the file already made: take it away, or the next runs wait for it.
      release(file, null);
      throw error;
    }
    try {
      return await fn();
    } finally {
      release(file, token);
    }
  }
}

/** The registry entry, or null when there is none, or `{ unreadable }` when there is a file that is not one. */
function readEntry(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const entry = JSON.parse(text);
    if (typeof entry?.workspaceId === "string") return entry;
    return { unreadable: "it has no workspaceId" };
  } catch (error) {
    // Half-written by a crash, or edited: treated as absent below, and said.
    return { unreadable: error.message };
  }
}

/**
 * The workspace for (key, cwd): the one the registry names if the daemon still
 * has it, otherwise a new one, recorded. Throws when the daemon cannot be
 * asked, the workspace cannot be made, or the lock stays taken.
 *
 * `title` is what is sent to Paseo, the event and the registry, all the same text.
 *
 * @param {{ dir: string, key: string, cwd: string, title: string, runId: string,
 *           executor: { listWorkspaces: () => Promise<Array<{ workspaceId: string }>>,
 *                       createWorkspace: (request: { cwd: string, title: string }) => Promise<{ workspaceId: string }> },
 *           lock?: { waitMs?: number, staleMs?: number, pollMs?: number } }} options
 * @returns {Promise<{ workspaceId: string, created: boolean, unrecorded?: string, unreadable?: string }>}
 *   `unrecorded`: made, but the registry could not be written (why).
 *   `unreadable`: the registry file was there and could not be read (why), so a workspace made before may not have been found.
 */
export async function ensureWorkspace({ dir, key, cwd, title, runId, executor, lock = {} }) {
  const name = createHash("sha256").update(`${key}\0${normalizeDir(cwd)}`).digest("hex").slice(0, 32);
  const file = path.join(workspacesDir(dir), `${name}.json`);
  const lockOptions = { waitMs: lock.waitMs ?? LOCK_WAIT_MS, staleMs: lock.staleMs ?? LOCK_STALE_MS, pollMs: lock.pollMs ?? LOCK_POLL_MS };

  return withLock(`${file}.lock`, lockOptions, async () => {
    const entry = readEntry(file);
    // The id alone: the daemon may spell the directory its own way, and the
    // registry's name already says which directory this is for.
    if (entry?.workspaceId && (await executor.listWorkspaces()).some((row) => row.workspaceId === entry.workspaceId)) {
      return { workspaceId: entry.workspaceId, created: false };
    }
    const unreadable = entry?.unreadable;
    const made = await executor.createWorkspace({ cwd, title });
    const record = { key, cwd, title, workspaceId: made.workspaceId, createdAt: new Date().toISOString(), runId };
    // Written beside and renamed over: a reader sees the old entry or the new one, never half of one.
    const next = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(next, JSON.stringify(record, null, 2), "utf8");
      renameSync(next, file);
    } catch (error) {
      // The workspace exists; this run uses it. Only the next run will not find it, which the caller says.
      return { workspaceId: made.workspaceId, created: true, unrecorded: error.message, ...(unreadable ? { unreadable } : {}) };
    }
    return { workspaceId: made.workspaceId, created: true, ...(unreadable ? { unreadable } : {}) };
  });
}
