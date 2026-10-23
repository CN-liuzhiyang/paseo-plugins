// Whether a run is alive, as one file with no imports: the table (`classify`), the one fact about the holder's
// process (`pidFact`), and how long a run that is alive may stay quiet before it is "maybe stuck" (`staleAfterMs`).
//
// This is the only copy that is written. A plugin is installed on its own and cannot import the runtime's
// modules, so each one that needs the answer carries a copy of this file, made by `npm run sync:liveness`
// (scripts/sync-liveness.mjs) and marked "由运行时复制，别手改". Each plugin's tests compare its copy with this
// file, word for word, and run every row of fixtures/run-state-cases.json through `classify`. Change the
// rule here, run the script, and every copy follows; change a copy and its test fails.
//
// Alive means one thing: the claim (claim.mjs) was touched within LIVE_WITHIN_MS. The process id is only ever
// evidence of death -- a pid that does not exist, on the machine that holds the claim, is proof the holder is
// gone; a pid that exists proves nothing, because pids are reused.

/** A claim touched within this long ago belongs to a run that is alive (four heartbeats). */
export const LIVE_WITHIN_MS = 120_000;
/** After starting a process, how long before "no claim and no events" means it did not start. */
export const START_GRACE_MS = 60_000;
/** A file with events and no claim (written before claims existed) is lost after this long quiet. */
export const LEGACY_QUIET_MS = 15 * 60_000;
/** A run that is alive but writes nothing for this long is quiet enough to say so; a call with a longer timeout raises the bar. */
export const STALE_BASE_MS = 15 * 60_000;
/** Grace on top of an open call's own timeout: the runtime needs a moment to write call.end. */
export const STALE_GRACE_MS = 2 * 60_000;

/**
 * The table. Pure: everything it needs is passed in, so the same function is the test of the table.
 * The states are described in state.mjs, next to what `readRunState` does with them.
 *
 * @param {import("./liveness.d.mts").LivenessFacts} facts
 * @returns {{ state: import("./liveness.d.mts").RunState, safeToRestart: boolean }}
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

/**
 * Whether the holder's pid exists, on the holder's machine only; "unknown" anywhere else.
 *
 * @param {{ pid?: unknown, hostname?: unknown } | null | undefined} body whatever names the holder: the claim, or run.start
 * @param {{ hostname: string, kill: (pid: number, signal: 0) => unknown }} probe
 * @returns {"alive" | "gone" | "unknown"}
 */
export function pidFact(body, probe) {
  if (!body || typeof body.pid !== "number" || !Number.isInteger(body.pid) || typeof body.hostname !== "string") return "unknown";
  if (body.hostname.toLowerCase() !== probe.hostname.toLowerCase()) return "unknown";
  try {
    probe.kill(body.pid, 0);
    return "alive";
  } catch (error) {
    if (error && error.code === "EPERM") return "alive";
    if (error && error.code === "ESRCH") return "gone";
    return "unknown";
  }
}

/**
 * Durations as the runtime writes them in `timeout`. The contract does not fix a format, so this accepts what
 * people write ("90s", "30m", "1h30m", "500ms", "2d") and a bare number of milliseconds; anything else is
 * `null` and the caller falls back to its default.
 *
 * @param {string | null} text
 * @returns {number | null}
 */
export function parseDuration(text) {
  if (text === null || text === undefined) return null;
  const trimmed = String(text).trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const parts = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== trimmed.replace(/\s+/g, "")) return null;
  return parts.reduce((sum, part) => sum + Number(part[1]) * unit[part[2]], 0);
}

/**
 * How long a run without run.end may stay quiet while it is alive before it reads as stuck. A run that is waiting
 * on a call is quiet for as long as that call may legitimately take, so an open call with a readable timeout
 * raises the bar to that timeout; otherwise the base applies. Measured from the last event, like the base.
 *
 * @param {{ baseMs?: number, lastEventAtMs: number | null, openCalls: Array<{ startedAtMs: number | null, timeoutMs: number | null }> }} run
 * @returns {number}
 */
export function staleAfterMs({ baseMs = STALE_BASE_MS, lastEventAtMs, openCalls }) {
  let limit = baseMs;
  for (const call of openCalls) {
    if (call.timeoutMs === null || call.startedAtMs === null || lastEventAtMs === null) continue;
    limit = Math.max(limit, call.startedAtMs + call.timeoutMs + STALE_GRACE_MS - lastEventAtMs);
  }
  return limit;
}
