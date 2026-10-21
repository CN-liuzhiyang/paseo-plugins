// Gate smoke: one human gate over made-up content, nothing else. No model is
// called and nothing is written but the gate's own files, so it costs nothing;
// it is how a person checks, in the real app, what a gate card looks like and
// that each way of answering it is read right.
//
//   node runtime/orch.mjs run flows/gate-smoke.mjs --round 1 --gate-timeout 30m
//
// The decision is the run's value; `summarize` says it in one line.

import { flow, text } from "../runtime/flow.mjs";

const CONTENT = [
  "-- 人闸冒烟用的假内容，不会被写到任何地方。",
  "local M = {}",
  "",
  "function M.greet(name)",
  '  return "hello, " .. tostring(name)',
  "end",
  "",
  "return M",
  "",
].join("\n");

const DIFF = ["--- a/greet.lua", "+++ b/greet.lua", "@@ -1,3 +1,3 @@", " function M.greet(name)", '-  return "hello, " .. name', '+  return "hello, " .. tostring(name)', " end"].join("\n");

const OUTCOME_WORD = { allowed: "批准", denied: "不批", expired: "过期", mismatch: "内容不一致", error: "出错" };

export default flow({
  name: "gate-smoke",
  description: "人闸冒烟：对一份假内容起一张人闸卡片，不调模型、不花钱，看卡片长相和每种应答怎么判",
  phases: [{ id: "review", title: "人闸" }],
  inputs: {
    round: text("第几次，只用来区分卡片标题，如 1、2、3"),
    gateTimeout: text("人闸最多等多久，如 30m"),
  },
  grants: ["gate:deny"],
  run: (input, $) =>
    $.phase("review", () =>
      $.gate({
        title: `批准 冒烟第 ${input.round} 次：greet.lua 放进 smoke/（假内容）`,
        content: CONTENT,
        name: "greet.lua",
        summary: ["冒烟：内容是假的，批不批都不会写到任何地方。", "校验：✅ 1 项通过（假的）· ⚪ 1 项没跑（假的）"].join("\n"),
        brief: [
          "## 人闸冒烟",
          "这是一张测试卡，用来看人闸卡片的样子、以及每种应答会被判成什么。",
          "",
          "### ① 脚本核实的（假的）",
          "- ✅ 语法：通过",
          "",
          "### ③ 需要你判断的",
          "- 按入口会话给你的顺序应答：点「不批」、在输入框打字、点「批准」。",
        ].join("\n"),
        evidence: [{ label: "要实现的修复（假的）", text: DIFF, kind: "diff", name: "greet.lua" }],
        timeout: input.gateTimeout,
      }),
    ),
  summarize: (decision) =>
    `人闸：${OUTCOME_WORD[decision?.outcome] ?? decision?.outcome}（answeredVia ${decision?.answeredVia ?? "无"}${decision?.reason ? `，理由：${decision.reason}` : ""}）`,
});
