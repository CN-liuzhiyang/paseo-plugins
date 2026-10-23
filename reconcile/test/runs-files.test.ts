import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify, type LivenessFacts, type RunState } from "../shared/liveness.mjs";
import type { Probe } from "../shared/liveness.mjs";
import { createRunReader } from "../server/runs";
import { cleanText } from "../server/untrusted";
import { AFFAIR, ago, callEnd, callStart, fixture, MIN, NOW, only, phaseStart, start } from "./run-files";

// The files the runs are read from are somebody else's to write: what is read of them is bounded, what is shown of
// them is cleaned, and whether a run is alive is the runtime's own table.

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(path.join(here, ...parts), "utf8").split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));

// ---- the runtime's table -------------------------------------------------------------------------------------------

test("shared/liveness.mjs and its types are the runtime's files with the header on, word for word", () => {
  for (const name of ["liveness.mjs", "liveness.d.mts"]) {
    const source = read("..", "..", "orchestration", "runtime", name);
    const copy = read("..", "shared", name);
    assert.ok(copy.startsWith("// 由运行时复制，别手改"), `${name} says it is a copy`);
    // The header is one line and a blank one.
    assert.equal(copy.slice(copy.indexOf(String.fromCharCode(10, 10)) + 2), source, `${name} differs from the runtime's: run npm run sync:liveness in orchestration/`);
  }
});

interface Row extends LivenessFacts {
  name: string;
  expect: { state: RunState; safeToRestart: boolean };
}
const TABLE = (JSON.parse(read("..", "..", "orchestration", "fixtures", "run-state-cases.json")) as { cases: Row[] }).cases;

test("the table: every row of the runtime's fixtures/run-state-cases.json, through this plugin's copy", () => {
  assert.ok(TABLE.length >= 30);
  for (const { name, expect, ...facts } of TABLE) assert.deepEqual(classify(facts), expect, name);
});

/** What a run in each state of the table is to the page: the states a run that wrote run.start can be in. */
const SITUATION: Partial<Record<RunState, string[]>> = { ended: ["done", "fail"], running: ["doing", "me", "slow"], lost: ["lost"], refused: ["fail"], unreadable: ["doing"] };

test("the table: every row of a run that wrote run.start, through the reader, with the holder's pid asked on the holder's machine", () => {
  let n = 0;
  let checked = 0;
  for (const row of TABLE) {
    n++;
    if (row.events === "none") continue; // no run.start: the reader does not know the run, there is nothing to show of it
    const want = SITUATION[row.expect.state];
    assert.ok(want, `${row.name}: a state a run with events can be in`);
    const pid = row.pid ?? "unknown";
    const probe: Probe = {
      hostname: pid === "unknown" ? "elsewhere" : "fixture-host",
      kill: () => {
        if (pid === "gone") throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return true;
      },
    };
    const f = fixture(probe);
    try {
      const runId = `row-${n}`;
      const quiet = row.quietMs ?? 60_000;
      const holder = { pid: 4242, hostname: "fixture-host" };
      const events: Array<Record<string, unknown>> = [{ ...start(ago(Math.max(quiet, 1000) + MIN), AFFAIR("tracker:1")), ...holder }];
      if (row.events === "open") events.push({ kind: "log", ts: ago(quiet), level: "info", message: "x" });
      else events.push({ kind: "run.end", ts: ago(quiet), outcome: "done", value: null, summary: null, stop: null, error: null, durationMs: 1, cost: null, caveats: [] });
      f.run(runId, events, {
        claimAgeMs: row.claim ? row.claim.ageMs : null,
        claimBody: row.claim?.unreadable ? "{not json" : row.claim?.refused ? { ...holder, refused: "no" } : holder,
      });
      const got = only(f).situation;
      assert.ok(want.includes(got), `${row.name}: the runtime says ${row.expect.state}, the reader says ${got}`);
      checked++;
    } finally {
      f.close();
    }
  }
  assert.ok(checked >= 12, `${checked} rows were run through the reader`);
});

test("a pid that is gone on this machine is a run that is lost, however fresh its claim; a pid that is there saves nothing", () => {
  const gone: Probe = { hostname: "fixture-host", kill: () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); } };
  const there: Probe = { hostname: "fixture-host", kill: () => true };
  const events = [{ ...start(ago(30 * MIN), AFFAIR("tracker:1")), pid: 4242, hostname: "fixture-host" }, { kind: "log", ts: ago(MIN), level: "info", message: "x" }];
  const a = fixture(gone);
  const b = fixture(there);
  try {
    a.run("r", events, { claimAgeMs: 5_000, claimBody: { pid: 4242, hostname: "fixture-host" } });
    b.run("r", events, { claimAgeMs: 10 * MIN, claimBody: { pid: 4242, hostname: "fixture-host" } });
    assert.equal(only(a).situation, "lost", "the process is gone");
    assert.equal(only(b).situation, "lost", "the claim went quiet and the process still being there does not make it alive (pids are reused)");
  } finally {
    a.close();
    b.close();
  }
});

// ---- not trusted ---------------------------------------------------------------------------------------------------

const AFFAIR_CASES = JSON.parse(read("..", "..", "orchestration", "fixtures", "affair-cases.json")) as { unsafe: Array<{ code: number; as_text: string }>; ok: Array<{ code: number; as_text: string }> };

test("text from an event file is cleaned by the same list as the runtime's affair labels: what cannot be drawn is gone, ordinary text stays", () => {
  assert.ok(AFFAIR_CASES.unsafe.length >= 25);
  for (const { code, as_text } of AFFAIR_CASES.unsafe) {
    const cleaned = cleanText(`请批准${as_text}删除`, 50)!;
    assert.ok(!cleaned.includes(as_text), `U+${code.toString(16)} is taken out`);
    assert.ok(cleaned.startsWith("请批准") && cleaned.endsWith("删除"));
  }
  for (const { code, as_text } of AFFAIR_CASES.ok) assert.ok(cleanText(`a${as_text}b`, 50)!.includes(as_text), `U+${code.toString(16)} stays`);
  assert.equal(cleanText("x".repeat(500), 20)!.length, 20);
  assert.equal(cleanText("   ", 20), null);
  assert.equal(cleanText(42, 20), null);
});

test("what a run's file says of itself is shown clean and short: a forged gate summary, a name, a title, an error", () => {
  const f = fixture();
  try {
    const bidi = String.fromCharCode(0x202e);
    const nul = String.fromCharCode(0);
    f.run("forged", [
      { ...start(ago(10 * MIN), AFFAIR("tracker:1")), flow: { name: `流程${bidi}${"名".repeat(400)}`, phases: [{ id: "p", title: `阶段${nul}一` }] } },
      phaseStart(ago(9 * MIN), "p"),
      callStart(ago(8 * MIN), "g", "gate", { phase: "p", title: `批准${bidi}删除`, summary: `请批准：${nul}${"删除全部示例".repeat(200)}\n第二行`, carrier: "model" }),
      { kind: "call.agent", ts: ago(8 * MIN), callId: "g", agentId: "../../etc/passwd" },
    ]);
    const r = only(f);
    assert.equal(r.situation, "me");
    assert.ok(r.flow.length <= 80 && !r.flow.includes(bidi), "the name of the flow");
    assert.equal(r.step!.title, "阶段 一", "the title of a phase");
    assert.ok(r.gate!.summary.length <= 200, "the gate's summary is a clipped line");
    assert.ok(!/[\u0000-\u001f‮]/.test(r.gate!.summary), "and has nothing in it that is not drawn");
    assert.equal(r.gate!.agentId, null, "an id that does not look like an agent's is not an agent to open");
    assert.equal(r.agentId, null);
    assert.equal(r.gate!.kind, "model");
  } finally {
    f.close();
  }
});

test("only what looks like an agent id opens an agent; the kind of carrier is only one of two words", () => {
  const f = fixture();
  try {
    f.run("ok", [
      start(ago(10 * MIN), AFFAIR("tracker:1")),
      callStart(ago(8 * MIN), "g", "gate", { title: "批准", summary: "x", carrier: "<script>" }),
      { kind: "call.agent", ts: ago(8 * MIN), callId: "g", agentId: "a9f3c2e1-5d4b-4a3c-9e2f-1b0a9c8d7e11" },
    ]);
    const r = only(f);
    assert.equal(r.gate!.agentId, "a9f3c2e1-5d4b-4a3c-9e2f-1b0a9c8d7e11");
    assert.equal(r.gate!.kind, null, "a carrier kind the contract does not have is not shown");
  } finally {
    f.close();
  }
});

test("a run says when it ended", () => {
  const f = fixture();
  try {
    f.run("e", [start(ago(30 * MIN), AFFAIR("tracker:1")), { kind: "run.end", ts: ago(10 * MIN), outcome: "done", value: null, summary: null, stop: null, error: null, durationMs: 1, cost: null, caveats: [] }], { claimAgeMs: null });
    f.run("w", [start(ago(30 * MIN), AFFAIR("tracker:2"))]);
    assert.equal(only(f).endedAt, "2026-10-23T19:50:00+08:00");
    assert.equal(only(f, "tracker:2").endedAt, null);
  } finally {
    f.close();
  }
});

// ---- bounded -------------------------------------------------------------------------------------------------------

const readerFor = (dir: string) => createRunReader({ runsDir: dir, tz: "Asia/Shanghai", now: () => NOW, affair: { plugin: "reconcile", screen: "inbox" }, view: { plugin: "orchestration-ui", screen: "runs" } });

test("a line too long to be one of the runtime's is passed over, and the file goes on being read after it", () => {
  const f = fixture();
  try {
    f.run("long", [start(ago(30 * MIN), AFFAIR("tracker:1")), phaseStart(ago(29 * MIN), "collect")]);
    const file = path.join(f.dir, "long.jsonl");
    appendFileSync(file, JSON.stringify({ v: 1, seq: 9, runId: "long", kind: "log", ts: ago(28 * MIN), level: "info", message: "y".repeat(5 << 20) }) + "\n");
    appendFileSync(file, JSON.stringify({ v: 1, seq: 10, runId: "long", kind: "phase.end", ts: ago(MIN), phase: "collect", ok: true }) + "\n");
    assert.deepEqual(readerFor(f.dir).forCase("tracker:1")[0]!.steps, ["ok", "todo", "todo"], "the events after the long line are read");
  } finally {
    f.close();
  }
});

test("whether a file is this plugin's is told by its first line, which has to end within the head: a longer one is not a run of ours", () => {
  const f = fixture();
  try {
    f.run("mine", [start(ago(5 * MIN), AFFAIR("tracker:1"))]);
    const padded = { ...start(ago(5 * MIN), AFFAIR("tracker:1")), note: "z".repeat(300 * 1024) };
    writeFileSync(path.join(f.dir, "padded.jsonl"), JSON.stringify({ v: 1, seq: 0, runId: "padded", ...padded }) + "\n");
    assert.deepEqual(readerFor(f.dir).forCase("tracker:1").map((r) => r.runId), ["mine"]);
  } finally {
    f.close();
  }
});

test("a file nobody has written to for two months is history: not read", () => {
  const f = fixture();
  try {
    f.run("recent", [start(ago(5 * MIN), AFFAIR("tracker:1"))]);
    f.run("ancient", [start(ago(5 * MIN), AFFAIR("tracker:1"))], { fileAgeMs: 90 * 86_400_000 });
    assert.deepEqual(readerFor(f.dir).forCase("tracker:1").map((r) => r.runId), ["recent"]);
  } finally {
    f.close();
  }
});

test("one run does not cost more than a bounded amount: calls past the limit are not kept", () => {
  const f = fixture();
  try {
    const calls = Array.from({ length: 3000 }, (_, i) => callStart(ago(2 * MIN - i), `c${i}`, "do"));
    f.run("many", [start(ago(30 * MIN), AFFAIR("tracker:1")), ...calls]);
    const r = only(f);
    assert.equal(r.situation, "doing");
    assert.equal(r.costUsd, 0);
    f.append("many", Array.from({ length: 3000 }, (_, i) => callEnd(ago(MIN - i), `c${i}`)));
    assert.ok(readerFor(f.dir).forCase("tracker:1")[0]!.costUsd <= 0.25 * 2000, "no more than the first 2000 calls are counted");
  } finally {
    f.close();
  }
});
