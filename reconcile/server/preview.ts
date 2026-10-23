import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clockText, GROUP_LABEL, type ListRow, type StageMeta } from "../shared/graph";
import type { Assessment, Card, Commitment } from "../shared/model";
import { loadConfig, type Config } from "./config";
import { createEngine, RULES_BROKEN_MS, type Carrier, type Deliver } from "./engine";
import { nextStep } from "./policy";
import { fingerprintOf, loadRules, RULES_KEPT, type KeepRules, type LoadedRule } from "./rules";
import type { RulesDiff, State } from "./state";
import { memoryStore, readState } from "./store";
import { addWorkdays, inWindow, iso, localParts, nextInWindow } from "./time";

// A change to the rules, policy.json or persons.json, previewed before it is copied into the
// config the controller runs on (the controller loads its rules directory again as soon as a file
// in it changes, so a change made there is already in force). Two engines run on one copy of the
// controller's state as it is on disk, read and not taken: one on the config in use, one on the
// candidate, at the same moments, in memory, with nothing leaving the process. First now, then on
// through the next workdays at every moment either side asks, nags, expires or may reach someone
// again, and on the hour between. What differs is the preview -- the judgments, the questions, the
// cards, and what the page shows -- and its id changes with anything that changes the difference
// (the files, the horizon), so that apply copies only what was looked at.

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** How far a preview runs on by default; apply looks no shorter. */
export const WORKDAYS = 7;

/** The parts of a config a candidate may change, as they lie in a config directory. */
const PARTS = ["rules", "policy.json", "persons.json", "calendar"] as const;
const DIR_PART: Record<string, RegExp> = { rules: /\.mjs$/, calendar: /^\d{4}\.json$/ };

const HEALTH: Record<string, string> = { "on-track": "在走", waiting: "在等", stalled: "停住了", blocked: "卡住", conflict: "对不上", done: "结束" };

export interface Look {
  stage: string;
  health: string;
  headline: string;
  actor: string;
  what: string;
  notice: string | null;
  error: string | null;
}

/** One thing that differs, as people read it: what it is, and each side. */
export interface FieldChange {
  field: string;
  inUse: string;
  candidate: string;
}

export interface CaseChange {
  caseId: string;
  label: string;
  /** The headline when it is the same on both sides, for knowing which item it is. */
  headline: string | null;
  /** Every field that differs; never empty. */
  fields: FieldChange[];
  inUse: Look | null;
  candidate: Look | null;
}

export interface QuestionChange {
  /**
   * As the candidate differs: new, opened again, changed, or taken back; and against what the rules
   * in use do now: keep (in use takes it back, the candidate does not) or skip (in use adds it).
   */
  kind: "new" | "reopen" | "change" | "cancel" | "keep" | "skip";
  caseId: string | null;
  label: string;
  title: string;
  /** For a change: what changed, before and after. */
  fields: FieldChange[];
}

export interface CardNow {
  person: string;
  title: string;
  questions: string[];
  channels: string[];
}

export interface AskChange {
  label: string;
  title: string;
  round: number;
  /** When each side asks it ("现在", or MM-DD HH:mm); null: that side does not. */
  inUse: string | null;
  candidate: string | null;
}

export interface Preview {
  id: string;
  now: string;
  until: string;
  workdays: number;
  /** The candidate's files that differ from the config in use. */
  changedFiles: string[];
  inUse: { fingerprint: string | null; errors: Array<{ file: string; error: string; fallback?: string }> };
  candidate: { fingerprint: string | null; errors: Array<{ file: string; error: string; fallback?: string }> };
  /** The rules change would be held on the controller until someone lets it through. */
  breaker: { changes: { newCommitments: number; dropped: number; changed: number; reopened: number }; limit: number } | null;
  cases: CaseChange[];
  /** Of items both sides judge: hot on one side, cold on the other. */
  heat: Array<{ caseId: string; label: string; inUse: boolean; candidate: boolean }>;
  /** Items only one side judges at all: no rule of its loads for them on the other. */
  judged: { onlyInUse: string[]; onlyCandidate: string[] };
  questions: QuestionChange[];
  /** The cards each side raises now, when they differ. */
  cardsNow: { inUse: CardNow[]; candidate: CardNow[] } | null;
  later: {
    asks: AskChange[];
    expiries: Array<{ label: string; title: string; inUse: string | null; candidate: string | null }>;
    cardsPerDay: Array<{ date: string; inUse: number; candidate: number }>;
    cases: Array<{ caseId: string; label: string; from: string; headline: string | null; fields: FieldChange[]; inUse: Look | null; candidate: Look | null }>;
  };
  /** What the page shows differently (the list's rows, the stages the rules declare): not the breaker's business. */
  page: {
    rows: Array<{ caseId: string; label: string; fields: FieldChange[] }>;
    stages: Array<{ rule: string; changes: string[] }>;
  };
  /** Items both sides judge that are cold now on both: not judged, so a change to them is not seen. */
  coldBoth: number;
  caveats: string[];
  empty: boolean;
}

export interface PreviewOptions {
  /** The config in use (the plugin's configDir). */
  configDir: string;
  /** A directory laid out like it, holding the parts that change: rules/, policy.json, persons.json, calendar/. */
  candidateDir: string;
  /** The controller's data directory; read only. */
  dataDir: string;
  nowMs: number;
  /** How many workdays after today to run on through. */
  workdays?: number;
}

export class PreviewError extends Error {}

/** Files of a config's changeable parts: relative path -> text. */
function partFiles(dir: string, only?: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of PARTS) {
    if (only && !only.has(part)) continue;
    const full = path.join(dir, part);
    if (!existsSync(full)) continue;
    if (DIR_PART[part]) {
      if (!statSync(full).isDirectory()) continue;
      for (const f of readdirSync(full).filter((f) => DIR_PART[part]!.test(f)).sort()) {
        if (statSync(path.join(full, f)).isFile()) out.set(`${part}/${f}`, readFileSync(path.join(full, f), "utf8"));
      }
    } else {
      out.set(part, readFileSync(full, "utf8"));
    }
  }
  return out;
}

const partsIn = (dir: string) => new Set(PARTS.filter((p) => existsSync(path.join(dir, p))));

/** Where a path really is: links, junctions and short names undone; a part not there yet, as written under what is. */
function real(p: string): string {
  let probe = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(probe) && path.dirname(probe) !== probe) {
    rest.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
  try {
    return path.join(realpathSync.native(probe), ...rest);
  } catch {
    return path.join(probe, ...rest);
  }
}

/** A candidate inside the config in use (or holding it) would be in force as soon as it is written. */
function outside(configDir: string, dir: string): void {
  const a = real(configDir).toLowerCase();
  const b = real(dir).toLowerCase();
  if (a === b || b.startsWith(`${a}${path.sep}`) || a.startsWith(`${b}${path.sep}`)) throw new PreviewError("候选目录要放在在用的配置目录外面（在原处改，daemon 马上就会用上）");
}

/** A link in the candidate could lead anywhere, the config in use included: none is taken. */
function noLinks(candidateDir: string): void {
  for (const part of PARTS) {
    const full = path.join(candidateDir, part);
    if (!existsSync(full) && !isLink(full)) continue;
    if (isLink(full)) throw new PreviewError(`候选里的 ${part} 是个链接：候选要是实在的一份，不能链到别处`);
    if (DIR_PART[part] && statSync(full).isDirectory()) {
      for (const f of readdirSync(full)) if (isLink(path.join(full, f))) throw new PreviewError(`候选里的 ${part}/${f} 是个链接：候选要是实在的一份，不能链到别处`);
    }
  }
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

function checkDirs(configDir: string, candidateDir: string): void {
  if (!existsSync(candidateDir)) throw new PreviewError(`候选目录不存在：${candidateDir}`);
  outside(configDir, candidateDir);
  noLinks(candidateDir);
  if (existsSync(path.join(candidateDir, "sources.json"))) throw new PreviewError("候选里有 sources.json：来源的改动预览不了（推演不读来源），请拿掉它");
  if (partsIn(candidateDir).size === 0) throw new PreviewError(`候选目录里没有可预览的东西（${PARTS.join("、")}）`);
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** One engine on a copy of the state, with a carrier and channels that only record. */
function shadow(state: State, config: Config, clock: { ms: number }, rulesKeep: KeepRules | null) {
  const store = memoryStore(state, () => clock.ms);
  let raised = 0;
  const carrier: Carrier = {
    async raise() {
      return `preview-${++raised}`;
    },
    async archive() {},
    async ensure() {},
  };
  const deliveries: Array<{ cardId: string; channel: string }> = [];
  const deliver: Deliver = async (channel, message) => {
    deliveries.push({ cardId: message.idempotencyKey.split(":")[2] ?? "", channel });
  };
  const engine = createEngine({ store, config, sources: [], carrier, mode: "live", instanceId: "preview", home: "", tickSeconds: 60, deliver, requestsDir: null, conversation: null, rulesKeep, now: () => clock.ms, log: () => {}, writeStatus: () => {} });
  /** Every source as just read, with nothing new: the preview runs on the data as it is. */
  const freshen = () =>
    store.append(
      config.sources.map((s) => ({
        type: "source.state" as const,
        id: s.id,
        health: {
          state: "ok" as const,
          lastOkAt: iso(clock.ms, config.policy.tz),
          lastError: null,
          failures: 0,
          calls: [],
          nextPollAt: clock.ms + DAY,
          ...(s.kind === "flags" ? { readAt: Object.fromEntries(s.files.map((f) => [`${s.id}:${f.id}`, iso(clock.ms, config.policy.tz)])) } : {}),
        },
      })),
    );
  return { store, engine, deliveries, freshen };
}

const lookOf = (a: Assessment | undefined): Look | null =>
  a ? { stage: a.stage, health: a.health, headline: a.headline, actor: a.next.actor, what: a.next.what, notice: a.notice ?? null, error: a.error } : null;
const ACTOR: Record<string, string> = { me: "你", them: "别人", system: "系统", nobody: "没有人" };
/** A judgment's fields as people read them: every one that differs is shown, and nothing else counts. */
const LOOK_FIELDS: Array<[string, (l: Look) => string]> = [
  ["阶段", (l) => l.stage],
  ["现状", (l) => l.headline],
  ["健康", (l) => HEALTH[l.health] ?? l.health],
  ["在等谁", (l) => ACTOR[l.actor] ?? l.actor],
  ["下一步", (l) => l.what || "（没写）"],
  ["提醒", (l) => l.notice ?? "无"],
  ["判断出错", (l) => l.error ?? "无"],
];
/**
 * What differs between two judgments, field by field; one side without a judgment is one field. A
 * stage is compared by its id and shown with the name each side gives it (a name alone that
 * changes is the page's: stageChanges).
 */
function lookFields(a: Look | null, b: Look | null, names: [(id: string) => string, (id: string) => string]): FieldChange[] {
  if (!a || !b) return a === b ? [] : [{ field: "判断", inUse: a ? `${a.headline}（${names[0](a.stage)}）` : "（没有判断）", candidate: b ? `${b.headline}（${names[1](b.stage)}）` : "（没有判断）" }];
  return LOOK_FIELDS.filter(([, f]) => f(a) !== f(b)).map(([field, f]) => (field === "阶段" ? { field, inUse: names[0](a.stage), candidate: names[1](b.stage) } : { field, inUse: f(a), candidate: f(b) }));
}

/** What a list row shows, as people read it. */
const ROW_FIELDS: Array<[string, (r: ListRow) => string]> = [
  ["列表里的分组", (r) => GROUP_LABEL[r.group]?.name ?? r.group],
  ["阶段名", (r) => r.stageLabel],
  ["在等谁", (r) => r.who.label],
  ["等待从几点算起", (r) => (r.waiting.since ? clockText(r.waiting.since) : "（不算）")],
  ["岔路", (r) => r.side?.label ?? "无"],
];

/** How the stages a rule declares differ: added, gone, renamed, reordered, detours, ends, signs of being through. */
function stageChanges(a: StageMeta[], b: StageMeta[]): string[] {
  const out: string[] = [];
  const name = (s: StageMeta) => `「${s.label}」（${s.id}）`;
  for (const s of b) if (!a.some((x) => x.id === s.id)) out.push(`新加阶段 ${name(s)}`);
  for (const s of a) if (!b.some((x) => x.id === s.id)) out.push(`去掉阶段 ${name(s)}`);
  const common = (list: StageMeta[], other: StageMeta[]) => list.filter((s) => other.some((x) => x.id === s.id)).map((s) => s.id);
  if (common(a, b).join(" ") !== common(b, a).join(" ")) out.push(`阶段的顺序：${common(a, b).join(" → ")} 改成 ${common(b, a).join(" → ")}`);
  for (const x of a) {
    const y = b.find((s) => s.id === x.id);
    if (!y) continue;
    if (x.label !== y.label) out.push(`${x.id} 改名：「${x.label}」→「${y.label}」`);
    if (x.side !== y.side) out.push(`${name(y)} ${y.side ? "成了岔路" : "不再是岔路"}`);
    if (x.when !== y.when) out.push(`${name(y)} 走岔路的条件：${x.when ?? "无"} → ${y.when ?? "无"}`);
    if (x.end !== y.end || x.endKind !== y.endKind) out.push(`${name(y)} ${y.end ? `成了终点（${y.endKind}）` : "不再是终点"}${x.end && y.end ? `（原来 ${x.endKind}）` : ""}`);
    if (x.next.join(",") !== y.next.join(",")) out.push(`${name(y)} 的下一步：${x.next.join("、") || "（照顺序）"} → ${y.next.join("、") || "（照顺序）"}`);
    if (x.done !== y.done) out.push(`${name(y)} 到下一步的标志：${x.done ?? "无"} → ${y.done ?? "无"}`);
  }
  return out;
}
const isOpen = (c: Commitment | undefined) => !!c && (c.status === "scheduled" || c.status === "waiting");

const COMMITMENT_FIELDS: Array<[string, (c: Commitment) => string]> = [
  ["标题", (c) => c.title],
  ["什么时候问", (c) => ("at" in c.trigger ? c.trigger.at.slice(5, 16).replace("T", " ") : "人手动")],
  ["兜底时间", (c) => c.backstop.at.slice(5, 16).replace("T", " ")],
  ["问法", (c) => `${c.ask.question}（${c.ask.options.map((o) => o.label).join(" / ")}）`],
  ["追问", (c) => `每 ${c.nag.everyWorkdays} 个工作日 ${c.nag.at}，最多 ${c.nag.max} 次`],
  ["推送", (c) => (c.level === "push" ? "推送" : "不推送")],
  ["卡上的说明", (c) => c.brief],
];

export async function preview(options: PreviewOptions): Promise<Preview> {
  const { configDir, candidateDir, dataDir, nowMs } = options;
  const workdays = options.workdays ?? WORKDAYS;
  checkDirs(configDir, candidateDir);
  if (!existsSync(path.join(dataDir, "journal")) && !existsSync(path.join(dataDir, "snapshot.json"))) throw new PreviewError(`数据目录里没有日志：${dataDir}`);
  const inUseConfig = loadConfig(configDir);
  const candidateConfig = loadConfig(configDir, candidateDir);
  const parts = partsIn(candidateDir);
  const inUseFiles = partFiles(configDir, parts);
  const candidateFiles = partFiles(candidateDir, parts);
  const changedFiles = [...new Set([...inUseFiles.keys(), ...candidateFiles.keys()])].filter((f) => inUseFiles.get(f) !== candidateFiles.get(f)).sort();

  const { state } = readState(dataDir);
  const tz = inUseConfig.policy.tz;
  const clock = { ms: nowMs };
  // The rules in use go on as the controller's kept copies where a file does not load, as there;
  // the candidate's are what was written, broken or not.
  const kept: KeepRules = { dir: path.join(dataDir, RULES_KEPT), write: false };
  const base = shadow(state, inUseConfig, clock, kept);
  const cand = shadow(state, candidateConfig, clock, null);
  // The candidate's rules as they will be once let through: what the breaker would hold is said
  // apart, and what it holds back is still shown.
  const candidateFingerprint = fingerprintOf(candidateConfig.rulesDir).fingerprint;
  const released = state.rules.released.includes(candidateFingerprint);
  if (!released) cand.store.state.rules.released.push(candidateFingerprint);
  // The rules in use too, when the controller has not loaded them yet: they are what it runs next.
  // Held there already, they stay held: that is what it does.
  const inUseFingerprint = fingerprintOf(inUseConfig.rulesDir).fingerprint;
  if (inUseFingerprint !== state.rules.fingerprint && state.rules.held?.fingerprint !== inUseFingerprint) base.store.state.rules.released.push(inUseFingerprint);

  const sides = [base, cand];
  const marks: number[][] = [[], []];
  const looks: Array<{ at: number; looks: [Map<string, Look | null>, Map<string, Look | null>] }> = [];
  const until = addWorkdays(nowMs, workdays, "23:59", tz, inUseConfig.calendar);
  const persons = [...Object.values(inUseConfig.persons), ...Object.values(candidateConfig.persons)];
  const heatNow: Array<Set<string>> = [];
  const statusNow: Array<ReturnType<typeof base.engine.status>> = [];
  for (let at = nowMs, step = 0; at <= until; step++) {
    clock.ms = at;
    for (const [i, side] of sides.entries()) {
      side.freshen();
      await side.engine.tick();
      marks[i]!.push(side.store.events.length);
      if (step === 0) {
        const status = side.engine.status();
        statusNow.push(status);
        heatNow.push(new Set(status.cases.map((c) => c.caseId)));
      }
    }
    const caseIds = new Set([...Object.keys(base.store.state.assessments), ...Object.keys(cand.store.state.assessments)]);
    const pair: [Map<string, Look | null>, Map<string, Look | null>] = [new Map(), new Map()];
    for (const id of caseIds) {
      pair[0].set(id, lookOf(base.store.state.assessments[id]));
      pair[1].set(id, lookOf(cand.store.state.assessments[id]));
    }
    looks.push({ at, looks: pair });
    // The next moment either side does something: a question's next step, a broken rule file
    // told, someone reachable again, or the next hour (a judgment that changes with the time alone).
    let next = (Math.floor(at / HOUR) + 1) * HOUR;
    const sooner = (ms: number) => {
      if (ms > at && ms < next) next = ms;
    };
    for (const side of sides) {
      for (const c of Object.values(side.store.state.commitments)) sooner(nextStep(c, tz, inUseConfig.calendar)?.atMs ?? 0);
      for (const b of Object.values(side.store.state.rules.broken ?? {})) sooner(Date.parse(b.since) + RULES_BROKEN_MS);
    }
    for (const p of persons) {
      for (const w of Object.values(p.windows)) {
        if (!w || inWindow(at, w, p.tz, inUseConfig.calendar)) continue;
        sooner(nextInWindow(at, w, p.tz, inUseConfig.calendar));
      }
    }
    at = next;
  }

  const label = (caseId: string | null) => {
    if (!caseId) return "（不属于哪个事项）";
    const item = base.store.state.items[caseId];
    return `#${caseId.slice(caseId.lastIndexOf(":") + 1)}${item ? ` ${item.title}` : ""}`;
  };
  const when = (ms: number) => (ms === nowMs ? "现在" : iso(ms, tz).slice(5, 16).replace("T", " "));
  // The stages each side's rules declare, for their names and for what the page shows of them.
  const known = Object.fromEntries(Object.entries(state.rules.kept ?? {}).map(([file, k]) => [file, k.sha256]));
  const ruleSets = [await loadRules(inUseConfig.rulesDir, { ...kept, known }), await loadRules(candidateConfig.rulesDir, null)];
  const ruleFor = (i: number, caseId: string): LoadedRule | undefined => {
    const item = base.store.state.items[caseId] ?? cand.store.state.items[caseId];
    return item ? ruleSets[i]!.rules.find((r) => r.source === item.source) : undefined;
  };
  const names = (caseId: string): [(id: string) => string, (id: string) => string] =>
    [0, 1].map((i) => (id: string) => {
      const meta = ruleFor(i, caseId)?.stageMeta?.find((s) => s.id === id);
      return meta && meta.label !== id ? `${meta.label}（${id}）` : id;
    }) as [(id: string) => string, (id: string) => string];
  const headlineOf = (a: Look | null, b: Look | null) => (a && b && a.headline === b.headline ? a.headline : null);
  const nowEvents = (i: number) => sides[i]!.store.events.slice(0, marks[i]![0]);

  // ---- now --------------------------------------------------------------------------------
  const [b0, c0] = looks[0]!.looks;
  const cases: CaseChange[] = [];
  for (const [id, look] of b0) {
    const other = c0.get(id) ?? null;
    const fields = lookFields(look, other, names(id));
    if (fields.length > 0) cases.push({ caseId: id, label: label(id), headline: headlineOf(look, other), fields, inUse: look, candidate: other });
  }
  const heat: Preview["heat"] = [];
  const judgedBy = [0, 1].map((i) => new Set([...statusNow[i]!.cases, ...statusNow[i]!.cold].map((c) => c.caseId)));
  for (const id of judgedBy[0]!) {
    if (judgedBy[1]!.has(id) && heatNow[0]!.has(id) !== heatNow[1]!.has(id)) heat.push({ caseId: id, label: label(id), inUse: heatNow[0]!.has(id), candidate: heatNow[1]!.has(id) });
  }
  const judged = { onlyInUse: [...judgedBy[0]!].filter((id) => !judgedBy[1]!.has(id)).map(label).sort(), onlyCandidate: [...judgedBy[1]!].filter((id) => !judgedBy[0]!.has(id)).map(label).sort() };
  // Cold on both sides now: neither judges them, so what the candidate would make of them is not seen.
  const coldNow = [0, 1].map((i) => new Set(statusNow[i]!.cold.map((c) => c.caseId)));
  const coldBoth = [...coldNow[0]!].filter((id) => coldNow[1]!.has(id)).length;

  // What the page shows: an item's row in the list, of items both sides show; the stages a rule declares.
  const rowsOf = (i: number) => new Map(statusNow[i]!.cases.flatMap((c) => (c.row ? [[c.caseId, c.row] as const] : [])));
  const [br, cr] = [rowsOf(0), rowsOf(1)];
  const rows: Preview["page"]["rows"] = [];
  for (const [id, x] of br) {
    const y = cr.get(id);
    if (!y) continue;
    const fields = ROW_FIELDS.filter(([, f]) => f(x) !== f(y)).map(([field, f]) => ({ field, inUse: f(x), candidate: f(y) }));
    if (fields.length > 0) rows.push({ caseId: id, label: label(id), fields });
  }
  rows.sort((x, y) => x.label.localeCompare(y.label));
  const stages: Preview["page"]["stages"] = [];
  for (const x of ruleSets[0]!.rules) {
    const y = ruleSets[1]!.rules.find((r) => r.name === x.name);
    if (!y || !x.stageMeta || !y.stageMeta) continue;
    const changes = stageChanges(x.stageMeta, y.stageMeta);
    if (changes.length > 0) stages.push({ rule: x.name, changes });
  }

  // Questions: what is open after now on each side.
  const commitmentsAt = (i: number) => {
    const out = new Map<string, Commitment>();
    for (const c of Object.values(state.commitments)) out.set(c.id, c);
    for (const e of nowEvents(i)) {
      if (e.type === "commitment.created") out.set(e.commitment.id, e.commitment);
      if (e.type === "commitment.changed" && out.has(e.id)) out.set(e.id, { ...out.get(e.id)!, ...e.patch });
    }
    return out;
  };
  const bc = commitmentsAt(0);
  const cc = commitmentsAt(1);
  const questions: QuestionChange[] = [];
  for (const id of new Set([...bc.keys(), ...cc.keys()])) {
    const b = bc.get(id);
    const c = cc.get(id);
    const any = (c ?? b)!;
    const q = { caseId: any.caseId, label: label(any.caseId), title: any.title, fields: [] as QuestionChange["fields"] };
    const was = state.commitments[id];
    if (isOpen(c) && !isOpen(b)) questions.push({ ...q, kind: isOpen(was) ? "keep" : was ? "reopen" : "new" });
    else if (isOpen(b) && !isOpen(c)) questions.push({ ...q, kind: isOpen(was) ? "cancel" : "skip" });
    else if (isOpen(b) && isOpen(c)) {
      const fields = COMMITMENT_FIELDS.filter(([, f]) => f(b!) !== f(c!)).map(([field, f]) => ({ field, inUse: f(b!), candidate: f(c!) }));
      if (fields.length > 0) questions.push({ ...q, kind: "change", fields });
    }
  }
  const order: Record<QuestionChange["kind"], number> = { new: 0, reopen: 1, keep: 2, change: 3, cancel: 4, skip: 5 };
  questions.sort((x, y) => order[x.kind] - order[y.kind] || x.label.localeCompare(y.label));

  // Cards raised now, with the channels they go to.
  const cardsOf = (i: number, from: number, to: number) =>
    sides[i]!.store.events.slice(from, to).flatMap((e) => (e.type === "card.created" && !e.card.cutFrom ? [e.card] : []));
  const describeCard = (i: number, card: Card): CardNow => {
    const side = sides[i]!;
    const config = i === 0 ? inUseConfig : candidateConfig;
    const labels = (config.persons[card.person]?.notify ?? []).map((t) => [t.channel, t.label ?? t.channel] as const);
    const channels = side.deliveries.filter((d) => d.cardId === card.id).map((d) => labels.find(([ch]) => ch === d.channel)?.[1] ?? d.channel);
    return {
      person: config.persons[card.person]?.name ?? card.person,
      title: card.title,
      questions: card.commitments.map(({ id, round }) => `${side.store.state.commitments[id]?.ask.header ?? id}${round > 1 ? `（第 ${round} 次）` : ""}`),
      channels: [...new Set(channels)],
    };
  };
  const nowCards = [0, 1].map((i) => cardsOf(i, 0, marks[i]![0]).map((card) => describeCard(i, card)));
  const cardKey = (c: CardNow) => JSON.stringify([c.person, [...c.questions].sort(), [...c.channels].sort()]);
  const cardsNow = JSON.stringify(nowCards[0]!.map(cardKey).sort()) === JSON.stringify(nowCards[1]!.map(cardKey).sort()) ? null : { inUse: nowCards[0]!, candidate: nowCards[1]! };

  // ---- later ------------------------------------------------------------------------------
  const asksOf = (i: number) => {
    const out = new Map<string, number>();
    for (const e of sides[i]!.store.events) {
      if (e.type !== "action" || e.action.kind !== "ask" || e.action.status !== "planned") continue;
      const m = /^ask:(.+):(\d+)$/.exec(e.action.key);
      if (m && !out.has(`${m[1]}\u0000${m[2]}`)) out.set(`${m[1]}\u0000${m[2]}`, Date.parse(e.at));
    }
    return out;
  };
  // An ask made now that was due before now is told by when it was due: a preview a little before
  // that moment and one a little after show the same, and keep the same id.
  const dueAt = (id: string, round: number, ms: number) => {
    const c = state.commitments[id];
    const step = ms === nowMs && c ? nextStep(c, tz, inUseConfig.calendar) : null;
    return step && (step.what === "ask" || step.what === "nag") && step.round === round && step.atMs < nowMs ? step.atMs : ms;
  };
  const askWhen = (id: string, round: number, ms: number) => (dueAt(id, round, ms) === ms ? when(ms) : `现在（本该 ${when(dueAt(id, round, ms))}）`);
  const asks: AskChange[] = [];
  const asksDue: Array<[string, number, number | null, number | null]> = [];
  const [ba, ca] = [asksOf(0), asksOf(1)];
  for (const key of new Set([...ba.keys(), ...ca.keys()])) {
    const [id, round] = key.split("\u0000") as [string, string];
    const x = ba.get(key);
    const y = ca.get(key);
    if (x === y) continue;
    const c = cand.store.state.commitments[id] ?? base.store.state.commitments[id];
    const r = Number(round);
    asks.push({ label: label(c?.caseId ?? null), title: c?.title ?? id, round: r, inUse: x === undefined ? null : askWhen(id, r, x), candidate: y === undefined ? null : askWhen(id, r, y) });
    asksDue.push([id, r, x === undefined ? null : dueAt(id, r, x), y === undefined ? null : dueAt(id, r, y)]);
  }
  asksDue.sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1]);
  const firstAt = (a: AskChange) => [a.inUse, a.candidate].filter((t): t is string => !!t).map((t) => (t === "现在" ? "" : t)).sort()[0] ?? "";
  asks.sort((x, y) => firstAt(x).localeCompare(firstAt(y)) || x.label.localeCompare(y.label) || x.round - y.round);

  const expiriesOf = (i: number) => {
    const out = new Map<string, number>();
    for (const e of sides[i]!.store.events) if (e.type === "commitment.changed" && e.patch.status === "expired" && !out.has(e.id)) out.set(e.id, Date.parse(e.at));
    return out;
  };
  const [be, ce] = [expiriesOf(0), expiriesOf(1)];
  const expiries: Preview["later"]["expiries"] = [];
  for (const id of new Set([...be.keys(), ...ce.keys()])) {
    if (be.get(id) === ce.get(id)) continue;
    const c = cand.store.state.commitments[id] ?? base.store.state.commitments[id];
    expiries.push({ label: label(c?.caseId ?? null), title: c?.title ?? id, inUse: be.has(id) ? when(be.get(id)!) : null, candidate: ce.has(id) ? when(ce.get(id)!) : null });
  }

  const perDay = (i: number) => {
    const out = new Map<string, number>();
    for (const card of cardsOf(i, 0, sides[i]!.store.events.length)) {
      const date = localParts(Date.parse(card.raisedAt), tz).date;
      out.set(date, (out.get(date) ?? 0) + 1);
    }
    return out;
  };
  const [bd, cd] = [perDay(0), perDay(1)];
  const cardsPerDay = [...new Set([...bd.keys(), ...cd.keys()])]
    .sort()
    .filter((d) => (bd.get(d) ?? 0) !== (cd.get(d) ?? 0))
    .map((date) => ({ date: date.slice(5), inUse: bd.get(date) ?? 0, candidate: cd.get(date) ?? 0 }));

  const laterCases: Preview["later"]["cases"] = [];
  for (const id of b0.keys()) {
    if (cases.some((c) => c.caseId === id)) continue;
    for (const s of looks) {
      const [x, y] = [s.looks[0].get(id) ?? null, s.looks[1].get(id) ?? null];
      const fields = lookFields(x, y, names(id));
      if (fields.length === 0) continue;
      laterCases.push({ caseId: id, label: label(id), from: when(s.at), headline: headlineOf(x, y), fields, inUse: x, candidate: y });
      break;
    }
  }
  laterCases.sort((x, y) => x.from.localeCompare(y.from));

  // ---- the breaker, and what cannot be seen -----------------------------------------------
  const changed = nowEvents(1).find((e): e is Extract<typeof e, { type: "rules.changed" }> => e.type === "rules.changed");
  let breaker: Preview["breaker"] = null;
  if (changed && state.rules.fingerprint !== null && !released) {
    const d: RulesDiff = changed.diff;
    const changes = { newCommitments: d.newCommitments.length, dropped: d.droppedCommitments.length, changed: d.changedCommitments?.length ?? 0, reopened: d.reopenedCommitments?.length ?? 0 };
    const limit = inUseConfig.policy.ruleBreakerChanges;
    if (changes.newCommitments + changes.dropped + changes.changed + changes.reopened > limit) breaker = { changes, limit };
  }
  const caveats = [
    "推演里没有新数据：来源当作照常能读、读到的和现在一样。单子被人改了、开关文件变了，这些都不在里面。",
    "推演里没人回答卡片：问了就按追问的间隔一直问到上限，然后到兜底时间。对话里说的话、页面上的回答也都没有。",
    "两边都是在这份快照上重新跑的，在用的那边也不是 daemon 真的计划；判断方法要是读了 ctx 以外的东西（自己的变量、时间），两次跑的结果可能不一样。",
    `只推演到 ${iso(until, tz).slice(5, 10)}（往后 ${workdays} 个工作日）；更晚才起作用的改动看不到。`,
    "按整点取样，另外只停在要问、追问、兜底、可以打扰的起点这些时刻：判断方法里拿 ctx.now 和不在整点的时刻比，差别要到下一个整点才看得到，时间也算成那个整点。",
    "「在用」是配置目录里现在的文件，不是 daemon 内存里的：policy.json、persons.json、calendar/ 要 reload 才生效。拷过去以后、reload 以前，跑的是新的判断方法配旧的这几样，这个组合没有推演；在用目录里有改了还没 reload 的，这里也当它已经生效。",
    "diff 会把候选的判断方法当代码执行，和 daemon 加载它一样：「只读」指不写文件、不发消息，不是不执行。候选不是自己写的，先看过代码再 diff。",
  ];
  if (coldBoth > 0) caveats.push(`现在有 ${coldBoth} 个事项两边都是冷的：冷的不判断，它们在候选下会怎样，要等变热才看得到。`);
  const stale = inUseConfig.sources.filter((s) => {
    const h = state.sources[s.id]?.health;
    return !h?.lastOkAt || h.state === "down" || nowMs - Date.parse(h.lastOkAt) > 3 * Math.max(s.everyMinutes, s.offHoursEveryMinutes) * 60_000;
  });
  if (stale.length > 0) caveats.push(`现在 ${stale.map((s) => s.id).join("、")} 有一阵没读到了，推演按能读算；真跑时依赖它的问题会等它恢复。`);
  if (state.rules.held) caveats.push(`在用的 daemon 上有一版判断方法正被停着（${state.rules.held.fingerprint}），在用的这边按停着算。`);

  const local = (e: Preview["inUse"]["errors"][number]) => (e.fallback ? { ...e, fallback: iso(Date.parse(e.fallback), tz) } : e);
  const page = { rows, stages };
  // What was looked at: the files on both sides, how far on, and every difference. A later run with
  // the same id shows the same thing: moments now are "现在", an ask due before now is its due time,
  // and what an ask made this minute changes is left out -- the cards sent now, the list's rows
  // (they follow from the questions, the asks and each day's cards, which are in it, and from the
  // files; who may be reached this minute is not).
  const body = { changedFiles, inUse: statusNow[0]!.rules.fingerprint, candidate: statusNow[1]!.rules.fingerprint, breaker, cases, heat, judged, questions, later: { asks: asksDue, expiries, cardsPerDay, cases: laterCases }, stages };
  const id = `p_${hash(JSON.stringify({ files: [...inUseFiles], candidate: [...candidateFiles], workdays, body })).slice(0, 10)}`;
  const empty =
    cases.length + heat.length + judged.onlyInUse.length + judged.onlyCandidate.length + questions.length + asks.length + expiries.length + cardsPerDay.length + laterCases.length + rows.length + stages.length === 0 && !cardsNow;
  return {
    id,
    now: iso(nowMs, tz),
    until: iso(until, tz),
    workdays,
    changedFiles,
    inUse: { fingerprint: statusNow[0]!.rules.fingerprint, errors: statusNow[0]!.rules.errors.map(local) },
    candidate: { fingerprint: statusNow[1]!.rules.fingerprint, errors: statusNow[1]!.rules.errors.map(local) },
    breaker,
    cases,
    heat,
    judged,
    questions,
    cardsNow,
    later: { asks, expiries, cardsPerDay, cases: laterCases },
    page,
    coldBoth,
    caveats,
    empty,
  };
}

/** An item that changed: which, then each field that differs, in use → candidate. */
const caseLines = (c: { label: string; headline: string | null; fields: FieldChange[] }, from = "") => [
  `- ${c.label}${from}${c.headline ? `：${clip(c.headline, 60)}` : ""}`,
  ...c.fields.map((f) => `  ${f.field}：${clip(f.inUse, 80)} → ${clip(f.candidate, 80)}`),
];
const cardLine = (c: CardNow) => `发给 ${c.person}「${c.title}」（${c.questions.join("、")}${c.channels.length > 0 ? `；也发到 ${c.channels.join("、")}` : ""}）`;
const KIND_TEXT: Record<QuestionChange["kind"], string> = { new: "新排", reopen: "重新排上", keep: "留着（在用的这次会收回）", change: "改了", cancel: "收回", skip: "不排（在用的这次会新排）" };
const clip = (text: string, n: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The preview as a person reads it. */
export function previewText(p: Preview): string {
  const lines: string[] = [];
  lines.push(`改动预览 ${p.id}（现在 ${p.now.slice(5, 16).replace("T", " ")}，往后推演到 ${p.until.slice(5, 10)}，${p.workdays} 个工作日）`);
  lines.push(p.changedFiles.length > 0 ? `候选里和在用不同的文件：${p.changedFiles.join("、")}` : "候选里的文件和在用的一模一样。");
  for (const e of p.inUse.errors) lines.push(`⚠ 在用的判断方法 ${e.file} 现在就加载不上，${e.fallback ? `daemon 接着用 ${e.fallback.slice(5, 16).replace("T", " ")} 换上的那一版` : "它管的事项 daemon 现在都不判断"}：${e.error}`);
  for (const e of p.candidate.errors) lines.push(`⚠ 候选的判断方法 ${e.file} 加载不上，不能拷过去（拷过去 daemon 也只会接着用上一版）：${e.error}`);
  if (p.breaker) {
    const c = p.breaker.changes;
    const parts = [c.newCommitments && `新排 ${c.newCommitments}`, c.dropped && `收回 ${c.dropped}`, c.changed && `改动 ${c.changed}`, c.reopened && `重新排上 ${c.reopened}`].filter(Boolean).join("、");
    lines.push(`⚠ 这个改动一下子会${parts} 个要问的问题，超过了上限 ${p.breaker.limit}：拷过去以后，daemon 会先停着它，要在「事项追踪」页面上放行才生效。下面是放行以后的样子。`);
  }
  if (p.empty) {
    lines.push("", `没有差异：现在和往后这几个工作日，两版对事项的判断、要问的问题、发卡、页面上看到的都一样。${p.coldBoth > 0 ? `（${p.coldBoth} 个事项两边都是冷的，没判断）` : ""}`);
  } else {
    lines.push("", "## 现在");
    if (p.cases.length > 0) {
      lines.push(`事项的判断（${p.cases.length} 个变了，在用 → 候选）：`);
      for (const c of p.cases) lines.push(...caseLines(c));
    }
    if (p.heat.length > 0) {
      lines.push(`冷热（${p.heat.length} 个变了；冷的不判断、不显示）：`);
      for (const h of p.heat) lines.push(`- ${h.label}：在用${h.inUse ? "热" : "冷"}，候选${h.candidate ? "热" : "冷"}`);
    }
    const some = (labels: string[]) => `${labels.slice(0, 10).join("、")}${labels.length > 10 ? ` 等 ${labels.length} 个` : ""}`;
    if (p.judged.onlyInUse.length > 0) lines.push(`候选不再判断的事项（${p.judged.onlyInUse.length} 个，管它们的判断方法在候选里没有或者加载不上）：${some(p.judged.onlyInUse)}`);
    if (p.judged.onlyCandidate.length > 0) lines.push(`候选开始判断的事项（${p.judged.onlyCandidate.length} 个）：${some(p.judged.onlyCandidate)}`);
    if (p.questions.length > 0) {
      lines.push(`要问的问题（${p.questions.length} 个变了）：`);
      for (const q of p.questions) {
        lines.push(`- ${KIND_TEXT[q.kind]}：${q.label}「${q.title}」`);
        for (const f of q.fields) lines.push(`  ${f.field}：${clip(f.inUse, 80)} → ${clip(f.candidate, 80)}`);
      }
    }
    if (p.cardsNow) {
      lines.push("现在就会发的卡（按不打扰时段和每天的上限算）：");
      lines.push(...(p.cardsNow.inUse.length > 0 ? p.cardsNow.inUse.map((c) => `- 在用：${cardLine(c)}`) : ["- 在用：不发"]));
      lines.push(...(p.cardsNow.candidate.length > 0 ? p.cardsNow.candidate.map((c) => `- 候选：${cardLine(c)}`) : ["- 候选：不发"]));
    }
    if (p.cases.length + p.heat.length + p.judged.onlyInUse.length + p.judged.onlyCandidate.length + p.questions.length === 0 && !p.cardsNow) lines.push("（现在没有差异）");
    const l = p.later;
    lines.push("", `## 往后 ${p.workdays} 个工作日`);
    if (l.asks.length > 0) {
      lines.push(`会不会问、什么时候问（${l.asks.length} 处不同）：`);
      for (const a of l.asks) lines.push(`- ${a.label}「${a.title}」第 ${a.round} 次：在用${a.inUse ? ` ${a.inUse}` : "不问"}，候选${a.candidate ? ` ${a.candidate}` : "不问"}`);
    }
    if (l.cardsPerDay.length > 0) {
      lines.push("每天发几张卡：");
      for (const d of l.cardsPerDay) lines.push(`- ${d.date}：在用 ${d.inUse} 张，候选 ${d.candidate} 张`);
    }
    if (l.expiries.length > 0) {
      lines.push("到了兜底时间还没回答：");
      for (const e of l.expiries) lines.push(`- ${e.label}「${e.title}」：在用${e.inUse ? ` ${e.inUse} 到期` : "不到期"}，候选${e.candidate ? ` ${e.candidate} 到期` : "不到期"}`);
    }
    if (l.cases.length > 0) {
      lines.push("事项的判断后来变得不一样（在用 → 候选）：");
      for (const c of l.cases) lines.push(...caseLines(c, `（从 ${c.from} 起）`));
    }
    if (l.asks.length + l.cardsPerDay.length + l.expiries.length + l.cases.length === 0) lines.push("（往后没有别的差异）");
    if (p.page.rows.length + p.page.stages.length > 0) {
      lines.push("", "## 页面上看到的（不算进熔断）");
      if (p.page.rows.length > 0) {
        lines.push(`列表里的事项（${p.page.rows.length} 个变了，在用 → 候选）：`);
        for (const r of p.page.rows) lines.push(`- ${r.label}`, ...r.fields.map((f) => `  ${f.field}：${clip(f.inUse, 80)} → ${clip(f.candidate, 80)}`));
      }
      if (p.page.stages.length > 0) {
        lines.push("判断方法声明的阶段：");
        for (const s of p.page.stages) lines.push(`- ${s.rule}`, ...s.changes.map((c) => `  ${c}`));
      }
    }
  }
  lines.push("", "推演的局限：", ...p.caveats.map((c) => `- ${c}`));
  return lines.join("\n") + "\n";
}

/** Copies the config's changeable parts into dir, to be changed there and previewed. */
export function copyConfig(configDir: string, dir: string): string[] {
  outside(configDir, dir);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new PreviewError(`${dir} 不是空的，换一个目录`);
  const files = partFiles(configDir);
  for (const [rel, text] of files) writeFile(path.join(dir, rel), text);
  return [...files.keys()];
}

// Not named like a rule while it is written: the controller loads only *.mjs.
const tmpOf = (file: string) => path.join(path.dirname(file), `.${path.basename(file)}.tmp`);

function writeFile(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmpOf(file), text);
  renameSync(tmpOf(file), file);
}

/**
 * Writes files into dir, all or none: every text first beside its place, then each moved in, the
 * rules last (the controller loads them as soon as they change, the rest only on reload). A
 * failure puts back what was moved in, from the texts it replaced (old; a file not in it was new
 * and is taken away again), and says what was put back.
 */
function writeAll(dir: string, files: Array<[string, string]>, old: Map<string, string>): void {
  const order = [...files].sort(([a], [b]) => Number(a.startsWith("rules/")) - Number(b.startsWith("rules/")) || a.localeCompare(b));
  const done: string[] = [];
  try {
    for (const [rel, text] of order) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(tmpOf(path.join(dir, rel)), text);
    }
    for (const [rel] of order) {
      renameSync(tmpOf(path.join(dir, rel)), path.join(dir, rel));
      done.push(rel);
    }
  } catch (error) {
    const back: string[] = [];
    const stuck: string[] = [];
    for (const rel of done.reverse()) {
      try {
        if (old.has(rel)) writeFile(path.join(dir, rel), old.get(rel)!);
        else rmSync(path.join(dir, rel), { force: true });
        back.push(rel);
      } catch {
        stuck.push(rel);
      }
    }
    for (const [rel] of order) rmSync(tmpOf(path.join(dir, rel)), { force: true });
    const said = back.length > 0 ? `已经换上的 ${back.join("、")} 改回了原样` : "一个文件都还没换上，在用的没动";
    throw new PreviewError(`拷的时候出错，没拷（${(error as Error).message}）：${said}${stuck.length > 0 ? `；${stuck.join("、")} 没能改回去，要人去看` : ""}`);
  }
}

const sameFiles = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/**
 * Copies the candidate's changed files into the config in use, if a preview run now has the id
 * the person looked at; otherwise nothing, and the new preview. The candidate is read once, into
 * a directory of its own: that copy is what is previewed and what is written, and a candidate or
 * config in use that changed meanwhile stops it. A file the candidate leaves out of a directory it
 * has is not deleted: that is for a person to do. Looks on no shorter than WORKDAYS.
 */
export async function applyCandidate(options: PreviewOptions & { expect: string }): Promise<{ applied: string[]; preview: Preview }> {
  const workdays = options.workdays ?? WORKDAYS;
  if (workdays < WORKDAYS) throw new PreviewError(`拷之前至少要往后推演 ${WORKDAYS} 个工作日（这次是 ${workdays}）：看得太短，后面的差别看不到`);
  checkDirs(options.configDir, options.candidateDir);
  const parts = partsIn(options.candidateDir);
  const candidate = partFiles(options.candidateDir, parts);
  const inUse = partFiles(options.configDir, parts);
  const missing = [...inUse.keys()].filter((f) => !candidate.has(f));
  if (missing.length > 0) throw new PreviewError(`候选里少了 ${missing.join("、")}：删文件要人自己做，这里不删`);
  const snapshot = mkdtempSync(path.join(os.tmpdir(), "reconcile-apply-"));
  try {
    for (const part of parts) if (DIR_PART[part]) mkdirSync(path.join(snapshot, part), { recursive: true });
    for (const [rel, text] of candidate) writeFile(path.join(snapshot, rel), text);
    const p = await preview({ ...options, candidateDir: snapshot, workdays });
    if (p.candidate.errors.length > 0) throw new PreviewError(`候选的判断方法加载出错，不拷：${p.candidate.errors.map((e) => `${e.file}（${clip(e.error, 80)}）`).join("、")}`);
    if (p.id !== options.expect) return { applied: [], preview: p };
    const stillParts = [...partsIn(options.candidateDir)].join() === [...parts].join();
    if (!stillParts || !sameFiles(partFiles(options.candidateDir, parts), candidate) || !sameFiles(partFiles(options.configDir, parts), inUse)) {
      throw new PreviewError("预览的这几秒里，候选或者在用的文件变了，没拷：再 diff 一次，看改过以后的样子");
    }
    const applied = p.changedFiles.filter((f) => candidate.has(f));
    writeAll(options.configDir, applied.map((rel) => [rel, candidate.get(rel)!]), inUse);
    return { applied, preview: p };
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}
