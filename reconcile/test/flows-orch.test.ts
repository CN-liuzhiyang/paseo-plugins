import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOME_SCREEN, RUN_SCREEN } from "../shared/graph";
import { createLauncher, runIdOf } from "../server/flows";
import { createOutReader, createRunReaders } from "../server/runs";
import { makeWorld, TEST_POLICY, TZ, type World } from "./helpers";
import { set } from "./item-flow";

// The engine against the real runtime: `orch.mjs run` started as a process of its own, a flow that spends nothing (it waits,
// it returns what it was given), and the runtime's own claim and event files read back. Slower than the rest (each run is a
// real process); what it proves is what the fakes cannot: that the files the runtime writes are the files the engine reads.

const here = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.join(here, "..", "..", "orchestration", "runtime", "orch.mjs");
const FLOW_MJS = pathToFileURL(path.join(here, "..", "..", "orchestration", "runtime", "flow.mjs")).href;

const DEMO = `import { flow, text, count } from ${JSON.stringify(FLOW_MJS)};
export default flow({
  name: "demo-triage",
  description: "spends nothing: waits as long as it is asked, then returns what it was given",
  phases: [{ id: "work", title: "work" }],
  inputs: { word: text("word"), waitMs: count("how long to wait"), blow: text("fail with this message"), pad: count("bytes of padding in the result") },
  grants: [],
  summarize: (value) => "got " + value.word,
  async run({ word, waitMs, blow, pad }, $) {
    return await $.phase("work", async () => {
      await $.do("wait", () => new Promise((resolve) => setTimeout(resolve, waitMs ?? 0)));
      if (blow) throw new Error(blow);
      return { word, found: 2, pad: "p".repeat(pad ?? 0) };
    });
  },
});
`;

/** A flow that writes a great deal to stdout before it returns, as a flow that logs does: the runner prints its result after all of it. */
const NOISY = `import { flow, count } from ${JSON.stringify(FLOW_MJS)};
export default flow({
  name: "demo-noisy",
  description: "spends nothing: writes a great deal to stdout, then returns",
  phases: [{ id: "work", title: "work" }],
  inputs: { noise: count("bytes written to stdout before the result") },
  grants: [],
  summarize: () => "noisy done",
  async run({ noise }, $) {
    return await $.phase("work", async () => {
      await $.do("shout", () => { process.stdout.write("x".repeat(Math.max(0, noise - 1)) + "\\n"); });
      return { found: 3 };
    });
  },
});
`;

/**
 * A flow in two parts that spends nothing: the first says how it could be carried on (the same flow, its second part) and stops, saying in
 * its value that it did not get done what it was for; the second returns what it is given.
 */
const TWO_PARTS = `import { flow, text, choice } from ${JSON.stringify(FLOW_MJS)};
export default flow({
  name: "demo-resume",
  description: "spends nothing: the first part stops and says how it could be carried on, the second part returns",
  phases: [{ id: "work", title: "work" }],
  inputs: { word: text("word"), stage: choice(["start", "finish"], "which part") },
  grants: [],
  summarize: (value) => "got " + value.word + " in " + value.stage,
  async run({ word, stage }, $) {
    return await $.phase("work", async () => {
      if (stage === "start") {
        await $.resumeWith({ flow: "demo-resume", input: { word, stage: "finish" }, from: "第一段做完了：从第二段接着", spends: "nothing" });
        return $.stop("第一段停在这里", { why: "第一段停在这里，接着跑第二段", word, stage });
      }
      return { word, stage };
    });
  },
});
`;

/** A rule that asks for runs as its item's `Runs` field says, and shows what it reads of them. */
const RULE = `export const flows = {
  demo: { flow: "demo-triage", timeout: "1m", maxUsd: 0.1 },
  noisy: { flow: "demo-noisy", timeout: "1m", maxUsd: 0.1 },
  hurried: { flow: "demo-triage", timeout: "1s", maxUsd: 0.1 },
  missing: { flow: "no-such-flow", maxUsd: 0.1 },
  twoparts: { flow: "demo-resume", timeout: "1m", maxUsd: 0.1 },
};
export default {
  name: "orchrule", description: "x", applies: { source: "gcp-demo" }, params: {},
  stages: [{ id: "review", label: "评审" }, { id: "finished", label: "完成", end: true }],
  assess(kase, ctx) {
    const f = kase.primary.fields;
    const seen = (f.Watch || "").split(",").filter(Boolean).map((w) => {
      const [n, k] = w.split(":");
      const r = ctx.run(n, k);
      return n + ":" + k + "=" + (r ? r.state + (r.value ? JSON.stringify(r.value).slice(0, 60) : "") + (r.summary ? " / " + r.summary : "") : "-");
    });
    const out = { stage: "review", health: "on-track", headline: "r " + seen.join(" "), next: { actor: "them", what: "等" }, facts: [], commitments: [] };
    if (f.Runs) out.run = JSON.parse(f.Runs);
    return out;
  },
};`;

interface Rig {
  w: World;
  logDir: string;
  runsDir: string;
  /** What the engine is given to start flows with: the test may change its `logDir`, as a plugin that comes back to another config has. */
  flowsDeps: { logDir: string | null; dir: string };
  /** How many processes the launcher was asked to start. */
  starts: number[];
  /** Moves the engine's clock (and the reader's) on without waiting. */
  skew: { ms: number };
  tick(): Promise<void>;
  /** Ticks until the test's condition holds (a real process takes real time), at most `ms`. */
  until(done: () => boolean, ms?: number): Promise<void>;
}

/** The day's limits wide open: these tests start several runs at once. */
const WIDE = { ...TEST_POLICY, flows: { perDay: 20, usdPerDay: 50, perCasePerDay: 9, concurrent: 9 } };

async function withRig(body: (rig: Rig) => Promise<void>, options: { envDir?: string } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "reconcile-orch-"));
  const flowsDir = path.join(base, "flows");
  const logDir = path.join(base, "logs");
  mkdirSync(flowsDir);
  mkdirSync(logDir);
  writeFileSync(path.join(flowsDir, "demo-triage.mjs"), DEMO);
  writeFileSync(path.join(flowsDir, "demo-noisy.mjs"), NOISY);
  writeFileSync(path.join(flowsDir, "demo-resume.mjs"), TWO_PARTS);
  const configFile = path.join(base, "orch-config.json");
  writeFileSync(configFile, JSON.stringify({ flowsDirs: [flowsDir] }));
  const env = { ...process.env, ORCH_CONFIG: configFile, ORCH_LOG_DIR: logDir };
  // the processes the launcher starts inherit this; the test's own process is put back afterwards
  const saved = { ORCH_CONFIG: process.env.ORCH_CONFIG, ORCH_LOG_DIR: process.env.ORCH_LOG_DIR };
  // what the process would resolve for itself, when it is not told: a test may make that something else than the directory the engine uses
  Object.assign(process.env, { ORCH_CONFIG: env.ORCH_CONFIG, ORCH_LOG_DIR: options.envDir ? path.join(base, options.envDir) : env.ORCH_LOG_DIR });
  const skew = { ms: 0 };
  const now = () => Date.now() + skew.ms;
  const runsDir = path.join(logDir, "runs");
  const readers = createRunReaders({ tz: TZ, now, affair: HOME_SCREEN, view: RUN_SCREEN }, logDir);
  const real = createLauncher({ command: [process.execPath, ORCH] });
  const starts: number[] = [];
  const flowsDeps = {
    launcher: {
      start: (spec: Parameters<typeof real.start>[0]) => {
        starts.push(Date.now());
        return real.start(spec);
      },
    },
    dir: path.join(base, "flows-out"),
    logDir: logDir as string | null,
    probe: (runId: string, spawnedAtMs: number | null, dir: string | null) => readers.forDir(dir ?? logDir).probe(runId, spawnedAtMs),
    readOut: createOutReader(path.join(base, "flows-out")),
  };
  const local = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
  const w = await makeWorld({
    start: local,
    config: { rules: { "orch.mjs": RULE }, policy: WIDE },
    runs: (caseId) => readers.current.forCase(caseId),
    flows: flowsDeps,
  });
  const tick = async () => {
    w.clock.now = now();
    await w.engine.tick();
    await w.engine.settled();
  };
  const until = async (done: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`gave up waiting: ${JSON.stringify(Object.values(w.store.state.flows ?? {}).map((r) => [r.runId, r.spawnedAt ? "spawned" : "queued", r.ended?.outcome ?? null]))}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tick();
    }
  };
  try {
    await body({ w, logDir, runsDir, flowsDeps, starts, skew, tick, until });
  } finally {
    w.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // processes of the runs may still be finishing: a short wait, then the directory goes
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const today = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const ask = (w: World, n: number, runs: unknown[], watch: string) => set(w, n, { Release: today(), Runs: JSON.stringify(runs), Watch: watch });
const ids = (n: number, flowName: string, key: string, flowFile = "demo-triage", round = 0) => runIdOf("test", `gcp-demo:${n}`, flowName, flowFile, key, round);
/** A request for the demo flow, whose inputs are all required: what a test does not name is nothing. */
const run = (key: string, input: Record<string, unknown>, flow = "demo", label = "初查") => ({ flow, key, input: { word: "x", waitMs: 0, blow: "", pad: 0, ...input }, label });
const flowsOf = (w: World) => w.store.state.flows ?? {};
const headline = (w: World, n: number) => w.store.state.assessments[`gcp-demo:${n}`]?.headline ?? "";
const eventsOf = (runsDir: string, runId: string) =>
  readFileSync(path.join(runsDir, `${runId}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// ---- a run, start to result ---------------------------------------------------------------------------------

test("a run asked for by a rule is started as a process of its own, runs, and its result comes back to the rule", () =>
  withRig(async ({ w, runsDir, tick, until }) => {
    const id = ids(1, "demo", "k1");
    ask(w, 1, [run("k1", { word: "hi", waitMs: 400 })], "demo:k1");
    await tick();
    assert.ok(flowsOf(w)[id]?.spawnedAt, "the process was started");
    assert.ok(typeof flowsOf(w)[id]!.pid === "number");
    await until(() => !!flowsOf(w)[id]!.ended);
    const ended = flowsOf(w)[id]!.ended!;
    assert.deepEqual([ended.outcome, ended.summary, ended.value, ended.costUsd, ended.valueDropped], ["done", "got hi", { word: "hi", found: 2, pad: "" }, 0, false]);
    await tick();
    assert.match(headline(w, 1), /^r demo:k1=done\{"word":"hi","found":2,"pad":""\} \/ got hi$/);
    // what the process was given, and what the runtime wrote down about it
    const events = eventsOf(runsDir, id);
    const start = events.find((e) => e.kind === "run.start") as { affair: { label: string; url: string; link: { plugin: string; screen: string; params: Record<string, string> } }; input: unknown; flow: { name: string } };
    assert.equal(start.flow.name, "demo-triage");
    assert.deepEqual(start.input, { word: "hi", waitMs: 400, blow: "", pad: 0 });
    assert.match(start.affair.label, /^#1 · 评审 · 初查$/);
    assert.equal(start.affair.url, "https://tracker.example/issues/1");
    assert.deepEqual([start.affair.link.plugin, start.affair.link.screen, start.affair.link.params], ["reconcile", "inbox", { case: "gcp-demo:1", stage: "review" }]);
    assert.equal(events.filter((e) => e.kind === "run.end").length, 1);
    // and the page reads the same files: the run is the item's, its own
    const view = w.engine.graph("gcp-demo:1")!.runs;
    assert.deepEqual(view.map((r) => [r.runId, r.own, r.situation]), [[id, true, "done"]]);
  }));

test("the same run id started twice runs once: the runtime takes the id before it spends anything, and the second process is told so", () =>
  withRig(async ({ w, runsDir, until, tick }) => {
    const id = ids(1, "demo", "k1");
    ask(w, 1, [run("k1", { word: "once", waitMs: 1500 })], "demo:k1");
    await tick();
    assert.ok(flowsOf(w)[id]?.spawnedAt);
    // another process for the same id while the first is going (a restart that did not know it had started one)
    const launcher = createLauncher({ command: [process.execPath, ORCH] });
    const flowsOut = path.join(w.dir, "again");
    mkdirSync(flowsOut);
    writeFileSync(path.join(flowsOut, "in.json"), JSON.stringify({ word: "twice", waitMs: 0 }));
    writeFileSync(path.join(flowsOut, "affair.json"), JSON.stringify({ label: "again" }));
    await launcher.start({ runId: id, flow: "demo-triage", timeout: "1m", inputFile: path.join(flowsOut, "in.json"), affairFile: path.join(flowsOut, "affair.json"), outFile: path.join(flowsOut, "out.txt") });
    await until(() => !!flowsOf(w)[id]!.ended);
    // let the second process finish writing what it has to say (it is refused, and says so)
    for (let i = 0; i < 100 && !(existsSync(path.join(flowsOut, "out.txt")) && readFileSync(path.join(flowsOut, "out.txt"), "utf8").includes("\n")); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const events = eventsOf(runsDir, id);
    assert.equal(events.filter((e) => e.kind === "run.start").length, 1, "one start");
    assert.equal(events.filter((e) => e.kind === "run.end").length, 1, "one end");
    assert.deepEqual(flowsOf(w)[id]!.ended!.value, { word: "once", found: 2, pad: "" }, "the first one's result");
    // refused either way, in the runtime's words for how far the first one had got: its claim is held, or its events are written
    assert.match(readFileSync(path.join(flowsOut, "out.txt"), "utf8"), /RunRefused: run id \S+ (is already taken|already has events)/);
    assert.equal(readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")).length, 1);
  }));

test("a plugin reload (or a crash) in the middle of a run neither starts it again nor loses it", () =>
  withRig(async ({ w, runsDir, tick, until }) => {
    const id = ids(1, "demo", "k1");
    ask(w, 1, [run("k1", { word: "long", waitMs: 2500 })], "demo:k1");
    await tick();
    const pid = flowsOf(w)[id]!.pid;
    await w.restart();
    await tick();
    assert.equal(flowsOf(w)[id]!.ended, undefined, "still going");
    assert.equal(flowsOf(w)[id]!.pid, pid);
    await w.crash();
    await tick();
    assert.equal(flowsOf(w)[id]!.ended, undefined);
    assert.match(headline(w, 1), /demo:k1=(starting|running)/);
    await until(() => !!flowsOf(w)[id]!.ended);
    assert.equal(flowsOf(w)[id]!.ended!.outcome, "done");
    assert.equal(eventsOf(runsDir, id).filter((e) => e.kind === "run.start").length, 1, "started once in all");
    assert.equal(flowsOf(w)[id]!.spawnTries, 1, "and the controller started the process once in all");
    assert.equal(Object.keys(flowsOf(w)).length, 1);
    await w.restart();
    await tick();
    assert.equal(Object.keys(flowsOf(w)).length, 1);
  }));

test("the process is killed in the middle of a run: it is told as lost, after a second look, with nothing run again", () =>
  withRig(async ({ w, runsDir, skew, tick, until }) => {
    const id = ids(1, "demo", "k1");
    ask(w, 1, [run("k1", { word: "doomed", waitMs: 60_000 })], "demo:k1");
    await tick();
    // wait for the runtime to have written its start
    await until(() => existsSync(path.join(runsDir, `${id}.jsonl`)));
    const pid = flowsOf(w)[id]!.pid as number;
    process.kill(pid);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await tick();
    assert.equal(flowsOf(w)[id]!.ended, undefined, "seen once: it may be a machine asleep");
    skew.ms += 31_000;
    await tick();
    const ended = flowsOf(w)[id]!.ended!;
    assert.equal(ended.outcome, "lost");
    assert.match(ended.why!, /失联/);
    assert.equal(w.engine.graph("gcp-demo:1")!.runs[0]!.situation, "lost");
    assert.equal(headline(w, 1), "r demo:k1=lost");
    await tick();
    assert.deepEqual(Object.keys(flowsOf(w)), [id], "and not started again");
  }));

test("a flow that fails, one that is refused by the runtime and one that runs out of time are each told as what they are", () =>
  withRig(async ({ w, tick, until }) => {
    ask(w, 1, [run("bad", { word: "x", blow: "kaboom" })], "demo:bad");
    ask(w, 2, [run("nowhere", {}, "missing")], "missing:nowhere");
    ask(w, 3, [run("slow", { word: "x", waitMs: 5000 }, "hurried")], "hurried:slow");
    await tick();
    await until(() => Object.values(flowsOf(w)).every((r) => r.ended), 30_000);
    const outcome = (n: number, name: string, key: string, file: string) => flowsOf(w)[ids(n, name, key, file)]!.ended!;
    const bad = outcome(1, "demo", "bad", "demo-triage");
    assert.equal(bad.outcome, "failed");
    assert.match(bad.why!, /kaboom/);
    const refused = outcome(2, "missing", "nowhere", "no-such-flow");
    assert.equal(refused.outcome, "refused");
    assert.match(refused.why!, /no flow "no-such-flow"/);
    const slow = outcome(3, "hurried", "slow", "demo-triage");
    assert.equal(slow.outcome, "timeout");
    await tick();
    assert.deepEqual([1, 2, 3].map((n) => headline(w, n).replace(/^r /, "")), ["demo:bad=failed", "missing:nowhere=refused", "hurried:slow=timeout"]);
    // none of them costs anything, and every one can be run again by a person
    assert.deepEqual([bad.costUsd, refused.costUsd, slow.costUsd], [0, 0, 0]);
    for (const n of [1, 3]) assert.deepEqual(w.engine.graph(`gcp-demo:${n}`)!.runs[0]!.actions, ["retry", "mine", "fold"]);
  }));

test("a result is handed on up to its bound; a larger one is not, and a huge one still ends the run", () =>
  withRig(async ({ w, tick, until }) => {
    ask(w, 1, [run("small", { word: "s", pad: 2000 })], "demo:small");
    ask(w, 2, [run("big", { word: "b", pad: 20_000 })], "demo:big");
    ask(w, 3, [run("huge", { word: "h", pad: 5 * 1024 * 1024 })], "demo:huge");
    await tick();
    await until(() => Object.values(flowsOf(w)).every((r) => r.ended), 40_000);
    const end = (n: number, key: string) => flowsOf(w)[ids(n, "demo", key)]!.ended!;
    assert.deepEqual([end(1, "small").outcome, end(1, "small").valueDropped, (end(1, "small").value as { pad: string }).pad.length], ["done", false, 2000]);
    assert.deepEqual([end(2, "big").outcome, end(2, "big").valueDropped, end(2, "big").value, end(2, "big").summary], ["done", true, null, "got b"], "too big to keep: the summary is what is left");
    assert.deepEqual([end(3, "huge").outcome, end(3, "huge").valueDropped, end(3, "huge").value], ["done", true, null], "the line was too long to read, and it still is the end");
    await tick();
    assert.match(headline(w, 2), /demo:big=done/);
  }));

test("the same key asked for in every round, by the real rule, starts one run however long it goes on", () =>
  withRig(async ({ w, runsDir, tick, until }) => {
    ask(w, 1, [run("k1", { word: "x", waitMs: 800 })], "demo:k1");
    for (let i = 0; i < 6; i++) {
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await until(() => !!Object.values(flowsOf(w))[0]?.ended);
    for (let i = 0; i < 3; i++) await tick();
    assert.equal(Object.keys(flowsOf(w)).length, 1);
    assert.equal(readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")).length, 1);
    assert.equal(existsSync(path.join(runsDir, `${ids(1, "demo", "k1")}.claim`)), true);
  }));

// ---- the log directory is part of what a run is (R7B-01) ------------------------------------------------------

const ended = (dir: string, id: string) => {
  const file = path.join(dir, "runs", `${id}.jsonl`);
  return existsSync(file) && readFileSync(file, "utf8").includes('"kind":"run.end"');
};
/** The runner has printed its result (the process is over): the controller's own output file for the run holds it. */
const printed = (outDir: string, id: string) => {
  const file = path.join(outDir, `${id}.out`);
  return existsSync(file) && readFileSync(file, "utf8").includes('"outcome"');
};
const waitFor = async (done: () => boolean, what: string) => {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

test("R7B-01: the config points to another log directory between a run and the controller reading its end: the run is read where it ran, and it does not run again", () =>
  withRig(async ({ w, logDir, flowsDeps, starts, skew, tick }) => {
    const id = ids(1, "demo", "k1");
    ask(w, 1, [run("k1", { word: "once", waitMs: 0 })], "demo:k1");
    await tick();
    assert.equal(starts.length, 1);
    // the run ends, in the first directory, while the controller is not looking
    const deadline = Date.now() + 20_000;
    while (!ended(logDir, id)) {
      if (Date.now() > deadline) throw new Error("the run did not end");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // the machine's config says another directory now, and the plugin comes back with that (as a reload does)
    const other = path.join(path.dirname(logDir), "logs-b");
    process.env.ORCH_LOG_DIR = other;
    flowsDeps.logDir = other;
    await w.crash();
    skew.ms += 120_000;
    await tick();
    await tick();
    assert.equal(flowsOf(w)[id]!.ended?.outcome, "done", "its end is read from where it was written");
    assert.equal(starts.length, 1, "and the run is not started a second time under the same id in the new directory");
    assert.equal(existsSync(other), false, "nothing of it was written there");
    assert.deepEqual(Object.keys(flowsOf(w)), [id]);
  }));

test("R7B-01: the process is told the log directory the intent fixed, not left to find its own", () =>
  withRig(
    async ({ w, runsDir, logDir, tick, until }) => {
      const id = ids(1, "demo", "k1");
      ask(w, 1, [run("k1", { word: "told", waitMs: 0 })], "demo:k1");
      await tick();
      await until(() => !!flowsOf(w)[id]!.ended);
      assert.equal(flowsOf(w)[id]!.logDir, logDir);
      assert.ok(existsSync(path.join(runsDir, `${id}.jsonl`)), "the run is where the intent said");
      // the directory the process would have found for itself has nothing in it
      assert.equal(existsSync(path.join(path.dirname(logDir), "elsewhere")), false);
    },
    { envDir: "elsewhere" },
  ));

test("N7B-01: the runtime's files for a run are gone (cleaned) before the controller read its end: it is not run again, and it is told as what it printed", () =>
  withRig(async ({ w, logDir, runsDir, flowsDeps, starts, skew, tick }) => {
    const id = ids(1, "demo", "k1");
    ask(w, 1, [run("k1", { word: "once", waitMs: 0 })], "demo:k1");
    await tick();
    assert.equal(starts.length, 1);
    // the run ends while the controller is not looking, and the runtime's log directory is cleaned out
    await waitFor(() => ended(logDir, id) && printed(flowsDeps.dir, id), "the run to end and print its result");
    rmSync(runsDir, { recursive: true, force: true });
    assert.equal(existsSync(runsDir), false);
    await w.crash();
    skew.ms += 120_000;
    await tick();
    await tick();
    const rec = flowsOf(w)[id]!;
    assert.equal(starts.length, 1, "not started a second time under the same id: that would be a second run, and a second payment");
    assert.deepEqual([rec.ended?.outcome, rec.ended?.summary, rec.ended?.value, rec.ended?.valueDropped], ["done", "got once", { word: "once", found: 2, pad: "" }, false]);
    assert.deepEqual(Object.keys(flowsOf(w)), [id]);
    await tick();
    assert.match(headline(w, 1), /^r demo:k1=done\{"word":"once"/);
  }));

// ---- the result is printed last (N7C-03) -----------------------------------------------------------------------

test("N7C-03: a flow that wrote more than the window to stdout before its result: the runtime's files are gone, and it is still not run again", () =>
  withRig(async ({ w, logDir, runsDir, flowsDeps, starts, skew, tick }) => {
    const id = ids(1, "noisy", "k1", "demo-noisy");
    ask(w, 1, [{ flow: "noisy", key: "k1", input: { noise: 1_300_000 }, label: "吵" }], "noisy:k1");
    await tick();
    assert.equal(starts.length, 1);
    await waitFor(() => ended(logDir, id) && printed(flowsDeps.dir, id), "the run to end and print its result");
    assert.ok(statSync(path.join(flowsDeps.dir, `${id}.out`)).size > 1_300_000, "more was printed than the controller reads at a time");
    rmSync(runsDir, { recursive: true, force: true });
    await w.crash();
    skew.ms += 120_000;
    await tick();
    await tick();
    const rec = flowsOf(w)[id]!;
    assert.equal(starts.length, 1, "the result is at the end of the file, and it is the end that is read: not a second run, and a second payment");
    assert.deepEqual([rec.ended?.outcome, rec.ended?.summary, rec.ended?.value, rec.ended?.valueDropped], ["done", "noisy done", { found: 3 }, false]);
    assert.deepEqual(Object.keys(flowsOf(w)), [id]);
  }));

// ---- a run that stopped short, carried on ---------------------------------------------------------------------

const twoParts = (key = "k1") => ({ flow: "twoparts", key, input: { word: "w", stage: "start" }, label: "两段" });
const orchResume = (logDir: string, runId: string, ...flags: string[]) => spawnSync(process.execPath, [ORCH, "resume", runId, ...flags], { encoding: "utf8", env: { ...process.env, ORCH_LOG_DIR: logDir } });

test("a stop is carried on from the page: the run left its word in its files, the button's round is started with `orch.mjs resume`, in the item's own workspace, and its result comes back to the rule", () =>
  withRig(async ({ w, logDir, runsDir, tick, until }) => {
    const [r0, r1] = [ids(1, "twoparts", "k1", "demo-resume"), ids(1, "twoparts", "k1", "demo-resume", 1)];
    ask(w, 1, [twoParts()], "twoparts:k1");
    await tick();
    await until(() => !!flowsOf(w)[r0]!.ended);
    const first = flowsOf(w)[r0]!.ended!;
    assert.deepEqual([first.outcome, first.resume], ["stopped", { flow: "demo-resume", from: "第一段做完了：从第二段接着", spends: "nothing" }]);
    const shown = w.engine.graph("gcp-demo:1")!.runs.find((r) => r.runId === r0)!;
    assert.deepEqual([shown.actions, shown.resume], [["resume", "retry", "mine", "fold"], { from: "第一段做完了：从第二段接着", spends: "nothing" }]);
    const r = w.engine.resumeFlow(r0, "owner");
    assert.equal(r.ok, true, r.detail);
    await tick();
    await until(() => !!flowsOf(w)[r1]!.ended);
    assert.deepEqual([flowsOf(w)[r1]!.ended!.outcome, flowsOf(w)[r1]!.ended!.value], ["done", { word: "w", stage: "finish" }]);
    await tick();
    assert.match(headline(w, 1), /^r twoparts:k1=done\{"word":"w","stage":"finish"\} \/ got w in finish$/);
    // what the runtime wrote: the second run says which it carries on, was given what the first declared, and is the same item's
    const [first0, second] = [eventsOf(runsDir, r0), eventsOf(runsDir, r1)];
    const [start0, start1] = [first0.find((e) => e.kind === "run.start"), second.find((e) => e.kind === "run.start")] as Array<{ resumeOf: string | null; input: unknown; affair: { link: { params: Record<string, string> }; key: string } }>;
    assert.equal(start0.resumeOf, null);
    assert.deepEqual([start1.resumeOf, start1.input, start1.affair.link.params, start1.affair.key], [r0, { word: "w", stage: "finish" }, start0.affair.link.params, start0.affair.key]);
    assert.equal(readFileSync(path.join(runsDir, `${r0}.resumed`), "utf8"), r1, "the stop is taken once, by this run");
    // and a second run by hand for the same stop is refused, spending nothing and writing no events
    const again = orchResume(logDir, r0, "--run-id", "by-hand-late");
    assert.equal(again.status, 2, again.stdout + again.stderr);
    assert.match(again.stderr, /already carried on, as run /);
    assert.equal(existsSync(path.join(runsDir, "by-hand-late.jsonl")), false);
    assert.equal(w.engine.resumeFlow(r0, "owner").ok, false);
  }));

test("a stop is carried on by hand with `orch.mjs resume`: the run lands in the item's workspace, the controller takes it in as the next round, and follows it to its result", () =>
  withRig(async ({ w, logDir, runsDir, tick, until }) => {
    const r0 = ids(1, "twoparts", "k1", "demo-resume");
    ask(w, 1, [twoParts()], "twoparts:k1");
    await tick();
    await until(() => !!flowsOf(w)[r0]!.ended);
    const done = orchResume(logDir, r0, "--run-id", "by-hand-1");
    assert.equal(done.status, 0, done.stdout + done.stderr);
    await until(() => !!flowsOf(w)["by-hand-1"]);
    const rec = flowsOf(w)["by-hand-1"]!;
    assert.deepEqual([rec.round, rec.name, rec.flow, rec.key, rec.resume?.by, rec.resume?.from, rec.resume?.flow], [1, "twoparts", "demo-resume", "k1", "cli", r0, "demo-resume"]);
    await until(() => !!rec.ended || !!flowsOf(w)["by-hand-1"]!.ended);
    await tick();
    assert.equal(flowsOf(w)["by-hand-1"]!.ended!.outcome, "done");
    assert.match(headline(w, 1), /^r twoparts:k1=done\{"word":"w","stage":"finish"\}/);
    assert.equal(w.engine.graph("gcp-demo:1")!.runs.filter((r) => (r.actions?.length ?? 0) > 0).length, 0, "nothing is left to do for the item");
    assert.equal(w.journal().filter((e) => e.type === "flow.resume" && e.by === "cli").length, 1);
    // the button's round for the same stop would have been refused by the runtime: nothing of it is there to take
    assert.equal(w.engine.resumeFlow(r0, "owner").ok, false);
    assert.equal(readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")).length, 2);
  }));
