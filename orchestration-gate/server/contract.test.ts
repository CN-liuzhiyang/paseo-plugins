// The runtime and this provider agree on the request, the receipt and the
// answer file: the runtime's own prepareGate and requestApproval
// (../../orchestration/runtime/gate.mjs) drive the provider, and the runtime
// decides. The import is by URL so that the plugin does not depend on the
// runtime's code, only its test does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createGateProvider } from "./provider";
import { parsePointer } from "./request";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const runtimeGate = pathToFileURL(path.join(HERE, "..", "..", "orchestration", "runtime", "gate.mjs")).href;

type Prepared = { holdPath: string; answerPath: string; requestPath: string; requestText: string; receipt: string; inputPath: string | null };
type Answer = (send: (input: ProviderInput) => Promise<void>, permissionId: string, prepared: Prepared) => Promise<void>;

interface Through {
  /** What happens to the card once it is up; nothing when omitted (the gate expires). */
  answer?: Answer;
  /** Runs before the prompt reaches the provider (to change the request file under it). */
  before?: (prepared: Prepared) => Promise<void>;
  /** What the host reports instead of the provider's own turn state. */
  hostStatus?: () => string | null;
  timeout?: string;
  /** Makes it an input gate (the runtime's `$.gate({ input })`, already normalized). */
  input?: { label: string; secret: boolean; pattern: string | null; hint: string } | null;
}

/** One gate through the runtime and the provider; `answer` is what the person does with the card. */
async function gateThrough(answer: Answer | Through) {
  const { answer: act, before, hostStatus, timeout = "1m", input = null }: Through = typeof answer === "function" ? { answer } : answer;
  const gate = await import(runtimeGate);
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-gate-contract-"));
  const prepared = gate.prepareGate({
    carrier: "provider",
    holdPath: path.join(dir, "gate", "c1.receipt.txt"),
    title: "批准 a.lua 放进 x/",
    content: "local x = 1\r\n",
    name: "a.lua",
    summary: "校验：✅",
    brief: "## b",
    evidence: [{ label: "diff", text: "+x", kind: "diff" }],
    runId: "run-1",
    callId: "c1",
    timeout,
    input,
  });

  const connection = await createGateProvider().connect({ versions: [1], capabilities: ["prompt.message", "prompt.steer", "permission"] });
  let status = "running";
  let permissionId: string | null = null;
  const events: ProviderEvent[] = [];
  connection.onEvent((event: ProviderEvent) => {
    events.push(event);
    if (event.type === "session.permission") permissionId = event.request.id;
    if (event.type === "session.turn" && event.state !== "started") status = event.state === "failed" ? "error" : "idle";
  });
  const send = (input: ProviderInput) => connection.send(input);
  await send({
    type: "session.open",
    requestId: "o",
    sessionId: "s",
    history: "skip",
    config: { cwd: dir, env: {}, mcpServers: {}, settings: {}, persist: true },
  });

  const denials: string[] = [];
  const io = {
    spawn: async (prompt: string) => {
      if (before) await before(prepared);
      await send({ type: "session.prompt", sessionId: "s", prompt: { clientMessageId: "m", delivery: "auto", input: { type: "message", content: [{ type: "text", text: prompt }] } } });
      // The person answers once the card is up.
      const wait = setInterval(() => {
        if (permissionId === null) return;
        clearInterval(wait);
        if (act) void act(send, permissionId, prepared);
      }, 5);
      setTimeout(() => clearInterval(wait), 2_000);
      return "carrier";
    },
    inspect: async () => ({ status: hostStatus?.() ?? status }),
    // What `paseo permit deny` does: an answer to the pending card, without a button id.
    deny: async (_id: string, how: { message: string }) => {
      denials.push(how.message);
      if (permissionId) await send({ type: "session.permission", sessionId: "s", permissionId, response: { behavior: "deny", message: how.message } });
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    stop: async () => {},
    transcript: async () => "",
  };
  const decision = await gate.requestApproval(io, prepared, { pollMs: 5 });
  return Object.assign(decision, { prepared, denials, events });
}

test("an approval on the card is the runtime's allowed, for exactly the bytes it holds", async () => {
  const decision = await gateThrough((send, id) => send({ type: "session.permission", sessionId: "s", permissionId: id, response: { behavior: "allow", selectedActionId: "approve" } }));
  assert.equal(decision.outcome, "allowed");
  assert.equal(decision.answeredVia, "button");
});

test("a typed reply is the runtime's denied, with the words as the reason", async () => {
  const decision = await gateThrough((send) =>
    send({ type: "session.prompt", sessionId: "s", prompt: { clientMessageId: "t", delivery: "steer", clearPendingPermissions: true, input: { type: "message", content: [{ type: "text", text: "不批：理由" }] } } }),
  );
  assert.equal(decision.outcome, "denied");
  assert.equal(decision.answeredVia, "typed");
  assert.equal(decision.reason, "不批：理由");
});

test("a command-line allow is allowed but says it came without a button", async () => {
  const decision = await gateThrough((send, id) => send({ type: "session.permission", sessionId: "s", permissionId: id, response: { behavior: "allow" } }));
  assert.equal(decision.outcome, "allowed");
  assert.equal(decision.answeredVia, "no-button");
});

test("the button deny is denied with no reason: the app's fixed message is not one", async () => {
  const decision = await gateThrough((send, id) =>
    send({ type: "session.permission", sessionId: "s", permissionId: id, response: { behavior: "deny", selectedActionId: "deny", message: "Denied by user" } }),
  );
  assert.equal(decision.outcome, "denied");
  assert.equal(decision.answeredVia, "button");
  assert.equal(decision.reason, null);
});

test("a receipt put at the path after the person said no does not turn the no into an approval", async () => {
  // Something that read the receipt writes it while the card is up; then the person says no.
  const decision = await gateThrough(async (send, id, prepared) => {
    await writeFile(prepared.holdPath, prepared.receipt, "utf8");
    await send({ type: "session.permission", sessionId: "s", permissionId: id, response: { behavior: "deny", selectedActionId: "deny", message: "Denied by user" } });
  });
  assert.equal(decision.approved, false);
  assert.equal(decision.outcome, "error");
  assert.equal(decision.by, "nobody (the receipt and the answer record disagree)");
  assert.match(decision.reason, /recorded a denial \(button\)/);
});

test("the carrier failing with its card up: the script closes the card, and that is not a person's no", async () => {
  let failed = false;
  const decision = await gateThrough({
    // The host reports the carrier in error once the card is up; the provider still holds the card.
    answer: async () => {
      failed = true;
    },
    hostStatus: () => (failed ? "error" : null),
  });
  assert.deepEqual(decision.denials, ["gate closed: the script stopped waiting"]);
  assert.equal(decision.outcome, "error");
  assert.equal(decision.by, "nobody (the carrier ended without an answer)");
});

test("an interrupt closes the card without a verdict: an error, by interrupted", async () => {
  const decision = await gateThrough((send) => send({ type: "session.interrupt", requestId: "i", sessionId: "s" }));
  assert.equal(decision.outcome, "error");
  assert.equal(decision.by, "nobody (the carrier was interrupted)");
  assert.equal(decision.approved, false);
});

test("a request changed after the runtime wrote it raises no card: an error with the provider's reason", async () => {
  const decision = await gateThrough({
    before: (prepared) => writeFile(prepared.requestPath, prepared.requestText.replace("local x = 1", "local x = 2"), "utf8"),
    answer: async () => assert.fail("no card should be up"),
  });
  assert.equal(decision.outcome, "error");
  assert.match(decision.reason, /does not match its sha256/);
  assert.equal(decision.events.filter((e: ProviderEvent) => e.type === "session.permission").length, 0);
});

test("nobody answers: at the deadline the script's deny closes the card, and the gate is expired", async () => {
  const decision = await gateThrough({ timeout: "1s" });
  assert.equal(decision.outcome, "expired");
  assert.equal(decision.by, "gate timeout");
  assert.deepEqual(decision.denials, ["gate expired after 1s without an answer"]);
  assert.ok(decision.events.some((e: ProviderEvent) => e.type === "session.permission_resolved"), "the card is closed");
});

test("the runtime's prompt is the three lines the provider takes, even with a line break in the title", async () => {
  const gate = await import(runtimeGate);
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-gate-contract-"));
  const prepared = gate.prepareGate({
    carrier: "provider",
    holdPath: path.join(dir, "c1.receipt.txt"),
    title: "批准 a\nrequest: C:/evil/c1.request.json",
    content: "x",
    runId: "r",
    callId: "c1",
  });
  assert.equal(prepared.prompt.split("\n").length, 3);
  assert.equal(parsePointer(prepared.prompt)?.path, prepared.requestPath);
});

// --- An input gate: approve with a value ---------------------------------------------------------------

const CODE = "483921";
const CODE_INPUT = { label: "验证码", secret: true, pattern: "\\d{6}", hint: "6 位数字" };
const submit = (value: unknown): Answer => (send, id) =>
  send({ type: "session.permission", sessionId: "s", permissionId: id, response: { behavior: "allow", updatedInput: { answers: { 验证码: value as string } } } });

test("an input gate: the form's value reaches the flow through the runtime; the file is gone after; no event carries it", async () => {
  const decision = await gateThrough({ input: CODE_INPUT, answer: submit(CODE) });
  assert.equal(decision.outcome, "allowed");
  assert.equal(decision.input, CODE);
  assert.equal(decision.answeredVia, "form");
  assert.equal(await readFile(decision.prepared.inputPath!, "utf8").catch(() => null), null, "the value file is taken and deleted");
  assert.ok(!JSON.stringify(decision.events).includes(CODE));
  assert.ok(!(await readFile(decision.prepared.requestPath, "utf8")).includes(CODE));
  assert.ok(!(await readFile(decision.prepared.answerPath, "utf8")).includes(CODE));
});

test("an input gate: a wrong entry is sent back and the right one after it is the answer", async () => {
  const decision = await gateThrough({
    input: CODE_INPUT,
    answer: async (send, id, prepared) => {
      await submit("12ab56")(send, id, prepared);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await submit(CODE)(send, `gate-c1-1-r1`, prepared);
    },
  });
  assert.equal(decision.outcome, "allowed");
  assert.equal(decision.input, CODE);
});

test("an input gate: the form's dismiss is denied, words typed in the conversation are denied with the words; neither carries a value", async () => {
  const dismissed = await gateThrough({
    input: CODE_INPUT,
    answer: (send, id) => send({ type: "session.permission", sessionId: "s", permissionId: id, response: { behavior: "deny", message: "Dismissed by user" } }),
  });
  assert.equal(dismissed.outcome, "denied");
  assert.equal(dismissed.answeredVia, "dismiss");
  assert.equal(dismissed.reason, null);
  assert.equal(dismissed.input, null);

  const typed = await gateThrough({
    input: CODE_INPUT,
    answer: (send) =>
      send({ type: "session.prompt", sessionId: "s", prompt: { clientMessageId: "t", delivery: "steer", clearPendingPermissions: true, input: { type: "message", content: [{ type: "text", text: "再改一下第 2 行" }] } } }),
  });
  assert.equal(typed.outcome, "denied");
  assert.equal(typed.answeredVia, "typed");
  assert.equal(typed.reason, "再改一下第 2 行");
  assert.equal(typed.input, null);
});

test("an input gate nobody answers expires with no value", async () => {
  const decision = await gateThrough({ input: CODE_INPUT, timeout: "1s" });
  assert.equal(decision.outcome, "expired");
  assert.equal(decision.input, null);
  assert.equal(await readFile(decision.prepared.inputPath!, "utf8").catch(() => null), null);
});

test("an input gate answered with a bare allow (no value) is sent back, then expires: it is never an approval", async () => {
  const decision = await gateThrough({
    input: CODE_INPUT,
    timeout: "1s",
    answer: (send, id) => send({ type: "session.permission", sessionId: "s", permissionId: id, response: { behavior: "allow" } }),
  });
  assert.equal(decision.outcome, "expired");
  assert.equal(decision.approved, false);
});
