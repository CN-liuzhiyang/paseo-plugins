// `$.ask(..., { archive: "after" })`: the agent of a call that came out well is archived once it has handed in its answer, and never
// the reason a run fails; a call that failed keeps its agent. And what the Paseo executor sends for it, and for the affair's workspace
// (made in the background). A fake executor stands in for the daemon, so nothing here talks to Paseo.
//
//   node --test test/archive.test.mjs        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { runFlow } from "../runtime/run.mjs";
import { flow, define, text } from "../runtime/flow.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { paseoExecutor } from "../runtime/executor.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import itemGlance from "../flows/item-glance.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const say = define({ name: "say", effects: "none", timeout: "1m", returns: { said: text() }, prompt: () => "Say hi." });

/** A flow of one ask, with these call options. */
const asking = (options) =>
  flow({ name: "asker", description: "d", phases: [], inputs: {}, grants: [], run: async (_, $) => $.ask(say, {}, options) });

const AFFAIR = { label: "Matter D1", key: "matter-d1" };
const run = async (target, executor, options = {}) => {
  const logDir = await tempDir("orch-archive-");
  return runFlow(target, { roster, logDir, cwd: "C:/work", caller: null, agentProbeDelays: [5], executor, ...options });
};
const archiveCaveats = (result) => result.caveats.filter((c) => c.startsWith("archive:"));
const eventsOf = (result) => {
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return events;
};

test("archive: \"after\": the agent of a call that came out well is archived once it has handed in its answer, and the run says nothing about it", async () => {
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }) });
  const result = await run(asking({ archive: "after" }), executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, { said: "hi" });
  assert.deepEqual(executor.archivedAgents, ["fake-agent-1"]);
  assert.deepEqual(archiveCaveats(result), []);
  const events = eventsOf(result);
  const end = events.find((e) => e.kind === "call.end");
  assert.equal(end.ok, true);
  assert.equal(end.agentId, "fake-agent-1", "its agent is in the record all the same: the record is where it is looked at");
  assert.ok(events.findIndex((e) => e.kind === "call.end") < events.findIndex((e) => e.kind === "run.end"));
});

test("without the option the agent is left for a person to archive", async () => {
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }) });
  const result = await run(asking({}), executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(executor.archivedAgents, []);
});

test("a call that failed keeps its agent: not archived when the call throws, nor when its answer does not fit the schema", async () => {
  const threw = fakeExecutor({
    answer: () => {
      throw new Error("the agent failed");
    },
  });
  const a = await run(asking({ archive: "after" }), threw);
  assert.equal(a.outcome, "failed");
  assert.match(a.error?.message ?? String(a.error), /the agent failed/);
  assert.deepEqual(threw.archivedAgents, [], "it is kept to be looked into");

  const misfit = fakeExecutor({ answer: () => ({ other: 1 }) });
  const b = await run(asking({ archive: "after" }), misfit);
  assert.equal(b.outcome, "failed");
  assert.deepEqual(misfit.archivedAgents, [], "a wrong answer keeps its agent too");
});

test("an agent that is still running is not archived (the CLI refuses it without --force), the run still comes out well, and a caveat says so", async () => {
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), archiveFails: "refuse" });
  const result = await run(asking({ archive: "after" }), executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, { said: "hi" });
  assert.deepEqual(executor.archivedAgents, []);
  const [caveat] = archiveCaveats(result);
  assert.match(caveat, /^archive: agent fake-agent-1 of c1 was not archived \(.*still running/);
  assert.equal(archiveCaveats(result).length, 1);
});

test("what the CLI said, as it said it (a JSON error): a running agent in its words; an agent it cannot find in a background workspace with the reason, measured on the fork CLI", async () => {
  const fail = (code, message) => async function archiveAgent() {
    throw Object.assign(new Error("paseo archive failed"), { stderr: JSON.stringify({ error: { code, message, details: "…" } }, null, 2) });
  };
  const running = fakeExecutor({ answer: () => ({ said: "hi" }) });
  running.archiveAgent = fail("AGENT_RUNNING", "Agent fake-ag is currently running");
  const a = await run(asking({ archive: "after" }), running);
  assert.equal(a.outcome, "done");
  assert.match(archiveCaveats(a)[0], /^archive: agent fake-agent-1 of c1 was not archived \(Agent fake-ag is currently running\)$/);

  const hidden = fakeExecutor({ answer: () => ({ said: "hi" }) });
  hidden.archiveAgent = fail("AGENT_NOT_FOUND", "Agent not found: fake-agent-1");
  const b = await run(asking({ archive: "after" }), hidden, { affair: AFFAIR });
  assert.equal(b.outcome, "done", "and the run is whole all the same");
  assert.match(archiveCaveats(b)[0], /was not archived \(Agent not found: fake-agent-1\); the agent exists, but this CLI's archive does not list the agents of a background workspace/);
});

test("any other failure of the archive is a caveat too, never a failed run", async () => {
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), archiveFails: "error" });
  const result = await run(asking({ archive: "after" }), executor);
  assert.equal(result.outcome, "done");
  assert.match(archiveCaveats(result)[0] ?? "", /was not archived \(fake failure of archive\)/);
});

test("an agent the runner could not find is not archived, and says so; an executor that cannot archive says so once", async () => {
  const lost = fakeExecutor({ answer: () => ({ said: "hi" }) });
  lost.findAgent = async () => null;
  const a = await run(asking({ archive: "after" }), lost);
  assert.equal(a.outcome, "done");
  assert.match(archiveCaveats(a)[0] ?? "", /^archive: the agent of c1 could not be found, so it was not archived$/);

  const plain = fakeExecutor({ answer: () => ({ said: "hi" }) });
  delete plain.archiveAgent;
  const twice = flow({ name: "twice", description: "d", phases: [], inputs: {}, grants: [], run: async (_, $) => ({ a: await $.ask(say, {}, { archive: "after" }), b: await $.ask(say, {}, { archive: "after" }) }) });
  const b = await run(twice, plain);
  assert.equal(b.outcome, "done");
  assert.equal(archiveCaveats(b).length, 1, "one caveat for the same thing, as caveats are");
  assert.match(archiveCaveats(b)[0], /cannot archive an agent/);
});

test("archive takes \"after\" and nothing else: the run fails before an agent is started", async () => {
  for (const wrong of ["before", true, "", null]) {
    const executor = fakeExecutor({ answer: () => ({ said: "hi" }) });
    const result = await run(asking({ archive: wrong }), executor);
    assert.equal(result.outcome, "failed", JSON.stringify(wrong));
    assert.equal(executor.requests.length, 0, "nothing was spent");
    assert.match(result.error?.message ?? String(result.error), /archive can only be "after"/);
  }
});

test("parallel asks: each archives its own agent", async () => {
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }), delayMs: 5 });
  const both = flow({
    name: "both",
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    run: async (_, $) => $.all([() => $.ask(say, {}, { archive: "after" }), () => $.ask(say, {}), () => $.ask(say, {}, { archive: "after" })]),
  });
  const result = await run(both, executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual([...executor.archivedAgents].sort(), ["fake-agent-1", "fake-agent-3"], "the one without the option is left");
});

// ---- the look ("item-glance") -----------------------------------------------------------------------------------------

const INPUT = {
  id: "D3",
  title: "年度体检",
  said: "帮我盯一下体检，月底前要约上",
  domain: "personal",
  n: 1,
  why: "first",
  now: "2026-10-28 周三 17:47",
  tz: "Asia/Shanghai",
  status: "",
  log: [],
  askQuestion: "",
  askOptions: [],
  askAt: "",
  answers: [],
  notes: [],
  minLookMinutes: 60,
  maxLookDays: 14,
  hint: "",
  workdir: "",
};
const PROPOSAL = { status: "任务没完成", looked: "读了任务", nextLook: "2026-11-02 18:30", nextWhy: "过几天", question: "", options: [], finished: "no", finishedWhy: "" };

test("a look that came out well is archived, in the matter's workspace: that is the one place its agent would otherwise pile up", async () => {
  const workspaces = [];
  const executor = fakeExecutor({ answer: () => PROPOSAL, workspaces });
  const result = await run(itemGlance, executor, { input: INPUT, affair: AFFAIR });
  assert.equal(result.outcome, "done");
  assert.equal(workspaces.length, 1);
  assert.equal(executor.requests[0].workspace, workspaces[0].workspaceId);
  assert.deepEqual(executor.archivedAgents, ["fake-agent-1"]);
});

test("a look that failed is not archived", async () => {
  const executor = fakeExecutor({
    answer: () => {
      throw new Error("the look failed");
    },
  });
  const result = await run(itemGlance, executor, { input: INPUT, affair: AFFAIR });
  assert.equal(result.outcome, "failed");
  assert.deepEqual(executor.archivedAgents, []);
});

// ---- what the Paseo executor sends --------------------------------------------------------------------------------------

/** paseoExecutor over a recorder in place of the CLI. */
function recorded(answers = {}) {
  const calls = [];
  const json = async (args, options) => {
    calls.push({ args, options });
    const key = args[0] === "workspace" ? `workspace ${args[1]}` : args[0];
    return Object.hasOwn(answers, key) ? answers[key] : {};
  };
  return { calls, executor: paseoExecutor({ cli: { runPaseoJson: json, runPaseo: async () => ({ stdout: "" }) } }) };
}

test("the affair's workspace is made in the background (and the listing includes the hidden ones, so it is found again)", async () => {
  const { calls, executor } = recorded({ "workspace create": { workspaceId: "wks_1" }, "workspace ls": [{ workspaceId: "wks_1", name: "Matter D1", cwd: "C:/work", background: true }] });
  assert.deepEqual(await executor.createWorkspace({ cwd: "C:/work", title: "Matter D1" }), { workspaceId: "wks_1" });
  const create = calls[0].args;
  assert.deepEqual(create.slice(0, 2), ["workspace", "create"]);
  assert.ok(create.includes("--background"));
  assert.ok(!create.includes("--no-background"), "not the visible one it used to be");
  assert.equal(create[create.indexOf("--title") + 1], "Matter D1");
  assert.deepEqual(await executor.listWorkspaces(), [{ workspaceId: "wks_1", name: "Matter D1", cwd: "C:/work" }]);
  assert.deepEqual(calls[1].args, ["workspace", "ls", "--background"]);
});

test("an agent is archived with `paseo archive <id>`, never forced: a running one is refused, not interrupted", async () => {
  const { calls, executor } = recorded();
  await executor.archiveAgent("agent-7");
  assert.deepEqual(calls[0].args, ["archive", "agent-7"]);
  assert.ok(!calls[0].args.includes("--force"));
});

// ---- the record of an archive: call.archive -------------------------------------------------------------------------------

const archiveEvents = (events) => events.filter((e) => e.kind === "call.archive");

test("every try to archive is written down: call.start says it was asked for, call.archive says whether it was done", async () => {
  const done = await run(asking({ archive: "after" }), fakeExecutor({ answer: () => ({ said: "hi" }) }));
  const events = eventsOf(done);
  assert.equal(events.find((e) => e.kind === "call.start").archive, "after");
  const [archived] = archiveEvents(events);
  assert.equal(archiveEvents(events).length, 1);
  assert.deepEqual({ callId: archived.callId, agentId: archived.agentId, ok: archived.ok, code: archived.code, message: archived.message }, { callId: "c1", agentId: "fake-agent-1", ok: true, code: null, message: null });
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.indexOf("call.end") < kinds.indexOf("call.archive") && kinds.indexOf("call.archive") < kinds.indexOf("run.end"));

  const plain = await run(asking({}), fakeExecutor({ answer: () => ({ said: "hi" }) }));
  const plainEvents = eventsOf(plain);
  assert.equal(plainEvents.find((e) => e.kind === "call.start").archive, null, "a call that did not ask says so");
  assert.deepEqual(archiveEvents(plainEvents), []);

  const failed = await run(asking({ archive: "after" }), fakeExecutor({ answer: () => { throw new Error("the agent failed"); } }));
  assert.deepEqual(archiveEvents(eventsOf(failed)), [], "a call that failed keeps its agent and has no archive to tell of");
});

test("an archive that was not done says why in a field of its own, not only in the caveat: what the CLI answered, or what the runtime found", async () => {
  const fail = (code, message) => async function archiveAgent() {
    throw Object.assign(new Error("paseo archive failed"), { stderr: JSON.stringify({ error: { code, message } }) });
  };
  const notDone = async (executor, options = {}) => {
    const result = await run(asking({ archive: "after" }), executor, options);
    assert.equal(result.outcome, "done");
    const [event, ...rest] = archiveEvents(eventsOf(result));
    assert.deepEqual(rest, []);
    return event;
  };

  const hidden = fakeExecutor({ answer: () => ({ said: "hi" }) });
  hidden.archiveAgent = fail("AGENT_NOT_FOUND", "Agent not found: fake-agent-1");
  const a = await notDone(hidden, { affair: AFFAIR });
  assert.deepEqual({ agentId: a.agentId, ok: a.ok, code: a.code, message: a.message }, { agentId: "fake-agent-1", ok: false, code: "AGENT_NOT_FOUND", message: "Agent not found: fake-agent-1" });

  const running = fakeExecutor({ answer: () => ({ said: "hi" }), archiveFails: "refuse" });
  const b = await notDone(running);
  assert.equal(b.code, "ERROR", "a CLI that gave no code");
  assert.match(b.message, /still running/);

  const other = fakeExecutor({ answer: () => ({ said: "hi" }), archiveFails: "error" });
  assert.deepEqual([(await notDone(other)).ok, (await notDone(other)).message], [false, "fake failure of archive"]);

  const lost = fakeExecutor({ answer: () => ({ said: "hi" }) });
  lost.findAgent = async () => null;
  const c = await notDone(lost);
  assert.deepEqual({ agentId: c.agentId, ok: c.ok, code: c.code, message: c.message }, { agentId: null, ok: false, code: "NO_AGENT", message: null });

  const plain = fakeExecutor({ answer: () => ({ said: "hi" }) });
  delete plain.archiveAgent;
  const d = await notDone(plain);
  assert.deepEqual({ agentId: d.agentId, ok: d.ok, code: d.code }, { agentId: "fake-agent-1", ok: false, code: "NO_ARCHIVE" });
});

test("the caveat on an agent the CLI cannot find in a background workspace says it is left to the plugin that started the run", async () => {
  const hidden = fakeExecutor({ answer: () => ({ said: "hi" }) });
  hidden.archiveAgent = async () => {
    throw Object.assign(new Error("paseo archive failed"), { stderr: JSON.stringify({ error: { code: "AGENT_NOT_FOUND", message: "Agent not found: fake-agent-1" } }) });
  };
  const result = await run(asking({ archive: "after" }), hidden, { affair: AFFAIR });
  assert.match(archiveCaveats(result)[0], /left to the plugin that started the run to archive \(call\.archive says it was not done\)$/);
});

test("checkEvents holds call.archive to the contract: only for a call that asked, that came out well, once, after its call.end", async () => {
  const result = await run(asking({ archive: "after" }), fakeExecutor({ answer: () => ({ said: "hi" }) }));
  const events = eventsOf(result);
  const at = events.findIndex((e) => e.kind === "call.archive");
  const renumber = (list) => list.map((e, i) => ({ ...e, seq: i }));
  const check = (list) => checkEvents(renumber(list), { strict: true, complete: true }).join("\n");
  const archive = events[at];

  assert.equal(check(events), "");
  assert.match(check([...events.slice(0, at), archive, ...events.slice(at)]), /second call\.archive for this call/);
  const endAt = events.findIndex((e) => e.kind === "call.end");
  const before = [...events.slice(0, endAt), archive, ...events.slice(endAt, at), ...events.slice(at + 1)];
  assert.match(check(before), /no call\.end, or whose call\.end is not ok/);
  assert.match(check(events.map((e) => (e.kind === "call.start" ? { ...e, archive: null } : e))), /did not ask for archive/);
  assert.match(check(events.map((e) => (e.kind === "call.end" ? { ...e, ok: false, output: null, error: { name: "Error", message: "x" } } : e))), /whose call\.end is not ok/);
  assert.match(check(events.map((e) => (e.kind === "call.archive" ? { ...e, ok: true, code: "ERROR" } : e))), /ok and code disagree/);
  assert.match(check(events.map((e) => (e.kind === "call.archive" ? { ...e, ok: false, code: null } : e))), /ok and code disagree/);
  assert.match(check(events.map((e) => (e.kind === "call.archive" ? { ...e, agentId: 7 } : e))), /agentId is not string \| null/);
  assert.match(check(events.map((e) => (e.kind === "call.start" ? { ...e, archive: "now" } : e))), /archive is not null \| "after"/);
  // A file from before the field: a reader of old files is not bothered, the runtime's own output is held to it.
  const old = events.filter((e) => e.kind !== "call.archive").map(({ archive, ...e }) => e);
  assert.equal(checkEvents(renumber(old), { complete: true }).join("\n"), "");
  assert.match(checkEvents(renumber(old), { strict: true, complete: true }).join("\n"), /archive is missing/);
});
