import type { Annotation, Assessment, Commitment, Item } from "../shared/model";
import {
  clockText,
  durationText,
  normalizeStages,
  plainMd,
  routeOf,
  stripOf,
  SITUATION,
  type AskView,
  type Ball,
  type Deviation,
  type GraphView,
  type Group,
  type HistoryLine,
  type LinkView,
  type ListRow,
  type Mark,
  type RunView,
  type Situation,
  type StageMeta,
  type Visit,
} from "../shared/graph";
import type { Config } from "./config";
import { createJournalBook, type Chain, type Fmt, type JournalBook } from "./journal-book";
import type { nextStep } from "./policy";
import { clip, KIND_LABEL } from "./requests";
import type { RuleSet } from "./rules";
import type { Store } from "./store";
import { iso, zoned } from "./time";

// The page of one item and the list's rows, worked out from the state, the journal (journal-book.ts)
// and the rule's declaration of its stages. Read-only: nothing here writes the journal or asks a
// person anything. The engine hands it the few things only it knows (what the rules read, when a
// question is next asked with the holds on it, what a person said that is in force).

export interface GraphDeps {
  store: Store;
  config: Config;
  now(): number;
  mode: "live" | "dry-run";
  rules(): RuleSet | null;
  /** The item keys and source ids the last judgment of an item rested on. */
  reads(caseId: string): ReadonlySet<string> | undefined;
  /** When a commitment next wants something, with the holds on it applied. */
  step(c: Commitment): ReturnType<typeof nextStep>;
  /** What people said about the item that is in force now. */
  inForce(caseId: string): Annotation[];
  /** The runs of flows started for an item; absent until the engine starts any. */
  runs?(caseId: string): RunView[];
}

const FALLBACK_DROPPED: StageMeta = { id: "dropped", label: "不再追踪", next: [], side: false, when: null, end: true, endKind: "dropped", done: null };

export function createGraph(deps: GraphDeps) {
  const { store, config } = deps;
  const state = store.state;
  const tz = config.policy.tz;
  const book: JournalBook = createJournalBook(
    store.dir,
    new Set(config.sources.filter((s) => s.kind === "flags").map((s) => s.id)),
  );
  const personName = (id: string) => config.persons[id]?.name ?? id;
  const fmtOf = (metas: StageMeta[]): Fmt => ({ stage: (id) => metaOf(metas, id).label, person: personName });
  const stamp = (ms: number) => iso(ms, tz);
  const numberOf = (caseId: string) => `#${caseId.slice(caseId.lastIndexOf(":") + 1)}`;
  const shortTitle = (title: string) => title.replace(/^(【[^】]*】\s*)+/, "").trim() || title;
  const isOpen = (c: Commitment | undefined): c is Commitment => !!c && (c.status === "scheduled" || c.status === "waiting");

  const metaCache = new WeakMap<object, StageMeta[]>();
  function metasFor(item: Item | undefined): StageMeta[] {
    const rule = item ? deps.rules()?.rules.find((r) => r.source === item.source) : undefined;
    let metas: StageMeta[];
    if (!rule) metas = [];
    else {
      let cached = metaCache.get(rule);
      if (!cached) metaCache.set(rule, (cached = rule.stageMeta ?? normalizeStages(rule.stages)));
      metas = cached;
    }
    return metas.some((m) => m.id === "dropped") ? metas : [...metas, FALLBACK_DROPPED];
  }
  /** A stage the rule no longer declares (an older judgment names it) shows as a detour under its own name. */
  function metaOf(metas: readonly StageMeta[], id: string): StageMeta {
    return metas.find((m) => m.id === id) ?? { id, label: id, next: [], side: true, when: "规则里已经没有这一步", end: false, endKind: null, done: null };
  }
  const withUnknown = (metas: StageMeta[], ids: string[]): StageMeta[] => [...metas, ...[...new Set(ids)].filter((id) => !metas.some((m) => m.id === id)).map((id) => metaOf(metas, id))];

  // ---- the stays ------------------------------------------------------------------------------

  interface Walk {
    visits: Visit[];
    deviations: Deviation[];
    trackingSince: string | null;
    metas: StageMeta[];
  }

  function walkOf(caseId: string, nowMs: number): Walk {
    const item = state.items[caseId];
    const chain = book.chain(caseId);
    const declared = metasFor(item);
    const metas = withUnknown(declared, chain?.visits.map((v) => v.stage) ?? []);
    const route = routeOf(metas);
    const trackingSince = chain?.first?.at ?? null;
    const raws = chain?.visits ?? [];
    const out: Visit[] = [];
    const rounds = new Map<string, number>();
    raws.forEach((raw, i) => {
      const happened = raw.happened;
      const from = happened ?? raw.observed;
      const next = raws[i + 1];
      const to = next ? (next.happened ?? next.observed) : null;
      const meta = metaOf(metas, raw.stage);
      const cur = i === raws.length - 1 && !meta.end;
      const round = raw.superseded ? 0 : (rounds.get(raw.stage) ?? 0) + 1;
      if (!raw.superseded) rounds.set(raw.stage, round);
      const spanEnd = to ? Date.parse(to) : cur ? nowMs : null;
      const before = i === 0 && !(happened && Date.parse(raw.observed) - Date.parse(happened) < 60_000);
      const stageEnd = (end: string) => chain?.notes.filter((n) => n.at >= from && n.at < end).map((n) => ({ field: n.field, value: n.value, evidence: n.evidence, at: n.at })) ?? [];
      out.push({
        id: `v${i}`,
        stage: raw.stage,
        round: round || 1,
        cur,
        before,
        inferred: false,
        superseded: raw.superseded,
        from,
        observedAt: raw.observed,
        fromKind: happened ? "happened" : "observed",
        to,
        durationMs: spanEnd === null ? null : Math.max(0, spanEnd - Date.parse(from)),
        cause: raw.cause,
        headline: raw.headline,
        lastHeadline: raw.lastHeadline,
        balls: raw.balls.map((b, j) => ({ actor: b.actor, what: b.what, from: b.from, to: raw.balls[j + 1]?.from ?? (to ?? null) })),
        handoffs: [],
        evidence: stageEnd(to ?? "9999"),
        skipped: [],
      });
    });
    // Stages of the route before the first one seen: passed before tracking began, no record of them.
    const firstReal = out.find((v) => !v.superseded);
    const deviations: Deviation[] = [];
    if (firstReal && route.includes(firstReal.stage)) {
      const pre = route.slice(0, route.indexOf(firstReal.stage)).filter((id) => !metaOf(metas, id).end);
      out.unshift(
        ...pre.map<Visit>((id, k) => ({
          id: `pre${k}`, stage: id, round: 1, cur: false, before: true, inferred: true, superseded: false, from: null, observedAt: null, fromKind: "unknown", to: null, durationMs: null, cause: null,
          headline: "开始追踪时已经过了这一步，没有记录", lastHeadline: "", balls: [], handoffs: [], evidence: [], skipped: [],
        })),
      );
    }
    // Skips, ways back, and detours: a step to a stage that is not among the usual next ones of the one before.
    let reached = -1;
    let prev: Visit | null = null;
    const seen = new Set<string>();
    for (const v of out) {
      if (v.superseded) continue;
      const meta = metaOf(metas, v.stage);
      const idx = route.indexOf(v.stage);
      if (prev && !metaOf(metas, prev.stage).next.includes(v.stage)) {
        const at = v.from ?? v.to ?? "";
        const observed = raws[Number(v.id.slice(1))]?.observed ?? at;
        if (meta.side || meta.end) {
          if (meta.side) deviations.push({ from: prev.stage, to: v.stage, at, kind: "off-graph", cause: v.cause ?? "data", why: meta.when });
        } else if (idx > reached + 1 && idx > route.indexOf(prev.stage)) {
          const passed = route.slice(reached + 1, idx).filter((id) => !seen.has(id));
          const earlier = v.fromKind === "happened" && Date.parse(observed) - Date.parse(at) > 5 * 60_000;
          const why = earlier ? `它在 ${clockText(at)} 就到了后面，${clockText(observed)} 才检查到` : "检查到它的时候已经在后面了";
          v.skipped = passed.map((id) => ({ stage: id, why }));
          if (passed.length > 0) deviations.push({ from: prev.stage, to: v.stage, at, kind: "skip", cause: v.cause ?? "data", why });
        } else if (idx >= 0 && idx <= reached) {
          deviations.push({ from: prev.stage, to: v.stage, at, kind: "back", cause: v.cause ?? "data", why: null });
        }
      }
      seen.add(v.stage);
      if (!meta.side && idx >= 0) reached = Math.max(reached, idx);
      prev = v;
    }
    return { visits: out, deviations, trackingSince, metas };
  }

  /**
   * When the one holding the ball now got it: the start of the latest run of the same holder in this
   * stay, so that a change of what it is doing (the holder the same) does not start the wait again.
   */
  function heldSince(v: Visit | undefined): string | null {
    if (!v) return null;
    const holder = v.balls[v.balls.length - 1]?.actor;
    let from: string | null = null;
    for (let i = v.balls.length - 1; i >= 0 && v.balls[i]!.actor === holder; i--) from = v.balls[i]!.from;
    return from ?? v.from;
  }

  // ---- situation ------------------------------------------------------------------------------

  interface Facts {
    caseId: string;
    item: Item | undefined;
    a: Assessment | undefined;
    metas: StageMeta[];
    waiting: Commitment[];
    open: Commitment[];
    said: Annotation[];
    runs: RunView[];
  }

  function factsOf(caseId: string, metas?: StageMeta[]): Facts {
    const item = state.items[caseId];
    const commitments = Object.values(state.commitments).filter((c) => c.caseId === caseId && isOpen(c));
    return {
      caseId,
      item,
      a: state.assessments[caseId],
      metas: metas ?? metasFor(item),
      waiting: commitments.filter((c) => c.status === "waiting").sort((x, y) => (x.lastAskedAt ?? "").localeCompare(y.lastAskedAt ?? "")),
      open: commitments,
      said: deps.inForce(caseId),
      runs: deps.runs?.(caseId) ?? [],
    };
  }

  const RUN_RANK: Array<RunView["situation"]> = ["me", "fail", "lost", "slow", "doing"];

  function situationOf(f: Facts): Situation {
    const { a } = f;
    if (f.said.some((s) => s.kind === "drop")) return "dropped";
    const meta = a ? f.metas.find((m) => m.id === a.stage) : undefined;
    if (meta?.end && meta.endKind !== "done") return "dropped";
    if (a && a.health === "done" && !a.error) return "done";
    if (a?.error) return "error";
    for (const s of RUN_RANK) if (f.runs.some((r) => r.situation === s)) return s as Situation;
    if (f.waiting.length > 0) return "me";
    if (a && (a.health === "blocked" || a.health === "stalled")) return "stuck";
    if (!a) return "system";
    return a.next.actor === "me" ? "mine" : a.next.actor === "them" ? "them" : "system";
  }

  const GROUP: Record<Situation, Group> = { me: "me", fail: "me", lost: "me", slow: "me", stuck: "me", error: "errors", them: "them", system: "system", doing: "system", mine: "mine", dropped: "done", done: "done" };

  /** The other end of a link, in one line. */
  function peek(caseId: string): LinkView["state"] {
    const f = factsOf(caseId);
    if (!f.a) return null;
    return { situation: situationOf(f), stageLabel: metaOf(f.metas, f.a.stage).label, line: clip(f.a.headline, 80) };
  }

  // ---- the lines of the page ------------------------------------------------------------------

  function askOf(c: Commitment): AskView {
    const step = deps.step(c);
    const hold = deps.inForce(c.caseId ?? "").find((s) => s.kind === "hold" && s.until && (!s.person || s.person === c.ask.person));
    const holdMs = hold?.until ? zoned(hold.until, "00:00", tz) : 0;
    const next = step && step.what !== "ask" ? step : null;
    const card = Object.values(state.cards).find((k) => (k.status === "pending" || k.status === "raised") && k.commitments.some((x) => x.id === c.id));
    return {
      commitmentId: c.id,
      round: c.rounds,
      header: c.ask.header,
      question: c.ask.question,
      brief: plainMd(c.brief),
      options: c.ask.options,
      allowOther: c.ask.allowOther,
      askedAt: c.lastAskedAt,
      nextAskAt: next ? stamp(next.what === "nag" ? Math.max(next.atMs, holdMs) : next.atMs) : null,
      nextAskWhat: next && next.what !== "ask" ? next.what : null,
      maxRounds: c.nag.max,
      cardAgentId: card?.agentId ?? null,
    };
  }

  /** The sources an item's judgment rests on, by id. */
  function sourcesOf(caseId: string): string[] {
    const reads = deps.reads(caseId);
    const ids = config.sources.map((s) => s.id);
    const out = new Set<string>();
    for (const key of reads ?? []) {
      const id = ids.find((s) => key === s || key.startsWith(`${s}:`));
      if (id) out.add(id);
    }
    const item = state.items[caseId];
    if (item) out.add(item.source);
    return [...out];
  }

  function pollOf(caseId: string): GraphView["poll"] {
    const ids = sourcesOf(caseId);
    const at = ids.map((id) => state.sources[id]?.health.nextPollAt ?? 0).filter((t) => t > 0);
    if (ids.length === 0) return null;
    return { what: `读 ${ids.join("、")}`, nextAt: at.length > 0 ? stamp(Math.min(...at)) : null };
  }

  function scheduleOf(f: Facts, nowMs: number, finished: boolean): GraphView["schedule"] {
    if (finished) return [{ at: null, line: "结束了，不再检查" }];
    const lines: Array<{ ms: number; at: string | null; line: string }> = [];
    for (const c of f.open) {
      if (c.status === "waiting") lines.push({ ms: -1, at: null, line: `现在：等你回答「${c.title}」` });
      const step = deps.step(c);
      if (!step) continue;
      const hold = f.said.find((s) => s.kind === "hold" && s.until && (!s.person || s.person === c.ask.person));
      const held = hold?.until ? zoned(hold.until, "00:00", tz) : 0;
      if (step.what === "ask") lines.push({ ms: Math.max(step.atMs, held), at: stamp(Math.max(step.atMs, held)), line: `问你：${c.title}${held > step.atMs ? "（你说过先别问）" : ""}` });
      else if (step.what === "nag") lines.push({ ms: Math.max(step.atMs, held), at: stamp(Math.max(step.atMs, held)), line: `没答就再问（第 ${step.round} 次，最多 ${c.nag.max} 次）` });
      else lines.push({ ms: step.atMs, at: stamp(step.atMs), line: "还没答就不再问，记成「问了没人答」" });
    }
    const poll = pollOf(f.caseId);
    if (poll?.nextAt) lines.push({ ms: Date.parse(poll.nextAt), at: poll.nextAt, line: poll.what });
    lines.sort((x, y) => x.ms - y.ms);
    return lines.map(({ at, line }) => ({ at, line }));
  }

  // ---- the page -------------------------------------------------------------------------------

  const ballWho = (actor: Ball): string => (actor === "me" ? "你" : actor === "them" ? "别人" : actor === "system" ? "系统" : "没有");

  function viewOf(caseId: string): GraphView | null {
    const item = state.items[caseId];
    if (!item) return null;
    book.refresh();
    const nowMs = deps.now();
    const walk = walkOf(caseId, nowMs);
    const f = factsOf(caseId, walk.metas);
    const { a, metas } = f;
    const route = routeOf(metas);
    const situation = situationOf(f);
    const fmt = fmtOf(metas);
    const chain = book.chain(caseId);
    const real = walk.visits.filter((v) => !v.superseded && !v.inferred);
    const last = real[real.length - 1];
    const stage = a?.stage ?? last?.stage ?? "";
    const stageMeta = metaOf(metas, stage);
    const finished = situation === "done" || situation === "dropped";
    const ask = f.waiting[0] ? askOf(f.waiting[0]) : null;
    const asks = f.waiting.map(askOf);
    const actor: Ball = ask ? "me" : (a?.next.actor ?? "nobody");
    const what = ask ? `回答：${ask.header}` : (a?.next.what ?? "");
    const waitingSince = ask?.askedAt ?? heldSince(last);
    const poll = finished ? null : pollOf(caseId);
    const schedule = scheduleOf(f, nowMs, finished);
    const nextAsk = schedule.find((s) => s.line.startsWith("问你") || s.line.startsWith("没答就再问"));
    const drop = f.said.find((s) => s.kind === "drop");
    const hold = f.said.find((s) => s.kind === "hold");

    const marks: Mark[] = [];
    if (a?.stale) {
      const bad = sourcesOf(caseId).filter((id) => (state.sources[id]?.health.state ?? "never") !== "ok");
      const h = bad[0] ? state.sources[bad[0]]?.health : null;
      marks.push({
        kind: "stale",
        line: bad.length > 0 ? `${bad.join("、")} ${h?.lastOkAt ? `从 ${clockText(h.lastOkAt)} 起` : ""}读不到了${h?.lastError ? "（一直在重试）" : ""}：下面是那之前读到的，可能已经变了` : "这个事项依赖的数据比平时旧，下面的判断可能已经过时",
        since: h?.lastOkAt ?? null,
        until: null,
      });
    }
    if (hold) marks.push({ kind: "held", line: `${personName(hold.by)} ${clockText(hold.at)} 说「${clip(hold.said, 60)}」${hold.until ? ` · ${hold.until} 前不问` : ""} · 说一句就撤`, since: hold.at, until: hold.until });
    const wrong = f.said.find((s) => s.kind === "wrong");
    if (wrong) marks.push({ kind: "wrong", line: `${personName(wrong.by)} ${clockText(wrong.at)} 说这个判断错了：「${clip(wrong.said, 60)}」`, since: wrong.at, until: null });

    // ---- the top bar and the four cells
    const stepOf = (v: Visit | undefined) => (v && route.includes(v.stage) ? route.indexOf(v.stage) + 1 : null);
    const stepNo = stepOf(last);
    const whoText = actor === "me" ? "你" : actor === "system" ? "系统" : actor === "them" ? "别人" : "没有";
    const sinceMs = waitingSince ? nowMs - Date.parse(waitingSince) : null;
    const totalMs = real.length > 0 && last ? (last.cur ? null : Math.max(0, Date.parse(last.from ?? real[0]!.from!) - Date.parse(real[0]!.from!))) : null;
    const answerable = asks.length > 0;
    const lastRun = f.runs.find((r) => r.situation === situation);

    let kicker: string;
    let line: string;
    let sub: string;
    const hm = (t: string | null) => (t ? clockText(t) : "");
    switch (situation) {
      case "me":
        kicker = ask ? `在等你回答 · 第 ${ask.round} 次问` : "在等你批准";
        line = ask?.question ?? lastRun?.gate?.summary ?? a?.headline ?? "";
        sub = ask ? `${hm(ask.askedAt)} 问的。${ask.nextAskAt ? `不答的话${ask.nextAskWhat === "nag" ? `${hm(ask.nextAskAt)} 再问` : `${hm(ask.nextAskAt)} 以后不再问`}，最多 ${ask.maxRounds} 次。` : ""}${personNotifies(ask) ?? ""}` : "批准在审批卡上点；这里不替你批。";
        break;
      case "them":
        kicker = `在等别人${a?.next.what ? ` · ${a.next.what}` : ""}`;
        line = a?.headline ?? "";
        sub = `${sinceMs !== null ? `已等 ${durationText(sinceMs)}。` : ""}要催的话：催办还没做。`;
        break;
      case "system":
        kicker = "系统在查 · 不用你做什么";
        line = a?.headline ?? "还没有判断";
        sub = [poll?.nextAt ? `${poll.what}，下次 ${hm(poll.nextAt)}。` : "", nextAsk?.at ? `${hm(nextAsk.at)} 还没有变化就问你。` : ""].join("");
        break;
      case "doing":
        kicker = "系统在做 · 不用你做什么";
        line = lastRun ? `流程「${lastRun.flow}」在跑${lastRun.step ? `：${lastRun.step.title}（第 ${lastRun.step.index} 步${lastRun.step.total ? `，共 ${lastRun.step.total} 步` : ""}）` : ""}` : (a?.headline ?? "");
        sub = lastRun ? `已跑 ${durationText(nowMs - Date.parse(lastRun.startedAt))}，花了 $${lastRun.costUsd.toFixed(2)}（只算已经结束的调用）。` : "";
        break;
      case "fail":
      case "lost":
      case "slow":
        kicker = situation === "fail" ? "流程失败了 · 要你定下一步" : situation === "lost" ? "流程断了 · 要你定下一步" : "可能卡住了 · 看一眼";
        line = lastRun ? `「${lastRun.flow}」${lastRun.step ? `在第 ${lastRun.step.index} 步「${lastRun.step.title}」` : ""}${situation === "fail" ? `失败了：${lastRun.error?.plain ?? "出错了"}` : situation === "lost" ? "断了：之后再没有动静" : `已经 ${durationText(lastRun.quiet?.ms ?? 0)}没有动静`}` : "";
        sub = lastRun ? `已花 $${lastRun.costUsd.toFixed(2)}。${lastRun.sideEffects.length > 0 ? `可能已经改了一部分：${lastRun.sideEffects.join("、")}。` : "对外的动作在人闸之后，没有改任何东西。"}不会自动重来。` : "";
        break;
      case "stuck":
        kicker = "卡住了 · 看一眼";
        line = a?.headline ?? "";
        sub = a?.notice ?? "";
        break;
      case "error":
        kicker = "检查出错 · 不是事项本身的问题";
        line = `判断这个事项的时候出错了${chain?.last ? `，下面显示的是 ${hm(chain.last.at)} 的判断` : ""}`;
        sub = clip(a?.error ?? "", 200);
        break;
      case "mine":
        kicker = "你在做 · 不催你";
        line = a?.headline ?? "";
        sub = "做完之后系统自动接着跟。";
        break;
      case "dropped":
        kicker = drop ? `不再追踪 · ${personName(drop.by)} ${hm(drop.at)} 说的` : "不再追踪";
        line = a?.headline ?? "";
        sub = drop ? `说一句「${numberOf(caseId)} 接着跟」就恢复；图保留。` : "";
        break;
      default:
        kicker = totalMs !== null ? `结束了 · 共 ${durationText(totalMs)}` : "结束了";
        line = a?.headline ?? "";
        sub = "";
    }

    const stageSub = !a ? "还没有判断" : stageMeta.side ? `岔路：${stageMeta.when ?? ""}` : stepNo ? `第 ${stepNo} 步，共 ${route.length} 步${last && last.skipped.length > 0 ? `（跳过了${last.skipped.map((s) => metaOf(metas, s.stage).label).join("、")}）` : ""}` : "";
    const facts = [
      { label: "走到哪", value: stageMeta.label || "—", sub: stageSub, hot: false },
      { label: "在等谁", value: finished ? "没有" : whoText, sub: finished ? "" : what, hot: false },
      {
        label: finished ? "用了多久" : "等了多久",
        value: finished ? (totalMs !== null ? durationText(totalMs) : "—") : sinceMs !== null ? durationText(sinceMs) : "—",
        sub: finished ? (real[0]?.from && last?.from ? `${clockText(real[0].from)} → ${clockText(last.from)}` : "") : waitingSince ? `从 ${clockText(waitingSince)} 起` : "",
        hot: false,
      },
      {
        label: "要你做吗",
        value: answerable || situation === "me" ? "要" : situation === "stuck" || situation === "slow" ? "看一眼" : situation === "fail" || situation === "lost" ? "要" : finished ? "不用" : "不用",
        sub: answerable ? "在下面选一个答案" : situation === "me" ? "批准只在审批卡上点" : situation === "stuck" ? "是顺延了还是漏了" : nextAsk?.at ? `${clockText(nextAsk.at)} 还没有变化才问你` : "",
        hot: answerable || situation === "me" || situation === "stuck" || situation === "fail" || situation === "lost",
      },
    ];

    // Some entries carry the instant the journal wrote them (UTC), some the one a judgment names (local): ordered as instants, shown in the instance's zone.
    const history: HistoryLine[] = (chain?.entries ?? [])
      .map((e) => ({ e, ms: Date.parse(e.at) }))
      .sort((x, y) => x.ms - y.ms || x.e.seq - y.e.seq)
      .slice(-120)
      .map(({ e, ms }) => ({ at: stamp(ms), kind: e.kind, line: e.text(fmt), detail: e.detail ? clip(e.detail, 160) : null, beforeTracking: false }));

    const sourceRows = sourcesOf(caseId).map((id) => ({ id, state: state.sources[id]?.health.state ?? "never", lastOkAt: state.sources[id]?.health.lastOkAt ?? null, nextPollAt: state.sources[id]?.health.nextPollAt ? stamp(state.sources[id]!.health.nextPollAt) : null }));
    const factRows = Object.values(state.notes[caseId] ?? {})
      .filter((n) => !n.field.startsWith("woken."))
      .sort((x, y) => x.field.localeCompare(y.field))
      .map((n) => ({ field: n.field, value: clip(n.value, 200), evidence: n.evidence ? clip(n.evidence, 200) : null, at: n.at, by: n.by }));

    return {
      case: caseId,
      number: numberOf(caseId),
      title: item.title,
      url: item.url,
      now: stamp(nowMs),
      mode: deps.mode,
      trackingSince: walk.trackingSince,
      situation,
      marks,
      hero: { kicker, line, sub },
      facts,
      graph: { stages: metas, normal: route },
      visits: walk.visits,
      deviations: walk.deviations,
      current: {
        stage,
        stageLabel: stageMeta.label,
        since: last?.from ?? null,
        sinceKind: last?.fromKind ?? "unknown",
        health: a?.health ?? "on-track",
        headline: a?.headline ?? "",
        ball: { actor, who: null, what, waitingSince },
        nudge: { can: false, why: "催办还没做" },
        ask,
        asks,
      },
      schedule,
      poll,
      links: linksOf(caseId, item),
      runs: f.runs,
      said: Object.values(state.annotations)
        .filter((s) => s.caseId === caseId && (!s.revoked || nowMs - Date.parse(s.revoked.at) < 7 * 86_400_000))
        .sort((x, y) => y.at.localeCompare(x.at))
        .map((s) => ({ id: s.id, kind: s.kind, label: KIND_LABEL[s.kind], said: clip(s.said, 200), by: personName(s.by), at: s.at, until: s.until, how: s.how, inForce: f.said.some((x) => x.id === s.id), revokedAt: s.revoked?.at ?? null })),
      history,
      evidence: { facts: factRows, sources: sourceRows, rule: a ? { name: a.rule, fingerprint: a.rulesFingerprint } : null, handoffsRead: false },
    };
  }

  /** The channels a person's card also goes to, said as the page's "also sent to": only for a person who has some. */
  function personNotifies(ask: AskView): string | null {
    const card = Object.values(state.cards).find((k) => k.commitments.some((x) => x.id === ask.commitmentId));
    const labels = card ? (config.persons[card.person]?.notify ?? []).map((t) => t.label ?? t.channel) : [];
    return labels.length > 0 ? `也发到了你的 ${labels.join("、")}（那边只能看，要在这里或问题卡上答）。` : null;
  }

  function linksOf(caseId: string, item: Item): LinkView[] {
    const out: LinkView[] = [];
    const seen = new Set<string>();
    const add = (key: string | null, number: string, kind: LinkView["kind"], label: string) => {
      const id = `${kind}:${key ?? number}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ caseId: key, number, kind, label, state: key ? peek(key) : null });
    };
    const resolve = (ref: string): string | null => (state.items[ref] ? ref : (Object.keys(state.items).find((k) => k.endsWith(`:${ref}`) && state.assessments[k]) ?? null));
    const tracked = (key: string) => (state.assessments[key] ? key : null);
    if (item.parent) add(tracked(item.parent), numberOf(item.parent), "parent", state.items[item.parent]?.title ? shortTitle(state.items[item.parent]!.title) : "");
    const mine = state.notes[caseId] ?? {};
    for (const field of Object.keys(mine)) {
      if (!field.startsWith("requires.")) continue;
      const key = resolve(field.slice("requires.".length));
      add(key && tracked(key), `#${field.slice("requires.".length)}`, "requires", key && state.items[key] ? shortTitle(state.items[key]!.title) : "");
    }
    const short = caseId.slice(caseId.lastIndexOf(":") + 1);
    for (const other of Object.keys(state.assessments)) {
      if (other === caseId) continue;
      const theirs = state.notes[other] ?? {};
      const title = state.items[other] ? shortTitle(state.items[other]!.title) : "";
      if (state.items[other]?.parent === caseId) add(other, numberOf(other), "child", title);
      if (theirs[`requires.${short}`]) add(other, numberOf(other), "provides", title);
      const key = mine["flagKey"]?.value;
      if (key && theirs["flagKey"]?.value === key) add(other, numberOf(other), "same-key", `同一个开关 ${key}`);
    }
    return out;
  }

  // ---- the list -------------------------------------------------------------------------------

  function rowOf(caseId: string): ListRow | null {
    const item = state.items[caseId];
    if (!item) return null;
    const nowMs = deps.now();
    const walk = walkOf(caseId, nowMs);
    const f = factsOf(caseId, walk.metas);
    const situation = situationOf(f);
    const { a } = f;
    const { cells, side } = stripOf(walk.visits, walk.metas);
    const real = walk.visits.filter((v) => !v.superseded && !v.inferred);
    const last = real[real.length - 1];
    const finished = situation === "done" || situation === "dropped";
    const ask = f.waiting[0];
    const actor: Ball = ask ? "me" : (a?.next.actor ?? "nobody");
    const what = ask ? `回答：${ask.ask.header}` : (a?.next.what ?? "");
    const since = ask?.lastAskedAt ?? heldSince(last);
    const schedule = scheduleOf(f, nowMs, finished);
    const first = real[0];
    const ms = finished ? (first?.from && last?.from ? Math.max(0, Date.parse(last.from) - Date.parse(first.from)) : null) : since ? nowMs - Date.parse(since) : null;
    return {
      caseId,
      number: numberOf(caseId),
      title: shortTitle(item.title),
      headline: a?.error ? a.error : (a?.headline ?? item.status),
      group: GROUP[situation],
      situation,
      stageLabel: a ? metaOf(walk.metas, a.stage).label : "未判断",
      strip: cells,
      side,
      who: { actor, label: finished ? "" : `${ballWho(actor)}${what ? ` · ${what}` : ""}` },
      waiting: { ms, since, ended: finished },
      next: finished ? [] : schedule.filter((s) => s.at).slice(0, 2).map((s) => `${clockText(s.at!)} ${s.line}`),
      asking: f.waiting.length,
    };
  }

  return {
    /** Reads what the journal got since, so that the first page after a tick is not the one to wait. */
    refresh: () => book.refresh(),
    view: viewOf,
    row: (caseId: string) => {
      book.refresh();
      return rowOf(caseId);
    },
    situation: (caseId: string): Situation => situationOf(factsOf(caseId)),
  };
}

export type Graph = ReturnType<typeof createGraph>;
