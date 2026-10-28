import { createHash } from "node:crypto";
import path from "node:path";
import type { Capsule } from "./capsule";
import { deskNo, isDeskKey } from "./desk";
import { canonical } from "./observe";
import { clip, diffFlowDecls, diffOutcomes, noDiff, replayOn, standingOf, type Diff, type ReplayRun, type Unmet } from "./replay";
import type { LoadedRule } from "./rules";

// A set of capsules asked of the rules in use and of a candidate: what differs between the two,
// what is amiss with the replay itself, and what people said was right and whether the candidate
// still says it. The preview (preview.ts) shows it and puts it in its id.
//
// The rule of the gate: where it cannot tell, it says so and stops (a ⚠ and no apply unless named),
// never lets the candidate through for want of an answer. What it cannot tell: a correction when a
// side asked for what the capsule never saw or no rule judges the item, a judgment that failed,
// a capsule that cannot be read and may hold what a person wrote. What the candidate cannot have
// changed it does not stop for: a rule it leaves as it is judges the same for both sides.

/** Which capsule, for a person: the item, when, and why it was kept. */
export interface CapsuleRef {
  id: string;
  caseId: string;
  label: string;
  at: string;
  trigger: string[];
  origin: Capsule["origin"];
}

export interface ExpectLine extends CapsuleRef {
  /** broken: the clauses the candidate newly does not meet; unknown: those its answer from what the capsule holds does not meet. */
  unmet: string[];
  said: string | null;
  /** unknown: why it cannot be told. */
  why?: string;
  /** unknown: the cause itself, the same for every capsule it holds for (what was asked for that the capsule lacks, or no rule). */
  because?: string;
}

export interface UnreadableCapsule {
  file: string;
  error: string;
  /** Whether what could be read of it says an expectation: true or false, or null when none of it could be read (peekExpect). */
  holds: boolean | null;
  /** It says an expectation, or may: one a person wrote (or, unreadable, in the config's cases/ outside the backfill's directory) is not to be left out of the gate unsaid. */
  kept: boolean;
  /** What apply is told to let it pass: its path under the config directory (the full path for one outside). */
  name: string;
}

export interface ReplayReport {
  /** Capsules read, and those some rule judges the item of. */
  capsules: number;
  applicable: number;
  /** Of those, the ones whose rule the candidate leaves as it is: both sides judge the same, so nothing was compared. */
  unchanged: number;
  unreadable: UnreadableCapsule[];
  /** run: the candidate was asked too; none: only the rules in use were (nothing to compare to); broken: the candidate does not load. */
  candidate: "run" | "none" | "broken";
  changed: Array<CapsuleRef & { diff: Diff }>;
  /** A side asked for what the capsule never saw: its answer is shown but not counted. */
  missing: Array<CapsuleRef & { sides: Array<"inUse" | "candidate">; calls: string[]; diff: Diff | null }>;
  /** A judgment that failed on one side only; calls: what that side also asked for that the capsule lacks (the failure may be that). */
  errors: Array<CapsuleRef & { side: "inUse" | "candidate"; error: string; calls: string[] }>;
  /** Only one side has a rule for the item. */
  noRule: Array<CapsuleRef & { side: "inUse" | "candidate"; correction: boolean; expect: boolean }>;
  expect: { broken: ExpectLine[]; fixed: ExpectLine[]; stillBroken: ExpectLine[]; unknown: ExpectLine[]; pending: CapsuleRef[] };
  /** Capsules made by the very version of the rule in use: the ones the rule can be held to what it said. */
  selfChecked: number;
  /** The rule that made a capsule, asked again, does not give what it gave. */
  selfCheck: Array<CapsuleRef & { fields: string[] }>;
}

const numberOf = (caseId: string) => (isDeskKey(caseId) ? deskNo(caseId) : `#${caseId.slice(caseId.lastIndexOf(":") + 1)}`);

export function refOf(c: Capsule): CapsuleRef {
  const title = (c.kase.primary as { title?: unknown }).title;
  return { id: c.id, caseId: c.case, label: `${numberOf(c.case)}${typeof title === "string" ? ` ${title}` : ""}`, at: c.at, trigger: c.trigger, origin: c.origin };
}

export interface ReplayOptions {
  unreadable?: Array<{ file: string; error: string; holds?: boolean | null }>;
  broken?: boolean;
  /** The config's cases/ directory: what is unreadable inside it, and may say an expectation, is a person's. */
  casesRoot?: string;
}

const inside = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** The two are the very same rule (the same text, so the same params): on a capsule they cannot judge differently. */
const sameRule = (a: LoadedRule, b: LoadedRule): boolean => !!a.sha256 && a.sha256 === b.sha256;

/** An unreadable file is held to the gate when it says an expectation, or, if it cannot be read at all, when it is where a person keeps theirs (not the backfill's directory, which is the machine's). */
const holdsWhatAPersonWrote = (u: { file: string; holds?: boolean | null }, casesRoot: string | undefined): boolean =>
  u.holds === true || (u.holds !== false && !!casesRoot && inside(casesRoot, u.file) && !inside(path.join(casesRoot, "backfill"), u.file));

/**
 * Every capsule asked of the rules in use and of the candidate (absent: only of the rules in use,
 * to see that they still give what they gave). The rule for an item is the one whose source is the
 * item's, as the controller picks it.
 */
export function replayCapsules(capsules: Capsule[], inUse: LoadedRule[], candidate: LoadedRule[] | null, options: ReplayOptions = {}): ReplayReport {
  const report: ReplayReport = {
    capsules: capsules.length,
    applicable: 0,
    unchanged: 0,
    unreadable: (options.unreadable ?? []).map((u) => ({
      file: u.file,
      error: u.error,
      holds: u.holds ?? null,
      kept: holdsWhatAPersonWrote(u, options.casesRoot),
      name: options.casesRoot && inside(options.casesRoot, u.file) ? path.relative(path.dirname(options.casesRoot), u.file).split(path.sep).join("/") : u.file,
    })),
    candidate: options.broken ? "broken" : candidate ? "run" : "none",
    changed: [],
    missing: [],
    errors: [],
    noRule: [],
    expect: { broken: [], fixed: [], stillBroken: [], unknown: [], pending: [] },
    selfChecked: 0,
    selfCheck: [],
  };
  for (const c of capsules) {
    const source = c.kase.primary.source;
    const a = inUse.find((r) => r.source === source);
    const b = candidate ? candidate.find((r) => r.source === source) : a;
    if (!a && !b) continue;
    report.applicable++;
    const ref = refOf(c);
    const runA = a ? replayOn(c, a) : null;
    // The candidate leaves the rule as it is: it judges what the rule in use judges, whatever the tape lacks, so nothing is compared (what the capsule lacks is the tape's, not the candidate's).
    const same = !!candidate && !!a && !!b && sameRule(a, b);
    if (same) report.unchanged++;
    const runB = candidate ? (b ? (same ? runA : replayOn(c, b)) : null) : runA;
    if (candidate && (!a || !b)) report.noRule.push({ ...ref, side: a ? "candidate" : "inUse", correction: c.correction !== null, expect: c.expect !== null });

    // The rule that made it, asked again of what it was given, has to give what it gave.
    if (runA && a?.sha256 && c.rule.sha256 === a.sha256) {
      report.selfChecked++;
      if (runA.missing.length > 0) report.selfCheck.push({ ...ref, fields: [`读了存档里没有的：${runA.missing.slice(0, 3).join("、")}`] });
      else if (canonical(c.outcome) !== canonical(runA.outcome)) {
        const d = diffOutcomes(c.outcome, runA.outcome);
        const fields = [...new Set([...d.judgment, ...d.flows, ...d.facts, ...d.observe, ...d.text].map((x) => x.field))].slice(0, 5);
        report.selfCheck.push({ ...ref, fields: fields.length > 0 ? fields : ["其余的字段"] });
      }
    }

    if (candidate && runA && runB && !same) {
      const lacking: Array<"inUse" | "candidate"> = [...(runA.missing.length > 0 ? (["inUse"] as const) : []), ...(runB.missing.length > 0 ? (["candidate"] as const) : [])];
      const diff = diffOutcomes(runA.outcome, runB.outcome);
      diff.flows.push(...diffFlowDecls(a!, b!, runA.outcome.output, runB.outcome.output));
      // A judgment that failed is an answer even when the rule also asked for what the capsule lacks
      // (the failure may be that; the person is told so, not that there was nothing to judge).
      if ((runA.outcome.output === null) !== (runB.outcome.output === null)) {
        const side = runB.outcome.output === null ? "candidate" : "inUse";
        const run = side === "candidate" ? runB : runA;
        report.errors.push({ ...ref, side, error: clip(run.outcome.error ?? "出错", 120), calls: run.missing.slice(0, 5) });
      } else if (lacking.length > 0) report.missing.push({ ...ref, sides: lacking, calls: [...new Set([...runA.missing, ...runB.missing])].slice(0, 5), diff: noDiff(diff) ? null : diff });
      else if (!noDiff(diff)) report.changed.push({ ...ref, diff });
    }

    if (c.correction && !c.expect) report.expect.pending.push(ref);
    if (c.expect) holdToExpect(report, c, ref, runA, candidate ? runB : null, candidate !== null, same);
  }
  return report;
}

const callsOf = (run: ReplayRun | null) => (run ? run.missing.slice(0, 3).join("、") : "");
const texts = (list: Unmet[]) => list.map((u) => u.text);

/**
 * What a person said is right, held to the rule in use and to the candidate, clause by clause: the
 * candidate says it again when it does not meet a clause the rule in use met (one put right and
 * another broken is that too). Where a side's answer cannot be held to it, it goes to `unknown`,
 * which stops as `broken` does.
 */
function holdToExpect(report: ReplayReport, c: Capsule, ref: CapsuleRef, runA: ReplayRun | null, runB: ReplayRun | null, compared: boolean, same: boolean): void {
  const expect = c.expect!;
  const said = c.correction?.said ?? null;
  const line = (unmet: Unmet[], because?: string, why?: string): ExpectLine => ({ ...ref, unmet: texts(unmet), said, ...(why ? { why } : {}), ...(because ? { because } : {}) });
  const sa = standingOf(expect, runA);
  if (same) {
    // The candidate leaves this rule as it is: it cannot have said it again, put it right, or made it harder to tell. Only what is still wrong is listed.
    if (sa.verdict === "unmet") report.expect.stillBroken.push(line(sa.unmet));
    return;
  }
  if (!compared) {
    // Only the rules in use were asked: nothing to compare to, only whether the correction is met.
    if (sa.verdict === "unmet") report.expect.stillBroken.push(line(sa.unmet));
    else if (sa.verdict === "unknown") report.expect.unknown.push(line(sa.unmet, `在用的判断方法读了存档里没有的：${callsOf(runA)}`, `在用的判断方法读了存档里没有的：${callsOf(runA)}`));
    return;
  }
  const sb = standingOf(expect, runB);
  if (sb.verdict === "none") {
    const because = "候选没有判断方法管这个事项";
    report.expect.unknown.push(line([], because, `${because}，核对不了`));
  } else if (sb.verdict === "unknown") {
    const partial = sb.unmet.length > 0 ? `拿存档里有的算，候选的答案已经不满足这几处` : "拿存档里有的算，候选的答案还满足";
    const because = `候选读了存档里没有的（${callsOf(runB)}）`;
    report.expect.unknown.push(line(sb.unmet, because, `${because}，${partial}；用候选重新补录一份存档才核对得了（cases backfill --candidate … --replace）`));
  } else if (sa.verdict === "unknown") {
    // The candidate's answer is whole; the rule in use's is not, so what was met before cannot be told.
    if (sb.verdict === "unmet") {
      const because = `在用的判断方法读了存档里没有的（${callsOf(runA)}）`;
      report.expect.unknown.push(line(sb.unmet, because, `${because}，分不清候选不满足的这几处是不是本来就不满足`));
    }
  } else if (sa.verdict === "none") {
    if (sb.verdict === "unmet") report.expect.stillBroken.push(line(sb.unmet));
  } else {
    const before = new Set(sa.unmet.map((u) => u.key));
    const again = sb.unmet.filter((u) => !before.has(u.key));
    if (again.length > 0) report.expect.broken.push(line(again));
    else if (sb.verdict === "met" && sa.verdict === "unmet") report.expect.fixed.push(line([]));
    else if (sb.verdict === "unmet") report.expect.stillBroken.push(line(sb.unmet));
  }
}

/** The part of a report that goes into a preview's id: what differs between the two sides, and what is amiss with the replay. */
export function replayDigest(r: ReplayReport): unknown {
  const tail = (file: string) => file.split(/[\\/]/).slice(-2).join("/");
  return {
    changed: r.changed.map((x) => [x.id, x.diff]),
    missing: r.missing.map((x) => [x.id, x.sides, x.calls]),
    errors: r.errors.map((x) => [x.id, x.side, x.error]),
    noRule: r.noRule.map((x) => [x.id, x.side]),
    broken: r.expect.broken.map((x) => [x.id, x.unmet]),
    unknown: r.expect.unknown.map((x) => [x.id, x.unmet, x.why]),
    fixed: r.expect.fixed.map((x) => x.id),
    selfCheck: r.selfCheck.map((x) => [x.id, x.fields]),
    unreadable: r.unreadable.map((x) => [tail(x.file), x.error, x.kept]),
  };
}

/** Nothing in it differs between the two sides, and nothing is amiss with the replay itself. */
export const replayEmpty = (r: ReplayReport): boolean =>
  r.changed.length + r.missing.length + r.errors.length + r.noRule.length + r.expect.broken.length + r.expect.unknown.length + r.expect.fixed.length + r.selfCheck.length + r.unreadable.length === 0;

/** One thing that stops an apply until a person names it. */
export interface Stop {
  /** One capsule's id, or an unreadable capsule's path under the config (the full path for one outside it). */
  name: string;
  kind: "broken" | "unknown" | "error" | "unreadable";
  label: string;
  /** Why, in words: the same for every stop with the same cause (not the capsule, not the path). */
  reason: string;
  /** The cause: naming it (`cause:<8 hex>`) lets every stop of this kind with this reason pass. */
  cause: string;
  /** The item the capsule is of ("" for a file that could not be read): naming `item:<it>@<kind>` lets the item's stops of that kind pass, and no other. */
  item: string;
}

/** Every name by which a stop can be let through. */
export const namesOf = (s: Stop): string[] => [s.name, s.cause, ...(s.item ? [itemName(s.item, s.kind)] : [])];

/** An item's stops of one kind, in one name: not the item's others (a candidate that fails on an item is not the same as a correction of it said again). */
export const itemName = (item: string, kind: Stop["kind"]) => `item:${item}@${kind}`;

const when = (c: CapsuleRef) => c.at.slice(5, 16).replace("T", " ");
const causeOf = (kind: Stop["kind"], reason: string) => `cause:${createHash("sha256").update(`${kind}\n${reason}`).digest("hex").slice(0, 8)}`;

/** Everything the gate stops an apply for: a correction said again or not to be told, a candidate that fails where the rule in use does not, a capsule that cannot be read and may say one. */
export function stops(r: ReplayReport): Stop[] {
  const stop = (kind: Stop["kind"], name: string, label: string, reason: string, item: string): Stop => ({ name, kind, label, reason, cause: causeOf(kind, reason), item });
  return [
    ...r.expect.broken.map((e) => stop("broken", e.id, `${e.label} ${when(e)}`, `纠错又犯了：${e.unmet.join("；")}`, e.caseId)),
    ...r.expect.unknown.map((e) => stop("unknown", e.id, `${e.label} ${when(e)}`, `纠错核对不了：${e.because ?? e.why ?? ""}`, e.caseId)),
    ...r.errors.filter((e) => e.side === "candidate").map((e) => stop("error", e.id, `${e.label} ${when(e)}`, `候选判断出错：${e.error}${e.calls.length > 0 ? `（候选还读了存档里没有的：${e.calls.join("、")}）` : ""}`, e.caseId)),
    ...r.unreadable.filter((u) => u.kept).map((u) => stop("unreadable", u.name, u.name, `读不了的存档：${u.error}`, "")),
  ];
}

/** Of what stops, the causes that more than one stop has, and the items that have more than one: what can be let through in one name. */
export function stopGroups(r: ReplayReport): { causes: Array<{ cause: string; kind: Stop["kind"]; reason: string; count: number }>; items: Array<{ item: string; kind: Stop["kind"]; label: string; count: number }> } {
  const all = stops(r);
  const causes = new Map<string, { cause: string; kind: Stop["kind"]; reason: string; count: number }>();
  const items = new Map<string, { item: string; kind: Stop["kind"]; label: string; count: number }>();
  const labels = new Map([...r.expect.broken, ...r.expect.unknown, ...r.errors].map((e) => [e.caseId, e.label.split(" ")[0] ?? e.caseId] as const));
  for (const s of all) {
    const c = causes.get(s.cause) ?? { cause: s.cause, kind: s.kind, reason: s.reason, count: 0 };
    c.count++;
    causes.set(s.cause, c);
    if (s.item) {
      const i = items.get(itemName(s.item, s.kind)) ?? { item: s.item, kind: s.kind, label: labels.get(s.item) ?? s.item, count: 0 };
      i.count++;
      items.set(itemName(s.item, s.kind), i);
    }
  }
  return { causes: [...causes.values()].filter((c) => c.count > 1), items: [...items.values()].filter((i) => i.count > 1) };
}

const WHY: Record<string, string> = { first: "第一次判断", stage: "换阶段", questions: "要问的变了", notice: "提醒变了", error: "判断出错", sample: "每天的样本", wrong: "说判断错了" };
const why = (c: CapsuleRef) => `${c.trigger.map((t) => WHY[t] ?? t).join("、")}${c.origin === "backfill" ? "，补录的" : ""}`;

/** What is wrong with the candidate or with the replay itself: shown at the top of a preview. */
export function replayWarnings(r: ReplayReport): string[] {
  const out: string[] = [];
  const cut = <T>(xs: T[], n: number, show: (x: T) => string, more: (left: number) => string) => {
    for (const x of xs.slice(0, n)) out.push(show(x));
    if (xs.length > n) out.push(more(xs.length - n));
  };
  const said = (e: ExpectLine) => (e.said ? `，说过：「${clip(e.said, 40)}」` : "");
  cut(
    r.expect.broken,
    10,
    (e) => `⚠ 纠错又犯了：${e.label} ${when(e)}（${e.id}）${said(e)}：候选${e.unmet.map((u) => clip(u, 60)).join("；")}`,
    (n) => `⚠ 还有 ${n} 条纠错又犯了（全部在 diff --json 里）`,
  );
  cut(
    r.expect.unknown,
    10,
    (e) => `⚠ 纠错核对不了：${e.label} ${when(e)}（${e.id}）${said(e)}：${e.why ?? ""}${e.unmet.length > 0 ? `：${e.unmet.map((u) => clip(u, 60)).join("；")}` : ""}`,
    (n) => `⚠ 还有 ${n} 条纠错核对不了（全部在 diff --json 里）`,
  );
  cut(
    r.errors.filter((x) => x.side === "candidate"),
    10,
    (e) => `⚠ 候选在这份存档上判断出错，在用的不出错：${e.label} ${when(e)}（${e.id}；${why(e)}）：${e.error}${e.calls.length > 0 ? `（候选还读了存档里没有的：${e.calls.slice(0, 3).join("、")}，出错可能就是因为它）` : ""}`,
    (n) => `⚠ 还有 ${n} 份存档上候选也判断出错（全部在 diff --json 里）`,
  );
  cut(
    r.noRule.filter((x) => x.side === "candidate" && x.correction && !x.expect),
    5,
    (n) => `⚠ 候选没有判断方法管这个事项，说过判断错了、还没写 expect：${n.label} ${when(n)}`,
    (n) => `⚠ 还有 ${n} 份说过判断错了、候选没有判断方法管的`,
  );
  cut(
    r.selfCheck,
    10,
    (s) => `⚠ 存档复现不了：${s.label} ${when(s)}，在用的判断方法和存下它时是同一版，拿存档里的数据再判断一遍，结果却不一样（${s.fields.join("、")}）：重放不可信，先查原因`,
    (n) => `⚠ 还有 ${n} 份存档复现不了`,
  );
  // Unreadable: one that says an expectation (or may: it cannot be read at all and is where a person keeps theirs) stops an apply; the rest are told, not stopped on.
  cut(
    r.unreadable.filter((u) => u.kept),
    5,
    (u) =>
      `⚠ 读不了的存档，${u.holds === true ? "里面写着 expect" : "看不出里面有没有 expect（它在配置目录的 cases/ 里，按有算）"}，它的纠错没有拿来核对：${u.name}（${clip(u.error, 100)}）：修好它，或者删掉；不修也要拷的话，把这个路径写进 --accept-regress`,
    (n) => `⚠ 还有 ${n} 份写着 expect 的存档读不了`,
  );
  cut(
    r.unreadable.filter((u) => !u.kept),
    3,
    (u) => `⚠ 读不了的存档，${u.holds === false ? "里面没有 expect" : "读不出内容，在机器写的目录里"}（只是没读进来，不拦）：${u.file.split(/[\\/]/).slice(-2).join("/")}（${clip(u.error, 100)}）`,
    (n) => `⚠ 还有 ${n} 份没写 expect 的存档读不了`,
  );
  // What stops in one name: a cause that more than one stop has (the same candidate failing the same way on many capsules), an item that has more.
  const groups = stopGroups(r);
  const kindWords: Record<Stop["kind"], string> = { broken: "纠错又犯了", unknown: "纠错核对不了", error: "候选判断出错", unreadable: "读不了的存档" };
  cut(
    groups.causes,
    5,
    (g) => `⚠ ${g.count} 处拦截是同一个原因（${kindWords[g.kind]}：${clip(g.reason.slice(g.reason.indexOf("：") + 1), 80)}），认下的话整组点名：${g.cause}`,
    (n) => `⚠ 还有 ${n} 组同一个原因的拦截（全部在 diff --json 的 stops 里）`,
  );
  cut(
    groups.items,
    5,
    (g) => `⚠ 事项 ${g.label} 有 ${g.count} 处${kindWords[g.kind]}的拦截，认下这一种的话点名：${itemName(g.item, g.kind)}（该事项别种拦截不跟着放行）`,
    (n) => `⚠ 还有 ${n} 组事项有不止一处同一种拦截`,
  );
  return out;
}

/** The replay as a person reads it: a section of the preview. */
export function replayLines(r: ReplayReport): string[] {
  const out: string[] = ["## 拿过去的判断时刻重放"];
  if (r.capsules === 0) {
    if (r.unreadable.length > 0) return [...out, `一份存档也没读成：${r.unreadable.length} 份读不了（见上面的 ⚠），先修那几份文件。`];
    return [...out, "没有存档（数据目录的 capsules/ 和配置目录的 cases/ 里都没有）：reconcile-preview cases backfill 可以从日志补一批。"];
  }
  const mode = r.candidate === "run" ? "在用、候选各判断一遍，比的是这两遍" : r.candidate === "broken" ? "候选的判断方法加载不上，只拿在用的判断一遍" : "只拿在用的判断一遍（没有候选）";
  out.push(`存档 ${r.capsules} 份，有判断方法管着的 ${r.applicable} 份；${mode}。`);
  out.push(
    r.selfChecked === 0
      ? "没有一份是在用的这一版判断方法存下的（存下它们的判断方法后来改过），存档里记的答案没拿来核对。"
      : `其中 ${r.selfChecked} 份是在用的这一版判断方法存下的，拿存档再判断一遍：${r.selfCheck.length > 0 ? `${r.selfCheck.length} 份和存下的不一样（见 ⚠）` : "答案和存下的一样"}。`,
  );
  if (r.unchanged > 0) out.push(`其中 ${r.unchanged} 份存档的判断方法候选没有改（文本一样），两边必然判断得一样，没有比。`);
  if (r.missing.length > 0) out.push(`其中 ${r.missing.length} 份有一边读了存档里没有的东西（回放缺数据）：这几份的差异只作参考；判断方法多读了东西，要用候选重新补录才比得准（cases backfill --candidate <候选目录> --replace）。`);
  const first = <T>(xs: T[], n: number) => xs.slice(0, n);
  const list = (xs: CapsuleRef[], n = 5) => `${first(xs, n).map((e) => `${e.label} ${when(e)}`).join("、")}${xs.length > n ? "…" : ""}`;
  if (r.expect.fixed.length > 0) out.push(`修好了 ${r.expect.fixed.length} 条纠错：${list(r.expect.fixed)}`);
  if (r.expect.stillBroken.length > 0) out.push(`还没修好的纠错 ${r.expect.stillBroken.length} 条（候选和在用的一样不满足）：${list(r.expect.stillBroken)}`);
  if (r.expect.pending.length > 0) out.push(`还没写 expect 的纠错 ${r.expect.pending.length} 条：${first(r.expect.pending, 5).map((e) => `${e.label} ${when(e)}（${e.id}）`).join("、")}（reconcile-preview cases expect --id … --expect <文件>）`);
  if (r.expect.unknown.length > 0) out.push(`纠错核对不了 ${r.expect.unknown.length} 条（见 ⚠）：${list(r.expect.unknown)}`);
  const judgment = r.changed.filter((c) => c.diff.judgment.length > 0);
  if (judgment.length > 0) {
    out.push(`判断变了（${judgment.length} 份，${new Set(judgment.map((c) => c.caseId)).size} 个事项；在用 → 候选）：`);
    for (const c of first(judgment, 15)) {
      out.push(`- ${c.label} ${when(c)}（${why(c)}）`, ...first(c.diff.judgment, 8).map((d) => `  ${d.field}：${clip(d.before, 70)} → ${clip(d.after, 70)}`));
      if (c.diff.judgment.length > 8) out.push(`  …还有 ${c.diff.judgment.length - 8} 处`);
    }
    if (judgment.length > 15) out.push(`…还有 ${judgment.length - 15} 份`);
  }
  const kinds: Array<[keyof Diff, string]> = [["flows", "要起的流程不同"], ["facts", "记下的事实不同"], ["observe", "要观察的不同"], ["text", "只差文字"]];
  for (const [kind, title] of kinds) {
    const some = r.changed.filter((c) => c.diff[kind].length > 0);
    if (some.length === 0) continue;
    const fields = new Map<string, number>();
    for (const c of some) for (const f of new Set(c.diff[kind].map((d) => d.field.replace(/^问题 [^：]+：/, "问题：")))) fields.set(f, (fields.get(f) ?? 0) + 1);
    out.push(`${title}（${some.length} 份）：${first([...fields], 8).map(([f, n]) => `${f}${n > 1 ? `×${n}` : ""}`).join("、")}${fields.size > 8 ? "…" : ""}`);
    // A flow costs money and a watch costs reads: which ones are told, not only that they differ.
    if (kind === "observe" || kind === "flows") for (const c of first(some, 5)) out.push(`- ${c.label} ${when(c)}`, ...first(c.diff[kind], 6).map((d) => `  ${d.field}：${clip(d.before, 60)} → ${clip(d.after, 60)}`));
  }
  for (const e of first(r.errors.filter((x) => x.side === "inUse"), 5)) out.push(`在用的在这份存档上判断出错、候选不出错：${e.label} ${when(e)}：${e.error}`);
  for (const n of first(r.noRule, 5)) out.push(`${n.side === "candidate" ? "候选不判断它" : "在用的不判断它，候选判断"}：${n.label} ${when(n)}`);
  for (const m of first(r.missing, 5)) {
    const sides = m.sides.map((s) => (s === "inUse" ? "在用" : "候选")).join("、");
    out.push(`回放缺数据（${sides}读了存档里没有的：${m.calls.join("、")}）：${m.label} ${when(m)}，结果只作参考${m.diff ? `（两边${m.diff.judgment.length > 0 ? "判断不同" : m.diff.flows.length > 0 ? "要起的流程不同" : "只差记账和文字"}）` : ""}`);
    // The judgment that differs, field by field, though only for reference: it is the very thing a change to what is read is most often meant to change.
    if (m.diff) {
      const shown = [...m.diff.judgment, ...m.diff.flows];
      for (const d of first(shown, 3)) out.push(`  （仅参考）${d.field}：${clip(d.before, 60)} → ${clip(d.after, 60)}`);
      if (shown.length > 3) out.push(`  …还有 ${shown.length - 3} 处判断${m.diff.flows.length > 0 ? "或要起的流程" : ""}不同`);
    }
  }
  if (r.missing.length > 5) out.push(`…还有 ${r.missing.length - 5} 份缺数据`);
  if (replayEmpty(r) && r.candidate !== "none") out.push(r.applicable === 0 ? "没有判断方法管这些存档，没有重放。" : "没有差异：每份存档在两版下得到同样的判断。");
  return out;
}
