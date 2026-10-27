// The affair's shared workspace: found or made once, used by every agent and
// gate card of the runs for that affair, and never the reason a run fails.
// A fake executor stands in for the daemon (its `workspaces` array is the
// daemon's list), so nothing here talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFlow } from "../runtime/run.mjs";
import { flow, define, text } from "../runtime/flow.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { affairKey, workspaceTitle, workspacesDir } from "../runtime/workspaces.mjs";
import { parseAffair } from "../runtime/affair.mjs";
import { fakeExecutor } from "./fake-executor.mjs";

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const say = define({ name: "say", effects: "none", timeout: "1m", returns: { said: text() }, prompt: () => "Say hi." });

const asking = (name = "asker") =>
  flow({
    name,
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    run: async (_, $) => ({ a: await $.ask(say, {}), b: await $.ask(say, {}) }),
  });

/** Calls in parallel, one of them in another directory. */
const asksInTwoDirectories = flow({
  name: "two-dirs",
  description: "d",
  phases: [],
  inputs: {},
  grants: [],
  run: async (_, $) => $.all([() => $.ask(say, {}), () => $.ask(say, {}), () => $.ask(say, {}, { cwd: "C:/work/sub" })]),
});

const gating = flow({
  name: "gating",
  description: "d",
  phases: [],
  inputs: {},
  grants: ["gate:deny"],
  run: async (_, $) => {
    await $.ask(say, {});
    return $.gate({ title: "批准 a.lua", content: "local x = 1\n", timeout: "1m" });
  },
});

const AFFAIR = { label: "Release 2.4 · blocked", link: { plugin: "tracker", screen: "case", params: { id: "24" } } };

async function freshLogDir() {
  return mkdtemp(path.join(os.tmpdir(), "orch-ws-"));
}

const run = (target, { logDir, ...options }) =>
  runFlow(target, { roster, logDir, cwd: "C:/work", caller: null, gatePollMs: 5, agentProbeDelays: [5], ...options });

const eventsOf = (result) => {
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return events;
};
/** The caveats about the workspace; the fence's own (an unenforced "none") are not this file's business. */
const affairCaveats = (result) => result.caveats.filter((c) => c.startsWith("affair:"));
const workspaceEvents = (result) => eventsOf(result).filter((e) => e.kind === "workspace");

test("affairKey: the caller's key, else the link, else the url, else none -- never the label", () => {
  assert.equal(affairKey(null), null);
  assert.equal(affairKey({ label: "same words" }), null);
  assert.equal(affairKey({ label: "x", key: "release-24", link: AFFAIR.link }), "key:release-24");
  assert.equal(affairKey({ label: "x", url: "https://example.com/r/24" }), "url:https://example.com/r/24");
  // The link: params in any order are the same item, another param or screen is another.
  const link = (params, screen = "case") => affairKey({ label: "x", link: { plugin: "tracker", screen, params } });
  assert.equal(link({ id: "24", stage: "2" }), link({ stage: "2", id: "24" }));
  assert.notEqual(link({ id: "24" }), link({ id: "25" }));
  assert.notEqual(link({ id: "24" }), link({ id: "24" }, "other"));
  assert.notEqual(link({ id: "24" }), link({ id: "24", stage: "2" }));
  assert.notEqual(affairKey({ label: "x", url: "https://example.com/a" }), affairKey({ label: "x", key: "https://example.com/a" }));
});

test("workspaceTitle: the label, and for another directory its name after it", () => {
  assert.equal(workspaceTitle("Release 2.4", "C:/work", "C:\\work"), "Release 2.4");
  assert.equal(workspaceTitle("Release 2.4", "C:/work/sub", "C:/work"), "Release 2.4 · sub");
});

test("affair.key: optional, bounded text, and parseAffair keeps it", () => {
  assert.deepEqual(parseAffair({ label: "x", key: "release-24" }), { label: "x", key: "release-24" });
  assert.throws(() => parseAffair({ label: "x", key: "" }), /affair\.key must not be empty/);
  assert.throws(() => parseAffair({ label: "x", key: 24 }), /affair\.key must be a string/);
  assert.throws(() => parseAffair({ label: "x", key: "a".repeat(257) }), /affair\.key is longer than 256/);
  assert.throws(() => parseAffair({ label: "x", key: "a\nb" }), /affair\.key has a control/);
});

test("a run with an affair: one workspace, titled with the label, every agent in it, one event", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), workspaces });
  const result = await run(asking(), { logDir, executor, affair: AFFAIR });

  assert.equal(result.outcome, "done");
  assert.deepEqual(affairCaveats(result), []);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].title, "Release 2.4 · blocked");
  assert.equal(workspaces[0].cwd, "C:/work");
  assert.deepEqual(executor.requests.map((r) => r.workspace), [workspaces[0].workspaceId, workspaces[0].workspaceId]);

  const found = workspaceEvents(result);
  assert.equal(found.length, 1, "the event is once per directory, not once per call");
  assert.deepEqual(
    { workspaceId: found[0].workspaceId, cwd: found[0].cwd, title: found[0].title, created: found[0].created, key: found[0].key },
    { workspaceId: workspaces[0].workspaceId, cwd: "C:/work", title: "Release 2.4 · blocked", created: true, key: affairKey(AFFAIR) },
  );
  // It comes before the first call it was for.
  const events = eventsOf(result);
  assert.ok(events.findIndex((e) => e.kind === "workspace") < events.findIndex((e) => e.kind === "call.start"));
});

test("a second run of the same affair reuses the workspace, even by another flow", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const first = await run(asking("one"), { logDir, executor: fakeExecutor({ answer: () => ({ said: "hi" }), workspaces }), affair: AFFAIR });
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), workspaces });
  const second = await run(asking("two"), { logDir, executor, affair: AFFAIR });

  assert.equal(workspaces.length, 1, "only the first run made one");
  assert.equal(workspaceEvents(first)[0].created, true);
  const again = workspaceEvents(second)[0];
  assert.equal(again.created, false);
  assert.equal(again.workspaceId, workspaces[0].workspaceId);
  assert.equal(executor.requests[0].workspace, workspaces[0].workspaceId);
});

test("another affair, or the same one in another directory, is another workspace", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const answer = () => ({ said: "hi" });
  await run(asking(), { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR });
  await run(asking(), { logDir, executor: fakeExecutor({ answer, workspaces }), affair: { label: "Release 2.5", link: { plugin: "tracker", screen: "case", params: { id: "25" } } } });
  assert.equal(workspaces.length, 2);

  // Same affair, three calls, one of them in another directory: two workspaces, and each call in its own.
  const executor = fakeExecutor({ answer, workspaces: [] });
  const result = await run(asksInTwoDirectories, { logDir: await freshLogDir(), executor, affair: AFFAIR });
  assert.equal(result.outcome, "done");
  const made = executor.requests.map((r) => ({ cwd: r.cwd, workspace: r.workspace }));
  assert.equal(new Set(made.map((m) => m.workspace)).size, 2);
  assert.equal(made.find((m) => m.cwd === "C:/work/sub").workspace, "fake-ws-2");
  assert.equal(made.filter((m) => m.workspace === "fake-ws-1").length, 2, "calls in one directory share a workspace");
  assert.deepEqual(
    workspaceEvents(result).map((e) => [e.cwd, e.title]),
    [["C:/work", "Release 2.4 · blocked"], ["C:/work/sub", "Release 2.4 · blocked · sub"]],
  );
});

test("a workspace the person archived is made again; one they renamed is still found", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const answer = () => ({ said: "hi" });
  await run(asking(), { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR });

  workspaces[0].title = "my own name for it";
  const renamed = await run(asking(), { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR });
  assert.equal(workspaceEvents(renamed)[0].created, false);
  assert.equal(workspaces.length, 1);

  workspaces.length = 0; // archived: no longer in the daemon's list
  const archived = await run(asking(), { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR });
  assert.equal(workspaceEvents(archived)[0].created, true);
  assert.equal(workspaces.length, 1);
  const [entry] = await readdir(workspacesDir(logDir));
  assert.equal(JSON.parse(await readFile(path.join(workspacesDir(logDir), entry), "utf8")).workspaceId, workspaces[0].workspaceId, "the registry follows");
});

test("no affair: nothing is listed, made or passed, and the events are as they were", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), workspaces });
  const result = await run(asking(), { logDir, executor });
  assert.equal(result.outcome, "done");
  assert.deepEqual(affairCaveats(result), []);
  assert.equal(workspaces.length, 0);
  assert.ok(executor.requests.every((r) => r.workspace === undefined));
  assert.equal(eventsOf(result).filter((e) => e.kind === "workspace").length, 0);
  assert.equal(existsSync(workspacesDir(logDir)), false);
});

test("an affair that cannot tell itself from another: no workspace, a caveat, the run goes on", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), workspaces });
  const result = await run(asking(), { logDir, executor, affair: { label: "just words" } });
  assert.equal(result.outcome, "done");
  assert.equal(workspaces.length, 0);
  assert.ok(executor.requests.every((r) => r.workspace === undefined));
  assert.equal(affairCaveats(result).length, 1);
  assert.match(affairCaveats(result)[0], /no key, link or url/);
  eventsOf(result);
});

test("the daemon cannot make a workspace: a caveat, agents as before, the run succeeds", async () => {
  for (const [failing, verb] of [["create", "create"], ["list", "ls"]]) {
    const logDir = await freshLogDir();
    const workspaces = [];
    const answer = () => ({ said: "hi" });
    if (failing === "list") await run(asking(), { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR });
    const executor = fakeExecutor({ answer, workspaces: failing === "list" ? workspaces : [], workspaceFails: failing });
    const result = await run(asking(), { logDir: failing === "list" ? logDir : await freshLogDir(), executor, affair: AFFAIR });
    assert.equal(result.outcome, "done", failing);
    assert.equal(executor.requests.length, 2, failing);
    assert.ok(executor.requests.every((r) => r.workspace === undefined), failing);
    assert.equal(affairCaveats(result).length, 1, failing);
    assert.match(affairCaveats(result)[0], new RegExp(`no shared workspace \\(fake failure of workspace ${verb}\\)`), failing);
    eventsOf(result);
  }
});

test("an executor that has no workspaces at all is a caveat, not a crash", async () => {
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }) });
  delete executor.listWorkspaces;
  const result = await run(asking(), { logDir: await freshLogDir(), executor, affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.match(affairCaveats(result)[0], /cannot list or make workspaces/);
});

test("two runs of one affair at once make one workspace, in one process and in the lock's way", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const executors = [0, 1, 2].map(() => fakeExecutor({ answer: () => ({ said: "hi" }), workspaces, workspaceDelayMs: 40 }));
  const results = await Promise.all(executors.map((executor) => run(asking(), { logDir, executor, affair: AFFAIR, workspaceLock: { pollMs: 5 } })));
  assert.ok(results.every((r) => r.outcome === "done" && affairCaveats(r).length === 0));
  assert.equal(workspaces.length, 1, "three runs, one workspace");
  assert.deepEqual(results.map((r) => workspaceEvents(r)[0].created).sort(), [false, false, true]);
  assert.ok(executors.every((e) => e.requests.every((r) => r.workspace === workspaces[0].workspaceId)));
  assert.deepEqual((await readdir(workspacesDir(logDir))).filter((f) => f.endsWith(".lock")), [], "the lock is released");
});

test("a lock that stays taken is given up on: no workspace, a caveat, and none is made behind its back", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  // Run once to learn the file's name, then hold its lock.
  await run(asking(), { logDir, executor: fakeExecutor({ answer: () => ({ said: "hi" }), workspaces }), affair: AFFAIR });
  const [entry] = await readdir(workspacesDir(logDir));
  await writeFile(path.join(workspacesDir(logDir), `${entry}.lock`), "{}", "utf8");
  workspaces.length = 0;

  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), workspaces });
  const result = await run(asking(), { logDir, executor, affair: AFFAIR, workspaceLock: { waitMs: 60, staleMs: 60_000, pollMs: 10 } });
  assert.equal(result.outcome, "done");
  assert.equal(workspaces.length, 0);
  assert.match(affairCaveats(result)[0], /no shared workspace \(another run has held .+\.lock for/);
});

test("a lock left by a process that died is taken over", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const answer = () => ({ said: "hi" });
  await run(asking(), { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR });
  const [entry] = await readdir(workspacesDir(logDir));
  await writeFile(path.join(workspacesDir(logDir), `${entry}.lock`), "{}", "utf8");

  const result = await run(asking(), { logDir, executor: fakeExecutor({ answer, workspaces }), affair: AFFAIR, workspaceLock: { waitMs: 2_000, staleMs: 0, pollMs: 10 } });
  assert.equal(affairCaveats(result).length, 0);
  assert.equal(workspaceEvents(result)[0].created, false);
});

test("a registry that cannot be written still gives the run its workspace, and says the next run will not find it", async () => {
  const logDir = await freshLogDir();
  // A directory where the registry file would go makes the rename fail.
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), workspaces: [] });
  const original = executor.createWorkspace;
  executor.createWorkspace = async (request) => {
    const made = await original(request);
    for (const lock of await readdir(workspacesDir(logDir))) {
      await mkdir(path.join(workspacesDir(logDir), lock.replace(/\.lock$/, "")), { recursive: true });
    }
    return made;
  };
  const result = await run(asking(), { logDir, executor, affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.equal(executor.requests[0].workspace, "fake-ws-1");
  assert.match(affairCaveats(result)[0], /made but not recorded/);
});

test("a run on another host keeps things as they were, and says so", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), workspaces });
  const result = await run(asking(), { logDir, executor, affair: AFFAIR, host: "ssh://mac", cwd: "/Users/me" });
  assert.equal(result.outcome, "done");
  assert.equal(workspaces.length, 0);
  assert.ok(executor.requests.every((r) => r.workspace === undefined));
  assert.match(affairCaveats(result)[0], /another host \(ssh:\/\/mac\)/);
});

test("the gate's card goes in the same workspace as the run's agents", async () => {
  const logDir = await freshLogDir();
  const workspaces = [];
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), workspaces, carrier: "approve" });
  const result = await run(gating, { logDir, executor, affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.equal(result.value.approved, true);
  assert.equal(workspaces.length, 1, "the ask and the card share one");
  const [ask, card] = executor.requests;
  assert.equal(ask.workspace, workspaces[0].workspaceId);
  assert.equal(card.labels["orch-step"], "gate");
  assert.equal(card.workspace, workspaces[0].workspaceId);
  assert.match(card.cwd, /gate$/, "the card still asks for the directory it used to; Paseo puts it in the workspace's");
});

test("a gate with no affair has no workspace either; one whose workspace failed still gates", async () => {
  const plain = fakeExecutor({ answer: () => ({ said: "hi" }), carrier: "approve" });
  const noAffair = await run(gating, { logDir: await freshLogDir(), executor: plain });
  assert.equal(noAffair.value.approved, true);
  assert.ok(plain.requests.every((r) => r.workspace === undefined));

  const broken = fakeExecutor({ answer: () => ({ said: "hi" }), carrier: "approve", workspaceFails: "create" });
  const degraded = await run(gating, { logDir: await freshLogDir(), executor: broken, affair: AFFAIR });
  assert.equal(degraded.value.approved, true);
  assert.equal(affairCaveats(degraded).length, 1, "one caveat for the one directory, not one per call");
});

test("a model carrier is left where it was", async () => {
  const workspaces = [];
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), workspaces, carrier: "approve" });
  const modelGate = { ...roster, roles: { ...roster.roles, gate: roster.roles.fast } };
  const result = await runFlow(gating, { roster: modelGate, logDir: await freshLogDir(), cwd: "C:/work", caller: null, gatePollMs: 5, agentProbeDelays: [5], executor, affair: AFFAIR });
  assert.equal(result.value.approved, true);
  const card = executor.requests.find((r) => r.labels["orch-step"] === "gate");
  assert.equal(card.workspace, undefined);
});

test("a run whose flow never calls an agent makes no workspace", async () => {
  const workspaces = [];
  const quiet = flow({ name: "quiet", description: "d", phases: [], inputs: {}, grants: [], run: async (_, $) => $.do("nothing", () => 1) });
  const result = await run(quiet, { logDir: await freshLogDir(), executor: fakeExecutor({ workspaces }), affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.equal(workspaces.length, 0);
});
