import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { runCardSchema } from "./card";

// What the surface asks the daemon side. The daemon only reads files; the app folds events
// with shared/run.ts, the same code that summarizes a run for the list.

const logDir = z.object({
  /** The directory runs are read from: <logDir>/runs. */
  runsDir: z.string(),
  logDir: z.string(),
  /** Which rule chose it, in resolution order. */
  source: z.enum(["settings", "env", "config", "default"]),
  /** The config file consulted, when one was. */
  configFile: z.string().nullable(),
});
export type LogDirInfo = z.output<typeof logDir>;

const error = z.object({ name: z.string(), message: z.string() }).nullable();

/** The daemon's look at an unfinished run's process; null when it could not look (see server/alive.ts). */
const processCheck = z.object({ pid: z.number().nullable(), alive: z.boolean(), gone: z.boolean().nullable().optional() }).nullable();

export const runSummary = z.object({
  runId: z.string(),
  flowName: z.string().nullable(),
  description: z.string().nullable(),
  startedAt: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  status: z.enum(["done", "stopped", "failed", "timeout", "running", "lost", "starting", "unreadable"]),
  /** run.end.durationMs; for a run without one the app counts from startedAt. */
  durationMs: z.number().nullable(),
  costUsd: z.number().nullable(),
  /** run.end.cost.partial, or why the figure is a lower bound. */
  costNote: z.string().nullable(),
  caller: z.string().nullable(),
  host: z.string().nullable(),
  /** run.start.affair's label: what the run is for, as its caller said. The detail view has the rest. */
  affairLabel: z.string().nullable(),
  /** For a run without run.end: what it is doing, or was doing when it went quiet. */
  activity: z.string().nullable(),
  stop: z.object({ reason: z.string(), phase: z.string().nullable(), phaseTitle: z.string().nullable() }).nullable(),
  error,
  /** Why the file could not be summarized. */
  problem: z.string().nullable(),
  process: processCheck,
  sizeBytes: z.number(),
  /** The input value that tells this run from the others (shared/graph.ts inputLabel). */
  inputLabel: z.string().nullable(),
  /** The detail view's one sentence (shared/graph.ts hero), for the row. */
  hero: z.object({ tone: z.enum(["neutral", "accent", "success", "warning", "danger"]), title: z.string() }).nullable(),
  /** A person has to act: a gate is waiting, or the run is lost. */
  needsYou: z.boolean(),
  /** One segment per declared phase; null when the file was too big to fold for a row. */
  strip: z
    .array(
      z.object({
        title: z.string(),
        state: z.enum(["done", "running", "waiting", "failed", "stopped", "interrupted", "pending", "skipped"]),
      }),
    )
    .nullable(),
});
export type RunSummary = z.output<typeof runSummary>;

export const listRunsRpc = defineRpc({
  name: "orchestration-ui.runs.list",
  input: z.object({ limit: z.number().int().min(1).max(1000).default(200) }),
  output: z.object({
    /** ok; missing: runs/ does not exist; unreadable: it exists and cannot be listed; config: logDir cannot be resolved. */
    state: z.enum(["ok", "missing", "unreadable", "config"]),
    detail: z.string(),
    logDir: logDir.nullable(),
    runs: z.array(runSummary),
    /** How many run files there are, of which `runs` are the newest `limit`. */
    total: z.number(),
    staleMs: z.number(),
  }),
});

/** How many runs the list reads; the flows' counts are over the same ones, so the two share what the daemon has folded. */
export const RUN_LIST_LIMIT = 200;

const flowInput = z.object({
  name: z.string(),
  /** The command-line flag the runtime takes it as (`--item-no`). */
  flag: z.string(),
  kind: z.enum(["text", "choice", "count", "flag", "list", "group"]),
  description: z.string(),
  choices: z.array(z.string()).optional(),
});
export type FlowInput = z.output<typeof flowInput>;

/** One flow: what it is (from the runtime's `list`) and how its runs have gone (from the run files). */
export const flowRow = z.object({
  name: z.string(),
  description: z.string(),
  /** shipped: in the runtime's own flows/; config: in a flowsDirs directory; seen: not in the list, but a run file says it ran. */
  origin: z.enum(["shipped", "config", "seen"]),
  file: z.string().nullable(),
  phases: z.array(z.object({ id: z.string(), title: z.string() })),
  inputs: z.array(flowInput),
  grants: z.array(z.string()),
  /** What `orch check` would refuse or warn about in the source. */
  problems: z.array(z.string()),
  /** The file is in a flows directory but cannot be used as a flow; this is why. */
  error: z.string().nullable(),
  /** How many of the runs the list shows (the newest RUN_LIST_LIMIT) are this flow's. */
  runCount: z.number(),
  /** Its newest run, by start time. */
  latest: runSummary.nullable(),
});
export type FlowRow = z.output<typeof flowRow>;

export const listFlowsRpc = defineRpc({
  name: "orchestration-ui.flows.list",
  input: z.object({}),
  output: z.object({
    /**
     * ok: the runtime listed the flows. fallback: it could not be asked (`detail` says why), so these are the flows
     * a run file says ran -- a flow nobody has run yet is not among them.
     */
    state: z.enum(["ok", "fallback"]),
    detail: z.string(),
    /** The orch.mjs the list came from (the setting), for the command that starts a flow; null when there is none. */
    orchPath: z.string().nullable(),
    flows: z.array(flowRow),
  }),
});

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const readRunRpc = defineRpc({
  name: "orchestration-ui.runs.read",
  input: z.object({
    runId: z.string().regex(RUN_ID),
    offset: z.number().int().min(0),
    /** Also check whether the run's process is still there; the reader asks until it has run.end. */
    probe: z.boolean().default(false),
  }),
  output: z.object({
    state: z.enum(["ok", "missing", "unreadable", "config"]),
    detail: z.string(),
    /** Parsed complete lines from `offset` on, in order. A final line without "\n" is left for later. */
    events: z.array(z.unknown()),
    /** Complete lines that are not JSON, by byte offset. */
    badLines: z.array(z.object({ offset: z.number(), error: z.string() })),
    /** Where the next read starts. */
    nextOffset: z.number(),
    size: z.number(),
    /** The file is shorter than `offset`: it was replaced, so the reader starts over from 0. */
    reset: z.boolean(),
    /** More complete lines are waiting; read again at once. */
    more: z.boolean(),
    staleMs: z.number(),
    process: processCheck,
  }),
});

/** Whether cards go into the conversations that start runs, and if not, why. */
const cardsState = z.object({
  /** on: the feed runs; off: turned off in settings; unavailable: this Paseo cannot append to timelines. */
  state: z.enum(["on", "off", "unavailable"]),
  detail: z.string(),
});
export type CardsState = z.output<typeof cardsState>;

export const statusRpc = defineRpc({
  name: "orchestration-ui.status",
  input: z.object({}),
  output: z.object({ logDir: logDir.nullable(), detail: z.string(), cards: cardsState }),
});

export const readCardRpc = defineRpc({
  name: "orchestration-ui.runs.card",
  input: z.object({ runId: z.string().regex(RUN_ID) }),
  output: z.object({
    state: z.enum(["ok", "missing", "unreadable", "config"]),
    detail: z.string(),
    card: runCardSchema.nullable(),
  }),
});
