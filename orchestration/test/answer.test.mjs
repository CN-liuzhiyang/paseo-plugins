// The pure half of correcting an answer in place: pointers, reading a reply, finding what is wrong, planning the correction.
//
//   node --test        (from orchestration/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckFailed, MAX_PLACES, applyFix, extractJson, fixPrompt, normalizeProblems, planFix, pointer, problemsOf, schemaFailure, segmentsOf, stripUndeclared } from "../runtime/answer.mjs";
import { objectSchema, text, count, choice, list, group } from "../runtime/step.mjs";
import { PaseoCliError, describeFailure, errorBody, unknownOption } from "../runtime/paseo-cli.mjs";

const schema = objectSchema({
  headline: text("one line"),
  edits: list(group({ file: text(), old: text("the text to replace"), hits: count() })),
  verdict: choice(["ship", "hold"]),
});
const answer = () => ({
  headline: "h",
  edits: [
    { file: "a.lua", old: "x", hits: 1 },
    { file: "b.lua", old: "y", hits: 2 },
    { file: "c.lua", old: "z", hits: 1 },
  ],
  verdict: "ship",
});

test("pointer: keys with / and ~ are escaped, and read back the same", () => {
  assert.equal(pointer("edits", 4, "old"), "/edits/4/old");
  assert.equal(pointer(), "");
  const odd = pointer("a/b", "c~d");
  assert.equal(odd, "/a~1b/c~0d");
  assert.deepEqual(segmentsOf(odd), ["a/b", "c~d"]);
  assert.throws(() => segmentsOf("edits/4"), /JSON pointer/);
});

test("extractJson: a fenced block, an object among prose, or nothing", () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a": 1}\n```\nbye'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a": "}{", "b": [1, 2]} hope that helps'), { a: "}{", b: [1, 2] });
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
  assert.equal(extractJson("I could not do that."), undefined);
  assert.equal(extractJson(""), undefined);
});

test("stripUndeclared: only fields the schema forbids, at any depth, and where they were", () => {
  const value = answer();
  value.extra = 1;
  value.edits[1].why = "because";
  const { value: kept, dropped } = stripUndeclared(schema, value);
  assert.deepEqual(kept, answer());
  assert.deepEqual(dropped.sort(), ["/edits/1/why", "/extra"]);
  assert.equal(value.extra, 1, "the original is not touched");
  // A schema that allows more fields keeps them.
  const lax = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  assert.deepEqual(stripUndeclared(lax, { a: "x", b: 2 }).value, { a: "x", b: 2 });
});

test("problemsOf: the place of each problem, whatever it is", () => {
  assert.deepEqual(problemsOf(schema, answer()), []);
  const value = answer();
  delete value.headline;
  value.edits[1].hits = "two";
  value.verdict = "maybe";
  value.edits[2].extra = 1;
  const found = Object.fromEntries(problemsOf(schema, value).map((p) => [p.at, p.say]));
  assert.deepEqual(Object.keys(found).sort(), ["/edits/1/hits", "/edits/2/extra", "/headline", "/verdict"]);
  assert.match(found["/edits/1/hits"], /number/);
  assert.match(found["/verdict"], /ship/);
  assert.deepEqual(problemsOf(schema, null).map((p) => p.at), [""]);
  assert.deepEqual(problemsOf(schema, "text").map((p) => p.at), [""]);
  // A keyword it does not know is the CLI's to judge, not a problem here.
  assert.deepEqual(problemsOf({ type: "object", properties: { a: { oneOf: [{ type: "string" }] } }, required: ["a"] }, { a: 1 }), []);
});

test("normalizeProblems: nothing, a string, a list; anything else is the check's mistake", () => {
  assert.deepEqual(normalizeProblems(undefined), []);
  assert.deepEqual(normalizeProblems(null), []);
  assert.deepEqual(normalizeProblems([]), []);
  assert.deepEqual(normalizeProblems("bad"), [{ at: "", say: "bad" }]);
  assert.deepEqual(normalizeProblems([{ at: "/a", say: " no " }, "also"]), [{ at: "/a", say: "no" }, { at: "", say: "also" }]);
  assert.throws(() => normalizeProblems([{ at: "a", say: "x" }]), /JSON pointer/);
  assert.throws(() => normalizeProblems([{ at: "/a" }]), /returns a list/);
  assert.throws(() => normalizeProblems(true), /returns a list/);
});

test("planFix: two places become f1 and f2, each with only its own sub-schema", () => {
  const plan = planFix(schema, answer(), [
    { at: "/edits/2/old", say: "hits 2 places" },
    { at: "/edits/0", say: "file is not tracked" },
  ]);
  assert.equal(plan.whole, false);
  assert.deepEqual(plan.items.map((i) => [i.key, i.at]), [["f1", "/edits/2/old"], ["f2", "/edits/0"]]);
  assert.deepEqual(Object.keys(plan.schema.properties), ["f1", "f2"]);
  assert.deepEqual(plan.schema.required, ["f1", "f2"]);
  assert.equal(plan.schema.additionalProperties, false);
  assert.equal(plan.schema.properties.f1.description, "the text to replace", "the field's own description goes with it");
  assert.equal(plan.schema.properties.f2.type, "object");
  assert.deepEqual(plan.items.map((i) => i.now), ["z", { file: "a.lua", old: "x", hits: 1 }]);
});

test("planFix: a problem inside another is one place, with both said", () => {
  const plan = planFix(schema, answer(), [
    { at: "/edits/1/old", say: "first" },
    { at: "/edits/1", say: "second" },
    { at: "/edits/1/hits", say: "third" },
  ]);
  assert.deepEqual(plan.items.map((i) => i.at), ["/edits/1"]);
  for (const word of ["first", "second", "third"]) assert.match(plan.items[0].say, new RegExp(word));
});

test("planFix: the whole answer when a problem is with the whole answer, or there are too many places", () => {
  const whole = planFix(schema, answer(), [{ at: "", say: "not what was asked" }, { at: "/verdict", say: "x" }]);
  assert.equal(whole.whole, true);
  assert.equal(whole.schema, schema, "the reply is the step's own schema");
  assert.equal(whole.problems.length, 2);
  const many = {
    type: "object",
    properties: Object.fromEntries(Array.from({ length: MAX_PLACES + 1 }, (_, i) => [`k${i}`, { type: "string" }])),
    required: Array.from({ length: MAX_PLACES + 1 }, (_, i) => `k${i}`),
    additionalProperties: false,
  };
  assert.equal(planFix(many, {}, problemsOf(many, {})).whole, true);
  assert.equal(planFix(many, { k0: "x" }, problemsOf(many, { k0: "x" })).whole, false, "eight places still fit");
});

test("planFix: a place the answer does not have is asked for as the thing that holds it", () => {
  const plan = planFix(schema, answer(), [{ at: "/edits/9/old", say: "no such edit" }]);
  assert.deepEqual(plan.items.map((i) => i.at), ["/edits"]);
  assert.deepEqual(plan.moves, [{ from: "/edits/9/old", to: "/edits" }]);
  assert.equal(planFix(schema, answer(), [{ at: "/nowhere", say: "x" }]).whole, true, "a place the schema does not have climbs to the root");
});

test("planFix: a missing field is a place of its own", () => {
  const value = answer();
  delete value.headline;
  const plan = planFix(schema, value, problemsOf(schema, value));
  assert.deepEqual(plan.items.map((i) => [i.at, i.now]), [["/headline", undefined]]);
  assert.match(fixPrompt(plan), /\(missing\)/);
});

test("fixPrompt: the problems and where the answer stands now, not the answer", () => {
  const value = answer();
  value.headline = "H".repeat(1000);
  const plan = planFix(schema, value, [{ at: "/headline", say: "too long" }, { at: "/edits/1/old", say: "ambiguous" }]);
  const prompt = fixPrompt(plan);
  assert.match(prompt, /needs 2 fixes/);
  assert.match(prompt, /f1 = headline: too long/);
  assert.match(prompt, /f2 = edits\[1\]\.old: ambiguous/);
  assert.ok(!prompt.includes("c.lua"), "what is fine is not repeated");
  assert.ok(prompt.length < 700, `cut to what is needed (${prompt.length} chars)`);
  assert.match(prompt, /…/, "a long value is cut");
  const whole = fixPrompt(planFix(schema, answer(), [{ at: "", say: "bad" }]));
  assert.match(whole, /whole answer again/);
  assert.match(fixPrompt(planFix(schema, undefined, [{ at: "", say: "no JSON" }]), { unread: true }), /could not read/);
});

test("applyFix: places come back to their own index; a reply that does not fit leaves its place alone", () => {
  const value = answer();
  const plan = planFix(schema, value, [{ at: "/edits/2/old", say: "a" }, { at: "/edits/0", say: "b" }, { at: "/verdict", say: "c" }]);
  const merged = applyFix(value, plan, { f1: "Z", f2: { file: "q.lua", old: "p", hits: 3 }, f3: "perhaps" });
  assert.equal(merged.edits[2].old, "Z");
  assert.deepEqual(merged.edits[0], { file: "q.lua", old: "p", hits: 3 });
  assert.equal(merged.verdict, "ship", "f3 is not one of the choices, so it is not taken");
  assert.equal(value.edits[2].old, "z", "the answer in hand is not changed");
  assert.equal(applyFix(value, plan, undefined), value);
  assert.equal(applyFix(value, plan, "nonsense"), value);
  const whole = planFix(schema, value, [{ at: "", say: "x" }]);
  assert.equal(applyFix(value, whole, { other: 1 }).other, 1, "a whole answer is taken as it comes");
  assert.equal(applyFix(value, whole, undefined), value);
});

test("schemaFailure: the reply the CLI refused, and what it said was wrong with it", () => {
  const error = (details) => new PaseoCliError("x", { argv: [], exitCode: 1, stdout: "", stderr: "", code: "OUTPUT_SCHEMA_FAILED", details });
  const failure = schemaFailure(error({ lastResponse: '{"a": 1}', validationErrors: ["/a: must be string", "(root): must NOT have additional properties", { instancePath: "/b", message: "is required", keyword: "required" }] }));
  assert.equal(failure.text, '{"a": 1}');
  assert.deepEqual(failure.errors, [{ at: "/a", say: "must be string" }, { at: "/b", say: "is required" }]);
  assert.equal(schemaFailure(error({ lastResponse: "  " })), null, "an agent that never answered is not a reply to correct");
  assert.equal(schemaFailure(error({})), null);
  assert.equal(schemaFailure(new PaseoCliError("x", { argv: [], exitCode: 1, stdout: "", stderr: "", code: "AGENT_NOT_FOUND", details: { lastResponse: "{}" } })), null);
});

test("unknownOption: only the argument parser's refusal, with the option it names", () => {
  const cli = (stderr, exitCode = 1) => new PaseoCliError("x", { argv: [], exitCode, stdout: "", stderr });
  assert.equal(unknownOption(cli("error: unknown option '--max-retries'\n")), "--max-retries");
  assert.equal(unknownOption(cli("Using workspace w1\nerror: unknown option '--output-schema'\n(Did you mean --output?)")), "--output-schema");
  assert.equal(unknownOption(cli("agent said: error: unknown option '--x'")), null, "it begins a line");
  assert.equal(unknownOption(cli("error: unknown option '--x'", 0)), null);
  assert.equal(unknownOption(new Error("error: unknown option '--x'")), null);
});

test("CheckFailed: the line a person reads names the step, the rounds and the first problem", () => {
  const failed = new CheckFailed({ step: "patch", problems: [{ at: "/m/0", say: "no {code}" }, { at: "", say: "other" }], value: { m: [] }, rounds: 3, phase: null });
  assert.equal(failed.name, "CheckFailed");
  assert.equal(failed.reason, "patch：核对 3 轮还不过：/m/0 no {code}");
  assert.equal(failed.rounds, 3);
});

test("describeFailure: a reply that did not fit is told apart from an answer that never came", () => {
  const say = (error) => describeFailure(["run"], 1, "", error);
  const mismatch = say({ code: "OUTPUT_SCHEMA_FAILED", message: "m", details: { validationErrors: ["/a: x"], lastResponse: "{}" } });
  const silent = say({ code: "OUTPUT_SCHEMA_FAILED", message: "m" });
  assert.match(mismatch, /answered, but not in the shape/);
  assert.doesNotMatch(mismatch, /permission request/);
  assert.match(silent, /did not hand in a structured answer/);
  assert.match(silent, /permission request/);
  assert.match(say({ code: "INVALID_OUTPUT_SCHEMA", message: "m" }), /could not parse the schema/);
  assert.equal(say({ code: "OTHER", message: "m" }), "paseo run failed: OTHER -- m");
  assert.match(describeFailure(["run"], 3, "plain text", null), /exited 3: plain text/);
});

test("errorBody: the CLI's JSON error behind a line it said first", () => {
  const raw = 'Using workspace w1\n{\n  "error": {\n    "code": "OUTPUT_SCHEMA_FAILED",\n    "message": "m",\n    "details": { "lastResponse": "{\\"a\\": 1}" }\n  }\n}\n';
  assert.deepEqual(errorBody(raw).details, { lastResponse: '{"a": 1}' });
  assert.equal(errorBody("error: unknown option '--x'"), null);
  assert.equal(errorBody('{ "not": "an error" }'), null);
});
