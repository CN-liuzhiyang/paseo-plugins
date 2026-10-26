import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { capsuleFiles, expectSchema, loadCapsules, readCapsule, writeCapsule, type Capsule, type Expect } from "./capsule";
import { loadConfig } from "./config";
import { checkDirs, PreviewError } from "./preview";
import { refOf, replayCapsules, type CapsuleRef, type ReplayReport } from "./replay-report";
import { loadRules, RULES_KEPT } from "./rules";
import { readState } from "./store";

// What people do with capsules besides a preview: replay them against a candidate alone, list
// them, keep one among the cases of the private config (where it is theirs, in a file anyone can
// read and the repository holds), and say what is right for it. The controller writes capsules
// to its data directory; it never writes to the config directory, so these are how one gets there.

export interface CasesOptions {
  /** The config in use. */
  configDir: string;
  /** The controller's data directory; read only. */
  dataDir: string;
  /** Where capsules are read from; absent: the data directory's capsules/ and the config directory's cases/. */
  casesDirs?: string[];
}

/** The directory in the config the cases a person keeps are in. */
export const casesIn = (configDir: string): string => path.join(configDir, "cases");
const roots = (o: CasesOptions) => o.casesDirs ?? [path.join(o.dataDir, "capsules"), casesIn(o.configDir)];

/** Only the replay: the capsules asked of the rules in use and, when given, of a candidate. */
export async function replayOnly(options: CasesOptions & { candidateDir?: string }): Promise<ReplayReport> {
  const config = loadConfig(options.configDir);
  const known = Object.fromEntries(Object.entries(readState(options.dataDir).state.rules.kept ?? {}).map(([file, k]) => [file, k.sha256]));
  const inUse = await loadRules(config.rulesDir, { dir: path.join(options.dataDir, RULES_KEPT), write: false, known });
  const loaded = loadCapsules(roots(options));
  let candidate = null;
  if (options.candidateDir) {
    checkDirs(options.configDir, options.candidateDir);
    candidate = await loadRules(loadConfig(options.configDir, options.candidateDir).rulesDir, null);
  }
  const broken = !!candidate && candidate.errors.length > 0;
  return replayCapsules(loaded.capsules.map((c) => c.capsule), inUse.rules, candidate && !broken ? candidate.rules : null, { unreadable: loaded.unreadable, broken, casesRoot: casesIn(options.configDir) });
}

export interface CaseRow extends CapsuleRef {
  file: string;
  where: "data" | "cases";
  expect: boolean;
  correction: boolean;
}

/** Every capsule there is, with where it is and whether it holds what a person said; one item's only when given (`#123`, `123` or the whole key). */
export function listCases(options: CasesOptions & { item?: string }): CaseRow[] {
  const mine = casesIn(options.configDir);
  const rows: CaseRow[] = [];
  const wanted = options.item?.replace(/^#/, "");
  for (const { file, capsule } of loadCapsules(roots(options)).capsules) {
    if (wanted && capsule.case !== wanted && !capsule.case.endsWith(`:${wanted}`)) continue;
    rows.push({ ...refOf(capsule), file, where: file.startsWith(mine + path.sep) ? "cases" : "data", expect: capsule.expect !== null, correction: capsule.correction !== null });
  }
  return rows;
}

/** An expectation from a file, checked the way a capsule's own is. */
export function readExpect(file: string): Expect {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PreviewError(`${file} 读不了：${(error as Error).message}`);
  }
  const parsed = expectSchema.safeParse(value);
  if (!parsed.success) throw new PreviewError(`${file} 里的 expect 不对：${parsed.error.issues.map((i) => `${i.path.join(".") || "(整体)"}：${i.message}`).join("；")}`);
  return parsed.data;
}

/**
 * The files of a directory that hold a capsule, in the order they are read: the last is the one a
 * load takes when a directory has more than one of an id (a controller's sample and a correction
 * of the same moment), so that is the one `file` and `capsule` are; `all` are every one.
 */
function find(dir: string, id: string): { file: string; capsule: Capsule; all: string[] } | null {
  const all: string[] = [];
  let last: { file: string; capsule: Capsule } | null = null;
  for (const file of capsuleFiles(dir)) {
    const read = readCapsule(file);
    if ("capsule" in read && read.capsule.id === id) {
      all.push(file);
      last = { file, capsule: read.capsule };
    }
  }
  return last ? { ...last, all } : null;
}

const idShape = z.string().regex(/^k_[0-9a-f]{16}$/);

/**
 * Keeps a capsule of the controller's among the cases of the config, as plain JSON, with what is
 * right for it when that is given. One already kept is not written over.
 */
export function keepCase(options: CasesOptions & { id: string; expect?: Expect }): string {
  if (!idShape.safeParse(options.id).success) throw new PreviewError(`${options.id} 不像存档的编号（k_ 加 16 位十六进制）`);
  const there = find(casesIn(options.configDir), options.id);
  if (there) throw new PreviewError(`${there.file} 已经在 cases/ 里了：要改 expect 用 cases expect`);
  const from = roots(options).filter((d) => d !== casesIn(options.configDir)).map((d) => find(d, options.id)).find((f) => f !== null);
  if (!from) throw new PreviewError(`数据目录的 capsules/ 里没有 ${options.id}`);
  return writeCapsule(casesIn(options.configDir), { ...from.capsule, expect: options.expect ?? from.capsule.expect }, { gzip: false });
}

/** Sets what is right for a capsule already among the cases of the config, in its own file (in each, where a directory holds the same capsule twice). */
export function setExpect(options: { configDir: string; id: string; expect: Expect }): string {
  const here = find(casesIn(options.configDir), options.id);
  if (!here) throw new PreviewError(`${casesIn(options.configDir)} 里没有 ${options.id}：先 cases keep`);
  for (const file of here.all) {
    const read = readCapsule(file);
    if (!("capsule" in read)) continue;
    const next: Capsule = { ...read.capsule, expect: options.expect };
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, file.endsWith(".gz") ? gzipSync(JSON.stringify(next)) : `${JSON.stringify(next, null, 2)}\n`);
      renameSync(tmp, file);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
  return here.file;
}
