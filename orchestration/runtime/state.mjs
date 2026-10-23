// What state a run is in, read from its two files: the one way a caller (a plugin that started the
// run, a UI) answers "is it alive, did it start, can I start it again". EVENTS.md's table is this file
// in prose; fixtures/run-state-cases.json is the same table as data, and both this module and
// orchestration-ui's port of `classify` are tested against it.
//
//   const { state, safeToRestart, reason } = readRunState({ dir: logDir, runId, spawnedAt });
//
// Alive means one thing: the claim (claim.mjs) was touched within LIVE_WITHIN_MS. The process id is
// only ever evidence of death -- a pid that does not exist, on the machine that holds the claim, is
// proof the holder is gone; a pid that exists proves nothing, because pids are reused.
//
// Nothing here starts, stops or deletes anything. A state that costs money to get wrong
// (`dead-before-start`, `stalled-before-start`, `lost`) never says it is safe to start again: that
// is a person's call, and `safeToRestart` is true in exactly one case, below.

import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import os from "node:os";
import { claimFile, LIVE_WITHIN_MS } from "./claim.mjs";
import { eventsFile } from "./events.mjs";

/** A file with events and no claim (written before claims existed) is lost after this long quiet. */
export const LEGACY_QUIET_MS = 15 * 60_000;
/** After starting a process, how long before "no claim and no events" means it did not start. */
export const START_GRACE_MS = 60_000;

/**
 * The states, and what each asks of the caller.
 *
 * - `pending`: no claim, no events, but the process was started just now. Look again.
 * - `absent`: no claim, no events, and enough time has passed since the process was started
 *   (`safeToRestart`), or the caller did not say when it started it (it is not safe to assume).
 * - `refused`: the runner took the id and ended before run.start; `reason` says why. The id is spent.
 * - `starting`: claim touched lately, no events yet: the runner is doing its checks.
 * - `running`: claim touched lately, run.start written, no run.end.
 * - `dead-before-start`, `stalled-before-start`: the claim is stale and there are no events. Nothing
 *   was spent. `stalled` means the holder's pid still exists. Neither is a reason to start again by
 *   itself: a person decides (the holder may have been asleep, not dead).
 * - `lost`: the claim is stale (or the holder is gone) after run.start and without run.end. Money was
 *   spent: the events say how much. Never started again by itself.
 * - `ended`: run.end is written; `outcome` says how.
 * - `unreadable`: the claim is there and fresh but cannot be read (being written). Look again.
 */
export const RUN_STATES = [
  "pending",
  "absent",
  "refused",
  "starting",
  "running",
  "dead-before-start",
  "stalled-before-start",
  "lost",
  "ended",
  "unreadable",
];

/**
 * The table. Pure: everything it needs is passed in, so the same function is the test of the table.
 *
 * @param {{
 *   claim: null | { ageMs: number, refused?: boolean, unreadable?: boolean },
 *   events: "none" | "open" | "ended",
 *   pid?: "alive" | "gone" | "unknown",
 *   quietMs?: number,
 *   spawnedAgoMs?: number | null,
 *   graceMs?: number,
 *   legacyQuietMs?: number,
 *   liveWithinMs?: number,
 * }} facts
 * @returns {{ state: string, safeToRestart: boolean }}
 */
export function classify(facts) {
  const { claim, events, pid = "unknown", quietMs = 0, spawnedAgoMs = null, graceMs = START_GRACE_MS, legacyQuietMs = LEGACY_QUIET_MS, liveWithinMs = LIVE_WITHIN_MS } = facts;
  const answer = (state, safeToRestart = false) => ({ state, safeToRestart });

  if (events === "ended") return answer("ended");

  if (claim === null) {
    // Before claims existed: the old rule, quiet time, with a gone pid as proof of death.
    if (events === "open") return pid === "gone" || quietMs > legacyQuietMs ? answer("lost") : answer("running");
    if (spawnedAgoMs === null) return answer("absent");
    return spawnedAgoMs < graceMs ? answer("pending") : answer("absent", true);
  }

  // A refusal is the first thing to look at: writing it touched the file, so it looks fresh.
  if (claim.refused) return answer("refused");

  const fresh = claim.ageMs <= liveWithinMs;
  if (claim.unreadable && fresh) return answer("unreadable");
  // A pid that is gone on the holder's machine is proof of death however fresh the claim.
  const alive = fresh && pid !== "gone";
  if (events === "none") {
    if (alive) return answer("starting");
    return pid === "alive" ? answer("stalled-before-start") : answer("dead-before-start");
  }
  return alive ? answer("running") : answer("lost");
}

const PROSE = {
  pending: "the process was started a moment ago; look again",
  absent: "no claim and no events",
  refused: "the runner refused it before run.start",
  starting: "the claim is fresh and run.start is not written yet",
  running: "the claim is fresh",
  "dead-before-start": "the claim went stale before run.start; nothing was spent. A person decides whether to start it again under a new id",
  "stalled-before-start": "the claim went stale before run.start but its process still exists; nothing was spent. A person decides",
  lost: "the claim went stale (or its process is gone) with no run.end; what was spent is in the events. Not to be started again by itself",
  ended: "run.end is written",
  unreadable: "the claim is being written; look again",
};

const TAIL_BYTES = 4 << 20;

/** The last complete line of a file that parses, and the run.end among the last few. */
function eventsFacts(file) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // Only complete lines (a last line without its newline is being written); the first line of a
    // tail read may be cut, so it is skipped unless the read began at the top.
    const complete = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
    if (start > 0) complete.shift();
    let end = null;
    let lastTs = null;
    for (const line of complete.slice(-8)) {
      try {
        const event = JSON.parse(line);
        if (typeof event?.ts === "string") lastTs = event.ts;
        if (event?.kind === "run.end") end = event;
      } catch {
        // A line that is not JSON says nothing.
      }
    }
    return { ended: end !== null, outcome: end?.outcome ?? null, lastEventAt: lastTs, mtimeMs: statSync(file).mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function readClaim(file) {
  let info;
  try {
    info = statSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let body = null;
  let unreadable = false;
  try {
    body = JSON.parse(readFileSync(file, "utf8"));
    if (body === null || typeof body !== "object") throw new Error("not an object");
  } catch {
    unreadable = true;
  }
  return { mtimeMs: info.mtimeMs, body, unreadable };
}

const localProbe = { hostname: os.hostname(), kill: (pid, signal) => process.kill(pid, signal) };

/** Whether the holder's pid exists, on the holder's machine only; "unknown" anywhere else. */
function pidFact(body, probe) {
  if (!body || !Number.isInteger(body.pid) || typeof body.hostname !== "string") return "unknown";
  if (body.hostname.toLowerCase() !== probe.hostname.toLowerCase()) return "unknown";
  try {
    probe.kill(body.pid, 0);
    return "alive";
  } catch (error) {
    if (error.code === "EPERM") return "alive";
    if (error.code === "ESRCH") return "gone";
    return "unknown";
  }
}

/**
 * Read a run's state from `<dir>/runs/<runId>.claim` and `.jsonl`. Look again after a heartbeat
 * (HEARTBEAT_MS) before doing anything about `dead-before-start`, `stalled-before-start` or `lost`:
 * a machine that was asleep reads as stale for the moment it wakes.
 *
 * @param {{ dir: string, runId: string, now?: () => number, spawnedAt?: number | Date | null,
 *           graceMs?: number, probe?: { hostname: string, kill: (pid: number, signal: 0) => unknown } }} options
 * @returns {{ state: string, safeToRestart: boolean, reason: string, refused: string | null, outcome: string | null,
 *             processAlive: boolean | null, claim: { pid: number | null, hostname: string | null, startedAt: string | null, touchedAgoMs: number } | null,
 *             lastEventAt: string | null }}
 */
export function readRunState({ dir, runId, now = Date.now, spawnedAt = null, graceMs = START_GRACE_MS, probe = localProbe }) {
  const at = now();
  const claim = readClaim(claimFile(dir, runId));
  const events = eventsFacts(eventsFile(dir, runId));
  const body = claim?.body ?? null;
  const pid = claim ? pidFact(body, probe) : "unknown";
  const verdict = classify({
    claim: claim ? { ageMs: at - claim.mtimeMs, refused: typeof body?.refused === "string", unreadable: claim.unreadable } : null,
    events: events === null ? "none" : events.ended ? "ended" : "open",
    pid,
    quietMs: events ? at - (Date.parse(events.lastEventAt ?? "") || events.mtimeMs) : 0,
    spawnedAgoMs: spawnedAt === null ? null : at - Number(spawnedAt instanceof Date ? spawnedAt.getTime() : spawnedAt),
    graceMs,
  });
  return {
    ...verdict,
    reason: PROSE[verdict.state],
    refused: typeof body?.refused === "string" ? body.refused : null,
    outcome: events?.outcome ?? null,
    processAlive: pid === "unknown" ? null : pid === "alive",
    claim: claim
      ? { pid: Number.isInteger(body?.pid) ? body.pid : null, hostname: typeof body?.hostname === "string" ? body.hostname : null, startedAt: typeof body?.startedAt === "string" ? body.startedAt : null, touchedAgoMs: at - claim.mtimeMs }
      : null,
    lastEventAt: events?.lastEventAt ?? null,
  };
}
