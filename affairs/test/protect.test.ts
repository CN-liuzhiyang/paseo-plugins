import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createEngine } from "../server/engine";
import { secretIn, verifyEvidence } from "../server/lib/check.mjs";
import { doctor } from "../server/lib/doctor.mjs";
import { counts, mayLook, tripped } from "../server/lib/limits.mjs";
import { append, load, logFile, read } from "../server/lib/log.mjs";
import * as ops from "../server/lib/ops.mjs";
import { DEFAULT_POLICY, policyProblems } from "../server/lib/policy.mjs";
import { scratch, world } from "./kit";

// What keeps a look from deciding things for the person, and the limits that hold whoever starts a look. Each of these
// was checked by taking the protection out and watching the test go red.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "affair.mjs");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type W = ReturnType<typeof world>;
const started = async (w: W, title = "洗牙") => {
  const made = await ops.create(w.ctx, { title, goal: "约上洗牙", said: "帮我盯一下洗牙，今天最好要搞定", noWait: true });
  assert.equal(made.ok, true, made.text);
  return made.id as string;
};
const good = (over: Record<string, unknown> = {}, next: Record<string, unknown> = {}) => ({
  status: "还没约", entry: "我看了一眼：还没约。", facts: [],
  next: { at: "2026-11-03 09:30", waitingFor: "等你去约", why: "他说今天搞定", earlyIf: [], ...next }, ...over,
});
/** A look as the schedule starts it: the brief, then what it hands in. */
async function lookOnce(w: W, id: string, over: Record<string, unknown> = {}, next: Record<string, unknown> = {}) {
  const b = await ops.brief(w.ctx, id);
  if (!b.ok) return b;
  const r = await ops.report(w.ctx, id, good(over, next));
  append(w.root, id, [{ kind: "wake.end", state: "ok", usd: null }], { now: w.now() });
  return r;
}
/** The line `brief` writes when a look starts, for a day or an hour that has to be full without running that many looks. */
const wakes = (w: W, id: string, n: number, at: number) => append(w.root, id, Array.from({ length: n }, () => ({ kind: "wake", why: ["time"], gapMinutes: 60, estUsd: 0.02 })), { now: at });

const lookOf = (w: W, id: string) => ({ PASEO_AGENT_ID: "agent-look", FAKE_PASEO_LABELS: JSON.stringify({ "paseo.schedule-id": load(w.root, id).scheduleId }) });
function cli(w: W, args: string[], env: Record<string, string | undefined> = {}, input = "") {
  const e: Record<string, string | undefined> = { ...process.env, AFFAIR_BY: undefined, PASEO_AGENT_ID: undefined, FAKE_PASEO_LABELS: undefined, FAKE_PASEO_FAIL: undefined, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync(process.execPath, [BIN, "--root", w.root, ...args], { encoding: "utf8", env: e as NodeJS.ProcessEnv, input });
}

test("F-04: a session the schedule started can only report, note what it saw and read; everything that is his to say is refused", async () => {
  const w = world();
  const id = await started(w);
  const LOOK = lookOf(w, id);
  await ops.brief(w.ctx, id);
  append(w.root, id, [{ kind: "asked", id: "D1-1", title: "约哪天？", options: ["周三", "周四"] }], { now: w.now() });
  const before = read(w.root, id).length;
  const refused = [
    ["pause", id, "--until", "2027-09-01 10:00"],
    ["answer", "D1-1", "--said", "周三"],
    ["stop", id, "--said", "办完了"],
    ["undo", id],
    ["resume", id],
    ["new", "--title", "别的事", "--said", "我自己加的", "--no-wait"],
    ["pause-all"],
    ["note", id, "--said", "他说截止是明天", "--deadline", "2026-11-03 10:00"],
  ];
  for (const args of refused) {
    const r = cli(w, args, LOOK);
    assert.equal(r.status, 1, `${args[0]}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /看一眼的会话|不算他说的/, `${args[0]} says why`);
  }
  assert.equal(read(w.root, id).length, before, "nothing at all was written by the refused ones");
  assert.equal(load(w.root, id).status, "watching");
  const noted = cli(w, ["note", id, "--said", "我看到飞书里还没勾"], { ...LOOK, AFFAIR_BY: "user" });
  assert.equal(noted.status, 0, noted.stdout + noted.stderr);
  const s = load(w.root, id);
  assert.equal(s.said.at(-1)?.by, "look", "saying it is the person's (AFFAIR_BY) does not make it so");
  assert.ok(!s.pending.includes(`said:${s.said.at(-1)?.seq}`), "and it does not call another look");
  assert.equal(s.chainBroken, 0, "commands and plugin write one chain");
});

test("F-04: who is calling is read from the session; a session that cannot be read counts as a look, a terminal and a conversation do not", async () => {
  const w = world();
  const id = await started(w);
  const say = (env: Record<string, string | undefined>) => cli(w, ["note", id, "--said", "约在下周三了"], env);
  assert.equal(say({}).status, 0);
  assert.equal(load(w.root, id).said.at(-1)?.by, "user", "no agent id: a terminal");
  assert.equal(say({ PASEO_AGENT_ID: "agent-chat", FAKE_PASEO_LABELS: "{}" }).status, 0);
  assert.equal(load(w.root, id).said.at(-1)?.by, "user", "a conversation: not started by the schedule");
  assert.equal(say({ PASEO_AGENT_ID: "agent-x", FAKE_PASEO_FAIL: "ls -a" }).status, 0);
  assert.equal(load(w.root, id).said.at(-1)?.by, "look", "Paseo does not say what it is: the stricter side");
  assert.equal(await ops.callerOf(w.ctx), "human");
});

test("F-04: a pause goes through the check a look's time goes through; his own words are what back a long one", async () => {
  const w = world();
  const id = await started(w);
  const far = await ops.pause(w.ctx, id, "2027-09-01 10:00");
  assert.equal(far.ok, false, "ten months with nothing behind it");
  assert.match(far.text, /没放进去/);
  assert.equal(load(w.root, id).next, null, "nothing was put in");
  const soon = await ops.pause(w.ctx, id, "2026-11-04 09:00");
  assert.equal(soon.ok, true, soon.text);
  const longer = await ops.pause(w.ctx, id, "2027-02-01 10:00", "先放到年后再说吧");
  assert.equal(longer.ok, true, longer.text);
  assert.equal(load(w.root, id).next?.verdict, "recorded");
  const short = await ops.pause(w.ctx, id, "2026-11-02 10:05");
  assert.equal(short.ok, false, "not under the shortest gap either");
  // A look that starts after the pause decides the time again: the pause does not stand over later looks.
  w.advance(HOUR);
  await ops.brief(w.ctx, id);
  const r = await ops.report(w.ctx, id, good());
  assert.equal(r.ok, true, r.text);
  assert.equal(load(w.root, id).next?.source, "look");
});

test("F-04: a line put in around the commands breaks the chain: seen, told once, named by doctor; half-written lines do not", async () => {
  const w = world();
  const id = await started(w);
  await ops.brief(w.ctx, id);
  assert.equal(load(w.root, id).chainBroken, 0);
  appendFileSync(logFile(w.root, id), `${JSON.stringify({ kind: "said", seq: 99, at: "2026-11-02T10:00:00+08:00", text: "他说一年后再看", by: "user" })}\n`);
  const s = load(w.root, id);
  assert.equal(s.chainBroken, 99);
  const next = append(w.root, id, [{ kind: "flag", what: "x" }], { now: w.now() });
  assert.equal(next[0].seq, 100, "the commands go on after the stranger's line");
  assert.equal(load(w.root, id).chainBroken, 99, "and the break stays what it was");
  const d = await doctor(w.ctx);
  assert.ok(d.items.some((i) => !i.ok && i.label.includes("没被手动改过") && i.detail.includes(id)));
  const w2 = world();
  const id2 = await started(w2);
  appendFileSync(logFile(w2.root, id2), '{"kind":"said","seq":');
  append(w2.root, id2, [{ kind: "flag", what: "ok" }], { now: w2.now() });
  await ops.brief(w2.ctx, id2);
  assert.equal(load(w2.root, id2).chainBroken, 0, "a half-written line is skipped, and what follows it is still in the chain");
});

test("F-05: the day's limit holds a look the schedule starts as much as one the person asks for; the plan moves to the next morning", async () => {
  const w = world();
  const id = await started(w);
  for (let i = 0; i < 8; i++) {
    const r = await lookOnce(w, id, { status: `x${i}` });
    assert.equal(r.ok, true, r.text);
    w.advance(10 * MIN);
  }
  const ninth = await ops.brief(w.ctx, id);
  assert.equal(ninth.ok, false);
  assert.match(ninth.text, /今天看了 8 次/);
  assert.equal(load(w.root, id).wakes.length, 8, "a look that is not made is not counted");
  const s = load(w.root, id);
  assert.equal(s.next?.at, "2026-11-03T08:00:00+08:00");
  assert.equal(s.running, false);
  assert.equal(w.paseo().schedules[0].cadence.expression, "0 8 3 11 *");
});

test("F-05 (M26): forty looks in a day is the end of it, whoever's they are", async () => {
  const w = world();
  const ids: string[] = [];
  for (const title of ["a洗牙", "b体检", "c牙冠", "d年检", "e报税", "f续费"]) ids.push(await started(w, title));
  w.advance(11 * MIN); // the look each one was cleared for when it was made has been waiting long enough to lapse
  for (const id of ids.slice(0, 5)) for (let k = 0; k < 8; k++) wakes(w, id, 1, w.now() - (5 + k * 10) * MIN);
  assert.equal(counts(w.root, w.now(), w.ctx.policy).total.looks, 40);
  assert.equal(mayLook(w.root, ids[5], w.now(), w.ctx.policy).ok, false);
  const b = await ops.brief(w.ctx, ids[5]);
  assert.equal(b.ok, false);
  assert.match(b.text, /一共看了 40 次/);
  const forced = await ops.requestLook(w.ctx, ids[5], "test", { force: true });
  assert.equal(forced.ok, false, "asking for one more does not lift the total");
});

test("F-05 (M05): too many looks in an hour stops this affair's plan and asks once; 接着看 lets it go on", async () => {
  const w = world();
  const ids: string[] = [];
  for (const title of ["a洗牙", "b体检", "c牙冠", "d年检"]) ids.push(await started(w, title));
  w.advance(11 * MIN);
  for (const id of ids.slice(0, 3)) wakes(w, id, 7, w.now() - 20 * MIN);
  assert.equal(counts(w.root, w.now(), w.ctx.policy).total.hour, 21);
  assert.equal(tripped(w.root, w.now(), w.ctx.policy).tripped, true);
  const id = ids[3];
  const b = await ops.brief(w.ctx, id);
  assert.equal(b.ok, false);
  assert.match(b.text, /看得太频繁/);
  let s = load(w.root, id);
  assert.equal(s.breaker, true);
  assert.equal(s.asks.filter((a: { for: string }) => a.for === "breaker").length, 1, "one question, with the way out in it");
  assert.equal(w.paseo().schedules.find((p: { name: string }) => p.name === `affair:${id}`).status, "paused", "this affair's plan is stopped");
  const again = await ops.brief(w.ctx, id);
  assert.equal(again.ok, false);
  assert.equal(load(w.root, id).asks.length, 1, "not asked again");
  const ring = await ops.requestLook(w.ctx, id, "test");
  assert.equal(ring.ok, false);
  const runs = () => w.calls().filter((c) => c[1] === "run-once").length;
  const n = runs();
  const go = await ops.answer(w.ctx, id, "D4-1", "接着看");
  assert.equal(go.ok, true, go.text);
  s = load(w.root, id);
  assert.equal(s.breaker, false);
  assert.equal(w.paseo().schedules.find((p: { name: string }) => p.name === `affair:${id}`).status, "active");
  assert.equal(runs(), n + 1, "and it looks at once");
  const b2 = await ops.brief(w.ctx, id);
  assert.equal(b2.ok, true, b2.text);
});

test("F-05: the money limit counts an estimate per look, from the role, and says so; a real cost replaces it", async () => {
  const w = world({ policy: { limits: { ...DEFAULT_POLICY.limits, perAffairUsdPerDay: 0.05 } } });
  const id = await started(w);
  for (let i = 0; i < 3; i++) {
    const r = await lookOnce(w, id, { status: `x${i}` });
    assert.equal(r.ok, true, r.text);
    w.advance(10 * MIN);
  }
  const c = counts(w.root, w.now(), w.ctx.policy);
  assert.ok(Math.abs(c.per[id].usd - 0.06) < 1e-9, `three looks at the role's estimate: ${c.per[id].usd}`);
  const b = await ops.brief(w.ctx, id);
  assert.equal(b.ok, false);
  assert.match(b.text, /花到上限/);
  append(w.root, id, [{ kind: "wake.end", state: "ok", usd: 0.001 }], { now: w.now() });
  assert.ok(Math.abs(counts(w.root, w.now(), w.ctx.policy).per[id].usd - 0.041) < 1e-9, "the last look cost what it cost, not the estimate");
  assert.equal(DEFAULT_POLICY.roles.glance.estimateUsd, 0.02);
});

test("F-06: the time the hint names goes through, seconds or not", async () => {
  const w = world();
  const id = await started(w);
  await ops.brief(w.ctx, id);
  w.at(w.now() + 30_000);
  const first = await ops.report(w.ctx, id, good({}, { at: "2026-11-02 10:30" }));
  assert.equal(first.ok, false);
  const hint = /最早 (\d\d:\d\d)/.exec(first.text)![1];
  assert.equal(hint, "10:31");
  const second = await ops.report(w.ctx, id, good({}, { at: `2026-11-02 ${hint}` }));
  assert.equal(second.ok, true, second.text);
});

test("F-07: seven looks in a row, 45 minutes apart and nothing changed: the fifth is sent back and a far time passes", async () => {
  const w = world();
  const id = await started(w);
  const verdicts: boolean[] = [];
  for (let i = 0; i < 7; i++) {
    w.advance(45 * MIN);
    const b = await ops.brief(w.ctx, id);
    assert.equal(b.ok, true, b.text);
    const at = (ms: number) => new Date(ms + 8 * HOUR).toISOString().slice(0, 16).replace("T", " ");
    const r = await ops.report(w.ctx, id, good({}, { at: at(w.now() + 45 * MIN) }));
    verdicts.push(r.ok);
    if (!r.ok) {
      assert.match(r.text, /前 3 次都在 2 小时内看/);
      const fix = await ops.report(w.ctx, id, good({}, { at: at(w.now() + 20 * HOUR) }));
      assert.equal(fix.ok, true, fix.text);
    }
    append(w.root, id, [{ kind: "wake.end", state: "ok", usd: null }], { now: w.now() });
  }
  assert.deepEqual(verdicts, [true, true, true, true, false, false, false]);
});

test("F-08: a field of the wrong shape on the third try is left out and said so; brief and show go on reading", async () => {
  const w = world();
  const id = await started(w);
  await ops.brief(w.ctx, id);
  const bad = { status: "x", entry: "我看了一眼：x", facts: "不是数组", next: { at: "2026-11-03 09:30", waitingFor: "等你去约", why: "他说今天搞定", earlyIf: [] } };
  for (let i = 0; i < 2; i++) assert.equal((await ops.report(w.ctx, id, bad)).ok, false);
  const third = await ops.report(w.ctx, id, bad);
  assert.equal(third.ok, true, third.text);
  const s = load(w.root, id);
  assert.ok(Array.isArray(s.facts));
  assert.match(s.reports.at(-1).detail, /facts 的格式不对/);
  assert.equal((await ops.brief(w.ctx, id)).ok, true);
  assert.equal(ops.show(w.ctx, id).ok, true);
  // And a line already in the log with the wrong shape is read around.
  append(w.root, id, [{ kind: "report", verdict: "pass", status: 42, entry: "x", facts: "oops", changed: true }, { kind: "next", next: 7 }, { kind: "asked", id: "D1-9", title: "t", options: "nope" }], { now: w.now() });
  assert.equal(ops.show(w.ctx, id, { log: true }).ok, true);
  assert.equal((await ops.brief(w.ctx, id)).ok, true);
  assert.deepEqual(load(w.root, id).facts, s.facts);
});

test("F-09: a half-made affair is taken apart, blocks nothing and can be asked for again; a finished ticket is watched again", async () => {
  const w = world();
  process.env.FAKE_PASEO_FAIL = "schedule create";
  const first = await ops.create(w.ctx, { title: "洗牙", said: "帮我盯一下洗牙", noWait: true });
  delete process.env.FAKE_PASEO_FAIL;
  assert.equal(first.ok, false);
  assert.match(first.text, /什么都没留下/);
  assert.equal(load(w.root, "D1").status, "stopped");
  assert.ok(w.calls().some((c) => c[0] === "workspace" && c[1] === "archive"), "the workspace that was made is put away");
  assert.equal(ops.ls(w.ctx).text.split("\n").filter((l) => l.includes("watching")).length, 0, "nothing is left watching");
  const again = await ops.create(w.ctx, { title: "洗牙", said: "帮我盯一下洗牙", noWait: true });
  assert.equal(again.ok, true, again.text);
  assert.equal(load(w.root, again.id as string).status, "watching");
  // A ticket: finished, then asked for again.
  const t = await ops.create(w.ctx, { title: "#700 闪退", link: "gcp:#700", said: "盯一下 #700", noWait: true });
  await ops.stop(w.ctx, t.id as string, { done: true, evidence: "办完了" });
  const re = await ops.create(w.ctx, { title: "#700 闪退", link: "gcp:#700", said: "再盯一下 #700", noWait: true });
  assert.equal(re.ok, true, re.text);
  assert.match(re.text, /之前办完了，这次重新盯/);
  assert.equal(load(w.root, "700").status, "watching");
  assert.deepEqual(w.paseo().schedules.filter((p: { name: string }) => p.name === "affair:700").map((p: { status: string }) => p.status), ["active"], "its plan is going again (the workspace had not been put away yet)");
  // A ticket that never got made, asked for again.
  process.env.FAKE_PASEO_FAIL = "workspace create";
  const broken = await ops.create(w.ctx, { title: "#701 卡死", link: "gcp:#701", said: "盯一下 #701", noWait: true });
  delete process.env.FAKE_PASEO_FAIL;
  assert.equal(broken.ok, false);
  const retry = await ops.create(w.ctx, { title: "#701 卡死", link: "gcp:#701", said: "盯一下 #701", noWait: true });
  assert.equal(retry.ok, true, retry.text);
  assert.equal(load(w.root, "701").status, "watching");
});

test("F-10: pause-all stops every plan and holds it that way until resume-all; the plugin's own syncing does not undo it", async () => {
  const w = world();
  const a = await started(w, "a洗牙");
  const b = await started(w, "b体检");
  const stopped = await ops.pauseAll(w.ctx);
  assert.equal(stopped.ok, true, stopped.text);
  assert.ok(w.paseo().schedules.every((p: { status: string }) => p.status === "paused"));
  for (const id of [a, b]) {
    await ops.syncPlan(w.ctx, id);
    assert.equal(load(w.root, id).held, true);
  }
  assert.ok(w.paseo().schedules.every((p: { status: string }) => p.status === "paused"), "still paused after the plugin syncs");
  assert.equal((await ops.resumeAll(w.ctx)).ok, true);
  assert.ok(w.paseo().schedules.every((p: { status: string }) => p.status === "active"));
});

test("F-02: policy problems are named, and doctor says ✓ or ✗ for each thing the machine has to have", async () => {
  const w = world();
  const bad = policyProblems(w.ctx.policy).map((p) => p.key);
  for (const key of ["binPath", "handbookPath", "push.to", "readers.dirs", "handbooksDir"]) assert.ok(bad.includes(key), key);
  const d = await doctor(w.ctx);
  assert.equal(d.ok, false);
  assert.ok(d.items.some((i) => !i.ok && i.label === "policy.json：binPath"));
  assert.ok(d.items.find((i) => i.label === "node 在 PATH 上")!.ok);
  assert.ok(d.items.find((i) => i.label === "paseo 连得上")!.ok);
  assert.match(d.text, /✗ policy\.json：push\.to/);
  // Everything in place: green, and the channel is found by the destination it was told.
  const dir = scratch("affairs-doctor-");
  const book = path.join(dir, "handbook.md");
  writeFileSync(book, "x");
  mkdirSync(path.join(dir, "hb"));
  for (const f of ["affair.md", "asked.md", "h.md"]) writeFileSync(path.join(dir, "hb", f), "x");
  mkdirSync(path.join(dir, "priv"));
  writeFileSync(path.join(dir, "priv", "t.mjs"), "// 读一个东西\n");
  const ok = world({ policy: { binPath: BIN, handbookPath: book, handbooksDir: path.join(dir, "hb"), handbookByKind: { gcp: "h.md" }, push: { ...DEFAULT_POLICY.push, to: "p2p:me" }, readers: { ...DEFAULT_POLICY.readers, dirs: [path.join(dir, "priv")], publicDir: path.join(HERE, "..", "readers") } } });
  process.env.FAKE_PASEO_CHANNELS = JSON.stringify([{ channel: "popo", to: "p2p:me", destination: "我的单聊" }]);
  try {
    const green = await doctor(ok.ctx);
    assert.deepEqual(green.items.filter((i) => !i.ok).map((i) => `${i.label}：${i.detail}`).filter((t) => !/python|lark-cli/.test(t)), []);
    process.env.FAKE_PASEO_CHANNELS = "[]";
    assert.ok((await doctor(ok.ctx)).items.some((i) => !i.ok && i.label === "推送"));
  } finally {
    delete process.env.FAKE_PASEO_CHANNELS;
  }
});

test("M23: a report with no look in progress is not taken; the brief comes first", async () => {
  const w = world();
  const id = await started(w);
  const r = await ops.report(w.ctx, id, good());
  assert.equal(r.ok, false);
  assert.match(r.text, /没有在看的一次/);
  assert.equal(load(w.root, id).reports.length, 0);
});

test("M24: a session the schedule started cannot reopen what is over, by resume or by saying 接着盯", async () => {
  const w = world();
  const id = await started(w);
  await ops.stop(w.ctx, id, { done: true, evidence: "办完了" });
  const look = { ...w.ctx, by: "look" };
  assert.equal((await ops.resume(look, id)).ok, false);
  const said = await ops.note(look, id, { said: "还没完，接着盯" });
  assert.equal(said.ok, false);
  assert.equal(load(w.root, id).status, "done");
  assert.equal((await ops.note(w.ctx, id, { said: "还没完，接着盯" })).ok, true, "he can");
  assert.equal(load(w.root, id).status, "watching");
});

test("M27: a look that has been 'running' for 45 minutes without ending is not waited for; one that has been 44 is", async () => {
  const w = world();
  const id = await started(w);
  const runs = () => w.calls().filter((c) => c[1] === "run-once").length;
  await ops.brief(w.ctx, id);
  w.advance(44 * MIN);
  const n = runs();
  const queued = await ops.requestLook(w.ctx, id, "test");
  assert.deepEqual([queued.ok, (queued as { queued?: boolean }).queued, runs()], [true, true, n]);
  w.advance(2 * MIN);
  const fresh = await ops.requestLook(w.ctx, id, "test");
  assert.deepEqual([fresh.ok, (fresh as { queued?: boolean }).queued, runs()], [true, false, n + 1]);
});

test("a look asked for twice before it hands anything in is one look; a look that was checked when asked for is not checked twice", async () => {
  const w = world();
  const id = await started(w);
  await ops.brief(w.ctx, id);
  await ops.brief(w.ctx, id);
  assert.equal(load(w.root, id).wakes.length, 1);
  await ops.report(w.ctx, id, good());
  append(w.root, id, [{ kind: "wake.end", state: "ok", usd: null }], { now: w.now() });
  // The person asked for one more on a day that was full: the look he got is not refused at its own start.
  for (let i = 0; i < 7; i++) {
    w.advance(10 * MIN);
    await lookOnce(w, id, { status: `x${i}` });
  }
  w.advance(10 * MIN);
  const more = await ops.requestLook(w.ctx, id, "said:1", { force: true });
  assert.equal(more.ok, true, more.text);
  const b = await ops.brief(w.ctx, id);
  assert.equal(b.ok, true, "the schedule starts it, and it comes in on what was cleared");
});

test("words: only what a person reads is held to the mechanism words; everyday ones are fine; secrets in JSON form are caught", async () => {
  const w = world();
  const id = await started(w);
  await ops.brief(w.ctx, id);
  const ok = await ops.report(w.ctx, id, good({ entry: "我看了一眼：他的计划里没有这一项，通话记录也没有", facts: ["读数 r12 是 3，记录里有两条计划"] }));
  assert.equal(ok.ok, true, ok.text);
  await ops.brief(w.ctx, id);
  const bad = await ops.report(w.ctx, id, good({ entry: "我看了一眼：读数没变" }));
  assert.equal(bad.ok, false);
  assert.match(bad.text, /内部用词/);
  for (const text of ['{"token":"abcdef123456"}', "pwd=hunter22x", "Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==", "run it with --password hunter2x", "token: 'abcdef1234'"]) assert.ok(secretIn(text), text);
  for (const text of ["他的令牌还没到", "token 过期了", "密码是个好东西"]) assert.equal(secretIn(text), null, text);
});

test("quotes: a few characters prove nothing unless they are everything that was said; digits and marks do not either", () => {
  const facts = { sources: { "said:1": "洗牙约好了，周三下午 3 点。", "said:2": "办完了" } } as never;
  assert.equal(verifyEvidence({ quote: "洗牙约好了，周三", from: "said:1" }, facts), null);
  assert.match(verifyEvidence({ quote: "周三", from: "said:1" }, facts) as string, /太短/);
  assert.match(verifyEvidence({ quote: "3 点", from: "said:1" }, facts) as string, /太短/);
  assert.equal(verifyEvidence({ quote: "办完了", from: "said:2" }, facts), null, "all of what he said");
  assert.match(verifyEvidence({ quote: "洗牙约好了，周四", from: "said:1" }, facts) as string, /找不到/);
});

test("reading a log again reads only what was added, and a pass over thirty long logs is nothing", async () => {
  const w = world();
  const ids: string[] = [];
  for (let n = 1; n <= 30; n++) {
    const id = `D${n}`;
    ids.push(id);
    mkdirSync(path.join(w.root, id), { recursive: true });
    append(w.root, id, [{ kind: "created", id, title: `事项${n}`, goal: "", domain: "work", link: null, workdir: "" }, ...Array.from({ length: 1999 }, (_, i) => ({ kind: "flag", what: "bulk", detail: `第 ${i} 行，一些要读的字，一些要读的字，一些要读的字，一些要读的字` }))], { now: w.now() });
  }
  const pass = () => { for (const id of ids) load(w.root, id); };
  pass();
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) pass();
  const warm = performance.now() - t0;
  assert.ok(warm < 1500, `ten passes over 30 x 2000 lines took ${Math.round(warm)} ms`);
  append(w.root, ids[0], [{ kind: "flag", what: "one more" }], { now: w.now() });
  assert.equal(read(w.root, ids[0]).length, 2001);
  assert.equal(load(w.root, ids[0]).flags.length, 2000);
  assert.ok(existsSync(logFile(w.root, ids[29])));
});

test("F-15: a look whose end was never heard is not waited for: the card stops saying it is on and the start makes the look that came due", async () => {
  const w = world();
  const id = await started(w);
  await lookOnce(w, id, {}, { at: "2026-11-02 12:00" });
  append(w.root, id, [{ kind: "wake", why: ["time"], gapMinutes: 5 }], { now: w.now() }); // started, never ended
  w.advance(4 * HOUR);
  const { cardOf } = await import("../server/lib/view.mjs");
  assert.equal(cardOf(load(w.root, id), w.now(), w.ctx.policy).next === "正在看一眼…", false);
  const runs = () => w.calls().filter((c) => c[1] === "run-once").length;
  const n = runs();
  const e = createEngine({ ctx: w.ctx, paseo: null, deliver: null, log: () => {} });
  await e.start();
  await e.stop();
  assert.equal(runs(), n + 1, "the look that came due while nobody was listening is made");
});

test("F-20: only a sentence that starts with 还没完 / 接着盯 takes an ended affair up again", async () => {
  const w = world();
  const id = await started(w);
  await ops.stop(w.ctx, id);
  assert.equal((await ops.note(w.ctx, id, { said: "不用接着盯了" })).ok, false);
  assert.equal((await ops.note(w.ctx, id, { said: "其实还没约上" })).ok, false);
  assert.equal(load(w.root, id).status, "stopped");
  assert.equal((await ops.note(w.ctx, id, { said: "接着盯洗牙" })).ok, true);
  assert.equal(load(w.root, id).status, "watching");
});

test("F-22: only a plain number after the kind names a ticket; the kind's role is the affair's role unless another is asked for", async () => {
  const w = world({ policy: { roleByKind: { gcp: "deep" }, roles: { glance: DEFAULT_POLICY.roles.glance, deep: { provider: "claude/claude-sonnet-5-5", thinking: "medium", mode: "bypassPermissions", estimateUsd: 0.15 } } } });
  const a = await ops.create(w.ctx, { title: "#700 闪退", link: "gcp:#700/截止日期", said: "盯一下 #700", noWait: true });
  assert.equal(a.id, "700");
  assert.equal(load(w.root, "700").roleName, "deep");
  const create = w.calls().find((c) => c[0] === "schedule" && c[1] === "create")!;
  assert.equal(create[create.indexOf("--provider") + 1], "claude/claude-sonnet-5-5");
  const x = await ops.create(w.ctx, { title: "任务甲", link: "feishu-task:a1-b2-0034", said: "盯一下", noWait: true });
  const y = await ops.create(w.ctx, { title: "任务乙", link: "feishu-task:b1-a2-0034", said: "盯一下", noWait: true });
  assert.notEqual(x.id, y.id, "the digits of two different ids are not a number");
  const own = await ops.create(w.ctx, { title: "#701 卡死", link: "gcp:#701", role: "glance", said: "盯一下", noWait: true });
  assert.equal(load(w.root, own.id as string).roleName, "glance");
});

test("F-25: what he said is not given back with its own full stop doubled", async () => {
  const w = world();
  const id = await started(w);
  const r = await ops.note(w.ctx, id, { said: "那个洗牙的约在下周三下午了。" });
  assert.match(r.text, /下午了。/);
  assert.doesNotMatch(r.text, /。。/);
});
