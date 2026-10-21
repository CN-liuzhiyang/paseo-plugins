// Gate smoke: one human gate over made-up content, nothing else. No model is
// called and nothing is written but the gate's own files, so it costs nothing;
// it is how a person checks, in the real app, what a gate card looks like and
// that each way of answering it is read right.
//
//   node runtime/orch.mjs run flows/gate-smoke.mjs --round 1 --task "请点「不批」" --gate-timeout 30m
//
// The title says what the person is to do with this card: three cards that look
// the same got the same answer, whatever they were meant to test (2026-10-21).
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
    round: text("第几张，写进卡片标题，如 1、补测 A"),
    task: text("这张卡要人做什么，写进卡片标题，如：请点「不批」"),
    gateTimeout: text("人闸最多等多久，如 30m"),
  },
  grants: ["gate:deny"],
  run: (input, $) =>
    $.phase("review", () =>
      $.gate({
        title: `冒烟${input.round}：${input.task}（假内容）`,
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
          "- 按卡片标题说的做。",
        ].join("\n"),
        evidence: [{ label: "要实现的修复（假的）", text: DIFF, kind: "diff", name: "greet.lua" }],
        timeout: input.gateTimeout,
      }),
    ),
  summarize: (decision) =>
    `人闸：${OUTCOME_WORD[decision?.outcome] ?? decision?.outcome}（answeredVia ${decision?.answeredVia ?? "无"}${decision?.reason ? `，理由：${decision.reason}` : ""}）`,
});
