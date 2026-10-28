import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FLOW_VALUE_BYTES, type FlowEnd, type FlowRec } from "../shared/model";
import { actFor, affairKeyOf, affairOf, createLauncher, endedMessage, inputHashOf, limitWhy, MAX_RESTARTS, recordingLauncher, resultOf, runIdOf, SUSPECT_MS } from "../server/flows";
import { probeOf } from "./helpers";
import { AFFAIR, ago, fixture, MIN, NOW, start } from "./run-files";

const here = path.dirname(fileURLToPath(import.meta.url));

// Flows started for items (server/flows.ts): the run's id, the day's limits, the table of what to do with a run in each
// state the runtime's files can be in, and how the process is started. All names are made up.

const rec = (over: Partial<FlowRec> = {}): FlowRec => ({
  runId: "rc-test-0123456789ab",
  caseId: "tracker:1",
  name: "triage",
  flow: "triage-flow",
  key: "k1",
  round: 0,
  stage: "review",
  label: "初查",
  affairLabel: "#1 · 评审 · 初查",
  owner: "owner",
  notify: true,
  maxUsd: 1,
  timeout: "30m",
  input: { a: 1 },
  inputHash: "h",
  rules: "fp",
  intentAt: "2026-10-13T10:00:00+08:00",
  ...over,
});
const spawned = (over: Partial<FlowRec> = {}) => rec({ spawnedAt: "2026-10-13T10:00:01+08:00", pid: 42, spawnTries: 1, ...over });
const T0 = Date.parse("2026-10-13T10:05:00+08:00");
const LIMITS = { perDay: 6, usdPerDay: 5, perCasePerDay: 3, concurrent: 2 };
const TZ = "Asia/Shanghai";

// ---- the id ------------------------------------------------------------------------------------------------

test("the same request is always the same run id, and a different one is a different id the runtime accepts", () => {
  const id = runIdOf("main", "tracker:1", "triage", "triage-flow", "k1", 0);
  assert.equal(runIdOf("main", "tracker:1", "triage", "triage-flow", "k1", 0), id, "made from what was asked for, not from the clock or a counter");
  assert.match(id, /^rc-main-[0-9a-f]{12}$/);
  const others = [
    runIdOf("main", "tracker:2", "triage", "triage-flow", "k1", 0),
    runIdOf("main", "tracker:1", "other", "triage-flow", "k1", 0),
    runIdOf("main", "tracker:1", "triage", "other-flow", "k1", 0),
    runIdOf("main", "tracker:1", "triage", "triage-flow", "k2", 0),
    runIdOf("main", "tracker:1", "triage", "triage-flow", "k1", 1),
    runIdOf("second", "tracker:1", "triage", "triage-flow", "k1", 0),
  ];
  assert.equal(new Set([id, ...others]).size, 7, "every part of the request tells it apart");
  assert.match(runIdOf("main", "tracker:1", "triage", "triage-flow", "k1", 2), /-r2$/, "a person's second round says so");
  // the runtime's own pattern (orchestration/runtime/claim.mjs RUN_ID) and the id it sizes files by
  for (const odd of ["我的 实例/x", "..", "-lead", "a".repeat(80)]) assert.match(runIdOf(odd, "tracker:1", "triage", "triage-flow", "k1", 0), /^[A-Za-z0-9][A-Za-z0-9._-]*$/, odd);
  assert.ok(runIdOf("a".repeat(80), "t:1", "x", "y", "k", 12).length <= 64);
});

test("an input is told apart by what it holds, not by the order its keys were written in", () => {
  assert.equal(inputHashOf({ a: 1, b: [1, { c: 2, d: 3 }] }), inputHashOf({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(inputHashOf({ a: 1 }), inputHashOf({ a: 2 }));
  assert.notEqual(inputHashOf({ a: [1, 2] }), inputHashOf({ a: [2, 1] }), "an array's order is its meaning");
  assert.notEqual(inputHashOf({}), inputHashOf({ a: null }));
});

// ---- the day's limits --------------------------------------------------------------------------------------

test("a run is held back by whichever of the day's limits it meets first, and the words say which", () => {
  const today = (n: number, over: Partial<FlowRec> = {}) => Array.from({ length: n }, (_, i) => rec({ runId: `r${i}`, caseId: `tracker:${i + 10}`, intentAt: "2026-10-13T09:00:00+08:00", ended: { at: "2026-10-13T09:10:00+08:00", outcome: "done", summary: null, costUsd: 0.1, value: null, valueDropped: false, why: null }, ...over }));
  const ask = { caseId: "tracker:1", maxUsd: 1, flow: "triage-flow" };
  assert.equal(limitWhy(today(2), [], LIMITS, ask, T0, TZ), null, "room for one more");
  assert.match(limitWhy(today(6), [], LIMITS, ask, T0, TZ)!.why, /今天流程已经起了 6 次（上限 6）/);
  assert.equal(limitWhy(today(6), [], LIMITS, ask, T0, TZ)!.until, "tomorrow");
  // the same item: three a day
  const mine = today(3, { caseId: "tracker:1" });
  assert.match(limitWhy(mine, [], LIMITS, ask, T0, TZ)!.why, /这个事项今天流程已经起了 3 次（上限 3）/);
  assert.equal(limitWhy(mine, [], LIMITS, { caseId: "tracker:2", maxUsd: 1, flow: "triage-flow" }, T0, TZ), null, "another item is not held for it");
  // money: the ones that are over at what they cost, the others at the most they were counted at
  const cheap = today(4, { maxUsd: 4 });
  assert.equal(limitWhy(cheap, [], LIMITS, ask, T0, TZ), null, "four runs that cost $0.10 each, not $4");
  const open = today(2, { maxUsd: 2, ended: undefined });
  assert.match(limitWhy(open, [], { ...LIMITS, concurrent: 9 }, { caseId: "tracker:1", maxUsd: 2, flow: "triage-flow" }, T0, TZ)!.why, /花费已到 \$4\.00（上限 \$5）/);
  assert.equal(limitWhy(open, [], { ...LIMITS, concurrent: 9 }, { caseId: "tracker:1", maxUsd: 1, flow: "triage-flow" }, T0, TZ), null, "exactly the limit is allowed");
  // at the same time: not a day's matter, so it frees as runs end and yesterday's open run still counts
  const yesterday = today(2, { intentAt: "2026-10-12T09:00:00+08:00", ended: undefined, maxUsd: 0.5 });
  const held = limitWhy(yesterday, [], LIMITS, ask, T0, TZ)!;
  assert.match(held.why, /同时在跑的流程已经有 2 个（上限 2）/);
  assert.equal(held.until, "later");
  assert.equal(limitWhy(yesterday.slice(0, 1), [], LIMITS, ask, T0, TZ), null);
});

test("a new day starts the counts at nothing, in the instance's zone and not UTC", () => {
  // 00:30 +08:00 on the 14th is still the 13th in UTC: the run belongs to the 14th, the day the instance lives in
  const full = Array.from({ length: 6 }, (_, i) => rec({ runId: `r${i}`, caseId: `tracker:${i + 10}`, intentAt: "2026-10-14T00:30:00+08:00", ended: { at: "2026-10-14T00:40:00+08:00", outcome: "done", summary: null, costUsd: 0, value: null, valueDropped: false, why: null } }));
  const ask = { caseId: "tracker:1", maxUsd: 1, flow: "triage-flow" };
  assert.ok(limitWhy(full, [], LIMITS, ask, Date.parse("2026-10-14T01:00:00+08:00"), TZ), "the same day, though UTC is still the 13th");
  assert.ok(limitWhy(full, [], LIMITS, ask, Date.parse("2026-10-14T23:59:00+08:00"), TZ));
  assert.equal(limitWhy(full, [], LIMITS, ask, Date.parse("2026-10-15T00:01:00+08:00"), TZ), null, "the next local day");
  assert.equal(limitWhy(full, [], LIMITS, ask, Date.parse("2026-10-13T23:50:00+08:00"), TZ), null, "and before: the runs are not yet made");
});

test("the runs asked for earlier in the same round count against the limits, written or not", () => {
  const ahead = [rec({ runId: "a", caseId: "tracker:7" }), rec({ runId: "b", caseId: "tracker:8" })];
  assert.match(limitWhy([], ahead, LIMITS, { caseId: "tracker:1", maxUsd: 1, flow: "triage-flow" }, T0, TZ)!.why, /同时在跑/);
  const sameItem = [1, 2, 3].map((n) => rec({ runId: `s${n}`, intentAt: "2026-10-13T10:04:00+08:00" }));
  assert.match(limitWhy([], sameItem, { ...LIMITS, concurrent: 9 }, { caseId: "tracker:1", maxUsd: 1, flow: "triage-flow" }, T0, TZ)!.why, /这个事项今天/);
});

// ---- what to do with a run ---------------------------------------------------------------------------------

test("the table: nothing was started yet, so it is started; started and nothing comes of it, so again under the same id, twice, then it is told", () => {
  const act = (r: FlowRec, patch: Parameters<typeof probeOf>[0], since: number | null = null, now = T0) => actFor(r, probeOf(patch), since, now);
  // the intent is written, the process is not
  assert.deepEqual(act(rec(), { state: "absent" }), { act: { kind: "launch" }, suspect: false });
  // started a moment ago: the runtime has not had time to take the id
  assert.deepEqual(act(spawned(), { state: "pending" }), { act: { kind: "wait", live: "starting" }, suspect: false });
  assert.deepEqual(act(spawned(), { state: "absent", safeToRestart: false }), { act: { kind: "wait", live: "starting" }, suspect: false }, "not safe to start again yet");
  // safe: nothing came of it. Started once: a second start (the first start was spawnTries 1)
  assert.deepEqual(act(spawned({ spawnTries: 1 }), { state: "absent", safeToRestart: true }).act, { kind: "launch" });
  assert.deepEqual(act(spawned({ spawnTries: MAX_RESTARTS }), { state: "absent", safeToRestart: true }).act, { kind: "launch" });
  const given = act(spawned({ spawnTries: MAX_RESTARTS + 1 }), { state: "absent", safeToRestart: true }).act;
  assert.equal(given.kind, "end");
  assert.equal(given.kind === "end" && given.end.outcome, "not-started");
  assert.equal(given.kind === "end" && given.end.costUsd, 0);
  assert.match(given.kind === "end" ? given.end.why! : "", /起了 3 次/);
});

test("the table: a run that is running is not touched, and a gate or a long quiet is only said", () => {
  const live = (patch: Parameters<typeof probeOf>[0]) => actFor(spawned(), probeOf({ state: "running", ...patch }), null, T0).act;
  assert.deepEqual(live({}), { kind: "wait", live: "running" });
  assert.deepEqual(live({ gate: true }), { kind: "wait", live: "gate" });
  assert.deepEqual(live({ slow: true }), { kind: "wait", live: "slow" });
  assert.deepEqual(live({ gate: true, slow: true }), { kind: "wait", live: "gate" }, "waiting for a person is not stuck");
  for (const state of ["starting", "unreadable"] as const) assert.deepEqual(actFor(spawned(), probeOf({ state }), null, T0), { act: { kind: "wait", live: "starting" }, suspect: false }, state);
});

test("the table: a state that may be a pause is looked at again after a while before it is taken for a death", () => {
  for (const state of ["dead-before-start", "stalled-before-start"] as const) {
    const first = actFor(spawned(), probeOf({ state }), null, T0);
    assert.deepEqual(first, { act: { kind: "wait", live: "starting" }, suspect: true }, `${state}: first sight`);
    assert.equal(actFor(spawned(), probeOf({ state }), T0 - (SUSPECT_MS - 1), T0).act.kind, "wait", "a hair short of the time");
    const sure = actFor(spawned(), probeOf({ state }), T0 - SUSPECT_MS, T0);
    assert.equal(sure.suspect, false);
    assert.equal(sure.act.kind === "end" && sure.act.end.outcome, "not-started");
    assert.match(sure.act.kind === "end" ? sure.act.end.why! : "", /没有花钱/);
  }
  const lost = actFor(spawned(), probeOf({ state: "lost", costUsd: 0.4 }), null, T0);
  assert.deepEqual(lost, { act: { kind: "wait", live: "slow" }, suspect: true }, "silent: perhaps the machine slept");
  const sure = actFor(spawned(), probeOf({ state: "lost", costUsd: 0.4 }), T0 - SUSPECT_MS, T0);
  assert.equal(sure.act.kind === "end" && sure.act.end.outcome, "lost");
  assert.equal(sure.act.kind === "end" && sure.act.end.costUsd, 0.4, "what the calls that ended cost is kept");
  assert.match(sure.act.kind === "end" ? sure.act.end.why! : "", /失联.*已花 \$0\.40/);
  // coming back to a calm state clears the doubt
  assert.equal(actFor(spawned(), probeOf({ state: "running" }), T0 - SUSPECT_MS, T0).suspect, false);
});

test("the table: what the runtime wrote is what the run came to, and a refusal is not a run", () => {
  const ended = (end: Partial<NonNullable<ReturnType<typeof probeOf>["end"]>>, costUsd = 0.5) =>
    actFor(spawned(), probeOf({ state: "ended", costUsd, end: { at: T0, outcome: "done", summary: "找到 2 处", stop: null, error: null, value: { n: 2 }, valueDropped: false, totalUsd: null, ...end } }), null, T0).act;
  const done = ended({});
  assert.deepEqual(done, { kind: "end", end: { outcome: "done", summary: "找到 2 处", costUsd: 0.5, completedAt: new Date(T0).toISOString(), value: { n: 2 }, valueDropped: false, why: null } });
  const stopped = ended({ outcome: "stopped", stop: "取不到数据", value: { why: "x" } });
  assert.equal(stopped.kind === "end" && stopped.end.outcome, "stopped");
  assert.equal(stopped.kind === "end" && stopped.end.why, "取不到数据");
  assert.deepEqual(stopped.kind === "end" && stopped.end.value, { why: "x" }, "a stop carries its value too");
  const timeout = ended({ outcome: "timeout" });
  assert.equal(timeout.kind === "end" && timeout.end.outcome, "timeout");
  const failed = ended({ outcome: "failed", error: { name: "OutputMismatch", message: "bad json", headline: "回答不合格式", plain: "x", raw: "x" } as never });
  assert.equal(failed.kind === "end" && failed.end.outcome, "failed");
  assert.match(failed.kind === "end" ? failed.end.why! : "", /OutputMismatch：回答不合格式/);
  const odd = ended({ outcome: "something-new" });
  assert.equal(odd.kind === "end" && odd.end.outcome, "failed", "an outcome this does not know is a failure, not a success");
  const big = ended({ value: null, valueDropped: true });
  assert.equal(big.kind === "end" && big.end.valueDropped, true);
  const refused = actFor(spawned(), probeOf({ state: "refused", refused: "run id taken" }), null, T0).act;
  assert.equal(refused.kind === "end" && refused.end.outcome, "refused");
  assert.match(refused.kind === "end" ? refused.end.why! : "", /run id taken/);
});

test("what a rule reads of a run follows the record, and a run a person set aside says how it ended", () => {
  const end = (over: Partial<FlowEnd> = {}): FlowEnd => ({ at: "2026-10-13T10:09:00+08:00", outcome: "done", summary: "好", costUsd: 0.3, value: { n: 1 }, valueDropped: false, why: null, ...over });
  assert.equal(resultOf(rec(), null).state, "queued", "an intent whose process was not started");
  assert.equal(resultOf(spawned(), null).state, "starting");
  assert.equal(resultOf(spawned(), "gate").state, "gate");
  const done = resultOf(spawned({ ended: end() }), null);
  assert.deepEqual([done.state, done.value, done.summary, done.costUsd, done.endedAt], ["done", { n: 1 }, "好", 0.3, "2026-10-13T10:09:00+08:00"]);
  const failed = resultOf(spawned({ ended: end({ outcome: "failed", value: { leak: 1 }, why: "坏了" }) }), null);
  assert.deepEqual([failed.state, failed.value, failed.why], ["failed", null, "坏了"], "no value is given for a run that did not come to one");
  const set = resultOf(spawned({ ended: end({ outcome: "lost" }), dismissed: { how: "mine", by: "owner", at: "2026-10-13T10:10:00+08:00" } }), null);
  assert.deepEqual([set.state, set.endedOutcome], ["dismissed", "lost"]);
  assert.equal(resultOf(spawned({ ended: end() }), null).endedOutcome, null);
});

// ---- what a person is told ---------------------------------------------------------------------------------

test("the message for a run that ended says what was found, or that it did not come to a result and what to do", () => {
  const end = (over: Partial<FlowEnd>): FlowEnd => ({ at: "2026-10-13T10:09:00+08:00", outcome: "done", summary: "找到 2 处", costUsd: 0, value: null, valueDropped: false, why: null, ...over });
  const ok = endedMessage(rec(), end({}));
  assert.deepEqual([ok.title, ok.status], ["初查好了", "succeeded"]);
  assert.match(ok.text, /^#1 初查好了：找到 2 处。详情在「事项追踪」里。$/);
  assert.match(endedMessage(rec(), end({ summary: null })).text, /好了：完成了/);
  const bad = endedMessage(rec(), end({ outcome: "lost", why: "失联：心跳停了" }));
  assert.deepEqual([bad.title, bad.status], ["初查没跑完", "failed"]);
  assert.match(bad.text, /^#1 初查没跑完：流程中途断了（失联：心跳停了），要自己看。$/);
  for (const [outcome, words] of [["not-started", "流程没起来"], ["failed", "流程失败了"], ["timeout", "流程超时了"], ["refused", "流程被运行时拒了"]] as const) assert.match(endedMessage(rec(), end({ outcome })).text, new RegExp(words), outcome);
});

test("a run is told to the runtime as the item it is for, the stage it was asked in and a link back, and an address only when it is a plain one", () => {
  const screen = { plugin: "reconcile", screen: "inbox" };
  const a = affairOf({ caseId: "tracker:1", stage: "review", label: "#1 · 评审 · 初查" }, "https://tracker.example/issues/1", screen);
  assert.deepEqual(a, { label: "#1 · 评审 · 初查", url: "https://tracker.example/issues/1", link: { plugin: "reconcile", screen: "inbox", params: { case: "tracker:1", stage: "review" } }, key: "tracker:1" });
  const none = affairOf({ caseId: "tracker:1", stage: null, label: "x" }, "javascript:alert(1)", screen);
  assert.equal("url" in none, false, "not an address a page may link to");
  assert.deepEqual((none.link as { params: unknown }).params, { case: "tracker:1" });
  assert.equal("url" in affairOf({ caseId: "tracker:1", stage: "a", label: "x" }, "https://user:pw@host.example/x", screen), false, "an address with credentials in it is not a plain one");
  assert.equal((affairOf({ caseId: "tracker:1", stage: "a", label: "x".repeat(300) }, null, screen).label as string).length <= 120, true);
  // The key is the whole id when it fits; the link's copy is cut at 256 as it always was.
  const long = affairOf({ caseId: "tracker:" + "9".repeat(300), stage: null, label: "x" }, null, screen);
  assert.equal((long.link as { params: { case: string } }).params.case.length, 256);
});

test("the runtime is told one key for one item, whatever stage or run it is, and another for another item", () => {
  const screen = { plugin: "reconcile", screen: "inbox" };
  const key = (caseId: string, stage: string | null, label: string, url: string | null = null) => affairOf({ caseId, stage, label }, url, screen).key;
  assert.equal(key("tracker:1", "review", "#1 · 评审"), key("tracker:1", "fix", "#1 · 修复", "https://tracker.example/issues/1"));
  assert.equal(key("tracker:1", "review", "#1"), key("tracker:1", null, "#1"));
  assert.notEqual(key("tracker:1", "review", "#1"), key("tracker:2", "review", "#1"));
  assert.notEqual(key("tracker:1", "review", "#1"), key("other:1", "review", "#1"), "the same number from another source is another item");
});

test("two long ids that differ only past the cut are two keys, and the runtime takes every affair this makes", async () => {
  const screen = { plugin: "reconcile", screen: "inbox" };
  const { affairProblems } = (await import(pathToFileURL(path.join(here, "..", "..", "orchestration", "runtime", "affair.mjs")).href)) as { affairProblems: (affair: unknown) => string[] };
  const source = "s".repeat(255);
  const a = affairOf({ caseId: `${source}:1`, stage: "review", label: "x" }, null, screen);
  const b = affairOf({ caseId: `${source}:2`, stage: "review", label: "x" }, null, screen);
  assert.notEqual(a.key, b.key, "the same 256 characters, a different item");
  assert.equal(a.key, affairOf({ caseId: `${source}:1`, stage: "fix", label: "y" }, null, screen).key, "and the same item is the same key whatever the stage");
  // The runtime counts characters (code points), so a long id of astral characters is cut by those, not by UTF-16 units.
  const astral = (tail: string) => affairOf({ caseId: "𠀀".repeat(300) + tail, stage: null, label: "x" }, null, screen);
  assert.notEqual(astral("1").key, astral("2").key);
  for (const made of [a, b, astral("1"), affairOf({ caseId: "tracker:1", stage: null, label: "x" }, null, screen)]) {
    assert.deepEqual(affairProblems(made), []);
    assert.ok([...(made.key as string)].length <= 256);
  }
  assert.equal(affairKeyOf("tracker:1"), "tracker:1", "an id that fits is the key as it is");
  assert.equal([...affairKeyOf("x".repeat(256))].length, 256);
  assert.equal([...affairKeyOf("x".repeat(257))].length, 256);
});

// ---- starting the process ----------------------------------------------------------------------------------

test("the process is started as the runtime is asked, detached, with the files it is given, and a program that cannot run is an error", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-launch-"));
  try {
    const script = path.join(dir, "echo-args.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path.join(dir, "args.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n`);
    const launcher = createLauncher({ command: [process.execPath, script, "run-prefix"], cwd: dir });
    const spec = { runId: "rc-x-1", flow: "triage-flow", timeout: "30m" as string | null, inputFile: path.join(dir, "i.json"), affairFile: path.join(dir, "a.json"), outFile: path.join(dir, "out.txt") };
    const { pid } = await launcher.start(spec);
    assert.ok(typeof pid === "number" && pid > 0);
    for (let i = 0; i < 100 && !existsSync(path.join(dir, "args.json")); i++) await new Promise((r) => setTimeout(r, 50));
    const seen = JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8")) as { args: string[]; cwd: string };
    assert.deepEqual(seen.args, ["run-prefix", "run", "triage-flow", "--run-id", "rc-x-1", "--affair", `@${spec.affairFile}`, "--input", `@${spec.inputFile}`, "--timeout", "30m"]);
    assert.equal(path.resolve(seen.cwd).toLowerCase(), path.resolve(dir).toLowerCase());
    assert.ok(existsSync(spec.outFile), "its own output goes to a file the controller made");
    // no timeout asked: none is passed
    rmSync(path.join(dir, "args.json"));
    await launcher.start({ ...spec, timeout: null, runId: "rc-x-2" });
    for (let i = 0; i < 100 && !existsSync(path.join(dir, "args.json")); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8")) as { args: string[] }).args.includes("--timeout"), false);
    // a program that is not there
    await assert.rejects(createLauncher({ command: [path.join(dir, "no-such-program")] }).start({ ...spec, runId: "rc-x-3" }), /ENOENT/);
    // an output file that cannot be opened
    await assert.rejects(launcher.start({ ...spec, runId: "rc-x-4", outFile: path.join(dir, "no-dir", "out.txt") }), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the recording launcher only records", async () => {
  const launcher = recordingLauncher();
  const spec = { runId: "r", flow: "f", timeout: null, inputFile: "i", affairFile: "a", outFile: "o" };
  assert.deepEqual(await launcher.start(spec), { pid: null });
  assert.deepEqual(launcher.started, [spec]);
});

// ---- reading one run by its id -----------------------------------------------------------------------------

const END = (ts: string, extra: Record<string, unknown> = {}) => ({ kind: "run.end", ts, outcome: "done", summary: "找到 2 处", value: { found: 2 }, cost: { usd: 0.5, partial: false }, ...extra });

/** What the reader says of one run, on files laid out as given (a fresh reader: it looks at the directory only every few seconds). */
function probed(runId: string, events: Array<Record<string, unknown>> | null, options: Parameters<ReturnType<typeof fixture>["run"]>[2] = {}, spawnedAgoMs: number | null = null) {
  const f = fixture();
  try {
    if (events) f.run(runId, events, options);
    return f.reader.probe(runId, spawnedAgoMs === null ? null : NOW - spawnedAgoMs);
  } finally {
    f.close();
  }
}

test("one run read by its id: what the files say of it in the runtime's own words, and what it returned", () => {
  assert.equal(probed("nothing-yet", null).state, "absent", "nothing on disk");
  assert.equal(probed("nothing-yet", null, {}, 10_000).state, "pending", "started ten seconds ago: not yet");
  const late = probed("nothing-yet", null, {}, 2 * MIN);
  assert.deepEqual([late.state, late.safeToRestart], ["absent", true], "started two minutes ago and nothing came of it");

  assert.equal(probed("live", [start(ago(5 * MIN), AFFAIR("tracker:1"))]).state, "running");
  assert.equal(probed("claimed", []).state, "starting", "the runtime has the id and has not written a start");

  const p = probed("done", [start(ago(5 * MIN), AFFAIR("tracker:1")), END(ago(1 * MIN))], { claimAgeMs: null });
  assert.equal(p.state, "ended");
  assert.deepEqual([p.end!.outcome, p.end!.summary, p.end!.value, p.end!.valueDropped], ["done", "找到 2 处", { found: 2 }, false]);

  const lost = probed("stale", [start(ago(60 * MIN), AFFAIR("tracker:1")), { kind: "log", ts: ago(50 * MIN), level: "info", message: "x" }], { claimAgeMs: 30 * MIN });
  assert.equal(lost.state, "lost");

  const r = probed("refused", [], { claimBody: { refused: "run id taken", pid: 1, hostname: "h" } });
  assert.deepEqual([r.state, r.refused], ["refused", "run id taken"]);

  const priced = probed("priced", [start(ago(10 * MIN), AFFAIR("tracker:1")), { kind: "call.start", ts: ago(9 * MIN), callId: "c1", type: "ask", name: "c1", title: "c1", phase: null }, { kind: "call.end", ts: ago(8 * MIN), callId: "c1", ok: true, durationMs: 1, output: null, error: null, agentId: null, cost: { usd: 0.25, inputTokens: 1, outputTokens: 1 } }]);
  assert.deepEqual([priced.state, priced.costUsd], ["running", 0.25], "what the calls that ended cost");
});

test("a result past the bound is not kept, only that it was too large; a stop carries its value like a finish does", () => {
  const ended = (runId: string, end: Record<string, unknown>) => probed(runId, [start(ago(5 * MIN), AFFAIR("tracker:1")), end], { claimAgeMs: null }).end!;
  const within = { rows: "x".repeat(FLOW_VALUE_BYTES - 200) };
  const kept = ended("within", END(ago(MIN), { value: within }));
  assert.deepEqual([kept.valueDropped, (kept.value as typeof within).rows.length], [false, within.rows.length]);
  const over = ended("over", END(ago(MIN), { value: { rows: "x".repeat(FLOW_VALUE_BYTES + 10) } }));
  assert.deepEqual([over.outcome, over.value, over.valueDropped], ["done", null, true], "it is still a finish, with no value");
  const stopped = ended("stopped", END(ago(MIN), { outcome: "stopped", stop: { reason: "取不到数据" }, value: { analysis: null, why: "取不到数据", samples: 0 } }));
  assert.deepEqual([stopped.outcome, stopped.stop, (stopped.value as { samples: number }).samples], ["stopped", "取不到数据", 0]);
  const none = ended("none", { kind: "run.end", ts: ago(MIN), outcome: "done" });
  assert.deepEqual([none.value, none.valueDropped], [null, false], "a run that returned nothing");
});

test("a run.end line too long to be read whole is still the end, with no value", () => {
  const f = fixture();
  try {
    f.run("huge", [start(ago(5 * MIN), AFFAIR("tracker:1"))], { claimAgeMs: null });
    // as the runtime writes it: v, seq, ts, runId, kind, then the event's own fields
    appendFileSync(path.join(f.dir, "huge.jsonl"), `${JSON.stringify({ v: 1, seq: 9, ts: ago(MIN), runId: "huge", kind: "run.end", outcome: "done", value: "y".repeat(5 << 20), summary: null })}
`);
    const p = f.reader.probe("huge", null);
    assert.equal(p.state, "ended");
    assert.deepEqual([p.end!.outcome, p.end!.value, p.end!.valueDropped], ["done", null, true]);
  } finally {
    f.close();
  }
});

// ---- a flow with limits of its own (policy flows.byFlow) ------------------------------------------------------

test("a flow with limits of its own is counted against those only, and counts in no other: neither can fill the other's room", () => {
  const BY = { ...LIMITS, byFlow: { "glance-flow": { perDay: 2, usdPerDay: 1 } } };
  const today = (n: number, flow: string, over: Partial<FlowRec> = {}) =>
    Array.from({ length: n }, (_, i) => rec({ runId: `${flow}-${i}`, flow, caseId: `tracker:${i + 10}`, intentAt: "2026-10-13T09:00:00+08:00", ended: { at: "2026-10-13T09:10:00+08:00", outcome: "done", summary: null, costUsd: 0.1, value: null, valueDropped: false, why: null }, ...over }));
  const general = { caseId: "tracker:1", maxUsd: 1, flow: "triage-flow" };
  const own = { caseId: "desk:D1", maxUsd: 0.5, flow: "glance-flow" };
  // the general flows use up their day: the flow with its own limits still has its room
  assert.ok(limitWhy(today(6, "triage-flow"), [], BY, general, T0, TZ), "the general limit is full for the general flows");
  assert.equal(limitWhy(today(6, "triage-flow"), [], BY, own, T0, TZ), null, "and none of it is the flow's");
  // the flow uses up its own: the general flows have their room, and the words say which limit it was
  const full = today(2, "glance-flow");
  assert.equal(limitWhy(full, [], BY, general, T0, TZ), null, "two of the other flow's runs do not count in the general day");
  assert.equal(limitWhy(full, [], { ...BY, perDay: 2, usdPerDay: 1.1 }, general, T0, TZ), null, "not in the general count however narrow it is, nor in its money");
  const held = limitWhy(full, [], BY, { ...own, caseId: "desk:D9" }, T0, TZ)!;
  assert.match(held.why, /今天「glance-flow」流程已经起了 2 次（上限 2）/);
  assert.equal(held.until, "tomorrow");
  // its own money, in its own words
  const spent = limitWhy(today(1, "glance-flow", { ended: undefined, maxUsd: 0.8 }), [], BY, own, T0, TZ)!;
  assert.match(spent.why, /今天「glance-flow」流程花费已到 \$0\.80（上限 \$1），再起一个按 \$0\.5 算会超/);
  // the same matter, and at the same time: the defaults of a flow with limits of its own are 4 and 1, not the general ones
  const sameMatter = today(4, "glance-flow", { caseId: "desk:D1" });
  assert.match(limitWhy(sameMatter, [], { ...BY, byFlow: { "glance-flow": { perDay: 9, usdPerDay: 9 } } }, own, T0, TZ)!.why, /这个事项今天「glance-flow」流程已经起了 4 次（上限 4）/);
  const going = today(1, "glance-flow", { ended: undefined, maxUsd: 0.1 });
  const one = limitWhy(going, [], { ...BY, byFlow: { "glance-flow": { perDay: 9, usdPerDay: 9 } } }, { ...own, caseId: "desk:D2" }, T0, TZ)!;
  assert.match(one.why, /同时在跑的「glance-flow」流程已经有 1 个（上限 1）/);
  assert.equal(one.until, "later");
  // the runs asked for earlier in the same round are counted in the room they belong to
  assert.match(limitWhy([], today(2, "glance-flow"), BY, { ...own, caseId: "desk:D9" }, T0, TZ)!.why, /「glance-flow」/);
  assert.equal(limitWhy([], today(2, "glance-flow"), BY, general, T0, TZ), null);
  // a flow named like a property of Object is not a flow with limits of its own
  assert.equal(limitWhy(today(6, "triage-flow"), [], BY, { caseId: "tracker:1", maxUsd: 1, flow: "constructor" }, T0, TZ)!.why.includes("「"), false);
  // no byFlow at all: the one room, as before
  assert.ok(limitWhy(today(6, "glance-flow"), [], LIMITS, own, T0, TZ));
});
