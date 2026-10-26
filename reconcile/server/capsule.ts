import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { canonical } from "./observe";
import { ruleOutputSchema, type Case, type CtxCall, type Judged, type LoadedRule, type RuleOutput } from "./rules";
import type { CalendarYear } from "./time";

// A capsule is one judgment of one item kept so that it can be made again: the item as the rule
// was given it, every call the rule made to its context (server/rules.ts recordingContext) with
// what it was given, the clock and the holiday tables of that moment, and what the rule said. A
// replay (replay.ts) hands a rule exactly that and nothing else, so the same rule gives the same
// answer and another version of it can be asked what it would have said. It is kept as JSON,
// gzipped when it is written by the controller; the ones people keep (the private config's
// cases/) are plain.

export const CAPSULE_VERSION = 1;

const oneOf = <T extends [string, ...string[]]>(values: T) => z.union([z.enum(values), z.array(z.enum(values)).min(1)]);

/**
 * What a person says is right for a capsule's moment, for the items they care about: every item
 * written is to hold, the ones not written are not looked at. A stage may be given as a list (any
 * of them); `asks` goes by the start of a commitment's key, which carries dates and rounds; a fact
 * written as null is one that must not be there.
 */
export const expectSchema = z
  .object({
    stage: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    health: oneOf(["on-track", "waiting", "stalled", "blocked", "conflict", "done"]),
    actor: oneOf(["me", "them", "system", "nobody"]),
    error: z.boolean(),
    notice: z.boolean(),
    asks: z.object({ has: z.array(z.string().min(1)), none: z.array(z.string().min(1)) }).partial().strict(),
    facts: z.record(z.string(), z.string().nullable()),
    headline: z.object({ has: z.array(z.string().min(1)), not: z.array(z.string().min(1)) }).partial().strict(),
  })
  .partial()
  .strict()
  .refine((e) => Object.keys(e).length > 0, "expect says nothing");

export type Expect = z.output<typeof expectSchema>;

export interface CapsuleOutcome {
  /** What the rule said, as the controller took it; null when the judgment failed. */
  output: RuleOutput | null;
  /** Why it failed. */
  error: string | null;
}

/** An assessment as the page showed it (a correction says which one it was about). */
export interface ShownJudgment {
  at: string;
  rule: string;
  stage: string;
  health: string;
  headline: string;
  actor: string;
  what: string;
}

export interface Capsule {
  v: typeof CAPSULE_VERSION;
  /** Of the tape: the same inputs at the same moment are the same capsule. */
  id: string;
  case: string;
  /** The judgment's `ctx.now`. */
  at: string;
  /** The journal's position when it was made; null when not known. */
  seq: number | null;
  instance: string | null;
  /** Why it was kept: first, stage, questions, notice, error, sample, wrong. */
  trigger: string[];
  /** live: kept by the controller as it judged; backfill: made later from the journal with the rule in use then. */
  origin: "live" | "backfill";
  rule: { name: string; file: string; sha256: string | null; fingerprint: string };
  clock: { now: string; tz: string; calendar: Record<string, CalendarYear> };
  /** What a check of the output (outputCheck) asks about. */
  names: { known: string[]; items: string[]; observing: string[] };
  kase: Case;
  calls: CtxCall[];
  outcome: CapsuleOutcome;
  /** Backfill: the judgment the journal holds for this moment, for reference. */
  logged: ShownJudgment | null;
  /** A correction: what the page showed when someone said it was wrong. */
  shown: ShownJudgment | null;
  correction: { annotation: string; said: string; what: string | null; expected: string | null; at: string; by: string } | null;
  expect: Expect | null;
}

const shown = z.object({ at: z.string(), rule: z.string(), stage: z.string(), health: z.string(), headline: z.string(), actor: z.string(), what: z.string() }).strict();
const year = z.object({ holidays: z.array(z.string()), workdays: z.array(z.string()) }).strict();

const capsuleSchema = z
  .object({
    v: z.literal(CAPSULE_VERSION),
    id: z.string().regex(/^k_[0-9a-f]{16}$/),
    case: z.string().min(1),
    at: z.string().min(1),
    seq: z.number().int().nullable(),
    instance: z.string().nullable(),
    trigger: z.array(z.string().min(1)).min(1),
    origin: z.enum(["live", "backfill"]),
    rule: z.object({ name: z.string(), file: z.string(), sha256: z.string().nullable(), fingerprint: z.string() }).strict(),
    clock: z.object({ now: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "not an instant"), tz: z.string().min(1), calendar: z.record(z.string(), year) }).strict(),
    names: z.object({ known: z.array(z.string()), items: z.array(z.string()), observing: z.array(z.string()) }).strict(),
    kase: z.object({ id: z.string(), primary: z.looseObject({ key: z.string(), source: z.string() }), items: z.array(z.unknown()), flags: z.array(z.unknown()) }).strict(),
    calls: z.array(z.object({ m: z.string(), args: z.array(z.unknown()), result: z.unknown() }).strict()),
    outcome: z.object({ output: ruleOutputSchema.nullable(), error: z.string().nullable() }).strict(),
    logged: shown.nullable(),
    shown: shown.nullable(),
    correction: z.object({ annotation: z.string(), said: z.string(), what: z.string().nullable(), expected: z.string().nullable(), at: z.string(), by: z.string() }).strict().nullable(),
    expect: expectSchema.nullable(),
  })
  .strict();

/** A capsule read back: checked, so that what a replay does with it cannot fail on its shape. */
export function parseCapsule(value: unknown): Capsule {
  if (value && typeof value === "object" && "v" in value && (value as { v: unknown }).v !== CAPSULE_VERSION) throw new Error(`不认识的存档版本：v=${String((value as { v: unknown }).v)}`);
  const parsed = capsuleSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  return parsed.data as unknown as Capsule;
}

/** What makes two capsules the same: the item, the moment, the clock and everything the rule was given. */
export function capsuleId(c: Pick<Capsule, "case" | "clock" | "names" | "kase" | "calls">): string {
  return `k_${createHash("sha256").update(canonical([c.case, c.clock, c.names, c.kase, c.calls])).digest("hex").slice(0, 16)}`;
}

export interface CaptureInput {
  kase: Case;
  calls: CtxCall[];
  judged: Judged;
  rule: LoadedRule;
  fingerprint: string;
  now: string;
  tz: string;
  calendar: Record<string, CalendarYear>;
  names: { known: Iterable<string>; items: Iterable<string>; observing: Iterable<string> };
  trigger: string[];
  origin: Capsule["origin"];
  seq?: number | null;
  instance?: string | null;
  logged?: ShownJudgment | null;
  shown?: ShownJudgment | null;
  correction?: Capsule["correction"];
  expect?: Expect | null;
}

const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A capsule of a judgment just made. Everything in it is JSON already, so it is the same as one read back. */
export function buildCapsule(input: CaptureInput): Capsule {
  const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
  const body = {
    case: input.kase.id,
    clock: { now: input.now, tz: input.tz, calendar: asJson(input.calendar) },
    names: { known: sorted(input.names.known), items: sorted(input.names.items), observing: sorted(input.names.observing) },
    kase: asJson(input.kase),
    calls: asJson(input.calls),
  };
  return {
    v: CAPSULE_VERSION,
    id: capsuleId(body),
    case: body.case,
    at: input.now,
    seq: input.seq ?? null,
    instance: input.instance ?? null,
    trigger: input.trigger,
    origin: input.origin,
    rule: { name: input.rule.name, file: input.rule.file, sha256: input.rule.sha256 ?? null, fingerprint: input.fingerprint },
    clock: body.clock,
    names: body.names,
    kase: body.kase,
    calls: body.calls,
    outcome: input.judged.output ? { output: asJson(input.judged.output), error: null } : { output: null, error: input.judged.assessment.error ?? "判断出错" },
    logged: input.logged ?? null,
    shown: input.shown ?? null,
    correction: input.correction ?? null,
    expect: input.expect ?? null,
  };
}

// ---- files ---------------------------------------------------------------------------------

/** The most a capsule may be on disk (compressed) and unpacked: a file bigger than that is not read. */
export const CAPSULE_FILE_BYTES = 8 * 1024 * 1024;
export const CAPSULE_TEXT_BYTES = 32 * 1024 * 1024;

const FILE = /\.json(\.gz)?$/;

/** The directory name an item's capsules go in under the root. */
export const caseDir = (caseId: string): string => caseId.replace(/[^A-Za-z0-9._-]/g, "_");

/** The file name of a capsule: when, why, and which. */
export function capsuleFile(c: Pick<Capsule, "id" | "at" | "trigger">, gzip: boolean): string {
  const stamp = c.at.slice(0, 16).replace(/[-:]/g, "").replace(/[^0-9T]/g, "");
  return `${stamp}-${c.trigger[0]!.replace(/[^a-z0-9-]/g, "_")}-${c.id.slice(2, 10)}.json${gzip ? ".gz" : ""}`;
}

/** Where a capsule is written under a root. */
export const capsulePath = (root: string, capsule: Pick<Capsule, "case" | "id" | "at" | "trigger">, gzip: boolean): string => path.join(root, caseDir(capsule.case), capsuleFile(capsule, gzip));

/**
 * Writes a capsule under `root/<item>/`, into a temporary file first. A capsule of the same id
 * (and trigger) already there is left as it is; returns the path either way.
 */
export function writeCapsule(root: string, capsule: Capsule, options: { gzip?: boolean } = {}): string {
  const gzip = options.gzip ?? true;
  const file = capsulePath(root, capsule, gzip);
  if (existsSync(file)) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, gzip ? gzipSync(JSON.stringify(capsule)) : `${JSON.stringify(capsule, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return file;
}

/** A capsule file read: the capsule, or why it cannot be. */
export function readCapsule(file: string): { capsule: Capsule } | { error: string } {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) return { error: "不是普通文件" };
    if (stat.size > CAPSULE_FILE_BYTES) return { error: `文件超过 ${CAPSULE_FILE_BYTES / 1024 / 1024} MB，没读` };
    const raw = readFileSync(file);
    const text = file.endsWith(".gz") ? gunzipSync(raw, { maxOutputLength: CAPSULE_TEXT_BYTES }).toString("utf8") : raw.toString("utf8");
    return { capsule: parseCapsule(JSON.parse(text)) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** The capsule files under a directory, in order; a link, a hidden file or a half-written one is not one. */
export function capsuleFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (stat.isFile() && FILE.test(name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

export interface LoadedCapsules {
  capsules: Array<{ file: string; capsule: Capsule }>;
  unreadable: Array<{ file: string; error: string }>;
}

/**
 * Every capsule under the roots, oldest first. One with the same id in a later root takes the
 * place of the earlier one: the cases a person keeps (private config) win over the controller's.
 */
export function loadCapsules(roots: string[]): LoadedCapsules {
  const byId = new Map<string, { file: string; capsule: Capsule }>();
  const unreadable: LoadedCapsules["unreadable"] = [];
  for (const root of roots) {
    for (const file of capsuleFiles(root)) {
      const read = readCapsule(file);
      if ("error" in read) unreadable.push({ file, error: read.error });
      else byId.set(read.capsule.id, { file, capsule: read.capsule });
    }
  }
  const capsules = [...byId.values()].sort((a, b) => Date.parse(a.capsule.at) - Date.parse(b.capsule.at) || a.capsule.case.localeCompare(b.capsule.case) || a.capsule.id.localeCompare(b.capsule.id));
  return { capsules, unreadable };
}
