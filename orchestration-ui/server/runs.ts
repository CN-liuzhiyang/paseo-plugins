import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import type { listRunsRpc, readRunRpc, RunSummary } from "../shared/rpc";
import { activity } from "../shared/format";
import { hero, inputLabel, phaseStrip } from "../shared/graph";
import {
  applyEvent,
  costSoFar,
  createRun,
  foldEvents,
  phaseTitle,
  runStatus,
  type ProcessCheck,
  type RunState,
} from "../shared/run";
import { checkProcess, localProbe, type Probe } from "./alive";
import { readFrom, readHeadLine, readTailLines, type Line } from "./lines";

// Reading <logDir>/runs. A run is folded in full -- the list has to know what it is doing, which
// calls are open to tell running from lost, and how far each phase got -- but incrementally: each
// listing reads only what was appended since the last one. A finished run is folded once and its
// summary cached until the file changes; a finished run too big for that is summarized from its
// first and last lines only.

type ListOutput = RpcOutput<typeof listRunsRpc>;
type ReadOutput = RpcOutput<typeof readRunRpc>;

const SUFFIX = ".jsonl";
/** Past this size an unfinished run is summarized from head and tail, like a finished one. */
const FOLD_LIMIT = 64 << 20;
/** Past this size a finished run is summarized from head and tail: no phase strip. */
const FINISHED_FOLD_LIMIT = 8 << 20;

interface Finished {
  size: number;
  mtimeMs: number;
  summary: RunSummary;
}

interface Unfinished {
  offset: number;
  run: RunState;
}

export interface RunIndexOptions {
  now?: () => number;
  probe?: Probe;
}

function parseLine(line: Line): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(line.text) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${code}：${(error as Error).message}` : String(error);
}

export function summarize(
  runId: string,
  run: RunState,
  size: number,
  now: number,
  staleMs: number,
  proc: ProcessCheck | null = null,
  { whole = true }: { whole?: boolean } = {},
): RunSummary {
  const status = runStatus(run, now, staleMs, proc);
  const top = run.start ? hero(run, status, now, { proc, staleMs }) : null;
  const end = run.end;
  let costUsd: number | null = null;
  let costNote: string | null = null;
  if (end) {
    costUsd = end.cost?.totalUsd ?? null;
    costNote = end.cost?.partial || null;
  } else if (run.start) {
    const soFar = costSoFar(run);
    costUsd = soFar.usd;
    costNote = soFar.uncounted > 0 ? `已结束调用的合计；${soFar.uncounted} 个调用未计入` : "已结束调用的合计";
  }
  return {
    runId,
    flowName: run.start?.flow.name ?? null,
    description: run.start?.flow.description ?? null,
    startedAt: run.startedAt,
    lastEventAt: run.lastEventAt,
    status,
    durationMs: end?.durationMs ?? null,
    costUsd,
    costNote,
    caller: run.start?.caller ?? null,
    host: run.start?.host ?? null,
    activity: activity(run, status, now, { proc, staleMs }),
    stop: end?.stop ? { ...end.stop, phaseTitle: phaseTitle(run, end.stop.phase) } : null,
    error: end?.error ?? null,
    problem: null,
    process: run.end ? null : proc,
    sizeBytes: size,
    inputLabel: inputLabel(run.start),
    hero: top ? { tone: top.tone, title: top.title } : null,
    needsYou: top?.needsYou ?? false,
    strip: whole && run.start ? phaseStrip(run, status) : null,
  };
}

function unreadable(runId: string, size: number, problem: string): RunSummary {
  return {
    runId,
    flowName: null,
    description: null,
    startedAt: null,
    lastEventAt: null,
    status: "unreadable",
    durationMs: null,
    costUsd: null,
    costNote: null,
    caller: null,
    host: null,
    activity: null,
    stop: null,
    error: null,
    problem,
    process: null,
    sizeBytes: size,
    inputLabel: null,
    hero: null,
    needsYou: false,
    strip: null,
  };
}

/**
 * Where run.start says the run's process lives; null when the first line is not a run.start yet.
 * Callers look before reading the events: a process found gone has already written everything it
 * ever will, so a run.end it wrote just before exiting is in the read that follows.
 */
async function processOf(file: string, probe: Probe): Promise<ProcessCheck | null> {
  const head = await readHeadLine(file);
  if (head === null) return null;
  const start = parseLine({ offset: 0, text: head });
  if (!start.ok) return null;
  return checkProcess(foldEvents([start.value]).start, probe);
}

export function createRunIndex({ now = Date.now, probe = localProbe }: RunIndexOptions = {}) {
  const finished = new Map<string, Finished>();
  const unfinished = new Map<string, Unfinished>();

  /** head + tail. Null when the tail holds no run.end, i.e. the run has not finished. */
  async function fromEnds(file: string, runId: string, size: number): Promise<RunSummary | null> {
    const head = await readHeadLine(file);
    if (head === null) return null;
    const start = parseLine({ offset: 0, text: head });
    if (!start.ok) return unreadable(runId, size, `第一行不是 JSON：${start.error}`);
    const kind = (start.value as { kind?: unknown } | null)?.kind;
    if (kind !== "run.start") return unreadable(runId, size, `第一行不是 run.start（是 ${JSON.stringify(kind)}）`);
    const tail = await readTailLines(file);
    let end: unknown = null;
    for (const line of tail) {
      const parsed = parseLine(line);
      if (parsed.ok && (parsed.value as { kind?: unknown } | null)?.kind === "run.end") end = parsed.value;
    }
    if (end === null) return null;
    if (size > FINISHED_FOLD_LIMIT) return summarize(runId, foldEvents([start.value, end]), size, now(), 0, null, { whole: false });
    return summarize(runId, await fold(file, size), size, now(), 0);
  }

  async function fold(file: string, size: number): Promise<RunState> {
    let entry = unfinished.get(file);
    if (!entry || entry.offset > size) entry = { offset: 0, run: createRun() };
    while (entry.offset < size) {
      const chunk = await readFrom(file, entry.offset, 4 << 20);
      for (const line of chunk.lines) {
        const parsed = parseLine(line);
        if (parsed.ok) applyEvent(entry.run, parsed.value);
        else entry.run.problems.push(`字节 ${line.offset} 处的一行不是 JSON`);
      }
      entry.offset = chunk.nextOffset;
      if (!chunk.more) break;
    }
    unfinished.set(file, entry);
    return entry.run;
  }

  async function summaryOf(file: string, runId: string, size: number, mtimeMs: number, staleMs: number): Promise<RunSummary> {
    const cached = finished.get(file);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.summary;
    if (size === 0) {
      const quiet = now() - mtimeMs > staleMs;
      return {
        ...unreadable(runId, 0, ""),
        status: quiet ? "lost" : "starting",
        problem: null,
        activity: quiet ? "文件是空的，一直没有写入第一条事件" : "文件已创建，第一条事件还没写完",
      };
    }
    const ended = await fromEnds(file, runId, size);
    if (ended) {
      finished.set(file, { size, mtimeMs, summary: ended });
      unfinished.delete(file);
      return ended;
    }
    const proc = await processOf(file, probe);
    if (size > FOLD_LIMIT) {
      // Too big to fold for a list row: say what the ends say and leave the detail to the view.
      const head = await readHeadLine(file);
      const tail = await readTailLines(file);
      const events = [head, tail.at(-1)?.text].flatMap((text) => {
        if (text == null) return [];
        const parsed = parseLine({ offset: 0, text });
        return parsed.ok ? [parsed.value] : [];
      });
      const run = foldEvents(events);
      return summarize(runId, run, size, now(), staleMs, proc, { whole: false });
    }
    const run = await fold(file, size);
    if (!run.start && run.eventCount > 0) return unreadable(runId, size, "第一条事件不是 run.start");
    return summarize(runId, run, size, now(), staleMs, run.end ? null : proc);
  }

  async function list(runsDir: string, limit: number, staleMs: number): Promise<Omit<ListOutput, "logDir" | "staleMs">> {
    let names: string[];
    try {
      names = (await readdir(runsDir)).filter((name) => name.endsWith(SUFFIX));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { state: "missing", detail: `目录不存在：${runsDir}`, runs: [], total: 0 };
      }
      return { state: "unreadable", detail: `读不了目录 ${runsDir}（${describe(error)}）`, runs: [], total: 0 };
    }
    const files = (
      await Promise.all(
        names.map(async (name) => {
          const file = path.join(runsDir, name);
          try {
            const info = await stat(file);
            return info.isFile() ? [{ name, file, size: info.size, mtimeMs: info.mtimeMs }] : [];
          } catch {
            return []; // Removed between readdir and stat.
          }
        }),
      )
    ).flat();
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const shown = files.slice(0, limit);
    const runs = await Promise.all(
      shown.map(async ({ name, file, size, mtimeMs }) => {
        const runId = name.slice(0, -SUFFIX.length);
        try {
          return await summaryOf(file, runId, size, mtimeMs, staleMs);
        } catch (error) {
          return unreadable(runId, size, `读不了：${describe(error)}`);
        }
      }),
    );
    // Forget files that are gone or no longer shown.
    const kept = new Set(shown.map(({ file }) => file));
    for (const key of [...finished.keys()]) if (!kept.has(key)) finished.delete(key);
    for (const key of [...unfinished.keys()]) if (!kept.has(key)) unfinished.delete(key);
    // Newest start first; a run whose start is unknown sorts by when its file last changed.
    const startOf = (summary: RunSummary, index: number) =>
      Date.parse(summary.startedAt ?? "") || shown[index]!.mtimeMs;
    const order = runs.map((summary, index) => ({ summary, key: startOf(summary, index) }));
    order.sort((a, b) => b.key - a.key);
    return { state: "ok", detail: "", runs: order.map(({ summary }) => summary), total: files.length };
  }

  return { list };
}

/** One increment of one run's events, from a byte offset; with `check`, also whether its process lives. */
export async function readRun(
  runsDir: string,
  runId: string,
  offset: number,
  { check = false, probe = localProbe }: { check?: boolean; probe?: Probe } = {},
): Promise<Omit<ReadOutput, "staleMs">> {
  const file = path.join(runsDir, `${runId}${SUFFIX}`);
  const empty = { events: [], badLines: [], nextOffset: offset, size: 0, reset: false, more: false, process: null };
  try {
    const process = check ? await processOf(file, probe) : null;
    const chunk = await readFrom(file, offset);
    const events: unknown[] = [];
    const badLines: Array<{ offset: number; error: string }> = [];
    for (const line of chunk.lines) {
      const parsed = parseLine(line);
      if (parsed.ok) events.push(parsed.value);
      else badLines.push({ offset: line.offset, error: parsed.error });
    }
    const { nextOffset, size, reset, more } = chunk;
    return { state: "ok", detail: "", events, badLines, nextOffset, size, reset, more, process };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "missing", detail: `找不到 ${file}`, ...empty };
    return { state: "unreadable", detail: `读不了 ${file}（${describe(error)}）`, ...empty };
  }
}
