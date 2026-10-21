// The runtime and this provider agree on the request, the receipt and the
// answer file: the runtime's own prepareGate and requestApproval
// (../../orchestration/runtime/gate.mjs) drive the provider, and the runtime
// decides. The import is by URL so that the plugin does not depend on the
// runtime's code, only its test does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createGateProvider } from "./provider";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const runtimeGate = pathToFileURL(path.join(HERE, "..", "..", "orchestration", "runtime", "gate.mjs")).href;

type Prepared = { holdPath: string; answerPath: string; requestPath: string; requestText: string; receipt: string };
type Answer = (send: (input: ProviderInput) => Promise<void>, permissionId: string, prepared: Prepared) => Promise<void>;

interface Through {
  /** What happens to the card once it is up; nothing when omitted (the gate expires). */
  answer?: Answer;
  /** Runs before the prompt reaches the provider (to change the request file under it). */
  before?: (prepared: Prepared) => Promise<void>;
  /** What the host reports instead of the provider's own turn state. */
  hostStatus?: () => string | null;
  timeout?: string;
}

/** One gate through the runtime and the provider; `answer` is what the person does with the card. */
async function gateThrough(answer: Answer | Through) {
  const { answer: act, before, hostStatus, timeout = "1m" }: Through = typeof answer === "function" ? { answer } : answer;
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
