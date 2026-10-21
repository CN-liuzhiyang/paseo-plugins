// An executor that spends nothing: every agent is an entry in a map, every
// answer comes from `answer(request)`. The runner cannot tell it from the
// Paseo one (runtime/executor.mjs), which is the point -- a flow runs end to
// end, events and all, without a daemon.
//
// `answer` gets the ask request ({ provider, mode, labels, prompt, schema, ... });
// `labels["orch-step"]` is the step name. Return the structured output, or
// throw to fail the call. `delayMs` spaces calls out so that durations and
// overlap look like something.
//
// The gate's carrier is simulated from its prompt, for either carrier
// (gate.mjs): the provider's pointer prompt is followed to its request file,
// the model's prompt is read for its receipt. `carrier`:
//   "approve"    the receipt is written (an approved Write, or the provider after an allow)
//   "deny"       nothing is written; the provider records a button deny
//   "typed"      provider only: the person typed a reply instead (`typed` is the text)
//   "cli-deny"   provider only: denied without a button id, with `message`
//   "paraphrase" the content is written in place of the receipt
//   "decline"    model only: the carrier makes no write and says why (no card is raised)
//   "hang"       never finishes (the gate expires)
// `providers` is what providerAvailable reports as available.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** What an answered carrier leaves behind, per `carrier` (see above). */
export async function carryAs(carrier, prompt, { typed, message }) {
  const pointer = /^request: (.+)\nsha256: ([0-9a-f]{64})$/m.exec(prompt);
  if (pointer) {
    const text = await readFile(pointer[1], "utf8");
    const request = JSON.parse(text);
    const record = (answer) => writeFile(request.answerPath, JSON.stringify(answer), "utf8");
    if (sha256(text) !== pointer[2]) return record({ error: "request file does not match its sha256" });
    await mkdir(path.dirname(request.receiptPath), { recursive: true });
    if (carrier === "approve") {
      await writeFile(request.receiptPath, request.receipt, "utf8");
      return record({ behavior: "allow", via: "button", selectedActionId: "approve" });
    }
    if (carrier === "paraphrase") {
      await writeFile(request.receiptPath, request.content, "utf8");
      return record({ behavior: "allow", via: "button", selectedActionId: "approve" });
    }
    if (carrier === "typed") return record({ behavior: "deny", via: "typed", typed });
    if (carrier === "cli-deny") return record({ behavior: "deny", via: "no-button", message });
    return record({ behavior: "deny", via: "button", selectedActionId: "deny", message: "Denied by user" });
  }
  const holdPath = /with file_path (.+) and the receipt/.exec(prompt)?.[1];
  const receipt = /<<<RECEIPT\n([\s\S]*)\nRECEIPT>>>/.exec(prompt)?.[1];
  const content = /【待批全文】[^\n]*\n([\s\S]*)\n\n---\n（以下是给载体/.exec(prompt)?.[1];
  if (carrier === "approve" || carrier === "paraphrase") {
    await mkdir(path.dirname(holdPath), { recursive: true });
    await writeFile(holdPath, carrier === "approve" ? receipt : content, "utf8");
  }
}

export function fakeExecutor({
  answer = () => ({}),
  carrier = "approve",
  usd = 0.01,
  delayMs = 0,
  providers = ["orch-gate"],
  typed = "这个类的源文件不对，别批",
  message = "denied from the command line",
} = {}) {
  const agents = new Map();
  const requests = [];
  const denied = [];
  const transcripts = [];
  let count = 0;
  const carry = (prompt) => carryAs(carrier, prompt, { typed, message });

  const start = (request, status) => {
    const id = `fake-agent-${++count}`;
    agents.set(id, { id, labels: request.labels, status, request });
    return id;
  };

  return {
    agents,
    requests,
    denied,
    transcripts,

    async ask(request) {
      requests.push(request);
      const id = start(request, "running");
      await sleep(typeof delayMs === "function" ? delayMs(request) : delayMs);
      try {
        const output = await answer(request);
        agents.get(id).status = "idle";
        return output;
      } catch (error) {
        agents.get(id).status = "error";
        throw error;
      }
    },

    async spawn(request) {
      requests.push(request);
      const id = start(request, "running");
      if (carrier !== "hang") setTimeout(() => carry(request.prompt).then(() => (agents.get(id).status = "idle")), 5);
      return { agentId: id };
    },

    async providerAvailable(family) {
      return providers.includes(family);
    },

    async findAgent(labels) {
      for (const agent of agents.values()) {
        if (Object.entries(labels).every(([key, value]) => agent.labels?.[key] === value)) return agent.id;
      }
      return null;
    },

    async inspect(agentId) {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`no agent ${agentId}`);
      return { status: agent.status, usage: { usd, inputTokens: 1200, outputTokens: 300 } };
    },

    // Like `paseo logs --filter`: "assistant_message" is what the agent said;
    // "tools" lists its tool calls as "[Name] ..."; "text" also has the prompt
    // it was given and its thinking. A carrier that never got an answer
    // (`hang`) has said nothing; one that declined made no tool call.
    async transcript(agentId, { filter = "text" } = {}) {
      transcripts.push({ agentId, filter });
      const said = carrier === "hang" ? "" : carrier === "decline" ? "我不替你批这次写入。" : "The write was denied.";
      if (filter === "assistant_message") return said === "" ? "No activity to display." : said;
      if (filter === "tools") {
        const holdPath = /with file_path (.+) and the receipt/.exec(agents.get(agentId)?.request.prompt ?? "")?.[1];
        return carrier === "decline" || !holdPath ? "No activity to display." : `[Write] ${holdPath}`;
      }
      const prompt = agents.get(agentId)?.request.prompt ?? "";
      return [`[User] ${prompt}`, "[Thought] The user asks me to write a file.", said].filter(Boolean).join("\n");
    },

    async deny(agentId) {
      denied.push(agentId);
    },

    async stop(agentId) {
      const agent = agents.get(agentId);
      if (agent) agent.status = "idle";
    },
  };
}

/**
 * Answers for committee's three steps. `assess` says "not converged" until
 * round `convergeAt`; `fail` names calls to fail, as "<step>:<provider>:<n>"
 * where n counts that step's calls on that provider from 1.
 */
export function committeeAnswers({ convergeAt = 2, fail = [] } = {}) {
  const seen = new Map();
  let assessments = 0;
  return (request) => {
    const step = request.labels["orch-step"];
    const key = `${step}:${request.provider}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (fail.includes(`${key}:${seen.get(key)}`)) throw new Error(`fake failure of ${step} on ${request.provider}`);
    switch (step) {
      case "analyze":
        return {
          diagnosis: `(${request.provider}) The cache is invalidated by the wrong key.`,
          plan: "Key the cache on the resolved path, not the requested one.",
          keyRisk: "Symlinked checkouts resolve to the same path.",
          confidence: "medium",
        };
      case "assess":
        assessments += 1;
        return assessments >= convergeAt
          ? { converged: true, realDisagreement: "", nextQuestion: "" }
          : {
              converged: false,
              realDisagreement: "Whether symlinked checkouts must share a cache entry.",
              nextQuestion: "Should two checkouts that resolve to the same path share one cache entry?",
            };
      case "respond":
        return {
          answer: "Yes: they are the same files, so one entry is correct.",
          changed: request.provider.startsWith("codex/"),
          diagnosis: "The cache is invalidated by the wrong key.",
          plan: "Key the cache on the resolved path.",
          confidence: "high",
        };
      default:
        throw new Error(`committeeAnswers: unexpected step ${step}`);
    }
  };
}
