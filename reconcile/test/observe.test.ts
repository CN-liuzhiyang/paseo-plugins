import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { conclude, lastDue, nextDue, wanted } from "../server/observe";
import { copyConfig, preview } from "../server/preview";
import type { Item, ObserveRequest } from "../shared/model";
import { issue, makeWorld, TEST_POLICY, type World } from "./helpers";

// Observing sources: a rule asks to have something watched for a while, a configured command
// is run while it is, and what the command found reaches the rule as the controller takes it.
// The command here is a script of the test's own, told by a file what to answer.

const SCRIPT = `const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const dir = process.argv[2];
  fs.appendFileSync(dir + "/observe-in.jsonl", JSON.stringify({ ...JSON.parse(input), cwd: process.cwd() }) + "\\n");
  const plan = JSON.parse(fs.readFileSync(dir + "/observe-out.json", "utf8"));
  if (plan.exit) { process.stderr.write(plan.stderr || "boom"); process.exit(plan.exit); }
  if (plan.raw !== undefined) { process.stdout.write(plan.raw); return; }
  const req = JSON.parse(input);
  const results = req.requests.filter((r) => !(plan.skip || []).includes(r.key)).map((r) => ({
    key: r.key, verdict: plan.verdict || "no-signal", observedAt: req.now,
    freshUntil: "freshUntil" in plan ? plan.freshUntil : req.now, numbers: plan.numbers || { devices: 0 }, notes: plan.notes || [],
    ...(plan.extra ? { extra: 1 } : {}),
  }));
  for (const key of plan.alsoKeys || []) results.push({ key, verdict: "hard-fail", freshUntil: req.now });
  const send = () => process.stdout.write(JSON.stringify({ results, ...(plan.errors ? { errors: plan.errors } : {}), ...(plan.meta ? { meta: plan.meta } : {}) }));
  if (plan.sleepMs) setTimeout(send, plan.sleepMs);
  else send();
});
`;

const RULE = `export default {
  name: "watcher", description: "x", applies: { source: "gcp-demo" }, params: {}, stages: ["s"],
  assess(kase, ctx) {
    const f = kase.primary.fields;
    const key = "w-" + kase.id.split(":")[1];
    const o = f.Watch ? ctx.observation("watch-demo", key) : null;
    const item = f.Watch ? ctx.item("watch-demo:" + key) : null;
    const said = o ? [o.verdict, o.why || "-", item ? item.fields.verdict : "none", o.reported || "none"].join(" ") : "none";
    return {
      stage: "s", health: "waiting", headline: "v " + said, next: { actor: "system", what: "x" }, facts: [],
      commitments: f.Ask ? [{ key: "q:" + kase.id, title: "q " + kase.id, domain: "work", owner: "owner", trigger: { at: ctx.at("2026-10-13", f.Ask) },
        ask: { header: "H", question: "推吗？" + said, options: [{ id: "a", label: "A", description: "" }], allowOther: false },
        brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 1 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }] : [],
      ...(f.Watch ? { observe: [{ source: f.Via || "watch-demo", key: f.Key || key,
        window: { from: ctx.at("2026-10-13", f.Watch), to: ctx.at("2026-10-13", f.WatchTo) }, reread: [60],
        params: { item: kase.id, big: f.Big ? "x".repeat(9000) : "" } }] } : {}),
    };
  },
};`;

const WATCH = { id: "watch-demo", kind: "command", everyMinutes: 10, maxCallsPerHour: 30, timeoutSeconds: 30, maxOutputBytes: 65536, maxLagMinutes: 30, downAfterMinutes: 30, domain: "work" };

async function withWatch(body: (w: World, plan: (p: Record<string, unknown>) => void, calls: () => Array<{ now: string; cwd: string; requests: Array<{ key: string; last: unknown; params: Record<string, unknown> }> }>, dir: string) => Promise<void>, start = "2026-10-13 09:50") {
  // The script and its plan live in a directory of their own; the source runs node on it.
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-observe-"));
  const script = path.join(dir, "observe.cjs");
  writeFileSync(script, SCRIPT);
  const w = await makeWorld({ start, config: { rules: { "watcher.mjs": RULE }, policy: TEST_POLICY, extraSources: [{ ...WATCH, command: [process.execPath, script, dir], cwd: dir }] } });
  const out = path.join(dir, "observe-out.json");
  const inFile = path.join(dir, "observe-in.jsonl");
  const plan = (p: Record<string, unknown>) => writeFileSync(out, JSON.stringify(p));
  plan({});
  const calls = () => (existsSync(inFile) ? readFileSync(inFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  try {
    await body(w, plan, calls, dir);
  } finally {
    w.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const put = (w: World, id: number, fields: Record<string, string>) => {
  const item = w.items.get(`gcp-demo:${id}`) ?? issue(id, { release: "2026-10-14" });
  w.items.set(`gcp-demo:${id}`, { ...item, fields: { ...item.fields, ...fields } });
};
const headline = (w: World, id: number) => w.store.state.assessments[`gcp-demo:${id}`]?.headline;
const health = (w: World) => w.store.state.sources["watch-demo"]?.health;

test("the command runs only while something is watched: through the window every few minutes, at its end, and at each reread; then not at all", () =>
  withWatch(async (w, _plan, calls) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30" });
    await w.run("2026-10-13 09:55", 5);
    assert.ok(w.store.state.observing?.["gcp-demo:1"], "asked for");
    assert.equal(calls().length, 0, "the window not begun: not run");
    await w.run("2026-10-13 13:00", 5);
    const at = calls().map((c) => c.now.slice(11, 16));
    assert.deepEqual(at, ["10:00", "10:10", "10:20", "10:30", "11:30"]);
    const first = calls()[0]!.requests[0]!;
    assert.deepEqual([first.key, first.last, first.params.item], ["w-1", null, "gcp-demo:1"], "what the rule gave, as it gave it; nothing found before");
    assert.equal((calls()[1]!.requests[0]!.last as { verdict: string }).verdict, "no-signal", "after that, what it found last time");
    // the item kept for it
    const item = w.store.state.items["watch-demo:w-1"]!;
    assert.deepEqual([item.kind, item.fields.verdict, item.fields.numbers, item.fields["window.to"].slice(11, 16)], ["observation", "no-signal", '{"devices":0}', "10:30"]);
  }));

test("'nothing found' stands only for a window watched to its end on data read in time; a problem found stays found", () =>
  withWatch(async (w, plan) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30" });
    put(w, 2, { Watch: "10:40", WatchTo: "11:00" });
    put(w, 3, { Watch: "11:10", WatchTo: "11:40" });
    put(w, 4, { Watch: "11:50", WatchTo: "12:20" });
    await w.run("2026-10-13 10:15", 5);
    assert.equal(headline(w, 1), "v insufficient-data window-open insufficient-data no-signal", "the command said nothing found, but the window is open: too little to tell, through ctx.item as well");
    await w.run("2026-10-13 10:40", 5);
    assert.equal(headline(w, 1), "v no-signal - no-signal no-signal", "watched to its end: nothing found");
    // the data lagging far behind the read
    plan({ freshUntil: "2026-10-13T08:00:00+08:00" });
    await w.run("2026-10-13 11:10", 5);
    assert.match(headline(w, 2)!, /^v insufficient-data lagging insufficient-data no-signal$/);
    // a read that was due and did not come: what was found before is not current; a problem found stays
    plan({ verdict: "hard-fail" });
    await w.run("2026-10-13 11:25", 5);
    assert.equal(headline(w, 3), "v hard-fail window-open hard-fail hard-fail", "a failure is told while the window is open");
    plan({ exit: 1, stderr: "no route" });
    await w.run("2026-10-13 12:00", 5);
    assert.equal(headline(w, 3), "v hard-fail not-read hard-fail hard-fail", "not read since, and still the failure it was");
    await w.run("2026-10-13 12:30", 5);
    assert.equal(headline(w, 4), "v insufficient-data none-yet none none", "never read: too little to tell (and no item to look up)");
  }));

test("a key watched again with another window does not carry what was found for the one before", () =>
  withWatch(async (w, plan) => {
    plan({ verdict: "hard-fail" });
    put(w, 1, { Watch: "10:00", WatchTo: "10:20", Key: "same" });
    await w.run("2026-10-13 10:25", 5);
    plan({ exit: 1 });
    put(w, 1, { Watch: "10:30", WatchTo: "10:50", Key: "same" });
    await w.run("2026-10-13 10:35", 5);
    // the rule reads its own key (w-1), so look at what the controller makes of "same" directly
    const seen = conclude(w.store.state.observing!["gcp-demo:1"]!.requests[0]!, w.store.state.items["watch-demo:same"]!, w.store.state.sources["watch-demo"]!.health.readAt!["watch-demo:same"]!, { everyMs: 600_000, graceMs: 0, maxLagMs: 1_800_000, nowMs: w.clock.now, tz: "Asia/Shanghai" });
    assert.deepEqual([seen.verdict, seen.why, seen.reported], ["insufficient-data", "none-yet", null], "the failure found in the window before is not this window's");
  }));

test("what the command prints is checked: a field it should not have, an answer for a key not asked, output over the cap, a failed run, and 'auth'", () =>
  withWatch(async (w, plan, calls) => {
    put(w, 1, { Watch: "10:00", WatchTo: "12:00" });
    plan({ extra: true });
    await w.run("2026-10-13 10:00", 5);
    assert.equal(health(w), undefined, "a run is taken in at the round after it started");
    await w.run("2026-10-13 10:05", 5);
    assert.equal(health(w)?.state, "degraded");
    assert.match(health(w)!.lastError!, /观察命令的输出不对：.*extra/);
    assert.equal(w.store.state.items["watch-demo:w-1"], undefined, "nothing of it is kept");
    plan({ alsoKeys: ["w-99"] });
    await w.run("2026-10-13 10:25", 5);
    assert.equal(health(w)?.state, "ok");
    assert.match(health(w)!.lastError!, /w-99: 没有要过它/);
    assert.equal(w.store.state.items["watch-demo:w-99"], undefined, "an answer for what was not asked is not kept");
    plan({ skip: ["w-1"] });
    await w.run("2026-10-13 10:35", 5);
    assert.match(health(w)!.lastError!, /w-1: 观察命令没给结果/);
    plan({ raw: "x".repeat(70_000) });
    await w.run("2026-10-13 10:45", 5);
    assert.match(health(w)!.lastError!, /输出超过 65536 字节/);
    // numbers past the cap: the output is not taken
    plan({ numbers: { big: "x".repeat(17_000) } });
    await w.run("2026-10-13 10:55", 5);
    assert.match(health(w)!.lastError!, /numbers over 16384 bytes/);
    // an error for the whole run beside something found: taken, the error kept beside it; nothing read: no time for the data
    plan({ verdict: "needs-look", errors: ["query"], meta: { seconds: 61, log: "y".repeat(5000) }, freshUntil: null, numbers: { related: [{ symbol: "A::b" }] } });
    await w.run("2026-10-13 11:10", 5);
    assert.deepEqual([health(w)?.state, health(w)?.lastError, (w.store.state.items["watch-demo:w-1"] as Item | undefined)?.fields.verdict], ["ok", "query", "needs-look"]);
    plan({ exit: 3, stderr: "line one\nline two" });
    await w.run("2026-10-13 11:30", 5);
    assert.match(health(w)!.lastError!, /观察命令退出码 3：line one line two/);
    // what is wrong for the whole run, and nothing found for anything: a read that failed
    plan({ verdict: "insufficient-data", errors: ["network"], notes: ["连不上"] });
    await w.run("2026-10-13 12:00", 5);
    assert.match(health(w)!.lastError!, /观察命令读不了：network/);
    assert.equal((w.store.state.items["watch-demo:w-1"] as Item | undefined)?.fields.verdict, "needs-look", "and what was found before is not replaced by it");
    // read again, then credentials that stop working: down at once, not after three failures
    plan({});
    await w.run("2026-10-13 12:25", 5);
    assert.deepEqual([health(w)?.state, health(w)?.failures], ["ok", 0]);
    plan({ errors: ["auth"] });
    await w.run("2026-10-13 13:05", 5);
    assert.deepEqual([health(w)?.state, health(w)?.failures], ["down", 1], "credentials that do not work: down at once");
  }));

test("an observing source failing while it watches is told after its own downAfterMinutes, and the card goes when there is nothing left to watch", () =>
  withWatch(async (w, plan) => {
    plan({ exit: 1 });
    put(w, 1, { Watch: "10:40", WatchTo: "11:30" });
    put(w, 2, { Watch: "14:00", WatchTo: "14:30" });
    await w.run("2026-10-13 11:05", 5);
    const card = () => Object.values(w.store.state.commitments).find((c) => c.key.startsWith("source-down:watch-demo"));
    assert.equal(card(), undefined, "25 minutes: not yet");
    await w.run("2026-10-13 11:20", 5);
    assert.ok(card(), "past 30 minutes of watching: told");
    assert.match(card()!.brief, /观察来源 \*\*watch-demo\*\* 从 10-13 10:40 起一直没读到，超过 30 分钟了/);
    // the window and its reread over: nothing left to read, the card goes, and not as recovered
    await w.run("2026-10-13 13:00", 5);
    assert.deepEqual([card()!.status, card()!.reason], ["cancelled", "不用再读了"]);
    // the next watch, still failing: counted from when it began, not from the failure long before
    const cards = () => Object.values(w.store.state.commitments).filter((c) => c.key.startsWith("source-down:watch-demo") && c.status !== "cancelled");
    await w.run("2026-10-13 14:20", 5);
    assert.equal(cards().length, 0, "20 minutes into this watch: not yet");
    await w.run("2026-10-13 14:40", 5);
    assert.equal(cards().length, 1);
    assert.match(cards()[0]!.brief, /从 10-13 14:00 起/);
  }));

test("a question resting on what was observed goes out after the reads have stopped: an observing source idle is not data gone stale", () =>
  withWatch(async (w) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30", Ask: "15:00" });
    await w.run("2026-10-13 15:10", 5);
    assert.equal(w.cards.length, 1, JSON.stringify(w.engine.status().plan));
    assert.equal(w.cards[0]!.content.questions[0]!.question, "推吗？no-signal - no-signal no-signal");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.stale, false);
  }));

test("a change of rules held by the breaker starts no watch, as it writes no fact", () =>
  withWatch(async (w, _plan, calls) => {
    const file = path.join(w.configDir, "rules", "watcher.mjs");
    // in use first: a version that asks nothing and watches nothing
    writeFileSync(file, RULE.replace("...(f.Watch ?", "...(false ?").replace("commitments: f.Ask ?", "commitments: false ?"));
    for (const id of [1, 2, 3, 4]) put(w, id, { Watch: "10:00", WatchTo: "10:30", Ask: "12:00" });
    await w.run("2026-10-13 09:55", 5);
    writeFileSync(file, RULE);
    await w.run("2026-10-13 10:20", 5);
    assert.ok(w.store.state.rules.held, "four new questions at once: held");
    assert.equal(w.store.state.observing?.["gcp-demo:1"], undefined);
    assert.equal(calls().length, 0);
    assert.ok(w.engine.status().plan.some((p) => p.kind === "held" && p.summary.includes("要观察：w-1")), JSON.stringify(w.engine.status().plan));
  }));

test("a rule's request is checked: an observing source it names, a window that is one, params within the cap", () =>
  withWatch(async (w) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30", Via: "flags-demo" });
    put(w, 2, { Watch: "10:30", WatchTo: "10:00" });
    put(w, 3, { Watch: "10:00", WatchTo: "10:30", Big: "1" });
    await w.run("2026-10-13 10:00", 5);
    const error = (id: number) => w.store.state.assessments[`gcp-demo:${id}`]?.error ?? "";
    assert.match(error(1), /observe 里的 "flags-demo" 不是配置里的观察来源/);
    assert.match(error(2), /window ends before it starts/);
    assert.match(error(3), /params over 8192 bytes/);
    assert.equal(w.store.state.observing?.["gcp-demo:1"], undefined, "a failed judgment starts no watch");
  }));

test("a case no longer followed watches nothing; a request taken back is not read again", () =>
  withWatch(async (w, _plan, calls) => {
    put(w, 1, { Watch: "10:00", WatchTo: "11:00" });
    put(w, 2, { Watch: "10:00", WatchTo: "11:00" });
    await w.run("2026-10-13 10:05", 5);
    assert.deepEqual(Object.keys(w.store.state.observing ?? {}).sort(), ["gcp-demo:1", "gcp-demo:2"]);
    w.store.append([{ type: "annotation.added", annotation: { id: "an_x", caseId: "gcp-demo:1", kind: "drop", said: "不用追了", by: "owner", via: null, how: "own-words", at: new Date(w.clock.now).toISOString(), until: null, person: null, what: null, expected: null, revoked: null } }] as never);
    put(w, 2, { Watch: "" });
    await w.run("2026-10-13 10:15", 5);
    assert.deepEqual(Object.keys(w.store.state.observing ?? {}), []);
    const n = calls().length;
    await w.run("2026-10-13 12:30", 5);
    assert.equal(calls().length, n, "nothing is read for either any more");
  }));

test("the preview runs on what was found as it was read: nothing new is read, and what was found is not lost", () =>
  withWatch(async (w) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30" });
    await w.run("2026-10-13 10:40", 5);
    assert.equal(headline(w, 1), "v no-signal - no-signal no-signal");
    const candidate = mkdtempSync(path.join(os.tmpdir(), "reconcile-observe-candidate-"));
    try {
      rmSync(candidate, { recursive: true });
      copyConfig(w.configDir, candidate);
      writeFileSync(path.join(candidate, "rules", "watcher.mjs"), RULE.replace('headline: "v " + said', 'headline: "c " + said'));
      const p = await preview({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now });
      const now = p.cases.find((c) => c.caseId === "gcp-demo:1")!;
      assert.deepEqual(now.fields.find((f) => f.field === "现状"), { field: "现状", inUse: "v no-signal - no-signal no-signal", candidate: "c no-signal - no-signal no-signal" });
    } finally {
      rmSync(candidate, { recursive: true, force: true });
    }
  }));

test("a slow command runs beside the rounds: they go on meanwhile, it is not started again, and what it brings is taken in after", () =>
  withWatch(async (w, plan, calls, dir) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30" });
    await w.run("2026-10-13 09:55", 5);
    plan({ sleepMs: 1500 });
    const at = (hm: string) => (w.clock.now = Date.parse(`2026-10-13T${hm}:00+08:00`));
    at("10:00");
    let started = Date.now();
    await w.engine.tick();
    assert.ok(Date.now() - started < 1000, "the round did not wait for it");
    await new Promise((resolve) => setTimeout(resolve, 300));
    at("10:10");
    started = Date.now();
    await w.engine.tick();
    assert.ok(Date.now() - started < 1000);
    assert.equal(calls().length, 1, "running: not started again, though a read is due");
    assert.equal(w.store.state.items["watch-demo:w-1"], undefined, "nothing taken in yet");
    await w.engine.settled();
    at("10:12");
    await w.engine.tick();
    const readAt = w.store.state.sources["watch-demo"]!.health.readAt!["watch-demo:w-1"]!;
    assert.equal(readAt.slice(11, 16), "10:00", "taken in as read when it started");
    assert.equal(w.store.state.sources["watch-demo"]!.health.lastOkAt!.slice(11, 16), "10:00");
    // it runs where it was told to
    assert.equal(realpathSync.native(calls()[0]!.cwd).toLowerCase(), realpathSync.native(dir).toLowerCase());
  }));

// ---- the timing, on its own --------------------------------------------------------------------

const REQ: ObserveRequest = { source: "s", key: "k", window: { from: "2026-10-13T10:00:00+08:00", to: "2026-10-13T10:30:00+08:00" }, reread: [60, 180], params: {} };
const ms = (hm: string) => Date.parse(`2026-10-13T${hm}:00+08:00`);

test("when a read is due: every few minutes from the window's start, at its end, and at each reread", () => {
  const every = 10 * 60_000;
  assert.equal(lastDue(REQ, every, ms("09:59")), null);
  assert.equal(lastDue(REQ, every, ms("10:15")), ms("10:10"));
  assert.equal(lastDue(REQ, every, ms("10:45")), ms("10:30"));
  assert.equal(lastDue(REQ, every, ms("11:45")), ms("11:30"));
  assert.equal(nextDue(REQ, every, ms("10:25")), ms("10:30"));
  assert.equal(nextDue(REQ, every, ms("12:00")), ms("13:30"));
  assert.equal(nextDue(REQ, every, ms("13:30")), null);
  assert.equal(wanted(REQ, every, ms("10:15"), ms("10:11")), false, "read since the last point");
  assert.equal(wanted(REQ, every, ms("10:31"), ms("10:21")), true, "the window's end is a point of its own");
  assert.equal(wanted(REQ, every, ms("09:00"), null), false);
});

test("what is concluded from an item: grace for a read on its way; lag measured from the read", () => {
  const item: Item = { key: "s:k", source: "s", kind: "observation", title: "k", url: null, status: "no-signal", closed: false, fields: { verdict: "no-signal", freshUntil: "2026-10-13T10:25:00+08:00", "window.from": REQ.window.from, "window.to": REQ.window.to, numbers: '{"devices":2,"related":[{"symbol":"A::b","devices":2}]}', "notes.0": "n" }, people: {}, parent: null, sourceUpdatedAt: null, observedAt: "" };
  const o = { everyMs: 600_000, graceMs: 5 * 60_000, maxLagMs: 30 * 60_000, tz: "Asia/Shanghai" };
  const at = (now: string, read: string, it = item) => conclude(REQ, it, `2026-10-13T${read}:00+08:00`, { ...o, nowMs: ms(now) });
  assert.deepEqual([at("10:33", "10:21").verdict, at("10:33", "10:21").why], ["insufficient-data", "window-open"], "the end's read on its way: the window is not watched to its end yet");
  assert.deepEqual([at("10:40", "10:21").why, at("10:40", "10:21").whyText], ["not-read", "10-13 10:30 该读的没读到（上次读到是 10-13 10:21）"]);
  assert.deepEqual([at("10:31", "10:30").verdict, at("10:31", "10:30").numbers, at("10:31", "10:30").notes], ["no-signal", { devices: 2, related: [{ symbol: "A::b", devices: 2 }] }, ["n"]], "what it found, nested as it gave it");
  const old = { ...item, fields: { ...item.fields, freshUntil: "2026-10-13T09:59:00+08:00" } };
  assert.deepEqual([at("10:31", "10:30", old).verdict, at("10:31", "10:30", old).whyText], ["insufficient-data", "数据只到 10-13 09:59"]);
  const unknown = { ...item, fields: { ...item.fields, freshUntil: "" } };
  assert.equal(at("10:31", "10:30", unknown).why, "lagging", "not saying how far the data goes is not fresh data");
});
