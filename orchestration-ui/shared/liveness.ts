// Whether a run is alive, from its claim. This is orchestration/runtime/state.mjs `classify`,
// ported: orchestration-ui is installed on its own and cannot import the runtime's module, so the
// table exists twice. What keeps the two the same is orchestration/fixtures/run-state-cases.json:
// both are tested against every row of it, and a row changed on one side fails the other.
//
// Alive means one thing: the claim (`<runId>.claim`) was touched within LIVE_WITHIN_MS. The pid is
// only ever evidence of death.

export const LIVE_WITHIN_MS = 120_000;
export const START_GRACE_MS = 60_000;
/** A run with events and no claim (written before claims existed) is lost after this long quiet. */
export const LEGACY_QUIET_MS = 15 * 60_000;

export type RunState =
  | "pending"
  | "absent"
  | "refused"
  | "starting"
  | "running"
  | "dead-before-start"
  | "stalled-before-start"
  | "lost"
  | "ended"
  | "unreadable";

export interface LivenessFacts {
  claim: null | { ageMs: number; refused?: boolean; unreadable?: boolean };
  events: "none" | "open" | "ended";
  /** Whether the holder's pid exists, asked on the holder's machine only. */
  pid?: "alive" | "gone" | "unknown";
  quietMs?: number;
  spawnedAgoMs?: number | null;
  graceMs?: number;
  legacyQuietMs?: number;
  liveWithinMs?: number;
}

export function classify(facts: LivenessFacts): { state: RunState; safeToRestart: boolean } {
  const {
    claim,
    events,
    pid = "unknown",
    quietMs = 0,
    spawnedAgoMs = null,
    graceMs = START_GRACE_MS,
    legacyQuietMs = LEGACY_QUIET_MS,
    liveWithinMs = LIVE_WITHIN_MS,
  } = facts;
  const answer = (state: RunState, safeToRestart = false) => ({ state, safeToRestart });

  if (events === "ended") return answer("ended");

  if (claim === null) {
    if (events === "open") return pid === "gone" || quietMs > legacyQuietMs ? answer("lost") : answer("running");
    if (spawnedAgoMs === null) return answer("absent");
    return spawnedAgoMs < graceMs ? answer("pending") : answer("absent", true);
  }

  // A refusal first: writing it touched the file, so it looks fresh.
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
