// Carrying on a run that did not finish: what a flow declares (`$.resumeWith`), what the events keep of it, and
// `orch.mjs resume`, which starts it again once and only once. Nothing here calls a model or talks to Paseo: the flows
// are scripts that do nothing but declare and stop, and the gates (resume-smoke) are answered by the fake executor.
//
//   node --test        (from orchestration/)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runFlow, RunRefused } from "../runtime/run.mjs";
import { flow } from "../runtime/flow.mjs";
import { checkEvents, eventsFile, readEvents } from "../runtime/events.mjs";
import { claimFile, runIdProblem } from "../runtime/claim.mjs";
import { claimResumption, readResumePoint, resumedFile, ResumeRefused } from "../runtime/resume.mjs";
import { readRunState } from "../runtime/state.mjs";
import { pointPrint, pointProblems } from "../runtime/resume-point.mjs";
import { parseResumeArgs, resumeRun } from "../runtime/orch.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { fakeExecutor } from "./fake-executor.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ORCH = path.join(ROOT, "runtime", "orch.mjs");
const FLOW_MJS = pathToFileURL(path.join(ROOT, "runtime", "flow.mjs")).href;

// The flows a point can name are found by name: these are in a flowsDirs directory, made before anything reads the config.
const BASE = await mkdtemp(path.join(os.tmpdir(), "orch-resume-"));
const FLOWS = path.join(BASE, "flows");
mkdirSync(FLOWS, { recursive: true });
const flowSource = (name, body) =>
  `import { flow, text } from ${JSON.stringify(FLOW_MJS)};\nimport { writeFileSync } from "node:fs";\nimport path from "node:path";\nexport default flow({ name: ${JSON.stringify(name)}, description: "d", phases: [], inputs: { dir: text() }, grants: [], run: async (input, $) => {\n${body}\n} });\n`;
// One part that declares the other and stops; the other leaves a file in the directory it is given.
writeFileSync(
  path.join(FLOWS, "rs-part-one.mjs"),
  flowSource("rs-part-one", `  await $.resumeWith({ flow: "rs-part-two", input: { dir: input.dir }, from: "第一段停在这里", spends: "nothing" });\n  return $.stop("part one stops", { why: "part one stops" });`),
);
writeFileSync(
  path.join(FLOWS, "rs-part-two.mjs"),
  flowSource("rs-part-two", `  await $.do("mark", () => writeFileSync(path.join(input.dir, "two.txt"), $.ctx.runId));\n  return { part: 2 };`),
);
// A run that declares and then works for as long as it is let: a process to be killed.
writeFileSync(
  path.join(FLOWS, "rs-hang.mjs"),
  flowSource("rs-hang", `  await $.resumeWith({ flow: "rs-part-two", input: { dir: input.dir }, from: "断了：接着跑第二段", spends: "nothing" });\n  await $.do("wait", () => new Promise(() => setInterval(() => {}, 1000)));`),
);
const CONFIG = path.join(BASE, "config.json");
writeFileSync(CONFIG, JSON.stringify({ flowsDirs: [FLOWS] }));
process.env.ORCH_CONFIG = CONFIG;

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});
// Everything above and below lives in BASE, and nothing outside it.
after(() => rm(BASE, { recursive: true, force: true }));

const tmp = (name) => mkdtemp(path.join(BASE, `${name}-`));
const ownOptions = (extra = {}) => ({ roster, caller: null, gatePollMs: 5, agentProbeDelays: [5], executor: fakeExecutor(), ...extra });
const go = (target, { logDir, ...options }) => runFlow(target, { ...ownOptions(), logDir, cwd: "C:/work", ...options });
const resume = (dir, previous, argv = [], runOptions = {}) => resumeRun(previous, argv, { logDir: dir, runOptions: ownOptions(runOptions) });
const flowFile = (name) => path.join(FLOWS, `${name}.mjs`);

/** The events of a finished run, checked against the contract. */
function eventsOf(result) {
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return events;
}
const runEnd = (events) => events.find((e) => e.kind === "run.end");
const filesIn = (dir) => readdirSync(path.join(dir, "runs")).sort();

/** A point for rs-part-two. */
const TWO = (dir, from = "从第二段接着", spends = "nothing") => ({ flow: "rs-part-two", input: { dir }, from, spends });
/** A flow made of `body`, stopping or returning as it says. */
const declaring = (body, extra = {}) => flow({ name: "declaring", description: "d", phases: [], inputs: {}, grants: [], run: body, ...extra });

async function until(check, what, ms = 20_000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// --- Declaring ---------------------------------------------------------------------------------

test("$.resumeWith: the last declaration is the one the run ends with, and null takes it back", async () => {
  const dir = await tmp("last");
  const result = await go(
    declaring(async (_, $) => {
      await $.resumeWith(TWO("a", "first"));
      await $.resumeWith(TWO("b", "second", "maybe"));
      return $.stop("s", { why: "x" });
    }),
    { logDir: dir },
  );
  const events = eventsOf(result);
  assert.deepEqual(events.filter((e) => e.kind === "resume").map(({ flow: f, from, spends }) => [f, from, spends]), [["rs-part-two", "first", "nothing"], ["rs-part-two", "second", "maybe"]]);
  assert.deepEqual(runEnd(events).resume, TWO("b", "second", "maybe"));
  assert.deepEqual(result.resume, TWO("b", "second", "maybe"));

  const taken = await go(
    declaring(async (_, $) => {
      await $.resumeWith(TWO("a"));
      await $.resumeWith(null);
      return $.stop("s", { why: "x" });
    }),
    { logDir: dir },
  );
  const takenEvents = eventsOf(taken);
  assert.deepEqual(takenEvents.filter((e) => e.kind === "resume").map((e) => e.cleared ?? e.flow), ["rs-part-two", true]);
  assert.equal(runEnd(takenEvents).resume, null);
});

test("$.resumeWith: stopped, failed and timed out runs keep the last declaration; a run that is done never does", async () => {
  const dir = await tmp("outcomes");
  const point = TWO("a", "keep me");
  const stopped = await go(declaring(async (_, $) => { await $.resumeWith(point); return $.stop("s", { why: "x" }); }), { logDir: dir });
  const failed = await go(declaring(async (_, $) => { await $.resumeWith(point); throw new Error("boom"); }), { logDir: dir });
  const timedOut = await go(
    declaring(async (_, $) => {
      await $.resumeWith(point);
      await $.do("wait", () => new Promise((resolve) => setTimeout(resolve, 5_000).unref()));
    }),
    { logDir: dir, timeout: "1s" },
  );
  const done = await go(declaring(async (_, $) => { await $.resumeWith(point); return { fine: true }; }), { logDir: dir });
  assert.deepEqual([stopped.outcome, failed.outcome, timedOut.outcome, done.outcome], ["stopped", "failed", "timeout", "done"]);
  for (const result of [stopped, failed, timedOut]) assert.deepEqual(runEnd(eventsOf(result)).resume, point, result.outcome);
  // Declared, written as a resume event, and not on the end: a run that came to its end has nothing to carry on.
  const doneEvents = eventsOf(done);
  assert.equal(doneEvents.filter((e) => e.kind === "resume").length, 1);
  assert.equal(runEnd(doneEvents).resume, null);
  assert.equal(done.resume, null);
  // The reader's check says the same.
  const bent = doneEvents.map((e) => (e.kind === "run.end" ? { ...e, resume: point } : e));
  assert.match(checkEvents(bent).join(), /resume must be null, or a resume point when the run did not come to done/);
});

// A declaration that does not fit is a warning, never a failed run, and the one before it stands.
const BAD = [
  ["a path as the flow", { ...TWO("a"), flow: "../flows/rs-part-two.mjs" }, /flow must be a flow's name/],
  // This one would find a file if it were looked up as a path (the flows directory's own name is "flows").
  ["a path that leads to a flow file", { ...TWO("a"), flow: "../flows/rs-part-two" }, /flow must be a flow's name/],
  ["a file name as the flow", { ...TWO("a"), flow: "rs-part-two.mjs" }, /flow must be a flow's name/],
  ["an absolute path as the flow", { ...TWO("a"), flow: "C:/x/rs-part-two" }, /flow must be a flow's name/],
  ["a flow nobody knows", { ...TWO("a"), flow: "no-such-flow" }, /no flow "no-such-flow"/],
  ["an input that does not fit the flow", { ...TWO("a"), input: {} }, /input\.dir: missing/],
  ["an input the flow does not take", { ...TWO("a"), input: { dir: "a", extra: 1 } }, /input\.extra: not declared/],
  ["a from with a control character", { ...TWO("a"), from: "a\nb" }, /from has a control or direction-changing character/],
  ["a from that is too long", { ...TWO("a"), from: "x".repeat(61) }, /from is longer than 60 characters/],
  ["an empty from", { ...TWO("a"), from: " " }, /from must not be empty/],
  ["a spends that is not one of the two", { ...TWO("a"), spends: "sometimes" }, /spends must be "nothing" or "maybe"/],
  ["a point without spends", (({ spends, ...rest }) => rest)(TWO("a")), /spends is missing/],
  ["a point with another key", { ...TWO("a"), why: "x" }, /unknown key "why"/],
  ["something that is not a point", "rs-part-two", /a resume point is \{ flow, input, from, spends \}/],
];
for (const [what, bad, expected] of BAD) {
  test(`$.resumeWith: ${what} is a warning and a caveat, not a failed run, and what was declared before stands`, async () => {
    const dir = await tmp("bad");
    const good = TWO("good", "still me");
    const result = await go(declaring(async (_, $) => { await $.resumeWith(good); await $.resumeWith(bad); return $.stop("s", { why: "x" }); }), { logDir: dir });
    assert.equal(result.outcome, "stopped");
    const events = eventsOf(result);
    assert.equal(events.filter((e) => e.kind === "resume").length, 1, "the one that did not fit was not recorded");
    assert.match(events.find((e) => e.kind === "log" && e.level === "warn")?.message ?? "", expected);
    assert.ok(result.caveats.some((c) => c.startsWith("resume: ")), result.caveats.join("\n"));
    assert.deepEqual(runEnd(events).resume, good);
    // Alone, it leaves nothing to be carried on from.
    const alone = await go(declaring(async (_, $) => { await $.resumeWith(bad); return $.stop("s", { why: "x" }); }), { logDir: dir });
    assert.equal(runEnd(eventsOf(alone)).resume, null);
  });
}

test("$.resumeWith: a value the run keeps secret is not a resume input -- not recorded now, and not kept if it came to be secret later", async () => {
  const dir = await tmp("secret");
  const asks = { title: "t", content: "c", timeout: "1m", input: { label: "code", pattern: "\\d{6}" } };
  // The secret is known, and then it is declared.
  const known = await go(
    flow({ name: "known", description: "d", phases: [], inputs: {}, grants: ["gate:deny"], run: async (_, $) => {
      const decision = await $.gate(asks);
      await $.resumeWith(TWO(decision.input, "with the code"));
      return $.stop("s", { why: "x" });
    } }),
    { logDir: dir, executor: fakeExecutor({ carrier: "input", inputValue: "483921" }) },
  );
  const knownEvents = eventsOf(known);
  assert.equal(knownEvents.filter((e) => e.kind === "resume").length, 0);
  assert.match(knownEvents.find((e) => e.kind === "log" && e.level === "warn").message, /keeps secret/);
  assert.equal(runEnd(knownEvents).resume, null);
  assert.ok(!(await readFile(known.events, "utf8")).includes("483921"), "the value is nowhere in the events");
  // Declared before it was known, and the value comes to be secret: the point that holds it is dropped when the run ends.
  const late = await go(
    flow({ name: "late", description: "d", phases: [], inputs: {}, grants: ["gate:deny"], run: async (_, $) => {
      await $.resumeWith(TWO("483921", "declared early"));
      await $.gate(asks);
      return $.stop("s", { why: "x" });
    } }),
    { logDir: dir, executor: fakeExecutor({ carrier: "input", inputValue: "483921" }) },
  );
  const lateEvents = eventsOf(late);
  assert.equal(runEnd(lateEvents).resume, null);
  assert.ok(late.caveats.some((c) => /came to keep secret/.test(c)), late.caveats.join("\n"));
});

test("$.resumeWith: after the outcome is decided it records nothing; one that is not awaited still lands before the run ends", async () => {
  const dir = await tmp("timing");
  let caught = null;
  const decided = await go(
    declaring(async (_, $) => {
      await $.resumeWith(TWO("a", "before the stop"));
      try {
        $.stop("s", { why: "x" });
      } catch {
        // A stop that is caught is still the end.
      }
      caught = await $.resumeWith(TWO("b", "after the stop")).then(() => null, (error) => error.name);
    }),
    { logDir: dir },
  );
  assert.equal(caught, "RunEnded");
  assert.equal(decided.outcome, "stopped");
  assert.equal(runEnd(eventsOf(decided)).resume.from, "before the stop");

  const unawaited = await go(declaring(async (_, $) => { $.resumeWith(TWO("a", "not awaited")); return $.stop("s", { why: "x" }); }), { logDir: dir });
  assert.equal(runEnd(eventsOf(unawaited)).resume.from, "not awaited");
});

test("run.start.resumeOf is null for a run, the earlier run's id for one that carries on, and must be an id", async () => {
  const dir = await tmp("resume-of");
  const plain = await go(declaring(async () => 1), { logDir: dir });
  assert.equal(eventsOf(plain)[0].resumeOf, null);
  const carried = await go(declaring(async () => 1), { logDir: dir, resumeOf: "earlier-1" });
  assert.equal(eventsOf(carried)[0].resumeOf, "earlier-1");
  await assert.rejects(go(declaring(async () => 1), { logDir: dir, resumeOf: "../earlier" }), (error) => error instanceof RunRefused && /resumeOf/.test(error.message));
});

test("a resume event and run.end.resume are checked as the contract says; files from before them read fine", async () => {
  const dir = await tmp("contract");
  const result = await go(declaring(async (_, $) => { await $.resumeWith(TWO("a")); return $.stop("s", { why: "x" }); }), { logDir: dir });
  const events = eventsOf(result);
  const bend = (kind, change) => events.map((e) => (e.kind === kind ? { ...e, ...change } : e));
  assert.match(checkEvents(bend("resume", { flow: "../x" })).join(), /resume point: flow must be a flow's name/);
  assert.match(checkEvents(bend("resume", { cleared: true })).join(), /takes the point back carries no point/);
  assert.match(checkEvents(bend("run.end", { resume: { flow: "x" } })).join(), /resume must be null, or a resume point/);
  assert.match(checkEvents(bend("run.start", { resumeOf: 4 })).join(), /resumeOf is not string \| null/);
  // What a file written before the two fields and the event looks like (the lines renumbered, as they would have been).
  const old = events.filter((e) => e.kind !== "resume").map(({ resumeOf, resume, ...rest }, seq) => ({ ...rest, seq }));
  assert.deepEqual(checkEvents(old, { complete: true }), [], "a reader of old files is not bothered");
  assert.match(checkEvents(old, { strict: true, complete: true }).join(), /resumeOf is missing/);
  assert.match(checkEvents(old, { strict: true, complete: true }).join(), /resume is missing/);
});

test("pointProblems: the four keys, a name that is a name, a from that is a line", () => {
  assert.deepEqual(pointProblems(TWO("a")), []);
  assert.deepEqual(pointProblems({ ...TWO("a"), from: "一".repeat(60) }), []);
  assert.match(pointProblems(null).join(), /a resume point is/);
  assert.match(pointProblems([]).join(), /a resume point is/);
  assert.match(pointProblems({ ...TWO("a"), input: [] }).join(), /input must be an object/);
  assert.match(pointProblems({ ...TWO("a"), flow: "Rs-Part" }).join(), /flow must be a flow's name/);
  assert.match(runIdProblem("x.resumed") ?? "", /\.resumed/);
  assert.match(runIdProblem("x.resumed.2") ?? "", /\.resumed/);
  assert.equal(runIdProblem("x.resumed.y"), null);
});

// --- Carrying on: what is read, and what is refused ---------------------------------------------

/** A stopped run of rs-part-one, under `id`, working in `work`. */
async function stoppedRun(dir, id, work, options = {}) {
  const result = await go(flowFile("rs-part-one"), { logDir: dir, runId: id, input: { dir: work }, ...options });
  assert.equal(result.outcome, "stopped");
  return result;
}

test("resume: the declared flow runs with the declared input, as a run that says what it carries on, in the same affair, directory and host", async () => {
  const dir = await tmp("basic");
  const work = await tmp("work");
  const affair = { label: "事项 #1 · 停了", key: "item-1", link: { plugin: "tracker", screen: "case", params: { id: "1" } } };
  await stoppedRun(dir, "first-1", work, { affair, cwd: "C:/elsewhere" });
  const result = await resume(dir, "first-1");
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, { part: 2 });
  const events = eventsOf(result);
  const start = events[0];
  assert.equal(start.resumeOf, "first-1");
  assert.equal(start.flow.name, "rs-part-two");
  assert.deepEqual(start.input, { dir: work });
  assert.deepEqual(start.affair, affair, "the affair is the earlier run's: the cards and agents stay in its workspace");
  assert.equal(start.cwd, "C:/elsewhere");
  assert.equal(readFileSync(path.join(work, "two.txt"), "utf8"), result.runId, "the flow ran, with the input");
  assert.equal(readFileSync(resumedFile(dir, "first-1"), "utf8"), result.runId, "the stop says which run took it over");
  // Given again, the affair and the directory are the caller's.
  const second = await tmp("basic-2");
  await stoppedRun(second, "first-2", work, { affair });
  const other = { label: "另一件事", key: "item-2" };
  const overridden = await resume(second, "first-2", ["--affair", JSON.stringify(other), "--cwd", "C:/there"]);
  assert.deepEqual(eventsOf(overridden)[0].affair, other);
  assert.equal(eventsOf(overridden)[0].cwd, "C:/there");
});

test("resume: a stop is carried on once; the second try is refused, spends nothing and leaves nothing behind", async () => {
  const dir = await tmp("once");
  const work = await tmp("work");
  await stoppedRun(dir, "first", work);
  const first = await resume(dir, "first", ["--run-id", "taker"]);
  const before = filesIn(dir);
  assert.deepEqual(before, ["first.claim", "first.jsonl", "first.resumed", "taker.claim", "taker.jsonl"]);
  const refused = await resume(dir, "first").then(() => assert.fail("a second resume ran"), (error) => error);
  assert.ok(refused instanceof ResumeRefused, String(refused));
  assert.match(refused.message, /was already carried on, as run taker: it ended as done/);
  assert.deepEqual(filesIn(dir), before, "a generated id is nobody's to look up: its claim is gone");
  // A caller's id keeps the reason with its claim, where whoever started the process looks.
  await assert.rejects(resume(dir, "first", ["--run-id", "asker"]), ResumeRefused);
  assert.match(JSON.parse(await readFile(claimFile(dir, "asker"), "utf8")).refused, /^ResumeRefused: .*already carried on/s);
  assert.equal(existsSync(eventsFile(dir, "asker")), false, "no run began");
  assert.equal(first.outcome, "done");
});

test("resume: a start that came to nothing frees the stop; one that began, however it ended, does not", async () => {
  const dir = await tmp("reclaim");
  const work = await tmp("work");
  await stoppedRun(dir, "first", work);
  await assert.rejects(resume(dir, "first", ["--run-id", "bad-start", "--timeout", "bogus"]), RunRefused);
  assert.equal(readFileSync(resumedFile(dir, "first"), "utf8"), "bad-start");
  const taken = await resume(dir, "first", ["--run-id", "good-start"]);
  assert.equal(taken.outcome, "done");
  assert.equal(readFileSync(resumedFile(dir, "first", 2), "utf8"), "good-start", "the stop is taken again under .resumed.2");
  await assert.rejects(resume(dir, "first"), /already carried on, as run good-start/);
  assert.equal(existsSync(resumedFile(dir, "first", 3)), false);
});

test("claimResumption: a holder that never came to exist frees the stop once enough time has passed, and not before", async () => {
  const dir = await tmp("slot");
  assert.equal(claimResumption({ dir, runId: "u", by: "ghost" }).attempt, 1);
  assert.throws(() => claimResumption({ dir, runId: "u", by: "b" }), /already carried on, as run ghost: it is running/, "just made: it may be starting");
  assert.equal(claimResumption({ dir, runId: "u", by: "b", now: () => Date.now() + 120_000 }).attempt, 2);
  // A file that is empty (being written, or its maker died) is not read as free.
  writeFileSync(resumedFile(dir, "v"), "");
  assert.throws(() => claimResumption({ dir, runId: "v", by: "b" }), /cannot be read yet/);
  // Nor is one that names something that is not a run id.
  writeFileSync(resumedFile(dir, "w"), "../../etc/passwd");
  assert.throws(() => claimResumption({ dir, runId: "w", by: "b" }), /cannot be read yet/);
});

test("claimResumption: a holder whose claim went stale before run.start frees the stop when its process is certainly gone, not when it may only have been asleep", async () => {
  const stale = (dir, holder, pid) => {
    const claim = claimFile(dir, holder);
    writeFileSync(claim, JSON.stringify({ pid, hostname: os.hostname(), startedAt: new Date(Date.now() - 300_000).toISOString() }));
    const old = new Date(Date.now() - 300_000);
    utimesSync(claim, old, old);
  };
  // The process that took the stop is gone, and wrote no run.start: nothing was spent and nothing will be, so the stop is taken again.
  const taken = async (name, holder) => {
    const dir = await tmp(name);
    mkdirSync(path.join(dir, "runs"), { recursive: true });
    writeFileSync(resumedFile(dir, "source"), holder);
    return dir;
  };
  const gone = await taken("slot-gone", "killed-start");
  stale(gone, "killed-start", 2147483647);
  assert.equal(readRunState({ dir: gone, runId: "killed-start" }).state, "dead-before-start");
  assert.equal(claimResumption({ dir: gone, runId: "source", by: "replacement" }).attempt, 2);
  assert.equal(readFileSync(resumedFile(gone, "source", 2), "utf8"), "replacement");
  // Its process still exists (pids are reused, and the machine may have been asleep): the stop stays taken.
  const alive = await taken("slot-alive", "asleep-start");
  stale(alive, "asleep-start", process.pid);
  assert.equal(readRunState({ dir: alive, runId: "asleep-start" }).state, "stalled-before-start");
  assert.throws(() => claimResumption({ dir: alive, runId: "source", by: "replacement" }), /already carried on, as run asleep-start: it reads as stalled-before-start/);
  assert.equal(existsSync(resumedFile(alive, "source", 2)), false);
  // It began: whatever came of it, it is the carrying on.
  const began = await taken("slot-began", "began");
  stale(began, "began", 2147483647);
  writeFileSync(eventsFile(began, "began"), `${JSON.stringify({ v: 1, seq: 0, ts: new Date().toISOString(), runId: "began", kind: "run.start" })}\n`);
  assert.throws(() => claimResumption({ dir: began, runId: "source", by: "replacement" }), /already carried on, as run began: it reads as lost/);
});

test("resume --expect: what a person was shown is what is carried on; a point that says another flow or input now is refused before anything is taken", async () => {
  // The fingerprint is of the flow and the input, whatever order the keys were written in; reconcile computes the same (its flows-resume test has this vector).
  assert.equal(pointPrint({ flow: "rs-part-two", input: { b: 1, a: [1, { d: 2, c: 3 }], s: "中文" }, from: "x", spends: "nothing" }), "92645a244d9b3d69");
  assert.equal(pointPrint({ input: { s: "中文", a: [1, { c: 3, d: 2 }], b: 1 }, flow: "rs-part-two", from: "another line", spends: "maybe" }), "92645a244d9b3d69");
  await assert.rejects(parseResumeArgs(["--expect", "not-a-print"]), /--expect is the 16 hex digits/);
  const dir = await tmp("expect");
  const work = await tmp("work");
  await stoppedRun(dir, "first", work);
  const before = filesIn(dir);
  const changed = await resume(dir, "first", ["--run-id", "asker", "--expect", pointPrint(TWO(path.join(work, "elsewhere")))]).then(() => assert.fail("a point other than the shown one ran"), (error) => error);
  assert.ok(changed instanceof ResumeRefused, String(changed));
  assert.match(changed.message, /is not the one that was shown/);
  assert.equal(existsSync(resumedFile(dir, "first")), false, "the stop was not taken");
  assert.equal(existsSync(eventsFile(dir, "asker")), false, "no run began");
  assert.match(JSON.parse(await readFile(claimFile(dir, "asker"), "utf8")).refused, /is not the one that was shown/);
  assert.deepEqual(filesIn(dir), [...before, "asker.claim"].sort());
  // The one that was shown runs, and the run says which point it was started from.
  const shown = await resume(dir, "first", ["--expect", pointPrint(TWO(work))]);
  assert.equal(shown.outcome, "done");
  const start = eventsOf(shown)[0];
  assert.equal(start.resumePrint, pointPrint(TWO(work)));
  // Without --expect it is recorded too; a run that does not carry on another has none.
  const second = await tmp("expect-none");
  await stoppedRun(second, "first", work);
  assert.equal(eventsOf(await resume(second, "first"))[0].resumePrint, pointPrint(TWO(work)));
  const plain = await go(flowFile("rs-part-two"), { logDir: await tmp("plain"), input: { dir: work } });
  assert.equal(eventsOf(plain)[0].resumePrint, null);
});

test("resume: of any number of processes asking at once, one carries the stop on and the others pay nothing", async () => {
  const dir = await tmp("race");
  const work = await tmp("work");
  await stoppedRun(dir, "race-1", work);
  const env = { ...process.env, ORCH_LOG_DIR: dir };
  delete env.PASEO_AGENT_ID;
  const codes = await Promise.all([1, 2, 3, 4].map(() => run(process.execPath, [ORCH, "resume", "race-1"], { env }).then(() => 0, (error) => error.code)));
  assert.deepEqual([...codes].sort(), [0, 2, 2, 2]);
  const runs = filesIn(dir).filter((f) => f.endsWith(".jsonl") && f !== "race-1.jsonl");
  assert.equal(runs.length, 1, filesIn(dir).join(", "));
  assert.equal(readEvents(path.join(dir, "runs", runs[0]))[0].resumeOf, "race-1");
  assert.equal(filesIn(dir).length, 5, "race-1 (claim, events, .resumed) and the one run (claim, events): the refused left nothing");
});

test("resume: only a run that did not come to done, and said how to go on, is carried on", async () => {
  const dir = await tmp("refuse");
  const work = await tmp("work");
  const done = await go(flowFile("rs-part-two"), { logDir: dir, runId: "finished", input: { dir: work } });
  assert.equal(done.outcome, "done");
  await assert.rejects(resume(dir, "finished"), /run finished is done: there is nothing to carry on/);
  const silent = await go(declaring(async (_, $) => $.stop("no point declared", { why: "x" })), { logDir: dir, runId: "silent" });
  assert.equal(silent.outcome, "stopped");
  await assert.rejects(resume(dir, "silent"), /did not say how it could be carried on/);
  await assert.rejects(resume(dir, "no-such-run"), /run no-such-run has no events/);
  await assert.rejects(resume(dir, "../finished"), /is not a run id/);
  await assert.rejects(resume(dir, "finished.jsonl"), /is not a run id/);
  await assert.rejects(resume(dir, "silent", ["--input", "{}"]), /--input|Unknown option/);
  // Nothing of these took a stop: the one that could be carried on still can.
  await stoppedRun(dir, "fine", work);
  assert.equal((await resume(dir, "fine")).outcome, "done");
});

test("resume: what the file says is read as untrusted -- a flow named by a path, a point that does not fit, is refused before anything starts", async () => {
  const dir = await tmp("edited");
  const work = await tmp("work");
  await stoppedRun(dir, "edit-1", work);
  const file = eventsFile(dir, "edit-1");
  const original = readFileSync(file, "utf8");
  const edit = (change) => {
    writeFileSync(file, original.split("\n").filter(Boolean).map((line) => {
      const event = JSON.parse(line);
      if (event.kind === "run.end") event.resume = { ...event.resume, ...change };
      return JSON.stringify(event);
    }).join("\n") + "\n");
  };
  for (const [change, expected] of [
    [{ flow: "../evil" }, /flow must be a flow's name/],
    [{ flow: "../flows/rs-part-two" }, /flow must be a flow's name/],
    [{ flow: "rs-part-two.mjs" }, /flow must be a flow's name/],
    [{ flow: "C:/x/evil" }, /flow must be a flow's name/],
    [{ spends: "always" }, /spends must be/],
    [{ from: "a\u0007b" }, /from has a control/],
  ]) {
    edit(change);
    await assert.rejects(resume(dir, "edit-1"), (error) => error instanceof ResumeRefused && expected.test(error.message), JSON.stringify(change));
    assert.equal(existsSync(resumedFile(dir, "edit-1")), false, "a point that does not fit takes nothing");
  }
  // A flow that is not there any more, or an input that no longer fits it: refused by the runner, before anything is spent.
  edit({ flow: "gone-since" });
  await assert.rejects(resume(dir, "edit-1"), /no flow "gone-since"/);
  assert.equal(existsSync(resumedFile(dir, "edit-1")), false);
  edit({ input: { dir: work, extra: true } });
  await assert.rejects(resume(dir, "edit-1"), (error) => error instanceof RunRefused && /input\.extra: not declared/.test(error.message));
  // That start was refused after it took the stop, and its claim says so: the stop is free again at once, under .resumed.2.
  assert.match(JSON.parse(readFileSync(claimFile(dir, readFileSync(resumedFile(dir, "edit-1"), "utf8")), "utf8")).refused, /input.extra: not declared/);
  edit({});
  assert.equal((await resume(dir, "edit-1")).outcome, "done", "put right, it is carried on: the refused starts did not use the stop up");
  assert.equal(existsSync(resumedFile(dir, "edit-1", 2)), true);
});

test("resume: a run whose process is not known to be gone is not carried on, a dead one is, and the last declaration it made is the point", async () => {
  const dir = await tmp("alive");
  const work = await tmp("work");
  const env = { ...process.env, ORCH_LOG_DIR: dir };
  delete env.PASEO_AGENT_ID;
  const child = spawn(process.execPath, [ORCH, "run", "rs-hang", "--dir", work, "--run-id", "hang-1"], { env, stdio: "ignore" });
  try {
    await until(() => existsSync(eventsFile(dir, "hang-1")) && readEvents(eventsFile(dir, "hang-1")).some((e) => e.kind === "resume"), "the run's declaration");
    await assert.rejects(resume(dir, "hang-1"), /has not ended and is not known to be dead: running/);
    assert.equal(existsSync(resumedFile(dir, "hang-1")), false);
  } finally {
    child.kill();
  }
  await once(child, "exit");
  // Cut off: no run.end, a claim that is fresh and whose process is gone.
  assert.equal(readEvents(eventsFile(dir, "hang-1")).some((e) => e.kind === "run.end"), false);
  const { point, outcome } = readResumePoint({ dir, runId: "hang-1" });
  assert.equal(outcome, "lost");
  assert.deepEqual(point, { flow: "rs-part-two", input: { dir: work }, from: "断了：接着跑第二段", spends: "nothing" });
  const result = await resume(dir, "hang-1");
  assert.equal(result.outcome, "done");
  assert.equal(eventsOf(result)[0].resumeOf, "hang-1");
  assert.equal(readFileSync(path.join(work, "two.txt"), "utf8"), result.runId);
});

test("resume: a run that stopped writing is not carried on unless its process is known to be gone (another machine, or one that still exists, is not)", async () => {
  const dir = await tmp("unknown");
  const work = await tmp("work");
  await stoppedRun(dir, "cut-1", work);
  // Make it look cut off: no run.end, a claim that went stale, held by a process on another machine.
  const file = eventsFile(dir, "cut-1");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const resumeEvent = { v: 1, seq: lines.length - 1, ts: lines.at(-1).ts, runId: "cut-1", kind: "resume", ...lines.at(-1).resume };
  writeFileSync(file, [...lines.slice(0, -1), resumeEvent].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const stale = (body) => {
    writeFileSync(claimFile(dir, "cut-1"), JSON.stringify(body));
    const long = new Date(Date.now() - 10 * 60_000);
    utimesSync(claimFile(dir, "cut-1"), long, long);
  };
  stale({ pid: 4242, hostname: "some-other-machine", startedAt: "2026-10-30T00:00:00.000Z" });
  await assert.rejects(resume(dir, "cut-1"), /stopped writing, but pid 4242 on some-other-machine is not known to be gone \(it is on another machine\)/);
  stale({ pid: process.pid, hostname: os.hostname(), startedAt: "2026-10-30T00:00:00.000Z" });
  await assert.rejects(resume(dir, "cut-1"), /that process still exists/);
  assert.equal(existsSync(resumedFile(dir, "cut-1")), false, "refused before the stop was taken");
  // The same claim, its process gone: proof of death, and the run is carried on from the last point it declared.
  stale({ pid: 2 ** 22 + 12345, hostname: os.hostname(), startedAt: "2026-10-30T00:00:00.000Z" });
  assert.equal((await resume(dir, "cut-1")).outcome, "done");
  // A point it took back is none.
  const second = await tmp("unknown-2");
  await stoppedRun(second, "cut-2", work);
  const lines2 = readFileSync(eventsFile(second, "cut-2"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const cleared = { v: 1, seq: lines2.length - 1, ts: lines2.at(-1).ts, runId: "cut-2", kind: "resume", cleared: true };
  writeFileSync(eventsFile(second, "cut-2"), [...lines2.slice(0, -1), cleared].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(claimFile(second, "cut-2"), JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname(), startedAt: "2026-10-30T00:00:00.000Z" }));
  await assert.rejects(resume(second, "cut-2"), /did not say how it could be carried on/);
});

test("resume: the carried-on run's gate card goes where the first one's did, and a run carried on that stops again can be carried on in turn", async () => {
  const dir = await tmp("smoke");
  const workspaces = [];
  const affair = { label: "冒烟事项", key: "smoke-item" };
  const first = fakeExecutor({ workspaces });
  const part1 = await go(path.join(ROOT, "flows", "resume-smoke.mjs"), { logDir: dir, runId: "smoke-1", affair, executor: first, input: { gateTimeout: "1s" } });
  assert.equal(part1.outcome, "stopped");
  assert.equal(part1.value.part, 1);
  assert.match(part1.summary, /第 1 段停下/);
  assert.equal(part1.resume.flow, "resume-smoke");
  assert.deepEqual(part1.resume.input, { gateTimeout: "1s" }, "the same input: it is carried on by running it again");
  assert.equal(part1.resume.spends, "nothing");
  assert.equal(first.requests.length, 1);
  // Part two's card is not answered in time: it stops, and says how to go on in its turn. Part one's card is not put again.
  const waiting = fakeExecutor({ workspaces, carrier: "hang" });
  const part2 = await resume(dir, "smoke-1", [], { executor: waiting });
  assert.equal(part2.outcome, "stopped");
  assert.equal(part2.value.part, 2);
  assert.equal(part2.value.decision, "expired");
  assert.equal(waiting.requests.length, 1, "one card: the second part's");
  assert.equal(waiting.requests[0].workspace, first.requests[0].workspace, "the card is in the workspace of the affair, as the first one was");
  assert.ok(first.requests[0].workspace);
  assert.equal(eventsOf(part2)[0].resumeOf, "smoke-1");
  assert.equal(eventsOf(part2)[0].lineage, "smoke-1");
  assert.deepEqual(part2.resume.input, { gateTimeout: "1s" });
  // The first stop was carried on once, however the second part went.
  await assert.rejects(resume(dir, "smoke-1"), /already carried on, as run .*: it ended as stopped; if it stopped, carry on that run \(/);
  const approving = fakeExecutor({ workspaces });
  const part3 = await resume(dir, part2.runId, [], { executor: approving });
  assert.equal(part3.outcome, "done");
  assert.match(part3.summary, /冒烟完成/);
  assert.equal(approving.requests.length, 1, "the second card again (nobody answered it); the first was answered, and is not asked");
  assert.equal(approving.requests[0].workspace, first.requests[0].workspace);
  assert.equal(eventsOf(part3)[0].resumeOf, part2.runId);
  assert.equal(workspaces.length, 1, "one workspace for the whole affair");

  // A no is the person's answer: the stop says so and offers nothing to carry on (starting again is a new run).
  const other = await tmp("smoke-denied");
  await go(path.join(ROOT, "flows", "resume-smoke.mjs"), { logDir: other, runId: "smoke-2", executor: fakeExecutor(), input: { gateTimeout: "1s" } });
  const refused = await resume(other, "smoke-2", [], { executor: fakeExecutor({ carrier: "deny" }) });
  assert.equal(refused.outcome, "stopped");
  assert.equal(refused.value.decision, "denied");
  assert.equal(refused.resume, null);
  await assert.rejects(resume(other, refused.runId), /did not say how it could be carried on/);
});

// --- The command line ----------------------------------------------------------------------------

test("orch.mjs resume: prints the result like run, exits 0 when it ran and 2 when it was refused", async () => {
  const dir = await tmp("cli");
  const work = await tmp("work");
  await stoppedRun(dir, "cli-1", work);
  const env = { ...process.env, ORCH_LOG_DIR: dir };
  delete env.PASEO_AGENT_ID;
  const { stdout } = await run(process.execPath, [ORCH, "resume", "cli-1", "--run-id", "cli-2", "--timeout", "5m"], { env });
  const printed = JSON.parse(stdout);
  assert.equal(printed.runId, "cli-2");
  assert.equal(printed.outcome, "done");
  assert.equal(printed.resume, null);
  assert.equal(eventsOf({ events: eventsFile(dir, "cli-2") })[0].resumeOf, "cli-1");
  const refused = await run(process.execPath, [ORCH, "resume", "cli-1"], { env }).then(() => assert.fail("expected exit 2"), (error) => error);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /ResumeRefused: run cli-1 was already carried on, as run cli-2/);
  const noId = await run(process.execPath, [ORCH, "resume"], { env }).then(() => assert.fail("expected exit 2"), (error) => error);
  assert.equal(noId.code, 2);
  assert.match(noId.stderr, /Usage:[\s\S]*orch\.mjs resume <runId>/);
  const badFlag = await run(process.execPath, [ORCH, "resume", "cli-1", "--dir", "x"], { env }).then(() => assert.fail("expected exit 2"), (error) => error);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.stderr, /resume takes --timeout, --run-id, --affair, --host, --cwd/);
});

test("parseResumeArgs: the flags of a run that are not a flow's input; a value that starts with a dash is still a value", async () => {
  assert.deepEqual(await parseResumeArgs([]), { timeout: null, host: null, cwd: null });
  const parsed = await parseResumeArgs(["--timeout", "30h", "--run-id", "r-2", "--cwd", "-odd", "--host", "box", "--affair", '{"label":"x"}']);
  assert.deepEqual(parsed, { timeout: "30h", host: "box", cwd: "-odd", runId: "r-2", affair: { label: "x" } });
  await assert.rejects(parseResumeArgs(["--affair", "{label:"]), /--affair: not valid JSON/);
  await assert.rejects(parseResumeArgs(["positional"]), /positional/);
});

test("the shipped resume-smoke: two parts, a card each, said in one line", async () => {
  const smoke = (await import("../flows/resume-smoke.mjs")).default;
  assert.equal(smoke.name, "resume-smoke");
  assert.equal(smoke.resume, "auto");
  assert.deepEqual(smoke.grants, ["gate:deny"]);
  assert.equal(smoke.summarize({ part: 2, decision: "allowed" }, { outcome: "done" }), "冒烟完成：第 2 段批准");
  assert.equal(smoke.summarize({ part: 1, decision: "denied" }, { outcome: "stopped" }), "第 1 段停下：人闸不批");
});
