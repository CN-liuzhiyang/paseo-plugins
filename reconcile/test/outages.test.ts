import assert from "node:assert/strict";
import { test } from "node:test";
import { issue, makeWorld, type World } from "./helpers";

// A source that cannot be read: who is told, and what it holds back.

async function withWorld(options: Parameters<typeof makeWorld>[0], body: (w: World) => Promise<void>) {
  const w = await makeWorld(options);
  try {
    await body(w);
  } finally {
    w.close();
  }
}

const plans = (w: World) => (w.statuses as Array<{ plan: Array<{ kind: string; summary: string }> }>).flatMap((s) => s.plan);

test("a source not read for sourceDownHours: the admin is told once, with its last error, on a 知道了 card in their hours; it goes when the source is read again", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-30" }));
    await w.run("2026-10-21 15:00");
    w.fail.source = Object.assign(new Error("请先登录"), { auth: true });
    await w.run("2026-10-21 22:00");
    assert.equal(w.cards.length, 0, "past 20:00: not now");
    assert.ok(plans(w).some((p) => p.kind === "notice" && /告诉 测试用户：gcp-demo 从 10-21 15:\d\d 起读不到/.test(p.summary)));
    await w.run("2026-10-22 09:45");
    assert.equal(w.cards.length, 1);
    const [card] = w.cards;
    assert.match(card!.card.title, /^gcp-demo 从 10-21 15:\d\d 起读不到，依赖它的判断和提醒先停着$/);
    assert.match(card!.content.brief, /请先登录/);
    assert.deepEqual(card!.content.questions[0]!.options.map((o) => o.label), ["知道了"]);
    await w.run("2026-10-23 11:00");
    assert.equal(w.cards.length, 1, "one outage, said once");
    assert.equal(w.store.state.evals, 1, "only the source being down; the unanswered statement is no candidate");
    w.fail.source = null;
    await w.run("2026-10-23 11:30");
    const outage = Object.values(w.store.state.commitments).find((c) => c.key.startsWith("source-down:"))!;
    assert.equal(outage.status, "cancelled");
    assert.equal(outage.reason, "来源恢复了");
  }));

// Three cases asked at the same time. The first reads the version file and says nothing more;
// the second reads it too but says its question rests on nothing else; the third never reads it.
const rule = `export default {
  name: "deps",
  description: "x",
  applies: { source: "gcp-demo" },
  params: {},
  stages: ["s"],
  assess(kase, ctx) {
    const n = kase.id.split(":").pop();
    if (n !== "3") ctx.item("ver-demo:main");
    return { stage: "s", health: "waiting", headline: "h", next: { actor: "me", what: "" }, facts: [], commitments: [{
      key: "q:" + kase.id, title: "q " + n, domain: "work", owner: "owner",
      trigger: { at: ctx.at("2026-10-14", "18:00") },
      ask: { header: "Q" + n, question: "q " + n + "?", options: [{ id: "a", label: "A", description: "" }], allowOther: true },
      brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 1 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push",
      ...(n === "2" ? { uses: [] } : {}) }] };
  },
};`;
// Configured but never read: stale from the start.
const versions = { id: "ver-demo", kind: "flags", itemKind: "version", files: [{ id: "main", url: "https://ver.example/main.json", labels: {} }], sections: [""], activeHours: "daily 00:00-23:59", everyMinutes: 15, offHoursEveryMinutes: 15, maxCallsPerHour: 60, timeoutSeconds: 10, domain: "work" };

test("data that may be old holds back only the questions resting on it: what a judgment read, or what its question says it uses", () =>
  withWorld({ start: "2026-10-13 10:00", config: { rules: { "deps.mjs": rule }, extraSources: [versions] } }, async (w) => {
    for (const n of [1, 2, 3]) w.items.set(`gcp-demo:${n}`, issue(n, { release: "2026-10-14" }));
    await w.run("2026-10-14 18:30");
    assert.equal(w.cards.length, 1);
    assert.deepEqual(w.cards[0]!.content.questions.map((q) => q.header), ["Q2", "Q3"]);
    assert.ok(plans(w).some((p) => p.kind === "deferred" && p.summary === "数据可能过时（ver-demo），先不问：Q1"));
    const stale = (n: number) => w.store.state.assessments[`gcp-demo:${n}`]!.stale;
    assert.deepEqual([stale(1), stale(2), stale(3)], [true, true, false], "the judgment itself read it in 1 and 2");
  }));
