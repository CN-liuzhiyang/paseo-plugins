// The provider's input gate (approve with a value) against a fake host: the question card, the entry that
// does not fit, the two ways of saying no, and that the value goes to its file and nowhere else.
// The runtime side of the same gate is in contract.test.ts and orchestration/test/gate-input.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderConnection, ProviderEvent, ProviderInput, ProviderPermissionRequest, ProviderPermissionResponse } from "@getpaseo/plugin/server/provider";
import { createGateProvider, DISMISSED, answeredValue } from "./provider";
import { contentDigest, inputProblem, parsePointer, receiptFor, readRequest, RequestError, type GateInput, type GateRequest } from "./request";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const CODE = "483921";

/** An input gate's request as the runtime writes it (gate.mjs prepareGate), and the prompt that points at it. */
async function gateFiles(input: Partial<GateInput> = {}, overrides: Partial<GateRequest> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-gate-input-"));
  const content = "svn commit -m fix\n";
  const fields = {
    v: 1 as const,
    kind: "orchestration-gate/request" as const,
    runId: "run-1",
    callId: "c3",
    title: "批准提交 r12 并输入验证码",
    summary: "校验：✅",
    brief: "",
    evidence: [],
    name: "commit.txt",
    content,
    sha256: contentDigest(content),
    receiptPath: path.join(dir, "c3.receipt.txt"),
    answerPath: path.join(dir, "c3.answer.json"),
    timeout: "8h",
    help: "不批的话可以点「不批」。",
    input: { label: "验证码", secret: true, pattern: "\\d{6}", hint: "6 位数字", ...input },
    inputPath: path.join(dir, "c3.input.json"),
  };
  const request: GateRequest = { ...fields, receipt: receiptFor(fields), ...overrides };
  const requestPath = path.join(dir, "c3.request.json");
  const text = JSON.stringify(request, null, 2);
  await writeFile(requestPath, text, "utf8");
  const prompt = `人闸 c3 · 运行 run-1：${request.title}\nrequest: ${requestPath}\nsha256: ${sha256(text)}`;
  return { dir, request, requestPath, prompt };
}

async function host() {
  const connection: ProviderConnection = await createGateProvider().connect({
    versions: [1],
    capabilities: ["prompt.message", "prompt.steer", "permission", "session.list", "timeline.plugin"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const send = async (input: ProviderInput) => {
    await connection.send(input);
    await settle();
  };
  await send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "s1",
    history: "skip",
    config: { cwd: "C:/work", env: {}, mcpServers: {}, settings: {}, persist: true, title: "[gate] x" },
  });
  const prompt = (text: string, delivery: "auto" | "steer" = "auto") =>
    send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: `m-${Math.random()}`, delivery, input: { type: "message", content: [{ type: "text", text }] } } });
  const cards = () => events.filter((e): e is Extract<ProviderEvent, { type: "session.permission" }> => e.type === "session.permission").map((e) => e.request);
  const answer = (permissionId: string, response: ProviderPermissionResponse) => send({ type: "session.permission", sessionId: "s1", permissionId, response });
  const turns = () => events.filter((e) => e.type === "session.turn").map((e) => (e as { state: string }).state);
  return { events, send, prompt, cards, answer, turns };
}

/** What the app's question form sends on submit (question-form-card.tsx handleSubmit): the input with `answers` added. */
const submitted = (card: ProviderPermissionRequest, value: unknown): ProviderPermissionResponse => ({
  behavior: "allow",
  updatedInput: { ...card.input, answers: { [(card.input as { questions: Array<{ header: string }> }).questions[0].header]: value } } as never,
});

const read = (file: string) => readFile(file, "utf8").catch(() => null);

test("the card is a question with one text field; the decision and what each answer does are in the question", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  const [card] = h.cards();
  assert.equal(card.kind, "question");
  assert.equal(card.actions, undefined, "the app draws a question form, not buttons");
  const q = (card.input as { questions: Array<Record<string, unknown>> }).questions;
  assert.equal(q.length, 1);
  assert.equal(q[0].header, "验证码");
  assert.deepEqual(q[0].options, []);
  assert.equal(q[0].allowEmpty, false, "an empty entry cannot be submitted, and the dismiss button does not submit one");
  assert.equal(q[0].dismissLabel, "不批");
  assert.equal(q[0].placeholder, "6 位数字");
  const text = q[0].question as string;
  assert.ok(text.includes(request.title));
  assert.ok(text.includes("点「提交」= 批准") && text.includes("点「不批」= 不批"), text);
  assert.ok(text.includes("这个输入框只填值，不当理由"), "the field and the conversation are not mixed up");
  assert.ok(text.includes("8h 内没人处理按不批"));
  assert.deepEqual(h.turns(), ["started"]);
  assert.equal(await read(request.answerPath), null);
});

test("submit a value that fits: the value file, then the record (without the value), then the receipt", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  const [card] = h.cards();
  await h.answer(card.id, submitted(card, `  ${CODE}\n`));
  assert.deepEqual(JSON.parse((await read(request.inputPath!))!), { v: 1, value: CODE }, "surrounding whitespace is a paste, not the value");
  const answer = JSON.parse((await read(request.answerPath))!);
  assert.equal(answer.behavior, "allow");
  assert.equal(answer.via, "form");
  assert.deepEqual(answer.input, { given: true, secret: true });
  assert.ok(!JSON.stringify(answer).includes(CODE), "the record never holds the value");
  assert.equal(await read(request.receiptPath), request.receipt);
  assert.deepEqual(h.turns(), ["started", "completed"]);
  // Nothing the provider said to the conversation or the host carries the value.
  assert.ok(!JSON.stringify(h.events).includes(CODE), "no event carries the value");
  const said = JSON.stringify(h.events.filter((e) => e.type === "timeline.item"));
  assert.ok(said.includes("值不会显示在这里"));
});

test("an entry that does not fit is not an answer: the card goes up again, nothing is recorded, the entry is not echoed", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  const [first] = h.cards();
  const WRONG = "12ab56";
  await h.answer(first.id, submitted(first, WRONG));
  assert.equal(h.cards().length, 2, "a second card is up");
  const second = h.cards()[1];
  assert.notEqual(second.id, first.id);
  assert.ok(h.events.some((e) => e.type === "session.permission_resolved" && e.permissionId === first.id));
  const text = (second.input as { questions: Array<{ question: string }> }).questions[0].question;
  assert.ok(text.startsWith("⚠ 上一次填的不符合要求：格式不对（要求：6 位数字）。没有算作答复"), text);
  assert.ok(!JSON.stringify(h.events).includes(WRONG), "the wrong entry is not echoed anywhere");
  assert.equal(await read(request.answerPath), null, "no answer is recorded");
  assert.equal(await read(request.inputPath!), null);
  assert.equal(await read(request.receiptPath), null);
  assert.deepEqual(h.turns(), ["started"], "the turn stays open");

  // The first card's id is dead; only the new card answers. A second wrong entry gets a third card.
  await h.answer(first.id, submitted(first, CODE));
  assert.equal(await read(request.answerPath), null, "an answer to a closed card changes nothing");
  await h.answer(second.id, submitted(second, "123"));
  assert.equal(h.cards().length, 3);
  const third = h.cards()[2];
  await h.answer(third.id, submitted(third, CODE));
  assert.equal(JSON.parse((await read(request.inputPath!))!).value, CODE);
  assert.equal(JSON.parse((await read(request.answerPath))!).behavior, "allow");
  assert.deepEqual(h.turns(), ["started", "completed"]);
});

test("an allow with no value, an empty one, a non-string one, or one that is too long is sent back too", async () => {
  const { request, prompt } = await gateFiles({ pattern: null });
  const h = await host();
  await h.prompt(prompt);
  const bad: ProviderPermissionResponse[] = [
    { behavior: "allow", selectedActionId: "approve" }, // `paseo permit allow` with no --input
    { behavior: "allow", updatedInput: { answers: {} } },
    { behavior: "allow", updatedInput: { answers: { 验证码: "   " } } },
    { behavior: "allow", updatedInput: { answers: { 验证码: 123456 } } },
    { behavior: "allow", updatedInput: { answers: { 验证码: "x".repeat(1001) } } },
    { behavior: "allow", updatedInput: { answers: { 验证码: "123" } } }, // a secret under 4 characters cannot be kept out of the logs
    { behavior: "allow", updatedInput: { answers: { 别的字段: CODE } } },
  ];
  for (const [i, response] of bad.entries()) {
    const cards = h.cards();
    await h.answer(cards[cards.length - 1].id, response);
    assert.equal(h.cards().length, cards.length + 1, `case ${i} raised the card again`);
  }
  assert.equal(await read(request.answerPath), null);
  const cards = h.cards();
  await h.answer(cards[cards.length - 1].id, submitted(cards[cards.length - 1], "no pattern, anything ≥ 4 chars"));
  assert.equal(JSON.parse((await read(request.inputPath!))!).value, "no pattern, anything ≥ 4 chars");
});

test("the form's dismiss is a no; so is any other deny; neither takes a value", async () => {
  for (const [response, via, reasonVisible] of [
    [{ behavior: "deny", message: DISMISSED }, "dismiss", false],
    [{ behavior: "deny", message: "from the command line" }, "no-button", true],
  ] as const) {
    const { request, prompt } = await gateFiles();
    const h = await host();
    await h.prompt(prompt);
    await h.answer(h.cards()[0].id, response);
    const answer = JSON.parse((await read(request.answerPath))!);
    assert.equal(answer.behavior, "deny");
    assert.equal(answer.via, via);
    assert.equal(answer.input, undefined);
    assert.equal(await read(request.inputPath!), null);
    assert.equal(await read(request.receiptPath), null);
    assert.equal(JSON.stringify(h.events).includes("from the command line"), reasonVisible);
    assert.deepEqual(h.turns(), ["started", "completed"]);
  }
});

test("words typed in the conversation are still a no with the words as the reason, never the value", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  // Even a typed message that looks like the code: it is a reply in the conversation, not the field.
  await h.prompt(CODE, "steer");
  const answer = JSON.parse((await read(request.answerPath))!);
  assert.equal(answer.behavior, "deny");
  assert.equal(answer.via, "typed");
  assert.equal(answer.typed, CODE);
  assert.equal(await read(request.inputPath!), null, "no value is taken from the conversation");
  assert.equal(await read(request.receiptPath), null);
});

test("an interrupt with the card up takes no value and records no approval; an entry sent back before it left nothing", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  await h.answer(h.cards()[0].id, submitted(h.cards()[0], "12ab56"));
  await h.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" });
  const answer = JSON.parse((await read(request.answerPath))!);
  assert.equal(answer.behavior, "deny");
  assert.equal(answer.via, "interrupt");
  assert.equal(await read(request.inputPath!), null);
  assert.equal(await read(request.receiptPath), null);
});

test("an ordinary gate (no input) is unchanged: buttons, no question, an allow needs no value", async () => {
  const { request, prompt } = await gateFiles({}, { input: undefined, inputPath: undefined });
  const h = await host();
  await h.prompt(prompt);
  const [card] = h.cards();
  assert.equal(card.kind, "tool");
  assert.deepEqual(card.actions?.map((a) => a.id), ["deny", "approve"]);
  await h.answer(card.id, { behavior: "allow", selectedActionId: "approve" });
  assert.equal(JSON.parse((await read(request.answerPath))!).via, "button");
  assert.equal(await read(request.receiptPath), request.receipt);
});

test("the request's input is checked: shape, a pattern that compiles, and where the value goes", async () => {
  const expectError = async (name: string, input: unknown, overrides: Partial<GateRequest>, message: RegExp) => {
    const { prompt } = await gateFiles({}, { input: input as GateInput, ...overrides });
    await assert.rejects(readRequest(prompt), (error: unknown) => error instanceof RequestError && message.test(error.message), name);
  };
  await expectError("not an object", "验证码", {}, /input is not/);
  await expectError("no label", { label: " ", secret: true, pattern: null, hint: "" }, {}, /input is not/);
  await expectError("secret is not a boolean", { label: "x", secret: "yes", pattern: null, hint: "" }, {}, /input is not/);
  await expectError("a pattern that does not compile", { label: "x", secret: true, pattern: "(", hint: "" }, {}, /pattern that compiles/);
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-gate-elsewhere-"));
  const valid = { label: "验证码", secret: true, pattern: null, hint: "" };
  await expectError("the value goes somewhere else", valid, { inputPath: path.join(dir, "c3.input.json") }, /value goes to/);
  await expectError("no inputPath", valid, { inputPath: undefined }, /value goes to/);
  const ok = await gateFiles();
  const parsed = await readRequest(ok.prompt);
  assert.equal(parsed.inputPath, ok.request.inputPath);
});

test("inputProblem is the rule the runtime applies too", () => {
  const rule = { secret: true, pattern: "\\d{6}", hint: "6 位数字" };
  assert.equal(inputProblem(CODE, rule), null);
  assert.equal(inputProblem("12345", rule), "格式不对（要求：6 位数字）");
  assert.equal(inputProblem("1234567", rule), "格式不对（要求：6 位数字）", "the whole value must match, not a part of it");
  assert.equal(inputProblem("a483921", rule), "格式不对（要求：6 位数字）");
  assert.equal(inputProblem("", rule), "没有填写");
  assert.equal(inputProblem(undefined, rule), "没有填写");
  assert.equal(inputProblem("abc", { secret: true, pattern: null, hint: "" }), "太短（至少 4 个字符）");
  assert.equal(inputProblem("abc", { secret: false, pattern: null, hint: "" }), null);
  assert.equal(inputProblem("a|b", { secret: false, pattern: "x|a\\|b", hint: "" }), null, "an alternation is anchored as a whole");
  assert.equal(answeredValue({ behavior: "deny" }, "验证码"), null);
  assert.equal(parsePointer("nothing")?.path, undefined);
});

// --- Responses captured from a real daemon (fixtures/real-responses.json) -----------------------------------

const real = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "real-responses.json"), "utf8")).cases as Record<
  string,
  { input: { permissionId: string; response: ProviderPermissionResponse } }
>;

test("real `paseo permit allow --input` is the approval with the value; the CLI's bare allow is sent back", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  const [card] = h.cards();
  // The CLI's allow without --input: no updatedInput at all.
  await h.answer(card.id, real["permit-allow-bare"].input.response);
  assert.equal(h.cards().length, 2);
  assert.equal(await read(request.answerPath), null);
  const [, again] = h.cards();
  await h.answer(again.id, real["permit-allow-with-input"].input.response);
  assert.equal(JSON.parse((await read(request.inputPath!))!).value, "483921");
  assert.equal(JSON.parse((await read(request.answerPath))!).via, "form");
});

test("real `paseo permit deny` and the runtime's own close-out deny are no-button denials; the second is the one the runtime knows", async () => {
  for (const name of ["permit-deny-with-message", "runtime-close-out-deny"]) {
    const { request, prompt } = await gateFiles();
    const h = await host();
    await h.prompt(prompt);
    await h.answer(h.cards()[0].id, real[name].input.response);
    const answer = JSON.parse((await read(request.answerPath))!);
    assert.equal(answer.behavior, "deny", name);
    assert.equal(answer.via, "no-button", name);
    assert.equal(answer.message, (real[name].input.response as { message: string }).message, name);
  }
});
