import type { Revision } from "../../shared/model";
import type { Exec } from "../exec";

// Reads a commit a tracker links to an item: which configured branch it was committed on, which
// identifiers it brought in, and which branches have it by now. Read-only (`svn log`, `svn diff`).
// A repository's root may be closed to the reader while its branches are open, so each branch is
// asked in turn. What a revision is never changes and is remembered for the life of the process;
// where it is does: a branch made by copying directories from another (instead of merging) gets
// it only when the next copy happens, so such a branch is asked again after `recheckMinutes`.

export interface SvnConfig {
  command: string[];
  timeoutSeconds: number;
  /** At most this many of an item's newest revisions are read. */
  maxRevisions: number;
  recheckMinutes?: number;
  /** At most this many svn calls in one poll of the source; past it a read fails and is tried next time. */
  maxCallsPerPoll?: number;
  repos: Array<{
    name: string;
    /** Matches the tracker's id for a revision; group 1 is the revision number. */
    pattern: string;
    /** `copied`: directories (relative to url) the branch gets by copying them from another branch. */
    branches: Array<{ name: string; url: string; copied?: string[] }>;
  }>;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
/** Names someone would give a switch or a key, not every word in a diff. */
const NAMEY = /^(?=.{4,80}$)(?:.*[_0-9].*|.*[a-z][A-Z].*)$/;
const MAX_TOKENS = 300;
const MAX_LINE = 160;
/** How many copies back to look for the one that brought a commit. */
const MAX_COPIES = 20;
/** A diff kept up to this much: the names a huge commit adds after it are not looked at. */
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
/** svn saying the branch was not there at that revision, rather than that it could not answer. */
const NOT_THERE = /E160013|E195012|E160006|E200009/;

export class SvnBudgetError extends Error {}

/** Identifiers on added lines that no removed line has, each with the first added line it is on. */
export function netAdded(diff: string): Array<[string, string]> {
  const added = new Map<string, string>();
  const removed = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const sign = line[0];
    if (sign !== "+" && sign !== "-") continue;
    for (const token of line.slice(1).match(IDENT) ?? []) {
      if (!NAMEY.test(token)) continue;
      if (sign === "-") removed.add(token);
      else if (!added.has(token)) added.set(token, line.slice(1).trim().slice(0, MAX_LINE));
    }
  }
  const out: Array<[string, string]> = [];
  for (const [token, line] of added) {
    if (removed.has(token)) continue;
    out.push([token, line]);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

interface LogEntry {
  revision: number;
  author: string;
  at: string;
  summary: string;
  paths: Array<{ path: string; copyFromRev: number | null; copyFromPath: string | null }>;
}

function logEntry(xml: string): LogEntry | null {
  const entry = /<logentry[\s\S]*?<\/logentry>/.exec(xml)?.[0];
  if (!entry) return null;
  const pick = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1] ?? "";
  const paths = [...entry.matchAll(/<path\b([^>]*)>([^<]+)<\/path>/g)].map((m) => {
    const from = /copyfrom-rev="(\d+)"/.exec(m[1]!)?.[1];
    const fromPath = /copyfrom-path="([^"]+)"/.exec(m[1]!)?.[1];
    return { path: unescape(m[2]!), copyFromRev: from ? Number(from) : null, copyFromPath: fromPath ? unescape(fromPath) : null };
  });
  return {
    revision: Number(/revision="(\d+)"/.exec(entry)?.[1] ?? 0),
    author: unescape(pick("author")),
    at: pick("date"),
    summary: unescape(pick("msg")).split(/\r?\n/)[0]!.slice(0, 200),
    paths,
  };
}

/** A changed path (repository-relative) under a branch's URL, relative to the branch; null when not under it. */
export function underBranch(url: string, path: string): string | null {
  const base = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, "");
  const segments = path.split("/");
  for (let k = segments.length; k > 1; k--) {
    const prefix = segments.slice(0, k).join("/");
    if (base.endsWith(prefix)) return segments.slice(k).join("/");
  }
  return null;
}

interface Known {
  revision: Revision;
  /** Paths relative to the branch it was committed on. */
  relative: string[];
  /** Branch name -> when it was last asked and did not have it. */
  missing: Map<string, number>;
}

export function createSvnReader(config: SvnConfig, exec: Exec, now: () => number = Date.now) {
  const cache = new Map<string, Known>();
  const copies = new Map<string, { at: number; entry: LogEntry | null }>();
  const timeoutMs = config.timeoutSeconds * 1000;
  const recheckMs = (config.recheckMinutes ?? 60) * 60_000;
  let callsThisPoll = 0;
  const svn = (args: string[], maxBytes?: number) => {
    if (config.maxCallsPerPoll !== undefined && ++callsThisPoll > config.maxCallsPerPoll) throw new SvnBudgetError(`more than ${config.maxCallsPerPoll} svn calls in one poll`);
    return exec(config.command, [...args, "--non-interactive"], { timeoutMs, ...(maxBytes ? { maxBytes } : {}) });
  };
  const repos = config.repos.map((r) => ({ ...r, regex: new RegExp(r.pattern) }));
  const join = (url: string, sub: string) => `${url.replace(/\/+$/, "")}/${sub.replace(/^\/+/, "")}`;

  async function log(args: string[], what: string): Promise<{ ok: true; entry: LogEntry | null } | { ok: false; error: string }> {
    const r = await svn(["log", "--xml", "-v", ...args]);
    if (r.timedOut) throw new Error(`svn log ${what} timed out`);
    if (r.code !== 0) return { ok: false, error: (r.stderr || `exit ${r.code}`).trim().slice(0, 200) };
    return { ok: true, entry: logEntry(r.stdout) };
  }

  /**
   * The copy the directory's history starts with: now (remembered for recheckMs), or as it was at
   * a past revision (which never changes).
   */
  async function copyOf(url: string, peg: number | null = null): Promise<LogEntry | null> {
    const key = `${url}@${peg ?? "HEAD"}`;
    const hit = copies.get(key);
    if (hit && (peg !== null || now() - hit.at < recheckMs)) return hit.entry;
    const r = await log(["--stop-on-copy", "-r", `1:${peg ?? "HEAD"}`, "-l", "1", peg === null ? url : `${url}@${peg}`], url);
    const entry = r.ok ? r.entry : null;
    copies.set(key, { at: now(), entry });
    return entry;
  }

  /** Whether a copied branch has it now, and since when; and the latest copy into it from its own branch. */
  async function lookIn(known: Known, number: number, branch: { name: string; url: string; copied?: string[] }, own: string): Promise<void> {
    const dir = (branch.copied ?? []).find((d) => known.relative.some((p) => p === d || p.startsWith(`${d}/`)));
    if (!dir) return;
    const url = join(branch.url, dir);
    const r = await log(["-c", String(number), url], url);
    const direct = r.ok && r.entry !== null && r.entry.paths.some((p) => underBranch(branch.url, p.path) !== null);
    const copy = r.ok && !direct ? await copyOf(url) : null;
    const source = copy?.paths.find((p) => p.copyFromRev !== null && p.copyFromPath !== null && underBranch(own, p.copyFromPath) !== null);
    if (copy && source) (known.revision.copied ??= {})[branch.name] = { rev: copy.revision, at: copy.at, from: source.copyFromRev!, seen: new Date(now()).toISOString() };
    if (!r.ok || !r.entry) {
      known.missing.set(branch.name, now());
      return;
    }
    // The copy that brought it: back through the copies while the branch had it just before one.
    let brought: LogEntry | null = null;
    for (let at = copy, step = 0; at && step < MAX_COPIES; step++) {
      if (!at.paths.some((p) => p.copyFromRev !== null && p.copyFromRev >= number)) break;
      const before = await log(["-c", String(number), `${url}@${at.revision - 1}`], url);
      if (!before.ok || !before.entry) {
        brought = at;
        break;
      }
      at = await copyOf(url, at.revision - 1);
    }
    // Not found that way (committed there, or too many copies back): about its own time.
    known.revision.in![branch.name] = brought ? { rev: brought.revision, at: brought.at } : { rev: number, at: r.entry.at };
    known.missing.delete(branch.name);
  }

  return {
    /** Starts counting svn calls against maxCallsPerPoll. */
    beginPoll(): void {
      callsThisPoll = 0;
    },
    /** Null when no configured repository names this id. Throws when svn itself fails. */
    async read(id: string, given: { at: string; author: string; summary: string }): Promise<Revision | null> {
      const repo = repos.find((r) => r.regex.test(id));
      if (!repo) return null;
      const number = Number(repo.regex.exec(id)![1]!);
      let known = cache.get(id);
      if (!known) {
        const failures: string[] = [];
        for (const branch of repo.branches) {
          const r = await log(["-c", String(number), branch.url], id);
          if (!r.ok) {
            // A branch that did not exist at that revision says so; try the next. Anything else
            // (the network, the server) leaves where it is unknown.
            if (!NOT_THERE.test(r.error)) failures.push(r.error);
            continue;
          }
          if (!r.entry) continue;
          const diff = await svn(["diff", "-c", String(number), branch.url], MAX_DIFF_BYTES);
          if (diff.timedOut || (diff.code !== 0 && !diff.truncated)) throw new Error(`svn diff ${id}: ${(diff.stderr || `exit ${diff.code}`).trim().slice(0, 200)}`);
          const at = r.entry.at || given.at;
          known = {
            revision: { id, repo: repo.name, branch: branch.name, at, author: r.entry.author || given.author, summary: r.entry.summary || given.summary, added: netAdded(diff.stdout), in: { [branch.name]: { rev: number, at } } },
            relative: r.entry.paths.map((p) => underBranch(branch.url, p.path)).filter((p): p is string => p !== null),
            missing: new Map(),
          };
          break;
        }
        if (!known) {
          // Some branch could not answer: it may be the one. Not remembered, so asked again.
          if (failures.length > 0) throw new Error(`svn log ${id}: ${failures[0]}`);
          known = { revision: { id, repo: repo.name, branch: null, at: given.at, author: given.author, summary: given.summary, added: [], in: {} }, relative: [], missing: new Map() };
        }
        cache.set(id, known);
      }
      if (known.revision.branch !== null) {
        const own = repo.branches.find((b) => b.name === known.revision.branch)!.url;
        for (const branch of repo.branches) {
          if (!branch.copied?.length || known.revision.in![branch.name]) continue;
          const last = known.missing.get(branch.name);
          if (last !== undefined && now() - last < recheckMs) continue;
          await lookIn(known, number, branch, own);
        }
      }
      return structuredClone(known.revision);
    },
  };
}

export type SvnReader = ReturnType<typeof createSvnReader>;
