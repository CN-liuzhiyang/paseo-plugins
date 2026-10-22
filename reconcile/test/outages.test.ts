import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../server/config";
import { createEngine, type Carrier } from "../server/engine";
import type { Source } from "../server/sources/source";
import { openStore } from "../server/store";
import { at, issue, makeWorld, type World } from "./helpers";

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

// One case, one question per entry, all asked at the same time; uses as given.
const usesRule = (uses: Record<string, string[] | null>) => `export default {
  name: "uses",
  description: "x",
  applies: { source: "gcp-demo" },
  params: {},
  stages: ["s"],
  assess(kase, ctx) {
    const uses = ${JSON.stringify(uses)};
    return { stage: "s", health: "waiting", headline: "h", next: { actor: "me", what: "" }, facts: [], commitments: Object.entries(uses).map(([h, u]) => ({
      key: "q:" + h + ":" + kase.id, title: "q " + h, domain: "work", owner: "owner",
      trigger: { at: ctx.at("2026-10-14", "18:00") },
      ask: { header: h, question: h + "?", options: [{ id: "a", label: "A", description: "" }], allowOther: true },
      brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 1 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push",
      ...(u ? { uses: u } : {}) })) };
  },
};`;

test("a file of a switch source not read holds a question that uses the file, or the whole source; one that uses only its case's source goes", () =>
  withWorld({ start: "2026-10-13 10:00", config: { rules: { "uses.mjs": usesRule({ DEF: null, SRC: ["flags-demo"], FILE: ["flags-demo:outer"], NONE: [] }) } } }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    // Not read for an hour and a half: stale, but not long enough for an outage card.
    await w.run("2026-10-14 17:00");
    w.fail.files.add("outer");
    await w.run("2026-10-14 18:30");
    assert.deepEqual(w.cards.flatMap((c) => c.content.questions.map((q) => q.header)), ["NONE"]);
    assert.ok(plans(w).some((p) => p.summary === "数据可能过时（flags-demo:outer），先不问：DEF、SRC、FILE"));
  }));

test("a name in uses that is no source, file or known item fails the judgment instead of holding nothing", () =>
  withWorld({ start: "2026-10-13 10:00", config: { rules: { "uses.mjs": usesRule({ TYPO: ["flag-demo:outer"] }) } } }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-13 10:30");
    assert.match(w.store.state.assessments["gcp-demo:1"]!.error!, /uses 里的 "flag-demo:outer" 不是配置里的来源、文件或已有的数据项/);
    assert.equal(Object.keys(w.store.state.commitments).length, 0);
  }));

test("with no admin, a long outage is said on the page: nobody gets the card", () =>
  withWorld({ start: "2026-10-21 10:00", config: { persons: { owner: { name: "测试用户", admin: false, tz: "Asia/Shanghai", quiet: { work: "workdays 09:30-20:00" }, pushPerDay: 8 } } } }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-30" }));
    await w.run("2026-10-21 10:30");
    w.fail.source = new Error("boom");
    await w.run("2026-10-21 19:00");
    assert.equal(w.cards.length, 0);
    assert.ok(w.engine.status().problems.some((p) => /^gcp-demo 从 10-21 1\d:\d\d 起读不到，但 persons.json 里没有 admin，没人收故障卡$/.test(p)));
  }));

test("an outage card nobody answers expires after a week, and is no candidate for evaluation", () =>
  withWorld({ start: "2026-10-21 10:00" }, async (w) => {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-12-30" }));
    await w.run("2026-10-21 10:30");
    w.fail.source = new Error("boom");
    await w.run("2026-10-30 12:00", 60);
    const outage = Object.values(w.store.state.commitments).find((c) => c.key.startsWith("source-down:"))!;
    assert.equal(outage.status, "expired");
    assert.equal(w.store.state.evals, 1, "only the source being down");
  }));

test("an engine stopped while a card's carrier is being raised writes nothing, and archives the carrier that came back", async () => {
  const w = await makeWorld({ start: "2026-10-13 10:00" });
  w.store.close();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const archived: string[] = [];
  const carrier: Carrier = {
    async raise() {
      await gate;
      return "agent-late";
    },
    async archive(agentId) {
      archived.push(agentId);
    },
  };
  const source: Source = { id: "gcp-demo", domain: "work", poll: async () => ({ snapshots: [], cursor: null, calls: 1, errors: [], more: false }) };
  try {
    const store = openStore({ dir: w.dataDir, now: () => w.clock.now });
    const engine = createEngine({ config: loadConfig(w.configDir), store, sources: [source], carrier, mode: "live", instanceId: "t", home: w.dir, tickSeconds: 60, now: () => w.clock.now, log: () => {}, writeStatus: () => {} });
    await engine.recover();
    assert.equal(engine.testCard().ok, true);
    w.clock.now = at("2026-10-13 10:01");
    const tick = engine.tick();
    for (let i = 0; i < 50 && Object.keys(store.state.cards).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const stopping = engine.stop();
    open();
    await tick;
    await stopping;
    assert.deepEqual(archived, ["agent-late"]);
    const [card] = Object.values(store.state.cards);
    assert.equal(card!.agentId, null, "no record of a carrier nobody would track");
    store.close();
  } finally {
    w.close();
  }
});
