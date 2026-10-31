// Durable steps and carrying on: what a run of a line does is in the line's journal, and a run that carries it on takes it from there --
// `$.step`, an answer, a card a person answered -- while what cannot be taken back is never done twice on a guess. A fake executor
// answers; the runs that are cut off are real processes (steps-child.mjs). Nothing here talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runFlow, RunRefused } from "../runtime/run.mjs";
import { flow, define, text } from "../runtime/flow.mjs";
import { checkEvents, readEvents } from "../runtime/events.mjs";
import { claimFile } from "../runtime/claim.mjs";
import { Journal } from "../runtime/journal.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { parseResumeArgs, resumeRun, settleRun, listSteps, SettleRefused, UsageError } from "../runtime/orch.mjs";
import { resumedFile, ResumeRefused } from "../runtime/resume.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { commitThenBackfill } from "./steps-flows.mjs";
import { tempDir } from "./temp.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLOW_MJS = pathToFileURL(path.join(HERE, "..", "runtime", "flow.mjs")).href;
const CHILD = path.join(HERE, "steps-child.mjs");

// Flows a resume point can name are found by name, so these are files in a directory the config points to.
const BASE = await tempDir("orch-steps-");
const FLOWS = path.join(BASE, "flows");
mkdirSync(FLOWS, { recursive: true });
const source = (name, inputs, body) =>
  `import { flow, text } from ${JSON.stringify(FLOW_MJS)};\nimport { appendFileSync, existsSync } from "node:fs";\nimport path from "node:path";\nexport default flow({ name: ${JSON.stringify(name)}, description: "d", phases: [], inputs: ${inputs}, grants: [], resume: "auto", run: async (input, $) => {\n${body}\n} });\n`;
// Three steps, the last of them one that cannot be taken back, then a wait for a person to say go (a file), then a report.
writeFileSync(
  path.join(FLOWS, "st-line.mjs"),
  source(
    "st-line",
    "{ dir: text() }",
    `  const note = (line) => appendFileSync(path.join(input.dir, "log.txt"), line + "\\n");
  const a = await $.step("alpha", () => { note("alpha"); return { n: 1 }; });
  const b = await $.step("build", () => { note("build"); return { ok: true, from: a.n }; }, { key: a });
  await $.step("commit", () => { note("commit"); return { revision: 7 }; }, { once: true });
  if (!existsSync(path.join(input.dir, "go"))) $.stop("not yet", { why: "waiting for go" });
  return await $.step("report", () => { note("report"); return { b }; }, { key: b });`,
  ),
);
// What the flow says about how it could be carried on, by `mode`.
writeFileSync(
  path.join(FLOWS, "st-words.mjs"),
  source(
    "st-words",
    "{ mode: text() }",
    `  if (input.mode === "words") await $.resumeWith({ from: "my own words", spends: "nothing" });
  if (input.mode === "clear") await $.resumeWith(null);
  if (input.mode === "bad") await $.resumeWith({ spends: "sometimes" });
  if (input.mode === "other") await $.resumeWith({ flow: "st-line", input: { dir: "somewhere" } });
  await $.step("one", () => 1);
  return $.stop("stop", { why: "x" });`,
  ),
);
const CONFIG = path.join(BASE, "config.json");
writeFileSync(CONFIG, JSON.stringify({ flowsDirs: [FLOWS] }));
process.env.ORCH_CONFIG = CONFIG;
const flowFile = (name) => path.join(FLOWS, `${name}.mjs`);

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const options = (extra = {}) => ({ roster, caller: null, gatePollMs: 5, agentProbeDelays: [5], executor: fakeExecutor(), cwd: "C:/work", ...extra });
const logs = () => tempDir("orch-st-logs-");
const go = (target, logDir, extra = {}) => runFlow(target, { ...options(), logDir, ...extra });
/** The next run of the line `line`, started the way `orch resume` starts one (without taking the stop). */
const carry = (target, logDir, line, extra = {}) => runFlow(target, { ...options(), logDir, lineage: line, resumeOf: line, ...extra });
const resume = (logDir, previous, argv = [], extra = {}) => resumeRun(previous, argv, { logDir, runOptions: options(extra) });
const make = (body, { grants = [], ...extra } = {}) => flow({ name: "steps-test", description: "d", phases: [], inputs: {}, grants, run: (_, $) => body($), ...extra });

function eventsOf(result) {
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return events;
}
const starts = (events, type) => events.filter((e) => e.kind === "call.start" && (type === undefined || e.type === type));
const endOf = (events, callId) => events.find((e) => e.kind === "call.end" && e.callId === callId);
const warned = (events, pattern) => events.some((e) => e.kind === "log" && e.level === "warn" && pattern.test(e.message));
const contents = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const lines = (dir) => (existsSync(path.join(dir, "log.txt")) ? readFileSync(path.join(dir, "log.txt"), "utf8").split("\n").filter(Boolean) : []);

const draft = define({ name: "draft", effects: "none", timeout: "5m", returns: { headline: text("one line"), body: text("the text") }, prompt: ({ topic }) => `write about ${topic}` });
const edits = define({ name: "edits", effects: "workspace", timeout: "5m", returns: { done: text("what was done") }, prompt: ({ topic }) => `change the files for ${topic}` });
const v1 = { headline: "first", body: "one" };
const v2 = { headline: "second", body: "two" };

// --- $.step ----------------------------------------------------------------------------------------------

test("a step is done once for the line: a run that carries it on takes its value, unless the key changed or `still` says it does not hold", async () => {
  const logDir = await logs();
  const ran = [];
  const f = (key, still) =>
    make(async ($) => $.step("work", () => (ran.push(key), { at: ran.length, key }), { key, ...(still ? { still } : {}) }));

  const first = await go(f("a"), logDir, { runId: "L1" });
  assert.deepEqual(first.value, { at: 1, key: "a" });
  const second = await carry(f("a"), logDir, "L1");
  assert.deepEqual(second.value, { at: 1, key: "a" }, "the value of the first run");
  assert.equal(ran.length, 1, "the function did not run again");
  const events = eventsOf(second);
  const [taken] = starts(events, "step");
  assert.deepEqual([taken.name, taken.once, taken.reused], ["work", false, { runId: "L1", callId: "c1" }]);
  assert.match(taken.key, /^[0-9a-f]{16}$/);
  assert.deepEqual([endOf(events, taken.callId).ok, endOf(events, taken.callId).cost, endOf(events, taken.callId).agentId], [true, null, null]);

  assert.deepEqual((await carry(f("b"), logDir, "L1")).value, { at: 2, key: "b" }, "another key: done again");
  assert.deepEqual((await carry(f("b", async () => false), logDir, "L1")).value, { at: 3, key: "b" }, "`still` says no: done again");
  assert.deepEqual((await carry(f("b", async (value) => value.at === 3), logDir, "L1")).value, { at: 3, key: "b" }, "`still` sees the earlier value, and agrees");
  assert.equal(ran.length, 3);
  const redone = eventsOf(await carry(f("c"), logDir, "L1"));
  assert.equal(starts(redone, "step")[0].reused, null);
});

test("a run that does not carry another on takes nothing from it, and a step that fails leaves no record", async () => {
  const logDir = await logs();
  let runs = 0;
  const flaky = make(async ($) => $.step("flaky", () => {
    runs += 1;
    if (runs === 1) throw new Error("first time no");
    return runs;
  }));
  const failed = await go(flaky, logDir, { runId: "F1" });
  assert.equal(failed.outcome, "failed");
  assert.equal(endOf(eventsOf(failed), "c1").ok, false);
  assert.equal((await carry(flaky, logDir, "F1")).value, 2, "no record of the failure: done");
  // A fresh run is a line of its own; nothing is shared with the line above.
  assert.equal((await go(flaky, logDir)).value, 3);
});

test("a step is JSON: what comes back is what a later run is given, and what cannot be kept fails the step", async () => {
  const logDir = await logs();
  const f = make(async ($) => ({
    value: await $.step("shape", () => ({ when: new Date(0), skipped: undefined, n: 1 })),
    nothing: await $.step("nothing", () => {}),
  }));
  const first = await go(f, logDir, { runId: "J1" });
  const second = await carry(f, logDir, "J1");
  assert.deepEqual(first.value, { value: { when: "1970-01-01T00:00:00.000Z", n: 1 }, nothing: undefined });
  assert.deepEqual(second.value, first.value, "the same on the run that made it and on the one that took it");
  assert.equal(starts(eventsOf(second), "step").every((e) => e.reused !== null), true);

  const big = await go(make(async ($) => $.step("big", () => "x".repeat(2 * 1024 * 1024))), logDir);
  assert.equal(big.outcome, "failed");
  assert.match(big.error.message, /bigger than 1 MB/);
  const odd = await go(make(async ($) => $.step("odd", () => ({ n: 10n }))), logDir);
  assert.match(odd.error.message, /cannot be written as JSON/);
});

test("a step's name is its identity: once per run; the options are checked before anything is done", async () => {
  const logDir = await logs();
  const caught = [];
  const result = await go(
    make(async ($) => {
      await $.step("x", () => 1);
      for (const attempt of [
        () => $.step("x", () => 2),
        () => $.step("", () => 1),
        () => $.step("y", "not a function"),
        () => $.step("y", () => 1, { probe: () => ({ done: false }) }),
        () => $.step("y", () => 1, { before: () => 1 }),
        () => $.step("y", () => 1, { colour: "red" }),
        () => $.step("y", () => 1, { once: "yes" }),
        () => $.step("y", () => 1, { still: true }),
      ]) {
        caught.push(await attempt().then(() => "no error", (error) => error.message));
      }
      return $.step("z", () => "fine");
    }),
    logDir,
  );
  assert.equal(result.outcome, "done");
  assert.match(caught[0], /already has a step by that name/);
  assert.match(caught[1], /needs a name/);
  assert.match(caught[2], /needs a function/);
  assert.match(caught[3], /probe is for a step that cannot be taken back/);
  assert.match(caught[4], /before is for a step that cannot be taken back/);
  assert.match(caught[5], /unknown option colour/);
  assert.match(caught[6], /once is true or false/);
  assert.match(caught[7], /still must be a function/);
});

test("the run says which line it is in, and a flow can read it", async () => {
  const logDir = await logs();
  const f = make(async ($) => ({ lineage: $.ctx.lineage, lineDir: $.ctx.lineDir, resumed: $.ctx.resumed }));
  const first = await go(f, logDir, { runId: "C1" });
  assert.deepEqual(first.value, { lineage: "C1", lineDir: path.join(logDir, "runs", "C1"), resumed: false });
  const startOf = (result) => eventsOf(result)[0];
  assert.deepEqual([startOf(first).lineage, startOf(first).redo, startOf(first).resumeOf], ["C1", null, null]);
  const second = await carry(f, logDir, "C1");
  assert.deepEqual(second.value, { lineage: "C1", lineDir: path.join(logDir, "runs", "C1"), resumed: true });
  assert.deepEqual([startOf(second).lineage, startOf(second).resumeOf], ["C1", "C1"]);
  await assert.rejects(go(f, logDir, { lineage: "../x" }), (error) => error instanceof RunRefused && /lineage/.test(error.message));
  await assert.rejects(go(f, logDir, { redo: "x" }), (error) => error instanceof RunRefused && /needs a step name and resumeOf/.test(error.message));
});

// --- Carrying on a flow that runs again ------------------------------------------------------------------

test("resume: a flow with resume \"auto\" is carried on by running it again; what the line did is not done again, and the line stays the first run's", async () => {
  const logDir = await logs();
  const work = await tempDir("orch-st-work-");
  const first = await go(flowFile("st-line"), logDir, { runId: "line-1", input: { dir: work } });
  assert.equal(first.outcome, "stopped");
  assert.deepEqual(lines(work), ["alpha", "build", "commit"]);
  // The shape of run.end.resume is the one every resume point has, and its words say how far the journal got.
  assert.deepEqual(Object.keys(first.resume), ["flow", "input", "from", "spends"]);
  assert.deepEqual([first.resume.flow, first.resume.input, first.resume.spends], ["st-line", { dir: work }, "maybe"]);
  assert.match(first.resume.from, /前面3步沿用/);
  assert.ok([...first.resume.from].length <= 60);

  // Still not ready: carried on and stops again, doing nothing twice.
  const second = await resume(logDir, "line-1");
  assert.equal(second.outcome, "stopped");
  assert.deepEqual(lines(work), ["alpha", "build", "commit"]);
  assert.equal(eventsOf(second)[0].lineage, "line-1");
  assert.equal(eventsOf(second)[0].resumeOf, "line-1");
  writeFileSync(path.join(work, "go"), "");
  const third = await resume(logDir, second.runId);
  assert.equal(third.outcome, "done");
  assert.deepEqual(lines(work), ["alpha", "build", "commit", "report"], "each step ran once over the three runs");
  const events = eventsOf(third);
  assert.equal(events[0].lineage, "line-1", "a run that carries on a run that carried one on is still in the first one's line");
  assert.deepEqual(starts(events, "step").map((e) => [e.name, e.reused?.runId ?? null]), [["alpha", "line-1"], ["build", "line-1"], ["commit", "line-1"], ["report", null]]);
  assert.equal(third.resume, null);

  const listed = listSteps(third.runId, { logDir });
  assert.equal(listed.lineage, "line-1");
  assert.deepEqual(listed.entries.map((e) => [e.id, e.state, e.once]), [["step:alpha", "done", false], ["step:build", "done", false], ["step:commit", "done", true], ["step:report", "done", false]]);
});

test("resume --redo: a step and what came after it that can be taken back are done again; what cannot is not; a name that is not there does not use up the stop", async () => {
  const logDir = await logs();
  const work = await tempDir("orch-st-work-");
  await go(flowFile("st-line"), logDir, { runId: "redo-1", input: { dir: work } });
  assert.deepEqual(await parseResumeArgs(["--redo", "build"]), { timeout: null, host: null, cwd: null, redo: "build" });
  await assert.rejects(parseResumeArgs(["--redo", " "]), (error) => error instanceof UsageError && /--redo is the name of a step/.test(error.message));

  await assert.rejects(resume(logDir, "redo-1", ["--redo", "biuld"]), (error) => error instanceof ResumeRefused && /no step "biuld"[\s\S]*alpha, build, commit/.test(error.message));
  await assert.rejects(resume(logDir, "redo-1", ["--redo", "commit"]), (error) => error instanceof ResumeRefused && /cannot be undone/.test(error.message));
  assert.equal(existsSync(resumedFile(logDir, "redo-1")), false, "the stop was not taken by either");

  writeFileSync(path.join(work, "go"), "");
  const again = await resume(logDir, "redo-1", ["--redo", "build"]);
  assert.equal(again.outcome, "done");
  assert.deepEqual(lines(work), ["alpha", "build", "commit", "build", "report"], "build again, alpha and the commit kept");
  const events = eventsOf(again);
  assert.equal(events[0].redo, "build");
  assert.deepEqual(starts(events, "step").map((e) => [e.name, e.reused !== null]), [["alpha", true], ["build", false], ["commit", true], ["report", false]]);
});

test("resume: a flow words the point itself with $.resumeWith, partly or not at all; null takes it back; one that does not fit is not recorded", async () => {
  const logDir = await logs();
  const stopped = (mode) => go(flowFile("st-words"), logDir, { input: { mode } });
  const plain = await stopped("plain");
  assert.deepEqual([plain.resume.flow, plain.resume.input, plain.resume.spends], ["st-words", { mode: "plain" }, "maybe"]);
  assert.match(plain.resume.from, /前面1步沿用/);
  // The line of the point is kept up to date while the run works, so that a run that is cut off has said how far it got.
  const resumes = eventsOf(plain).filter((e) => e.kind === "resume");
  assert.ok(resumes.length >= 2);
  assert.deepEqual(resumes.at(-1).from, plain.resume.from);
  assert.match(resumes[0].from, /没有可沿用的/);

  const words = await stopped("words");
  assert.deepEqual([words.resume.from, words.resume.spends, words.resume.flow], ["my own words", "nothing", "st-words"]);
  assert.equal((await stopped("clear")).resume, null);
  const other = await stopped("other");
  assert.deepEqual([other.resume.flow, other.resume.input], ["st-line", { dir: "somewhere" }]);
  const bad = await stopped("bad");
  assert.equal(bad.resume.spends, "maybe", "the point before it stands");
  assert.ok(bad.caveats.some((c) => /resume point the flow declared was not recorded/.test(c)));
});

// --- $.ask, $.again ---------------------------------------------------------------------------------------

test("an answer is taken from the journal when the question is the same; another question, or an agent that may have changed files, is asked", async () => {
  const logDir = await logs();
  const ask = (topic, extra) => make(async ($) => $.ask(draft, { topic }, { role: "fast", ...extra }));
  const one = fakeExecutor({ answer: () => v1 });
  const first = await go(ask("t"), logDir, { runId: "A1", executor: one });
  assert.deepEqual(first.value, v1);

  const two = fakeExecutor({ answer: () => v2 });
  const second = await carry(ask("t"), logDir, "A1", { executor: two });
  assert.deepEqual(second.value, v1);
  assert.equal(two.requests.length, 0, "nobody was asked");
  const events = eventsOf(second);
  const [taken] = starts(events, "ask");
  assert.deepEqual(taken.reused, { runId: "A1", callId: "c1" });
  assert.equal(taken.archive, null, "nothing to archive: no agent was started");
  assert.equal(taken.prompt.includes("write about t"), true);
  assert.deepEqual(events.find((e) => e.kind === "call.agent").agentId, "fake-agent-1", "the agent that gave the answer, so that it can be opened");
  const end = endOf(events, "c1");
  assert.deepEqual([end.ok, end.agentId, end.cost, end.rounds], [true, "fake-agent-1", null, 1]);
  assert.equal(second.cost, null, "nothing was spent");

  const three = fakeExecutor({ answer: () => v2 });
  const third = await carry(ask("another"), logDir, "A1", { executor: three });
  assert.deepEqual(third.value, v2);
  assert.equal(three.requests.length, 1);
  assert.equal(warned(eventsOf(third), /not to what is asked now, so it is asked again/), true);

  // An agent allowed to change files says nothing of the files by its answer: the flow looks, or it is asked again.
  const write = (extra) => make(async ($) => $.ask(edits, { topic: "t" }, { role: "fast", ...extra }));
  const wrote = fakeExecutor({ answer: () => ({ done: "x" }) });
  await go(write(), logDir, { runId: "W1", executor: wrote });
  const again = fakeExecutor({ answer: () => ({ done: "y" }) });
  assert.deepEqual((await carry(write(), logDir, "W1", { executor: again })).value, { done: "y" });
  const looked = fakeExecutor({ answer: () => ({ done: "z" }) });
  assert.deepEqual((await carry(write({ reuse: async (answer) => answer.done === "y" }), logDir, "W1", { executor: looked })).value, { done: "y" });
  assert.equal(looked.requests.length, 0);
  assert.deepEqual((await carry(write({ reuse: () => false }), logDir, "W1", { executor: looked })).value, { done: "z" });
});

test("what is asked inside a step does not move the names of what comes after it: a step taken from the journal runs nothing in it", async () => {
  const logDir = await logs();
  const f = make(async ($) => {
    const inner = await $.step("outer", () => $.ask(draft, { topic: "t" }, { role: "fast" }));
    const outer = await $.ask(draft, { topic: "t" }, { role: "fast" });
    return { inner, outer };
  });
  let n = 0;
  const first = await go(f, logDir, { runId: "N1", executor: fakeExecutor({ answer: () => ({ headline: `h${++n}`, body: "b" }) }) });
  const executor = fakeExecutor({ answer: () => assert.fail("nothing is asked") });
  const second = await carry(f, logDir, "N1", { executor });
  assert.deepEqual(second.value, first.value);
  assert.equal(executor.requests.length, 0);
  const reused = starts(eventsOf(second), "ask").map((e) => e.reused !== null);
  assert.deepEqual(reused, [true], "the ask inside the taken step did not run; the one outside it was taken by its own name");
});

/** An executor whose agents can be sent to: each `send` is answered from `replies`. */
function withSend(replies, fake = {}) {
  const base = fakeExecutor(fake);
  const sends = [];
  return { ...base, sends, send: async (request) => (sends.push(request), replies.shift()) };
}

test("$.again is taken from the journal like an ask, and follows the answer it was given: another answer before it, another question to it", async () => {
  const logDir = await logs();
  const f = (topic) =>
    make(async ($) => {
      const a = await $.ask(draft, { topic }, { role: "fast" });
      return { a, b: await $.again(a, "make it shorter") };
    });
  const executor = withSend([v2, v2, v2], { answer: () => v1 });
  const first = await go(f("t"), logDir, { runId: "G1", executor });
  assert.deepEqual(first.value, { a: v1, b: v2 });
  assert.equal(executor.sends.length, 1);

  const second = await carry(f("t"), logDir, "G1", { executor });
  assert.deepEqual(second.value, first.value);
  assert.equal(executor.sends.length, 1, "not asked again");
  assert.equal(executor.requests.length, 1, "nor was a new agent");
  const events = eventsOf(second);
  const [a, b] = starts(events, "ask");
  assert.deepEqual([a.reused?.callId, b.reused?.callId], ["c1", "c2"]);
  assert.deepEqual(b.continues, { runId: second.runId, callId: a.callId }, "it goes on from the call that took the answer, whose agent is the same");
  assert.equal(endOf(events, b.callId).agentId, endOf(events, a.callId).agentId);

  // The same words from another agent are not the answer the second was a reply to: it went on with the first agent's conversation.
  const same = await carry(f("other"), logDir, "G1", { executor });
  assert.equal(executor.requests.length, 2, "the other question was asked");
  assert.equal(executor.sends.length, 2, "and the follow-up was said to the agent that gave this answer");
  assert.deepEqual(starts(eventsOf(same), "ask").map((e) => e.reused !== null), [false, false]);
  const changed = withSend([v1], { answer: () => v2 });
  const third = await carry(f("another"), logDir, "G1", { executor: changed });
  assert.deepEqual(third.value, { a: v2, b: v1 });
  assert.equal(changed.sends.length, 1, "asked again, of the new agent");
  assert.equal(eventsOf(third).filter((e) => e.kind === "call.start" && e.reused !== null).length, 0);
});

// --- Cards -----------------------------------------------------------------------------------------------

const GATED = { grants: ["gate:deny"] };
const asked = (executor) => executor.requests.filter((r) => r.provider.startsWith("orch-gate")).length;

test("a card a person answered is not put to them again when it is the same card; another card, an expired one and one that asks for a value are", async () => {
  const logDir = await logs();
  const card = (content = "body", extra = {}) => make(async ($) => (await $.gate({ title: "approve it", content, timeout: "1m", ...extra })), GATED);

  const first = fakeExecutor({ carrier: "approve" });
  const answered = await go(card(), logDir, { runId: "K1", executor: first });
  assert.equal(answered.value.outcome, "allowed");
  assert.equal(asked(first), 1);

  const hang = fakeExecutor({ carrier: "hang" });
  const second = await carry(card(), logDir, "K1", { executor: hang });
  assert.equal(second.value.outcome, "allowed", "their word, with its own time");
  assert.equal(second.value.decidedAt, answered.value.decidedAt);
  assert.equal(asked(hang), 0, "no card");
  const events = eventsOf(second);
  const [gate] = starts(events, "gate");
  assert.deepEqual(gate.reused, { runId: "K1", callId: "c1" });
  assert.equal(endOf(events, gate.callId).output.outcome, "allowed");
  assert.equal(second.cost, null);

  const other = fakeExecutor({ carrier: "deny" });
  assert.equal((await carry(card("another body"), logDir, "K1", { executor: other })).value.outcome, "denied", "another card");
  assert.equal(asked(other), 1);

  // A no is an answer too: it stays what it was said to be.
  const denied = fakeExecutor({ carrier: "deny" });
  await go(card("for a no"), logDir, { runId: "K2", executor: denied });
  const approving = fakeExecutor({ carrier: "approve" });
  const still = await carry(card("for a no"), logDir, "K2", { executor: approving });
  assert.deepEqual([still.value.outcome, still.value.approved, asked(approving)], ["denied", false, 0]);

  // Nobody answered: the card is asked again.
  const unanswered = fakeExecutor({ carrier: "hang" });
  const expired = await go(card("for nobody", { timeout: "1s" }), logDir, { runId: "K3", executor: unanswered });
  assert.equal(expired.value.outcome, "expired");
  const answering = fakeExecutor({ carrier: "approve" });
  assert.equal((await carry(card("for nobody", { timeout: "1s" }), logDir, "K3", { executor: answering })).value.outcome, "allowed");
  assert.equal(asked(answering), 1);

  // A card that asks for a value is asked every time, and the value is in no file.
  const code = (extra) => make(async ($) => $.gate({ title: "approve with a code", content: "x", timeout: "1m", input: { label: "code" }, ...extra }), GATED);
  await go(code(), logDir, { runId: "K4", executor: fakeExecutor({ carrier: "input" }) });
  const again = fakeExecutor({ carrier: "input" });
  const typed = await carry(code(), logDir, "K4", { executor: again });
  assert.equal(typed.value.input, "483921");
  assert.equal(asked(again), 1);
  for (const file of [new Journal({ dir: logDir, lineage: "K4" }).file, typed.events]) assert.equal(contents(file).includes("483921"), false, file);
});

// --- Steps that cannot be taken back ---------------------------------------------------------------------

test("a step that cannot be taken back is not authorised twice: its card is asked before it begins, so a run that is cut off after it never asks again", async () => {
  const logDir = await logs();
  const commits = [];
  const backfills = [];
  const f = (crash) =>
    make(async ($) => {
      const c = await $.step("commit", (given) => (commits.push(given.input), { committed: true, revision: 12 }), {
        once: true,
        before: async () => {
          const given = await $.gate({ title: "approve the commit", content: "the diff", timeout: "1m", input: { label: "code" } });
          if (!given.approved) $.stop("not approved");
          return given;
        },
      });
      if (crash) throw new Error("the run broke before the backfill began");
      await $.step("backfill", () => backfills.push(c.revision), { once: true });
      return c;
    }, GATED);
  const first = fakeExecutor({ carrier: "input" });
  const broke = await go(f(true), logDir, { runId: "H1", executor: first });
  assert.equal(broke.outcome, "failed");
  assert.deepEqual([commits, backfills, asked(first)], [["483921"], [], 1]);

  const nobody = fakeExecutor({ carrier: "hang" });
  const finished = await carry(f(false), logDir, "H1", { executor: nobody });
  assert.equal(finished.outcome, "done");
  assert.deepEqual([commits, backfills, asked(nobody)], [["483921"], [12], 0], "committed once, no second card, the backfill went straight on");
  const events = eventsOf(finished);
  assert.deepEqual(starts(events).map((e) => [e.type, e.name, e.reused !== null]), [["step", "commit", true], ["step", "backfill", false]]);
});

test("a step that cannot be taken back, in a process that dies inside it, is not done again on a guess: the run stops and says how to settle it", async () => {
  const crashed = async (dieIn) => {
    const logDir = await logs();
    const work = await tempDir("orch-st-work-");
    const died = await run(process.execPath, [CHILD, logDir, "crash-1", work, dieIn]).then(() => assert.fail("the process should have died"), (error) => error);
    assert.equal(died.code, 7);
    // What a run that was killed leaves: no run.end, a claim nobody touches, a process that is gone.
    const claim = claimFile(logDir, "crash-1");
    writeFileSync(claim, JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname(), startedAt: "2026-10-30T00:00:00.000Z" }));
    const old = new Date(Date.now() - 300_000);
    utimesSync(claim, old, old);
    return { logDir, work };
  };
  const next = (logDir, work, probe, runId = "crash-2") => carry(commitThenBackfill({ probe }), logDir, "crash-1", { runId, input: { dir: work }, executor: fakeExecutor({ carrier: "hang" }) });

  // Died in the backfill, after the commit and its card: no probe, so a person says.
  const { logDir, work } = await crashed("backfill");
  assert.deepEqual(lines(work), ["commit with code 483921", "backfill of 12"]);
  const stopped = await next(logDir, work, "none");
  assert.equal(stopped.outcome, "stopped");
  assert.match(stopped.stop.reason, /orch\.mjs settle crash-2 backfill --done .* --not-done/);
  assert.deepEqual(lines(work), ["commit with code 483921", "backfill of 12"], "neither the commit nor the backfill was done again");
  const events = eventsOf(stopped);
  assert.equal(events.some((e) => e.kind === "call.start" && e.type === "gate"), false, "and no card for the commit");
  assert.deepEqual(starts(events, "step").map((e) => [e.name, e.reused !== null]), [["commit", true]]);
  // The stop is one a run can be carried on from, and the journal says what is unknown.
  assert.equal(stopped.resume, null, "this flow does not run again by itself: it said nothing of how");
  assert.deepEqual(listSteps("crash-2", { logDir }).entries.map((e) => [e.id, e.state]), [["step:commit", "done"], ["step:backfill", "begun"]]);

  // A person looks and says it was done, with the value it would have given.
  assert.deepEqual(settleRun("crash-2", ["backfill", "--done", '{"ok":true,"by":"person"}'], { logDir }).settled, "done");
  const finished = await next(logDir, work, "none", "crash-3");
  assert.equal(finished.outcome, "done");
  assert.deepEqual(lines(work), ["commit with code 483921", "backfill of 12"], "taken as done, not done again");

  // With a probe that finds it was done, or was not.
  const found = await crashed("backfill");
  assert.equal((await next(found.logDir, found.work, "done")).outcome, "done");
  assert.deepEqual(lines(found.work), ["commit with code 483921", "backfill of 12"]);
  assert.equal(listSteps("crash-2", { logDir: found.logDir }).entries.find((e) => e.id === "step:backfill").by, "probe");
  const missed = await crashed("backfill");
  assert.equal((await next(missed.logDir, missed.work, "not-done")).outcome, "done");
  assert.deepEqual(lines(missed.work), ["commit with code 483921", "backfill of 12", "backfill of 12"], "the probe said it was not done, so it was");

  // Died in the commit itself, which has no probe here: the same stop, and still no second card.
  const inCommit = await crashed("commit");
  const unknown = await next(inCommit.logDir, inCommit.work, "none");
  assert.equal(unknown.outcome, "stopped");
  assert.match(unknown.stop.reason, /settle crash-2 commit/);
  assert.deepEqual([unknown.stop.kind, unknown.stop.step], ["unknown", "commit"]);
  assert.deepEqual(lines(inCommit.work), ["commit with code 483921"]);
});

test("a step that cannot be taken back and fails is not known to have failed; one whose value holds a secret is done and its value is not kept", async () => {
  const logDir = await logs();
  const f = (fails) => make(async ($) => $.step("act", () => { if (fails) throw new Error("exit code 1, and the server may have got it"); return { ok: true }; }, { once: true }));
  const first = await go(f(true), logDir, { runId: "U1" });
  assert.equal(first.outcome, "failed");
  const second = await carry(f(false), logDir, "U1");
  assert.equal(second.outcome, "stopped");
  assert.match(second.stop.reason, /settle .* act/);

  const secret = (once) =>
    make(async ($) => {
      const given = await $.gate({ title: "code", content: "x", timeout: "1m", input: { label: "code" } });
      return $.step("embed", () => ({ code: given.input, n: 1 }), { once });
    }, GATED);
  for (const once of [false, true]) {
    const dir = await logs();
    const made = await go(secret(once), dir, { runId: "S1", executor: fakeExecutor({ carrier: "input" }) });
    assert.equal(made.outcome, "done");
    const journal = new Journal({ dir, lineage: "S1" });
    assert.equal(contents(journal.file).includes("483921"), false, "the code is in no file of the journal");
    const entry = journal.get("step:embed");
    if (once) assert.deepEqual([entry.state, entry.dropped], ["done", true], "done, with no value to give back");
    else assert.equal(entry, null, "not kept at all: the step is done again by a run that carries it on");
    const later = await carry(secret(once), dir, "S1", { executor: fakeExecutor({ carrier: "input" }) });
    assert.equal(later.outcome, once ? "stopped" : "done", once ? "a value that was not kept is not known" : "done again");
  }
});

test("settle: only a step that may or may not have been done, once the run that began it is over; and what is said is what a later run does", async () => {
  const logDir = await logs();
  const work = await tempDir("orch-st-work-");
  await run(process.execPath, [CHILD, logDir, "crash-1", work, "backfill"]).catch(() => {});
  const settle = (...argv) => settleRun("crash-1", argv, { logDir });
  // The run that began the step may still be working: here its claim is one of a live process.
  const claim = claimFile(logDir, "crash-1");
  const claimOf = (pid) => writeFileSync(claim, JSON.stringify({ pid, hostname: os.hostname(), startedAt: "2026-10-30T00:00:00.000Z" }));
  claimOf(process.pid);
  assert.throws(() => settle("backfill", "--not-done"), (error) => error instanceof SettleRefused && /is not known to be over \(running\)/.test(error.message));
  claimOf(2 ** 22 + 12345);

  assert.throws(() => settle("commit", "--done", "{}"), (error) => error instanceof SettleRefused && /is done, not a step that may or may not/.test(error.message));
  assert.throws(() => settle("nothing", "--not-done"), (error) => error instanceof SettleRefused && /no step "nothing"/.test(error.message));
  assert.throws(() => settle("backfill"), (error) => error instanceof UsageError && /either --done <json> or --not-done/.test(error.message));
  assert.throws(() => settle("backfill", "--done", "{", "--not-done"), UsageError);
  assert.throws(() => settle("backfill", "--done", "{nope"), (error) => error instanceof UsageError && /step's value as JSON/.test(error.message));
  assert.throws(() => settle("--not-done"), (error) => error instanceof UsageError);

  assert.equal(settle("backfill", "--not-done").settled, "not-done");
  assert.throws(() => settle("backfill", "--done", "{}"), (error) => error instanceof SettleRefused && /settled as not done/.test(error.message), "settled once");
  const finished = await carry(commitThenBackfill({}), logDir, "crash-1", { runId: "crash-2", input: { dir: work }, executor: fakeExecutor({ carrier: "hang" }) });
  assert.equal(finished.outcome, "done");
  assert.deepEqual(lines(work).slice(-2), ["backfill of 12", "backfill of 12"], "said not done: done");
  assert.throws(() => settleRun("no-such-run", ["x", "--not-done"], { logDir }), UsageError);
});
