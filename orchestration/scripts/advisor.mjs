// Advisor: one agent from a contrasting provider family gives a judgment. It
// does not drive the work.
//
// The scripted version of `paseo-advisor`. The briefing stays with the caller
// -- writing it is judgment, and whoever has the context should do it. What
// the script fixes is everything around it: provider, read-only handling, the
// shape of the answer, and the audit line.
//
// Usage:
//   node scripts/advisor.mjs "<question>" [--role reviewer] [--context <file>]

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Orchestrator } from "../runtime/agents.mjs";
import { Audit } from "../runtime/audit.mjs";
import { define, text, choice } from "../runtime/step.mjs";

export const advise = define({
  name: "advise",
  readOnly: true,
  timeout: "12m",
  returns: {
    verdict: text("Your judgment, in one or two sentences."),
    reasoning: text("Why. Name the evidence you actually looked at."),
    recommendation: text("What you would do, concretely."),
    whatWouldChangeMyMind: text(
      "The specific finding that would flip this verdict. A falsifier, not a hedge. " +
        "If you cannot name one, your confidence is not high.",
    ),
    confidence: choice(["low", "medium", "high"]),
  },
  prompt: ({ question, context }) =>
    [
      "You are being asked for a second opinion. You have no prior context on this work.",
      "Read the files you need before answering.",
      "",
      "## Question",
      question,
      ...(context ? ["", "## Context from the caller", context] : []),
    ].join("\n"),
});

/**
 * @param {string} question
 * @param {{ role?: string, context?: string, cwd?: string, orchestrator?: Orchestrator }} [options]
 */
export async function runAdvisor(question, options = {}) {
  const orch = options.orchestrator ?? (await Orchestrator.create({ cwd: options.cwd }));
  const role = options.role ?? "reviewer";

  const answer = await orch.ask(advise, { question, context: options.context }, { role });

  return {
    question,
    advisor: { role, provider: orch.provider(role) },
    answer,
    caveats: orch.caveats.length > 0 ? [...orch.caveats] : null,
    auditRunId: orch.audit.runId,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const question = argv.find((a) => !a.startsWith("--"));
  if (!question) {
    console.error('Usage: node scripts/advisor.mjs "<question>" [--role <role>] [--context <file>]');
    process.exit(2);
  }
  const flagValue = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const audit = new Audit({ script: "advisor" });
  const orchestrator = await Orchestrator.create({ audit });
  await audit.record("script.start", { question });

  const contextFile = flagValue("context");
  const result = await runAdvisor(question, {
    role: flagValue("role"),
    context: contextFile ? await readFile(contextFile, "utf8") : undefined,
    orchestrator,
  });

  const cost = await orchestrator.collectCosts().catch(() => null);
  await audit.record("script.end", { confidence: result.answer.confidence, cost });
  console.log(JSON.stringify({ ...result, cost }, null, 2));
}
