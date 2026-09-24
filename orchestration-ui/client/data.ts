import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { listRunsRpc, readRunRpc } from "../shared/rpc";
import { createRun, foldEvents, runStatus, type ProcessCheck, type RunState } from "../shared/run";

// Polling. The list refreshes every few seconds. A run is read incrementally from the byte
// offset the daemon last handed back, about once a second while it runs, and not at all once
// run.end has arrived.

const LIST_MS = 3_000;
const RUNNING_MS = 1_500;
const QUIET_MS = 5_000;

export type RunList = RpcOutput<typeof listRunsRpc>;

export function useRunList(): { data: RunList | null; error: string | null } {
  const list = useRpc(listRunsRpc);
  const [state, setState] = useState<{ data: RunList | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const data = await list({ limit: 200 });
        if (!cancelled) setState({ data, error: null });
      } catch (error) {
        // Keep showing the last list; say the refresh failed.
        if (!cancelled) setState((current) => ({ data: current.data, error: String(error) }));
      }
      if (!cancelled) timer = setTimeout(tick, LIST_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [list]);
  return state;
}

export interface RunSnapshot {
  run: RunState;
  /** The parsed lines as read, for the events view. Appended in place like `run`. */
  events: unknown[];
  /** Bumped on every fold; the run object itself is mutated in place. */
  version: number;
  loaded: boolean;
  state: RpcOutput<typeof readRunRpc>["state"] | null;
  detail: string;
  staleMs: number;
  /** The last read failed; the view keeps what it had. */
  error: string | null;
  /** The daemon's look at the run's process; null once ended, or when it cannot look. */
  process: ProcessCheck | null;
  polling: boolean;
}

export function useRun(runId: string): RunSnapshot {
  const read = useRpc(readRunRpc);
  const [snapshot, setSnapshot] = useState<RunSnapshot>(() => ({
    run: createRun(),
    events: [],
    version: 0,
    loaded: false,
    state: null,
    detail: "",
    staleMs: 15 * 60_000,
    error: null,
    polling: true,
    process: null,
  }));
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let run = createRun();
    let events: unknown[] = [];
    let offset = 0;
    let version = 0;
    const tick = async () => {
      let delay = QUIET_MS;
      try {
        const chunk = await read({ runId, offset, probe: run.end === null });
        if (cancelled) return;
        if (chunk.reset) {
          run = createRun();
          events = [];
        }
        foldEvents(chunk.events, run);
        for (const event of chunk.events) events.push(event);
        for (const bad of chunk.badLines) run.problems.push(`字节 ${bad.offset} 处的一行不是 JSON（${bad.error}）`);
        offset = chunk.nextOffset;
        const ended = run.end !== null && !chunk.more;
        version += 1;
        setSnapshot({
          run,
          events,
          version,
          loaded: true,
          state: chunk.state,
          detail: chunk.detail,
          staleMs: chunk.staleMs,
          error: null,
          polling: !ended,
          process: run.end ? null : chunk.process,
        });
        if (ended) return;
        if (chunk.state === "ok") {
          delay = chunk.more ? 0 : runStatus(run, Date.now(), chunk.staleMs, chunk.process) === "lost" ? QUIET_MS : RUNNING_MS;
        }
      } catch (error) {
        if (cancelled) return;
        setSnapshot((current) => ({ ...current, loaded: true, error: String(error) }));
      }
      timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, read]);
  return snapshot;
}

/** The current time, ticking while `active`. */
export function useNow(active: boolean, everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}
