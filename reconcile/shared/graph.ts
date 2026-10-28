// What the page of one item (the flow chart) and the list of items are made of: the types the
// server fills (server/graph.ts) and the screen draws (client/), the stage metadata a rule
// declares, and the few pure functions both sides need (the layout of the chart, durations).
// Here and not in server/ because the client reads it: the plugin compiler keeps every server/
// module, type-only imports included, out of the client bundle.

import type { Annotation } from "./model";

export type Ball = "me" | "them" | "system" | "nobody";
export type StatusTone = "neutral" | "accent" | "success" | "warning" | "danger";

/**
 * What an item is doing now, in one word: the colour of the page's top bar and its first
 * sentence. The colour says whose ball it is: you = warning, the system = accent, someone else =
 * neutral, broken = danger, over = success. "Stale data" and "you said not to ask until..." are not
 * here: they are marks laid over one of these, since the item is in one of these anyway.
 */
export type Situation = "me" | "them" | "system" | "doing" | "stuck" | "error" | "mine" | "dropped" | "fail" | "lost" | "slow" | "notstarted" | "unchecked" | "done";

export const SITUATION: Record<Situation, { tone: StatusTone; icon: string; name: string }> = {
  me: { tone: "warning", icon: "!", name: "在等你" },
  them: { tone: "neutral", icon: "人", name: "在等别人" },
  system: { tone: "accent", icon: "查", name: "系统在查" },
  doing: { tone: "accent", icon: "做", name: "系统在做" },
  stuck: { tone: "danger", icon: "!", name: "卡住了" },
  error: { tone: "danger", icon: "×", name: "检查出错" },
  mine: { tone: "neutral", icon: "你", name: "你在做" },
  dropped: { tone: "neutral", icon: "–", name: "不再追踪" },
  fail: { tone: "danger", icon: "×", name: "流程失败了" },
  lost: { tone: "warning", icon: "?", name: "流程断了" },
  slow: { tone: "warning", icon: "…", name: "可能卡住了" },
  notstarted: { tone: "warning", icon: "?", name: "流程没起来" },
  unchecked: { tone: "warning", icon: "?", name: "没查成" },
  done: { tone: "success", icon: "✓", name: "结束了" },
};

// ---- stage metadata a rule declares ---------------------------------------------------------

/** What a rule may write for one stage in its `stages`: a bare id (as v1 rules do), or this. */
export interface StageSpec {
  id: string;
  /** What people read; the id when absent. */
  label?: string;
  /** Where it usually goes next; absent: the next stage of the usual route. */
  next?: string[];
  /** A detour: a step some items take besides the usual route; it is not on it. */
  side?: boolean;
  /** For a detour, when an item takes it ("没赶上封版"). */
  when?: string;
  /** An end: nothing comes after. */
  end?: boolean;
  /** For an end: finished as meant, stopped following, or something else. Absent on an end: finished. */
  endKind?: "done" | "dropped" | "other";
  /** The sign that an item is through this stage ("到下一步的标志"). */
  done?: string;
}

export interface StageMeta {
  id: string;
  /** What people read. A stage the rule gave no name has a neutral one ("第 3 步"); its id is for the evidence layer only. */
  label: string;
  /** The rule named it. */
  named: boolean;
  next: string[];
  side: boolean;
  when: string | null;
  end: boolean;
  endKind: "done" | "dropped" | "other" | null;
  done: string | null;
}

/**
 * The stages as a rule declared them, filled in: a bare id is a stage with that name, not a detour,
 * not an end; a stage with no `next` goes on to the next one of the usual route (an end to none).
 * Throws what is wrong with the declaration, for the rule's loader to report.
 */
export function normalizeStages(raw: ReadonlyArray<string | StageSpec>): StageMeta[] {
  const specs: StageSpec[] = raw.map((s) => (typeof s === "string" ? { id: s } : s));
  const ids = specs.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`stage "${dup}" is declared twice`);
  for (const s of specs) {
    for (const n of s.next ?? []) if (!ids.includes(n)) throw new Error(`stage "${s.id}": next "${n}" is not a declared stage`);
    if (s.endKind && !s.end) throw new Error(`stage "${s.id}": endKind needs end: true`);
    if (s.when && !s.side) throw new Error(`stage "${s.id}": when is for a detour (side: true)`);
    if (s.side && s.end) throw new Error(`stage "${s.id}": a detour is not an end`);
  }
  const metas: StageMeta[] = specs.map((s) => ({
    id: s.id,
    label: s.label ?? s.id,
    named: s.label !== undefined,
    next: s.next ?? [],
    side: s.side === true,
    when: s.when ?? null,
    end: s.end === true,
    endKind: s.end ? (s.endKind ?? "done") : null,
    done: s.done ?? null,
  }));
  const route = routeOf(metas);
  // A stage with no name is not shown by its id: that is a word of whoever wrote the rule.
  let detours = 0;
  for (const m of metas) {
    if (m.named) continue;
    // "dropped" is the id the engine itself gives to the end of not following an item.
    m.label = m.end || m.id === "dropped" ? (m.endKind === "other" ? "另一种结束" : m.endKind === "dropped" || m.id === "dropped" ? "不再追踪" : "结束") : m.side ? `岔路 ${++detours}` : `第 ${route.indexOf(m.id) + 1} 步`;
  }
  metas.forEach((m, i) => {
    if (specs[i]!.next !== undefined || m.end) return;
    // A detour goes back to the route at the first route stage declared after it.
    const after = m.side ? route.find((r) => ids.indexOf(r) > i) : route[route.indexOf(m.id) + 1];
    if (after) m.next = [after];
  });
  return metas;
}

/** The usual route: the stages in the order declared, without detours and without ends that are not finishing. */
export function routeOf(metas: readonly StageMeta[]): string[] {
  return metas.filter((m) => !m.side && (!m.end || m.endKind === "done")).map((m) => m.id);
}

// ---- one item's page ------------------------------------------------------------------------

export type Cause = "data" | "rules-changed" | "said" | "correction";

/** One stay in a stage. A stage entered again later is another visit (round 2). */
export interface Visit {
  id: string;
  stage: string;
  round: number;
  cur: boolean;
  /**
   * Before tracking began: a stage the route had passed already when tracking began (no record of
   * it, `inferred`), or the first one, which began earlier or at an unknown time. The times of
   * such a visit are inferred, and the screen says so.
   */
  before: boolean;
  inferred: boolean;
  /** Judged so, then judged again by changed rules: not a step the item took, not drawn. */
  superseded: boolean;
  /** When it got in: the time the rule gave from its evidence if it did, else the reconcile that saw it. */
  from: string | null;
  /** The reconcile that first saw the item in this stage; null for a stage no reconcile saw. */
  observedAt: string | null;
  fromKind: "happened" | "observed" | "unknown";
  to: string | null;
  durationMs: number | null;
  /** What came in: why this stage came after the one before. Null for the first. */
  cause: Cause | null;
  headline: string;
  lastHeadline: string;
  /** Who had the ball, as the controller judged it: one entry per change in this stay. */
  /**
   * Whose move it was, in turn. `from`: when it became theirs (the rule's evidence if it gave it,
   * else the judgment that saw it, `seen`). `cause` "rules-changed": it became theirs because the
   * rules changed, not the data; with no evidence of when, the wait is counted from the change.
   */
  balls: Array<{ actor: Ball; what: string; from: string; to: string | null; seen?: string; cause?: "rules-changed" | null }>;
  /** Hand-offs between people inside this stay (a planner, then QA): not read from anywhere yet, always empty. */
  handoffs: Array<{ actor: Ball; who: string | null; what: string; from: string; to: string | null }>;
  /** Facts recorded during this stay, with where they came from. */
  evidence: Array<{ field: string; value: string; evidence: string | null; at: string }>;
  /** Stages of the usual route this one came to without stopping in them, and why. */
  skipped: Array<{ stage: string; why: string }>;
}

/** A step the item took off what was declared: a skip, a way back, or somewhere not declared as next. */
export interface Deviation {
  from: string;
  to: string;
  at: string;
  kind: "skip" | "back" | "off-graph";
  cause: Cause;
  why: string | null;
}

export interface AskView {
  commitmentId: string;
  round: number;
  header: string;
  question: string;
  brief: string;
  options: Array<{ id: string; label: string; description: string }>;
  allowOther: boolean;
  /** A question about whether words were the person's own: answered on its card only, never here. */
  confirm: boolean;
  askedAt: string | null;
  nextAskAt: string | null;
  nextAskWhat: "nag" | "backstop" | "exhausted" | null;
  maxRounds: number;
  /** The agent showing the card that asks it, if one is up. */
  cardAgentId: string | null;
}

export interface Mark {
  kind: "stale" | "held" | "weak" | "wrong" | "notice" | "unread" | "flow";
  line: string;
  since: string | null;
  until: string | null;
}

export interface HistoryLine {
  at: string;
  kind: "stage" | "ask" | "answer" | "said" | "rules" | "error" | "run" | "note";
  line: string;
  detail: string | null;
  beforeTracking: boolean;
}

export interface LinkView {
  /** The item at the other end, when it is one the controller follows. */
  caseId: string | null;
  number: string;
  kind: "parent" | "child" | "requires" | "provides" | "same-key";
  label: string;
  /** What the other is doing now; null for one not followed. */
  state: { situation: Situation; stageLabel: string; line: string } | null;
}

/** This plugin's own screen: where a flow's `affair` link points back to, and how a run is found to belong to an item (server/runs.ts). */
export const HOME_SCREEN = { plugin: "reconcile", screen: "inbox" } as const;

/** The orchestration plugin's page of one run: where a run's link goes. */
export const RUN_SCREEN = { plugin: "orchestration-ui", screen: "runs" } as const;

/** One run of a flow started for the item, read from the runtime's event files (server/runs.ts). */
export interface RunView {
  runId: string;
  stage: string | null;
  flow: string;
  startedAt: string;
  /** When it ended; null while it has not. */
  endedAt: string | null;
  /**
   * How alive it is: the runtime's own reading (readRunState), mapped. "unreadable": a line of its record was too
   * long to read and nothing said what it was, so whether it went on, is stuck or is over is not known.
   */
  situation: "doing" | "me" | "fail" | "lost" | "slow" | "done" | "refused" | "unreadable" | "notstarted" | "unchecked";
  /** Lines of its record too long to read whose head did not say what they were (0 for a record read whole). */
  unreadLines: number;
  outcome: string | null;
  step: { index: number; total: number | null; title: string } | null;
  steps: Array<"ok" | "run" | "wait" | "bad" | "slow" | "lost" | "skip" | "todo">;
  costUsd: number;
  /** How long it has been quiet, and the limit it is judged by. */
  quiet: { ms: number; limitMs: number } | null;
  /** `kind`: what carries the approval (a provider without a model, or a model); `agentId`: the agent that holds the card, if the run said. */
  gate: { callId: string; summary: string; since: string; kind: "provider" | "model" | null; agentId: string | null } | null;
  error: { name: string; plain: string; raw: string } | null;
  stopReason: string | null;
  /** Steps that already changed something outside: what a failure or a break left behind. */
  sideEffects: string[];
  /** The agent working on the step now. */
  agentId: string | null;
  link: { plugin: string; screen: string; params: Record<string, string> };
  retry: { round: number; estimateUsd: number | null } | null;
  /**
   * Whether this controller started it (it recorded the intent first): only such a run counts as the item's own
   * condition. Absent: not known (a reader with no controller behind it), read as before.
   */
  own?: boolean;
  /** The request this run is a round of (the case, the rule's name, the flow and the key): runs of one request are rounds of the same ask, runs of two are two asks. */
  request?: string;
  /** For a run of its own: the round (a person's "run it again" adds one). */
  round?: number;
  /** A person set it aside: "mine" (they take it from here) or "fold" (not shown). It no longer counts as the item's condition. */
  dismissed?: "mine" | "fold";
  /** First time a break is seen: a machine asleep reads as one, so it is told as "may be asleep" before it is told as lost. */
  maybeAsleep?: boolean;
  /** Why a run that did not come to a result did not, in a sentence. */
  why?: string | null;
  /** What a person may do with it on the page now (the server decides): run it again, take it over, or fold it away. */
  actions?: Array<"retry" | "mine" | "fold">;
  /** The rule now gives another input for this run than the one it was run with (it is not run again for that). */
  inputDrifted?: boolean;
  /** A run still going that the rule's latest judgment no longer asks for (it is not stopped for that). */
  unwanted?: boolean;
  /** The rule takes this run's failure itself (rules.ts `selfRetry`): a failure is history, not the item's condition, and has no buttons. */
  selfRetry?: boolean;
}

export interface Fact {
  label: string;
  value: string;
  sub: string;
  /** The one that wants you. */
  hot: boolean;
}

export interface GraphView {
  case: string;
  number: string;
  title: string;
  url: string | null;
  /** The time of this reading. */
  now: string;
  mode: "live" | "dry-run";
  /** The first judgment of the item: before it, times are inferred. */
  trackingSince: string | null;
  situation: Situation;
  marks: Mark[];
  hero: { kicker: string; line: string; sub: string };
  facts: Fact[];
  graph: { stages: StageMeta[]; normal: string[] };
  visits: Visit[];
  deviations: Deviation[];
  current: {
    stage: string;
    stageLabel: string;
    since: string | null;
    sinceKind: "happened" | "observed" | "unknown";
    health: string;
    headline: string;
    /** `atLeast`: the wait is counted from where tracking began, so it was at least this long. */
    ball: { actor: Ball; who: string | null; what: string; waitingSince: string | null; atLeast: boolean; rulesAt?: string | null };
    ask: AskView | null;
    asks: AskView[];
  };
  /** What happens next: questions to be asked, when sources are read next, flows. */
  schedule: Array<{ at: string | null; line: string }>;
  poll: { what: string; nextAt: string | null } | null;
  links: LinkView[];
  runs: RunView[];
  said: Array<{ id: string; kind: Annotation["kind"]; label: string; said: string; by: string; at: string; until: string | null; how: "own-words" | "confirmed"; inForce: boolean; revokedAt: string | null }>;
  history: HistoryLine[];
  evidence: {
    facts: Array<{ field: string; value: string; evidence: string | null; at: string; by: string }>;
    sources: Array<{ id: string; state: string; lastOkAt: string | null; nextPollAt: string | null }>;
    /** The stages of the rule by the id it wrote them with: ids are for here, the rest of the page uses the names. */
    stages: Array<{ id: string; label: string; named: boolean }>;
    rule: { name: string; fingerprint: string } | null;
    /** The hand-off data (who held the ball inside a stage) is not read; the screen leaves its place empty. */
    handoffsRead: false;
  };
}

// ---- the list -------------------------------------------------------------------------------

export type Group = "me" | "errors" | "them" | "system" | "mine" | "done";

export const GROUP_LABEL: Record<Group, { name: string; sub: string }> = {
  me: { name: "要你做的", sub: "回答问题、批准、看一眼卡住的" },
  errors: { name: "检查出错的", sub: "不是事项本身的问题，是判断它的时候出错了" },
  them: { name: "在等别人的", sub: "谁、在干什么、等了多久" },
  system: { name: "系统在查的", sub: "不用管，有变化或到点会叫你" },
  mine: { name: "你自己在开发的", sub: "不催你，开发完成后自动接着跟" },
  done: { name: "结束了的", sub: "最近的" },
};

export type StripCell = "done" | "cur" | "todo" | "skip" | "pre";

/** What the list shows of one item: not the whole page, so that the 5-second poll stays small. */
export interface ListRow {
  caseId: string;
  number: string;
  title: string;
  headline: string;
  group: Group;
  situation: Situation;
  stageLabel: string;
  /** One cell per stage of the usual route, in order. */
  strip: StripCell[];
  /** A detour taken, and how far along the route it was taken (after this many cells), or null. */
  side: { after: number; label: string } | null;
  who: { actor: Ball; label: string };
  /**
   * How long it has waited (or, ended, how long it took) and since when. `atLeast`: the clock starts when
   * tracking began, not when the wait did, so the length is a floor; ended with `ms` null and `atLeast`:
   * it was already over when tracking began.
   */
  waiting: { ms: number | null; since: string | null; ended: boolean; atLeast: boolean; rulesAt?: string | null };
  /** The rule's statement that something looks wrong, whatever state the item is in. */
  notice: string | null;
  /** The data it rests on is older than usual. */
  stale: boolean;
  next: string[];
  /** Questions waiting for you: the page can answer them. */
  asking: number;
}

// ---- the layout of the chart ----------------------------------------------------------------

/** What the chart is made of, left to right (a loop holds rows of pieces). */
export type Piece =
  | { k: "stage"; v: Visit }
  | { k: "dip"; v: Visit; when: string | null }
  | { k: "skip"; stage: StageMeta; why: string }
  | { k: "loop"; rounds: Piece[][]; label: string }
  | { k: "end"; v: Visit; stage: StageMeta }
  | { k: "future"; stages: StageMeta[] }
  | { k: "endghost" };

/**
 * Visits to pieces. A detour hangs under the line; a way back to a stage already walked wraps the
 * stretch from that stage on in a loop (one row per round); what the route passed without stopping
 * is a bridge; what has not come yet is one box ("后面还有 N 步", or just the end).
 */
export function layoutOf(visits: readonly Visit[], metas: readonly StageMeta[]): Piece[] {
  const meta = (id: string) => metas.find((m) => m.id === id)!;
  const route = routeOf(metas);
  const pieces: Piece[] = [];
  // `prev`: where the item stood in the stay before (a way back is a stage at or before it); `furthest`: how far it ever got.
  let prev = -1;
  let furthest = -1;
  let loop: Extract<Piece, { k: "loop" }> | null = null;
  let loopMax = -1;
  const push = (p: Piece) => (loop ? loop.rounds[loop.rounds.length - 1]! : pieces).push(p);
  let stopped = false;
  for (const v of visits) {
    if (v.superseded) continue;
    const st = meta(v.stage);
    if (st.side) {
      push({ k: "dip", v, when: st.when });
      continue;
    }
    if (st.end) {
      push({ k: "end", v, stage: st });
      if (st.endKind === "done") {
        prev = route.indexOf(st.id);
        furthest = Math.max(furthest, prev);
      } else stopped = true;
      continue;
    }
    const idx = route.indexOf(st.id);
    if (idx <= prev) {
      if (!loop) {
        const start = pieces.findIndex((p) => p.k === "stage" && p.v.stage === v.stage);
        if (start >= 0) {
          loop = { k: "loop", rounds: [pieces.splice(start)], label: "" };
          loopMax = furthest;
          pieces.push(loop);
        }
      }
      loop?.rounds.push([]);
    } else {
      if (loop && idx > loopMax) loop = null;
      for (const s of v.skipped) push({ k: "skip", stage: meta(s.stage), why: s.why });
    }
    push({ k: "stage", v });
    prev = idx;
    furthest = Math.max(furthest, idx);
  }
  if (loop) loop.label = `打回 ${loop.rounds.length - 1} 次`;
  const finished = stopped || visits.some((v) => !v.superseded && meta(v.stage).end);
  if (!finished) {
    const rest = route.slice(furthest + 1).map(meta);
    if (rest.some((s) => !s.end)) pieces.push({ k: "future", stages: rest });
    else if (rest.length > 0) pieces.push({ k: "endghost" });
  }
  return pieces;
}

/** One cell per stage of the usual route, for the list: walked, here, not yet, or passed without stopping. */
export function stripOf(visits: readonly Visit[], metas: readonly StageMeta[]): { cells: StripCell[]; side: ListRow["side"] } {
  const route = routeOf(metas);
  const real = visits.filter((v) => !v.superseded);
  const cells = route.map<StripCell>((id) => {
    const here = real.filter((v) => v.stage === id);
    if (here.some((v) => v.cur)) return "cur";
    if (here.some((v) => !v.inferred)) return "done";
    if (here.length > 0) return "pre";
    return "todo";
  });
  const lastIdx = Math.max(-1, ...real.filter((v) => route.includes(v.stage)).map((v) => route.indexOf(v.stage)));
  // A stage behind the furthest one that nothing stopped in was passed.
  for (let i = 0; i < lastIdx; i++) if (cells[i] === "todo") cells[i] = "skip";
  const dipAt = real.findIndex((v) => metas.find((m) => m.id === v.stage)?.side);
  let side: ListRow["side"] = null;
  if (dipAt >= 0) {
    const before = real.slice(0, dipAt).reverse().find((v) => route.includes(v.stage));
    side = { after: before ? route.indexOf(before.stage) : 0, label: metas.find((m) => m.id === real[dipAt]!.stage)!.label };
  }
  return { cells, side };
}

// ---- text helpers ---------------------------------------------------------------------------

/** A span in the words the page uses: 6 分钟, 1 小时 10 分, 15 小时, 3 天 18 小时, 13 天. */
export function durationText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 10) return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分`;
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days >= 10 || hours % 24 === 0) return `${days} 天`;
  return `${days} 天 ${hours % 24} 小时`;
}

/** "10-23 15:11" from an ISO instant that carries its own offset (the plugin writes them in the instance's zone). */
export const clockText = (iso: string): string => iso.slice(5, 16).replace("T", " ");

/** What the page calls a run that came to no result (or went quiet), in a word. */
export const troubleWord = (situation: RunView["situation"]): string =>
  situation === "notstarted" ? "没起来" : situation === "unchecked" ? "没查成" : situation === "lost" ? "断了" : situation === "slow" ? "可能卡住了" : "失败了";

/** The line over the way out of a run in trouble: which run, what became of it and why in the flow's own words (no double stop). */
export const troubleLine = (run: Pick<RunView, "flow" | "situation" | "why">): string => {
  const why = run.why?.replace(/[。.]+$/u, "");
  return `流程「${run.flow}」${troubleWord(run.situation)}${why ? `：${why}` : ""}。不会自动重来。`;
};

/** What the button that runs it again says: whether it will cost, and what the last round cost. */
export const retryLabel = (run: Pick<RunView, "situation" | "retry">): string =>
  run.situation === "notstarted" || (run.situation === "unchecked" && !run.retry?.estimateUsd)
    ? "重新跑一次（上次没花钱）"
    : `重新跑一次（会再花钱${run.retry?.estimateUsd ? `，上次花了 $${run.retry.estimateUsd.toFixed(2)}` : ""}）`;

// One pass, so that what an escape protects is read as the character it stands for and not as a mark: `\#` is a
// "#", and the "#" it makes is not the start of a heading. An escape is a backslash before ASCII punctuation (the
// CommonMark rule; requests.ts `clipMd` writes them for words from outside). In order of the alternatives:
// an escape, a link, a heading mark and a quote mark at the start of a line, emphasis and code marks.
const MARKS = /\\([!-/:-@[-`{-~])|\[([^\]]*)\]\([^)]*\)|^#{1,6}\s*|^(?:>[ \t]?)+|\*\*|__|`/gm;
// What is left of a link's own words: the marks inside a line, not the ones that belong to the start of one.
const INLINE_MARKS = /\\([!-/:-@[-`{-~])|\*\*|__|`/g;

/** The text of a Markdown brief without its marks, for places that show plain text. */
export function plainMd(text: string): string {
  return text
    .replace(MARKS, (_mark, escaped?: string, linked?: string) => escaped ?? (linked === undefined ? "" : linked.replace(INLINE_MARKS, (_m, e?: string) => e ?? "")))
    .trim();
}
