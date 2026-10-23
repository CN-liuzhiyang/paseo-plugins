import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { classify, LIVE_WITHIN_MS, type LivenessFacts, type RunState } from "../shared/liveness";
import type { Probe } from "./alive";
import { createRunIndex } from "./runs";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const TABLE = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "..", "orchestration", "fixtures", "run-state-cases.json"), "utf8"),
) as { cases: Array<LivenessFacts & { name: string; expect: { state: RunState; safeToRestart: boolean } }> };

const scratch = mkdtemp(path.join(os.tmpdir(), "orchestration-ui-liveness-"));
after(async () => rm(await scratch, { recursive: true, force: true }));

test("the table: every row of the runtime's fixtures/run-state-cases.json", () => {
  assert.ok(TABLE.cases.length >= 30);
  for (const { name, expect, ...facts } of TABLE.cases) {
    assert.deepEqual(classify(facts), expect, name);
  }
});

// The same table through the list: a run that wrote run.start and not run.end, with its claim.
const NOW = Date.parse("2026-10-24T09:00:00Z");
const probe = (answer: "alive" | "ESRCH" | "elsewhere"): Probe => ({
  hostname: answer === "elsewhere" ? "elsewhere" : "FIXTURE-HOST",
  kill: () => {
    if (answer === "ESRCH") throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    return true;
  },
});

/** The unfinished fixture (pid 4242 on fixture-host, last event hours before NOW) with a claim touched `ageMs` before NOW. */
async function listed(
  ageMs: number | null,
  answer: "alive" | "ESRCH" | "elsewhere",
  claim: unknown = { pid: 4242, hostname: "fixture-host", startedAt: "2026-09-24T03:00:00Z" },
) {
  const dir = await mkdtemp(path.join(await scratch, "r-"));
  const text = await readFile(path.join(FIXTURES, "survey-unfinished.jsonl"), "utf8");
  const runId = JSON.parse(text.slice(0, text.indexOf("\n"))).runId as string;
  await writeFile(path.join(dir, `${runId}.jsonl`), text);
  if (ageMs !== null) {
    const file = path.join(dir, `${runId}.claim`);
    await writeFile(file, typeof claim === "string" ? claim : JSON.stringify(claim));
    await utimes(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
  }
  const index = createRunIndex({ now: () => NOW, probe: probe(answer) });
  const { runs, total } = await index.list(dir, 10, 15 * 60_000);
  assert.equal(total, 1, "a claim file is not a run");
  return runs[0]!;
}

test("a claim touched lately is a run that is alive, however long since its last event", async () => {
  const run = await listed(5_000, "elsewhere");
  assert.equal(run.status, "running");
  assert.deepEqual(run.process, { pid: 4242, alive: true, gone: null });
});

test("a claim gone quiet is a run that is lost, and the pid still being there does not save it", async () => {
  const stale = await listed(LIVE_WITHIN_MS + 1_000, "elsewhere");
  assert.equal(stale.status, "lost");
  assert.deepEqual(stale.process, { pid: 4242, alive: false, gone: null });

  const reused = await listed(LIVE_WITHIN_MS + 1_000, "alive");
  assert.equal(reused.status, "lost", "pids are reused");
  assert.deepEqual(reused.process, { pid: 4242, alive: false, gone: false });
  assert.match(reused.activity ?? "", /占位文件超过 2 分钟没有更新（pid 4242 还在，但 pid 可能已被复用）/);
  assert.match(reused.hero?.title ?? "", /占位文件超过 2 分钟没有更新/);
});

test("a pid that is gone is proof of death, whatever the claim says", async () => {
  const run = await listed(5_000, "ESRCH");
  assert.equal(run.status, "lost");
  assert.deepEqual(run.process, { pid: 4242, alive: false, gone: true });
  assert.match(run.activity ?? "", /运行进程（pid 4242）已退出/);
});

test("a claim that cannot be read yet is taken as alive while it is fresh; without a claim the old rule holds", async () => {
  assert.equal((await listed(50, "elsewhere", "")).status, "running");
  assert.equal((await listed(LIVE_WITHIN_MS + 1_000, "elsewhere", "")).status, "lost");
  // No claim at all: quiet for hours on another machine reads as lost, as before claims existed.
  assert.equal((await listed(null, "elsewhere")).status, "lost");
  assert.equal((await listed(null, "alive")).status, "running");
});
