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
//   node runtime/orch.mjs run flows/committee.mjs --question "<问题>" --committee cheap --rounds 3 --assessor worker

import { flow, define, text, flag, count, choice } from "../runtime/flow.mjs";

// Named pairings. Contrast across provider families is the point, so each one
// pairs a Claude role with a Codex role. They live here rather than in roles/
// because this flow is their only reader; smoke.mjs checks the names exist.
export const COMMITTEES = {
  default: ["planner", "reviewer"],
  cheap: ["worker", "reviewer-alt"],
};

// Timeouts are per step, not per flow. Measured 2026-09-22 on one committee
// run: the same `analyze` took 855s on claude-sonnet-5 and 138s on
// codex/gpt-5.6-sol, and later rounds ranged from 33s to 112s. At the 30m
// default a three-round committee can run for hours before anyone finds out.
// A step that blows its budget fails; the flow keeps the rounds already paid for.
const analyze = define({
  name: "analyze",
  title: "独立分析",
  headline: "plan",
  effects: "none",
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
  title: "裁决：收敛了吗",
  headline: "converged",
  effects: "none",
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

// A respond node exists to answer the assessor's question, so its line is the
// answer; `plan` is restated in full there and says less at a glance.
const respond = define({
  name: "respond",
  title: "回应",
  headline: "answer",
  effects: "none",
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

export default flow({
  name: "committee",
  description: "两家模型对抗讨论，直到收敛或到轮数上限",
  phases: [
    { id: "analyze", title: "独立分析" },
    { id: "debate", title: "辩论" },
  ],
  inputs: {
    question: text("要讨论的问题"),
    committee: choice(Object.keys(COMMITTEES), "成员配对，见 flows/committee.mjs 的 COMMITTEES"),
    rounds: count("轮数上限，含第一轮独立分析"),
    // The assessor is cheaper than the members it judges, which is unsettled
    // on purpose. A committee run on 2026-09-22 argued this exact point and
    // did not converge: one side wants an ablation test to fix a capability
    // floor, the other wants to start cheap and escalate on runtime signals
    // (a veto, low ranking confidence, a topic stalling). Both agreed the
    // residual risk is a silent bad merge of two positions that only look
    // alike. Until that is settled, naming a stronger role here raises it.
    assessor: text("裁决者的角色名；平常用 worker"),
  },
  grants: [],

  async run({ question, committee, rounds: maxRounds, assessor }, $) {
    const roles = COMMITTEES[committee];
    const member = (i) => `成员 ${"AB"[i]}（${roles[i]}）`;
    // Roles resolve here, before anything is spent, not at the first ask.
    const members = roles.map((role) => ({ role, provider: $.ctx.role(role).provider }));
    $.ctx.role(assessor);
    if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new RangeError(`rounds must be a whole number of at least 1, got ${maxRounds}`);

    const transcript = [];
    // Everything below is written so that a failure late in the loop keeps the
    // rounds already paid for. Agent calls cost money and take minutes; losing a
    // finished round because the next step failed is the expensive mistake here.
    const failures = [];
    const result = (fields) => ({
      question,
      members,
      contrastingFamilies: new Set(members.map((m) => m.provider.split("/")[0])).size > 1,
      transcript,
      failures: failures.length > 0 ? failures : null,
      ...fields,
    });

    const first = await $.phase("analyze", () => $.all(roles.map((role, i) => $.ask(analyze, { question }, { role, title: `${member(i)}独立分析` }))));
    first.forEach((outcome, i) => {
      if (!outcome.ok) failures.push({ round: 1, step: "analyze", role: roles[i], message: outcome.error.message });
    });
    // One position is not a committee. What the other member said is kept.
    if (failures.length > 0) {
      $.stop(
        `analyze failed for ${failures.map((f) => f.role).join(", ")}`,
        result({ rounds: 1, converged: null, disagreement: null, positions: first.map((o) => (o.ok ? o.value : null)) }),
      );
    }
    // Every outcome is ok past the stop above; the check is for the reader and the type checker.
    let positions = first.map((outcome) => (outcome.ok ? outcome.value : null));
    transcript.push({ round: 1, kind: "analyze", positions });

    let verdict = null;
    let round = 1;

    while (round < maxRounds) {
      const debated = await $.phase("debate", async () => {
        let assessed;
        try {
          assessed = await $.ask(assess, { question, positions, roles }, { role: assessor, title: `第 ${round} 轮裁决：收敛了吗` });
        } catch (error) {
          failures.push({ round, step: "assess", message: error.message });
          return { assessed: null, next: null };
        }
        if (assessed.converged || !assessed.nextQuestion) return { assessed, next: null };

        const focus = assessed.nextQuestion;
        const settled = await $.all(
          roles.map((role, i) =>
            $.ask(
              respond,
              { question, own: positions[i], other: positions[1 - i], otherRole: roles[1 - i], focus },
              { role, title: `${member(i)}第 ${round + 1} 轮回应` },
            ),
          ),
        );
        settled.forEach((outcome, i) => {
          if (!outcome.ok) failures.push({ round: round + 1, step: "respond", role: roles[i], message: outcome.error.message });
        });
        // A member that failed keeps its previous position rather than vanishing.
        if (settled.every((outcome) => !outcome.ok)) return { assessed, next: null };
        return { assessed, next: { focus, positions: settled.map((outcome, i) => (outcome.ok ? outcome.value : positions[i])) } };
      });
      // A failed assessment leaves the last verdict standing.
      if (debated.assessed) verdict = debated.assessed;
      if (!debated.next) break;

      round += 1;
      positions = debated.next.positions;
      transcript.push({ round, kind: "respond", focus: debated.next.focus, positions });
    }

    return result({
      rounds: round,
      // null when the cap stopped the loop before anyone assessed the last round.
      converged: verdict?.converged ?? null,
      disagreement: verdict?.converged ? null : (verdict?.realDisagreement ?? null),
      positions,
    });
  },

  // The line on the result bar. It gets the value as run.end records it; the
  // only stop above is a failed analyze, so a stopped run is said from that.
  summarize(value, { outcome }) {
    const failures = value.failures ?? [];
    if (outcome === "stopped") {
      const who = failures.filter((f) => f.step === "analyze").map((f) => f.role);
      return `独立分析失败（${who.join("、")}），没有进入辩论`;
    }
    const note = failures.length > 0 ? `（${failures.length} 次调用失败）` : "";
    if (value.converged === true) return `第 ${value.rounds} 轮收敛${note}：${value.positions[0].plan}`;
    if (value.converged === false) return `${value.rounds} 轮未收敛${note}，分歧：${value.disagreement || "裁决者没有说清"}`;
    // No assessment ever came back: one round only, or the first one failed.
    return failures.some((f) => f.step === "assess") ? `裁决失败，${value.rounds} 轮没有结论${note}` : `只做了独立分析，没有裁决${note}`;
  },
});
