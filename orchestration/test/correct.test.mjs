// `$.ask` with `check` and `fixes`: an answer that does not pass is sent back to the agent that gave it, with only what is
// wrong, and merged. The executor is a fake that answers from a script; nothing talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFlow } from "../runtime/run.mjs";
import { flow, define, text, list } from "../runtime/flow.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { PaseoCliError } from "../runtime/paseo-cli.mjs";
import { CheckFailed } from "../runtime/answer.mjs";
import { fakeExecutor } from "./fake-executor.mjs";

let roster;
let logDir;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
  logDir = await mkdtemp(path.join(os.tmpdir(), "orch-correct-"));
});
after(() => rm(logDir, { recursive: true, force: true }));

const patch = define({
  name: "patch",
  effects: "none",
  timeout: "5m",
  returns: { headline: text("one line"), messages: list(text("a commit message")), note: text() },
  prompt: () => "write the patch",
});
const good = { headline: "h", messages: ["a {code}", "b {code}", "c {code}"], note: "n" };

const cliError = (code, details, stderr = "") => new PaseoCliError("paseo failed", { argv: ["run"], exitCode: 1, stdout: "", stderr, code, details });
/** What `paseo run --output-schema --max-retries 0` does with a reply that does not fit. */
const refused = (reply, validationErrors = []) => cliError("OUTPUT_SCHEMA_FAILED", { lastResponse: typeof reply === "string" ? reply : JSON.stringify(reply), validationErrors });
const unknownOption = (option) => new PaseoCliError("paseo failed", { argv: ["run"], exitCode: 1, stdout: "", stderr: `error: unknown option '${option}'\n` });

const withFirst = (first, options = {}) => {
  const base = fakeExecutor({
    answer: () => {
      if (first instanceof Error) throw first;
      return first;
    },
    ...options.fake,
  });
  const queue = [...(options.replies ?? [])];
  const sends = [];
  const asks = [];
  const executor = {
    ...base,
    sends,
    asks,
    ask: async (request) => {
      asks.push(request);
      if (options.askUnknown && request.maxRetries !== undefined) throw unknownOption(options.askUnknown);
      return base.ask(request);
    },
  };
  if (!options.noSend) {
    executor.send = async (request) => {
      sends.push(request);
      if (options.sendUnknown) throw unknownOption(options.sendUnknown);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(request) : next;
    };
  }
  return executor;
};

const asking = (askOptions, body = null) =>
  flow({
    name: "correcting",
    description: "d",
    phases: [{ id: "write", title: "写" }],
    inputs: {},
    grants: [],
    run: (_, $) => $.phase("write", () => (body ? body($, askOptions) : $.ask(patch, {}, { role: "fast", ...askOptions }))),
  });

const run = (f, executor, options = {}) => runFlow(f, { roster, logDir, cwd: "C:/work", caller: null, agentProbeDelays: [5, 10], executor, ...options });

function eventsOf(result) {
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return events;
}
const of = (events, kind) => events.filter((e) => e.kind === kind);
const noCode = (a) => a.messages.flatMap((m, i) => (m.includes("{code}") ? [] : [{ at: `/messages/${i}`, say: "needs a {code} placeholder" }]));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test("a reply with a field the schema does not declare loses the field and is not sent back", async () => {
  const executor = withFirst(refused({ ...good, extra: "x" }, ["(root): must NOT have additional properties"]));
  const result = await run(asking({}), executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, good);
  assert.equal(executor.sends.length, 0);
  assert.equal(executor.asks[0].maxRetries, 0, "the CLI is told not to retry; the runner corrects");
  const events = eventsOf(result);
  assert.equal(of(events, "call.fix").length, 0);
  assert.equal(of(events, "call.end")[0].rounds, 1);
  assert.match(of(events, "log").find((l) => l.level === "info").message, /dropped: \/extra/);
});

test("a missing field is asked for alone, in the same agent, and merged", async () => {
  const { note, ...short } = good;
  const executor = withFirst(refused(short, ["(root): must have required property 'note'"]), { replies: [{ f1: "fixed note" }] });
  const result = await run(asking({}), executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, { ...good, note: "fixed note" });

  assert.equal(executor.requests.length, 1, "no second agent");
  const [send] = executor.sends;
  assert.equal(send.agentId, "fake-agent-1");
  assert.deepEqual(Object.keys(send.schema.properties), ["f1"]);
  assert.equal(send.schema.properties.f1.type, "string");
  assert.match(send.prompt, /f1 = note: is missing/);
  assert.ok(!send.prompt.includes("write the patch"), "the prompt is not sent again");
  assert.match(send.timeout, /^\d+s$/);
  assert.ok(send.file.endsWith(path.join("prompts", "c1.r2.txt")), send.file);

  const events = eventsOf(result);
  const [fix] = of(events, "call.fix");
  const [fixed] = of(events, "call.fixed");
  assert.equal(fix.round, 2);
  assert.deepEqual(fix.problems, [{ at: "/note", say: "is missing" }]);
  assert.equal(fix.prompt, send.prompt);
  assert.deepEqual(fix.schema, send.schema);
  assert.deepEqual([fixed.round, fixed.ok, fixed.answer], [2, true, { f1: "fixed note" }]);
  assert.deepEqual(fixed.cost, { usd: 0.01, inputTokens: 1200, outputTokens: 300 });
  const end = of(events, "call.end")[0];
  assert.equal(end.rounds, 2);
  assert.equal(end.ok, true);
  near(end.cost.usd, 0.02);
  assert.equal(end.cost.inputTokens, 2400);
  near(result.cost.totalUsd, 0.02);
  assert.ok(fix.seq < fixed.seq && fixed.seq < end.seq);
  assert.equal(of(events, "call.agent").filter((e) => e.callId === "c1").length, 1, "the agent is announced once");
});

test("a check that points at two places gets them back as f1 and f2, each at its own index", async () => {
  const first = { ...good, messages: ["a", "b {code}", "c"] };
  const executor = withFirst(first, { replies: [{ f1: "a {code}", f2: "c {code}" }] });
  const result = await run(asking({ check: noCode }), executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value.messages, ["a {code}", "b {code}", "c {code}"]);
  const [send] = executor.sends;
  assert.deepEqual(Object.keys(send.schema.properties), ["f1", "f2"]);
  assert.match(send.prompt, /f1 = messages\[0\]: needs a \{code\} placeholder\n\s+now: "a"/);
  assert.match(send.prompt, /f2 = messages\[2\]/);
  assert.ok(!send.prompt.includes("b {code}"), "what passed is not repeated");
  assert.equal(executor.sends.length, 1);
});

test("a check is given a copy and the round it is looking at", async () => {
  const seen = [];
  const executor = withFirst(good, { replies: [] });
  await run(
    asking({
      check: (a, info) => {
        seen.push(info.round);
        a.note = "changed by the check";
        return [];
      },
    }),
    executor,
  ).then((r) => assert.equal(r.value.note, "n"));
  assert.deepEqual(seen, [1]);
});

test("a check that says the answer as a whole is wrong gets the whole answer back, against the step's own schema", async () => {
  const executor = withFirst(good, { replies: [{ ...good, headline: "again" }] });
  let looks = 0;
  const result = await run(asking({ check: (a) => (looks++ === 0 ? "not what was asked" : a.headline === "again" ? [] : "still no") }), executor);
  assert.equal(result.value.headline, "again");
  assert.deepEqual(executor.sends[0].schema, patch.schema);
  assert.match(executor.sends[0].prompt, /whole answer again/);
  assert.match(executor.sends[0].prompt, /not what was asked/);
});

test("a reply that does not fit leaves its place alone and is asked for again", async () => {
  const first = { ...good, note: "n", messages: ["a", "b {code}", "c {code}"] };
  const executor = withFirst(first, { replies: [{ f1: 42 }, refused("sorry, no JSON here"), { f1: "a {code}" }] });
  const result = await run(asking({ check: noCode, fixes: 3 }), executor);
  assert.equal(result.outcome, "done");
  assert.equal(result.value.messages[0], "a {code}");
  assert.equal(executor.sends.length, 3);
  const events = eventsOf(result);
  assert.deepEqual(of(events, "call.fixed").map((e) => [e.round, e.ok]), [[2, false], [3, false], [4, true]]);
  assert.equal(of(events, "call.fixed")[1].answer, "sorry, no JSON here", "what could not be read is kept as it came");
  assert.equal(of(events, "call.end")[0].rounds, 4);
});

test("the corrections run out: CheckFailed, and a run that does not catch it stops", async () => {
  const wrong = { ...good, messages: ["a", "b {code}", "c {code}"] };
  const executor = withFirst(wrong, { replies: [{ f1: "still a" }, { f1: "again a" }] });
  const result = await run(asking({ check: noCode }), executor);
  assert.equal(result.outcome, "stopped");
  assert.equal(result.ok, true);
  assert.equal(result.stop.reason, "patch：核对 3 轮还不过：/messages/0 needs a {code} placeholder");
  assert.deepEqual([result.stop.kind, result.stop.step], ["check", "patch"], "a reader acts on the kind, not on the words of the reason");
  assert.equal(result.stop.phase, "write");
  assert.equal(result.error, null);
  assert.equal(executor.sends.length, 2, "fixes defaults to two");
  const events = eventsOf(result);
  const end = of(events, "call.end")[0];
  assert.equal(end.ok, false);
  assert.equal(end.rounds, 3);
  assert.equal(end.error.name, "CheckFailed");
  assert.equal(end.output.messages[0], "again a", "the last merged answer is kept");
  near(end.cost.usd, 0.03);
  near(result.cost.totalUsd, 0.03);
});

test("a flow can catch CheckFailed and decide for itself", async () => {
  const executor = withFirst({ ...good, messages: ["a"] }, { replies: [{ f1: "b" }] });
  const f = asking({ check: noCode, fixes: 1 }, async ($, options) => {
    try {
      return await $.ask(patch, {}, { role: "fast", ...options });
    } catch (error) {
      assert.ok(error instanceof CheckFailed);
      return { gaveUp: true, rounds: error.rounds, problems: error.problems, value: error.value };
    }
  });
  const result = await run(f, executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, { gaveUp: true, rounds: 2, problems: [{ at: "/messages/0", say: "needs a {code} placeholder" }], value: { ...good, messages: ["b"] } });
  eventsOf(result);
});

test("a check that throws is a failed call, not a round", async () => {
  const executor = withFirst(good);
  const result = await run(asking({ check: () => { throw new RangeError("the check is broken"); } }), executor);
  assert.equal(result.outcome, "failed");
  assert.equal(result.error.name, "RangeError");
  assert.equal(executor.sends.length, 0);
  const end = of(eventsOf(result), "call.end")[0];
  assert.deepEqual([end.ok, end.rounds], [false, 1]);
  const bad = await run(asking({ check: () => [{ at: "messages/0", say: "x" }] }), withFirst(good));
  assert.equal(bad.outcome, "failed");
  assert.match(bad.error.message, /JSON pointer/);
});

test("a problem at a place the answer does not have is asked for as the list that holds it", async () => {
  const executor = withFirst(good, { replies: [{ f1: ["a {code}"] }] });
  const result = await run(asking({ check: (a) => (a.messages.length === 1 ? [] : [{ at: "/messages/7", say: "there must be one message" }]) }), executor);
  assert.deepEqual(result.value.messages, ["a {code}"]);
  assert.deepEqual(executor.sends[0].schema.properties.f1.type, "array");
  assert.match(of(eventsOf(result), "log").find((l) => l.level === "warn").message, /\/messages\/7/);
});

test("a send that fails fails the call, and the turn it cost is counted", async () => {
  const executor = withFirst({ ...good, messages: ["a"] }, { replies: [cliError("AGENT_TIMEOUT", null)] });
  const result = await run(asking({ check: noCode }), executor);
  assert.equal(result.outcome, "failed");
  assert.equal(result.error.name, "PaseoCliError");
  const events = eventsOf(result);
  assert.equal(of(events, "call.fixed").length, 0);
  const end = of(events, "call.end")[0];
  assert.equal(end.rounds, 1);
  near(end.cost.usd, 0.02);
});

test("an executor that cannot send, or an agent that cannot be found, ends a failing check without a round", async () => {
  const wrong = { ...good, messages: ["a"] };
  const plain = await run(asking({ check: noCode }), withFirst(wrong, { noSend: true }));
  assert.equal(plain.outcome, "stopped");
  assert.match(plain.stop.reason, /核对 1 轮还不过/);
  assert.equal(plain.caveats.length >= 0, true);
  eventsOf(plain);

  const lost = withFirst(wrong, { fake: {} });
  lost.findAgent = async () => null;
  const result = await run(asking({ check: noCode }), lost);
  assert.equal(result.outcome, "stopped");
  assert.equal(lost.sends.length, 0);
  assert.ok(result.caveats.some((c) => /could not be found/.test(c)), result.caveats.join("|"));
});

test("a schema problem with nothing to send it back through is the old OutputMismatch", async () => {
  const result = await run(asking({}), withFirst({ headline: "h" }, { noSend: true }));
  assert.equal(result.outcome, "failed");
  assert.equal(result.error.name, "OutputMismatch");
  assert.match(result.error.message, /\/messages is missing/);
});

test("an older CLI is asked the old way, once, and the run says so", async () => {
  const wrong = { ...good, messages: ["a"] };
  const executor = withFirst(wrong, { askUnknown: "--max-retries" });
  const f = asking({ check: noCode }, async ($, options) => {
    const out = [];
    for (let i = 0; i < 2; i += 1) {
      out.push(await $.ask(patch, {}, { role: "fast", ...options, check: undefined }));
    }
    return out.length;
  });
  const result = await run(f, executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(executor.asks.map((a) => a.maxRetries), [0, undefined, undefined], "refused once; the second call does not try again");
  assert.equal(result.caveats.filter((c) => /--max-retries/.test(c)).length, 1);
  assert.equal(executor.requests.length, 2, "the refused ask started no agent");
  eventsOf(result);

  const checked = await run(asking({ check: noCode }), withFirst(wrong, { askUnknown: "--max-retries" }));
  assert.equal(checked.outcome, "stopped");
  assert.match(checked.stop.reason, /核对 1 轮还不过/);
});

test("a send that the CLI does not know the option of is the old way too, and costs nothing", async () => {
  const executor = withFirst({ ...good, messages: ["a"] }, { sendUnknown: "--output-schema" });
  const result = await run(asking({ check: noCode }), executor);
  assert.equal(result.outcome, "stopped");
  assert.ok(result.caveats.some((c) => /send/.test(c)));
  const events = eventsOf(result);
  assert.equal(of(events, "call.fixed").length, 0);
  const end = of(events, "call.end")[0];
  assert.equal(end.rounds, 1);
  near(end.cost.usd, 0.01);
});

test("fixes: 0 leaves the CLI to retry as it did, and a failing check ends the call at once", async () => {
  const executor = withFirst({ ...good, messages: ["a"] });
  const result = await run(asking({ check: noCode, fixes: 0 }), executor);
  assert.equal(executor.asks[0].maxRetries, undefined);
  assert.equal(result.outcome, "stopped");
  assert.equal(executor.sends.length, 0);
  assert.match(result.stop.reason, /核对 1 轮/);
});

test("check and fixes are checked before anything is spent", async () => {
  const executor = withFirst(good);
  for (const options of [{ check: "nope" }, { fixes: -1 }, { fixes: 1.5 }, { fixes: 99 }, { checks: noCode }]) {
    const result = await run(asking(options), executor);
    assert.equal(result.outcome, "failed", JSON.stringify(options));
    assert.equal(result.error.name, "TypeError");
  }
  assert.equal(executor.requests.length, 0);
});

test("a run that has ended sends nothing more", async () => {
  const executor = withFirst({ ...good, messages: ["a"] });
  executor.send = async (request) => {
    executor.sends.push(request);
    await new Promise((r) => setTimeout(r, 1_200));
    return { f1: "b" };
  };
  const f = asking({}, ($, options) => {
    $.ask(patch, {}, { role: "fast", ...options, check: noCode, fixes: 3 }).catch(() => {});
    return new Promise(() => {});
  });
  const result = await run(f, executor, { timeout: "1s" });
  assert.equal(result.outcome, "timeout");
  const events = eventsOf(result);
  const [end] = of(events, "call.end");
  assert.deepEqual([end.ok, end.error.name, end.rounds], [false, "RunEnded", 1]);
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(executor.sends.length, 1, "the answer that came back after the end was not sent back again");
});

test("answer-smoke: the first tag cannot pass, so one field goes back to the same agent", async () => {
  const smoke = (await import("../flows/answer-smoke.mjs")).default;
  const executor = withFirst({ color: "teal", tag: "teal" }, { replies: [{ f1: "TEL-1" }] });
  const result = await run(smoke, executor);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, { color: "teal", tag: "TEL-1" });
  assert.equal(result.summary, "teal · TEL-1");
  assert.deepEqual(Object.keys(executor.sends[0].schema.properties), ["f1"]);
  assert.equal(of(eventsOf(result), "call.end")[0].rounds, 2);
});

test("a correction that gets no answer fails the call and is not a round", async () => {
  const wrong = { ...good, messages: ["a"] };
  const silent = [
    ["an empty reply the CLI refused", cliError("OUTPUT_SCHEMA_FAILED", { validationErrors: ["(root): must be object"], lastResponse: "" })],
    ["a failure with no reply at all", cliError("OUTPUT_SCHEMA_FAILED", null)],
    ["nothing printed", null],
  ];
  for (const [label, reply] of silent) {
    const executor = withFirst(wrong, { replies: [reply] });
    const result = await run(asking({ check: noCode }), executor);
    assert.equal(result.outcome, "failed", label);
    const events = eventsOf(result);
    assert.equal(of(events, "call.fixed").length, 0, label);
    const end = of(events, "call.end")[0];
    assert.deepEqual([end.ok, end.rounds], [false, 1], label);
    near(end.cost.usd, 0.02);
  }
  const text = withFirst(wrong, { replies: [refused("I would rather not."), { f1: "a {code}" }] });
  const result = await run(asking({ check: noCode }), text);
  assert.equal(result.outcome, "done", "a reply with words in it is an answer, if a wrong one: the next round asks again");
  assert.equal(of(eventsOf(result), "call.end")[0].rounds, 3);
});
