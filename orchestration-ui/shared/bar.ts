// The words and the grouping for the two places a run is read in one glance: the one-line card in
// the conversation that started it, and the flow bar beside the conversation. Both draw from the
// same RunCard, so a run says the same thing in both. Pure; nothing here reads a clock but the
// `now` it is handed.

import type { RunCard } from "./card";
import { fixingText } from "./fixes";
import { formatBrief, formatUsd } from "./format";
import type { Tone } from "./graph";
import type { RunSummary } from "./rpc";

export type BarGroup = "waiting" | "running" | "stopped" | "done";

/** The order the bar lists groups in: what needs a person first. */
export const BAR_ORDER: readonly BarGroup[] = ["waiting", "running", "stopped", "done"];

export const BAR_TITLE: Record<BarGroup, string> = { waiting: "等你", running: "在跑", stopped: "停了", done: "完成" };

/** Characters a status sentence may take, not counting the flow's name. */
export const CARD_SENTENCE_MAX = 30;
export const ROW_SENTENCE_MAX = 20;
/** The input that tells a run from its siblings is cut to this many characters in a name. */
export const NAME_LABEL_MAX = 16;

/** A finished run older than this is left to the 流程 page. */
export const DONE_WINDOW_MS = 24 * 60 * 60_000;
/** A run that stopped or failed stays until it is this old, unless something carried it on. */
export const STOPPED_WINDOW_MS = 7 * 24 * 60 * 60_000;

type Grouped = Pick<RunCard, "status" | "gate">;

export function groupOf(card: Grouped): BarGroup {
  if (card.gate) return "waiting";
  if (card.status === "running" || card.status === "starting") return "running";
  if (card.status === "done") return "done";
  return "stopped";
}

/** `max` characters (code points), the last one an ellipsis when something was cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : flat;
}

/** "编译 6/9": the phase a run is in and how many it declares; null when it declares none or has not reached one. */
export function stageOf(card: Pick<RunCard, "strip">): string | null {
  const strip = card.strip;
  if (!strip || strip.length === 0) return null;
  let at = strip.findIndex((segment) => segment.state === "running" || segment.state === "waiting");
  if (at < 0) at = strip.findIndex((segment) => segment.state === "pending");
  if (at < 0) return null;
  return `${clip(strip[at]!.title, 8)} ${at + 1}/${strip.length}`;
}

/** "demo-flow" and "#1234": the flow, and the input that tells this run from the others, cut short. */
export function nameParts(card: Pick<RunCard, "flow" | "label">): { flow: string; label: string | null } {
  return { flow: card.flow ?? "流程", label: card.label === null ? null : clip(card.label, NAME_LABEL_MAX) };
}

export function nameOf(card: Pick<RunCard, "flow" | "label">): string {
  const { flow, label } = nameParts(card);
  return label ? `${flow} ${label}` : flow;
}

function sinceNow(iso: string | null, now: number): string | null {
  const at = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(at) ? formatBrief(now - at) : null;
}

function cost(card: RunCard): string | null {
  return card.costUsd === null ? null : formatUsd(card.costUsd);
}

/** Why a run that is not running is not done, in its own words. */
function trouble(card: RunCard): string {
  if (card.status === "lost") {
    if (!card.lost?.procGone) return "出错了：很久没有新事件，不知道还在不在跑";
    return `出错了：${card.lost.agents ? "进程没了，agent 可能还在花钱" : "进程没了"}`;
  }
  return card.status === "stopped" ? card.title : `出错了：${card.title}`;
}

/** Joins a left part that may be cut and a right part that may not, inside `max`. */
function join(left: string, right: string | null, max: number): string {
  if (right === null) return clip(left, max);
  return `${clip(left, Math.max(2, max - [...right].length - 3))} · ${right}`;
}

/** A run in progress: the answer being sent back, else the phase it is in and for how long. */
function runningSentence(card: RunCard, now: number, max: number): string {
  if (card.fixing) return join(card.fixing.title, fixingText(card.fixing), max);
  return clip([stageOf(card) ?? "运行中", sinceNow(card.startedAt, now)].filter(Boolean).join(" · "), max);
}

/** The sentence after the flow's name on the conversation's card. */
export function cardSentence(card: RunCard, now: number): string {
  switch (groupOf(card)) {
    case "waiting":
      return clip(`等你批准：${clip(card.gate!.title, 12)}`, CARD_SENTENCE_MAX);
    case "running":
      return runningSentence(card, now, CARD_SENTENCE_MAX);
    case "done":
      return join(card.title, cost(card), CARD_SENTENCE_MAX);
    case "stopped":
      return clip(card.status === "stopped" ? `停了：${card.title}` : trouble(card), CARD_SENTENCE_MAX);
  }
}

/** The sentence under the flow's name in a bar row; the group heading has already said waiting, stopped or done. */
export function rowSentence(card: RunCard, now: number): string {
  switch (groupOf(card)) {
    case "waiting": {
      const waited = sinceNow(card.gate!.since, now);
      return join(card.gate!.title, waited === null ? null : `等了 ${waited}`, ROW_SENTENCE_MAX);
    }
    case "running":
      return runningSentence(card, now, ROW_SENTENCE_MAX);
    case "done":
      return join(card.title, cost(card), ROW_SENTENCE_MAX);
    case "stopped":
      return clip(trouble(card), ROW_SENTENCE_MAX);
  }
}

/** The icon and color in front of a line. */
export function markOf(card: RunCard): { icon: string; tone: Tone } {
  if (card.gate) return { icon: "ShieldCheck", tone: "warning" };
  switch (card.status) {
    case "done":
      return { icon: "CircleCheck", tone: "success" };
    case "stopped":
      return { icon: "CircleStop", tone: "warning" };
    case "failed":
    case "timeout":
      return { icon: "CircleX", tone: "danger" };
    case "lost":
      return { icon: "Unplug", tone: "danger" };
    default:
      return { icon: "Loader", tone: "accent" };
  }
}

/** The one word for where a run is, for the head of an opened run: what the group says, but an error is an error. */
export function stateWord(card: RunCard): string {
  const group = groupOf(card);
  return group === "stopped" && card.status !== "stopped" ? "出错了" : BAR_TITLE[group];
}

/**
 * The one button on the conversation's card, and the node it opens the run at. A run that finished
 * has none: there is nothing to do, and the line itself still opens it.
 */
export function cardButton(card: RunCard): { label: string; select: string } | null {
  switch (groupOf(card)) {
    case "waiting":
      return { label: "去批准", select: card.gate!.callId };
    case "stopped":
      return { label: "看原因", select: card.focus };
    case "running":
      return { label: "在旁边看", select: card.focus };
    case "done":
      return null;
  }
}

export type RowAction = { kind: "approve"; agentId: string } | { kind: "affair" } | null;

/** The one button on a bar row: approve what waits, or go to the affair that has to act on a stop. */
export function rowAction(card: RunCard, affairLink: boolean): RowAction {
  const group = groupOf(card);
  if (group === "waiting") return card.gate!.carrierAgentId ? { kind: "approve", agentId: card.gate!.carrierAgentId } : null;
  return group === "stopped" && affairLink ? { kind: "affair" } : null;
}

// ---- which runs, in which groups ---------------------------------------------------------

export interface BarRun {
  run: RunSummary;
  card: RunCard;
  group: BarGroup;
}

/** Whether a run belongs to a workspace: the runtime put its agents there, or the agent that started it lives there. */
export function inWorkspace(
  run: Pick<RunSummary, "workspaceIds" | "caller">,
  workspaceId: string,
  callersInside: ReadonlySet<string>,
): boolean {
  return run.workspaceIds.includes(workspaceId) || (run.caller !== null && callersInside.has(run.caller));
}

/** The runs some later run carries on. Looked up over every run, not just one workspace's. */
export function supersededRuns(all: readonly Pick<RunSummary, "resumeOf">[]): Set<string> {
  return new Set(all.flatMap((run) => (run.resumeOf ? [run.resumeOf] : [])));
}

/**
 * The rows the bar shows for a workspace's runs: newest first, a stopped run only until something
 * carried it on or a week has passed, a finished one for a day.
 */
export function barRows(mine: readonly RunSummary[], superseded: ReadonlySet<string>, now: number): BarRun[] {
  const rows: BarRun[] = [];
  for (const run of mine) {
    const card = run.card;
    if (!card || superseded.has(run.runId)) continue;
    const group = groupOf(card);
    const lastAt = Date.parse(card.endedAt ?? card.lastEventAt ?? card.startedAt ?? "");
    const age = Number.isFinite(lastAt) ? now - lastAt : 0;
    if (group === "done" && age > DONE_WINDOW_MS) continue;
    if (group === "stopped" && age > STOPPED_WINDOW_MS) continue;
    rows.push({ run, card, group });
  }
  const startedAt = (row: BarRun) => Date.parse(row.card.startedAt ?? "") || 0;
  return rows.sort((a, b) => startedAt(b) - startedAt(a));
}

export interface BarGroupRows {
  group: BarGroup;
  title: string;
  rows: BarRun[];
}

/** The groups in the bar's order; a group with nothing in it is not there. */
export function barGroups(rows: readonly BarRun[]): BarGroupRows[] {
  return BAR_ORDER.map((group) => ({ group, title: BAR_TITLE[group], rows: rows.filter((row) => row.group === group) })).filter(
    (entry) => entry.rows.length > 0,
  );
}

/** The affair the newest of these runs belongs to: its words, and whether its own page is inside Paseo. */
export function barAffair(rows: readonly BarRun[]): { label: string; link: RunSummary["affairLink"] } | null {
  const row = rows.find((entry) => entry.run.affairLabel !== null);
  return row ? { label: row.run.affairLabel!, link: row.run.affairLink } : null;
}
