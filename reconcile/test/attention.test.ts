import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionOf, countLabel, type Status } from "../shared/status";
import { issue, makeWorld, type World } from "./helpers";

// The number on the sidebar's row: what waits for the person. It is what the page lists under "要你做的", plus the cards that belong
// to no item; asking is one call (reconcile.attention) and the same function the page's own count comes from.

const mini = `export default {
  name: "mini",
  description: "x",
  applies: { source: "gcp-demo" },
  params: {},
  stages: ["s"],
  assess(kase, ctx) {
    const d = (kase.primary.fields.Release || "").slice(0, 10);
    const base = { stage: "s", health: "on-track", headline: "h " + d, next: { actor: "nobody", what: "" }, facts: [], commitments: [] };
    if (!d) return base;
    return { ...base, health: "waiting", commitments: [{
      key: "q:" + kase.id, title: "q " + kase.id, domain: "work", owner: "owner",
      trigger: { at: ctx.at(d, "18:00") },
      ask: { header: "Q" + kase.id.split(":").pop(), question: "q " + kase.id + "?", options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "B", description: "" }], allowOther: true },
      brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 3 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }] };
  },
};`;

async function withWorld<T>(items: number[], body: (w: World) => Promise<T>): Promise<T> {
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "mini.mjs": mini } } });
  try {
    for (const id of items) w.items.set(`gcp-demo:${id}`, issue(id, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    return await body(w);
  } finally {
    w.close();
  }
}

const row = (n: number, group: string) => ({ caseId: `c${n}`, row: { group } }) as unknown as Status["cases"][number];
const card = (agentId: string | null, caseIds: string[]) => ({ id: "x", agentId, caseIds }) as unknown as Status["cards"][number];

test("attentionOf: the items under 要你做的, and the raised cards of no item; the others do not count", () => {
  const status = { cases: [row(1, "me"), row(2, "them"), row(3, "me"), row(4, "system"), { caseId: "c5", row: null } as unknown as Status["cases"][number]], cards: [card("a1", []), card(null, []), card("a3", ["c1"])] };
  assert.equal(attentionOf(status), 3, "two items and one loose raised card");
  assert.equal(attentionOf({ cases: [], cards: [] }), 0);
});

test("a question waiting is one; answered, none", () =>
  withWorld([1, 2], async (w) => {
    assert.equal(w.engine.attention(), 2, "two items each with a question waiting");
    const row = (n: number) => w.engine.status().cases.find((k) => k.caseId === `gcp-demo:${n}`)!.row!;
    assert.equal(row(1).group, "me");
    w.answer({ Q1: "A" });
    const c = Object.values(w.store.state.commitments).find((x) => x.key === "q:gcp-demo:2")!;
    assert.equal(w.engine.answerQuestion(c.id, c.rounds, { option: "a" }).ok, true);
    await w.engine.tick();
    assert.equal(w.engine.attention(), 0);
  }));

test("the test card belongs to no item and counts while it is up", () =>
  withWorld([], async (w) => {
    assert.equal(w.engine.attention(), 0);
    assert.equal(w.engine.testCard().ok, true);
    await w.engine.tick();
    assert.equal(w.engine.attention(), 1);
  }));

test("the badge reads 9+ past nine", () => {
  assert.deepEqual([1, 9, 10, 40].map(countLabel), ["1", "9", "9+", "9+"]);
});
