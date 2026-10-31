import { z } from "zod";
import { hero, inputLabel, phaseStrip, callTitle } from "./graph";
import { costSoFar, openCalls, processGone, type ProcessCheck, type RunState, type RunStatus } from "./run";

// The card a run leaves in the conversation that started it: what it is doing, where in the
// flow, what it cost, whether a person has to act, and at the end how it went. The daemon side
// works it out from the folded events and appends it to the caller's timeline; appending again
// under the same id replaces it in place. Nothing here depends on "now" beyond the status
// itself: elapsed and waited times travel as timestamps and the card counts them.

export const CARD_KIND = "run-card";
export const CARD_VERSION = 1;

const tone = z.enum(["neutral", "accent", "success", "warning", "danger"]);
const status = z.enum(["done", "stopped", "failed", "timeout", "running", "lost", "starting"]);
const stripState = z.enum(["done", "running", "waiting", "failed", "stopped", "interrupted", "pending", "skipped"]);

export const runCardSchema = z.object({
  runId: z.string(),
  flow: z.string().nullable(),
  /** The input value that tells this run from the others. */
  label: z.string().nullable(),
  status,
  tone,
  /** "需要你处理", "完成 · 用时 3 分 02 秒" -- fixed text, nothing that ticks. */
  kicker: z.string(),
  title: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  lastEventAt: z.string().nullable(),
  costUsd: z.number().nullable(),
  /** Why the figure is a lower bound; null when it is the whole cost. */
  costNote: z.string().nullable(),
  strip: z.array(z.object({ title: z.string(), state: stripState })).nullable(),
  /** The gate waiting for a person, if one is. */
  gate: z
    .object({
      callId: z.string(),
      title: z.string(),
      since: z.string().nullable(),
      timeout: z.string().nullable(),
      carrierAgentId: z.string().nullable(),
    })
    .nullable(),
  /** For a lost run: whether its process is known to be gone, and whether agents it started were still open. */
  lost: z.object({ pid: z.number().nullable(), procGone: z.boolean(), agents: z.boolean().optional() }).nullable(),
  /** The node the run view selects first when opened from the card. */
  focus: z.string(),
  /** Started with --host: its agents live on another daemon. */
  remote: z.boolean(),
  /** When the daemon worked this out. */
  evaluatedAt: z.string(),
});
export type RunCard = z.output<typeof runCardSchema>;

/** The timeline item id: one card per run, so appending again replaces it. */
export function cardItemId(runId: string): string {
  return `run:${runId}`;
}

export function isFinished(status: RunStatus): boolean {
  return status !== "running" && status !== "starting" && status !== "lost";
}

/** Nothing more will happen: finished, or lost with its process known to be gone. */
export function isOver(card: Pick<RunCard, "status" | "lost">): boolean {
  return isFinished(card.status) || (card.status === "lost" && card.lost?.procGone === true);
}

/** Null until run.start has been read. */
export function cardOf(
  runId: string,
  run: RunState,
  status: RunStatus,
  now: number,
  { proc = null }: { proc?: ProcessCheck | null } = {},
): RunCard | null {
  const start = run.start;
  if (!start) return null;
  // No staleMs: "quiet for 20 minutes" would change the card on every look with nothing happening.
  const top = hero(run, status, now, { proc, staleMs: null });
  const end = run.end;
  let costUsd: number | null;
  let costNote: string | null;
  if (end) {
    costUsd = end.cost?.totalUsd ?? null;
    costNote = end.cost?.partial || null;
  } else if ([...run.calls.values()].some((call) => call.type === "ask")) {
    const soFar = costSoFar(run);
    costUsd = soFar.usd;
    costNote = soFar.uncounted > 0 ? `已结束调用的合计；${soFar.uncounted} 个调用未计入` : "已结束调用的合计";
  } else {
    // Only script steps so far: nothing has cost anything, and "$0" would read as a figure.
    costUsd = null;
    costNote = null;
  }
  const live = status === "running" || status === "starting";
  const gateCall = live ? openCalls(run).find((call) => call.type === "gate") : undefined;
  return {
    runId,
    flow: start.flow.name,
    label: inputLabel(start),
    status,
    tone: top.tone,
    kicker: top.kicker,
    title: top.title,
    startedAt: run.startedAt,
    endedAt: end?.at ?? null,
    durationMs: end?.durationMs ?? null,
    lastEventAt: run.lastEventAt,
    costUsd,
    costNote,
    strip: run.phaseOrder.length > 0 ? phaseStrip(run, status) : null,
    gate: gateCall
      ? {
          callId: gateCall.callId,
          title: callTitle(run, gateCall),
          since: gateCall.startedAt,
          timeout: gateCall.gate?.timeout ?? null,
          carrierAgentId: gateCall.agentId,
        }
      : null,
    lost: status === "lost" ? { pid: proc?.pid ?? null, procGone: processGone(proc), agents: openCalls(run).some((call) => call.agentId) } : null,
    focus: top.select,
    remote: start.host != null,
    evaluatedAt: new Date(now).toISOString(),
  };
}

/** What the card says, without when it was worked out: equal means appending would change nothing. */
export function cardKey(card: RunCard): string {
  const { evaluatedAt: _, ...rest } = card;
  return JSON.stringify(rest);
}

/**
 * Changes a person should see at once rather than after the usual spacing: a gate opening or
 * closing, the run ending, the run going quiet for good.
 */
export function urgentChange(before: RunCard | null, after: RunCard): boolean {
  if (!before) return true;
  if ((before.gate?.callId ?? null) !== (after.gate?.callId ?? null)) return true;
  return before.status !== after.status && (isFinished(after.status) || after.status === "lost");
}
