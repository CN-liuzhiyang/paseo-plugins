// Each @ts-expect-error below is a mistake the editor must catch; tsc fails
// if any of them stops being an error.
import { flow, define, text, choice, list, group, flag } from "../../runtime/flow.mjs";

const analyze = define({
  name: "analyze",
  effects: "none",
  timeout: "12m",
  returns: {
    diagnosis: text(),
    confidence: choice(["low", "medium", "high"]),
    items: list(group({ target: text(), ok: flag() })),
  },
  prompt: ({ question }) => question,
});

// @ts-expect-error effects is required
define({ name: "x", returns: { a: text() }, prompt: () => "p" });

export default flow({
  name: "probe",
  description: "d",
  phases: [{ id: "analyze", title: "A" }],
  inputs: { question: text(), rounds: text() },
  grants: [],
  async run({ question, rounds }, $) {
    const answer = await $.ask(analyze, { question }, { role: "planner" });
    /** @type {string} */
    const d = answer.diagnosis;
    /** @type {"low" | "medium" | "high"} */
    const c = answer.confidence;
    /** @type {boolean} */
    const ok = answer.items[0].ok;
    // @ts-expect-error misspelled field of the answer
    answer.diagnosys;
    // @ts-expect-error not one of the choices
    if (answer.confidence === "certain") return null;
    // @ts-expect-error mode is gone
    await $.ask(analyze, { question }, { role: "planner", mode: "auto" });
    // @ts-expect-error phase id not declared
    await $.phase("debate", async () => null);
    // @ts-expect-error inputs are the declared ones
    rounds.toFixed();
    const [a, b] = await $.all([$.ask(analyze, { question }), () => $.do("read", () => 42)]);
    if (b.ok) {
      /** @type {number} */
      const n = b.value;
    }
    if (a.ok) a.value.diagnosis;
    // @ts-expect-error a settled task must be checked before its value is read
    b.value.toFixed();
    return { d, c, ok };
  },
});
