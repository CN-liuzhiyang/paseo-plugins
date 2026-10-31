// An answer is corrected, and its extra fields dropped, only as far as answer.mjs reads the schema: a schema with rules it cannot see
// (minLength, patternProperties, $ref...) is corrected as a whole and judged by the CLI, and what the CLI refuses is not taken for fixed.
// A fake executor answers from a script. Nothing here talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { runFlow } from "../runtime/run.mjs";
import { flow, define, text } from "../runtime/flow.mjs";
import { readEvents } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { PaseoCliError } from "../runtime/paseo-cli.mjs";
import { fixErrors, planFix, readsFully, stripUndeclared } from "../runtime/answer.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

/** What `paseo send --output-schema` does with a reply that does not fit. */
const refused = (reply, validationErrors) =>
  new PaseoCliError("paseo failed", { argv: ["send"], exitCode: 1, stdout: "", stderr: "", code: "OUTPUT_SCHEMA_FAILED", details: { lastResponse: JSON.stringify(reply), validationErrors } });
const run = async (step, askOptions, { first, replies = [] }) => {
  const base = fakeExecutor({ answer: () => first });
  const sends = [];
  const queue = [...replies];
  const executor = {
    ...base,
    sends,
    send: async (request) => {
      sends.push(request);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const result = await runFlow(flow({ name: "vocab-test", description: "d", phases: [], inputs: {}, grants: [], run: (_, $) => $.ask(step, {}, { role: "fast", ...askOptions }) }), {
    roster,
    caller: null,
    executor,
    cwd: "C:/work",
    logDir: await tempDir("orch-vocab-"),
    agentProbeDelays: [5],
  });
  return { result, sends, events: readEvents(result.events) };
};

test("which schemas answer.mjs reads completely", () => {
  const plain = { type: "object", properties: { a: { type: "string", description: "x" }, b: { type: "array", items: { type: "number" } } }, required: ["a", "b"], additionalProperties: false };
  assert.equal(readsFully(plain), true);
  for (const schema of [
    { type: "object", properties: { tag: { type: "string", minLength: 5 } }, required: ["tag"], additionalProperties: false },
    { type: "object", properties: {}, patternProperties: { "^x": { type: "string" } }, additionalProperties: false },
    { type: "object", properties: { plan: { $ref: "#/$defs/Plan" } }, $defs: { Plan: { type: "object" } } },
    { type: "object", properties: { a: { oneOf: [{ type: "string" }, { type: "number" }] } } },
    { type: "object", additionalProperties: false },
    { type: "object", required: ["a"] },
    { type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "string" } },
  ]) {
    assert.equal(readsFully(schema), false, JSON.stringify(schema));
  }
});

test("fields the schema declares some other way than `properties` are kept; fields it does not declare at all are still dropped", () => {
  const dynamic = { type: "object", properties: {}, patternProperties: { "^x": { type: "string" } }, additionalProperties: false };
  assert.deepEqual(stripUndeclared(dynamic, { x1: "keep" }), { value: { x1: "keep" }, dropped: [] });
  const wrapped = { type: "object", properties: { data: dynamic, note: { type: "string" } }, required: ["data", "note"], additionalProperties: false };
  assert.deepEqual(stripUndeclared(wrapped, { data: { x1: "keep" }, note: "n", extra: 1 }), { value: { data: { x1: "keep" }, note: "n" }, dropped: ["/extra"] });
  const combined = { type: "object", properties: { a: { type: "string" } }, allOf: [{ properties: { b: { type: "string" } } }], additionalProperties: false };
  assert.deepEqual(stripUndeclared(combined, { a: "1", b: "2" }).dropped, [], "a field some other keyword may declare is not dropped");
});

test("a schema with a `$ref` is corrected as a whole, with the whole schema and its definitions", () => {
  const schema = { type: "object", properties: { plan: { $ref: "#/$defs/Plan" } }, required: ["plan"], additionalProperties: false, $defs: { Plan: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } } };
  const plan = planFix(schema, { plan: { title: "old" } }, [{ at: "/plan/title", say: "revise" }]);
  assert.equal(plan.whole, true);
  assert.equal(plan.schema, schema, "the schema the CLI is given holds what `$ref` points to");
  assert.deepEqual(plan.problems, [{ at: "/plan/title", say: "revise" }]);
});

test("what the CLI refused in a correction's reply is a problem of the answer at the place the reply stood for", () => {
  const plan = { whole: false, items: [{ key: "f1", at: "/steps/2/title" }, { key: "f2", at: "/note" }] };
  assert.deepEqual(fixErrors(plan, [{ at: "/f1", say: "too short" }, { at: "/f2/x", say: "bad" }, { at: "", say: "required property f2" }, { at: "/f9", say: "?" }]), [
    { at: "/steps/2/title", say: "too short" },
    { at: "/note/x", say: "bad" },
    { at: "", say: "required property f2" },
    { at: "", say: "/f9 ?" },
  ]);
  assert.deepEqual(fixErrors({ whole: true }, [{ at: "/a", say: "b" }]), [{ at: "/a", say: "b" }]);
});

test("a correction the CLI refuses as not fitting the schema is not counted as fixed, even when answer.mjs cannot see why", async () => {
  const schema = { type: "object", properties: { tag: { type: "string", minLength: 5 } }, required: ["tag"], additionalProperties: false };
  const step = define({ name: "tag", effects: "none", timeout: "5m", returns: schema, prompt: () => "give a tag" });
  const check = (answer) => (answer.tag === "draft" ? [{ at: "/tag", say: "replace draft" }] : []);
  const { result, sends, events } = await run(step, { check }, {
    first: { tag: "draft" },
    replies: [refused({ tag: "x" }, [{ instancePath: "/tag", message: "must NOT have fewer than 5 characters" }]), refused({ tag: "y" }, [{ instancePath: "/tag", message: "must NOT have fewer than 5 characters" }]), refused({ tag: "z" }, [{ instancePath: "/tag", message: "must NOT have fewer than 5 characters" }])],
  });
  assert.equal(result.outcome, "stopped", "never fixed: not done with a tag that is too short");
  assert.match(result.stop.reason, /fewer than 5 characters/);
  assert.equal(sends.length >= 2, true);
  const fixed = events.filter((e) => e.kind === "call.fixed");
  assert.equal(fixed.length > 0 && fixed.every((e) => e.ok === false), true);
  // The whole schema was what the correction was asked under: the CLI is the judge of a rule this module cannot read.
  assert.deepEqual(sends[0].schema, schema);
  // The complaint of the CLI is what the next round is told.
  assert.equal(events.filter((e) => e.kind === "call.fix")[1].problems.some((p) => /fewer than 5/.test(p.say)), true);
});

test("a correction by place that the CLI refuses is told back at the place it was about", async () => {
  const step = define({ name: "pair", effects: "none", timeout: "5m", returns: { tag: text("a tag"), note: text("a note") }, prompt: () => "give both" });
  const check = (answer) => (answer.tag === "draft" ? [{ at: "/tag", say: "replace draft" }] : []);
  const { result, events } = await run(step, { check }, {
    first: { tag: "draft", note: "n" },
    replies: [refused({ f1: "" }, [{ instancePath: "/f1", message: "refused by the CLI" }]), { f1: "final" }],
  });
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, { tag: "final", note: "n" });
  const fixes = events.filter((e) => e.kind === "call.fix");
  assert.equal(fixes.length, 2);
  assert.equal(fixes[1].problems.some((p) => p.at === "/tag" && /refused by the CLI/.test(p.say)), true);
});

test("data a `patternProperties` schema declares survives a successful reply", async () => {
  const schema = { type: "object", properties: { data: { type: "object", properties: {}, patternProperties: { "^x": { type: "string" } }, additionalProperties: false } }, required: ["data"], additionalProperties: false };
  const step = define({ name: "dynamic", effects: "none", timeout: "5m", returns: schema, prompt: () => "answer" });
  const { result } = await run(step, {}, { first: { data: { x1: "keep" } } });
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.value, { data: { x1: "keep" } });
});
