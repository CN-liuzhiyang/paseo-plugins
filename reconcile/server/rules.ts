import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Assessment, Commitment, FlowResult, Item, Note, Observation } from "../shared/model";
import { normalizeStages, type StageMeta, type StageSpec } from "../shared/graph";
import { parseDuration } from "../shared/liveness.mjs";
import { flagOf, linksOf, type FlagLink, type Vocabulary } from "./links";
import { addWorkdays, iso, workdaysBetween, zoned, type Calendar } from "./time";
import type { Concluded } from "./observe";

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

/** The most `params` of one request may take, as JSON. */
export const OBSERVE_PARAMS_BYTES = 8 * 1024;
/** The longest a window, or a reread after it, may be. */
export const OBSERVE_SPAN_MINUTES = 7 * 24 * 60;

/**
 * Something to have watched by an observing source (a "command" source): read every few minutes
 * from `window.from` to `window.to`, then once `reread` minutes after it, each. The key is the
 * request's own (the same key asked again with another window is a new watch); `params` goes to
 * the command as it is.
 */
const observe = z
  .object({
    source: z.string().min(1),
    key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).max(200),
    window: z.object({ from: z.string(), to: z.string() }).strict(),
    reread: z.array(z.number().int().min(1).max(OBSERVE_SPAN_MINUTES)).max(6).default([]),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/** What a flow's name looks like to the runtime (orchestration/runtime/resolve.mjs). */
export const FLOW_NAME = /^[a-z][a-z0-9-]*$/;
/** The most a run's input may be, as JSON. */
export const RUN_INPUT_BYTES = 16 * 1024;
/** The most runs a rule may ask for in one judgment. */
export const RUNS_PER_JUDGMENT = 5;

/**
 * A flow this rule may have started for its items, under the rule's own name for it: the flow the
 * runtime is asked to run (by name; where it lives is the runtime's), how long a run may take, the
 * ceiling the day's budget counts one at while it runs (not enforced on the run), and whether the
 * person is told in a message when it ends.
 */
const flowDecl = z
  .object({
    flow: z.string().regex(FLOW_NAME),
    timeout: z.string().refine((t) => parseDuration(t) !== null, "not a duration such as 45m").optional(),
    maxUsd: z.number().positive().max(1000),
    notify: z.boolean().default(false),
    /**
     * The rule takes the failure of a run of this flow itself (it asks again under another key when it has to): a run that
     * came to no result is not the item's condition on the page, has no way-out buttons, and is not run again by a person.
     */
    selfRetry: z.boolean().optional(),
  })
  .strict();

export type FlowDecl = z.output<typeof flowDecl>;

const flowsDecl = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/), flowDecl);

/**
 * A run of a declared flow to have started for the case: asked for once per key. The same key given
 * again, however the run came out, is not run again (only a person's "run it again" adds a round).
 * `owner`: whom the end of the run is told to (persons.json id); absent: the admin.
 */
const runRequest = z
  .object({
    flow: z.string().min(1),
    key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).max(200),
    input: z.record(z.string(), z.unknown()).default({}),
    label: z.string().min(1).max(60),
    owner: z.string().min(1).optional(),
  })
  .strict();

const output = z
  .object({
    stage: z.string().min(1),
    health: z.enum(["on-track", "waiting", "stalled", "blocked", "conflict", "done"]),
    headline: z.string().min(1).max(200),
    /**
     * `since`: when it became this actor's move by what the rule can see (the step that has waited
     * on the owner since a time, say), an instant, ISO. The page counts the wait from it, so that a
     * rule changed or a judgment made later does not start the wait again.
     */
    next: z.object({ actor: z.enum(["me", "them", "system", "nobody"]), what: z.string(), since: z.string().min(1).optional() }).strict(),
    facts: z.array(fact),
    commitments: z.array(commitmentSpec),
    wake: z.array(wake).optional(),
    observe: z.array(observe).max(20).optional(),
    run: z.array(runRequest).max(RUNS_PER_JUDGMENT).optional(),
    /** A statement for the owner when something looks wrong; not a question, nothing to answer. */
    notice: z.string().min(1).max(300).optional(),
    /**
     * When the item got to this stage by what the rule can see (the day a commit landed, the day
     * it was done), when that is not now: the flow chart then tells when it happened apart from
     * when it was found out. An instant, ISO.
     */
    since: z.string().min(1).optional(),
  })
  .strict();

export type RuleOutput = z.output<typeof output>;
/** The output schema, for what reads a rule output back from a capsule. */
export const ruleOutputSchema = output;

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
  /** The latest changes of an item, oldest first: `at` by the source, `seenAt` when read, `readBefore` when last read without the change. */
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
  /**
   * The run of a flow this rule asked for under `name` (its `flows`) and `key` (its `run` output),
   * for this case: null when it was never asked for, else where it stands and, once there is one, its
   * result (`value`, as the flow returned it). The latest round: a person's "run it again" is a new one.
   * Not a source: reading it does not make the judgment depend on one.
   */
  run(name: string, key: string): FlowResult | null;
  /**
   * What an observing source found for a key this rule (or another) asked it to watch, as the
   * controller takes it: `verdict` is the command's, except that "no-signal" is "insufficient-data"
   * until the window has been watched to its end on data read in time (`why` says what is missing).
   * Null for a source that is not an observing one. `ctx.item` gives an observation's item with the
   * same `verdict` in its fields (the command's own is `verdict.reported`).
   */
  observation(sourceId: string, key: string): Concluded | null;
}

interface RuleModule {
  name: string;
  description: string;
  applies: { source: string };
  params: Record<string, unknown>;
  stages: Array<string | StageSpec>;
  assess(kase: Case, ctx: RuleContext): unknown;
}

export interface LoadedRule {
  file: string;
  name: string;
  /** The sha256 of the text that was loaded (what a capsule says it was judged by); absent on a rule made by hand in a test. */
  sha256?: string;
  source: string;
  /** The ids of the stages it declares. */
  stages: string[];
  /** What it says about them for the flow chart (labels, the usual route, detours, ends); absent on a rule made by hand in a test. */
  stageMeta?: StageMeta[];
  params: Record<string, unknown>;
  /** The flows it may have started, by its own names for them (the module's `export const flows`); none when it declares none. */
  flows?: Record<string, FlowDecl>;
  assess: RuleModule["assess"];
}

export interface RuleSet {
  /** Of the rules that run: the directory's files, one that does not load replaced by the copy of it that runs instead. */
  fingerprint: string;
  /** Of the directory as it is: when it changes, the rules are loaded again. */
  dirFingerprint: string;
  files: string[];
  rules: LoadedRule[];
  /** Files that do not load; fallback: the last copy of it that did (saved when that version first loaded, ISO) runs instead. */
  errors: Array<{ file: string; error: string; fallback?: string }>;
  /** Copies saved by this load (file, the text's sha256, the source its rule judges). */
  kept: Array<{ file: string; sha256: string | null; source?: string }>;
  /** Copies that could not be saved: a file that breaks later has nothing to go on with. */
  keepErrors: Array<{ file: string; error: string }>;
}

/** The directory under the data directory the copies are kept in. */
export const RULES_KEPT = "rules-last-good";

/**
 * Where the last copy of each rule file that loaded is kept, and whether this load may save there
 * (the controller does; a preview only reads it). A file that stops loading -- a syntax error, a
 * wrong shape, a forbidden call -- then goes on as that copy instead of its items going unjudged.
 * A copy is code that runs: one is used only if its sha256 is the one recorded when the controller
 * saved it (`known`), so that a file put there by anything else is not.
 */
export interface KeepRules {
  dir: string;
  write: boolean;
  /** The clock a copy's saving time is read from (its file's modified time); the wall clock if absent. */
  now?: () => number;
  /** The sha256 recorded for each copy saved, and only a copy that has it is used; absent: not checked (a caller with no record of its own). */
  known?: Record<string, string>;
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Kept out of the bundler's sight: the host compiles this plugin to CommonJS, and a literal
// import() there would be rewritten into a require that cannot load an .mjs file.
const dynamicImport = new Function("url", "return import(url)") as (url: string) => Promise<{ default?: unknown; flows?: unknown }>;

export function fingerprintOf(dir: string): { fingerprint: string; files: Array<{ file: string; text: string }> } {
  const files = existsSync(dir)
    ? readdirSync(dir)
        // A directory named like a rule is not one.
        .filter((f) => f.endsWith(".mjs") && statSync(path.join(dir, f)).isFile())
        .sort()
        .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), "utf8") }))
    : [];
  const hash = createHash("sha256");
  for (const { file, text } of files) hash.update(`${file}\0${text}\0`);
  return { fingerprint: hash.digest("hex").slice(0, 16), files };
}

/** A stage with its metadata (shared/graph.ts StageSpec); a bare id is also a stage. */
const stageSpec = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    next: z.array(z.string().min(1)).optional(),
    side: z.boolean().optional(),
    when: z.string().min(1).optional(),
    end: z.boolean().optional(),
    endKind: z.enum(["done", "dropped", "other"]).optional(),
    done: z.string().min(1).optional(),
  })
  .strict();

const moduleSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  applies: z.object({ source: z.string().min(1) }).strict(),
  params: z.record(z.string(), z.unknown()),
  stages: z.array(z.union([z.string().min(1), stageSpec])).min(1),
  assess: z.custom<RuleModule["assess"]>((v) => typeof v === "function", "assess must be a function"),
});

async function loadOne(file: string, text: string, loaded: LoadedRule[]): Promise<LoadedRule | { error: string }> {
  const problem = scanRule(text);
  if (problem) return { error: problem };
  try {
    // What runs is the text read -- scanned and, for a copy, checked -- not the file read again: a
    // file changed on disk after it was read does not run. (A rule imports nothing: scanRule.)
    const url = `data:text/javascript;base64,${Buffer.from(text, "utf8").toString("base64")}`;
    const mod = await dynamicImport(url);
    const parsed = moduleSchema.safeParse(mod.default);
    if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    const m = parsed.data;
    // Flows are declared on the module (`export const flows = {...}`), beside the default export, not in it: said so
    // rather than left out, as a `flows` inside the default export would otherwise be dropped without a word.
    if (mod.default && typeof mod.default === "object" && "flows" in mod.default) return { error: "flows: declare them as `export const flows = {...}` beside the default export, not inside it" };
    const declared = flowsDecl.safeParse(mod.flows ?? {});
    if (!declared.success) return { error: `flows: ${declared.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    let stageMeta: StageMeta[];
    try {
      stageMeta = normalizeStages(m.stages);
    } catch (error) {
      return { error: `stages: ${(error as Error).message}` };
    }
    if (loaded.some((r) => r.name === m.name)) return { error: `a rule named "${m.name}" is already loaded` };
    return { file, name: m.name, sha256: sha256(text), source: m.applies.source, stages: stageMeta.map((s) => s.id), stageMeta, params: m.params, flows: declared.data, assess: m.assess };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** The kept copy of a rule file and when it was saved; null when there is none; error when it cannot be read. */
function kept(dir: string, file: string): { text: string; at: string } | { error: string } | null {
  const full = path.join(dir, file);
  try {
    if (!existsSync(full)) return null;
    return { text: readFileSync(full, "utf8"), at: new Date(statSync(full).mtimeMs).toISOString() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** The rule files a copy is kept of. */
export function keptFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".mjs")) : [];
}

/** Takes a copy away. */
export function dropKept(dir: string, file: string): void {
  rmSync(path.join(dir, file), { force: true });
}

/** Saves a copy; false when the same text was there already. */
function keep(to: KeepRules, file: string, text: string): boolean {
  const there = kept(to.dir, file);
  if (there && "text" in there && there.text === text) return false;
  mkdirSync(to.dir, { recursive: true });
  const tmp = path.join(to.dir, `.${file}.tmp`);
  writeFileSync(tmp, text);
  if (to.now) utimesSync(tmp, new Date(to.now()), new Date(to.now()));
  renameSync(tmp, path.join(to.dir, file));
  return true;
}

export async function loadRules(dir: string, keepRules: KeepRules | null = null): Promise<RuleSet> {
  const { fingerprint: dirFingerprint, files } = fingerprintOf(dir);
  const rules: LoadedRule[] = [];
  const errors: RuleSet["errors"] = [];
  const keptNow: RuleSet["kept"] = [];
  const keepErrors: RuleSet["keepErrors"] = [];
  const running: Array<{ file: string; text: string }> = [];
  for (const { file, text } of files) {
    const loaded = await loadOne(file, text, rules);
    if (!("error" in loaded)) {
      rules.push(loaded);
      running.push({ file, text });
      if (keepRules?.write) {
        try {
          const sum = sha256(text);
          if (keep(keepRules, file, text) || keepRules.known?.[file] !== sum) keptNow.push({ file, sha256: sum, source: loaded.source });
        } catch (error) {
          keepErrors.push({ file, error: (error as Error).message });
        }
      }
      continue;
    }
    // Why no copy runs instead, when one does not: said with the file's own error.
    let why = "";
    const copy = keepRules ? kept(keepRules.dir, file) : null;
    if (copy && "error" in copy) why = `；副本读不了：${copy.error}`;
    else if (copy && keepRules!.known && keepRules!.known[file] === undefined) why = "；副本还没有记下哈希（刚换成核对副本的版本，要等这个文件再加载成功一次才记），没用它";
    else if (copy && keepRules!.known && keepRules!.known[file] !== sha256(copy.text)) why = "；副本和控制器存下时记的不一样，没用它";
    else if (copy && copy.text !== text) {
      const instead = await loadOne(file, copy.text, rules);
      if (!("error" in instead)) {
        rules.push(instead);
        running.push({ file, text: copy.text });
        errors.push({ file, error: loaded.error, fallback: copy.at });
        continue;
      }
      why = `；副本也加载不上：${instead.error}`;
    }
    // Nothing of it runs; its text still counts, so that fixing it is a change.
    running.push({ file, text });
    errors.push({ file, error: `${loaded.error}${why}` });
  }
  const hash = createHash("sha256");
  for (const { file, text } of running) hash.update(`${file}\0${text}\0`);
  return { fingerprint: hash.digest("hex").slice(0, 16), dirFingerprint, files: files.map((f) => f.file), rules, errors, kept: keptNow, keepErrors };
}

export function deepFreeze<T>(value: T): T {
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
  /** What an observation item comes to now (observe.ts); null: not an observing source's item. */
  observed?(itemKey: string): Concluded | null;
  /** The run of a flow asked for by the case being judged (server/flows.ts); absent: none was. */
  run?(name: string, key: string): FlowResult | null;
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
    item: (key: string) => {
      inputs.reads?.add(key);
      const found = inputs.items[key];
      if (!found) return null;
      // An observation is read as the controller takes it, whichever way the rule asks.
      const seen = found.kind === "observation" ? inputs.observed?.(key) : null;
      if (!seen) return copy(found);
      // All of it as concluded: nothing of what was read for another request than the one asked
      // (what it found, what the command said, when, for which request).
      const mine = seen.readAt !== null;
      const fields = Object.fromEntries(Object.entries(found.fields).filter(([field]) => field !== "numbers" && !field.startsWith("notes.") && (mine || (field !== "request" && field !== "observedAt"))));
      seen.notes.forEach((note, i) => (fields[`notes.${i}`] = note));
      if (seen.window) Object.assign(fields, { "window.from": seen.window.from, "window.to": seen.window.to });
      return copy({
        ...found,
        status: seen.verdict,
        observedAt: seen.readAt ?? "",
        fields: { ...fields, numbers: JSON.stringify(seen.numbers), freshUntil: seen.freshUntil ?? "", verdict: seen.verdict, "verdict.reported": seen.reported ?? "", "verdict.why": seen.why ?? "" },
      });
    },
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
    run: (name: string, key: string) => {
      const found = inputs.run?.(name, key) ?? null;
      return found ? copy(found) : null;
    },
    observation: (sourceId: string, key: string) => {
      inputs.reads?.add(`${sourceId}:${key}`);
      const seen = inputs.observed?.(`${sourceId}:${key}`) ?? null;
      return seen ? copy(seen) : null;
    },
  });
}

/**
 * How each member of the rule's context is recorded for a capsule (server/capsule.ts): `value` is
 * part of the capsule's clock (or the rule's own, `params`); `data` is read from the controller's
 * state, so each call is taped with what it gave; `derived` is worked out from the clock and the
 * holiday tables alone, so it is not taped and a replay works it out again. A member added to
 * RuleContext has to be classed here (the type will not let it go without), and a `data` member
 * that is not taped is a hole a replay falls into.
 */
export const CTX_KIND: Record<keyof RuleContext, "value" | "data" | "derived"> = {
  now: "value",
  tz: "value",
  params: "value",
  item: "data",
  siblings: "data",
  observations: "data",
  notes: "data",
  commitments: "data",
  flag: "data",
  flagsOf: "data",
  naming: "data",
  fresh: "data",
  run: "data",
  observation: "data",
  workdaysBetween: "derived",
  addWorkdays: "derived",
  at: "derived",
  local: "derived",
};

/** One call a rule made to a `data` member of its context, and what it was given. */
export interface CtxCall {
  m: string;
  args: unknown[];
  result: unknown;
}

/** The key a call is looked up by: the member and its arguments as JSON. */
export const callKey = (m: string, args: unknown[]): string => `${m}\u0000${JSON.stringify(args)}`;

/**
 * A context that hands the rule exactly what `ctx` does and tapes every call to a `data` member:
 * the first call of each (member, arguments) with its result as JSON. Nothing about the rule's
 * judgment changes; what the rule is given is the same objects.
 */
export function recordingContext(ctx: RuleContext): { ctx: RuleContext; calls(): CtxCall[] } {
  const taped = new Map<string, CtxCall>();
  const wrapped: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(ctx)) {
    if (typeof member !== "function" || CTX_KIND[name as keyof RuleContext] !== "data") {
      wrapped[name] = member;
      continue;
    }
    wrapped[name] = (...args: unknown[]) => {
      const result = (member as (...a: unknown[]) => unknown)(...args);
      const key = callKey(name, args);
      if (!taped.has(key)) taped.set(key, { m: name, args: JSON.parse(JSON.stringify(args)) as unknown[], result: result === undefined ? null : (JSON.parse(JSON.stringify(result)) as unknown) });
      return result;
    };
  }
  return { ctx: Object.freeze(wrapped) as unknown as RuleContext, calls: () => [...taped.values()] };
}

/** What `outputCheck` asks about names an output refers to. */
export interface OutputNames {
  /** A configured source id or a file of a file source ("<source>:<file>"). */
  known(name: string): boolean;
  /** A data item the controller already has. */
  item(key: string): boolean;
  /** A configured observing source (kind "command"). */
  observing(sourceId: string): boolean;
  /** A person of persons.json: whom a run's end is told to. */
  person(id: string): boolean;
}

/** What the controller knows that the schema does not: names an output refers to must exist. An error string fails the judgment. */
export function outputCheck(names: OutputNames): (out: RuleOutput) => string | null {
  return (out) => {
    const unknown = out.commitments.flatMap((spec) => (spec.uses ?? []).filter((u) => !names.known(u) && !names.item(u)));
    if (unknown.length > 0) return `uses 里的 ${unknown.map((u) => `"${u}"`).join("、")} 不是配置里的来源、文件或已有的数据项`;
    const notObserving = [...new Set((out.observe ?? []).map((o) => o.source).filter((id) => !names.observing(id)))];
    if (notObserving.length > 0) return `observe 里的 ${notObserving.map((u) => `"${u}"`).join("、")} 不是配置里的观察来源（kind: command）`;
    const strangers = [...new Set((out.run ?? []).map((r) => r.owner).filter((o): o is string => !!o && !names.person(o)))];
    return strangers.length > 0 ? `run 里的 owner ${strangers.map((u) => `"${u}"`).join("、")} 不是 persons.json 里的人` : null;
  };
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
    assessment: { ...base, stage: "error", health: "conflict", headline: `判断出错：${rule.name}`, next: { actor: "me", what: "看一眼判断文件" }, error },
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
  const keys = new Set<string>();
  for (const o of out.observe ?? []) {
    // What is kept of params, and handed on, is their JSON: taken as that from here on (a Date as
    // its string, an undefined left out), so that what is checked, stored and told apart by is it.
    try {
      o.params = JSON.parse(JSON.stringify(o.params)) as Record<string, unknown>;
    } catch (error) {
      return failed(`${rule.file}: observe ${o.key}: params are not JSON (${(error as Error).message})`);
    }
    const [from, to] = [Date.parse(o.window.from), Date.parse(o.window.to)];
    if (Number.isNaN(from) || Number.isNaN(to)) return failed(`${rule.file}: observe ${o.key}: window is not two instants`);
    if (to < from || to - from > OBSERVE_SPAN_MINUTES * 60_000) return failed(`${rule.file}: observe ${o.key}: window ends before it starts, or is longer than 7 days`);
    if (Buffer.byteLength(JSON.stringify(o.params), "utf8") > OBSERVE_PARAMS_BYTES) return failed(`${rule.file}: observe ${o.key}: params over ${OBSERVE_PARAMS_BYTES} bytes`);
    if (keys.has(`${o.source}:${o.key}`)) return failed(`${rule.file}: observe ${o.key} asked twice`);
    keys.add(`${o.source}:${o.key}`);
  }
  const runs = new Set<string>();
  for (const r of out.run ?? []) {
    if (!rule.flows?.[r.flow]) return failed(`${rule.file}: run ${r.key}: "${r.flow}" is not a flow this rule declares (export const flows)`);
    if (runs.has(`${r.flow}\0${r.key}`)) return failed(`${rule.file}: run ${r.key} asked twice`);
    runs.add(`${r.flow}\0${r.key}`);
    // The input is taken as its JSON from here on, like observe params: what is checked, kept and compared is one thing.
    try {
      r.input = JSON.parse(JSON.stringify(r.input)) as Record<string, unknown>;
    } catch (error) {
      return failed(`${rule.file}: run ${r.key}: input is not JSON (${(error as Error).message})`);
    }
    if (Buffer.byteLength(JSON.stringify(r.input), "utf8") > RUN_INPUT_BYTES) return failed(`${rule.file}: run ${r.key}: input over ${RUN_INPUT_BYTES} bytes`);
  }
  for (const spec of out.commitments) {
    for (const value of [spec.trigger.at, spec.backstop.at]) if (Number.isNaN(Date.parse(value))) return failed(`${rule.file}: not an instant: ${value}`);
    const ids = spec.ask.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) return failed(`${rule.file}: duplicate option ids in ${spec.key}`);
  }
  const wrong = check?.(out);
  if (wrong) return failed(`${rule.file}: ${wrong}`);
  return {
    assessment: { ...base, stage: out.stage, health: out.health, headline: out.headline, next: out.next, notice: out.notice ?? null, ...(out.since && !Number.isNaN(Date.parse(out.since)) ? { since: out.since } : {}), error: null },
    output: out,
  };
}
