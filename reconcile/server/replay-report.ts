import path from "node:path";
import type { Capsule } from "./capsule";
import { canonical } from "./observe";
import { clip, diffOutcomes, noDiff, replayOn, standingOf, type Diff, type ReplayRun, type Unmet } from "./replay";
import type { LoadedRule } from "./rules";

// A set of capsules asked of the rules in use and of a candidate: what differs between the two,
// what is amiss with the replay itself, and what people said was right and whether the candidate
// still says it. The preview (preview.ts) shows it and puts it in its id.
//
// The rule of the gate: where it cannot tell, it says so and stops (a ⚠ and no apply unless named),
// never lets the candidate through for want of an answer. What it cannot tell: a correction when a
// side asked for what the capsule never saw or no rule judges the item, a judgment that failed,
// a capsule that cannot be read.

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
}

export interface UnreadableCapsule {
  file: string;
  error: string;
  /** In the config's cases/: a person's, who may have written an expectation in it. */
  kept: boolean;
  /** What apply is told to let it pass: its path under the config directory. */
  name: string;
}

export interface ReplayReport {
  /** Capsules read, and those some rule judges the item of. */
  capsules: number;
  applicable: number;
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

const numberOf = (caseId: string) => `#${caseId.slice(caseId.lastIndexOf(":") + 1)}`;

export function refOf(c: Capsule): CapsuleRef {
  const title = (c.kase.primary as { title?: unknown }).title;
  return { id: c.id, caseId: c.case, label: `${numberOf(c.case)}${typeof title === "string" ? ` ${title}` : ""}`, at: c.at, trigger: c.trigger, origin: c.origin };
}

export interface ReplayOptions {
  unreadable?: Array<{ file: string; error: string }>;
  broken?: boolean;
  /** The config's cases/ directory: what is unreadable inside it is a person's. */
  casesRoot?: string;
}

const inside = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * Every capsule asked of the rules in use and of the candidate (absent: only of the rules in use,
 * to see that they still give what they gave). The rule for an item is the one whose source is the
 * item's, as the controller picks it.
 */
export function replayCapsules(capsules: Capsule[], inUse: LoadedRule[], candidate: LoadedRule[] | null, options: ReplayOptions = {}): ReplayReport {
  const report: ReplayReport = {
    capsules: capsules.length,
    applicable: 0,
    unreadable: (options.unreadable ?? []).map((u) => {
      const kept = !!options.casesRoot && inside(options.casesRoot, u.file);
      return { ...u, kept, name: kept ? path.relative(path.dirname(options.casesRoot!), u.file).split(path.sep).join("/") : u.file };
    }),
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
    const runB = candidate ? (b ? replayOn(c, b) : null) : runA;
    if (candidate && (!a || !b)) report.noRule.push({ ...ref, side: a ? "candidate" : "inUse", correction: c.correction !== null, expect: c.expect !== null });

    // The rule that made it, asked again of what it was given, has to give what it gave.
    if (runA && a?.sha256 && c.rule.sha256 === a.sha256) {
      report.selfChecked++;
      if (runA.missing.length > 0) report.selfCheck.push({ ...ref, fields: [`读了存档里没有的：${runA.missing.slice(0, 3).join("、")}`] });
      else if (canonical(c.outcome) !== canonical(runA.outcome)) {
        const d = diffOutcomes(c.outcome, runA.outcome);
        const fields = [...new Set([...d.judgment, ...d.facts, ...d.observe, ...d.text].map((x) => x.field))].slice(0, 5);
        report.selfCheck.push({ ...ref, fields: fields.length > 0 ? fields : ["其余的字段"] });
      }
    }

    if (candidate && runA && runB) {
      const lacking: Array<"inUse" | "candidate"> = [...(runA.missing.length > 0 ? (["inUse"] as const) : []), ...(runB.missing.length > 0 ? (["candidate"] as const) : [])];
      const diff = diffOutcomes(runA.outcome, runB.outcome);
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
    if (c.expect) holdToExpect(report, c, ref, runA, candidate ? runB : null, candidate !== null);
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
function holdToExpect(report: ReplayReport, c: Capsule, ref: CapsuleRef, runA: ReplayRun | null, runB: ReplayRun | null, compared: boolean): void {
  const expect = c.expect!;
  const said = c.correction?.said ?? null;
  const line = (unmet: Unmet[], why?: string): ExpectLine => ({ ...ref, unmet: texts(unmet), said, ...(why ? { why } : {}) });
  const sa = standingOf(expect, runA);
  if (!compared) {
    // Only the rules in use were asked: nothing to compare to, only whether the correction is met.
    if (sa.verdict === "unmet") report.expect.stillBroken.push(line(sa.unmet));
    else if (sa.verdict === "unknown") report.expect.unknown.push(line(sa.unmet, `在用的判断方法读了存档里没有的：${callsOf(runA)}`));
    return;
  }
  const sb = standingOf(expect, runB);
  if (sb.verdict === "none") {
    report.expect.unknown.push(line([], "候选没有判断方法管这个事项，核对不了"));
  } else if (sb.verdict === "unknown") {
    const partial = sb.unmet.length > 0 ? `拿存档里有的算，候选的答案已经不满足这几处` : "拿存档里有的算，候选的答案还满足";
    report.expect.unknown.push(line(sb.unmet, `候选读了存档里没有的（${callsOf(runB)}），${partial}；用候选重新补录一份存档才核对得了`));
  } else if (sa.verdict === "unknown") {
    // The candidate's answer is whole; the rule in use's is not, so what was met before cannot be told.
    if (sb.verdict === "unmet") report.expect.unknown.push(line(sb.unmet, `在用的判断方法读了存档里没有的（${callsOf(runA)}），分不清候选不满足的这几处是不是本来就不满足`));
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
  /** What `--accept-regress` is given for it: a capsule's id, or an unreadable capsule's path under the config. */
  name: string;
  kind: "broken" | "unknown" | "error" | "unreadable";
  label: string;
}

const when = (c: CapsuleRef) => c.at.slice(5, 16).replace("T", " ");

/** Everything the gate stops an apply for: a correction said again or not to be told, a candidate that fails where the rule in use does not, a person's capsule that cannot be read. */
export function stops(r: ReplayReport): Stop[] {
  return [
    ...r.expect.broken.map((e): Stop => ({ name: e.id, kind: "broken", label: `${e.label} ${when(e)}` })),
    ...r.expect.unknown.map((e): Stop => ({ name: e.id, kind: "unknown", label: `${e.label} ${when(e)}` })),
    ...r.errors.filter((e) => e.side === "candidate").map((e): Stop => ({ name: e.id, kind: "error", label: `${e.label} ${when(e)}` })),
    ...r.unreadable.filter((u) => u.kept).map((u): Stop => ({ name: u.name, kind: "unreadable", label: u.name })),
  ];
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
  // Unreadable: a person's stop an apply; the controller's are told, not stopped on.
  cut(
    r.unreadable.filter((u) => u.kept),
    5,
    (u) => `⚠ 读不了配置目录里留下的存档，它里面写的纠错没有拿来核对：${u.name}（${clip(u.error, 100)}）：修好它，或者删掉；不修也要拷的话，把这个路径写进 --accept-regress`,
    (n) => `⚠ 还有 ${n} 份配置目录里的存档读不了`,
  );
  cut(
    r.unreadable.filter((u) => !u.kept),
    3,
    (u) => `⚠ 读不了数据目录里的存档：${u.file.split(/[\\/]/).slice(-2).join("/")}（${clip(u.error, 100)}）`,
    (n) => `⚠ 还有 ${n} 份数据目录里的存档读不了`,
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
  if (r.missing.length > 0) out.push(`其中 ${r.missing.length} 份有一边读了存档里没有的东西（回放缺数据）：这几份的差异只作参考；判断方法多读了东西，要用候选重新补录才比得准。`);
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
  const kinds: Array<[keyof Diff, string]> = [["facts", "记下的事实不同"], ["observe", "要观察的不同"], ["text", "只差文字"]];
  for (const [kind, title] of kinds) {
    const some = r.changed.filter((c) => c.diff[kind].length > 0);
    if (some.length === 0) continue;
    const fields = new Map<string, number>();
    for (const c of some) for (const f of new Set(c.diff[kind].map((d) => d.field.replace(/^问题 [^：]+：/, "问题：")))) fields.set(f, (fields.get(f) ?? 0) + 1);
    out.push(`${title}（${some.length} 份）：${first([...fields], 8).map(([f, n]) => `${f}${n > 1 ? `×${n}` : ""}`).join("、")}${fields.size > 8 ? "…" : ""}`);
    if (kind === "observe") for (const c of first(some, 5)) out.push(`- ${c.label} ${when(c)}`, ...c.diff.observe.map((d) => `  ${d.field}：${clip(d.before, 60)} → ${clip(d.after, 60)}`));
  }
  for (const e of first(r.errors.filter((x) => x.side === "inUse"), 5)) out.push(`在用的在这份存档上判断出错、候选不出错：${e.label} ${when(e)}：${e.error}`);
  for (const n of first(r.noRule, 5)) out.push(`${n.side === "candidate" ? "候选不判断它" : "在用的不判断它，候选判断"}：${n.label} ${when(n)}`);
  for (const m of first(r.missing, 5)) {
    const sides = m.sides.map((s) => (s === "inUse" ? "在用" : "候选")).join("、");
    out.push(`回放缺数据（${sides}读了存档里没有的：${m.calls.join("、")}）：${m.label} ${when(m)}，结果只作参考${m.diff ? `（两边${m.diff.judgment.length > 0 ? "判断不同" : "只差记账和文字"}）` : ""}`);
  }
  if (r.missing.length > 5) out.push(`…还有 ${r.missing.length - 5} 份缺数据`);
  if (replayEmpty(r) && r.candidate !== "none") out.push(r.applicable === 0 ? "没有判断方法管这些存档，没有重放。" : "没有差异：每份存档在两版下得到同样的判断。");
  return out;
}
