import assert from "node:assert/strict";
import { test } from "node:test";
import { isBroken, phaseLine, sortFlows, standing, startCommand } from "../shared/flows";
import type { FlowRow, RunSummary } from "../shared/rpc";
import { createCatalog, type Catalog, type CatalogEntry, type Exec } from "./catalog";
import { flowRows } from "./flows";

const run = (over: Partial<RunSummary>): RunSummary => ({
  runId: "r",
  flowName: "triage",
  description: "分诊",
  startedAt: "2026-10-26T06:00:00.000Z",
  lastEventAt: null,
  status: "done",
  durationMs: null,
  costUsd: null,
  costNote: null,
  caller: null,
  host: null,
  affairLabel: null,
  activity: null,
  stop: null,
  error: null,
  problem: null,
  process: null,
  sizeBytes: 1,
  inputLabel: null,
  hero: null,
  needsYou: false,
  strip: null,
  ...over,
});

const entry = (name: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  name,
  description: `${name} 的说明`,
  origin: "config",
  file: `D:/flows/${name}.mjs`,
  phases: [{ id: "a", title: "取数" }, { id: "b", title: "分析" }],
  inputs: [
    { name: "itemNo", flag: "--item-no", kind: "count", description: "单号" },
    { name: "mode", flag: "--mode", kind: "choice", description: "模式", choices: ["a", "b"] },
  ],
  grants: [],
  problems: [],
  error: null,
  ...over,
});

const ok = (...flows: CatalogEntry[]): Catalog => ({ ok: true, flows });

test("flows: a flow nobody has run is still a row; its runs are counted and the newest is its latest", () => {
  const listed = flowRows(
    ok(entry("triage"), entry("never-run")),
    [
      run({ runId: "old", startedAt: "2026-10-20T00:00:00.000Z", status: "failed" }),
      run({ runId: "new", startedAt: "2026-10-26T00:00:00.000Z" }),
      run({ runId: "other", flowName: "never-run-2" }),
    ],
  );
  assert.equal(listed.state, "ok");
  const [triage, never] = ["triage", "never-run"].map((n) => listed.flows.find((f) => f.name === n)!);
  assert.deepEqual([triage!.runCount, triage!.latest?.runId], [2, "new"]);
  assert.deepEqual([never!.runCount, never!.latest], [0, null]);
});

test("flows: a run of a flow the list does not have still shows its flow, marked as only seen in the runs", () => {
  const listed = flowRows(ok(entry("triage")), [run({ flowName: "gone", description: "已经删掉的", runId: "g" })]);
  const gone = listed.flows.find((f) => f.name === "gone")!;
  assert.deepEqual([gone.origin, gone.description, gone.file, gone.runCount], ["seen", "已经删掉的", null, 1]);
});

test("flows: with no list from the runtime the rows are the flows that ran, and the state says so", () => {
  const listed = flowRows({ ok: false, detail: "没填 orchPath" }, [run({})]);
  assert.deepEqual([listed.state, listed.detail, listed.flows.map((f) => f.name)], ["fallback", "没填 orchPath", ["triage"]]);
  assert.equal(flowRows({ ok: false, detail: "x" }, []).flows.length, 0);
});

test("flows: a run that is not a run file (no flow name) is in no flow", () => {
  const listed = flowRows(ok(entry("triage")), [run({ flowName: null, status: "unreadable", runId: "bad" })]);
  assert.equal(listed.flows[0]!.runCount, 0);
});

test("standing: needs you, then running, then newest ended, then never run, then broken", () => {
  const row = (name: string, over: Partial<FlowRow>): FlowRow => ({ ...entry(name), runCount: 1, latest: null, ...over });
  const rows = [
    row("broken", { error: "Unexpected end of input" }),
    row("never", {}),
    row("old", { latest: run({ startedAt: "2026-10-01T00:00:00.000Z" }) }),
    row("new", { latest: run({ startedAt: "2026-10-26T00:00:00.000Z", status: "failed" }) }),
    row("live", { latest: run({ status: "running", startedAt: "2026-10-02T00:00:00.000Z" }) }),
    row("asks", { latest: run({ needsYou: true, status: "running", startedAt: "2026-09-01T00:00:00.000Z" }) }),
  ];
  assert.deepEqual(sortFlows(rows).map((f) => f.name), ["asks", "live", "new", "old", "never", "broken"]);
  assert.equal(standing(rows[2]!).label, "上次完成");
  assert.equal(standing(rows[3]!).label, "上次失败");
  assert.equal(standing(rows[1]!).label, "还没跑过");
  assert.equal(isBroken(rows[0]!), true);
});

test("flows: how a flow reads is its phases in a line and the command that starts it", () => {
  const row: FlowRow = { ...entry("triage"), runCount: 0, latest: null };
  assert.equal(phaseLine(row), "取数 → 分析");
  assert.equal(startCommand(row, "D:/x/orch.mjs"), "node D:/x/orch.mjs run triage --item-no <itemNo> --mode <a|b>");
  assert.match(startCommand(row, null), /<paseo-plugins>\/orchestration\/runtime\/orch\.mjs/);
});

// --- Asking the runtime ---------------------------------------------------

const listing = JSON.stringify({ flows: [entry("triage")] });
const answer = (over: Partial<Awaited<ReturnType<Exec>>> = {}): Exec => async () => ({ code: 0, stdout: listing, stderr: "", failure: null, ...over });

test("catalog: no orchPath is said, not guessed, and nothing is run", async () => {
  let ran = 0;
  const catalog = createCatalog({ exec: async () => (ran++, { code: 0, stdout: listing, stderr: "", failure: null }), execPath: "node" });
  const got = await catalog.get("  ");
  assert.equal(got.ok, false);
  assert.match((got as { detail: string }).detail, /orchPath/);
  assert.equal(ran, 0);
});

test("catalog: the runtime's list is read with the daemon's own node, and remembered for a few seconds", async () => {
  const calls: string[][] = [];
  let t = 0;
  const catalog = createCatalog({
    exec: async (file, args) => (calls.push([file, ...args]), { code: 0, stdout: listing, stderr: "", failure: null }),
    now: () => t,
    execPath: "C:/node.exe",
  });
  const [a, b] = await Promise.all([catalog.get("D:/x/orch.mjs"), catalog.get("D:/x/orch.mjs")]);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.deepEqual(calls, [["C:/node.exe", "D:/x/orch.mjs", "list"]]);
  t = 5_000;
  await catalog.get("D:/x/orch.mjs");
  assert.equal(calls.length, 1);
  t = 11_000;
  await catalog.get("D:/x/orch.mjs");
  assert.equal(calls.length, 2);
  await catalog.get("D:/y/orch.mjs"); // another path is another question
  assert.equal(calls.length, 3);
});

test("catalog: every way it can go wrong says what happened, in a sentence", async () => {
  const cases: Array<[Partial<Awaited<ReturnType<Exec>>>, RegExp]> = [
    [{ failure: "ENOENT" }, /没成功：ENOENT/],
    [{ failure: "等了 30 秒没有结果" }, /等了 30 秒/],
    [{ code: 2, stderr: "UsageError: Usage:\nnode orch run" }, /退出码 2.*Usage/],
    [{ stdout: "not json" }, /不是 JSON.*太旧/],
    [{ stdout: JSON.stringify({ flows: [{ name: 1 }] }) }, /对不上/],
  ];
  for (const [over, expected] of cases) {
    const got = await createCatalog({ exec: answer(over), execPath: "node" }).get("D:/x/orch.mjs");
    assert.equal(got.ok, false);
    assert.match((got as { detail: string }).detail, expected);
  }
});
