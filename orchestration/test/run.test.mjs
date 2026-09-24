// The runner end to end on a fake executor: flows run, events come out, and
// the events conform to EVENTS.md. Nothing here talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFlow, RunRefused } from "../runtime/run.mjs";
import { flow, define, text, count, flag, list, choice, checkFlow, scanSource } from "../runtime/flow.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { fenceFor } from "../runtime/fences.mjs";
import { parseRunArgs } from "../runtime/orch.mjs";
import committee from "../flows/committee.mjs";
import advisor from "../flows/advisor.mjs";
import { fakeExecutor, committeeAnswers } from "./fake-executor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let roster;
let logDir;

before(async () => {
  // Shipped roles only: a private rolesDirs entry must not change what these test.
  roster = await loadRoster([ROLES_DIR]);
  logDir = await mkdtemp(path.join(os.tmpdir(), "orch-test-"));
});

const run = (target, options) =>
  runFlow(target, { roster, logDir, cwd: "C:/work", caller: null, gatePollMs: 5, agentProbeDelays: [5, 10, 20], ...options });

/** Events of a finished run, checked against the contract. */
function eventsOf(result) {
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return events;
}

const kinds = (events) =>
  events
    .filter((e) => e.kind !== "call.agent")
    .map((e) => (e.kind.startsWith("call.") ? `${e.kind}:${e.callId}` : e.kind.startsWith("phase.") ? `${e.kind}:${e.phase}` : e.kind));

const COMMITTEE_INPUT = { question: "Why does the cache miss?", committee: "cheap", rounds: 3, assessor: "worker" };

test("committee: two rounds, converges, every event in the contract", async () => {
  const executor = fakeExecutor({ answer: committeeAnswers({ convergeAt: 2 }), delayMs: 60 });
  const result = await run(committee, { input: COMMITTEE_INPUT, executor });

  assert.equal(result.outcome, "done");
  assert.equal(result.ok, true);
  assert.equal(result.value.rounds, 2);
  assert.equal(result.value.converged, true);
  assert.equal(result.value.contrastingFamilies, true);
  assert.equal(result.value.failures, null);

  const events = eventsOf(result);
  assert.equal(events[0].kind, "run.start");
  assert.equal(events.at(-1).kind, "run.end");
  // Round 1 analyzes in the analyze phase; each debate round is its own entry.
  const phases = events.filter((e) => e.kind.startsWith("phase.")).map((e) => `${e.kind}:${e.phase}`);
  assert.deepEqual(phases, ["phase.start:analyze", "phase.end:analyze", "phase.start:debate", "phase.end:debate", "phase.start:debate", "phase.end:debate"]);

  const starts = events.filter((e) => e.kind === "call.start");
  assert.deepEqual(starts.map((e) => `${e.name}@${e.phase}`), [
    "analyze@analyze", "analyze@analyze", "assess@debate", "respond@debate", "respond@debate", "assess@debate",
  ]);
  for (const start of starts) {
    assert.equal(start.type, "ask");
    assert.equal(start.effects, "none");
    assert.equal(start.fence.enforced, false);
    assert.ok(start.prompt.endsWith("Everything you produce goes in your answer."), "the none suffix is in the prompt as sent");
  }
  // Every call ended with its agent and its cost; the run sums them.
  const ends = events.filter((e) => e.kind === "call.end");
  assert.equal(ends.length, 6);
  for (const end of ends) {
    assert.equal(end.ok, true);
    assert.match(end.agentId, /^fake-agent-/);
    assert.deepEqual(end.cost, { usd: 0.01, inputTokens: 1200, outputTokens: 300 });
  }
  // Each call's agent was announced while the call ran, once, and matches call.end.
  for (const end of ends) {
    const announced = events.filter((e) => e.kind === "call.agent" && e.callId === end.callId);
    assert.equal(announced.length, 1, end.callId);
    assert.ok(announced[0].seq < end.seq, `${end.callId}: call.agent comes before call.end`);
    assert.equal(announced[0].agentId, end.agentId);
  }
  assert.equal(events[0].pid, process.pid);
  assert.equal(events[0].hostname, os.hostname());
  assert.equal(result.cost.agentCount, 6);
  assert.ok(Math.abs(result.cost.totalUsd - 0.06) < 1e-9);
  // Unenforced effects are said once per provider family.
  assert.deepEqual(result.caveats.map((c) => c.split(" is not enforced")[0]), ['effects "none" on claude', 'effects "none" on codex']);
  assert.deepEqual(events.at(-1).caveats, result.caveats);

  // Modes came from the fence table, not from the flow.
  const modes = executor.requests.map((r) => `${r.provider.split("/")[0]}:${r.mode}`);
  assert.ok(modes.every((m) => m === "claude:auto" || m === "codex:auto"), modes.join(", "));
  // Each agent carries the labels its call is found by.
  for (const request of executor.requests) {
    assert.equal(request.labels["orch-run"], result.runId);
    assert.match(request.labels["orch-call"], /^c\d+$/);
  }
});

test("committee: a failed respond keeps the member's last position and the paid rounds", async () => {
  const executor = fakeExecutor({ answer: committeeAnswers({ convergeAt: 3, fail: ["respond:codex/gpt-5.6-sol:1"] }) });
  const result = await run(committee, { input: COMMITTEE_INPUT, executor });

  assert.equal(result.outcome, "done");
  assert.equal(result.value.rounds, 3);
  assert.equal(result.value.failures.length, 1);
  assert.equal(result.value.failures[0].step, "respond");
  const events = eventsOf(result);
  const failed = events.filter((e) => e.kind === "call.end" && !e.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error.message, "fake failure of respond on codex/gpt-5.6-sol");
  // A failed call still ran on an agent and still cost money.
  assert.match(failed[0].agentId, /^fake-agent-/);
  assert.equal(failed[0].cost.usd, 0.01);
});

test("committee: a failed analyze stops with what the other member said", async () => {
  const executor = fakeExecutor({ answer: committeeAnswers({ fail: ["analyze:claude/claude-sonnet-5[1m]:1"] }) });
  const result = await run(committee, { input: COMMITTEE_INPUT, executor });

  assert.equal(result.outcome, "stopped");
  assert.equal(result.ok, true);
  assert.match(result.stop.reason, /analyze failed for worker/);
  assert.equal(result.stop.phase, null);
  assert.equal(result.value.positions[0], null);
  assert.equal(result.value.positions[1].confidence, "medium");
  const events = eventsOf(result);
  assert.deepEqual(events.at(-1).stop, result.stop);
});

test("committee: an unknown assessor fails before anything is spent", async () => {
  const executor = fakeExecutor({ answer: committeeAnswers() });
  const result = await run(committee, { input: { ...COMMITTEE_INPUT, assessor: "nobody" }, executor });
  assert.equal(result.outcome, "failed");
  assert.match(result.error.message, /Unknown role "nobody"/);
  assert.equal(executor.requests.length, 0);
  assert.equal(result.cost, null);
  assert.ok(!eventsOf(result).some((e) => e.kind === "call.start"));
});

test("advisor: one ask, the answer is the value", async () => {
  const answer = { verdict: "v", reasoning: "r", recommendation: "do x", whatWouldChangeMyMind: "y", confidence: "low" };
  const executor = fakeExecutor({ answer: () => answer });
  const result = await run(advisor, { input: { question: "Is this right?", role: "fast" }, executor });
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, { question: "Is this right?", advisor: { role: "fast", provider: "claude/claude-haiku-4-5" }, answer });
  const events = eventsOf(result);
  assert.deepEqual(kinds(events), ["run.start", "call.start:c1", "caveat", "call.end:c1", "run.end"]);
  assert.equal(events[0].source, null);
  assert.deepEqual(events[0].input, { question: "Is this right?", role: "fast" });
  assert.equal(events[1].role, "fast");
  assert.equal(events[1].timeout, "12m");
});

test("input is checked before run.start: a refused run leaves no events file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-refused-"));
  await assert.rejects(
    runFlow(advisor, { roster, logDir: dir, executor: fakeExecutor(), input: { question: "q" } }),
    (error) => error instanceof RunRefused && /input\.role: missing/.test(error.message),
  );
  await assert.rejects(runFlow(advisor, { roster, logDir: dir, executor: fakeExecutor(), input: { question: "q", role: "fast", extra: 1 } }), /not declared/);
  await assert.rejects(runFlow(committee, { roster, logDir: dir, executor: fakeExecutor(), input: { ...COMMITTEE_INPUT, rounds: "3" } }), /expected a number/);
  await assert.rejects(runFlow(committee, { roster, logDir: dir, executor: fakeExecutor(), input: { ...COMMITTEE_INPUT, committee: "big" } }), /not one of default, cheap/);
  assert.equal(existsSync(path.join(dir, "runs")), false);
});

// --- Primitives -------------------------------------------------------

const echo = define({ name: "echo", effects: "workspace", timeout: "1m", returns: { said: text() }, prompt: ({ word }) => `Say ${word}.` });

test("$.phase / $.do / $.log / $.stop: stop inside a phase ends it cleanly and names it", async () => {
  const f = flow({
    name: "probe",
    description: "d",
    phases: [{ id: "one", title: "One" }],
    inputs: {},
    grants: [],
    async run(_, $) {
      $.log.info("starting %s", "now");
      const big = await $.do("read", async () => "x".repeat(5_000));
      assert.equal(big.length, 5_000, "$.do returns the real value, only the event is cut");
      await $.phase("one", async () => {
        $.stop("nothing to do", { partial: true });
      });
      return "unreachable";
    },
  });
  const result = await run(f, { executor: fakeExecutor() });
  assert.equal(result.outcome, "stopped");
  assert.deepEqual(result.stop, { reason: "nothing to do", phase: "one" });
  assert.deepEqual(result.value, { partial: true });
  const events = eventsOf(result);
  assert.deepEqual(kinds(events), ["run.start", "log", "call.start:c1", "call.end:c1", "phase.start:one", "phase.end:one", "run.end"]);
  assert.equal(events[1].message, "starting now");
  assert.equal(events[3].output, `${"x".repeat(2_000)}…(truncated 3000 chars)`);
  assert.equal(events[3].agentId, null);
  assert.equal(events[5].ok, true, "a stop is not a failed phase");
});

test("$.stop cannot be swallowed: caught and returned, the run is still stopped", async () => {
  const f = flow({
    name: "swallow",
    description: "d",
    phases: [{ id: "one", title: "One" }],
    inputs: {},
    grants: [],
    async run(_, $) {
      await $.phase("one", async () => {
        try {
          $.stop("first reason", { partial: 1 });
        } catch {
          // swallowed
        }
        try {
          $.stop("second reason", { partial: 2 });
        } catch {
          // the first stop wins
        }
      });
      return "carried on";
    },
  });
  const result = await run(f, { executor: fakeExecutor() });
  assert.equal(result.outcome, "stopped");
  assert.deepEqual(result.stop, { reason: "first reason", phase: "one" });
  assert.deepEqual(result.value, { partial: 1 });
  const events = eventsOf(result);
  assert.deepEqual(events.find((e) => e.kind === "phase.end").ok, true);
});

test("$.stop cannot be swallowed: spending after a caught stop is refused", async () => {
  const executor = fakeExecutor({ answer: () => ({ said: "a" }) });
  const f = flow({
    name: "spend-after",
    description: "d",
    phases: [{ id: "later", title: "Later" }],
    inputs: {},
    grants: [],
    async run(_, $) {
      try {
        $.stop("done here");
      } catch {
        // swallowed
      }
      const refused = [];
      for (const attempt of [() => $.ask(echo, { word: "a" }, { role: "fast" }), () => $.phase("later", async () => 1), () => $.do("write", () => 1)]) {
        await attempt().catch((error) => refused.push(error.name));
      }
      throw new Error(`carried on and failed after: ${refused.join(",")}`);
    },
  });
  const result = await run(f, { executor });
  assert.equal(result.outcome, "stopped");
  assert.equal(result.error, null);
  assert.equal(result.stop.reason, "done here");
  assert.equal(executor.requests.length, 0, "nothing was sent after the stop");
  const events = eventsOf(result);
  assert.ok(!events.some((e) => e.kind === "call.start" || e.kind === "phase.start"));
  assert.match(events.find((e) => e.kind === "log").message, /RunEnded,RunEnded,RunEnded/);
});

test("$.stop inside one $.all task: siblings cannot start new calls, calls in flight finish", async () => {
  const executor = fakeExecutor({ answer: () => ({ said: "a" }), delayMs: 30 });
  const f = flow({
    name: "stop-in-all",
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    async run(_, $) {
      const results = await $.all([
        () => $.ask(echo, { word: "a" }, { role: "fast" }),
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          $.stop("enough");
        },
        async () => {
          await new Promise((r) => setTimeout(r, 15));
          return $.ask(echo, { word: "b" }, { role: "fast" });
        },
      ]).catch((error) => error);
      return results;
    },
  });
  const result = await run(f, { executor });
  assert.equal(result.outcome, "stopped");
  assert.equal(result.stop.reason, "enough");
  assert.equal(executor.requests.length, 1, "the late sibling was refused");
  const events = eventsOf(result);
  const end = events.find((e) => e.kind === "call.end");
  assert.equal(end.ok, true, "the call already in flight finished normally");
});

test("$.all settles every task; one failure keeps the others' results", async () => {
  const f = flow({
    name: "fan",
    description: "d",
    phases: [{ id: "left", title: "L" }, { id: "right", title: "R" }],
    inputs: {},
    grants: [],
    async run(_, $) {
      // Two phases at once: each call is tagged with its own.
      return $.all([
        () => $.phase("left", () => $.ask(echo, { word: "a" }, { role: "fast" })),
        () => $.phase("right", () => $.ask(echo, { word: "b" }, { role: "reviewer-alt" })),
        $.do("boom", () => {
          throw new Error("boom");
        }),
      ]);
    },
  });
  const executor = fakeExecutor({ answer: (r) => ({ said: r.prompt.includes("Say a") ? "a" : "b" }), delayMs: 10 });
  const result = await run(f, { executor });
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value.map((s) => s.ok), [true, true, false]);
  assert.deepEqual(result.value[0].value, { said: "a" });
  assert.equal(result.value[2].error.message, "boom");
  const events = eventsOf(result);
  const phaseOf = Object.fromEntries(events.filter((e) => e.kind === "call.start").map((e) => [e.name + e.callId, e.phase]));
  // The $.do was passed as a promise, so it started first; the thunks start inside $.all.
  assert.deepEqual(phaseOf, { boomc1: null, echoc2: "left", echoc3: "right" });
  // workspace effects: the workspace suffix, and codex runs in auto too.
  const start = events.find((e) => e.kind === "call.start" && e.name === "echo");
  assert.match(start.prompt, /only there\. Do not commit, push/);
  // The value keeps errors readable in run.end.
  assert.deepEqual(events.at(-1).value[2], { ok: false, error: { name: "Error", message: "boom" } });
});

test("$.ask refuses mode, unknown options, unknown providers -- before the call starts", async () => {
  const attempts = {
    mode: ($) => $.ask(echo, { word: "a" }, { role: "fast", mode: "auto" }),
    option: ($) => $.ask(echo, { word: "a" }, { role: "fast", sandbox: true }),
    provider: ($) => $.ask(echo, { word: "a" }, { provider: "gemini/pro" }),
    input: ($) => $.ask(echo, {}, { role: "fast" }),
    thinking: ($) => $.ask(echo, { word: "a" }, { role: "planner", provider: "codex/gpt-6-astra" }),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    const executor = fakeExecutor();
    const f = flow({ name: "refuse", description: "d", phases: [], inputs: {}, grants: [], run: (_, $) => attempt($) });
    const result = await run(f, { executor });
    assert.equal(result.outcome, "failed", name);
    assert.equal(executor.requests.length, 0, `${name}: nothing was sent`);
    assert.ok(!eventsOf(result).some((e) => e.kind === "call.start"), `${name}: no call started`);
  }
});

test("$.gate: approved, denied, expired; the decision is the output; gate:deny is required", async () => {
  const gated = (timeout) =>
    flow({
      name: "gated",
      description: "d",
      phases: [{ id: "review", title: "Review" }],
      inputs: {},
      grants: ["gate:deny"],
      run: (_, $) => $.phase("review", () => $.gate({ title: "place a.lua", content: "local x = 1\n", brief: "checks passed", timeout })),
    });

  const approved = await run(gated("1m"), { executor: fakeExecutor({ carrier: "approve" }) });
  assert.equal(approved.value.outcome, "allowed");
  assert.equal(approved.value.approved, true);
  let events = eventsOf(approved);
  const start = events.find((e) => e.kind === "call.start");
  assert.equal(start.type, "gate");
  assert.equal(start.phase, "review");
  assert.equal(start.fence.mode, "default");
  assert.ok(start.holdPath.startsWith(path.join(logDir, "runs", approved.runId, "gate")), start.holdPath);
  assert.ok(start.prompt.startsWith("checks passed"), "the carrier's prompt as sent is recorded");
  const end = events.find((e) => e.kind === "call.end");
  assert.equal(end.agentId, approved.value.agentId);
  const announced = events.find((e) => e.kind === "call.agent");
  assert.equal(announced.agentId, approved.value.agentId, "the carrier is announced as soon as it is spawned");
  assert.ok(announced.seq < end.seq);
  assert.ok(approved.caveats.some((c) => c.includes("unattributed")));

  const denied = await run(gated("1m"), { executor: fakeExecutor({ carrier: "deny" }) });
  assert.equal(denied.value.outcome, "denied");
  assert.equal(denied.value.agentReport, "The write was denied.");
  eventsOf(denied);

  const executor = fakeExecutor({ carrier: "hang" });
  const expired = await run(gated("1s"), { executor });
  assert.equal(expired.value.outcome, "expired");
  assert.deepEqual(executor.denied, [expired.value.agentId], "the expired card was denied on the person's behalf");
  eventsOf(expired);

  // Without the grant: refused at the call, before a carrier starts.
  const bare = fakeExecutor();
  const ungranted = flow({ name: "ungranted", description: "d", phases: [], inputs: {}, grants: [], run: (_, $) => $.gate({ title: "t", content: "c" }) });
  const refused = await run(ungranted, { executor: bare });
  assert.equal(refused.outcome, "failed");
  assert.equal(refused.error.name, "GrantError");
  assert.equal(bare.requests.length, 0);
});

test("timeout: the run ends, the call in flight is closed with RunEnded", async () => {
  const f = flow({
    name: "slow",
    description: "d",
    phases: [{ id: "wait", title: "Wait" }],
    inputs: {},
    grants: [],
    run: (_, $) => $.phase("wait", () => $.ask(echo, { word: "a" }, { role: "fast" })),
  });
  const executor = fakeExecutor({ answer: () => new Promise(() => {}) });
  const result = await run(f, { executor, timeout: "1s" });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.ok, false);
  assert.equal(result.error.name, "RunTimeout");
  const events = eventsOf(result);
  const end = events.find((e) => e.kind === "call.end");
  assert.equal(end.error.name, "RunEnded");
  assert.match(end.agentId, /^fake-agent-/, "the agent left running is named");
  assert.deepEqual(events.filter((e) => e.kind === "phase.end").map((e) => e.ok), [false]);
});

test("past a timeout the flow cannot start new calls, even while the run is settling", async () => {
  // The slow call is not awaited; the loop keeps asking while settling looks
  // agents up, which takes a while on a real daemon.
  const f = flow({
    name: "busy",
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    async run(_, $) {
      $.ask(echo, { word: "slow" }, { role: "fast" }).catch(() => {});
      for (;;) await $.ask(echo, { word: "a" }, { role: "fast" });
    },
  });
  const base = fakeExecutor({ answer: (r) => (r.prompt.includes("slow") ? new Promise(() => {}) : { said: "a" }), delayMs: 200 });
  const executor = { ...base, findAgent: async (labels) => (await new Promise((r) => setTimeout(r, 300)), base.findAgent(labels)) };
  const result = await run(f, { executor, timeout: "1s" });
  assert.equal(result.outcome, "timeout");
  eventsOf(result);
  const started = base.requests.length;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(base.requests.length, started, "nothing was sent after the run ended");
});

test("a timeout out of setTimeout's range is refused before anything runs", async () => {
  await assert.rejects(run(advisor, { input: { question: "q", role: "fast" }, executor: fakeExecutor(), timeout: "0s" }), /out of range/);
  await assert.rejects(run(advisor, { input: { question: "q", role: "fast" }, executor: fakeExecutor(), timeout: "600h" }), /out of range/);
});

test("an answer that does not fit the schema fails the call and is still recorded", async () => {
  for (const [label, answer] of [["null", null], ["missing field", { verdict: "v" }]]) {
    const result = await run(advisor, { input: { question: "q", role: "fast" }, executor: fakeExecutor({ answer: () => answer }) });
    assert.equal(result.outcome, "failed", label);
    assert.equal(result.error.name, "OutputMismatch", label);
    const end = eventsOf(result).find((e) => e.kind === "call.end");
    assert.equal(end.ok, false);
    assert.deepEqual(end.output, answer, `${label}: the paid answer is kept`);
  }
});

test("a thrown error is a failed run with a run.end", async () => {
  const f = flow({ name: "throws", description: "d", phases: [], inputs: {}, grants: [], run: async () => { throw new RangeError("bad"); } });
  const result = await run(f, { executor: fakeExecutor() });
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.error, { name: "RangeError", message: "bad" });
  const events = eventsOf(result);
  assert.equal(events.at(-2).kind, "log");
  assert.match(events.at(-2).message, /RangeError: bad/);
});

// --- For people: titles, headlines, summaries ---------------------------

test("titles: $.ask's own, then the step's, then [name]; the same text goes to Paseo", async () => {
  const titled = define({ name: "titled", title: "有标题的一步", headline: "said", effects: "none", timeout: "1m", returns: { said: text() }, prompt: () => "p" });
  const f = flow({
    name: "titles",
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    async run(_, $) {
      await $.ask(titled, {}, { role: "fast", title: "这一次的标题" });
      await $.ask(titled, {}, { role: "fast" });
      await $.ask(echo, { word: "hi" }, { role: "fast" });
      await $.do("read", () => 1, { title: "读文件" });
      await $.do("write", () => 2);
    },
  });
  const executor = fakeExecutor({ answer: () => ({ said: "hi" }) });
  const result = await run(f, { executor });
  assert.equal(result.outcome, "done");
  const starts = eventsOf(result).filter((e) => e.kind === "call.start");
  assert.deepEqual(starts.map((e) => e.title), ["这一次的标题", "有标题的一步", "[echo]", "读文件", "write"]);
  assert.deepEqual(executor.requests.map((r) => r.title), ["这一次的标题", "有标题的一步", "[echo]"]);
  assert.deepEqual(starts.map((e) => e.name), ["titled", "titled", "echo", "read", "write"]);
});

test("$.do takes only a title, and a real one", async () => {
  for (const [options, message] of [
    [{ name: "x" }, /unknown option name; options: title/],
    [{ title: "" }, /title must be a non-empty string/],
    [{ title: 3 }, /title must be a non-empty string/],
  ]) {
    const f = flow({ name: "bad-do", description: "d", phases: [], inputs: {}, grants: [], run: (_, $) => $.do("read", () => 1, options) });
    const result = await run(f, { executor: fakeExecutor() });
    assert.equal(result.outcome, "failed");
    assert.match(result.error.message, message);
    assert.ok(!eventsOf(result).some((e) => e.kind === "call.start"), "refused before the call starts");
  }
});

test("headline: the step's field on every ask's call.start, null when it has none", async () => {
  const pick = define({ name: "pick", headline: "choice", effects: "none", timeout: "1m", returns: { choice: text(), why: text() }, prompt: () => "p" });
  const f = flow({
    name: "headlines",
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    run: async (_, $) => [await $.ask(pick, {}, { role: "fast" }), await $.ask(echo, { word: "x" }, { role: "fast" })],
  });
  const result = await run(f, { executor: fakeExecutor({ answer: (r) => (r.labels["orch-step"] === "pick" ? { choice: "a", why: "b" } : { said: "x" }) }) });
  const asks = eventsOf(result).filter((e) => e.kind === "call.start");
  assert.deepEqual(asks.map((e) => e.headline), ["choice", null]);
  assert.ok(asks.every((e) => Object.hasOwn(e, "headline")));
});

test("define: title is a non-empty string, headline names a field of returns", () => {
  const base = { name: "x", effects: "none", returns: { verdict: text(), why: text() }, prompt: () => "p" };
  assert.throws(() => define({ ...base, headline: "verdit" }), /headline must name a field of returns \(verdict, why\), got "verdit"/);
  assert.throws(() => define({ ...base, headline: 1 }), /headline must name a field of returns/);
  assert.throws(() => define({ ...base, headline: "toString" }), /headline must name a field/, "inherited names are not fields");
  assert.throws(() => define({ ...base, title: "  " }), /title must be a non-empty string/);
  assert.throws(() => define({ ...base, title: ["t"] }), /title must be a non-empty string/);
  const ok = define({ ...base, title: "裁决", headline: "verdict" });
  assert.equal(ok.title, "裁决");
  assert.equal(ok.headline, "verdict");
  assert.equal(define(base).headline, null);
  // A hand-written schema passes through; its properties are the fields.
  const raw = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  assert.equal(define({ ...base, returns: raw, headline: "a" }).headline, "a");
  assert.throws(() => define({ ...base, returns: raw, headline: "b" }), /headline must name a field of returns \(a\)/);
});

/** A flow that ends as told, with a summarize under test. */
const ending = (how, summarize) =>
  flow({
    name: "ending",
    description: "d",
    phases: [],
    inputs: {},
    grants: [],
    async run(_, $) {
      if (how === "stop") $.stop("had enough", { got: "partial" });
      if (how === "throw") throw new Error("broke");
      return { got: "all", when: new Date(0) };
    },
    summarize,
  });

test("summarize: called once, on done and stopped, with the value as recorded", async () => {
  const seen = [];
  const summarize = (value, info) => {
    seen.push({ value, info });
    return `${info.outcome}: ${value.got}`;
  };
  const done = await run(ending("return", summarize), { executor: fakeExecutor() });
  assert.equal(done.summary, "done: all");
  assert.equal(eventsOf(done).at(-1).summary, "done: all");
  // The value run.end writes: JSON, so the Date is its string.
  assert.deepEqual(seen[0], { value: { got: "all", when: "1970-01-01T00:00:00.000Z" }, info: { outcome: "done" } });

  const stopped = await run(ending("stop", summarize), { executor: fakeExecutor() });
  assert.equal(stopped.outcome, "stopped");
  assert.equal(stopped.summary, "stopped: partial");
  assert.equal(seen.length, 2);

  const failed = await run(ending("throw", summarize), { executor: fakeExecutor() });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.summary, null);
  assert.equal(eventsOf(failed).at(-1).summary, null);
  assert.equal(seen.length, 2, "not called for a failed run");

  // No summarize: null, and run.start does not carry one either way.
  const plain = await run(ending("return"), { executor: fakeExecutor() });
  assert.equal(plain.summary, null);
  const events = eventsOf(done);
  assert.equal(Object.hasOwn(events[0].flow, "summarize"), false);
  assert.equal(Object.hasOwn(eventsOf(plain).at(-1), "summary"), true);
});

test("summarize: a throw or a non-string is a warning and a null; the outcome stands", async () => {
  const cases = [
    ["throws", () => { throw new TypeError("cannot read verdict"); }, /summarize threw, so run\.end has no summary: TypeError: cannot read verdict/],
    ["throws a non-error", () => { throw Object.create(null); }, /summarize threw/],
    ["returns a number", () => 42, /summarize returned number, not a string/],
    ["returns null", () => null, /summarize returned null, not a string/],
    ["is async", async () => { throw new Error("later"); }, /summarize returned a promise \(it is not awaited\)/],
  ];
  for (const [label, summarize, warning] of cases) {
    for (const how of ["return", "stop"]) {
      const result = await run(ending(how, summarize), { executor: fakeExecutor() });
      assert.equal(result.outcome, how === "stop" ? "stopped" : "done", `${label}/${how}`);
      assert.equal(result.summary, null, `${label}/${how}`);
      const events = eventsOf(result);
      assert.equal(events.at(-1).kind, "run.end");
      assert.equal(events.at(-1).outcome, result.outcome);
      assert.equal(events.at(-1).summary, null);
      const warn = events.filter((e) => e.kind === "log" && e.level === "warn");
      assert.equal(warn.length, 1, `${label}/${how}`);
      assert.match(warn[0].message, warning);
    }
  }
  // Nothing to say is not a mistake: null, no warning.
  const empty = await run(ending("return", () => "   "), { executor: fakeExecutor() });
  assert.equal(empty.summary, null);
  assert.ok(!eventsOf(empty).some((e) => e.kind === "log"));
});

test("summarize: past 200 characters the line is cut, by code points, and marked", async () => {
  const long = "裁".repeat(150) + "😀".repeat(100);
  const result = await run(ending("return", () => long), { executor: fakeExecutor() });
  assert.equal([...result.summary].length, 201);
  assert.equal(result.summary, `${"裁".repeat(150)}${"😀".repeat(50)}…`);
  const exact = await run(ending("return", () => "x".repeat(200)), { executor: fakeExecutor() });
  assert.equal(exact.summary, "x".repeat(200));
});

test("flow: summarize is optional, and a function when given", () => {
  const base = { name: "f", description: "d", phases: [], inputs: {}, grants: [], run: async () => null };
  assert.equal(flow(base).summarize, null);
  assert.throws(() => flow({ ...base, summarize: "done" }), /summarize must be a function/);
});

test("shipped flows say how they came out", async () => {
  const converged = await run(committee, { input: COMMITTEE_INPUT, executor: fakeExecutor({ answer: committeeAnswers({ convergeAt: 2 }) }) });
  assert.equal(converged.summary, "第 2 轮收敛：Key the cache on the resolved path.");
  const events = eventsOf(converged);
  const starts = events.filter((e) => e.kind === "call.start");
  assert.deepEqual(starts.map((e) => e.title), [
    "成员 A（worker）独立分析",
    "成员 B（reviewer-alt）独立分析",
    "第 1 轮裁决：收敛了吗",
    "成员 A（worker）第 2 轮回应",
    "成员 B（reviewer-alt）第 2 轮回应",
    "第 2 轮裁决：收敛了吗",
  ]);
  assert.deepEqual(starts.map((e) => e.headline), ["plan", "plan", "converged", "answer", "answer", "converged"]);

  const capped = await run(committee, { input: { ...COMMITTEE_INPUT, rounds: 2 }, executor: fakeExecutor({ answer: committeeAnswers({ convergeAt: 9 }) }) });
  assert.equal(capped.summary, "2 轮未收敛，分歧：Whether symlinked checkouts must share a cache entry.");

  const single = await run(committee, { input: { ...COMMITTEE_INPUT, rounds: 1 }, executor: fakeExecutor({ answer: committeeAnswers() }) });
  assert.equal(single.summary, "只做了独立分析，没有裁决");

  const noAssess = await run(committee, { input: COMMITTEE_INPUT, executor: fakeExecutor({ answer: committeeAnswers({ fail: ["assess:claude/claude-sonnet-5[1m]:1"] }) }) });
  assert.equal(noAssess.summary, "裁决失败，1 轮没有结论（1 次调用失败）");

  const stopped = await run(committee, { input: COMMITTEE_INPUT, executor: fakeExecutor({ answer: committeeAnswers({ fail: ["analyze:claude/claude-sonnet-5[1m]:1"] }) }) });
  assert.equal(stopped.outcome, "stopped");
  assert.equal(stopped.summary, "独立分析失败（worker），没有进入辩论");

  const answer = { verdict: "It holds.", reasoning: "r", recommendation: "x", whatWouldChangeMyMind: "y", confidence: "high" };
  const advised = await run(advisor, { input: { question: "q", role: "fast" }, executor: fakeExecutor({ answer: () => answer }) });
  assert.equal(advised.summary, "It holds.");
  const ask = eventsOf(advised).find((e) => e.kind === "call.start");
  assert.equal(ask.title, "第二意见");
  assert.equal(ask.headline, "verdict");
});

// --- Definitions and checks -------------------------------------------

test("define: effects is required, readOnly is gone, names are verbs in lowercase", () => {
  const base = { name: "x", returns: { a: text() }, prompt: () => "p" };
  assert.throws(() => define(base), /effects is required/);
  assert.throws(() => define({ ...base, effects: "all" }), /effects is required/);
  assert.throws(() => define({ ...base, readOnly: true }), /readOnly is gone/);
  assert.throws(() => define({ ...base, effects: "none", mode: "auto" }), /unknown key mode/);
  assert.throws(() => define({ ...base, effects: "none", timeout: "5 minutes" }), /timeout must look like/);
  assert.throws(() => define({ ...base, name: "Analyze", effects: "none" }), /lowercase name/);
  assert.equal(define({ ...base, effects: "none" }).effects, "none");
});

test("flow: metadata is data, every key required, grants guarded", () => {
  const base = { name: "f", description: "d", phases: [], inputs: {}, grants: [], run: async () => null };
  assert.equal(flow(base).name, "f");
  assert.throws(() => flow({ ...base, grants: ["gate:allow"] }), /never granted/);
  assert.throws(() => flow({ ...base, grants: ["spawn"] }), /default grant/);
  assert.throws(() => flow({ ...base, grants: ["archive"] }), /unknown grant/);
  const { phases, ...noPhases } = base;
  assert.throws(() => flow(noPhases), /phases is required/);
  assert.throws(() => flow({ ...base, phases: [{ id: "a", title: "A" }, { id: "a", title: "B" }] }), /declared twice/);
  assert.throws(() => flow({ ...base, inputs: { timeout: text() } }), /collides/);
  assert.throws(() => flow({ ...base, inputs: { "hotfix-id": text() } }), /camelCase/);
  assert.throws(() => flow({ ...base, inputs: { a: { type: "string", default: "x" } } }), /not something the builders emit/);
  assert.throws(() => flow({ ...base, extra: 1 }), /unknown key extra/);
});

test("scanSource: undeclared phases and a gate without its grant, before any spend", () => {
  const f = flow({ name: "f", description: "d", phases: [{ id: "a", title: "A" }], inputs: {}, grants: [], run: async () => null });
  assert.deepEqual(scanSource(f, `await $.phase("a", x); await $.phase('b', y); await $.gate({})`), [
    '$.phase("b") is not declared in phases',
    'the flow calls $.gate but does not declare grants: ["gate:deny"]',
  ]);
});

test("a flow file with an undeclared phase is refused before run.start", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-flowfile-"));
  const file = path.join(dir, "typo.mjs");
  const runtime = path.join(HERE, "..", "runtime", "flow.mjs").replace(/\\/g, "/");
  await writeFile(
    file,
    `import { flow } from "file:///${runtime}";\n` +
      `export default flow({ name: "typo", description: "d", phases: [{ id: "debate", title: "D" }], inputs: {}, grants: [],\n` +
      `  run: (_, $) => $.phase("debtae", async () => 1) });\n`,
  );
  await assert.rejects(runFlow(file, { roster, logDir: dir, executor: fakeExecutor() }), /\$\.phase\("debtae"\) is not declared/);
  assert.equal(existsSync(path.join(dir, "runs")), false);

  const checked = await checkFlow(file, { roster });
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.problems, ['$.phase("debtae") is not declared in phases']);

  // A step without effects throws at import: refused, not a failed run.
  const broken = path.join(dir, "broken.mjs");
  await writeFile(
    broken,
    `import { flow, define, text } from "file:///${runtime}";\n` +
      `const s = define({ name: "s", returns: { a: text() }, prompt: () => "p" });\n` +
      `export default flow({ name: "broken", description: "d", phases: [], inputs: {}, grants: [], run: async () => s });\n`,
  );
  await assert.rejects(runFlow(broken, { roster, logDir: dir, executor: fakeExecutor() }), (e) => e instanceof RunRefused && /effects is required/.test(e.message));
  assert.equal(existsSync(path.join(dir, "runs")), false);
});

test("checkFlow on the shipped flows", async () => {
  for (const name of ["committee", "advisor"]) {
    const checked = await checkFlow(path.join(HERE, "..", "flows", `${name}.mjs`), { roster });
    assert.equal(checked.ok, true, checked.problems.join("; "));
    assert.equal(checked.flow.name, name);
    assert.deepEqual(checked.warnings, []);
  }
});

test("fences: every level has a mode source, unknown families fail closed", () => {
  assert.equal(fenceFor("claude/claude-haiku-4-5", "none").mode, "auto");
  assert.equal(fenceFor("claude/x", "ask-human").mode, "default");
  assert.equal(fenceFor("codex/gpt-6-astra", "workspace").mode, "auto");
  assert.equal(fenceFor("pi/crs-claude/claude-opus-5", "none").mode, null);
  assert.throws(() => fenceFor("codex/gpt-6-astra", "ask-human"), /codex has no "ask-human" fence/);
  assert.throws(() => fenceFor("gemini/pro", "none"), /No fence for provider family "gemini"/);
  assert.throws(() => fenceFor("claude/x", "readonly"), /unknown fence level/);
});

test("CLI arguments are parsed by the flow's input types", async () => {
  const f = flow({
    name: "types",
    description: "d",
    phases: [],
    inputs: { hotfixId: text(), rounds: count(), write: flag(), files: list(text()), mode: choice(["a", "b"]) },
    grants: [],
    run: async () => null,
  });
  const parsed = await parseRunArgs(f, ["--hotfix-id", "42", "--rounds", "3", "--no-write", "--files", "a.lua", "--files", "b.lua", "--mode", "a", "--timeout", "2h"]);
  assert.deepEqual(parsed, { input: { hotfixId: "42", rounds: 3, write: false, files: ["a.lua", "b.lua"], mode: "a" }, timeout: "2h" });
  const merged = await parseRunArgs(f, ["--input", '{"hotfixId":"1","rounds":2}', "--rounds", "5"]);
  assert.deepEqual(merged.input, { hotfixId: "1", rounds: 5 });
  // Values that start with "-": a question written as a list, a negative number.
  const dashed = await parseRunArgs(f, ["--hotfix-id", "- a\n- b", "--rounds", "-1", "--write"]);
  assert.deepEqual(dashed.input, { hotfixId: "- a\n- b", rounds: -1, write: true });
  await assert.rejects(parseRunArgs(f, ["--rounds", "three"]), /not a number/);
  await assert.rejects(parseRunArgs(f, ["--hotfix_id", "1"]), /Unknown option/);
});

// --- The contract checker itself ----------------------------------------

test("checkEvents catches what a reader would trip on", () => {
  const good = [
    { v: 1, seq: 0, ts: "2026-09-24T00:00:00.000Z", runId: "r", kind: "run.start", flow: { name: "f", description: "d", phases: [{ id: "a", title: "A" }], inputs: {}, grants: [] }, source: null, input: {}, caller: null, cwd: "C:/", host: null, pid: 1, hostname: "h" },
    { v: 1, seq: 1, ts: "2026-09-24T00:00:01.000Z", runId: "r", kind: "run.end", outcome: "done", value: null, summary: null, stop: null, error: null, durationMs: 1, cost: null, caveats: [] },
  ];
  assert.deepEqual(checkEvents(good, { strict: true, complete: true }), []);
  assert.match(checkEvents([good[0]], { complete: true }).join(), /no run\.end/);
  assert.match(checkEvents([good[0], { ...good[1], seq: 2 }]).join(), /seq is 2, expected 1/);
  assert.match(checkEvents([good[0], { ...good[1], seq: 1, kind: "phase.start", phase: "b" }]).join(), /"b" is not declared/);
  assert.match(checkEvents([good[0], { ...good[1], outcome: "stopped" }]).join(), /stop must be/);
  assert.match(checkEvents([good[0], { ...good[1], kind: "future.thing" }], { strict: true }).join(), /not in the contract/);
  assert.deepEqual(checkEvents([good[0], { ...good[1], kind: "future.thing" }]), [], "readers ignore unknown kinds");
  const t = "2026-09-24T00:00:00.500Z";
  const call = [
    good[0],
    { v: 1, seq: 1, ts: t, runId: "r", kind: "call.start", callId: "c1", type: "do", name: "x", title: "x", phase: null },
    { v: 1, seq: 2, ts: t, runId: "r", kind: "call.agent", callId: "c1", agentId: "a" },
  ];
  assert.match(checkEvents(call).join(), /a do call has no agent/);
  const { pid, ...noPid } = good[0];
  assert.match(checkEvents([noPid]).join(), /pid is not a positive integer/);
  assert.match(checkEvents([good[0], { ...good[1], outcome: "failed", error: { name: "E", message: "m" }, summary: "x" }]).join(), /summary must be null/);
  assert.match(checkEvents([good[0], { ...good[1], summary: " " }]).join(), /summary must be null/);
});

test("checkEvents: headline and summary are required of new files, absent from old ones", () => {
  const events = readEvents(path.join(HERE, "..", "fixtures", "committee.jsonl"));
  const asks = events.filter((e) => e.kind === "call.start" && e.type === "ask");
  assert.ok(asks.every((e) => e.headline !== undefined) && events.at(-1).summary !== undefined);
  // What a file written before the two fields looks like.
  const old = events.map(({ headline, summary, ...rest }) => rest);
  assert.deepEqual(checkEvents(old, { complete: true }), [], "a reader of old files is not bothered");
  const strict = checkEvents(old, { strict: true, complete: true });
  assert.equal(strict.filter((p) => /headline is missing/.test(p)).length, asks.length);
  assert.equal(strict.filter((p) => /summary is missing/.test(p)).length, 1);
  // Present, they must fit.
  const bent = events.map((e) => (e.kind === "call.start" && e.type === "ask" ? { ...e, headline: "nosuchfield" } : e));
  assert.match(checkEvents(bent).join(), /headline is not null or a field of schema/);
});

test("the committed committee fixture conforms to the contract", async () => {
  const events = readEvents(path.join(HERE, "..", "fixtures", "committee.jsonl"));
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  assert.equal(events[0].flow.name, "committee");
  assert.equal(events[0].flow.summarize, undefined);
  assert.match(events.at(-1).summary, /^第 3 轮收敛（1 次调用失败）：/);
});

test("nothing is left in the log directory but runs/", async () => {
  // The per-day audit files are gone: one run, one file, nothing else.
  const entries = await readdir(logDir);
  assert.deepEqual(entries, ["runs"]);
  const files = await readdir(path.join(logDir, "runs"));
  assert.ok(files.every((f) => f.endsWith(".jsonl") || !f.includes(".")), files.join(", "));
  assert.ok((await readFile(path.join(logDir, "runs", files.find((f) => f.endsWith(".jsonl"))), "utf8")).endsWith("\n"));
});
