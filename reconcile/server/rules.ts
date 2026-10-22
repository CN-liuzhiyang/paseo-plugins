import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Assessment, Commitment, Item, Note, Observation } from "../shared/model";
import { flagOf, linksOf, type FlagLink, type Vocabulary } from "./links";
import { addWorkdays, iso, workdaysBetween, zoned, type Calendar } from "./time";

// Rules are the deployment's private judgment: one ES module per file in <config>/rules, each
// a pure function from a case and a read-only context to an assessment. They are code, but the
// controller treats them like data: loaded by content fingerprint, scanned for the obvious ways
// to be nondeterministic, and their output checked against a closed vocabulary. This is not a
// sandbox -- a rule runs in this process with all of Node -- the safety is that only the person
// who owns the private config can change it.

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bDate\.now\b/, "Date.now (use ctx.now)"],
  [/new\s+Date\s*\(\s*\)/, "new Date() without an argument (use ctx.now)"],
  [/\bMath\.random\b/, "Math.random"],
  [/\bfetch\s*\(/, "fetch"],
  [/\bprocess\s*\./, "process"],
  [/\brequire\s*\(/, "require"],
  [/^\s*import\s/m, "import (a rule gets everything through ctx)"],
  [/\bimport\s*\(/, "dynamic import"],
];

export function scanRule(source: string): string | null {
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(source)) return `uses ${what}`;
  return null;
}

const option = z.object({ id: z.string().regex(/^[a-z0-9-]+$/), label: z.string().min(1), description: z.string() }).strict();

const commitmentSpec = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    domain: z.enum(["work", "personal", "family"]),
    owner: z.string().min(1),
    trigger: z.object({ at: z.string() }).strict(),
    ask: z
      .object({
        header: z.string().min(1).max(40),
        question: z.string().min(1),
        options: z.array(option).min(1).max(6),
        allowOther: z.boolean(),
      })
      .strict(),
    brief: z.string(),
    nag: z.object({ everyWorkdays: z.number().int().min(1), at: z.string().regex(/^\d{2}:\d{2}$/), max: z.number().int().min(1).max(10) }).strict(),
    backstop: z.object({ at: z.string() }).strict(),
    level: z.enum(["silent", "push"]),
    /**
     * What the question rests on besides the case's own source: item keys (a file of a file
     * source) or source ids (any of its files). Only these going stale hold it back. Absent:
     * whatever the rule read for the case (every item it looked up, and the switch files). A name
     * that is no configured source, file or known item fails the judgment.
     */
    uses: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();

export type CommitmentSpec = z.output<typeof commitmentSpec>;

const fact = z.object({ field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/), value: z.string(), evidence: z.string() }).strict();

/** Another case to judge again soon, e.g. one that waits on this one; it stays hot for a while. */
const wake = z.object({ caseId: z.string().min(1), reason: z.string().min(1).max(200) }).strict();

const output = z
  .object({
    stage: z.string().min(1),
    health: z.enum(["on-track", "waiting", "stalled", "blocked", "conflict", "done"]),
    headline: z.string().min(1).max(200),
    next: z.object({ actor: z.enum(["me", "them", "system", "nobody"]), what: z.string() }).strict(),
    facts: z.array(fact),
    commitments: z.array(commitmentSpec),
    wake: z.array(wake).optional(),
    /** A statement for the owner when something looks wrong; not a question, nothing to answer. */
    notice: z.string().min(1).max(300).optional(),
  })
  .strict();

export type RuleOutput = z.output<typeof output>;

export interface Case {
  id: string;
  primary: Item;
  items: Item[];
  /** Flag keys the item names in its text or its commits, with what each flag file says now (links.ts). */
  flags: FlagLink[];
}

export interface RuleContext {
  now: string;
  tz: string;
  params: Readonly<Record<string, unknown>>;
  item(key: string): Item | null;
  /** Other items under the same parent as this one (none when it has no parent). */
  siblings(key: string): Item[];
  observations(key: string): Observation[];
  notes(key: string): Record<string, Note>;
  commitments(caseId: string): Commitment[];
  /** What every flag file says about a key, e.g. one a person named; present: false where it is not. */
  flag(key: string): FlagLink;
  /** The flag keys another item names in its text or commits, as `kase.flags` is for this one. */
  flagsOf(key: string): FlagLink[];
  /**
   * Every item a rule follows that names a flag key, with how it names it, whether it is hot this
   * round, and its last stage. For deciding which of several items follows the key itself.
   */
  naming(flagKey: string): Array<{ item: Item; link: FlagLink; hot: boolean; stage: string | null }>;
  /** Whole workdays between two ISO instants. */
  workdaysBetween(from: string, to: string): number;
  /** The n-th workday after an ISO instant's date, at a local time, as ISO. */
  addWorkdays(from: string, n: number, time: string): string;
  /** A local date and time in the instance's zone, as ISO. */
  at(date: string, time: string): string;
  /** An instant written in the instance's zone, as ISO with its offset. */
  local(instant: string): string;
  /** Whether the source has succeeded recently enough that silence in it means something. */
  fresh(sourceId: string): boolean;
}

interface RuleModule {
  name: string;
  description: string;
  applies: { source: string };
  params: Record<string, unknown>;
  stages: string[];
  assess(kase: Case, ctx: RuleContext): unknown;
}

export interface LoadedRule {
  file: string;
  name: string;
  source: string;
  stages: string[];
  params: Record<string, unknown>;
  assess: RuleModule["assess"];
}

export interface RuleSet {
  fingerprint: string;
  files: string[];
  rules: LoadedRule[];
  errors: Array<{ file: string; error: string }>;
}

// Kept out of the bundler's sight: the host compiles this plugin to CommonJS, and a literal
// import() there would be rewritten into a require that cannot load an .mjs file.
const dynamicImport = new Function("url", "return import(url)") as (url: string) => Promise<{ default?: unknown }>;

export function fingerprintOf(dir: string): { fingerprint: string; files: Array<{ file: string; text: string }> } {
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".mjs"))
        .sort()
        .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), "utf8") }))
    : [];
  const hash = createHash("sha256");
  for (const { file, text } of files) hash.update(`${file}\0${text}\0`);
  return { fingerprint: hash.digest("hex").slice(0, 16), files };
}

const moduleSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  applies: z.object({ source: z.string().min(1) }).strict(),
  params: z.record(z.string(), z.unknown()),
  stages: z.array(z.string().min(1)).min(1),
  assess: z.custom<RuleModule["assess"]>((v) => typeof v === "function", "assess must be a function"),
});

export async function loadRules(dir: string): Promise<RuleSet> {
  const { fingerprint, files } = fingerprintOf(dir);
  const rules: LoadedRule[] = [];
  const errors: RuleSet["errors"] = [];
  for (const { file, text } of files) {
    const problem = scanRule(text);
    if (problem) {
      errors.push({ file, error: problem });
      continue;
    }
    try {
      const url = `${pathToFileURL(path.join(dir, file)).href}?v=${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
      const loaded = (await dynamicImport(url)).default;
      const parsed = moduleSchema.safeParse(loaded);
      if (!parsed.success) {
        errors.push({ file, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        continue;
      }
      const m = parsed.data;
      if (rules.some((r) => r.name === m.name)) {
        errors.push({ file, error: `a rule named "${m.name}" is already loaded` });
        continue;
      }
      rules.push({ file, name: m.name, source: m.applies.source, stages: m.stages, params: m.params, assess: m.assess });
    } catch (error) {
      errors.push({ file, error: (error as Error).message });
    }
  }
  return { fingerprint, files: files.map((f) => f.file), rules, errors };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface ContextInputs {
  nowMs: number;
  tz: string;
  calendar: Calendar;
  items: Record<string, Item>;
  recent: Record<string, Observation[]>;
  notes: Record<string, Record<string, Note>>;
  commitments: Record<string, Commitment>;
  fresh(sourceId: string): boolean;
  vocabulary?: Vocabulary;
  /** Each followed item's links and heat this round, worked out before any is judged. */
  links?: Map<string, FlagLink[]>;
  hot?: ReadonlySet<string>;
  assessments?: Record<string, Assessment>;
  /** Filled with the keys of the items the rule looks up: what its judgment rests on. */
  reads?: Set<string>;
}

export function makeContext(inputs: ContextInputs, params: Record<string, unknown>): RuleContext {
  const { tz, calendar } = inputs;
  const vocabulary = inputs.vocabulary ?? { files: [], keys: new Map(), sections: new Map(), changedAt: new Map(), aliases: new Map() };
  const copy = <T>(value: T): T => deepFreeze(structuredClone(value));
  const parseIso = (value: string) => {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new Error(`not an instant: ${value}`);
    return ms;
  };
  return Object.freeze({
    now: iso(inputs.nowMs, tz),
    tz,
    params: copy(params),
    item: (key: string) => (inputs.reads?.add(key), inputs.items[key] ? copy(inputs.items[key]) : null),
    siblings: (key: string) => {
      const parent = inputs.items[key]?.parent ?? null;
      return parent === null ? [] : copy(Object.values(inputs.items).filter((i) => i.parent === parent && i.key !== key));
    },
    observations: (key: string) => (inputs.reads?.add(key), copy(inputs.recent[key] ?? [])),
    notes: (key: string) => copy(inputs.notes[key] ?? {}),
    commitments: (caseId: string) => copy(Object.values(inputs.commitments).filter((c) => c.caseId === caseId)),
    flag: (key: string) => copy(flagOf(vocabulary, key)),
    flagsOf: (key: string) => (inputs.items[key] ? copy(inputs.links?.get(key) ?? linksOf(inputs.items[key], vocabulary)) : []),
    naming: (flagKey: string) => {
      const found: Array<{ item: Item; link: FlagLink; hot: boolean; stage: string | null }> = [];
      for (const [key, links] of inputs.links ?? new Map<string, FlagLink[]>()) {
        const link = links.find((l) => l.key === flagKey);
        const item = inputs.items[key];
        if (link && item) found.push({ item, link, hot: inputs.hot?.has(key) ?? false, stage: inputs.assessments?.[key]?.stage ?? null });
      }
      return copy(found);
    },
    workdaysBetween: (from: string, to: string) => workdaysBetween(parseIso(from), parseIso(to), tz, calendar),
    addWorkdays: (from: string, n: number, time: string) => iso(addWorkdays(parseIso(from), n, time, tz, calendar), tz),
    at: (date: string, time: string) => iso(zoned(date, time, tz), tz),
    local: (instant: string) => iso(parseIso(instant), tz),
    fresh: (sourceId: string) => inputs.fresh(sourceId),
  });
}

export interface Judged {
  assessment: Assessment;
  output: RuleOutput | null;
}

/** Runs the rule for a case. A throw or an output outside the vocabulary is an assessment with an error, not a crash. */
/** check: what the caller knows that the schema does not (names the output refers to); an error string fails it. */
export function judge(rule: LoadedRule, kase: Case, ctx: RuleContext, fingerprint: string, check?: (out: RuleOutput) => string | null): Judged {
  const base = { caseId: kase.id, at: ctx.now, rule: rule.name, rulesFingerprint: fingerprint, stale: false };
  const failed = (error: string): Judged => ({
    assessment: { ...base, stage: "error", health: "conflict", headline: `规则出错：${rule.name}`, next: { actor: "me", what: "看一眼规则" }, error },
    output: null,
  });
  let raw: unknown;
  try {
    raw = rule.assess(deepFreeze(structuredClone(kase)), ctx);
  } catch (error) {
    return failed(`${rule.file}: ${(error as Error).message}`);
  }
  const parsed = output.safeParse(raw);
  if (!parsed.success) return failed(`${rule.file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const out = parsed.data;
  if (!rule.stages.includes(out.stage)) return failed(`${rule.file}: stage "${out.stage}" is not one of the declared stages`);
  for (const spec of out.commitments) {
    for (const value of [spec.trigger.at, spec.backstop.at]) if (Number.isNaN(Date.parse(value))) return failed(`${rule.file}: not an instant: ${value}`);
    const ids = spec.ask.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) return failed(`${rule.file}: duplicate option ids in ${spec.key}`);
  }
  const wrong = check?.(out);
  if (wrong) return failed(`${rule.file}: ${wrong}`);
  return {
    assessment: { ...base, stage: out.stage, health: out.health, headline: out.headline, next: out.next, notice: out.notice ?? null, error: null },
    output: out,
  };
}
