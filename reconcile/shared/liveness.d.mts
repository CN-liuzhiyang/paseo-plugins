// 由运行时复制，别手改。来源：orchestration/runtime/liveness.d.mts。要改就改那份，再在 orchestration/ 里跑 `npm run sync:liveness`。

// Types of liveness.mjs. Copied with it into each plugin that carries a copy (scripts/sync-liveness.mjs).

export const LIVE_WITHIN_MS: number;
export const START_GRACE_MS: number;
export const LEGACY_QUIET_MS: number;
export const STALE_BASE_MS: number;
export const STALE_GRACE_MS: number;

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

export interface Probe {
  hostname: string;
  kill: (pid: number, signal: 0) => unknown;
}

export function classify(facts: LivenessFacts): { state: RunState; safeToRestart: boolean };
export function pidFact(body: { pid?: unknown; hostname?: unknown } | null | undefined, probe: Probe): "alive" | "gone" | "unknown";
export function parseDuration(text: string | null): number | null;
export function staleAfterMs(run: {
  baseMs?: number;
  lastEventAtMs: number | null;
  openCalls: Array<{ startedAtMs: number | null; timeoutMs: number | null }>;
}): number;
