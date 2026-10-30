// Resume smoke: a run that stops and is carried on, with a human gate in each part. No model is called and nothing is
// written but the gates' own files, so it costs nothing; it is how a person checks, in the real app, that a stop can be
// carried on -- the card of the second part turns up where the first one's did -- and that a stop is carried on once.
//
//   node runtime/orch.mjs run flows/resume-smoke.mjs --stage start --gate-timeout 30m --affair @affair.json
//   node runtime/orch.mjs resume <the run id it printed>          # the second part, on the same affair
//   node runtime/orch.mjs resume <the same run id>                # refused: that stop was carried on
//
// Part one (`start`) asks for a card, whichever way it is answered says where it can be picked up -- the second part of
// this flow -- and stops. Part two (`finish`) asks for another card; approved, the run is done. Not approved, it stops
// again and declares itself as the resume point, so a part that does not get its approval can be asked again: the flow that
// is carried on says how it could be carried on in its turn (CONVENTIONS.md "接着跑").

import { flow, choice, text } from "../runtime/flow.mjs";

const OUTCOME_WORD = { allowed: "批准", denied: "不批", expired: "过期", mismatch: "内容不一致", error: "出错" };

const CONTENT = ["-- 接着跑冒烟用的假内容，不会被写到任何地方。", "return {}", ""].join("\n");

export default flow({
  name: "resume-smoke",
  description: "接着跑冒烟：两段，各起一张人闸卡片；第一段停下并声明从第二段接着，不调模型、不花钱，看停下的流程能不能接着跑、一次停下是不是只能接一次",
  phases: [{ id: "review", title: "人闸" }],
  inputs: {
    stage: choice(["start", "finish"], "start 是第一段；finish 是第二段（接着跑起来的就是它）"),
    gateTimeout: text("人闸最多等多久，如 30m"),
  },
  grants: ["gate:deny"],
  async run(input, $) {
    const again = { flow: "resume-smoke", input: { stage: "finish", gateTimeout: input.gateTimeout }, spends: "nothing" };
    if (input.stage === "start") {
      const decision = await $.phase("review", () =>
        $.gate({
          title: "冒烟：第 1 段，点「批准」或「不批」都行（假内容）",
          content: CONTENT,
          name: "smoke.lua",
          summary: "冒烟：内容是假的，批不批都不会写到任何地方；这一段批完就停下，等着被接着跑。",
          brief: ["## 接着跑冒烟 · 第 1 段", "批或不批，这一段都会停下，然后在 `orch resume` 或事项页接着跑第 2 段。"].join("\n"),
          timeout: input.gateTimeout,
        }),
      );
      await $.resumeWith({ ...again, from: "第 1 段停在这里：接着跑会再起一张卡（第 2 段）" });
      return $.stop("第 1 段停在这里，等着接着跑第 2 段", { why: "冒烟：第 1 段停在这里，接着跑第 2 段", part: 1, decision: decision.outcome });
    }
    const decision = await $.phase("review", () =>
      $.gate({
        title: "冒烟：第 2 段，请点「批准」完成冒烟？（假内容）",
        content: CONTENT,
        name: "smoke.lua",
        summary: "冒烟：内容是假的，批准就完成这次冒烟，不批则这一段停下，可以再接着跑。",
        brief: ["## 接着跑冒烟 · 第 2 段", "批准：冒烟完成。不批：这一段停下，还能接着跑。"].join("\n"),
        timeout: input.gateTimeout,
      }),
    );
    if (!decision.approved) {
      await $.resumeWith({ ...again, from: "第 2 段没批：接着跑会再起一张卡（第 2 段）" });
      return $.stop("第 2 段没批", { why: `冒烟：第 2 段没批（${OUTCOME_WORD[decision.outcome] ?? decision.outcome}），可以再接着跑`, part: 2, decision: decision.outcome });
    }
    return { part: 2, decision: decision.outcome };
  },
  summarize: (value, { outcome }) =>
    outcome === "done" ? `冒烟完成：第 2 段${OUTCOME_WORD[value?.decision] ?? value?.decision}` : `第 ${value?.part ?? "?"} 段停下：人闸${OUTCOME_WORD[value?.decision] ?? value?.decision}`,
});
