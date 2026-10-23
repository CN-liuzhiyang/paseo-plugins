// A run's claim on its id: `<logDir>/runs/<runId>.claim`.
//
// The events file does not exist until run.start, and run.start comes after
// the runner has loaded the flow, scanned it, read the roles and checked the
// gate's provider -- seconds, in which a second process given the same id
// would find nothing and run the flow again, and pay again. So the runner
// takes the id first, with an exclusive create (`wx`), which the file system
// makes atomic: of any number of processes asking for one id, one gets the
// file. It cannot be a line in the events file, which must open with run.start.
//
// The file says who holds the id ({ pid, hostname, startedAt }), and the
// holder touches it every HEARTBEAT_MS. That is what tells a reader the run is
// alive: a claim touched within LIVE_WITHIN_MS. Not the pid -- a pid is reused
// by the system, and a process that exists proves nothing about this run. The
// file stays after the run ends, as the record that the id was used.
//
// A run refused after it holds a caller-given id (the flow does not load, the
// input does not fit) leaves the claim with `refused: <why>` and stops touching
// it: the id is spent, and a caller that looks later finds the reason where it
// looks. A generated id is nobody's to look up, so its claim is removed and the
// refusal leaves no file, as EVENTS.md says.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** What a caller-given run id looks like; orchestration-ui reads the same shape. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const RUN_ID_LIMIT = 128;
/** The runner's own files sit next to a run's: an id ending like one would be taken for it. */
const OWN_SUFFIX = /\.(claim|jsonl)$/i;
/** Names Windows treats as devices whatever extension follows; a file called CON.claim is not a file. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** How often the holder touches its claim. */
export const HEARTBEAT_MS = 30_000;
/** A claim touched within this long ago belongs to a run that is alive (four heartbeats). */
export const LIVE_WITHIN_MS = 120_000;
/** The holder gives up after this many heartbeats in a row that could not touch the claim. */
const HEARTBEAT_FAILURES = 3;

/** `<logDir>/runs/<runId>.claim` */
export const claimFile = (dir, runId) => path.join(dir, "runs", `${runId}.claim`);

/** Why a run id cannot be used, or null. */
export function runIdProblem(runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return `a run id must match ${RUN_ID}`;
  if (runId.length > RUN_ID_LIMIT) return `a run id is at most ${RUN_ID_LIMIT} characters`;
  if (OWN_SUFFIX.test(runId)) return `a run id does not end in .claim or .jsonl, which are the run's own files`;
  if (DEVICE_NAME.test(runId)) return `"${runId}" is a reserved device name on Windows`;
  return null;
}

/** The id is already held. `holder` is what the claim file says, or null when it could not be read. */
export class ClaimTaken extends Error {
  constructor(runId, holder, touchedAgoMs) {
    const who = holder
      ? `by pid ${holder.pid} on ${holder.hostname} since ${holder.startedAt}` +
        (touchedAgoMs === null ? "" : `, last touched ${Math.round(touchedAgoMs / 1000)}s ago`) +
        (holder.refused ? `; it was refused: ${holder.refused}` : "")
      : "(its claim file cannot be read)";
    super(`run id ${runId} is already taken ${who}`);
    this.name = "ClaimTaken";
    this.holder = holder;
  }
}

/**
 * Take the id, or throw ClaimTaken. Returns the claim: `refuse(reason)` for a
 * run that ends before run.start, `stop()` when the run is over. `onError` (also
 * settable on the claim) is told once, after the heartbeat has failed three times running, and a
 * handler that throws is ignored; the claim then goes stale and a reader will take the run for dead.
 *
 * @param {{ dir: string, runId: string, heartbeatMs?: number, now?: () => number, onError?: (error: Error) => void }} options
 */
export function claimRun({ dir, runId, heartbeatMs = HEARTBEAT_MS, now = Date.now, onError = () => {} }) {
  const file = claimFile(dir, runId);
  const info = { pid: process.pid, hostname: os.hostname(), startedAt: new Date(now()).toISOString() };
  mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = openSync(file, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let holder = null;
    let touchedAgoMs = null;
    try {
      holder = JSON.parse(readFileSync(file, "utf8"));
      touchedAgoMs = now() - statSync(file).mtimeMs;
    } catch {
      // Being written, or not ours to read: the message says so.
    }
    throw new ClaimTaken(runId, holder, touchedAgoMs);
  }
  try {
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }

  let failures = 0;
  let timer = setInterval(() => {
    try {
      const at = new Date(now());
      utimesSync(file, at, at);
      failures = 0;
    } catch (error) {
      // The claim was removed (a log clean-up, a person): put it back rather than look dead.
      if (error.code === "ENOENT") {
        try {
          writeFileSync(file, JSON.stringify(info), { flag: "wx" });
          failures = 0;
          return;
        } catch {
          // Cannot recreate it either: counts as a failure below.
        }
      }
      failures += 1;
      if (failures < HEARTBEAT_FAILURES) return;
      stop();
      // This runs in a timer: whatever the caller's handler does, it must not take the runner down.
      try {
        claim.onError(error);
      } catch {
        // The claim is going stale; the run itself carries on.
      }
    }
  }, heartbeatMs);
  timer.unref?.();

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  const claim = {
    file,
    runId,
    info,
    onError,
    stop,
    /** For a run nobody can ask after (a generated id): take the file away, as if it had never started. */
    discard() {
      stop();
      try {
        unlinkSync(file);
      } catch {
        // Already gone.
      }
    },
    refuse(reason) {
      stop();
      // Written beside and renamed over, so a reader sees the claim as it was or as it is now,
      // never an empty or half-written file.
      const next = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(next, JSON.stringify({ ...info, refused: String(reason).slice(0, 2_000) }), "utf8");
        renameSync(next, file);
      } catch {
        // The refusal still reaches the caller as the exception; the file only adds the reason.
        try {
          unlinkSync(next);
        } catch {
          // Never written.
        }
      }
    },
  };
  return claim;
}
