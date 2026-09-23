// Committee: two agents from contrasting provider families analyze one problem,
// then argue until a neutral assessor says they have converged or the round cap
// stops them.
//
// The scripted version of the `paseo-committee` skill. What scripting changes:
// membership comes from named roles rather than a model's judgment, each round
// is schema-checked, and the loop is bounded here.
//
// What is deliberately NOT scripted: which question to ask next. The first run
// of this script asked two models what scripting these skills would cost, and
// both independently answered that a committee's value is choosing the next
// question from the answers -- so that choice is an agent call (`assess`),
// while the mechanism around it stays fixed. Determinism belongs in the
// machinery, not in the strategy.
//
// Usage:
//   node scripts/committee.mjs "<question>" [--committee default|cheap] [--roles a,b] [--rounds 3]

import { pathToFileURL } from "node:url";
import { Orchestrator } from "../runtime/agents.mjs";
import { Audit } from "../runtime/audit.mjs";
import { define, text, flag, choice } from "../runtime/step.mjs";

// Named pairings. Contrast across provider families is the point, so each one
// pairs a Claude role with a Codex role. They live here rather than in roles/
// because this script is their only reader; smoke.mjs checks the names exist.
export const COMMITTEES = {
  default: ["planner", "reviewer"],
  cheap: ["worker", "reviewer-alt"],
};

// Timeouts are per step, not per script. Measured 2026-09-22 on one committee
// run: the same `analyze` took 855s on claude-sonnet-5 and 138s on
// codex/gpt-5.6-sol, and later rounds ranged from 33s to 112s. At the 30m
// default a three-round committee can run for hours before anyone finds out.
// A step that blows its budget fails; `runCommittee` keeps the rounds already
// paid for.
const analyze = define({
  name: "analyze",
  readOnly: true,
  timeout: "12m",
  returns: {
    diagnosis: text("The root cause as you see it. If the question is misstated, say so here."),
    plan: text("What to do about it, concretely."),
    keyRisk: text("The single thing most likely to make this plan wrong."),
    confidence: choice(["low", "medium", "high"]),
  },
  prompt: ({ question }) =>
    [
      "Step back from the immediate work and analyze this problem at the root-cause level.",
      "Read whatever files you need before concluding. Do not assume the framing is correct.",
      "",
      "## Problem",
      question,
    ].join("\n"),
});

const assess = define({
  name: "assess",
  readOnly: true,
  timeout: "5m",
  returns: {
    converged: flag("True only if both positions are substantively the same. Ending the argument is not agreement."),
    realDisagreement: text("What they actually disagree about, in one sentence. Empty string if nothing."),
    nextQuestion: text(
      "The one question that would most move them toward a shared answer. Empty string if converged. " +
        "Ask about the thing they disagree on, not for a summary.",
    ),
  },
  prompt: ({ question, positions, roles }) =>
    [
      "Two agents analyzed the same problem independently. Judge whether they have converged, and if not,",
      "find the question that would resolve the disagreement fastest.",
      "",
      "## Problem",
      question,
      "",
      `## Position A (${roles[0]})`,
      JSON.stringify(positions[0], null, 2),
      "",
      `## Position B (${roles[1]})`,
      JSON.stringify(positions[1], null, 2),
    ].join("\n"),
});

const respond = define({
  name: "respond",
  readOnly: true,
  timeout: "8m",
  returns: {
    answer: text("Your answer to the question put to you."),
    changed: flag("Did this change your position?"),
    diagnosis: text("Your diagnosis now, restated in full."),
    plan: text("Your plan now, restated in full."),
    confidence: choice(["low", "medium", "high"]),
  },
  prompt: ({ question, own, other, otherRole, focus }) =>
    [
      "You and another agent analyzed the same problem and disagree. A neutral assessor picked the question",
      "below as the one most likely to resolve it. Answer it directly.",
      "",
      "## The question put to you",
      focus,
      "",
      "## Original problem",
      question,
      "",
      "## Your position",
      JSON.stringify(own, null, 2),
      "",
      `## The other member (${otherRole})`,
      JSON.stringify(other, null, 2),
      "",
      "Hold your position where you think it is right and say why. Change it where they convinced you.",
    ].join("\n"),
});

/**
 * @param {string} question
 * @param {{ roles?: string[], committee?: string, rounds?: number, assessor?: string,
 *           cwd?: string, orchestrator?: Orchestrator }} [options]
 */
export async function runCommittee(question, options = {}) {
  const orch = options.orchestrator ?? (await Orchestrator.create({ cwd: options.cwd }));
  const preset = options.committee ?? "default";
  if (!options.roles && !COMMITTEES[preset]) {
    throw new Error(`Unknown committee "${preset}". Committees: ${Object.keys(COMMITTEES).join(", ")}`);
  }
  const roles = options.roles ?? COMMITTEES[preset];
  if (roles.length !== 2) {
    throw new Error(`A committee is exactly two members; got ${roles.length}: ${roles.join(", ")}`);
  }

  const providers = roles.map((role) => orch.provider(role));
  const maxRounds = options.rounds ?? 3;
  const transcript = [];

  // Everything below is written so that a failure late in the loop keeps the
  // rounds already paid for. Agent calls cost money and take minutes; losing a
  // finished round because the next step failed is the expensive mistake here.
  const failures = [];

  let positions = await Promise.all(roles.map((role) => orch.ask(analyze, { question }, { role })));
  transcript.push({ round: 1, kind: "analyze", positions });

  let verdict = null;
  let round = 1;

  while (round < maxRounds) {
    try {
      // The assessor is cheaper than the members it judges, which is unsettled
      // on purpose. A committee run on 2026-09-22 argued this exact point and
      // did not converge: one side wants an ablation test to fix a capability
      // floor, the other wants to start cheap and escalate on runtime signals
      // (a veto, low ranking confidence, a topic stalling). Both agreed the
      // residual risk is a silent bad merge of two positions that only look
      // alike. Until that is settled, `--assessor` is how you raise it.
      verdict = await orch.ask(assess, { question, positions, roles }, { role: options.assessor ?? "worker" });
    } catch (error) {
      failures.push({ round, step: "assess", message: error.message });
      break;
    }
    if (verdict.converged || !verdict.nextQuestion) break;

    const focus = verdict.nextQuestion;
    const settled = await Promise.allSettled(
      roles.map((role, i) =>
        orch.ask(
          respond,
          { question, own: positions[i], other: positions[1 - i], otherRole: roles[1 - i], focus },
          { role },
        ),
      ),
    );

    settled.forEach((outcome, i) => {
      if (outcome.status === "rejected") {
        failures.push({ round: round + 1, step: "respond", role: roles[i], message: outcome.reason.message });
      }
    });

    // A member that failed keeps its previous position rather than vanishing.
    if (settled.every((outcome) => outcome.status === "rejected")) break;

    round += 1;
    positions = settled.map((outcome, i) => (outcome.status === "fulfilled" ? outcome.value : positions[i]));
    transcript.push({ round, kind: "respond", focus, positions });
  }

  return {
    question,
    members: roles.map((role, i) => ({ role, provider: providers[i] })),
    contrastingFamilies: new Set(providers.map((p) => p.split("/")[0])).size > 1,
    rounds: round,
    // null when the cap stopped the loop before anyone assessed the last round.
    converged: verdict?.converged ?? null,
    disagreement: verdict?.converged ? null : (verdict?.realDisagreement ?? null),
    positions,
    transcript,
    failures: failures.length > 0 ? failures : null,
    caveats: orch.caveats.length > 0 ? [...orch.caveats] : null,
    auditRunId: orch.audit.runId,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const question = argv.find((a) => !a.startsWith("--"));
  if (!question) {
    console.error('Usage: node scripts/committee.mjs "<question>" [--committee <name>] [--roles a,b] [--rounds n]');
    process.exit(2);
  }
  const flagValue = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const audit = new Audit({ script: "committee" });
  const orchestrator = await Orchestrator.create({ audit });
  await audit.record("script.start", { question });

  const result = await runCommittee(question, {
    committee: flagValue("committee"),
    roles: flagValue("roles")?.split(","),
    rounds: flagValue("rounds") ? Number(flagValue("rounds")) : undefined,
    assessor: flagValue("assessor"),
    orchestrator,
  });

  const cost = await orchestrator.collectCosts().catch(() => null);
  await audit.record("script.end", { converged: result.converged, rounds: result.rounds, cost });
  console.log(JSON.stringify({ ...result, cost }, null, 2));
}
