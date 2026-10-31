// What a caller from outside needs of a run: its own id that can be taken only
// once, the affair it belongs to, and a flow found by name. Nothing here talks
// to Paseo and nothing is spent.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import advisor from "../flows/advisor.mjs";
import { runFlow, RunRefused } from "../runtime/run.mjs";
import { flow } from "../runtime/flow.mjs";
import { checkEvents, readEvents, eventsFile } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { claimFile, claimRun, runIdProblem, ClaimTaken, LIVE_WITHIN_MS } from "../runtime/claim.mjs";
import { affairProblems, parseAffair, LABEL_LIMIT } from "../runtime/affair.mjs";
import { parseConfig } from "../runtime/config.mjs";
import { resolveFlowFile, resolveTarget, isFlowName, FLOWS_DIR, FlowLookupError } from "../runtime/resolve.mjs";
import { parseRunArgs } from "../runtime/orch.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
let roster;
const tmp = (name) => tempDir(`orch-${name}-`);

before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const ANSWER = { verdict: "v", reasoning: "r", recommendation: "do", whatWouldChangeMyMind: "w", confidence: "high" };
const advise = (logDir, options = {}, delayMs = 0) => {
  const executor = fakeExecutor({ answer: () => ANSWER, delayMs });
  const result = runFlow(advisor, { roster, logDir, executor, cwd: "C:/work", caller: null, input: { question: "q", role: "fast" }, ...options });
  return { result, executor };
};
const names = async (dir) => ((await readdir(path.join(dir, "runs")).catch(() => [])).sort());

// --- The id --------------------------------------------------------------

test("run id: the caller's id names the files, and the claim says who holds it", async () => {
  const dir = await tmp("id");
  const { result } = advise(dir, { runId: "release-24.attempt_1" });
  const done = await result;
  assert.equal(done.runId, "release-24.attempt_1");
  assert.equal(done.events, eventsFile(dir, "release-24.attempt_1"));
  // (The directory is the run's journal: what it asked is kept there for a run that carries it on.)
  assert.deepEqual(await names(dir), ["release-24.attempt_1", "release-24.attempt_1.claim", "release-24.attempt_1.jsonl"]);

  const events = readEvents(done.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  assert.ok(events.every((e) => e.runId === "release-24.attempt_1"));

  const held = JSON.parse(await readFile(claimFile(dir, "release-24.attempt_1"), "utf8"));
  assert.equal(held.pid, process.pid);
  assert.equal(held.hostname, os.hostname());
  assert.equal(held.pid, events[0].pid, "the claim and run.start name the same process");
  assert.ok(Number.isFinite(Date.parse(held.startedAt)));
  assert.equal(held.refused, undefined);
});

test("run id: a generated id still takes a claim, and the claim is not touched after the run", async () => {
  const dir = await tmp("generated");
  const done = await advise(dir).result;
  assert.deepEqual(await names(dir), [done.runId, `${done.runId}.claim`, `${done.runId}.jsonl`]);
});

test("run id: a malformed id is refused, and nothing is created for it", async () => {
  const dir = await tmp("badid");
  const long = "a".repeat(129);
  for (const bad of ["", "../escape", "a/b", "a\\b", ".hidden", "-lead", "has space", "CON", "nul.txt", "lpt1", long, "x\u0000y", 7, null]) {
    const { result, executor } = advise(dir, { runId: bad });
    await assert.rejects(result, (error) => error instanceof RunRefused && /--run-id/.test(error.message), JSON.stringify(bad));
    assert.equal(executor.requests.length, 0);
  }
  assert.deepEqual(await names(dir), []);
  assert.equal(runIdProblem("fine-1.2_3"), null);
  assert.equal(runIdProblem("a".repeat(128)), null);
});

test("run id: a taken id is refused before anything is paid for", async () => {
  const dir = await tmp("taken");
  mkdirSync(path.join(dir, "runs"));
  writeFileSync(claimFile(dir, "r1"), JSON.stringify({ pid: 4242, hostname: "other-box", startedAt: "2026-10-23T08:00:00.000Z" }));
  const { result, executor } = advise(dir, { runId: "r1" });
  await assert.rejects(result, (error) => error instanceof RunRefused && /already taken by pid 4242 on other-box/.test(error.message) && /last touched/.test(error.message));
  assert.equal(executor.requests.length, 0, "no agent was asked");
  assert.deepEqual(await names(dir), ["r1.claim"], "the holder's claim is left as it was");
  assert.equal(JSON.parse(await readFile(claimFile(dir, "r1"), "utf8")).pid, 4242);
});

test("run id: an id that already has events is refused even if its claim is gone", async () => {
  const dir = await tmp("events");
  const first = await advise(dir, { runId: "once" }).result;
  assert.equal(first.ok, true);
  unlinkSync(claimFile(dir, "once"));
  const { result, executor } = advise(dir, { runId: "once" });
  await assert.rejects(result, (error) => error instanceof RunRefused && /already has events/.test(error.message));
  assert.equal(executor.requests.length, 0);
  assert.equal(existsSync(claimFile(dir, "once")), false, "refusing it did not claim it");
  assert.equal(readEvents(eventsFile(dir, "once")).filter((e) => e.kind === "run.start").length, 1);
});

test("run id: two runs started together in one process, one id: one runs", async () => {
  const dir = await tmp("together");
  const a = advise(dir, { runId: "same" }, 30);
  const b = advise(dir, { runId: "same" }, 30);
  const settled = await Promise.allSettled([a.result, b.result]);
  assert.deepEqual(settled.map((s) => s.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(a.executor.requests.length + b.executor.requests.length, 1, "the flow's one ask was paid for once");
  assert.equal(readEvents(eventsFile(dir, "same")).filter((e) => e.kind === "run.start").length, 1);
});

test("run id: two processes started together with one id: one runs, the other pays nothing", async () => {
  const dir = await tmp("processes");
  const child = (id) => run(process.execPath, [path.join(HERE, "claim-child.mjs"), id, dir, "400"]);
  const outputs = (await Promise.all([child("shared"), child("shared"), child("shared")])).map((r) => JSON.parse(r.stdout.trim()));
  const ran = outputs.filter((o) => o.ran);
  const refused = outputs.filter((o) => !o.ran);
  assert.equal(ran.length, 1, JSON.stringify(outputs));
  assert.equal(ran[0].asks, 1);
  assert.equal(refused.length, 2);
  for (const o of refused) {
    assert.equal(o.refused, true);
    assert.equal(o.asks, 0, "a refused process asked no agent");
    assert.match(o.message, /already taken|already has events/);
  }
  const events = readEvents(eventsFile(dir, "shared"));
  assert.equal(events.filter((e) => e.kind === "run.start").length, 1);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
});

test("run id: a refusal after the claim leaves the reason with the claim, for a caller-given id only", async () => {
  const dir = await tmp("refused");
  // A flow input that does not fit: refused after the claim was taken.
  const { result } = advise(dir, { runId: "mine", input: { question: "q" } });
  await assert.rejects(result, /input\.role: missing/);
  const held = JSON.parse(await readFile(claimFile(dir, "mine"), "utf8"));
  assert.match(held.refused, /^RunRefused: .*input\.role: missing/s);
  assert.equal(existsSync(eventsFile(dir, "mine")), false);
  // The id is spent: trying again with it is refused, and says why the first one was.
  await assert.rejects(advise(dir, { runId: "mine" }).result, /already taken.*it was refused: RunRefused/s);
  // A generated id is nobody's to look up: no file.
  await assert.rejects(advise(dir, { input: { question: "q" } }).result, /input\.role: missing/);
  assert.deepEqual(await names(dir), ["mine.claim"]);
});

test("claim: the holder touches it, and stops when told", async () => {
  const dir = await tmp("heartbeat");
  let clock = Date.parse("2026-10-23T08:00:00.000Z");
  const claim = claimRun({ dir, runId: "beat", heartbeatMs: 15, now: () => clock });
  const old = new Date("2026-10-23T07:00:00.000Z");
  utimesSync(claim.file, old, old);
  clock += 5_000;
  await new Promise((r) => setTimeout(r, 80));
  const touched = statSync(claim.file).mtimeMs;
  assert.ok(Math.abs(touched - clock) < 2, `touched at the clock the holder reads: ${touched} vs ${clock}`);
  claim.stop();
  utimesSync(claim.file, old, old);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(statSync(claim.file).mtimeMs, old.getTime(), "stopped: no more touches");
  assert.throws(() => claimRun({ dir, runId: "beat" }), ClaimTaken);
  assert.ok(LIVE_WITHIN_MS >= 4 * 30_000, "four of the 30s heartbeats fit in the window");
});

test("claim: a claim that was removed is put back; one that cannot be touched is given up after three tries, once", async () => {
  const dir = await tmp("heartbeat-fail");
  const errors = [];
  const claim = claimRun({ dir, runId: "gone", heartbeatMs: 10, onError: (e) => errors.push(e) });
  unlinkSync(claim.file);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(existsSync(claim.file), true, "put back, with what it said before");
  assert.equal(JSON.parse(await readFile(claim.file, "utf8")).pid, process.pid);
  assert.equal(errors.length, 0);
  // The directory itself is gone: nothing can be put back.
  rmSync(path.join(dir, "runs"), { recursive: true });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(errors.length, 1, "told once, after three failures");
  assert.equal(errors[0].code, "ENOENT");
});

test("claim: a handler that throws does not take the process down", async () => {
  const dir = await tmp("heartbeat-throws");
  const claim = claimRun({
    dir,
    runId: "throws",
    heartbeatMs: 10,
    onError: () => {
      throw new Error("the disk is the problem for the log too");
    },
  });
  rmSync(path.join(dir, "runs"), { recursive: true });
  // An uncaught exception in a timer would fail this test run; waiting is the test.
  await new Promise((r) => setTimeout(r, 120));
  claim.stop();
});

test("claim: refusing writes the whole file at once, and leaves no scratch file", async () => {
  const dir = await tmp("refuse-atomic");
  const claim = claimRun({ dir, runId: "r" });
  claim.refuse("because");
  assert.equal(JSON.parse(await readFile(claim.file, "utf8")).refused, "because");
  assert.deepEqual(await names(dir), ["r.claim"]);
});

test("run id: ids that look like the runner's own files are refused", () => {
  for (const bad of ["a.claim", "a.jsonl", "A.CLAIM", "x.y.jsonl"]) assert.match(runIdProblem(bad), /own files/, bad);
  for (const fine of ["claim", "a.claim.1", "jsonl-1", "a.json"]) assert.equal(runIdProblem(fine), null, fine);
});

// --- The affair ----------------------------------------------------------

const FULL = {
  label: "Release 2.4 · 等灰度",
  url: "https://tracker.example.com/cases/24?tab=runs",
  link: { plugin: "tracker", screen: "case", params: { id: "24", "from.run": "x y" } },
};

test("affair: written to run.start as given; null when there is none", async () => {
  const dir = await tmp("affair");
  const given = await advise(dir, { affair: FULL }).result;
  const start = readEvents(given.events)[0];
  assert.deepEqual(start.affair, FULL);
  assert.deepEqual(checkEvents(readEvents(given.events), { strict: true, complete: true }), []);

  for (const none of [{}, { affair: null }, { affair: undefined }]) {
    const result = await advise(dir, none).result;
    const events = readEvents(result.events);
    assert.equal(events[0].affair, null);
    assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  }
  const label = await advise(dir, { affair: { label: "just words" } }).result;
  assert.deepEqual(readEvents(label.events)[0].affair, { label: "just words" });
});

test("affair: what does not fit is refused before the run, naming every problem", async () => {
  const bad = {
    "not an object": "release 24",
    "an array": [{ label: "x" }],
    "no label": {},
    "empty label": { label: "  " },
    "label too long": { label: "x".repeat(LABEL_LIMIT + 1) },
    "label with a newline": { label: "one\ntwo" },
    "label with a right-to-left override": { label: "fdp.\u202Etxt" },
    "label not text": { label: 24 },
    "unknown key": { label: "x", owner: "someone" },
    "script url": { label: "x", url: "javascript:alert(1)" },
    "data url": { label: "x", url: "data:text/html,hi" },
    "relative url": { label: "x", url: "/cases/24" },
    "url with credentials": { label: "x", url: "https://user:secret@example.com/" },
    "url with a space": { label: "x", url: "https://example.com/a b" },
    "url too long": { label: "x", url: `https://example.com/${"a".repeat(2_100)}` },
    "link not an object": { label: "x", link: "tracker/case" },
    "link without screen": { label: "x", link: { plugin: "tracker" } },
    "plugin with a slash": { label: "x", link: { plugin: "a/b", screen: "case" } },
    "screen with a query": { label: "x", link: { plugin: "tracker", screen: "case?x=1" } },
    "link unknown key": { label: "x", link: { plugin: "tracker", screen: "case", route: "/x" } },
    "params not strings": { label: "x", link: { plugin: "tracker", screen: "case", params: { id: 24 } } },
    "param key with an equals sign": { label: "x", link: { plugin: "tracker", screen: "case", params: { "a=b": "1" } } },
    "param value too long": { label: "x", link: { plugin: "tracker", screen: "case", params: { id: "9".repeat(300) } } },
    "too many params": { label: "x", link: { plugin: "tracker", screen: "case", params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])) } },
  };
  const dir = await tmp("affair-bad");
  for (const [what, affair] of Object.entries(bad)) {
    assert.ok(affairProblems(affair).length > 0, what);
    assert.throws(() => parseAffair(affair), TypeError, what);
    const { result, executor } = advise(dir, { affair });
    await assert.rejects(result, (error) => error instanceof RunRefused && /--affair does not fit/.test(error.message), what);
    assert.equal(executor.requests.length, 0, what);
  }
  assert.deepEqual(await names(dir), [], "generated ids: no file for any refusal");
  const several = affairProblems({ label: "", url: "ftp://x", link: { plugin: "", screen: "" } });
  assert.ok(several.length >= 4, several.join("; "));
});

test("affair: ordinary text passes -- Chinese, emoji, a join character, a long but allowed value", () => {
  assert.deepEqual(affairProblems({ label: "2.4 版本发布 · 灰度 50%" }), []);
  assert.deepEqual(affairProblems({ label: "👨‍👩‍👧 family" }), []);
  assert.deepEqual(affairProblems({ label: "あ".repeat(LABEL_LIMIT) }), [], "counted in characters, not code units");
  assert.deepEqual(affairProblems({ label: "x", url: "http://localhost:3000/a%20b?q=1#frag" }), []);
  assert.deepEqual(affairProblems({ label: "x", link: { plugin: "p", screen: "s", params: { k: "v".repeat(256) } } }), []);
});

const CASES = JSON.parse(readFileSync(path.join(HERE, "..", "fixtures", "affair-cases.json"), "utf8"));

test("affair: invisible and direction-changing characters are refused in a label, joiners are not", () => {
  for (const { code, as_text: ch } of CASES.unsafe) {
    assert.ok(affairProblems({ label: `a${ch}b` }).length > 0, `U+${code.toString(16)} in a label`);
    assert.ok(affairProblems({ label: ch }).length > 0, `U+${code.toString(16)} alone`);
    assert.ok(affairProblems({ label: "x", link: { plugin: "p", screen: "s", params: { k: `v${ch}` } } }).length > 0, `U+${code.toString(16)} in a param`);
  }
  for (const { code, as_text: ch } of CASES.ok) {
    assert.deepEqual(affairProblems({ label: `a${ch}b` }), [], `U+${code.toString(16)} in a label`);
  }
  assert.ok(affairProblems({ label: "x", url: `https://example.com/${String.fromCharCode(0x200b)}a` }).length > 0, "a zero width space in a url");
});

test("affair: the source holds the character classes as escapes, not as invisible characters", () => {
  const source = readFileSync(path.join(HERE, "..", "runtime", "affair.mjs"), "utf8");
  // Anything outside printable ASCII in a line that is not a comment is a literal character.
  const literal = source.split(String.fromCharCode(10)).filter((line) => !line.trimStart().startsWith("//") && /[^ -~]/.test(line));
  assert.deepEqual(literal, []);
});

test("affair: run.start files written before it was added still read, and a bad one is caught", async () => {
  const dir = await tmp("affair-old");
  const events = readEvents((await advise(dir).result).events);
  const { affair, ...old } = events[0];
  const oldFile = [old, ...events.slice(1)];
  assert.deepEqual(checkEvents(oldFile, { complete: true }), [], "a reader of old files is not bothered");
  assert.match(checkEvents(oldFile, { strict: true, complete: true }).join(), /affair is missing/);
  assert.match(checkEvents([{ ...events[0], affair: { label: "" } }, ...events.slice(1)]).join(), /affair is not null or/);
  assert.match(checkEvents([{ ...events[0], affair: "text" }, ...events.slice(1)]).join(), /affair is not null or/);
});

// --- Flow names ----------------------------------------------------------

function flowsIn(dir, ...fileNames) {
  mkdirSync(dir, { recursive: true });
  for (const name of fileNames) writeFileSync(path.join(dir, `${name}.mjs`), "export default null;\n");
  return dir;
}

test("flows: a name is the shipped flow, or one in a flowsDirs directory", async () => {
  const mine = flowsIn(path.join(await tmp("flows"), "mine"), "release-notes", "triage");
  assert.equal(resolveFlowFile("advisor"), path.join(FLOWS_DIR, "advisor.mjs"));
  assert.equal(resolveFlowFile("triage", [FLOWS_DIR, mine]), path.join(mine, "triage.mjs"));
  assert.equal(resolveFlowFile("release-notes", [FLOWS_DIR, mine]), path.join(mine, "release-notes.mjs"));
  // The same directory named twice is one flow, not two.
  assert.equal(resolveFlowFile("triage", [mine, mine, path.join(mine, "..", "mine")]), path.join(mine, "triage.mjs"));
});

test("flows: not found says where it looked, what is there, and which directory is not a directory", async () => {
  const mine = flowsIn(path.join(await tmp("flows-miss"), "mine"), "triage");
  const absent = path.join(os.tmpdir(), "orch-no-such-flows-dir");
  assert.throws(
    () => resolveFlowFile("nosuch", [FLOWS_DIR, mine, absent]),
    (error) =>
      error instanceof FlowLookupError &&
      error.message.includes(mine) &&
      error.message.includes(`not a directory: ${absent}`) &&
      /Flows there: .*advisor.*triage/.test(error.message) &&
      /flowsDirs/.test(error.message),
  );
});

test("flows: the same name in two directories is an error, not an override", async () => {
  const base = await tmp("flows-dup");
  const one = flowsIn(path.join(base, "one"), "triage", "only-one");
  const two = flowsIn(path.join(base, "two"), "triage");
  assert.throws(
    () => resolveFlowFile("triage", [FLOWS_DIR, one, two]),
    (error) => error instanceof FlowLookupError && error.message.includes(path.join(one, "triage.mjs")) && error.message.includes(path.join(two, "triage.mjs")) && /more than once/.test(error.message),
  );
  assert.equal(resolveFlowFile("only-one", [FLOWS_DIR, one, two]), path.join(one, "only-one.mjs"));
  assert.throws(() => resolveFlowFile("advisor", [FLOWS_DIR, flowsIn(path.join(base, "three"), "advisor")]), /more than once/);
});

test("flows: only a bare name is looked up; a path is a path as before", () => {
  assert.equal(isFlowName("advisor"), true);
  assert.equal(isFlowName("hot-fix2"), true);
  for (const path_ of ["advisor.mjs", "./advisor", "flows/advisor.mjs", "C:\\flows\\advisor.mjs", "..", "Advisor", "", "a b", "../x"]) {
    assert.equal(isFlowName(path_), false, path_);
    assert.equal(resolveTarget(path_), path_);
  }
  assert.equal(resolveTarget("advisor"), path.join(FLOWS_DIR, "advisor.mjs"));
  assert.throws(() => resolveFlowFile("../etc/passwd"), FlowLookupError);
});

test("flows: flowsDirs is a config key, a list of non-empty strings", () => {
  assert.deepEqual(parseConfig('{ "flowsDirs": ["D:/private/flows"] }', "c").flowsDirs, ["D:/private/flows"]);
  assert.throws(() => parseConfig('{ "flowsDirs": "D:/private/flows" }', "c"), /"flowsDirs" has the wrong shape/);
  assert.throws(() => parseConfig('{ "flowsDirs": [""] }', "c"), /wrong shape/);
  assert.throws(() => parseConfig('{ "flowDirs": [] }', "c"), /unknown key "flowDirs"/);
});

test("flows: the command line finds a flow by name through the configured directories", async () => {
  const base = await tmp("flows-cli");
  const dir = path.join(base, "mine");
  mkdirSync(dir);
  // A real flow, so `check` loads it.
  await writeFile(
    path.join(dir, "ping.mjs"),
    `import { flow } from ${JSON.stringify(pathToFileURL(path.join(HERE, "..", "runtime", "flow.mjs")).href)};\n` +
      'export default flow({ name: "ping", description: "d", phases: [], inputs: {}, grants: [], async run() { return 1; } });\n',
  );
  const config = path.join(base, "config.json");
  await writeFile(config, JSON.stringify({ flowsDirs: [dir] }));
  const orch = path.join(HERE, "..", "runtime", "orch.mjs");
  const env = { ...process.env, ORCH_CONFIG: config };

  const found = await run(process.execPath, [orch, "check", "ping"], { env });
  assert.equal(JSON.parse(found.stdout).flow.name, "ping");
  const shipped = await run(process.execPath, [orch, "check", "advisor"], { env });
  assert.equal(JSON.parse(shipped.stdout).flow.name, "advisor");
  await assert.rejects(run(process.execPath, [orch, "check", "nosuch"], { env }), (error) => error.code === 2 && /no flow "nosuch"/.test(error.stderr));
  const byPath = await run(process.execPath, [orch, "check", path.join(dir, "ping.mjs")], { env });
  assert.equal(JSON.parse(byPath.stdout).ok, true);
});

// --- The command line ------------------------------------------------------

test("command line: --run-id and --affair, inline or from a file", async () => {
  const f = advisor;
  const base = await parseRunArgs(f, ["--question", "q", "--role", "fast"]);
  assert.deepEqual(Object.keys(base).sort(), ["cwd", "host", "input", "timeout"], "without them the result is what it was");
  assert.deepEqual(base.input, { question: "q", role: "fast" });

  const inline = await parseRunArgs(f, ["--question", "q", "--role", "fast", "--run-id", "r-1", "--affair", JSON.stringify(FULL)]);
  assert.equal(inline.runId, "r-1");
  assert.deepEqual(inline.affair, FULL);

  const dir = await tmp("cli-affair");
  const file = path.join(dir, "affair.json");
  await writeFile(file, `\uFEFF${JSON.stringify({ label: "from a file" })}`);
  assert.deepEqual((await parseRunArgs(f, ["--affair", `@${file}`])).affair, { label: "from a file" });
  await writeFile(file, "null");
  assert.equal((await parseRunArgs(f, ["--affair", `@${file}`])).affair, null);

  await assert.rejects(parseRunArgs(f, ["--affair", "{label:"]), /--affair: not valid JSON/);
});

test("flows cannot name an input runId or affair: the runner's flags own them", () => {
  for (const name of ["runId", "affair"]) {
    assert.throws(
      () => flow({ name: "x", description: "d", phases: [], inputs: { [name]: { type: "string" } }, grants: [], run: async () => 1 }),
      /collides with the runner's own/,
    );
  }
});

test("command line: a caller-given id is claimed before the flow is read, and a failure after it is on the claim", async () => {
  const dir = await tmp("cli-claim");
  const orch = path.join(HERE, "..", "runtime", "orch.mjs");
  const env = { ...process.env, ORCH_LOG_DIR: dir };
  const failing = (args) => run(process.execPath, [orch, "run", ...args], { env }).then(() => assert.fail("expected exit 2"), (error) => error);
  const refusedOf = async (id) => JSON.parse(await readFile(claimFile(dir, id), "utf8")).refused;

  const missing = await failing(["nosuch", "--run-id", "cli-a"]);
  assert.equal(missing.code, 2);
  assert.match(await refusedOf("cli-a"), /^FlowLookupError: no flow "nosuch"/);

  const badJson = await failing(["advisor", "--question", "q", "--role", "fast", "--affair", "{label:", "--run-id", "cli-b"]);
  assert.equal(badJson.code, 2);
  assert.match(await refusedOf("cli-b"), /--affair: not valid JSON/);

  const badAffair = await failing(["advisor", "--question", "q", "--role", "fast", "--affair", '{"label":""}', "--run-id=cli-c"]);
  assert.equal(badAffair.code, 2);
  assert.match(await refusedOf("cli-c"), /--affair does not fit/);

  const noInput = await failing(["advisor", "--run-id", "cli-d"]);
  assert.equal(noInput.code, 2);
  assert.match(await refusedOf("cli-d"), /question/);

  // The id is spent, and the second try is told why the first one ended.
  const again = await failing(["advisor", "--question", "q", "--role", "fast", "--run-id", "cli-a"]);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already taken.*it was refused: FlowLookupError/s);

  // No id given: nothing is left behind by a refusal.
  const before = await names(dir);
  assert.equal((await failing(["nosuch"])).code, 2);
  assert.deepEqual(await names(dir), before);
  assert.equal((await failing(["advisor", "--question", "q"])).code, 2);
  assert.deepEqual(await names(dir), before);
  assert.ok(before.every((n) => n.endsWith(".claim")) && before.length === 4, before.join(", "));
});

test("flows: the same directory written in another letter case is one directory (Windows, macOS)", { skip: process.platform !== "win32" && process.platform !== "darwin" }, async () => {
  const mine = flowsIn(path.join(await tmp("flows-case"), "Mine"), "triage");
  const other = mine.replace(/Mine$/, "mine");
  assert.equal(resolveFlowFile("triage", [mine, other]).toLowerCase(), path.join(mine, "triage.mjs").toLowerCase());
  const shipped = FLOWS_DIR.replace(/flows$/, "FLOWS");
  assert.equal(resolveFlowFile("advisor", [FLOWS_DIR, shipped]).toLowerCase(), path.join(FLOWS_DIR, "advisor.mjs").toLowerCase());
});
