import { issue, makeWorld, type World } from "./helpers";

// A rule with stages that carry metadata (a detour, an end that is not finishing) judging made-up items whose fields a test moves.

export const FLOW = `export default {
  name: "flow", description: "x", applies: { source: "gcp-demo" }, params: {},
  stages: [
    { id: "draft", label: "草稿" },
    { id: "review", label: "评审" },
    { id: "rework", label: "返工", side: true, when: "评审打回时" },
    { id: "ship", label: "上线" },
    { id: "finished", label: "完成", end: true },
    { id: "dropped", label: "不再做", end: true, endKind: "dropped" },
  ],
  assess(kase, ctx) {
    const f = kase.primary.fields;
    if (f.Boom) throw new Error("rule failed on " + kase.id);
    const stage = f.Phase || "draft";
    const base = { stage, health: f.Health || (stage === "finished" ? "done" : "on-track"), headline: "h " + stage, next: { actor: f.Ball || "them", what: f.What || "等" }, facts: [], commitments: [] };
    if (f.Ask) base.commitments = [{
      key: "q:" + kase.id, title: "q " + kase.id, domain: "work", owner: "owner",
      trigger: { at: ctx.at(f.Ask, "10:00") },
      ask: { header: "H" + kase.id.split(":").pop(), question: "q " + kase.id + "?", options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "B", description: "" }], allowOther: false },
      brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 3 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }];
    return f.Since ? { ...base, since: f.Since } : base;
  },
};`;

export const START = "2026-10-13 10:00";

export async function withFlow<T>(body: (w: World) => Promise<T>, rule = FLOW): Promise<T> {
  const w = await makeWorld({ start: START, config: { rules: { "flow.mjs": rule } } });
  try {
    return await body(w);
  } finally {
    w.close();
  }
}

/** Sets fields of item `id` (a hot one: it has a release day close by). */
export const set = (w: World, id: number, fields: Record<string, string>) => {
  const item = w.items.get(`gcp-demo:${id}`) ?? issue(id, { release: "2026-10-14" });
  w.items.set(`gcp-demo:${id}`, { ...item, fields: { ...item.fields, ...fields } });
};
export const view = (w: World, id: number) => w.engine.graph(`gcp-demo:${id}`)!;
export const rowOf = (w: World, id: number) => w.engine.status().cases.find((c) => c.caseId === `gcp-demo:${id}`)!.row!;
