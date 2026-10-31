// Each @ts-expect-error below is a mistake the editor must catch; tsc fails
// if any of them stops being an error.
import { flow, define, text, choice, list, group, flag, pointer } from "../../runtime/flow.mjs";

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

// @ts-expect-error headline names a field of returns
define({ name: "x", effects: "none", returns: { a: text() }, headline: "b", prompt: () => "p" });

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
    await $.ask(analyze, { question }, { check: (a) => (a.confidence === "low" ? [{ at: pointer("items", 0, "target"), say: "name the file" }] : null), fixes: 1 });
    await $.ask(analyze, { question }, { check: async (a) => (a.items.length > 0 ? undefined : "no items") });
    // @ts-expect-error a check reads the step's answer, so a misspelled field is caught
    await $.ask(analyze, { question }, { check: (a) => a.diagnosys });
    // @ts-expect-error a problem is { at, say }
    await $.ask(analyze, { question }, { check: () => [{ where: "/a", say: "x" }] });
    // @ts-expect-error fixes is a number
    await $.ask(analyze, { question }, { fixes: "2" });
    const next = await $.again(answer, "name the file");
    /** @type {"low" | "medium" | "high"} */
    const again = next.confidence;
    await $.again(answer, analyze, { question }, { check: null, archive: null, fresh: false });
    await $.again(answer, "redo", { fresh: true, role: "worker", check: (a) => (a.items.length > 0 ? [] : "no items") });
    // @ts-expect-error the question is a string
    await $.again(answer, 42);
    // @ts-expect-error a misspelled field of the answer is caught in the check
    await $.again(answer, "redo", { check: (a) => a.diagnosys });
    // @ts-expect-error fresh is true or false
    await $.again(answer, "redo", { fresh: "yes" });
    // @ts-expect-error phase id not declared
    await $.phase("debate", async () => null);
    // @ts-expect-error inputs are the declared ones
    rounds.toFixed();
    // @ts-expect-error $.do takes only a title
    await $.do("read", () => 1, { name: "x" });
    const [a, b] = await $.all([$.ask(analyze, { question }), () => $.do("read", () => 42, { title: "读取" })]);
    if (b.ok) {
      /** @type {number} */
      const n = b.value;
    }
    if (a.ok) a.value.diagnosis;
    // @ts-expect-error a settled task must be checked before its value is read
    b.value.toFixed();
    const gated = await $.gate({ title: "t", content: "c", input: { label: "验证码", pattern: "\d{6}", hint: "6 位数字" } });
    /** @type {string | null | undefined} */
    const given = gated.input;
    // @ts-expect-error the value is a string, not a number
    gated.input?.toFixed();
    // @ts-expect-error an input needs a label
    await $.gate({ title: "t", content: "c", input: { secret: true } });
    // @ts-expect-error secret is a boolean
    await $.gate({ title: "t", content: "c", input: { label: "x", secret: "yes" } });
    await $.resumeWith({ flow: "build-resume", input: { dir: "r" }, from: "编译已过：从核对接着", spends: "nothing" });
    await $.resumeWith(null);
    // @ts-expect-error spends is required
    await $.resumeWith({ flow: "build-resume", input: {}, from: "x" });
    // @ts-expect-error spends is one of two words
    await $.resumeWith({ flow: "build-resume", input: {}, from: "x", spends: "sometimes" });
    // @ts-expect-error a flow is named, not found by a path
    await $.resumeWith({ flow: "flows/build-resume.mjs", input: {}, from: "x", spends: "nothing" });
    // @ts-expect-error nor by a file name
    await $.resumeWith({ flow: "build-resume.mjs", input: {}, from: "x", spends: "nothing" });
    // @ts-expect-error nor by a Windows path
    await $.resumeWith({ flow: "C:\\flows\\build-resume", input: {}, from: "x", spends: "nothing" });
    // @ts-expect-error a point is an object or null
    await $.resumeWith("build-resume");
    // In a flow that runs again by itself, a point is only what differs from that.
    await $.resumeWith({ from: "核对已过：从回填接着", spends: "nothing" });
    // @ts-expect-error spends is one of two words
    await $.resumeWith({ spends: "sometimes" });
    // @ts-expect-error another flow is the whole point
    await $.resumeWith({ flow: "other" });

    const built = await $.step("build", () => ({ n: 1 }), { key: { question }, still: (value) => value.n > 0 });
    /** @type {number} */
    const n = built.n;
    // @ts-expect-error the value of a step is what its function returns
    built.m;
    // @ts-expect-error still reads the step's value
    await $.step("build", () => ({ n: 1 }), { still: (value) => value.m > 0 });
    // @ts-expect-error a step is named
    await $.step(() => 1);
    // @ts-expect-error a step has a function
    await $.step("build", 1);
    // @ts-expect-error once is true or false
    await $.step("commit", () => 1, { once: "yes" });
    // @ts-expect-error a probe finds the step's value when it was done
    await $.step("commit", () => ({ n: 1 }), { once: true, probe: () => ({ done: true }) });
    const committed = await $.step("commit", (given) => ({ ok: given.approved }), {
      once: true,
      before: () => $.gate({ title: "t", content: "c", input: { label: "验证码" } }),
      probe: () => ({ done: false }),
    });
    /** @type {boolean} */
    const approved = committed.ok;
    // @ts-expect-error what before returns is what the step's function is given
    await $.step("send", (given) => given.nothing, { once: true, before: () => $.gate({ title: "t", content: "c" }) });
    await $.ask(analyze, { question }, { reuse: (a) => a.confidence === "low" });
    // @ts-expect-error reuse reads the step's answer
    await $.ask(analyze, { question }, { reuse: (a) => a.diagnosys });
    /** @type {string} */
    const line = $.ctx.lineage;
    /** @type {boolean} */
    const resumed = $.ctx.resumed;
    return { d, c, ok, n, approved, line, resumed };
  },
  summarize: (value, { outcome }) => `${outcome}: ${value.d}`,
  resume: "auto",
  wake: "problems",
});

flow({
  name: "quiet",
  description: "d",
  phases: [],
  inputs: {},
  grants: [],
  // @ts-expect-error wake is "problems" or left out
  wake: "always",
  async run() {
    return 1;
  },
});
