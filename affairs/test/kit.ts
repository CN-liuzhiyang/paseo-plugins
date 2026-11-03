import { readFileSync, existsSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeCtx } from "../server/lib/ops.mjs";
import { makeRun } from "../server/lib/paseo.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE = path.join(HERE, "fake-paseo.mjs");

const made: string[] = [];
process.on("exit", () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
/** A directory in the temp folder that goes when the test process does. */
export function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export const T0 = Date.parse("2026-11-02T10:00:00+08:00");

/** A root on disk, a fake paseo and a clock that only moves when told to. */
export function world(options: { policy?: Record<string, unknown> } = {}) {
  const dir = scratch("affairs-test-");
  const root = path.join(dir, "root");
  const calls = path.join(dir, "calls.jsonl");
  Object.assign(process.env, { PASEO_BIN: FAKE, FAKE_PASEO_STATE: path.join(dir, "paseo.json"), FAKE_PASEO_CALLS: calls });
  delete process.env.FAKE_PASEO_FAIL;
  delete process.env.FAKE_PASEO_BUSY;
  delete process.env.PASEO_AGENT_ID;
  delete process.env.AFFAIR_BY;
  let clock = T0;
  const ctx = makeCtx({ root, paseoHome: "", run: makeRun({ home: null }), now: () => clock, waitMs: 0, runRetryMs: 0, policy: { ...DEFAULT_POLICY, ...(options.policy ?? {}) } });
  return {
    dir, root, ctx,
    at: (ms: number) => void (clock = ms),
    advance: (ms: number) => void (clock += ms),
    now: () => clock,
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
    paseo: () => JSON.parse(readFileSync(path.join(dir, "paseo.json"), "utf8")),
    file: (name: string, text: string) => writeFileSync(path.join(dir, name), text),
  };
}

export const iso = (local: string) => Date.parse(`${local.replace(" ", "T")}:00+08:00`);
