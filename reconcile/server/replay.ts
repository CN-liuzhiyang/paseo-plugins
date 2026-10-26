import type { Capsule, CapsuleOutcome, Expect } from "./capsule";
import { canonical, conclude } from "./observe";
import { callKey, deepFreeze, judge, makeContext, outputCheck, type LoadedRule, type RuleContext, type RuleOutput } from "./rules";
import { createCalendar } from "./time";

// A capsule asked again. The rule is handed a context that holds exactly what was taped (a call
// the tape has is answered as it was; the clock and the holiday tables are the capsule's), and its
// answer is taken the way the controller takes one (judge(): the schema, the stages, the names it
// refers to). A call the tape does not have is answered with nothing (an empty list, no item) and
// told apart: a rule that wants what the capsule never saw has no answer to be compared on.

export const HEALTH: Record<string, string> = { "on-track": "在走", waiting: "在等", stalled: "停住了", blocked: "卡住", conflict: "对不上", done: "结束" };
export const ACTOR: Record<string, string> = { me: "你", them: "别人", system: "系统", nobody: "没有人" };

export interface ReplayRun {
  outcome: CapsuleOutcome;
  /** Calls the rule made that the tape does not have, as `member(args)`. */
  missing: string[];
}

export function replayOn(capsule: Capsule, rule: LoadedRule): ReplayRun {
  const { now, tz } = capsule.clock;
  const nowMs = Date.parse(now);
  // The calendar members are worked out from the clock and the tables, by the same code as live.
  const base = makeContext({ nowMs, tz, calendar: createCalendar(capsule.clock.calendar), items: {}, recent: {}, notes: {}, commitments: {}, fresh: () => true }, rule.params);
  const table = new Map(capsule.calls.map((c) => [callKey(c.m, c.args), c.result] as const));
  const missing: string[] = [];
  const taped =
    (member: string, nothing: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      const key = callKey(member, args);
      if (table.has(key)) return deepFreeze(structuredClone(table.get(key)));
      const call = `${member}(${args.map((a) => JSON.stringify(a)).join(", ")})`;
      if (!missing.includes(call)) missing.push(call);
      return deepFreeze(structuredClone(nothing(...args)));
    };
  const members = {
    now,
    tz,
    params: base.params,
    workdaysBetween: base.workdaysBetween,
    addWorkdays: base.addWorkdays,
    at: base.at,
    local: base.local,
    item: taped("item", () => null),
    siblings: taped("siblings", () => []),
    observations: taped("observations", () => []),
    notes: taped("notes", () => ({})),
    commitments: taped("commitments", () => []),
    flag: taped("flag", (key) => base.flag(key as string)),
    flagsOf: taped("flagsOf", () => []),
    naming: taped("naming", () => []),
    fresh: taped("fresh", () => true),
    // No flow was asked for that this capsule knows: never asked for, which is what a rule is told then.
    run: taped("run", () => null),
    // Nothing was read for it that this capsule knows: not read yet, which is what a rule is told then.
    observation: taped("observation", () => conclude(null, null, null, { everyMs: 60_000, graceMs: 0, maxLagMs: 0, nowMs, tz })),
  } satisfies Record<keyof RuleContext, unknown>;
  const names = { known: new Set(capsule.names.known), items: new Set(capsule.names.items), observing: new Set(capsule.names.observing) };
  const judged = judge(
    rule,
    capsule.kase,
    Object.freeze(members) as unknown as RuleContext,
    capsule.rule.fingerprint,
    outputCheck({ known: (n) => names.known.has(n), item: (k) => names.items.has(k), observing: (id) => names.observing.has(id) }),
  );
  return { outcome: judged.output ? { output: JSON.parse(JSON.stringify(judged.output)) as RuleOutput, error: null } : { output: null, error: judged.assessment.error ?? "判断出错" }, missing };
}

// ---- what differs ----------------------------------------------------------------------------

/** One thing that differs, as people read it. */
export interface Delta {
  field: string;
  before: string;
  after: string;
}

/**
 * The differences between two answers to the same capsule, in four kinds in the order they
 * matter: the judgment (what is decided: stage, who has the ball, which questions are asked of
 * whom and when), the facts a rule writes down, what it asks to have watched, and wording.
 */
export interface Diff {
  judgment: Delta[];
  facts: Delta[];
  observe: Delta[];
  text: Delta[];
}

export const noDiff = (d: Diff): boolean => d.judgment.length + d.facts.length + d.observe.length + d.text.length === 0;

export const clip = (text: string, n = 200): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** How the same instant is written does not matter. */
const sameAt = (a: string, b: string) => a === b || (Date.parse(a) === Date.parse(b) && !Number.isNaN(Date.parse(a)));

export function diffOutcomes(a: CapsuleOutcome, b: CapsuleOutcome): Diff {
  const d: Diff = { judgment: [], facts: [], observe: [], text: [] };
  const x = a.output;
  const y = b.output;
  if (!x || !y) {
    if (x || y) d.judgment.push({ field: "判断出错", before: x ? "无" : clip(a.error ?? "出错"), after: y ? "无" : clip(b.error ?? "出错") });
    else if (a.error !== b.error) d.text.push({ field: "出错原因", before: clip(a.error ?? ""), after: clip(b.error ?? "") });
    return d;
  }
  const put = (kind: keyof Diff, field: string, before: string, after: string, same = before === after) => {
    if (!same) d[kind].push({ field, before: clip(before), after: clip(after) });
  };
  put("judgment", "阶段", x.stage, y.stage);
  put("judgment", "健康", HEALTH[x.health] ?? x.health, HEALTH[y.health] ?? y.health);
  put("judgment", "在等谁", ACTOR[x.next.actor] ?? x.next.actor, ACTOR[y.next.actor] ?? y.next.actor);
  put("judgment", "提醒", x.notice ? "有" : "无", y.notice ? "有" : "无");
  put("text", "提醒的话", x.notice ?? "", y.notice ?? "", !x.notice || !y.notice || x.notice === y.notice);
  put("text", "现状", x.headline, y.headline);
  put("text", "下一步", x.next.what, y.next.what);
  put("text", "到这一步的时间", x.since ?? "无", y.since ?? "无", sameAt(x.since ?? "", y.since ?? ""));
  put("text", "轮到的时间", x.next.since ?? "无", y.next.since ?? "无", sameAt(x.next.since ?? "", y.next.since ?? ""));

  const cx = new Map(x.commitments.map((c) => [c.key, c]));
  const cy = new Map(y.commitments.map((c) => [c.key, c]));
  for (const key of [...new Set([...cx.keys(), ...cy.keys()])].sort()) {
    const p = cx.get(key);
    const q = cy.get(key);
    if (!p || !q) {
      const c = (p ?? q)!;
      put("judgment", `问题 ${key}`, p ? `要问「${c.title}」` : "没有", q ? `要问「${c.title}」` : "没有");
      continue;
    }
    const at = (field: string, before: string, after: string) => put("judgment", `问题 ${key}：${field}`, before, after, sameAt(before, after));
    put("judgment", `问题 ${key}：问谁`, p.owner, q.owner);
    put("judgment", `问题 ${key}：范围`, p.domain, q.domain);
    at("什么时候问", p.trigger.at, q.trigger.at);
    at("兜底时间", p.backstop.at, q.backstop.at);
    put("judgment", `问题 ${key}：推送`, p.level, q.level);
    put("judgment", `问题 ${key}：选项`, p.ask.options.map((o) => o.id).join(" / "), q.ask.options.map((o) => o.id).join(" / "));
    put("judgment", `问题 ${key}：能不能写别的`, String(p.ask.allowOther), String(q.ask.allowOther));
    put("judgment", `问题 ${key}：追问`, canonical(p.nag), canonical(q.nag));
    put("judgment", `问题 ${key}：依赖`, canonical(p.uses ?? null), canonical(q.uses ?? null));
    put("text", `问题 ${key}：标题`, p.title, q.title);
    put("text", `问题 ${key}：问法`, `${p.ask.header}：${p.ask.question}`, `${q.ask.header}：${q.ask.question}`);
    put("text", `问题 ${key}：选项的字`, p.ask.options.map((o) => `${o.label}（${o.description}）`).join(" / "), q.ask.options.map((o) => `${o.label}（${o.description}）`).join(" / "));
    put("text", `问题 ${key}：卡上的说明`, p.brief, q.brief);
  }

  const wx = new Map((x.wake ?? []).map((w) => [w.caseId, w.reason]));
  const wy = new Map((y.wake ?? []).map((w) => [w.caseId, w.reason]));
  for (const id of [...new Set([...wx.keys(), ...wy.keys()])].sort()) {
    put("judgment", `叫醒 ${id}`, wx.has(id) ? "叫" : "不叫", wy.has(id) ? "叫" : "不叫");
    if (wx.has(id) && wy.has(id)) put("text", `叫醒 ${id} 的话`, wx.get(id)!, wy.get(id)!);
  }

  const fx = new Map(x.facts.map((f) => [f.field, f]));
  const fy = new Map(y.facts.map((f) => [f.field, f]));
  for (const field of [...new Set([...fx.keys(), ...fy.keys()])].sort()) {
    put("facts", field, fx.get(field)?.value ?? "（没有）", fy.get(field)?.value ?? "（没有）");
    if (fx.has(field) && fy.has(field)) put("text", `事实 ${field} 的依据`, fx.get(field)!.evidence, fy.get(field)!.evidence);
  }

  const ox = new Map((x.observe ?? []).map((o) => [`${o.source}:${o.key}`, o]));
  const oy = new Map((y.observe ?? []).map((o) => [`${o.source}:${o.key}`, o]));
  for (const key of [...new Set([...ox.keys(), ...oy.keys()])].sort()) {
    const p = ox.get(key);
    const q = oy.get(key);
    put("observe", `观察 ${key}`, p ? "要" : "不要", q ? "要" : "不要");
    if (!p || !q) continue;
    put("observe", `观察 ${key}：窗口`, `${p.window.from} 到 ${p.window.to}`, `${q.window.from} 到 ${q.window.to}`, sameAt(p.window.from, q.window.from) && sameAt(p.window.to, q.window.to));
    put("observe", `观察 ${key}：补读`, p.reread.join("、") || "无", q.reread.join("、") || "无");
    put("observe", `观察 ${key}：参数`, canonical(p.params), canonical(q.params));
  }
  return d;
}

// ---- what a person said is right ------------------------------------------------------------

const listed = (want: string | string[]) => (Array.isArray(want) ? want : [want]);

/** One thing of an expectation an answer does not meet: which clause (stable between answers), and in words. */
export interface Unmet {
  key: string;
  text: string;
}

interface Clause {
  key: string;
  /** The key of the expectation it belongs to, for saying a judgment that failed could not be held to it. */
  top: string;
  /** In words what the answer does not meet; null when it meets it. */
  check: (x: RuleOutput) => string | null;
}

/** Every clause an expectation holds, in the order they are told. */
function clausesOf(expect: Expect): Clause[] {
  const out: Clause[] = [];
  const one = (key: string, name: string, want: string | string[] | undefined, got: (x: RuleOutput) => string, show: (v: string) => string = (v) => v) => {
    if (want === undefined) return;
    out.push({ key, top: key, check: (x) => (listed(want).includes(got(x)) ? null : `${name}要是 ${listed(want).map(show).join(" 或 ")}，是 ${show(got(x))}`) });
  };
  one("stage", "阶段", expect.stage, (x) => x.stage);
  one("health", "健康", expect.health, (x) => x.health, (v) => HEALTH[v] ?? v);
  one("actor", "在等谁", expect.actor, (x) => x.next.actor, (v) => ACTOR[v] ?? v);
  if (expect.notice !== undefined) out.push({ key: "notice", top: "notice", check: (x) => (!!x.notice === expect.notice ? null : expect.notice ? "该有提醒，没有" : "不该有提醒，有") });
  for (const prefix of expect.asks?.has ?? []) out.push({ key: `asks.has:${prefix}`, top: "asks", check: (x) => (x.commitments.some((c) => c.key.startsWith(prefix)) ? null : `该问 ${prefix}…，没有`) });
  for (const prefix of expect.asks?.none ?? []) {
    out.push({
      key: `asks.none:${prefix}`,
      top: "asks",
      check: (x) => {
        const hit = x.commitments.find((c) => c.key.startsWith(prefix));
        return hit ? `不该问 ${prefix}…，却要问 ${hit.key}` : null;
      },
    });
  }
  for (const [field, want] of Object.entries(expect.facts ?? {})) {
    out.push({
      key: `facts:${field}`,
      top: "facts",
      check: (x) => {
        const got = x.facts.find((f) => f.field === field)?.value ?? null;
        if (got === want) return null;
        return want === null ? `不该记事实 ${field}，记了 ${clip(got ?? "", 60)}` : `事实 ${field} 该是 ${clip(want, 60)}，是 ${got === null ? "（没有）" : clip(got, 60)}`;
      },
    });
  }
  for (const text of expect.headline?.has ?? []) out.push({ key: `headline.has:${text}`, top: "headline", check: (x) => (x.headline.includes(text) ? null : `现状里该有「${text}」`) });
  for (const text of expect.headline?.not ?? []) out.push({ key: `headline.not:${text}`, top: "headline", check: (x) => (x.headline.includes(text) ? `现状里不该有「${text}」` : null) });
  return out;
}

/** What of an expectation an answer does not meet, clause by clause; empty when it meets all of it. */
export function unmetClauses(expect: Expect, outcome: CapsuleOutcome): Unmet[] {
  const out: Unmet[] = [];
  if (expect.error !== undefined && (outcome.output === null) !== expect.error) out.push({ key: "error", text: expect.error ? "该判断出错，它没有" : `不该判断出错：${clip(outcome.error ?? "", 80)}` });
  const x = outcome.output;
  for (const clause of clausesOf(expect)) {
    // A judgment that failed has no answer to hold to a clause: every one of them is unmet.
    const text = x ? clause.check(x) : `判断出错了，核对不了「${clause.top}」`;
    if (text) out.push({ key: clause.key, text });
  }
  return out;
}

/** What of an expectation an answer does not meet, in words; empty when it meets all of it. */
export function unmet(expect: Expect, outcome: CapsuleOutcome): string[] {
  return [...new Set(unmetClauses(expect, outcome).map((u) => u.text))];
}

/**
 * Whether a run meets an expectation: unknown when the rule asked for what the capsule does not
 * hold (it has no answer to be held to), none when no rule judges the item on that side.
 */
export function verdictOf(expect: Expect, run: ReplayRun | null): "met" | "unmet" | "unknown" | "none" {
  if (!run) return "none";
  if (run.missing.length > 0) return "unknown";
  return unmet(expect, run.outcome).length === 0 ? "met" : "unmet";
}

/**
 * A side's standing against an expectation: the verdict and, whenever there is an answer, which
 * clauses it does not meet -- for an unknown one, the clauses the answer it gave from what the
 * capsule holds does not meet (a rule given nothing for what it asked is no proof it was right).
 */
export interface Standing {
  verdict: "met" | "unmet" | "unknown" | "none";
  unmet: Unmet[];
}

export function standingOf(expect: Expect, run: ReplayRun | null): Standing {
  if (!run) return { verdict: "none", unmet: [] };
  const clauses = unmetClauses(expect, run.outcome);
  return { verdict: run.missing.length > 0 ? "unknown" : clauses.length === 0 ? "met" : "unmet", unmet: clauses };
}
