import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunView } from "../shared/graph";
import type { Probe } from "../shared/liveness.mjs";
import { createRunReader } from "../server/runs";

// Fixture event files written the way the orchestration runtime writes them (EVENTS.md): one json per line,
// `v`, `seq`, `ts`, `runId`, `kind` first, and a `.claim` file beside whose modification time says whether the run
// is alive. No flow runs in the real system yet; these are made-up runs of a made-up flow.

export const NOW = Date.parse("2026-10-23T12:00:00Z");
export const ago = (ms: number) => new Date(NOW - ms).toISOString();
export const MIN = 60_000;
export const AFFAIR = (caseId: string, extra: Record<string, string> = {}) => ({ label: "示例单的流程", link: { plugin: "reconcile", screen: "inbox", params: { case: caseId, ...extra } } });

export interface Fixture {
  dir: string;
  /**
   * Writes a run's events; `claimAgeMs` null: no claim file; `claimBody`: what the claim says (a string is written as it is);
   * `fileAgeMs`: how long ago the events file was last written.
   */
  run(runId: string, events: Array<Record<string, unknown>>, options?: { claimAgeMs?: number | null; claimBody?: unknown; fileAgeMs?: number }): void;
  append(runId: string, events: Array<Record<string, unknown>>, raw?: string): void;
  reader: ReturnType<typeof createRunReader>;
  close(): void;
}

export function fixture(probe?: Probe): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-runs-"));
  const runsDir = path.join(dir, "runs");
  mkdirSync(runsDir);
  const seqs = new Map<string, number>();
  const lines = (runId: string, events: Array<Record<string, unknown>>) =>
    events.map((e) => JSON.stringify({ v: 1, seq: seqs.get(runId) ?? 0, runId, ...((seqs.set(runId, (seqs.get(runId) ?? 0) + 1), e)) }) + "\n").join("");
  return {
    dir: runsDir,
    run(runId, events, options = {}) {
      const file = path.join(runsDir, `${runId}.jsonl`);
      writeFileSync(file, lines(runId, events));
      if (options.fileAgeMs !== undefined) utimesSync(file, new Date(NOW - options.fileAgeMs), new Date(NOW - options.fileAgeMs));
      const age = options.claimAgeMs === undefined ? 10_000 : options.claimAgeMs;
      if (age !== null) {
        const claim = path.join(runsDir, `${runId}.claim`);
        const body = options.claimBody === undefined ? { pid: 1, hostname: "h", startedAt: ago(60 * MIN) } : options.claimBody;
        writeFileSync(claim, typeof body === "string" ? body : JSON.stringify(body));
        utimesSync(claim, new Date(NOW - age), new Date(NOW - age));
      }
    },
    append(runId, events, raw = "") {
      appendFileSync(path.join(runsDir, `${runId}.jsonl`), lines(runId, events) + raw);
    },
    reader: createRunReader({ runsDir, tz: "Asia/Shanghai", now: () => NOW, affair: { plugin: "reconcile", screen: "inbox" }, view: { plugin: "orchestration-ui", screen: "runs" }, probe }),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const start = (ts: string, affair: unknown, phases = ["collect", "draft", "publish"]) => ({
  kind: "run.start",
  ts,
  flow: { name: "示例流程", description: "x", phases: phases.map((id) => ({ id, title: `阶段 ${id}` })), inputs: {}, grants: [] },
  source: null,
  input: {},
  caller: null,
  cwd: "/x",
  host: null,
  pid: 1,
  hostname: "h",
  affair,
});
export const phaseStart = (ts: string, phase: string) => ({ kind: "phase.start", ts, phase });
export const phaseEnd = (ts: string, phase: string, ok = true) => ({ kind: "phase.end", ts, phase, ok });
export const callStart = (ts: string, callId: string, type: "ask" | "do" | "gate", extra: Record<string, unknown> = {}) => ({ kind: "call.start", ts, callId, type, name: callId, title: `调用 ${callId}`, phase: null, ...extra });
export const callEnd = (ts: string, callId: string, ok = true, extra: Record<string, unknown> = {}) => ({ kind: "call.end", ts, callId, ok, durationMs: 1000, output: null, error: null, agentId: null, cost: { usd: 0.25, inputTokens: 1, outputTokens: 1 }, ...extra });

export const only = (f: Fixture, caseId = "tracker:1"): RunView => {
  const runs = f.reader.forCase(caseId);
  assert.equal(runs.length, 1);
  return runs[0]!;
};

/** A run as the page gets it, for tests of what the page does with runs; `over` replaces any part. */
export const runView = (situation: RunView["situation"], over: Partial<RunView> = {}): RunView => ({
  runId: "r1",
  stage: "a",
  flow: "示例流程",
  startedAt: "2026-10-13T09:30:00+08:00",
  endedAt: null,
  situation,
  outcome: null,
  step: { index: 2, total: 3, title: "阶段 draft" },
  steps: ["ok", "run", "todo"],
  costUsd: 0.42,
  quiet: { ms: 0, limitMs: 15 * MIN },
  gate: null,
  error: null,
  stopReason: null,
  sideEffects: [],
  agentId: null,
  link: { plugin: "orchestration-ui", screen: "runs", params: { run: "r1" } },
  retry: null,
  ...over,
});

