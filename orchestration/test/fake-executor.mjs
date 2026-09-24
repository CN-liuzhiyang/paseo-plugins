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
// The gate's carrier is simulated from its prompt: `carrier: "approve"` writes
// the content to the hold path (what an approved Write does), "deny" writes
// nothing, "hang" never finishes (the gate expires).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fakeExecutor({ answer = () => ({}), carrier = "approve", usd = 0.01, delayMs = 0 } = {}) {
  const agents = new Map();
  const requests = [];
  const denied = [];
  let count = 0;

  const start = (request, status) => {
    const id = `fake-agent-${++count}`;
    agents.set(id, { id, labels: request.labels, status, request });
    return id;
  };

  return {
    agents,
    requests,
    denied,

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
      const holdPath = /with file_path (.+) and the content/.exec(request.prompt)?.[1];
      const content = /<<<CONTENT\n([\s\S]*)\nCONTENT>>>/.exec(request.prompt)?.[1];
      if (carrier !== "hang") {
        setTimeout(async () => {
          if (carrier === "approve") {
            await mkdir(path.dirname(holdPath), { recursive: true });
            await writeFile(holdPath, content, "utf8");
          }
          agents.get(id).status = "idle";
        }, 5);
      }
      return { agentId: id };
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

    async transcript() {
      return "The write was denied.";
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
