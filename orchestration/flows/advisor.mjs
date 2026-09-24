// Advisor: one agent, usually from a contrasting provider family, gives a
// judgment. It does not drive the work.
//
// The scripted version of `paseo-advisor`. The briefing stays with the caller
// -- writing it is judgment, and whoever has the context should do it, in the
// question itself. What the flow fixes is everything around it: the role,
// the effects, the shape of the answer, and the record of it.
//
//   node runtime/orch.mjs run flows/advisor.mjs --question "<问题>" --role reviewer

import { flow, define, text, choice } from "../runtime/flow.mjs";

export const advise = define({
  name: "advise",
  effects: "none",
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
  prompt: ({ question }) =>
    [
      "You are being asked for a second opinion. You have no prior context on this work.",
      "Read the files you need before answering.",
      "",
      "## Question",
      question,
    ].join("\n"),
});

export default flow({
  name: "advisor",
  description: "一个 agent 给第二意见，不接手工作",
  phases: [],
  inputs: {
    question: text("要问的问题，连同对方需要的背景；大段材料给绝对路径"),
    role: text("给意见的角色名；平常用 reviewer（与调用方不同家族）"),
  },
  grants: [],

  async run({ question, role }, $) {
    const { provider } = $.ctx.role(role);
    const answer = await $.ask(advise, { question }, { role });
    return { question, advisor: { role, provider }, answer };
  },
});
