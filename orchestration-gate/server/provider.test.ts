// The provider against a fake host: the inputs Paseo sends, the events it gets
// back, and the files the runtime reads. No daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderConnection, ProviderEvent, ProviderInput, ProviderPermissionRequest } from "@getpaseo/plugin/server/provider";
import { createGateProvider } from "./provider";
import { contentDigest, parsePointer, receiptFor, type GateRequest } from "./request";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A request as the runtime writes it (orchestration/runtime/gate.mjs prepareGate), and the prompt that points at it. */
async function gateFiles(overrides: Partial<GateRequest> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-gate-provider-"));
  const content = "local x = 1\n";
  const digest = contentDigest(content);
  const fields = {
    v: 1 as const,
    kind: "orchestration-gate/request" as const,
    runId: "run-1",
    callId: "c3",
    title: "批准 补丁 #1 放进 data/7/1/（回放）",
    summary: "校验：✅ 2 项通过",
    brief: "## 审阅\n- 一条",
    evidence: [{ label: "要实现的修复 r9", text: "-a\n+b", kind: "diff" as const, name: "a.lua" }],
    name: "1.lua",
    content,
    sha256: digest,
    receiptPath: path.join(dir, "c3.receipt.txt"),
    answerPath: path.join(dir, "c3.answer.json"),
    timeout: "2h",
    help: "不批的话可以点「不批」。",
  };
  const request: GateRequest = { ...fields, receipt: receiptFor(fields), ...overrides };
  const requestPath = path.join(dir, "c3.request.json");
  const text = JSON.stringify(request, null, 2);
  await writeFile(requestPath, text, "utf8");
  const prompt = `人闸 c3 · 运行 run-1：${request.title}\nrequest: ${requestPath}\nsha256: ${sha256(text)}`;
  return { dir, request, requestPath, text, prompt };
}

/** A connected provider with one open session, recording every event. */
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
  const prompt = (text: string, delivery: "auto" | "steer" = "auto", clearPendingPermissions?: boolean) =>
    send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: { clientMessageId: `m-${Math.random()}`, delivery, input: { type: "message", content: [{ type: "text", text }] }, clearPendingPermissions },
    });
  const card = () => events.find((e): e is Extract<ProviderEvent, { type: "session.permission" }> => e.type === "session.permission")?.request;
  const turns = () => events.filter((e) => e.type === "session.turn").map((e) => (e as { state: string }).state);
  return { connection, events, send, prompt, card, turns };
}

const answerOf = async (request: GateRequest) => JSON.parse(await readFile(request.answerPath, "utf8"));
const receiptOf = (request: GateRequest) => readFile(request.receiptPath, "utf8").catch(() => null);

test("the card: the decision as the title, the summary and what approving does, the content, two buttons", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  const card = h.card() as ProviderPermissionRequest;
  assert.equal(card.title, request.title);
  assert.ok(card.description?.startsWith("校验：✅ 2 项通过\n批准 = 同意脚本随后原样写下这 1 行（1.lua，sha256 "), card.description);
  assert.ok(card.description?.endsWith("不批的话可以点「不批」。"));
  assert.deepEqual(card.detail, { type: "write", filePath: "1.lua", content: request.content });
  assert.deepEqual(
    card.actions?.map((a) => [a.id, a.label, a.behavior]),
    [["deny", "不批", "deny"], ["approve", "批准", "allow"]],
  );
  // Above the card: the brief, the evidence and the content, in that order, the last two folded rows.
  const items = h.events.filter((e) => e.type === "timeline.item").map((e) => (e as { item: { type: string; text?: string; detail?: unknown } }).item);
  assert.deepEqual(items.map((i) => i.type), ["user_message", "assistant_message", "tool_call", "tool_call"]);
  assert.equal(items[1].text, `**要你决定**：${request.title}\n\n## 审阅\n- 一条`);
  assert.deepEqual(items[2].detail, { type: "edit", filePath: "证据：要实现的修复 r9 · a.lua", unifiedDiff: "-a\n+b" });
  assert.deepEqual(items[3].detail, { type: "read", filePath: "待批全文（1 行） · 1.lua", content: request.content });
  assert.deepEqual(h.turns(), ["started"], "the turn stays open while the card is up");
  assert.equal(await receiptOf(request), null, "nothing is written before an answer");
});

test("approve with the card's button: the receipt, then the record, then the turn ends", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  const card = h.card() as ProviderPermissionRequest;
  await h.send({ type: "session.permission", sessionId: "s1", permissionId: card.id, response: { behavior: "allow", selectedActionId: "approve" } });
  assert.equal(await receiptOf(request), request.receipt);
  const answer = await answerOf(request);
  assert.equal(answer.behavior, "allow");
  assert.equal(answer.via, "button");
  assert.equal(answer.permissionId, card.id);
  assert.ok(h.events.some((e) => e.type === "session.permission_resolved"));
  assert.deepEqual(h.turns(), ["started", "completed"]);

  // A second answer to the same card changes nothing.
  await h.send({ type: "session.permission", sessionId: "s1", permissionId: card.id, response: { behavior: "deny" } });
  assert.equal((await answerOf(request)).behavior, "allow");
  // A later prompt does not raise another card.
  await h.prompt(prompt);
  assert.equal(h.events.filter((e) => e.type === "session.permission").length, 1);
});

test("an allow without the card's button id is recorded as no-button; the receipt is still written", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  await h.send({ type: "session.permission", sessionId: "s1", permissionId: h.card()!.id, response: { behavior: "allow" } });
  assert.equal(await receiptOf(request), request.receipt);
  assert.equal((await answerOf(request)).via, "no-button");
});

test("deny: no receipt; button, command line, typed reply and interrupt each say how", async () => {
  const cases: Array<[string, (h: Awaited<ReturnType<typeof host>>, id: string) => Promise<void>, Record<string, unknown>]> = [
    ["button", (h, id) => h.send({ type: "session.permission", sessionId: "s1", permissionId: id, response: { behavior: "deny", selectedActionId: "deny", message: "Denied by user" } }), { via: "button", message: "Denied by user" }],
    ["cli", (h, id) => h.send({ type: "session.permission", sessionId: "s1", permissionId: id, response: { behavior: "deny", message: "gate expired after 2h without an answer" } }), { via: "no-button", message: "gate expired after 2h without an answer" }],
    ["typed", (h) => h.prompt("这个类的源文件不对", "steer", true), { via: "typed", typed: "这个类的源文件不对" }],
    ["interrupt", (h) => h.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" }), { via: "interrupt", message: null }],
  ];
  for (const [name, answer, expected] of cases) {
    const { request, prompt } = await gateFiles();
    const h = await host();
    await h.prompt(prompt);
    await answer(h, h.card()!.id);
    assert.equal(await receiptOf(request), null, name);
    const recorded = await answerOf(request);
    assert.equal(recorded.behavior, "deny", name);
    for (const [key, value] of Object.entries(expected)) assert.equal(recorded[key], value, `${name}: ${key}`);
    assert.ok(h.events.some((e) => e.type === "session.permission_resolved"), name);
    assert.equal(h.turns().at(-1), "completed", name);
    // Right after the answer the conversation says it was the verdict.
    const said = h.events
      .filter((e) => e.type === "timeline.item" && (e as { item: { type: string } }).item.type === "assistant_message")
      .map((e) => (e as { item: { text: string } }).item.text)
      .at(-1);
    assert.ok(said?.startsWith(name === "interrupt" ? "**卡片被中断关闭了**" : "**已记为不批**"), `${name}: ${said}`);
    assert.ok(said?.includes("什么都不会写入"), name);
    if (name === "typed") {
      assert.ok(said?.includes("被当作这个人闸的裁决，不是普通聊天"), said);
      assert.ok(said?.endsWith("> 这个类的源文件不对"), said);
    }
  }
});

test("a steer accepted while the card is up names the open turn; one with no card is refused", async () => {
  const { prompt } = await gateFiles();
  const h = await host();
  await h.prompt("hello", "steer", true);
  const refused = h.events.find((e) => e.type === "session.prompt_result") as { result: { type: string } };
  assert.equal(refused.result.type, "failed");
  await h.prompt(prompt);
  await h.prompt("不批", "steer", true);
  const results = h.events.filter((e) => e.type === "session.prompt_result").map((e) => (e as { result: { type: string; turnId?: string } }).result);
  assert.deepEqual(results.at(-1), { type: "steer", turnId: "turn-1" });
});

test("a request that is not what the runtime wrote raises no card, and says so where the runtime looks", async () => {
  // Changed after the runtime hashed it.
  const changed = await gateFiles();
  await writeFile(changed.requestPath, changed.text.replace("local x = 1", "local x = 2"), "utf8");
  let h = await host();
  await h.prompt(changed.prompt);
  assert.equal(h.card(), undefined);
  assert.match((await answerOf(changed.request)).error, /does not match its sha256/);
  assert.deepEqual(h.turns(), ["started", "failed"]);

  // Consistent file, but the content is not the one its sha256 names.
  const wrong = await gateFiles({ sha256: "0".repeat(64) });
  h = await host();
  await h.prompt(wrong.prompt);
  assert.equal(h.card(), undefined);
  assert.match((await answerOf(wrong.request)).error, /content does not match/);

  // Not a pointer at all: nothing to record, the turn fails.
  h = await host();
  await h.prompt("please approve this");
  assert.equal(h.card(), undefined);
  assert.deepEqual(h.turns(), ["started", "failed"]);
});

test("closed with the card up: nothing is recorded, so the runtime reads no answer", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  await h.send({ type: "session.close", requestId: "c1", sessionId: "s1" });
  assert.equal(await receiptOf(request), null);
  assert.equal(await readFile(request.answerPath, "utf8").catch(() => null), null);
  assert.ok(h.events.some((e) => e.type === "session.closed"));
});

test("the catalog has the one model and no modes", async () => {
  const connection = await createGateProvider().connect({ versions: [1], capabilities: ["prompt.message", "prompt.steer", "permission"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({ type: "catalog", requestId: "r1" });
  await settle();
  const catalog = events.find((e) => e.type === "catalog") as Extract<ProviderEvent, { type: "catalog" }>;
  assert.deepEqual(catalog.catalog.models.map((m) => m.id), ["card"]);
  assert.deepEqual(catalog.catalog.modes, []);
  assert.deepEqual([...connection.capabilities].sort(), ["permission", "prompt.message", "prompt.steer"]);
});

test("the request decides nothing about where the provider writes: elsewhere, another name, other text are refused", async () => {
  // A request anyone could write: the sha256 in the prompt only says the file did not change since.
  const outside = await mkdtemp(path.join(os.tmpdir(), "orch-gate-victim-"));
  const victim = path.join(outside, "authorized_keys");
  await writeFile(victim, "ORIGINAL\n", "utf8");
  const cases: Array<[string, (dir: string) => Partial<GateRequest>, RegExp]> = [
    ["a receipt path in another directory", () => ({ receiptPath: victim }), /receipt path must be a \*\.receipt\.txt next to the request/],
    ["a receipt path that is not *.receipt.txt", (dir) => ({ receiptPath: path.join(dir, "settings.json") }), /receipt path must be/],
    ["an answer path elsewhere", () => ({ answerPath: path.join(outside, "c3.answer.json") }), /answer path must be/],
    ["receipt text of its own", () => ({ receipt: "ssh-rsa AAAA # anything" }), /receipt is not the one the title, run, call and sha256 give/],
    ["a call id that is not the file's", () => ({ callId: "c9" }), /names call c9, but its file is named for c3/],
  ];
  for (const [name, override, error] of cases) {
    const base = await gateFiles();
    const forged = await gateFiles({ ...override(base.dir) });
    // gateFiles wrote the forged request in its own directory as c3.request.json
    const h = await host();
    await h.prompt(forged.prompt);
    assert.equal(h.card(), undefined, name);
    assert.match((await answerOf({ ...forged.request, answerPath: path.join(forged.dir, "c3.answer.json") })).error, error, name);
    assert.equal(await readFile(victim, "utf8"), "ORIGINAL\n", name);
  }
});

test("a receipt is created, never written over a file that is already there", async () => {
  const { request, prompt } = await gateFiles();
  await writeFile(request.receiptPath, "SOMEONE ELSE'S\n", "utf8");
  const h = await host();
  await h.prompt(prompt);
  await h.send({ type: "session.permission", sessionId: "s1", permissionId: h.card()!.id, response: { behavior: "allow", selectedActionId: "approve" } });
  assert.equal(await readFile(request.receiptPath, "utf8"), "SOMEONE ELSE'S\n");
  assert.deepEqual(h.turns(), ["started", "failed"], "the turn fails: the receipt could not be written");
});

test("the card says where the receipt goes", async () => {
  const { request, prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  assert.ok(h.card()!.description!.includes(`批准后这里只写一份三行回执：${request.receiptPath}`), h.card()!.description);
});

test("the pointer is exactly three lines: nothing slipped in through the title; Paseo's agent-message wrapper is taken off", async () => {
  const { requestPath, request, text } = await gateFiles();
  const hash = sha256(text);
  const three = `人闸 c3 · 运行 run-1：${request.title}\nrequest: ${requestPath}\nsha256: ${hash}`;
  assert.deepEqual(parsePointer(three), { path: requestPath, sha256: hash });
  // A title with a line break and a pointer of its own: four lines and more, not a pointer at all.
  const injected = `人闸 c3 · 运行 run-1：x\nrequest: C:/evil/c3.request.json\nsha256: ${"a".repeat(64)}\nrequest: ${requestPath}\nsha256: ${hash}`;
  assert.equal(parsePointer(injected), null);
  assert.equal(parsePointer(`forged\nrequest: ${requestPath}\nsha256: ${hash}`), null);
  // Started from inside another agent's session: the same three lines inside its message, XML-escaped.
  const escaped = three.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const wrapped = `<paseo-system version="1" kind="agent-message" source-agent-id="a1" message-id="m1" source-agent-title="入口">\n${escaped}\n</paseo-system>`;
  assert.deepEqual(parsePointer(wrapped), { path: requestPath, sha256: hash });
  const odd = `人闸 c3 · 运行 run-1：t\nrequest: C:/R&D/c3.request.json\nsha256: ${hash}`;
  assert.equal(parsePointer(`<paseo-system version="1" kind="agent-message">\n${odd.replace(/&/g, "&amp;")}\n</paseo-system>`)?.path, "C:/R&D/c3.request.json");
});

test("what the conversation says after a button answer is what the answer carried, not who sent it", async () => {
  const { prompt } = await gateFiles();
  const h = await host();
  await h.prompt(prompt);
  await h.send({ type: "session.permission", sessionId: "s1", permissionId: h.card()!.id, response: { behavior: "allow", selectedActionId: "approve" } });
  const said = h.events
    .filter((e) => e.type === "timeline.item" && (e as { item: { type: string } }).item.type === "assistant_message")
    .map((e) => (e as { item: { text: string } }).item.text)
    .at(-1);
  assert.ok(said?.startsWith("**已记为批准**（收到的应答带着卡片「批准」按钮的 id）"), said);
  assert.ok(!said?.includes("你点了"), said);
});
