// The runtime and this provider agree on the request, the receipt and the
// answer file: the runtime's own prepareGate and requestApproval
// (../../orchestration/runtime/gate.mjs) drive the provider, and the runtime
// decides. The import is by URL so that the plugin does not depend on the
// runtime's code, only its test does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createGateProvider } from "./provider";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const runtimeGate = pathToFileURL(path.join(HERE, "..", "..", "orchestration", "runtime", "gate.mjs")).href;

type Answer = (send: (input: ProviderInput) => Promise<void>, permissionId: string) => Promise<void>;

/** One gate through the runtime and the provider; `answer` is what the person does with the card. */
async function gateThrough(answer: Answer) {
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
    timeout: "1m",
  });

  const connection = await createGateProvider().connect({ versions: [1], capabilities: ["prompt.message", "prompt.steer", "permission"] });
  let status = "running";
  let permissionId: string | null = null;
  connection.onEvent((event: ProviderEvent) => {
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

  const io = {
    spawn: async (prompt: string) => {
      await send({ type: "session.prompt", sessionId: "s", prompt: { clientMessageId: "m", delivery: "auto", input: { type: "message", content: [{ type: "text", text: prompt }] } } });
      // The person answers once the card is up.
      const wait = setInterval(() => {
        if (permissionId === null) return;
        clearInterval(wait);
        void answer(send, permissionId);
      }, 5);
      return "carrier";
    },
    inspect: async () => ({ status }),
    deny: async (_id: string, how: { message: string }) => {
      if (permissionId) await send({ type: "session.permission", sessionId: "s", permissionId, response: { behavior: "deny", message: how.message } });
    },
    stop: async () => {},
    transcript: async () => "",
  };
  return gate.requestApproval(io, prepared, { pollMs: 5 });
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
