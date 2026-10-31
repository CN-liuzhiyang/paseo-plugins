// Resume smoke: a run that stops and is carried on, with a human gate in each part. No model is called and nothing is
// written but the gates' own files, so it costs nothing; it is how a person checks, in the real app, that a stop can be
// carried on -- what part one did is not done again and the card part one's person answered is not put to them again, the card
// of part two turns up where the first one's did -- and that a stop is carried on once.
//
//   node runtime/orch.mjs run flows/resume-smoke.mjs --gate-timeout 30m --affair @affair.json
//   node runtime/orch.mjs resume <the run id it printed>          # part two, on the same affair
//   node runtime/orch.mjs resume <the same run id>                # refused: that stop was carried on
//
// The flow is carried on by running it again with the same input (`resume: "auto"`, CONVENTIONS.md "接着跑"), which is also how it
// knows which part it is in: the first run does part one and stops; the run that carries it on finds part one in the journal --
// the marker's time is the same, the first card is not asked -- and goes on to part two's card. Approved, the run is done. Left to
// expire, it stops again and can be carried on in turn; denied, it stops without offering to be carried on, since the person's
// answer would only be found again (a new run starts from the beginning).

import { flow, text } from "../runtime/flow.mjs";

const OUTCOME_WORD = { allowed: "批准", denied: "不批", expired: "过期", mismatch: "内容不一致", error: "出错" };

const CONTENT = ["-- 接着跑冒烟用的假内容，不会被写到任何地方。", "return {}", ""].join("\n");

export default flow({
  name: "resume-smoke",
  description: "接着跑冒烟：两段，各起一张人闸卡片；第一段停下，接着跑时第一段做过的不再做、第一张卡不再问，不调模型、不花钱，看停下的流程能不能接着跑、一次停下是不是只能接一次",
  phases: [{ id: "review", title: "人闸" }],
  inputs: {
    gateTimeout: text("人闸最多等多久，如 30m"),
  },
  grants: ["gate:deny"],
  resume: "auto",
  async run(input, $) {
    // No model is called by any part of it, which the button should say.
    await $.resumeWith({ spends: "nothing" });
    const marker = await $.step("marker", () => ({ madeAt: new Date().toISOString() }), { title: "记下开始的时间" });
    const first = await $.phase("review", () =>
      $.gate({
        title: "冒烟：第 1 段，点「批准」或「不批」都行（假内容）",
        content: CONTENT,
        name: "smoke.lua",
        summary: "冒烟：内容是假的，批不批都不会写到任何地方；这一段批完就停下，等着被接着跑。",
        brief: ["## 接着跑冒烟 · 第 1 段", "批或不批，这一段都会停下，然后在 `orch resume` 或事项页接着跑第 2 段；这张卡不会再问第二遍。"].join("\n"),
        timeout: input.gateTimeout,
      }),
    );
    if (!$.ctx.resumed) {
      return $.stop("第 1 段停在这里，等着接着跑第 2 段", { why: "冒烟：第 1 段停在这里，接着跑第 2 段", part: 1, decision: first.outcome, marker });
    }
    const second = await $.phase("review", () =>
      $.gate({
        title: "冒烟：第 2 段，请点「批准」完成冒烟？（假内容）",
        content: CONTENT,
        name: "smoke.lua",
        summary: "冒烟：内容是假的，批准就完成这次冒烟；不批则这一段停下，过期则还能接着跑。",
        brief: ["## 接着跑冒烟 · 第 2 段", "批准：冒烟完成。过期：这一段停下，还能接着跑。不批：停下，要重来就从头再跑一遍。"].join("\n"),
        timeout: input.gateTimeout,
      }),
    );
    if (!second.approved) {
      if (second.outcome === "denied") await $.resumeWith(null);
      return $.stop("第 2 段没批", { why: `冒烟：第 2 段没批（${OUTCOME_WORD[second.outcome] ?? second.outcome}）`, part: 2, decision: second.outcome, marker });
    }
    return { part: 2, decision: second.outcome, firstDecision: first.outcome, marker };
  },
  summarize: (value, { outcome }) =>
    outcome === "done" ? `冒烟完成：第 2 段${OUTCOME_WORD[value?.decision] ?? value?.decision}` : `第 ${value?.part ?? "?"} 段停下：人闸${OUTCOME_WORD[value?.decision] ?? value?.decision}`,
});
