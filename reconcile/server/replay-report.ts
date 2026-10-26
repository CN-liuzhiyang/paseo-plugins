import type { Capsule } from "./capsule";
import { canonical } from "./observe";
import { clip, diffOutcomes, noDiff, replayOn, unmet, verdictOf, type Diff } from "./replay";
import type { LoadedRule } from "./rules";

// A set of capsules asked of the rules in use and of a candidate: what differs between the two,
// what is amiss with the replay itself, and what people said was right and whether the candidate
// still says it. The preview (preview.ts) shows it and puts it in its id.

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
  /** What the candidate's answer does not meet. */
  unmet: string[];
  said: string | null;
}

export interface ReplayReport {
  /** Capsules read, and those some rule judges the item of. */
  capsules: number;
  applicable: number;
  unreadable: Array<{ file: string; error: string }>;
  /** run: the candidate was asked too; none: only the rules in use were (nothing to compare to); broken: the candidate does not load. */
  candidate: "run" | "none" | "broken";
  changed: Array<CapsuleRef & { diff: Diff }>;
  /** A side asked for what the capsule never saw: its answer is shown but not counted. */
  missing: Array<CapsuleRef & { sides: Array<"inUse" | "candidate">; calls: string[]; diff: Diff | null }>;
  /** A judgment that failed on one side only. */
  errors: Array<CapsuleRef & { side: "inUse" | "candidate"; error: string }>;
  /** Only one side has a rule for the item. */
  noRule: Array<CapsuleRef & { side: "inUse" | "candidate" }>;
  expect: { broken: ExpectLine[]; fixed: ExpectLine[]; stillBroken: ExpectLine[]; unknown: CapsuleRef[]; pending: CapsuleRef[] };
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

/**
 * Every capsule asked of the rules in use and of the candidate (absent: only of the rules in use,
 * to see that they still give what they gave). The rule for an item is the one whose source is the
 * item's, as the controller picks it.
 */
export function replayCapsules(capsules: Capsule[], inUse: LoadedRule[], candidate: LoadedRule[] | null, options: { unreadable?: ReplayReport["unreadable"]; broken?: boolean } = {}): ReplayReport {
  const report: ReplayReport = {
    capsules: capsules.length,
    applicable: 0,
    unreadable: options.unreadable ?? [],
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
    if (candidate && (!a || !b)) report.noRule.push({ ...ref, side: a ? "candidate" : "inUse" });

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
      if (lacking.length > 0) report.missing.push({ ...ref, sides: lacking, calls: [...new Set([...runA.missing, ...runB.missing])].slice(0, 5), diff: noDiff(diff) ? null : diff });
      else if ((runA.outcome.output === null) !== (runB.outcome.output === null)) {
        const side = runB.outcome.output === null ? "candidate" : "inUse";
        report.errors.push({ ...ref, side, error: clip((side === "candidate" ? runB : runA).outcome.error ?? "出错", 120) });
      } else if (!noDiff(diff)) report.changed.push({ ...ref, diff });
    }

    if (c.correction && !c.expect) report.expect.pending.push(ref);
    if (c.expect) {
      const expect = c.expect;
      const [va, vb] = [verdictOf(expect, runA), verdictOf(expect, runB)];
      const line = (): ExpectLine => ({ ...ref, unmet: runB ? unmet(expect, runB.outcome) : [], said: c.correction?.said ?? null });
      if (va === "unknown" || vb === "unknown") report.expect.unknown.push(ref);
      else if (vb === "unmet" && va === "met") report.expect.broken.push(line());
      else if (vb === "met" && va === "unmet") report.expect.fixed.push(line());
      else if (vb === "unmet") report.expect.stillBroken.push(line());
    }
  }
  return report;
}

/** The part of a report that goes into a preview's id: what differs between the two sides, and what is amiss with the replay. */
export function replayDigest(r: ReplayReport): unknown {
  return {
    changed: r.changed.map((x) => [x.id, x.diff]),
    missing: r.missing.map((x) => [x.id, x.sides, x.calls]),
    errors: r.errors.map((x) => [x.id, x.side]),
    noRule: r.noRule.map((x) => [x.id, x.side]),
    broken: r.expect.broken.map((x) => [x.id, x.unmet]),
    fixed: r.expect.fixed.map((x) => x.id),
    selfCheck: r.selfCheck.map((x) => [x.id, x.fields]),
  };
}

/** Nothing in it differs between the two sides, and nothing is amiss with the replay itself. */
export const replayEmpty = (r: ReplayReport): boolean =>
  r.changed.length + r.missing.length + r.errors.length + r.noRule.length + r.expect.broken.length + r.expect.fixed.length + r.selfCheck.length === 0;

/** The ids of the corrections a candidate says again what was said wrong. */
export const regressions = (r: ReplayReport): string[] => r.expect.broken.map((e) => e.id);

const when = (c: CapsuleRef) => c.at.slice(5, 16).replace("T", " ");
const WHY: Record<string, string> = { first: "第一次判断", stage: "换阶段", questions: "要问的变了", notice: "提醒变了", error: "判断出错", sample: "每天的样本", wrong: "说判断错了" };
const why = (c: CapsuleRef) => `${c.trigger.map((t) => WHY[t] ?? t).join("、")}${c.origin === "backfill" ? "，补录的" : ""}`;

/** What is wrong with the candidate or with the replay itself: shown at the top of a preview. */
export function replayWarnings(r: ReplayReport): string[] {
  const out: string[] = [];
  for (const e of r.expect.broken.slice(0, 10)) out.push(`⚠ 纠错又犯了：${e.label} ${when(e)}（${e.id}）${e.said ? `，说过：「${clip(e.said, 40)}」` : ""}：候选${e.unmet.map((u) => clip(u, 60)).join("；")}`);
  if (r.expect.broken.length > 10) out.push(`⚠ 还有 ${r.expect.broken.length - 10} 条纠错又犯了`);
  for (const e of r.errors.filter((x) => x.side === "candidate").slice(0, 10)) out.push(`⚠ 候选在这份存档上判断出错，在用的不出错：${e.label} ${when(e)}（${why(e)}）：${e.error}`);
  for (const s of r.selfCheck.slice(0, 10)) out.push(`⚠ 存档复现不了：${s.label} ${when(s)}，在用的判断方法和存下它时是同一版，拿存档里的数据再判断一遍，结果却不一样（${s.fields.join("、")}）：重放不可信，先查原因`);
  return out;
}

/** The replay as a person reads it: a section of the preview. */
export function replayLines(r: ReplayReport): string[] {
  const out: string[] = ["## 拿过去的判断时刻重放"];
  if (r.capsules === 0) return [...out, `没有存档（数据目录的 capsules/ 和配置目录的 cases/ 里都没有）：reconcile-preview cases backfill 可以从日志补一批。${r.unreadable.length > 0 ? `读不了 ${r.unreadable.length} 份。` : ""}`];
  const mode = r.candidate === "run" ? "在用、候选各判断一遍，比的是这两遍" : r.candidate === "broken" ? "候选的判断方法加载不上，只拿在用的判断一遍" : "只拿在用的判断一遍（没有候选）";
  out.push(`存档 ${r.capsules} 份，有判断方法管着的 ${r.applicable} 份；${mode}。`);
  out.push(
    r.selfChecked === 0
      ? "没有一份是在用的这一版判断方法存下的（存下它们的判断方法后来改过），存档里记的答案没拿来核对。"
      : `其中 ${r.selfChecked} 份是在用的这一版判断方法存下的，拿存档再判断一遍：${r.selfCheck.length > 0 ? `${r.selfCheck.length} 份和存下的不一样（见 ⚠）` : "答案和存下的一样"}。`,
  );
  const first = <T>(xs: T[], n: number) => xs.slice(0, n);
  const list = (xs: CapsuleRef[], n = 5) => `${first(xs, n).map((e) => `${e.label} ${when(e)}`).join("、")}${xs.length > n ? "…" : ""}`;
  if (r.unreadable.length > 0) out.push(`读不了的存档 ${r.unreadable.length} 份：${first(r.unreadable, 3).map((u) => `${u.file.split(/[\\/]/).slice(-2).join("/")}（${clip(u.error, 60)}）`).join("；")}${r.unreadable.length > 3 ? "…" : ""}`);
  if (r.expect.fixed.length > 0) out.push(`修好了 ${r.expect.fixed.length} 条纠错：${list(r.expect.fixed)}`);
  if (r.expect.stillBroken.length > 0) out.push(`还没修好的纠错 ${r.expect.stillBroken.length} 条（候选和在用的一样不满足）：${list(r.expect.stillBroken)}`);
  if (r.expect.pending.length > 0) out.push(`还没写 expect 的纠错 ${r.expect.pending.length} 条：${first(r.expect.pending, 5).map((e) => `${e.label} ${when(e)}（${e.id}）`).join("、")}（reconcile-preview cases expect --id … --expect <文件>）`);
  if (r.expect.unknown.length > 0) out.push(`有 expect、但有一边读了存档里没有的数据，不下结论：${list(r.expect.unknown)}`);
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
  if (replayEmpty(r) && r.candidate !== "none") out.push("没有差异：每份存档在两版下得到同样的判断。");
  return out;
}
