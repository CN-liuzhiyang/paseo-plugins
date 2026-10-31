// `$.again`: another question to the agent that answered, or to a new one that starts from the answer. The executor is a fake
// that answers from a script; nothing talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFlow } from "../runtime/run.mjs";
import { flow, define, text } from "../runtime/flow.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { FENCES } from "../runtime/fences.mjs";
import { PaseoCliError } from "../runtime/paseo-cli.mjs";
import againSmoke from "../flows/again-smoke.mjs";
import { fakeExecutor } from "./fake-executor.mjs";

let roster;
let logDir;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
  logDir = await mkdtemp(path.join(os.tmpdir(), "orch-again-"));
});
after(() => rm(logDir, { recursive: true, force: true }));

const draft = define({ name: "draft", effects: "none", timeout: "5m", returns: { headline: text("one line"), body: text("the text") }, prompt: ({ topic }) => `write about ${topic}` });
const notes = define({ name: "notes", effects: "none", timeout: "5m", returns: { notes: text("what to improve") }, prompt: () => "list what to improve" });
const v1 = { headline: "first", body: "one" };
const v2 = { headline: "second", body: "two" };
const v3 = { headline: "third", body: "three" };

const cliError = (code, message = code) => new PaseoCliError(message, { argv: ["x"], exitCode: 1, stdout: "", stderr: "", code, details: null });
const unknownOption = (option) => new PaseoCliError("paseo failed", { argv: ["run"], exitCode: 1, stdout: "", stderr: `error: unknown option '${option}'\n` });

/**
 * A fake with a script: `firsts` are what agents answer when they are started, `replies` what any agent answers when it is sent to.
 * An id in `gone` is an agent Paseo no longer has. `send` wakes an archived agent, as the real one does.
 */
function conversation({ firsts = [], replies = [], gone = [], askUnknown = false, noSend = false, fake = {} } = {}) {
  const startQueue = [...firsts];
  const replyQueue = [...replies];
  const base = fakeExecutor({
    answer: () => {
      const next = startQueue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    ...fake,
  });
  const sends = [];
  const asks = [];
  const executor = {
    ...base,
    sends,
    asks,
    ask: async (request) => {
      asks.push(request);
      if (askUnknown && request.maxRetries !== undefined) throw unknownOption("--max-retries");
      return base.ask(request);
    },
    inspect: async (id) => {
      if (gone.includes(id)) throw cliError("AGENT_NOT_FOUND", `Agent not found: ${id}`);
      return base.inspect(id);
    },
  };
  if (!noSend) {
    executor.send = async (request) => {
      sends.push(request);
      const agent = base.agents.get(request.agentId);
      if (agent) agent.archived = false;
      const next = replyQueue.shift();
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(request) : next;
    };
  }
  return executor;
}

const flowOf = (body, grants = []) => flow({ name: "again", description: "d", phases: [], inputs: {}, grants, run: (_, $) => body($) });
const run = (f, executor, options = {}) => runFlow(f, { roster, logDir, cwd: "C:/work", caller: null, gatePollMs: 5, agentProbeDelays: [5, 10], executor, ...options });
const ask = ($, options = {}) => $.ask(draft, { topic: "t" }, { role: "fast", ...options });

function eventsOf(result) {
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return events;
}
const of = (events, kind) => events.filter((e) => e.kind === kind);
const startOf = (events, callId) => events.find((e) => e.kind === "call.start" && e.callId === callId);
const endOf = (events, callId) => events.find((e) => e.kind === "call.end" && e.callId === callId);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test("again asks the agent that answered, and says what the previous version was", async () => {
  const executor = conversation({ firsts: [v1], replies: [v2] });
  const result = await run(flowOf(async ($) => $.again(await ask($), "make it shorter")), executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, v2);

  assert.equal(executor.requests.length, 1, "no second agent");
  const [send] = executor.sends;
  assert.equal(send.agentId, "fake-agent-1");
  assert.deepEqual(send.schema, draft.schema, "the whole answer again, against the step's own schema");
  assert.ok(send.prompt.startsWith("make it shorter"));
  assert.ok(!send.prompt.includes("write about"), "the question is not asked again");
  assert.ok(send.file.endsWith(path.join("prompts", "c2.r1.txt")), send.file);
  const saved = send.prompt.match(/saved in (.+)\. Reply/)[1];
  assert.deepEqual(JSON.parse(await readFile(saved, "utf8")), v1, "the previous version, as it was handed in");

  const events = eventsOf(result);
  const c2 = startOf(events, "c2");
  assert.deepEqual([c2.type, c2.name, c2.continues, c2.revises], ["ask", "draft", { runId: result.runId, callId: "c1" }, null]);
  assert.equal(c2.prompt, send.prompt);
  assert.deepEqual(startOf(events, "c1").continues, null);
  const announced = events.find((e) => e.kind === "call.agent" && e.callId === "c2");
  assert.equal(announced.agentId, "fake-agent-1");
  assert.ok(events.slice(c2.seq + 1, announced.seq).every((e) => e.kind === "caveat"), "the agent is announced as the call starts, before anything of the call itself");
  assert.equal(endOf(events, "c2").agentId, "fake-agent-1");
  assert.equal(endOf(events, "c2").rounds, 1);
  near(endOf(events, "c2").cost.usd, 0.01);
  assert.equal(result.cost.agentCount, 1, "one agent, whatever it was asked");
  near(result.cost.totalUsd, 0.02);
});

test("again after again: the same agent each time, the check follows the answer unless the flow changes it", async () => {
  const noShout = (a) => (a.body.includes("!") ? [{ at: "/body", say: "no exclamation marks" }] : []);
  const executor = conversation({ firsts: [{ ...v1, body: "one!" }], replies: [{ f1: "one" }, { ...v2, body: "two!" }, { f1: "two" }, { ...v3, body: "three!" }, { ...v3, body: "three!" }, { ...v3, body: "three!" }] });
  const result = await run(
    flowOf(async ($) => {
      const a = await ask($, { check: noShout });
      const b = await $.again(a, "rewrite");
      const c = await $.again(b, "again, with feeling", { check: null });
      return { a, b, c };
    }),
    executor,
  );
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value.a.body, "one");
  assert.deepEqual(result.value.b.body, "two", "the check of the first call stood in the second: its answer was sent back");
  assert.equal(result.value.c.body, "three!", "check: null turned it off");
  assert.deepEqual(new Set(executor.sends.map((s) => s.agentId)), new Set(["fake-agent-1"]));
  assert.deepEqual(Object.keys(executor.sends[0].schema.properties), ["f1"], "the correction of a first answer is as in any ask");
  const events = eventsOf(result);
  assert.deepEqual(endOf(events, "c2").rounds, 2);
  assert.deepEqual(startOf(events, "c3").continues, { runId: result.runId, callId: "c2" });
  assert.equal(result.cost.agentCount, 1);
});

test("another step asked of the same agent", async () => {
  const executor = conversation({ firsts: [v1], replies: [{ notes: "tighter" }] });
  const result = await run(flowOf(async ($) => $.again(await ask($), notes, {})), executor);
  assert.deepEqual(result.value, { notes: "tighter" });
  const [send] = executor.sends;
  assert.deepEqual(send.schema, notes.schema);
  assert.ok(send.prompt.startsWith("list what to improve"), "the step's own prompt, with its effects line");
  assert.ok(!send.prompt.includes("saved in"));
  const events = eventsOf(result);
  assert.equal(startOf(events, "c2").name, "notes");
  assert.deepEqual(startOf(events, "c2").continues, { runId: result.runId, callId: "c1" });
});

test("a step whose effects need another mode than the agent was started with is refused", async () => {
  const before = FENCES.claude.workspace.mode;
  const writes = define({ name: "writes", effects: "workspace", timeout: "5m", returns: { done: text() }, prompt: () => "do it" });
  try {
    const executor = conversation({ firsts: [v1], replies: [{ done: "x" }] });
    FENCES.claude.workspace.mode = "acceptEdits";
    const result = await run(flowOf(async ($) => $.again(await ask($), writes, {})), executor);
    assert.equal(result.outcome, "failed");
    assert.match(result.error.message, /keeps its fence/);
    assert.equal(executor.sends.length, 0);
    assert.equal(of(eventsOf(result), "call.start").length, 1, "nothing was started for it");
  } finally {
    FENCES.claude.workspace.mode = before;
  }
});

test("an agent archived after its answer is woken to be asked again, and archived again", async () => {
  const executor = conversation({ firsts: [v1], replies: [v2] });
  const result = await run(flowOf(async ($) => $.again(await ask($, { archive: "after" }), "more")), executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(executor.archivedAgents, ["fake-agent-1", "fake-agent-1"], "once after each answer, the second time without the flow asking for it");
  const events = eventsOf(result);
  assert.equal(startOf(events, "c2").archive, "after", "the call says it is archived after");
  assert.deepEqual(of(events, "call.archive").map((e) => [e.callId, e.ok]), [["c1", true], ["c2", true]]);

  const kept = conversation({ firsts: [v1], replies: [v2] });
  await run(flowOf(async ($) => $.again(await ask($, { archive: "after" }), "more", { archive: null })), kept);
  assert.deepEqual(kept.archivedAgents, ["fake-agent-1"], "archive: null on the question leaves it as it is");
});

test("fresh: a new agent asked from the previous version, which can be another role", async () => {
  const executor = conversation({ firsts: [v1, v2] });
  const result = await run(flowOf(async ($) => $.again(await ask($), "someone else, please", { fresh: true, role: "worker" })), executor);
  assert.equal(result.outcome, "done");
  assert.equal(executor.sends.length, 0);
  assert.equal(executor.requests.length, 2);
  const [first, second] = executor.requests;
  assert.notEqual(second.provider, first.provider, "the named role, not the first one");
  assert.ok(second.prompt.includes("write about t"), "the original question");
  assert.ok(second.prompt.includes("someone else, please"));
  const saved = second.prompt.match(/saved in (.+)\. Reply/)[1];
  assert.deepEqual(JSON.parse(await readFile(saved, "utf8")), v1);
  assert.equal(second.maxRetries, 0);
  const events = eventsOf(result);
  const c2 = startOf(events, "c2");
  assert.deepEqual([c2.continues, c2.revises], [null, { runId: result.runId, callId: "c1" }]);
  assert.equal(c2.role, "worker");
  assert.notEqual(endOf(events, "c2").agentId, endOf(events, "c1").agentId);
  assert.equal(result.cost.agentCount, 2);

  const same = conversation({ firsts: [v1, v2] });
  await run(flowOf(async ($) => $.again(await ask($), "again", { fresh: true })), same);
  assert.equal(same.requests[1].provider, same.requests[0].provider, "no role named: the same one as before");
});

test("an agent that is gone is replaced by a new one that is given the previous version", async () => {
  const executor = conversation({ firsts: [v1, v2], gone: ["fake-agent-1"] });
  const result = await run(flowOf(async ($) => $.again(await ask($), "polish it")), executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, v2);
  assert.equal(executor.sends.length, 0);
  assert.equal(executor.requests.length, 2);
  assert.match(executor.requests[1].prompt, /polish it[\s\S]*saved in .+answers/);
  assert.ok(result.caveats.some((c) => /agent of c1 is gone/.test(c)), result.caveats.join("|"));
  const c2 = startOf(eventsOf(result), "c2");
  assert.deepEqual([c2.continues, c2.revises], [null, { runId: result.runId, callId: "c1" }]);

  // Another step: the new agent is told where the previous agent's answer is, since the step's prompt has not got it.
  const other = conversation({ firsts: [v1, { notes: "n" }], gone: ["fake-agent-1"] });
  const second = await run(flowOf(async ($) => $.again(await ask($), notes, {})), other);
  assert.match(other.requests[1].prompt, /list what to improve[\s\S]*answer the previous agent gave to draft is saved in .+answers/);
  eventsOf(second);

  // A failure that is not "gone" is the call's own: nothing is asked of a new agent behind its back.
  const broken = conversation({ firsts: [v1, v2] });
  broken.inspect = async () => {
    throw cliError("DAEMON_UNREACHABLE");
  };
  const third = await run(flowOf(async ($) => $.again(await ask($), "x")), broken);
  assert.equal(third.outcome, "failed");
  assert.equal(broken.requests.length, 1);
});

test("a CLI or executor that cannot ask an agent again asks a new agent", async () => {
  const old = conversation({ firsts: [v1, v2], askUnknown: true });
  const result = await run(flowOf(async ($) => $.again(await ask($), "more")), old);
  assert.equal(result.outcome, "done");
  assert.equal(old.sends.length, 0);
  assert.ok(result.caveats.some((c) => /cannot be sent a question with a schema/.test(c)), result.caveats.join("|"));
  assert.equal(startOf(eventsOf(result), "c2").revises.callId, "c1");

  const plain = conversation({ firsts: [v1, v2], noSend: true });
  const second = await run(flowOf(async ($) => $.again(await ask($), "more")), plain);
  assert.equal(second.outcome, "done");
  assert.equal(plain.requests.length, 2);
  assert.ok(second.caveats.some((c) => /cannot be sent to by this executor/.test(c)));
});

test("a send the CLI does not take fails the call and is said", async () => {
  const executor = conversation({ firsts: [v1], replies: [unknownOption("--output-schema")] });
  const result = await run(flowOf(async ($) => $.again(await ask($), "more")), executor);
  assert.equal(result.outcome, "failed");
  assert.ok(result.caveats.some((c) => /fresh: true/.test(c)));
  eventsOf(result);
});

test("only what a call of this run returned is an answer to ask about", async () => {
  const fails = async (value, pattern) => {
    const result = await run(flowOf(async ($) => $.again(await value($), "x")), conversation({ firsts: [v1], replies: [v2] }));
    assert.equal(result.outcome, "failed");
    assert.match(result.error.message, pattern);
  };
  await fails(async ($) => structuredClone(await ask($)), /as it is/);
  await fails(async ($) => (await ask($)).body, /as it is/);
  await fails(async () => null, /as it is/);
  await fails(async () => ({ ...v1 }), /as it is/);
  const other = await run(flowOf(async ($) => ask($)), conversation({ firsts: [v1] }));
  await fails(async () => other.value, /as it is/);
});

test("again's options are checked before anything is asked", async () => {
  const bad = [
    [(a) => ["", {}], /text is what to say/],
    [(a) => ["x", { colour: 1 }], /unknown option colour/],
    [(a) => ["x", { role: "worker" }], /only be given with fresh: true/],
    [(a) => ["x", { cwd: "C:/other" }], /only be given with fresh: true/],
    [(a) => ["x", { fresh: "yes" }], /fresh is true or false/],
    [(a) => [notes, {}, { fresh: true }], /is a \$\.ask/],
    [(a) => ["x", { archive: "now" }], /archive is "after" or null/],
    [(a) => ["x", { check: "nope" }], /check must be a function/],
    [(a) => ["x", { fixes: 9 }], /fixes is how many times/],
  ];
  for (const [args, pattern] of bad) {
    const executor = conversation({ firsts: [v1], replies: [v2] });
    const result = await run(flowOf(async ($) => $.again(await ask($), ...args())), executor);
    assert.equal(result.outcome, "failed", String(pattern));
    assert.match(result.error.message, pattern);
    assert.equal(executor.sends.length + executor.requests.length - 1, 0, "nothing was asked");
  }
});

test("a human sends an answer back in a card: the agent is asked again with the words, not a new one (the shape CONVENTIONS shows)", async () => {
  const rework = (reply) =>
    flowOf(
      async ($) => {
        let doc = await ask($);
        for (let v = 2; ; v += 1) {
          const g = await $.gate({ title: `approve version ${v - 1}`, content: JSON.stringify(doc), timeout: "1m" });
          if (g.approved) return { doc, versions: v - 1 };
          if (v > 3 || !g.reason) $.stop(`version ${v - 1} was not approved`, { doc });
          doc = await $.again(doc, `The reviewer did not approve this version. In their words:\n> ${g.reason}\nChange it as they say.`);
        }
      },
      ["gate:deny"],
    );
  const executor = conversation({ firsts: [v1], replies: [v2, v3], fake: { carrier: "typed", typed: "the body is too short" } });
  const result = await run(rework(), executor);
  assert.equal(result.outcome, "stopped");
  assert.equal(result.stop.reason, "version 3 was not approved");
  assert.deepEqual(result.value.doc, v3);
  assert.deepEqual(executor.sends.map((s) => s.agentId), ["fake-agent-1", "fake-agent-1"], "both rounds went to the agent that wrote it");
  for (const send of executor.sends) assert.match(send.prompt, /> the body is too short/);
  const events = eventsOf(result);
  const asks = of(events, "call.start").filter((e) => e.type === "ask");
  assert.deepEqual(asks.map((e) => e.continues?.callId ?? null), [null, asks[0].callId, asks[1].callId], "each version continues the one before it");

  const approved = conversation({ firsts: [v1], fake: { carrier: "approve" } });
  const done = await run(rework(), approved);
  assert.deepEqual(done.value, { doc: v1, versions: 1 });
  assert.equal(approved.sends.length, 0, "approved: nothing to ask again");
});

test("again-smoke: the second question goes to the first agent and its answer says what it remembers", async () => {
  const executor = conversation({ firsts: [{ color: "teal", recalled: "" }], replies: [{ color: "red", recalled: "Teal" }] });
  const result = await run(againSmoke, executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, { first: "teal", second: "red", recalled: "Teal", remembered: true });
  assert.match(result.summary, /^记得上一轮/);
  assert.equal(executor.sends[0].agentId, "fake-agent-1");
  eventsOf(result);
});
