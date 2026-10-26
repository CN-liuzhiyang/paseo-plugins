import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HOME_SCREEN, RUN_SCREEN } from "../shared/graph";
import { recordingLauncher, resultOf, SUSPECT_MS, UNREAD_SUSPECT_MS } from "../server/flows";
import { copyConfig, preview, previewText } from "../server/preview";
import { createRunReader, createRunsWiring } from "../server/runs";
import { at, makeWorld, probeOf, TZ, type World } from "./helpers";
import { advance, asks, failedProbe, finished, first, flowsOf, headline, idFor, kinds, look, OWNER, POLICY, req, RULE, running, withFlows } from "./flows-kit";
import { set } from "./item-flow";

// What the independent review of the first version found (R7B-01 to R7B-10), each as a test that fails without its fix: a run is
// read where it was started, lines that could not be read are not an end, a budget counts what was spent (across midnight too),
// the breaker counts what is held back, a flow that changed is a new request, one request's success hides no other's failure,
// a late end is not news, a start that cannot be written down is still a start, and a card is put up again for its run only.

/** A rule that asks for nothing: what is in use before a change that asks for runs. */
const QUIET = RULE.replace("if (f.Runs) out.run = JSON.parse(f.Runs);", "");

// ---- R7B-01: the log directory is part of what a run is --------------------------------------------------

test("R7B-01: an intent keeps the log directory it was made under: the process is told it, the run is read from it, and a config that points elsewhere later neither hides the run nor starts it again", () =>
  withFlows(async (w) => {
    const [a, b] = [w.flows.logDir!, path.join(w.dir, "logs-b")];
    asks(w, 1, [req("a")]);
    await first(w);
    const id = idFor(1, "a");
    assert.equal(w.flows.launcher.started[0]!.logDir, a, "the process is given the directory, not left to find its own");
    assert.equal(flowsOf(w)[id]!.logDir, a, "and the intent keeps it");
    // The run finished in A while the controller was away. It comes back with the config pointing at B, where nothing of the run is,
    // and the table there says a run that came to nothing may be started again.
    w.flows.probes.set(`${id}@${a}`, finished({ ok: 1 }));
    w.flows.probes.set(`${id}@${b}`, probeOf({ state: "absent", safeToRestart: true }));
    w.flows.logDir = b;
    await w.crash();
    await look(w, 120);
    await look(w, 120);
    assert.equal(flowsOf(w)[id]!.ended?.outcome, "done", "read where it ran");
    assert.equal(w.flows.launcher.started.length, 1, "and not run a second time in the new directory");
    assert.ok(w.flows.askedDirs.every((d) => d === a), JSON.stringify(w.flows.askedDirs));
    // what is asked for after the change goes where the config says now
    asks(w, 2, [req("a")]);
    await look(w, 1200);
    assert.equal(w.flows.launcher.started.length, 2);
    assert.equal(w.flows.launcher.started[1]!.logDir, b);
    assert.equal(flowsOf(w)[idFor(2, "a")]!.logDir, b);
  }));

test("R7B-01: an intent that was written and not started goes to its own directory when it is started after the config changed; a run again goes to the directory of now", () =>
  withFlows(async (w) => {
    const [a, b] = [w.flows.logDir!, path.join(w.dir, "logs-b")];
    const id = idFor(1, "a");
    asks(w, 1, [req("a")]);
    // the process dies after the intent was written and before the start
    w.flows.failStarts = { count: 1, error: new Error("spawn failed") };
    await first(w);
    assert.equal(w.flows.launcher.started.length, 0);
    assert.equal(flowsOf(w)[id]!.logDir, a);
    w.flows.logDir = b;
    await w.crash();
    await look(w, 60);
    assert.equal(w.flows.launcher.started.length, 1);
    assert.equal(w.flows.launcher.started[0]!.logDir, a, "the run was meant for A");
    // it fails; a person asks for it again: a new id, nothing of it anywhere yet, so the directory of now
    w.flows.probes.set(`${id}@${a}`, failedProbe());
    await look(w, 60);
    assert.equal(w.engine.retryFlow(id, "owner").ok, true);
    await look(w, 60);
    assert.equal(w.flows.launcher.started.length, 2);
    assert.equal(w.flows.launcher.started[1]!.logDir, b);
  }));

test("R7B-01: an engine that is not told the log directory starts nothing for money: the request waits, and says why", async () => {
  const launcher = recordingLauncher();
  const w = await makeWorld({
    start: "2026-10-13 10:00",
    config: { rules: { "flow.mjs": RULE } },
    flows: { launcher, dir: path.join(os.tmpdir(), "reconcile-no-logdir-never-written"), probe: () => probeOf() },
  });
  try {
    asks(w, 1, [req("a")]);
    await first(w);
    assert.deepEqual(Object.keys(flowsOf(w)), [], "no intent: nothing to start");
    assert.match(w.engine.flowResult("gcp-demo:1", "triage", "a")!.why!, /日志目录/);
    assert.equal(w.engine.flowResult("gcp-demo:1", "triage", "a")!.state, "deferred");
    // an intent that has no directory either (one from before intents kept it) is not started for want of one
    const id = idFor(1, "legacy");
    w.store.append([
      {
        type: "flow.intent",
        rec: { runId: id, caseId: "gcp-demo:1", name: "triage", flow: "triage-flow", key: "legacy", round: 0, stage: "review", label: "初查", affairLabel: "x", owner: null, notify: false, maxUsd: 1, timeout: null, input: { n: 1 }, inputHash: "h", rules: "fp", intentAt: "2026-10-13T10:00:00+08:00" },
      },
    ]);
    await look(w, 60);
    assert.equal(launcher.started.length, 0);
    assert.ok(w.engine.status().problems.some((p: string) => /不知道日志目录在哪，没有起/.test(p)), JSON.stringify(w.engine.status().problems));
  } finally {
    w.close();
  }
});

// ---- a real reader on a temp directory: R7B-02 and R7B-03 -------------------------------------------------

interface Rig {
  w: World;
  dir: string;
  /** What the engine started (the launcher only records). */
  launcher: ReturnType<typeof recordingLauncher>;
  file(id: string): string;
  line(id: string, seq: number, kind: string, extra: Record<string, unknown>): string;
  start(id: string, caseNumber: number): string;
  claim(id: string): void;
}

/** An engine reading the run files of a temp directory the way the plugin does; the test writes what the runtime would. */
async function withReader(body: (rig: Rig) => Promise<void>, options: { policy?: unknown } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-review-"));
  const holder: { w?: World } = {};
  const reader = createRunReader({
    runsDir: dir,
    tz: TZ,
    now: () => holder.w?.clock.now ?? 0,
    affair: HOME_SCREEN,
    view: RUN_SCREEN,
    probe: {
      hostname: "demo-host",
      kill() {
        const e = new Error("gone") as NodeJS.ErrnoException;
        e.code = "ESRCH";
        throw e;
      },
    },
  });
  const launcher = recordingLauncher();
  const w = await makeWorld({
    start: "2026-10-13 10:00",
    config: { rules: { "flow.mjs": RULE }, ...(options.policy ? { policy: options.policy } : {}) },
    flows: { launcher, dir: path.join(dir, "out"), logDir: dir, probe: (runId, spawnedAtMs) => reader.probe(runId, spawnedAtMs) },
  });
  holder.w = w;
  const rig: Rig = {
    w,
    dir,
    launcher,
    file: (id) => path.join(dir, `${id}.jsonl`),
    line: (id, seq, kind, extra) => JSON.stringify({ v: 1, seq, ts: new Date(w.clock.now).toISOString(), runId: id, kind, ...extra }) + "\n",
    start: (id, n) => rig.line(id, 1, "run.start", { pid: 123, hostname: "demo-host", flow: { name: "triage-flow", phases: [] }, affair: { link: { ...HOME_SCREEN, params: { case: `gcp-demo:${n}`, stage: "review" } } } }),
    claim: (id) => writeFileSync(path.join(dir, `${id}.claim`), JSON.stringify({ pid: 123, hostname: "demo-host" })),
  };
  try {
    await body(rig);
  } finally {
    w.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A call that cost something and whose end is too long to be read (the reader passes over a line past 4 MB). */
const hugeCall = (rig: Rig, id: string, usd: number) =>
  rig.line(id, 2, "call.start", { callId: "c1", type: "ask", title: "big" }) + rig.line(id, 3, "call.end", { callId: "c1", ok: true, cost: { usd }, output: { pad: "x".repeat(5 * 1024 * 1024) } });

test("R7B-02: lines of a run that could not be read are not an end: a run that went quiet is waited for longer, told with its cost as not known, and a true end that comes is taken", () =>
  withReader(async (rig) => {
    const { w } = rig;
    asks(w, 1, [req("a")]);
    await first(w);
    const id = idFor(1, "a");
    writeFileSync(rig.file(id), rig.start(id, 1) + hugeCall(rig, id, 2));
    rig.claim(id);
    await look(w, 60);
    // the usual second look: seen once, then again after SUSPECT_MS
    await look(w, SUSPECT_MS / 1000 + 1);
    assert.equal(flowsOf(w)[id]!.ended, undefined, "it wrote something that was not read: not told as lost after the usual second look");
    assert.equal(w.engine.flowResult("gcp-demo:1", "triage", "a")!.state, "slow");
    assert.equal(w.engine.graph("gcp-demo:1")!.runs[0]!.maybeAsleep, true);
    // a longer look, and then it is told as it is: broken, and what it spent not known
    await look(w, UNREAD_SUSPECT_MS / 1000 + 1);
    const ended = flowsOf(w)[id]!.ended!;
    assert.equal(ended.outcome, "lost");
    assert.equal(ended.costUnknown, true, "the cost was not read: not told as nothing");
    assert.match(ended.why!, /读不全/);
  }));

test("R7B-02: the end of a run that wrote lines too long to read is still its end, with the runtime's own total for what it cost", () =>
  withReader(async (rig) => {
    const { w } = rig;
    asks(w, 1, [req("a")]);
    await first(w);
    const id = idFor(1, "a");
    writeFileSync(rig.file(id), rig.start(id, 1) + hugeCall(rig, id, 2));
    rig.claim(id);
    await look(w, 60);
    await look(w, SUSPECT_MS / 1000 + 1);
    assert.equal(flowsOf(w)[id]!.ended, undefined);
    appendFileSync(rig.file(id), rig.line(id, 4, "run.end", { outcome: "done", summary: "好", value: { ok: true }, cost: { totalUsd: 2, agentCount: 1, partial: "" } }));
    await look(w, 10);
    const ended = flowsOf(w)[id]!.ended!;
    assert.deepEqual([ended.outcome, ended.costUsd, ended.costUnknown], ["done", 2, undefined], "the total the runtime gave, not the sum of what could be read");
  }));

test("R7B-03: what a run cost is the runtime's own total when it gave one, and the budget holds what was spent even when a call's line was too long to read", () =>
  withReader(
    async (rig) => {
      const { w } = rig;
      asks(w, 1, [req("a")]);
      await first(w);
      const id = idFor(1, "a");
      writeFileSync(rig.file(id), rig.start(id, 1) + hugeCall(rig, id, 2) + rig.line(id, 4, "run.end", { outcome: "done", summary: "好", value: { ok: true }, cost: { totalUsd: 2, agentCount: 1, partial: "" } }));
      await look(w, 60);
      assert.equal(flowsOf(w)[id]!.ended!.costUsd, 2, "the sum of what could be read is 0: the total is 2");
      asks(w, 2, [req("b")]);
      await look(w, 1200);
      assert.equal(rig.launcher.started.length, 1, "$2 is spent of $1 a day: the next one waits");
      assert.match(w.engine.flowResult("gcp-demo:2", "triage", "b")!.why!, /今天流程花费已到 \$2\.00/);
    },
    { policy: POLICY({ usdPerDay: 1, concurrent: 2 }) },
  ));

test("R7B-03: a run that ended without a total and whose lines were not all read counts for at least its ceiling in the budget", () =>
  withReader(
    async (rig) => {
      const { w } = rig;
      asks(w, 1, [req("a")]);
      await first(w);
      const id = idFor(1, "a");
      // the end line has no cost to give, and a call's line before it was past what is read
      writeFileSync(rig.file(id), rig.start(id, 1) + hugeCall(rig, id, 2) + rig.line(id, 4, "run.end", { outcome: "done", summary: "好", value: { ok: true } }));
      await look(w, 60);
      const ended = flowsOf(w)[id]!.ended!;
      assert.deepEqual([ended.costUsd, ended.costUnknown], [0, true]);
      asks(w, 2, [req("b")]);
      await look(w, 1200);
      assert.equal(rig.launcher.started.length, 1, "nothing was read of the cost, and the ceiling of $1 is held: the next waits");
    },
    { policy: POLICY({ usdPerDay: 1, concurrent: 2 }) },
  ));

test("R7B-03: more calls than the reader keeps are not read as a cost of less: the total is what counts, and without it the cost is said not to be known", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-review-"));
  try {
    const now = at("2026-10-13 10:00");
    const reader = createRunReader({ runsDir: dir, tz: TZ, now: () => now, affair: HOME_SCREEN, view: RUN_SCREEN });
    const lines = (id: string, end: Record<string, unknown> | null) => {
      const ts = new Date(now).toISOString();
      const line = (seq: number, kind: string, extra: Record<string, unknown>) => JSON.stringify({ v: 1, seq, ts, runId: id, kind, ...extra }) + "\n";
      let out = line(1, "run.start", { flow: { name: "f", phases: [] }, affair: { link: { ...HOME_SCREEN, params: { case: "gcp-demo:1", stage: "review" } } } });
      for (let i = 0; i < 2100; i++) out += line(2 + 2 * i, "call.start", { callId: `c${i}`, type: "do", title: "t" }) + line(3 + 2 * i, "call.end", { callId: `c${i}`, ok: true, cost: { usd: 0.01 } });
      return out + (end ? line(9999, "run.end", end) : "");
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "with-total.jsonl"), lines("with-total", { outcome: "done", cost: { totalUsd: 21, agentCount: 1, partial: "" } }));
    writeFileSync(path.join(dir, "no-total.jsonl"), lines("no-total", { outcome: "done" }));
    const [a, b] = [reader.probe("with-total", null), reader.probe("no-total", null)];
    assert.deepEqual([a.costUsd, a.costKnown], [21, true]);
    assert.equal(b.costKnown, false, "2000 of the 2100 calls were kept: what was added up is not all of it");
    assert.ok(b.costUsd > 0 && b.costUsd < 21);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R7B-01: what the plugin wires up: the log directory is found once and absolute, a run is probed in the directory it is given, and none given is the current one", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "reconcile-review-"));
  try {
    const [a, b] = [path.join(base, "a"), path.join(base, "b")];
    mkdirSync(path.join(b, "runs"), { recursive: true });
    const now = at("2026-10-13 10:00");
    const ts = new Date(now).toISOString();
    const line = (seq: number, kind: string, extra: Record<string, unknown>) => JSON.stringify({ v: 1, seq, ts, runId: "rc-x", kind, ...extra }) + "\n";
    writeFileSync(
      path.join(b, "runs", "rc-x.jsonl"),
      line(1, "run.start", { flow: { name: "f", phases: [] }, affair: { link: { ...HOME_SCREEN, params: { case: "gcp-demo:1", stage: "review" } } } }) + line(2, "run.end", { outcome: "done", summary: "好", value: null }),
    );
    const wiring = createRunsWiring({ tz: TZ, now: () => now, log: () => {}, env: { ORCH_LOG_DIR: path.relative(process.cwd(), a) } })!;
    assert.equal(wiring.logDir, path.resolve(a), "absolute, whatever it was written as");
    assert.equal(wiring.probe("rc-x", null, b).state, "ended", "read from the directory the intent fixed");
    assert.equal(wiring.probe("rc-x", null, a).state, "absent");
    assert.equal(wiring.probe("rc-x", null, null).state, "absent", "none fixed: the current one");
    assert.deepEqual(wiring.runs("gcp-demo:1"), [], "the page lists from the current directory only");
    // a config that cannot be read is not guessed around: no log directory to start under -- and the runs already going are still read
    const bad = path.join(base, "bad.json");
    writeFileSync(bad, "{not json");
    const blind = createRunsWiring({ tz: TZ, now: () => now, log: () => {}, env: { ORCH_CONFIG: bad } });
    assert.equal(blind.logDir, null);
    assert.deepEqual(blind.runs("gcp-demo:1"), []);
    assert.equal(blind.probe("rc-x", null, b).state, "ended", "a run whose intent fixed a directory is read from it all the same");
    const nowhere = blind.probe("rc-x", null, null);
    assert.deepEqual([nowhere.state, nowhere.reachable, nowhere.safeToRestart], ["absent", false, false], "with none to look in, nothing is concluded from not seeing it");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("R7B-01: a directory that cannot be read is not a directory with nothing in it: a run started in it is not started again", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-review-"));
  try {
    const now = at("2026-10-13 10:00");
    // a file where the directory should be: listing it is an error that is not "there is no such directory"
    const notADir = path.join(dir, "runs");
    writeFileSync(notADir, "x");
    const stuck = createRunReader({ runsDir: notADir, tz: TZ, now: () => now, affair: HOME_SCREEN, view: RUN_SCREEN }).probe("rc-x", now - 600_000);
    assert.deepEqual([stuck.state, stuck.reachable], ["absent", false]);
    // one that is not there yet is nothing to list, as before
    const none = createRunReader({ runsDir: path.join(dir, "nowhere"), tz: TZ, now: () => now, affair: HOME_SCREEN, view: RUN_SCREEN }).probe("rc-x", now - 600_000);
    assert.deepEqual([none.state, none.reachable], ["absent", true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await withFlows(async (w) => {
    asks(w, 1, [req("a")]);
    await first(w);
    const id = idFor(1, "a");
    w.flows.probes.set(id, probeOf({ state: "absent", safeToRestart: true, reachable: false }));
    await look(w, 300);
    await look(w, 300);
    assert.equal(w.flows.launcher.started.length, 1, "the table says it may be started again, but nothing could be looked at: it is not");
    assert.equal(flowsOf(w)[id]!.ended, undefined);
    assert.equal(w.engine.flowResult("gcp-demo:1", "triage", "a")!.state, "slow");
    assert.ok(w.engine.status().problems.some((p: string) => /读不到流程的日志目录/.test(p)), JSON.stringify(w.engine.status().problems));
  });
});

// ---- R7B-04: the budget of a day that a run crosses ------------------------------------------------------

test("R7B-04: a run still going from yesterday holds its ceiling in today's budget", () =>
  withFlows(
    async (w) => {
      const [a, b] = [idFor(1, "a"), idFor(2, "b")];
      // both ask at 23:58: the first starts, the second is over the day's $1 and waits
      asks(w, 1, [req("a")]);
      asks(w, 2, [req("b")]);
      await first(w);
      w.flows.probes.set(a, running());
      assert.equal(w.flows.launcher.started.length, 1);
      assert.match(w.engine.flowResult("gcp-demo:2", "triage", "b")!.why!, /今天流程花费已到 \$1\.00/);
      w.clock.now = at("2026-10-14 00:01");
      await first(w);
      assert.equal(w.flows.launcher.started.length, 1, "$1 a day, and $1 is still being spent by the run of yesterday");
      assert.match(w.engine.flowResult("gcp-demo:2", "triage", "b")!.why!, /今天流程花费已到 \$1\.00（上限 \$1）/);
      // it ends, costing nothing: what it held is let go, and the next one starts
      w.flows.probes.set(a, finished({ ok: 1 }, {}, 0));
      await look(w, 300);
      await look(w, 60);
      assert.equal(w.flows.launcher.started.length, 2);
      assert.ok(flowsOf(w)[b]);
    },
    { start: "2026-10-13 23:58", policy: POLICY({ usdPerDay: 1, concurrent: 2 }) },
  ));

test("R7B-04: a run that began yesterday and ended today spent what it cost today", () =>
  withFlows(
    async (w) => {
      const a = idFor(1, "a");
      asks(w, 1, [req("a")]);
      asks(w, 2, [req("b")]);
      await first(w);
      w.flows.probes.set(a, running());
      await look(w, 60);
      w.clock.now = at("2026-10-14 00:05");
      w.flows.probes.set(a, finished({ ok: 1 }, {}, 0.8));
      await first(w);
      assert.equal(flowsOf(w)[a]!.ended!.costUsd, 0.8);
      await look(w, 60);
      assert.equal(w.flows.launcher.started.length, 1, "$0.80 of $1 spent today: another that may cost $1 waits");
      assert.match(w.engine.flowResult("gcp-demo:2", "triage", "b")!.why!, /今天流程花费已到 \$0\.80/);
    },
    { start: "2026-10-13 23:58", policy: POLICY({ usdPerDay: 1, concurrent: 2 }) },
  ));

test("R7B-04: what a run cost on a day gone by is not today's spending", () =>
  withFlows(
    async (w) => {
      const a = idFor(1, "a");
      asks(w, 1, [req("a")]);
      await first(w);
      w.flows.probes.set(a, finished({ ok: 1 }, {}, 0.8));
      await look(w, 60);
      assert.equal(flowsOf(w)[a]!.ended!.costUsd, 0.8);
      // the next day starts with nothing spent: another that may cost $1 starts
      w.clock.now = at("2026-10-14 10:00");
      asks(w, 2, [req("b")]);
      await first(w);
      await look(w, 1200);
      assert.equal(w.flows.launcher.started.length, 2, "$0.80 was yesterday's");
    },
    { policy: POLICY({ usdPerDay: 1, concurrent: 2 }) },
  ));

// ---- R7B-05: the breaker counts what is held back --------------------------------------------------------

test("R7B-05: a change of rules that asks for many runs is held however few a limit lets start now, and the preview lists the ones that wait", () =>
  withFlows(
    async (w) => {
      for (let n = 1; n <= 4; n++) asks(w, n, [req("a")]);
      await first(w);
      const candidate = mkdtempSync(path.join(os.tmpdir(), "reconcile-candidate-"));
      try {
        rmSync(candidate, { recursive: true });
        copyConfig(w.configDir, candidate);
        writeFileSync(path.join(candidate, "rules", "flow.mjs"), RULE);
        const p = await preview({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now });
        assert.equal(p.flows.length, 4);
        assert.equal(p.flows.filter((f) => f.later).length, 2, "two start, two wait for room");
        assert.deepEqual(p.breaker, { changes: { newCommitments: 0, dropped: 0, changed: 0, reopened: 0, flows: 4 }, limit: 3 });
        assert.match(previewText(p), /⚠ 这个改动一下子会起 4 个流程/);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
      writeFileSync(path.join(w.configDir, "rules", "flow.mjs"), RULE);
      await look(w, 60);
      const held = w.store.state.rules.held!;
      assert.ok(held, "four are asked for at once, and only two could start: still four");
      assert.equal(held.flows, 4);
      assert.equal(w.flows.launcher.started.length, 0);
      assert.deepEqual(Object.keys(flowsOf(w)), []);
      // let through: they start as room comes
      assert.equal(w.engine.releaseRules(held.fingerprint), true);
      await look(w, 60);
      assert.equal(w.flows.launcher.started.length, 2);
      for (const id of Object.keys(flowsOf(w))) w.flows.probes.set(id, finished({ ok: 1 }));
      await look(w, 60);
      await look(w, 60);
      assert.equal(w.flows.launcher.started.length, 4);
    },
    { policy: POLICY({ concurrent: 2 }), rule: QUIET },
  ));

test("R7B-05: a request held back by a limit that nothing else asks for is not a change of rules: it does not hold anything", () =>
  withFlows(
    async (w) => {
      for (let n = 1; n <= 4; n++) asks(w, n, [req("a")]);
      await first(w);
      assert.equal(w.store.state.rules.held, null, "the rules did not change: four requests, two of them waiting for room, is the day as it is");
      assert.equal(w.flows.launcher.started.length, 2);
    },
    { policy: POLICY({ concurrent: 2 }) },
  ));

// ---- R7B-06: a name made to stand for another flow --------------------------------------------------------

test("R7B-06: a rule that makes its name stand for another flow asks for a new run, the old run's result is not handed to it, and the old one is still there to go back to", () =>
  withFlows(async (w) => {
    const file = path.join(w.configDir, "rules", "flow.mjs");
    asks(w, 1, [req("a")], { Watch: "triage:a" });
    await first(w);
    const old = idFor(1, "a");
    w.flows.probes.set(old, finished({ old: true }));
    await look(w, 60);
    assert.match(headline(w, 1)!, /triage:a=done\{"old":true\}/);
    writeFileSync(file, RULE.replace('flow: "triage-flow"', 'flow: "replacement-flow"'));
    await look(w, 60);
    assert.deepEqual(w.flows.launcher.started.map((s) => s.flow), ["triage-flow", "replacement-flow"], "the new flow is started");
    assert.doesNotMatch(headline(w, 1)!, /old/, "and what the old one returned is not given as its result");
    const replaced = w.flows.launcher.started[1]!.runId;
    assert.notEqual(replaced, old);
    assert.equal(w.engine.flowResult("gcp-demo:1", "triage", "a")!.runId, replaced);
    w.flows.probes.set(replaced, finished({ replaced: true }));
    await look(w, 60);
    assert.match(headline(w, 1)!, /triage:a=done\{"replaced":true\}/);
    // back to the first flow: that is the request it was, and its result is there; nothing is started
    writeFileSync(file, RULE);
    await look(w, 60);
    assert.equal(w.flows.launcher.started.length, 2);
    assert.match(headline(w, 1)!, /triage:a=done\{"old":true\}/);
    assert.equal(Object.keys(flowsOf(w)).length, 2, "the first run's record was not written over");
    assert.equal(flowsOf(w)[old]!.ended?.outcome, "done");
  }));

test("R7B-06: a run going under a flow the rule no longer names is said to be one it does not ask for", () =>
  withFlows(async (w) => {
    const file = path.join(w.configDir, "rules", "flow.mjs");
    asks(w, 1, [req("a")]);
    await first(w);
    const old = idFor(1, "a");
    w.flows.probes.set(old, running());
    writeFileSync(file, RULE.replace('flow: "triage-flow"', 'flow: "replacement-flow"'));
    await look(w, 60);
    const runs = w.engine.graph("gcp-demo:1")!.runs;
    assert.equal(runs.find((r) => r.runId === old)!.unwanted, true);
    assert.equal(runs.find((r) => r.runId !== old)!.unwanted, undefined);
  }));

// ---- R7B-07: one request's success hides no other's failure -----------------------------------------------

test("R7B-07: two requests in one stage are two: the success of one does not hide the failure of the other, and a run again of the same request still replaces the earlier round", () =>
  withFlows(async (w) => {
    asks(w, 1, [req("a")]);
    await first(w);
    w.flows.probes.set(idFor(1, "a"), failedProbe());
    await look(w, 60);
    asks(w, 1, [req("a"), req("b")]);
    await look(w, 1200);
    w.flows.probes.set(idFor(1, "b"), finished({ ok: true }));
    await look(w, 60);
    const g = w.engine.graph("gcp-demo:1")!;
    assert.equal(g.runs.find((r) => r.runId === idFor(1, "a"))!.situation, "fail");
    assert.equal(g.runs.find((r) => r.runId === idFor(1, "b"))!.situation, "done");
    assert.match(g.hero.kicker, /流程失败了/, "the failure of the first is still the item's condition");
    // asked again (a new round): the second round is the one that counts for that request
    assert.equal(w.engine.retryFlow(idFor(1, "a"), "owner").ok, true);
    await look(w, 60);
    w.flows.probes.set(idFor(1, "a", "triage", 1), finished({ ok: true }));
    await look(w, 60);
    assert.doesNotMatch(w.engine.graph("gcp-demo:1")!.hero.kicker, /流程失败了/, "the round that came to a result replaced the one that did not");
  }));

// ---- R7B-08: a late end is not news ----------------------------------------------------------------------

test("R7B-08: a run that ended long before the controller found out is not told as news; its end is when the run ended", () =>
  withFlows(
    async (w) => {
      const id = idFor(1, "a");
      asks(w, 1, [req("a")]);
      await first(w);
      const ranTo = at("2026-10-13 10:00");
      w.flows.probes.set(id, finished({ ok: 1 }, { at: ranTo }));
      // the controller was away a day
      w.clock.now = at("2026-10-14 10:00");
      await w.restart();
      await first(w);
      const ended = flowsOf(w)[id]!.ended!;
      assert.equal(Date.parse(ended.completedAt!), ranTo);
      assert.equal(Date.parse(ended.at), at("2026-10-14 10:00"), "recorded when it was found");
      assert.equal(w.deliveries.length, 0, "a day old: not sent");
      assert.equal(w.store.state.ledger[`flow-notify:${id}:chat:u1`]!.status, "suppressed");
      assert.equal(w.engine.flowResult("gcp-demo:1", "triage", "a")!.endedAt, new Date(ranTo).toISOString());
    },
    { start: "2026-10-13 09:55", persons: OWNER() },
  ));

// ---- R7B-09: a start that could not be written down is still a start --------------------------------------

test("R7B-09: the process started and the journal could not take the record of it: that is not a failed start, the run is read as the run it is, and the record is written when it can be", async () => {
  for (const crash of [false, true]) {
    await withFlows(async (w) => {
      asks(w, 1, [req("a")], { Watch: "triage:a" });
      const id = idFor(1, "a");
      w.flows.onStart = () => w.flows.probes.set(id, running());
      const append = w.store.append.bind(w.store);
      let once = true;
      w.store.append = (events) => {
        if (once && events.some((e) => e.type === "flow.spawned")) {
          once = false;
          throw new Error("injected journal failure");
        }
        return append(events);
      };
      await first(w);
      assert.equal(w.flows.launcher.started.length, 1);
      assert.equal(kinds(w).includes("flow.spawn-failed"), false, "it did start");
      assert.equal(flowsOf(w)[id]!.spawnError, undefined);
      if (crash) await w.crash();
      await look(w, 60);
      assert.equal(w.flows.launcher.started.length, 1, "and was not started again");
      assert.equal(w.engine.flowResult("gcp-demo:1", "triage", "a")!.state, "running", "what the runtime's files say, not the queue it was left in");
      assert.ok(flowsOf(w)[id]!.spawnedAt, "the start is written down now");
      assert.equal(flowsOf(w)[id]!.spawnTries, 1);
      assert.match(headline(w, 1)!, /triage:a=running/);
      w.flows.probes.set(id, finished({ ok: 1 }));
      await look(w, 60);
      assert.equal(flowsOf(w)[id]!.ended?.outcome, "done");
    });
  }
});

test("R7B-09: what the runtime's files say of a run outranks the queue it is left in when the record of its start is missing", () => {
  const rec = {
    runId: "rc-x-1", caseId: "gcp-demo:1", name: "triage", flow: "triage-flow", key: "a", round: 0, stage: "review", label: "初查", affairLabel: "x", owner: null, notify: false,
    maxUsd: 1, timeout: null, input: { n: 1 }, inputHash: "h", rules: "fp", intentAt: "2026-10-13T10:00:00+08:00",
  };
  assert.equal(resultOf(rec, "running").state, "running");
  assert.equal(resultOf(rec, "gate").state, "gate");
  assert.equal(resultOf(rec, null).state, "queued", "nothing known of it: it is waiting to be started");
  assert.equal(resultOf({ ...rec, spawnedAt: "2026-10-13T10:00:01+08:00" }, null).state, "starting");
});

// ---- R7B-10: a card is put up again for its run, once ----------------------------------------------------

test("R7B-10: an end that did not change a card's words is seen and spent: a change of its words long after, for any other reason, does not put the card up again", () =>
  withFlows(async (w) => {
    asks(w, 1, [req("a")], { Ask: "2026-10-13" });
    await first(w);
    assert.equal(w.cards.length, 1);
    w.flows.probes.set(idFor(1, "a"), finished({ unused: true }));
    await look(w, 60);
    assert.equal(w.cards.length, 1, "the run ended and the words did not change");
    // this rule never reads the run: long after, it rewrites a word for another reason
    asks(w, 1, [req("a")], { Ask: "2026-10-13", Word: "unrelated changed word" });
    await look(w, 1200);
    assert.equal(w.cards.length, 1, "not the run's doing: the card stays as it is");
    assert.equal(w.journal().filter((e) => e.type === "card.changed" && String((e.patch as { reason?: string }).reason ?? "").includes("流程有了结局")).length, 0);
  }));

test("R7B-10: a run that ends and does change the words still puts the card up again, once, and the next end does the same", () =>
  withFlows(async (w) => {
    asks(w, 1, [req("a"), req("b")], { Ask: "2026-10-13", Watch: "triage:a,triage:b" });
    await first(w);
    assert.equal(w.cards.length, 1);
    w.flows.probes.set(idFor(1, "a"), finished({ first: true }));
    await look(w, 60);
    assert.equal(w.cards.length, 2);
    w.flows.probes.set(idFor(1, "b"), finished({ second: true }));
    await look(w, 60);
    assert.equal(w.cards.length, 3);
    await look(w, 600);
    assert.equal(w.cards.length, 3);
  }));
