// A gate that asks for a value with the approval (`$.gate({ input })`), on the fake executor: the flow gets the
// value, and a secret value is nowhere in what the run writes. Nothing here talks to Paseo; the provider's side
// of the same gate is in orchestration-gate/server (input.test.ts, contract.test.ts).
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFlow } from "../runtime/run.mjs";
import { flow } from "../runtime/flow.mjs";
import { readEvents, checkEvents, EventLog } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { requestApproval, prepareGate, inputProblem, INPUT_REDACTED } from "../runtime/gate.mjs";
import { fakeExecutor, carryAs } from "./fake-executor.mjs";

let roster;
let logDir;
const CODE = "483921";

before(async () => {
  roster = await loadRoster([ROLES_DIR]);
  logDir = await mkdtemp(path.join(os.tmpdir(), "orch-input-test-"));
});

const run = (target, options) =>
  runFlow(target, { roster, logDir, cwd: "C:/work", caller: null, gatePollMs: 5, agentProbeDelays: [5, 10, 20], ...options });

/** The events file as text -- the thing a secret must not be in -- and as checked events. */
async function eventsOf(result) {
  const text = await readFile(result.events, "utf8");
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return { text, events };
}

const INPUT = { label: "验证码", pattern: "\\d{6}", hint: "6 位数字" };

/** A flow with one input gate; `after` is what the flow does with the decision. */
const inputFlow = (input = INPUT, after = async () => {}, extra = {}) =>
  flow({
    name: "input-gate",
    description: "d",
    phases: [{ id: "commit", title: "提交" }],
    inputs: {},
    grants: ["gate:deny"],
    run: (_, $) =>
      $.phase("commit", async () => {
        const decision = await $.gate({ title: "批准提交并输入验证码", content: "svn commit -m fix\n", timeout: "1m", input, ...extra });
        await after(decision, $);
        return decision;
      }),
  });

test("$.gate({ input }): the flow gets the value; the request names the field, never the value; the value file is gone", async () => {
  const result = await run(inputFlow(), { executor: fakeExecutor({ carrier: "input", inputValue: CODE }) });
  const d = result.value;
  assert.equal(d.outcome, "allowed");
  assert.equal(d.approved, true);
  assert.equal(d.input, CODE, "the flow holds the value");
  assert.equal(d.answeredVia, "form");

  const { text, events } = await eventsOf(result);
  const start = events.find((e) => e.kind === "call.start");
  assert.deepEqual(start.input, { label: "验证码", secret: true, pattern: "\\d{6}", hint: "6 位数字" }, "secret defaults to true");
  const request = JSON.parse(await readFile(start.requestPath, "utf8"));
  assert.deepEqual(request.input, start.input);
  assert.equal(request.inputPath, path.join(path.dirname(start.holdPath), "c1.input.json"));
  assert.ok(!(await readFile(start.requestPath, "utf8")).includes(CODE));
  assert.equal(existsSync(request.inputPath), false, "taken and deleted");
  assert.ok(result.caveats.some((c) => c.startsWith("gate input:")));

  // The stream: the value is nowhere, and the output says it was used.
  assert.ok(!text.includes(CODE), "the events file does not contain the value");
  const end = events.find((e) => e.kind === "call.end");
  assert.equal(end.output.input, INPUT_REDACTED);
  assert.equal(end.output.outcome, "allowed");
});

test("a secret value is scrubbed from everything the run writes, wherever the flow puts it", async () => {
  const flowWithLeaks = inputFlow(
    INPUT,
    async (decision, $) => {
      $.log.info(`got ${decision.input}`);
      $.log.warn(JSON.stringify({ code: decision.input }));
      await $.do("echo", async () => ({ echoed: decision.input, nested: [`x-${decision.input}-y`], [decision.input]: 1 }));
      await $.do("boom", async () => {
        throw new Error(`the server rejected ${decision.input}`);
      }).catch(() => {});
      throw new Error(`failing with ${decision.input}`);
    },
  );
  const result = await run(flowWithLeaks, { executor: fakeExecutor({ carrier: "input", inputValue: CODE }) });
  assert.equal(result.outcome, "failed");
  const text = await readFile(result.events, "utf8");
  const events = readEvents(result.events);
  assert.ok(!text.includes(CODE), `the value is in the events file: ${text.split("\n").filter((l) => l.includes(CODE)).join("\n").slice(0, 300)}`);
  assert.ok(text.includes(`got ${INPUT_REDACTED}`), "the line is still there, with the stand-in");
  assert.ok(events.find((e) => e.kind === "run.end").error.message.includes(`failing with ${INPUT_REDACTED}`));
  // The envelope is not touched: a value that looks like a timestamp fragment cannot eat one.
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  // Nothing else the runtime wrote under the run's directory has it either.
  const runDir = path.join(logDir, "runs", result.runId);
  for (const file of existsSync(runDir) ? await readdir(runDir, { recursive: true, withFileTypes: true }) : []) {
    if (!file.isFile()) continue;
    assert.ok(!(await readFile(path.join(file.parentPath, file.name), "utf8")).includes(CODE), `${file.name} holds the value`);
  }
});

test("EventLog.addSecret: both spellings, keys and arrays, and not the envelope", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-scrub-"));
  const log = new EventLog({ dir, runId: "r-2026" });
  log.addSecret('a"b\\c2026');
  log.emit("log", { level: "info", message: 'x a"b\\c2026 y', json: JSON.stringify({ v: 'a"b\\c2026' }), list: ['a"b\\c2026'], 'a"b\\c2026': 1 });
  const text = await readFile(log.file, "utf8");
  assert.ok(!text.includes("c2026"), text);
  assert.ok(text.includes('"runId":"r-2026"'), "the envelope's own fields are not scrubbed");
  assert.equal(JSON.parse(text).message, `x ${INPUT_REDACTED} y`);
  assert.ok(!JSON.stringify(log.events).includes("c2026"), "nor the in-memory copy");
});

test("secret: false keeps the value in the call's output, and says so in the caveat", async () => {
  const result = await run(inputFlow({ label: "备注", secret: false }), { executor: fakeExecutor({ carrier: "input", inputValue: "ship it" }) });
  assert.equal(result.value.input, "ship it");
  const { events } = await eventsOf(result);
  assert.equal(events.find((e) => e.kind === "call.end").output.input, "ship it");
  assert.ok(result.caveats.some((c) => c.includes("secret: false")));
});

test("not approved means no value, whatever else happened", async () => {
  const cases = [
    ["deny", { carrier: "deny" }, "denied"],
    ["typed", { carrier: "typed", typed: "改一下" }, "denied"],
    ["cli-deny", { carrier: "cli-deny" }, "denied"],
  ];
  for (const [name, options, outcome] of cases) {
    const result = await run(inputFlow(), { executor: fakeExecutor(options) });
    assert.equal(result.value.outcome, outcome, name);
    assert.equal(result.value.input, null, name);
    assert.equal(result.value.approved, false, name);
  }
  const typed = await run(inputFlow(), { executor: fakeExecutor({ carrier: "typed", typed: "改一下第 2 行" }) });
  assert.equal(typed.value.reason, "改一下第 2 行", "typed words are still the reason: the field and the conversation stay apart");
  const expired = await run(inputFlow(INPUT, async () => {}, { timeout: "1s" }), { executor: fakeExecutor({ carrier: "hang" }) });
  assert.equal(expired.value.outcome, "expired");
  assert.equal(expired.value.input, null);
});

test("an allow without a value, with a lost value file, or with one that does not fit is an error, never an approval", async () => {
  const noValue = await run(inputFlow(), { executor: fakeExecutor({ carrier: "cli-allow" }) });
  assert.equal(noValue.value.outcome, "error");
  assert.equal(noValue.value.approved, false);
  assert.equal(noValue.value.input, null);
  assert.match(noValue.value.reason, /asks for a value, but the allow on record carries none/);

  const lost = await run(inputFlow(), { executor: fakeExecutor({ carrier: "input-lost" }) });
  assert.equal(lost.value.outcome, "error");
  assert.match(lost.value.reason, /its file is missing/);

  const SNEAKY = "12ab56";
  const bad = await run(inputFlow(), { executor: fakeExecutor({ carrier: "input-bad", inputValue: SNEAKY }) });
  assert.equal(bad.value.outcome, "error", "the runtime checks the pattern again: a carrier that did not is not trusted");
  assert.equal(bad.value.input, null);
  assert.match(bad.value.reason, /not acceptable: does not match the pattern/);
  const { text } = await eventsOf(bad);
  assert.ok(!text.includes(SNEAKY), "a rejected value is not echoed into the stream either");

  const short = await run(inputFlow({ label: "码" }), { executor: fakeExecutor({ carrier: "input", inputValue: "123" }) });
  assert.equal(short.value.outcome, "error", "a secret too short to scrub is not taken");
  assert.match(short.value.reason, /shorter than 4 characters/);
});

test("$.gate({ input }) is checked at the call", async () => {
  const refused = async (input, message, options = {}) => {
    const result = await run(inputFlow(input), { executor: fakeExecutor({ carrier: "input" }), ...options });
    assert.equal(result.outcome, "failed", JSON.stringify(input));
    assert.match(result.error.message, message);
  };
  await refused("验证码", /input must be \{ label/);
  await refused({}, /input\.label must be a non-empty string/);
  await refused({ label: "x", secret: "yes" }, /input\.secret must be a boolean/);
  await refused({ label: "x", pattern: "(" }, /input\.pattern is not a regular expression/);
  await refused({ label: "x", pattern: 5 }, /input\.pattern must be a string/);
  await refused({ label: "x", colour: "red" }, /unknown option|colour/);
  // A model carrier cannot take a value: refused at the call, before any card.
  const modelGate = { ...roster, roles: { ...roster.roles, gate: roster.roles.fast } };
  await refused(INPUT, /needs the orch-gate provider as its carrier/, { roster: modelGate, executor: fakeExecutor({ providers: [] }) });
});

test("requestApproval: the value file is cleared before the gate starts and deleted after, whatever the outcome", async () => {
  const prepare = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orch-input-gate-"));
    return prepareGate({
      carrier: "provider",
      holdPath: path.join(dir, "gate", "c1.receipt.txt"),
      title: "批准",
      content: "x\n",
      runId: "run-1",
      callId: "c1",
      timeout: "1m",
      input: { label: "验证码", secret: true, pattern: "\\d{6}", hint: "" },
    });
  };
  const io = (act) => ({
    spawn: async (prompt) => {
      await act(prompt);
      return "agent";
    },
    inspect: async () => ({ status: "idle" }),
    deny: async () => {},
    stop: async () => {},
    transcript: async () => "",
  });
  const { writeFile, mkdir } = await import("node:fs/promises");

  // A value left at the path by an earlier gate is not this gate's.
  const stale = await prepare();
  await mkdir(path.dirname(stale.inputPath), { recursive: true });
  await writeFile(stale.inputPath, JSON.stringify({ v: 1, value: "999999" }), "utf8");
  const refusedStale = await requestApproval(io((p) => carryAs("cli-allow", p, {})), stale, { pollMs: 5 });
  assert.notEqual(refusedStale.input, "999999");
  assert.equal(refusedStale.outcome, "error");
  assert.equal(existsSync(stale.inputPath), false);

  for (const carrier of ["input", "deny", "input-bad", "input-lost"]) {
    const gate = await prepare();
    await requestApproval(io((p) => carryAs(carrier, p, { inputValue: carrier === "input-bad" ? "xx" : CODE })), gate, { pollMs: 5 });
    assert.equal(existsSync(gate.inputPath), false, `${carrier}: nothing is left on disk`);
  }
  // An ordinary gate has no value file and its decision has no `input`.
  const plain = await prepareGate({ carrier: "provider", holdPath: path.join(await mkdtemp(path.join(os.tmpdir(), "orch-plain-")), "c1.receipt.txt"), title: "t", content: "x", runId: "r", callId: "c1" });
  assert.equal(plain.inputPath, null);
  const decision = await requestApproval(io((p) => carryAs("approve", p, {})), plain, { pollMs: 5 });
  assert.equal(decision.outcome, "allowed");
  assert.equal("input" in decision, false);
});

test("inputProblem matches the plugin's rule", () => {
  const rule = { secret: true, pattern: "\\d{6}" };
  assert.equal(inputProblem(CODE, rule), null);
  assert.equal(inputProblem("1234567", rule), "does not match the pattern", "the whole value, not a part");
  assert.equal(inputProblem("", rule), "no value");
  assert.equal(inputProblem("abc", { secret: true, pattern: null }), "shorter than 4 characters");
  assert.equal(inputProblem("abc", { secret: false, pattern: null }), null);
  assert.equal(inputProblem("a".repeat(1001), { secret: false, pattern: null }), "longer than 1000 characters");
});

test("a model carrier cannot be asked to prepare an input gate", () => {
  assert.throws(
    () => prepareGate({ carrier: "model", holdPath: "C:/x/c1.receipt.txt", title: "t", content: "x", runId: "r", callId: "c1", input: { label: "x", secret: true, pattern: null, hint: "" } }),
    /needs the orch-gate provider/,
  );
});
