// What goes wrong around the affair's workspace, and what the run does about it
// (docs/affair-workspace.md, "失败降级" and "失败与限制"): a start that Paseo refuses
// before an agent exists, parallel gates, a lock that fails, directory spellings,
// the title. Same fake daemon as workspaces.test.mjs.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFlow } from "../runtime/run.mjs";
import { flow, define, text } from "../runtime/flow.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { lockIo, normalizeDir, workspaceRefusal, workspaceTitle, workspacesDir } from "../runtime/workspaces.mjs";
import { PaseoCliError } from "../runtime/paseo-cli.mjs";
import { fakeExecutor, refusalError } from "./fake-executor.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const say = define({ name: "say", effects: "none", timeout: "1m", returns: { said: text() }, prompt: () => "Say hi." });
const answer = () => ({ said: "hi" });

const asking = flow({
  name: "asker",
  description: "d",
  phases: [],
  inputs: {},
  grants: [],
  run: async (_, $) => ({ a: await $.ask(say, {}), b: await $.ask(say, {}) }),
});

const gateOnly = flow({
  name: "gate-only",
  description: "d",
  phases: [],
  inputs: {},
  grants: ["gate:deny"],
  run: async (_, $) => $.gate({ title: "批准 a.lua", content: "local x = 1\n", timeout: "1m" }),
});

const AFFAIR = { label: "Release 2.4 · blocked", link: { plugin: "tracker", screen: "case", params: { id: "24" } } };

const freshLogDir = () => mkdtemp(path.join(os.tmpdir(), "orch-wsf-"));

const run = (target, { logDir, ...options }) =>
  runFlow(target, { roster, logDir, cwd: "C:/work", caller: null, gatePollMs: 5, agentProbeDelays: [5], ...options });

const eventsOf = (result) => {
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return events;
};
const workspaceEvents = (result) => eventsOf(result).filter((e) => e.kind === "workspace");
const affairCaveats = (result) => result.caveats.filter((c) => c.startsWith("affair:"));
const affairCaveat = (result, pattern) => affairCaveats(result).find((c) => pattern.test(c));
const cliError = (stderr, exitCode = 1) => new PaseoCliError("paseo run failed", { argv: ["run"], exitCode, stdout: "", stderr });
const FIXTURES = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "paseo-refusals.json"), "utf8")).cases;

// --- F1: Paseo refuses the workspace before it makes the agent -----------------------------------------------

test("workspaceRefusal knows what the real CLI printed, prefix lines and all", () => {
  // Byte for byte from the CLI (test/fixtures/paseo-refusals.json): the JSON error comes after "Using workspace <id>",
  // and for --background after a deprecation warning too. The old reading, JSON.parse of all of stderr, saw none of these.
  for (const name of ["ask-missing", "spawn-missing", "ask-archived"]) {
    assert.ok(!FIXTURES[name].stderr.startsWith("{"), `${name}: a line comes before the JSON`);
    assert.equal(workspaceRefusal(refusalError(name)), "gone", name);
  }
  assert.equal(workspaceRefusal(refusalError("unknown-option")), "flag");
  // The older shapes still hold: the bare JSON, and the parser's line with a warning before it.
  assert.equal(workspaceRefusal(cliError(JSON.stringify({ error: { code: "WORKSPACE_NOT_FOUND", message: "m" } }))), "gone");
  assert.equal(workspaceRefusal(cliError("Warning: --background (-d) is deprecated. Use --no-wait instead.\nerror: unknown option '--workspace'\n")), "flag");
  // The JSON may also have lines after it.
  assert.equal(workspaceRefusal(cliError(`${FIXTURES["ask-missing"].stderr}some trailing line\n`)), "gone");
});

test("workspaceRefusal: only a refusal that came before any agent existed", () => {
  // What is not that: another code, another option, a failure with no exit code (a timeout), anything that is not the CLI's.
  assert.equal(workspaceRefusal(cliError(JSON.stringify({ error: { code: "OUTPUT_SCHEMA_FAILED", message: "m" } }))), null);
  assert.equal(workspaceRefusal(cliError("error: unknown option '--thinking'\n")), null);
  // Words are not codes: a failure that mentions the name (its message, a title, a prompt echoed back) is its own.
  const mentions = "Using workspace wks_0000000000000000\n" + JSON.stringify({ error: { code: "OUTPUT_SCHEMA_FAILED", message: "WORKSPACE_NOT_FOUND in the title of the agent" } }, null, 2) + "\n";
  assert.equal(workspaceRefusal(cliError(mentions)), null);
  assert.equal(workspaceRefusal(cliError("agent 'WORKSPACE_NOT_FOUND report' failed\n")), null);
  assert.equal(workspaceRefusal(cliError("I was told: error: unknown option '--workspace'\n")), null, "the parser's line starts a line");
  assert.equal(workspaceRefusal(cliError(FIXTURES["ask-missing"].stderr, 0)), null, "a zero exit is not a refusal");
  assert.equal(workspaceRefusal(new PaseoCliError("paseo run exceeded 5ms", { argv: ["run"], exitCode: null, stdout: "", stderr: "" })), null);
  assert.equal(workspaceRefusal(new Error("Workspace not found")), null);
  assert.equal(workspaceRefusal(null), null);
});

test("F1: a workspace archived during the run is made again for the next ask, and the run does not fail", async () => {
  const workspaces = [];
  // The person archives it while the first agent works.
  const executor = fakeExecutor({
    answer: () => {
      workspaces.length = 0;
      return { said: "hi" };
    },
    workspaces,
  });
  const result = await run(asking, { logDir: await freshLogDir(), executor, affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.deepEqual(executor.requests.map((r) => r.workspace), ["fake-ws-1", "fake-ws-2"]);
  assert.equal(executor.refused.length, 1, "the second ask was refused once, before it existed");
  assert.deepEqual(workspaceEvents(result).map((e) => [e.workspaceId, e.created]), [["fake-ws-1", true], ["fake-ws-2", true]]);
  assert.match(affairCaveat(result, /refused workspace fake-ws-1 .*the workspace is gone/), /once more in the workspace found or made again/);
});

test("F1: a workspace archived between the listing and the start: the start is made once more, in a new one", async () => {
  const workspaces = [];
  const executor = fakeExecutor({ answer, workspaces, archiveOnStart: true });
  const result = await run(asking, { logDir: await freshLogDir(), executor, affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.equal(executor.refused.length, 1);
  assert.deepEqual(executor.requests.map((r) => r.workspace), ["fake-ws-2", "fake-ws-2"], "both asks end up in the workspace made after the refusal");
  assert.equal(workspaceEvents(result).length, 2);
});

test("F1: a CLI that does not know --workspace: the start is repeated without it, and nothing later asks for one", async () => {
  const executor = fakeExecutor({ answer, workspaces: [], workspaceFlag: false });
  const result = await run(asking, { logDir: await freshLogDir(), executor, affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.equal(executor.refused.length, 1, "refused once, not once per ask");
  assert.equal(executor.requests.length, 2);
  assert.ok(executor.requests.every((r) => r.workspace === undefined));
  assert.match(affairCaveat(result, /does not know --workspace/), /without one/);
});

test("F1: the gate's card start is retried the same way", async () => {
  const gone = fakeExecutor({ answer, carrier: "approve", archiveOnStart: true });
  const archived = await run(gateOnly, { logDir: await freshLogDir(), executor: gone, affair: AFFAIR });
  assert.equal(archived.value.approved, true);
  assert.equal(gone.refused.length, 1);
  assert.equal(gone.requests[0].workspace, "fake-ws-2");

  const old = fakeExecutor({ answer, carrier: "approve", workspaceFlag: false });
  const flagless = await run(gateOnly, { logDir: await freshLogDir(), executor: old, affair: AFFAIR });
  assert.equal(flagless.value.approved, true);
  assert.equal(old.requests[0].workspace, undefined);
  assert.ok(affairCaveat(flagless, /does not know --workspace/));
});

test("F1: any other failure of the start is the call's own and is not repeated", async () => {
  const executor = fakeExecutor({ answer: () => Promise.reject(new Error("the model said no")), workspaces: [] });
  const result = await run(asking, { logDir: await freshLogDir(), executor, affair: AFFAIR });
  assert.equal(result.outcome, "failed");
  assert.equal(executor.requests.length, 1, "one start, no second");
  assert.equal(executor.refused.length, 0);
  assert.equal(affairCaveat(result, /refused/), undefined);
});

test("F1: an ordinary failure whose title and message say WORKSPACE_NOT_FOUND is not a refusal and is not repeated", async () => {
  const titled = flow({
    name: "titled",
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    run: async (_, $) => $.ask(say, {}, { title: "WORKSPACE_NOT_FOUND report" }),
  });
  const failure = cliError("Using workspace fake-ws-1\n" + JSON.stringify({ error: { code: "OUTPUT_SCHEMA_FAILED", message: "WORKSPACE_NOT_FOUND report: no output" } }, null, 2) + "\n");
  const executor = fakeExecutor({ answer: () => Promise.reject(failure), workspaces: [] });
  const result = await run(titled, { logDir: await freshLogDir(), executor, affair: AFFAIR });
  assert.equal(result.outcome, "failed");
  assert.equal(executor.requests.length, 1, "started once");
  assert.equal(executor.refused.length, 0);
  assert.equal(affairCaveat(result, /refused/), undefined);
});

// --- F2: the receipt path is claimed in one synchronous stretch ----------------------------------------------

/** Two gates started together on one receipt path: main refuses the second. */
const twoGatesOnOnePath = (holdPath) =>
  flow({
    name: "two-gates",
    description: "d",
    phases: [],
    inputs: {},
    grants: ["gate:deny"],
    run: async (_, $) =>
      $.all([
        () => $.gate({ title: "first", content: "a\n", holdPath, timeout: "1m" }),
        () => $.gate({ title: "second", content: "b\n", holdPath, timeout: "1m" }),
      ]),
  });

test("F2: two gates at once on one receipt path: the second is refused, with an affair, without, and with a failing workspace", async () => {
  for (const [name, options, executorOptions] of [
    ["no affair", {}, {}],
    ["affair", { affair: AFFAIR }, {}],
    ["affair, workspace failing", { affair: AFFAIR }, { workspaceFails: "create" }],
  ]) {
    const logDir = await freshLogDir();
    const executor = fakeExecutor({ carrier: "approve", ...executorOptions });
    const result = await run(twoGatesOnOnePath(path.join(logDir, "shared.receipt.txt")), { logDir, executor, ...options });
    const [first, second] = result.value;
    assert.equal(first.ok, true, name);
    assert.equal(first.value.approved, true, name);
    assert.equal(second.ok, false, name);
    assert.match(second.error.message, /already another gate's in this run/, name);
    assert.equal(executor.requests.length, 1, `${name}: one card, not two on one receipt`);
  }
});

// --- F3, F4: the lock -----------------------------------------------------------------------------------------

test("F4: a lock whose contents could not be written is not left behind", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const write = lockIo.write;
  lockIo.write = () => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  };
  let failed;
  try {
    failed = await run(asking, { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR });
  } finally {
    lockIo.write = write;
  }
  assert.equal(failed.outcome, "done", "the run degrades");
  assert.ok(affairCaveat(failed, /no shared workspace \(no space left on device\)/));
  assert.deepEqual((await readdir(workspacesDir(logDir))).filter((f) => f.endsWith(".lock")), [], "no lock is left");

  // The disk is back: the next run takes the lock at once instead of waiting for a lock nobody holds.
  const next = await run(asking, { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR, workspaceLock: { waitMs: 40, pollMs: 5 } });
  assert.equal(affairCaveats(next).length, 0);
  assert.equal(workspaceEvents(next)[0].created, true);
});

test("F3/F4: a holder whose lock was taken over does not remove the new holder's lock", async () => {
  const logDir = await freshLogDir();
  const executor = fakeExecutor({ answer, workspaces: [] });
  const made = executor.createWorkspace;
  let lockFile;
  executor.createWorkspace = async (request) => {
    // While this run holds the lock, another run takes it over as stale: its lock, its token, in the same place.
    lockFile = path.join(workspacesDir(logDir), (await readdir(workspacesDir(logDir))).find((f) => f.endsWith(".lock")));
    await writeFile(lockFile, JSON.stringify({ token: "the-new-holder" }), "utf8");
    return made(request);
  };
  const result = await run(asking, { logDir, executor, affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.equal(JSON.parse(await readFile(lockFile, "utf8")).token, "the-new-holder", "not ours any more, so not removed");
});

test("a registry that cannot be read is said, and the workspace is made again", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  await run(asking, { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR });
  const [entry] = await readdir(workspacesDir(logDir));
  await writeFile(path.join(workspacesDir(logDir), entry), '{"workspaceId":', "utf8");

  const result = await run(asking, { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.match(affairCaveat(result, /registry file for this affair could not be read/), /may not have been found/);
  assert.equal(workspaces.length, 2);
});

// --- F6, F7: one spelling of a directory, one title ----------------------------------------------------------

test("F6: one directory under several spellings is one workspace and one event", async () => {
  assert.equal(normalizeDir("C:/work"), normalizeDir("C:/work/./"));
  const spellings = ["C:/work", "C:/work/.", "C:/work/sub/.."];
  if (process.platform === "win32") spellings.push("c:\\WORK");
  const aliases = flow({
    name: "aliases",
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    run: async (_, $) => $.all(spellings.map((cwd) => () => $.ask(say, {}, { cwd }))),
  });
  const workspaces = [];
  const executor = fakeExecutor({ answer, workspaces, workspaceDelayMs: 30 });
  const result = await run(aliases, { logDir: await freshLogDir(), executor, affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.equal(workspaceEvents(result).length, 1);
  assert.equal(workspaces.length, 1);
  assert.equal(new Set(executor.requests.map((r) => r.workspace)).size, 1);
  assert.deepEqual(affairCaveats(result), []);
  // What is shown is the directory as the first call wrote it.
  assert.equal(workspaceEvents(result)[0].cwd, "C:/work");
});

test("F7: the title that is sent, recorded in the event and kept in the registry is one text, cut by code point", async () => {
  const inSub = flow({ name: "in-sub", description: "d", phases: [], inputs: {}, grants: [], run: async (_, $) => $.ask(say, {}, { cwd: "C:/work/sub" }) });
  for (const label of ["x".repeat(120), "𠀀".repeat(120)]) {
    const logDir = await freshLogDir();
    const workspaces = [];
    const result = await run(inSub, { logDir, executor: fakeExecutor({ answer, workspaces }), affair: { ...AFFAIR, label } });
    assert.equal(result.outcome, "done");
    const [event] = workspaceEvents(result);
    assert.equal(event.title, workspaces[0].title, "the executor was sent what the event says");
    assert.equal([...event.title].length, 120);
    assert.ok(event.title.endsWith(" · sub"), "the part that tells two directories apart is not what is cut");
    assert.equal(event.title, event.title.toWellFormed(), "no half of a surrogate pair");
    const [entry] = await readdir(workspacesDir(logDir));
    assert.equal(JSON.parse(await readFile(path.join(workspacesDir(logDir), entry), "utf8")).title, event.title);
  }
  assert.equal(workspaceTitle("Release", "C:/work", "C:/work"), "Release");
});
