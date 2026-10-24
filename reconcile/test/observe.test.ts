import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { conclude, lastDue, live, nextDue, requestVersion, wanted } from "../server/observe";
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
  fs.writeFileSync(dir + "/pid", String(process.pid));
  fs.appendFileSync(dir + "/observe-in.jsonl", JSON.stringify({ ...JSON.parse(input), cwd: process.cwd() }) + "\\n");
  const plan = JSON.parse(fs.readFileSync(dir + "/observe-out.json", "utf8"));
  if (plan.exit) { process.stderr.write(plan.stderr || "boom"); process.exit(plan.exit); }
  if (plan.raw !== undefined) { process.stdout.write(plan.raw); return; }
  const req = JSON.parse(input);
  const results = req.requests.filter((r) => !(plan.skip || []).includes(r.key)).map((r) => ({
    key: r.key, verdict: plan.verdict || "no-signal", observedAt: req.now,
    freshUntil: "freshUntil" in plan ? plan.freshUntil : req.now, numbers: plan.numbers || { devices: 0, ...(r.params.region ? { region: r.params.region } : {}) }, notes: plan.notes || [],
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
    const o = f.Watch ? ctx.observation("watch-demo", f.Key || key) : null;
    const item = f.Watch ? ctx.item("watch-demo:" + (f.Key || key)) : null;
    const said = o ? [o.verdict, o.why || "-", item ? item.fields.verdict : "none", o.reported || "none"].join(" ") : "none";
    const told = JSON.stringify({ f: o ? o.failure : null, w: o ? o.whyText : null, n: item ? item.fields.numbers : null });
    return {
      stage: "s", health: "waiting", headline: "v " + said, next: { actor: "system", what: told }, facts: [],
      commitments: f.Ask ? [{ key: "q:" + kase.id, title: "q " + kase.id, domain: "work", owner: "owner", trigger: { at: ctx.at("2026-10-13", f.Ask) },
        ask: { header: "H", question: "推吗？" + said, options: [{ id: "a", label: "A", description: "" }], allowOther: false },
        brief: "b", nag: { everyWorkdays: 1, at: "10:00", max: 1 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }] : [],
      ...(f.Watch ? { observe: [{ source: f.Via || "watch-demo", key: f.Key || key,
        window: { from: ctx.at("2026-10-13", f.Watch), to: ctx.at("2026-10-13", f.WatchTo) }, reread: [60],
        params: { item: kase.id, big: f.Big ? "汉".repeat(3000) : "", ...(f.Region ? { region: f.Region } : {}),
          ...(f.Cutoff ? { cutoff: new Date(ctx.at("2026-10-13", f.Cutoff)) } : {}), platform: f.Platform, ...(f.Churn ? { asOf: ctx.now } : {}) } }] } : {}),
    };
  },
};`;

const WATCH = { id: "watch-demo", kind: "command", everyMinutes: 10, maxCallsPerHour: 30, timeoutSeconds: 30, maxOutputBytes: 65536, maxLagMinutes: 30, downAfterMinutes: 30, domain: "work" };

async function withWatch(body: (w: World, plan: (p: Record<string, unknown>) => void, calls: () => Array<{ now: string; cwd: string; requests: Array<{ key: string; last: unknown; params: Record<string, unknown>; window: { from: string; to: string } }> }>, dir: string) => Promise<void>, start = "2026-10-13 09:50") {
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
    await w.engine.stop();
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
    // nothing for the one key asked: a read that failed, not a read
    plan({ skip: ["w-1"] });
    await w.run("2026-10-13 10:35", 5);
    assert.deepEqual([health(w)?.state, health(w)?.failures], ["degraded", 1]);
    assert.match(health(w)!.lastError!, /观察命令没给要的结果/);
    // the caps are on bytes as written (UTF-8), not on characters
    plan({ raw: "汉".repeat(25_000) });
    await w.run("2026-10-13 10:45", 5);
    assert.match(health(w)!.lastError!, /输出超过 65536 字节/);
    // numbers past the cap: the output is not taken
    plan({ numbers: { big: "汉".repeat(6_000) } });
    await w.run("2026-10-13 10:55", 5);
    assert.match(health(w)!.lastError!, /numbers over 16384 bytes/);
    // an error for the whole run beside something found: taken, the error kept beside it; nothing read: no time for the data;
    // notes are for people: past ten left out, each cut short, none refused for it
    const notes = ["长".repeat(2000), ...Array.from({ length: 11 }, (_, i) => `n${i}`)];
    plan({ verdict: "needs-look", errors: ["query"], meta: { seconds: 61, log: "y".repeat(5000) }, freshUntil: null, numbers: { related: [{ symbol: "A::b" }] }, notes });
    await w.run("2026-10-13 11:10", 5);
    assert.deepEqual([health(w)?.state, health(w)?.lastError, (w.store.state.items["watch-demo:w-1"] as Item | undefined)?.fields.verdict], ["ok", "query", "needs-look"]);
    const kept = (w.store.state.items["watch-demo:w-1"] as Item).fields;
    assert.deepEqual([kept["notes.9"], kept["notes.10"], kept["notes.0"]!.length <= 300], ["n8", undefined, true]);
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

const ms = (hm: string) => Date.parse(`2026-10-13T${hm}:00+08:00`);

/** One round at a local time of 2026-10-13 ("10:41" or ms); the commands it starts are not waited for. */
const tickAt = async (w: World, at: string | number) => {
  w.clock.now = typeof at === "number" ? at : ms(at);
  await w.engine.tick();
};
const sleep = (n: number) => new Promise((resolve) => setTimeout(resolve, n));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Rounds a minute apart from `from` until the followed item has `field` = `value` (taken in), at most an hour. */
async function untilTaken(w: World, from: string, field: string, value: string, settle = true) {
  for (let t = ms(from); t < ms(from) + 3_600_000; t += 60_000) {
    await tickAt(w, t);
    if (settle) await w.engine.settled();
    if (w.store.state.items["gcp-demo:1"]?.fields[field] === value) return;
  }
  assert.fail(`${field} = ${value} not taken in`);
}

test("what was read is for the request it was read for: other params or a window ending before the last read are read anew, and the round that asks for them takes nothing from before", () =>
  withWatch(async (w, _plan, calls) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30" });
    await w.run("2026-10-13 10:40", 5);
    assert.equal(headline(w, 1), "v no-signal - no-signal no-signal");
    const n = calls().length;
    // the same key and window, other params
    put(w, 1, { Region: "global" });
    await untilTaken(w, "10:41", "Region", "global");
    assert.equal(headline(w, 1), "v insufficient-data none-yet insufficient-data none", "the round it is asked in: what was read for the params before is not its");
    assert.equal(JSON.parse(w.store.state.assessments["gcp-demo:1"]!.next.what).n, "{}", "ctx.item: nor what it found");
    await w.run("2026-10-13 11:05", 1);
    const after = calls().slice(n);
    assert.equal(after.length, 1, "read again, once, though the window is over and read to its end");
    assert.deepEqual([after[0]!.requests[0]!.params.region, after[0]!.requests[0]!.last], ["global", null]);
    assert.equal(headline(w, 1), "v no-signal - no-signal no-signal");
    assert.equal(JSON.parse(w.store.state.items["watch-demo:w-1"]!.fields.numbers!).region, "global");
    // a window that ends before the read made last
    put(w, 1, { WatchTo: "10:20" });
    await untilTaken(w, "11:06", "WatchTo", "10:20");
    await w.run("2026-10-13 11:15", 1);
    const later = calls().slice(n + 1);
    assert.equal(later.length, 1, "read anew, not 'read already' by a read after its end");
    assert.equal(later[0]!.requests[0]!.window.to.slice(11, 16), "10:20");
    // what changed is told by its size and hash; the item keeps it whole
    const obs = (w.store.state.recent["watch-demo:w-1"] ?? []).flatMap((o) => o.changes ?? []).filter((c) => c.field === "fields.numbers");
    assert.ok(obs.length > 0);
    for (const c of obs) for (const v of [c.from, c.to]) assert.match(v, /^\d+ 字节 #[0-9a-f]{12}$/);
  }));

test("a run that comes back for a request changed meanwhile is not taken for the one asked now", () =>
  withWatch(async (w, plan, calls) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30" });
    await w.run("2026-10-13 09:55", 5);
    plan({ sleepMs: 4000 });
    await tickAt(w, "10:00");
    put(w, 1, { Region: "global" });
    await untilTaken(w, "10:01", "Region", "global", false);
    assert.equal(w.engine.runningNow().length, 1, "still running when the change is taken in");
    await w.engine.settled();
    plan({});
    const at = w.clock.now + 60_000;
    await tickAt(w, at);
    assert.equal(w.store.state.items["watch-demo:w-1"], undefined, "what it read was for the params before");
    assert.equal(w.store.state.sources["watch-demo"]!.health.readAt?.["watch-demo:w-1"], undefined);
    await tickAt(w, at + 60_000);
    await w.engine.settled();
    assert.equal(calls()[1]!.requests[0]!.params.region, "global", "read again, for the request as it is now");
  }));

test("past its deadline a request is not read any more: the rule is told it never was, and why; the outage card goes only then", () =>
  withWatch(async (w, plan, calls) => {
    plan({ exit: 1, stderr: "no route" });
    put(w, 1, { Watch: "10:00", WatchTo: "10:30" });
    // its deadline: the reread at 11:30, and the grace after (10 minutes, 30 seconds of timeout, 2 minutes)
    const deadline = ms("11:42") + 30_000;
    await w.run("2026-10-13 11:40", 1);
    const card = () => Object.values(w.store.state.commitments).find((c) => c.key.startsWith("source-down:watch-demo"));
    assert.ok(card() && card()!.status !== "cancelled", `still read: still told ${JSON.stringify(card())}`);
    assert.match(w.store.state.assessments["gcp-demo:1"]!.next.what, /观察命令退出码 1：no route/, "the rule sees why it was not read");
    assert.equal(headline(w, 1), "v insufficient-data none-yet none none");
    await w.run("2026-10-13 15:00", 1);
    assert.ok(calls().length > 0 && calls().every((c) => Date.parse(c.now) <= deadline), calls().map((c) => c.now.slice(11, 16)).join(" "));
    assert.deepEqual([card()!.status, card()!.reason], ["cancelled", "不用再读了"]);
    assert.equal(headline(w, 1), "v insufficient-data gave-up none none");
    assert.match(w.store.state.assessments["gcp-demo:1"]!.next.what, /no route/);
  }));

test("a key the command gives nothing for, while it does for others, fails on its own: retried after its own backoff, told when it stays so", () =>
  withWatch(async (w, plan, calls) => {
    put(w, 1, { Watch: "10:00", WatchTo: "11:30" });
    put(w, 2, { Watch: "10:00", WatchTo: "11:30" });
    plan({ skip: ["w-2"] });
    const states = new Set<string>();
    for (let t = ms("09:50"); t <= ms("10:40"); t += 60_000) {
      await tickAt(w, t);
      await w.engine.settled();
      if (health(w)) states.add(health(w)!.state);
    }
    assert.deepEqual([...states], ["ok"], "w-2 tried again on its own, giving nothing: the source is not failing for it");
    assert.equal(Object.values(w.store.state.commitments).filter((c) => c.key.startsWith("source-down:watch-demo:2")).length, 0, "no card for the source");
    const h = health(w)!;
    assert.ok(w.store.state.items["watch-demo:w-1"], "the other key taken");
    const f = h.keyFailures?.["watch-demo:w-2"];
    assert.ok(f && f.failures >= 2 && f.since?.slice(11, 16) === "10:00", JSON.stringify(h));
    const asked2 = calls().filter((c) => c.requests.some((r) => r.key === "w-2")).length;
    assert.ok(asked2 <= 6, `asked for w-2 ${asked2} times in 40 minutes`);
    const card = () => Object.values(w.store.state.commitments).find((c) => c.key.startsWith("source-down:watch-demo:w-2:"));
    assert.ok(card(), "failing past downAfterMinutes: told, for that key");
    assert.match(card()!.brief, /观察命令没给/);
    plan({});
    await w.run("2026-10-13 11:20", 1);
    assert.equal(health(w)!.keyFailures, undefined);
    assert.deepEqual([card()!.status, card()!.reason], ["cancelled", "来源恢复了"]);
  }));

test("an outage is counted from when the request was taken on, not from its window's start or a failure before it", () =>
  withWatch(async (w, plan) => {
    plan({ exit: 1 });
    w.store.append([{ type: "source.state", id: "watch-demo", health: { state: "down", lastOkAt: null, lastError: "old", failures: 3, calls: [], nextPollAt: 0, downSince: "2026-10-13T09:00:00+08:00" } }]);
    put(w, 1, { Watch: "09:00", WatchTo: "12:00" });
    const cards = () => Object.values(w.store.state.commitments).filter((c) => c.key.startsWith("source-down:watch-demo"));
    await w.run("2026-10-13 10:15", 5);
    assert.equal(cards().length, 0, "25 minutes since it was asked for: not yet");
    await w.run("2026-10-13 10:25", 5);
    assert.equal(cards().length, 1);
    assert.match(cards()[0]!.brief, /从 10-13 09:50 起/);
  }));

test("a rule taken away leaves nothing watched; one that does not load still does, run as its last copy or not run at all", () =>
  withWatch(async (w, _plan, calls) => {
    const file = path.join(w.configDir, "rules", "watcher.mjs");
    writeFileSync(path.join(w.configDir, "rules", "other.mjs"), `export default { name: "other", description: "x", applies: { source: "flags-demo" }, params: {}, stages: ["s"], assess() { return { stage: "s", health: "waiting", headline: "o", next: { actor: "system", what: "x" }, facts: [], commitments: [] }; } };`);
    put(w, 1, { Watch: "10:00", WatchTo: "12:00" });
    await w.run("2026-10-13 10:15", 5);
    assert.ok(w.store.state.observing?.["gcp-demo:1"]);
    writeFileSync(file, "export default {");
    await w.run("2026-10-13 10:25", 5);
    assert.ok(w.store.state.observing?.["gcp-demo:1"], "broken, its last copy runs: still asks");
    // broken with no copy to run: it may be the one that asked, so what it asked stays
    writeFileSync(file, RULE);
    await w.run("2026-10-13 10:30", 5);
    rmSync(path.join(w.dataDir, "rules-last-good"), { recursive: true, force: true });
    writeFileSync(file, "export default { name: ");
    await w.run("2026-10-13 10:35", 5);
    assert.ok(w.store.state.rules.broken?.["watcher.mjs"] && !w.store.state.rules.broken["watcher.mjs"].fallback, JSON.stringify(w.store.state.rules.broken));
    assert.ok(w.store.state.observing?.["gcp-demo:1"], "broken, nothing runs instead: still asks");
    const n = calls().length;
    assert.ok(n >= 4);
    rmSync(file);
    await w.run("2026-10-13 10:45", 5);
    assert.equal(w.store.state.observing?.["gcp-demo:1"], undefined);
    await w.run("2026-10-13 12:30", 5);
    assert.equal(calls().length, n, "nothing read for it any more");
  }));

test("a stop stops the command in flight, with what it started, before it resolves", () =>
  withWatch(async (w, plan, _calls, dir) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30" });
    await w.run("2026-10-13 09:55", 5);
    plan({ sleepMs: 120_000 });
    await tickAt(w, "10:00");
    const pidFile = path.join(dir, "pid");
    for (let i = 0; i < 400 && !existsSync(pidFile); i++) await sleep(25);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(pid), "running");
    const started = Date.now();
    await w.engine.stop();
    assert.ok(Date.now() - started < 10_000);
    assert.equal(alive(pid), false, "gone once the stop resolves: before another engine could start one");
  }));

test("params are taken as their JSON: a Date changed is another request; an undefined left out the same across a restart, not read again for it", () =>
  withWatch(async (w, _plan, calls) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30", Cutoff: "09:00" });
    await w.run("2026-10-13 10:40", 5);
    const n = calls().length;
    assert.equal(calls()[0]!.requests[0]!.params.cutoff, "2026-10-13T01:00:00.000Z", "a Date goes as its JSON");
    assert.equal("platform" in calls()[0]!.requests[0]!.params, false, "an undefined is left out");
    put(w, 1, { Cutoff: "09:30" });
    await untilTaken(w, "10:41", "Cutoff", "09:30");
    await w.run("2026-10-13 11:05", 1);
    assert.deepEqual(calls().slice(n).map((c) => c.requests[0]!.params.cutoff), ["2026-10-13T01:30:00.000Z"], "another Date: read anew");
    // across a restart: the same request, read when it is due, not at once
    put(w, 2, { Watch: "11:00", WatchTo: "12:00" });
    await w.run("2026-10-13 11:15", 5);
    // what is in flight at a restart is lost (read again when due): taken in first
    await w.run("2026-10-13 11:16", 1);
    const before = calls().length;
    const set = w.store.state.observing!["gcp-demo:2"]!;
    await w.engine.stop();
    await w.restart();
    await w.run("2026-10-13 11:19", 1);
    assert.equal(calls().length, before, "not read again for the restart");
    assert.deepEqual(w.store.state.observing!["gcp-demo:2"], set, "nor asked again (since kept)");
    await w.run("2026-10-13 11:21", 1);
    assert.equal(calls().length, before + 1, "read when it is due");
  }));

test("a request that changes round after round is told as a judgment gone wrong; the rule put right, it is judged again", () =>
  withWatch(async (w) => {
    put(w, 1, { Watch: "10:00", WatchTo: "11:30", Churn: "1" });
    await w.run("2026-10-13 10:05", 5);
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.error, null, "three changes: not yet");
    await w.run("2026-10-13 10:10", 5);
    const a = w.store.state.assessments["gcp-demo:1"]!;
    assert.equal(a.stage, "error");
    assert.match(a.error!, /observe w-1: 参数每轮都在变（一小时里变了 4 次），读不到/);
    put(w, 1, { Churn: "" });
    await untilTaken(w, "10:11", "Churn", "");
    // the round it changes back is a change too; the next is steady
    await tickAt(w, w.clock.now + 60_000);
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.error, null, "steady again: no error, though it changed within the hour");
  }));

test("a key read for another case's request: the other's case is told its own is not read, not that it was tried", () =>
  withWatch(async (w, _plan, calls) => {
    put(w, 1, { Watch: "10:00", WatchTo: "10:30", Key: "same", Region: "cn" });
    put(w, 2, { Watch: "10:00", WatchTo: "10:30", Key: "same", Region: "global" });
    await w.run("2026-10-13 10:15", 5);
    assert.ok(calls().every((c) => c.requests.every((r) => r.params.region === "global")), "one request read for the key: the one set last");
    const said = (id: number) => JSON.parse(w.store.state.assessments[`gcp-demo:${id}`]!.next.what);
    assert.equal(said(1).w, "这个 key 被另一个事项占用，没有读");
    await w.run("2026-10-13 11:00", 5);
    assert.equal(said(1).w, "这个 key 被另一个事项占用，没有读", "past its deadline too");
  }));

// ---- the timing, on its own --------------------------------------------------------------------

const REQ: ObserveRequest = { source: "s", key: "k", window: { from: "2026-10-13T10:00:00+08:00", to: "2026-10-13T10:30:00+08:00" }, reread: [60, 180], params: {} };

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
  const item: Item = { key: "s:k", source: "s", kind: "observation", title: "k", url: null, status: "no-signal", closed: false, fields: { request: requestVersion(REQ), verdict: "no-signal", freshUntil: "2026-10-13T10:25:00+08:00", "window.from": REQ.window.from, "window.to": REQ.window.to, numbers: '{"devices":2,"related":[{"symbol":"A::b","devices":2}]}', "notes.0": "n" }, people: {}, parent: null, sourceUpdatedAt: null, observedAt: "" };
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

test("a request's version: its source, key, window (the instant, however written) and params (in any order); its deadline, from when it was taken on if that is later", () => {
  const v = requestVersion(REQ);
  const same: ObserveRequest = { ...REQ, window: { from: "2026-10-13T02:00:00Z", to: REQ.window.to }, reread: [] };
  assert.equal(requestVersion(same), v, "the same instant; rereads are not what is read");
  assert.equal(requestVersion({ ...REQ, params: { b: 1, a: [1, { y: 2, x: 1 }] } }), requestVersion({ ...REQ, params: { a: [1, { x: 1, y: 2 }], b: 1 } }));
  for (const other of [{ ...REQ, key: "k2" }, { ...REQ, source: "s2" }, { ...REQ, window: { ...REQ.window, to: "2026-10-13T10:20:00+08:00" } }, { ...REQ, params: { region: "global" } }]) assert.notEqual(requestVersion(other), v);
  const grace = 5 * 60_000;
  assert.deepEqual([live(REQ, grace, ms("09:59")), live(REQ, grace, ms("13:35")), live(REQ, grace, ms("13:36"))], [false, true, false], "the last reread at 13:30, and the grace");
  const past = { ...REQ, since: "2026-10-13T15:00:00+08:00" };
  assert.deepEqual([live(past, grace, ms("15:04")), live(past, grace, ms("15:06"))], [true, false], "a window past when it was asked for: read once, then not");
});

test("what is concluded past the deadline: given up, and why; a read owed from when the request was taken on", () => {
  const item: Item = { key: "s:k", source: "s", kind: "observation", title: "k", url: null, status: "no-signal", closed: false, fields: { request: requestVersion(REQ), verdict: "no-signal", freshUntil: "2026-10-13T10:25:00+08:00", "window.from": REQ.window.from, "window.to": REQ.window.to }, people: {}, parent: null, sourceUpdatedAt: null, observedAt: "" };
  const o = { everyMs: 600_000, graceMs: 5 * 60_000, maxLagMs: 30 * 60_000, tz: "Asia/Shanghai", failure: "连不上" };
  const at = (now: string, read: string | null, it: Item | null = item, r: ObserveRequest = REQ) => conclude(r, it, read && `2026-10-13T${read}:00+08:00`, { ...o, nowMs: ms(now) });
  assert.deepEqual([at("13:40", "12:31").verdict, at("13:40", "12:31").why, at("13:40", "12:31").failure], ["insufficient-data", "gave-up", "连不上"]);
  assert.match(at("13:40", "12:31").whyText!, /13:30 该读的一直没读成，10-13 13:35 以后不再读了.*：连不上/);
  assert.deepEqual([at("13:40", null, null).why, at("13:30", null, null).why], ["gave-up", "none-yet"]);
  const fresh = { ...item, fields: { ...item.fields, freshUntil: "2026-10-13T13:30:00+08:00" } };
  assert.deepEqual([at("13:40", "13:31", fresh).why, at("13:40", "13:31", fresh).failure], [null, null], "read: nothing owed, no failure told");
  assert.equal(at("12:00", "10:21").why, "not-read");
  // taken on at 11:58: the 11:30 read was not owed before then
  const late = { ...REQ, since: "2026-10-13T11:58:00+08:00" };
  assert.deepEqual([at("12:00", "10:21", item, late).why, at("12:04", "10:21", item, late).why], ["window-open", "not-read"]);
  // another version of the request: nothing of the item is its
  const seen = at("10:40", "10:31", item, { ...REQ, params: { region: "global" } });
  assert.deepEqual([seen.why, seen.reported, seen.readAt], ["none-yet", null, null]);
});
