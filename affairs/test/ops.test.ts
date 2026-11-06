import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as ops from "../server/lib/ops.mjs";
import { append, load, read } from "../server/lib/log.mjs";
import { iso, world } from "./kit";

const HOUR = 3_600_000;

async function started(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  const made = await ops.create(w.ctx, { id: "dental", title: "洗牙", goal: "约上洗牙", said: "帮我盯一下洗牙，今天最好要搞定", noWait: true, ...extra });
  assert.equal(made.ok, true, made.text);
  return made.id as string;
}

/** A look in progress: the brief has run. */
async function looking(w: ReturnType<typeof world>, id: string) {
  const b = await ops.brief(w.ctx, id);
  assert.equal(b.ok, true);
  return b.text;
}

/** The plugin's side of a finished run. */
const ended = (w: ReturnType<typeof world>, id: string, usd = 0.01) => append(w.root, id, [{ kind: "wake.end", state: "ok", usd }], { now: w.now() });

const good = (over: Record<string, unknown> = {}) => ({
  status: "飞书任务还是待办，今天日历上没有洗牙。",
  entry: "飞书里有「定期洗牙」，还没约。",
  facts: ["飞书任务 定期洗牙 未完成"],
  next: { at: "2026-11-03 09:30", waitingFor: "等你去约", waitingOn: "me", why: "他说今天最好搞定，明早再看一次", earlyIf: [] },
  ...over,
});

test("new makes the folder, the workspace under the 事项 project, a plan in that workspace, and looks at once", async () => {
  const w = world();
  const id = await started(w);
  assert.equal(id, "dental");
  assert.equal(existsSync(path.join(w.root, "dental", "CLAUDE.md")), false);
  assert.ok(existsSync(path.join(w.root, "dental", "files")));
  const calls = w.calls();
  assert.ok(calls.some((c) => c[0] === "project" && c[1] === "rename" && c[3] === "事项"), "the project is named 事项");
  const ws = calls.find((c) => c[0] === "workspace" && c[1] === "create")!;
  assert.deepEqual([ws[ws.indexOf("--isolation") + 1], ws.includes("--no-background"), ws[ws.indexOf("--title") + 1]], ["local", true, "洗牙"]);
  const sc = calls.find((c) => c[0] === "schedule" && c[1] === "create")!;
  assert.equal(sc[sc.indexOf("--name") + 1], "affair:dental");
  assert.equal(sc[sc.indexOf("--deliver") + 1], "affairs:dental");
  assert.equal(sc[sc.indexOf("--workspace") + 1], w.paseo().workspaces[0].workspaceId);
  assert.equal(sc[sc.indexOf("--provider") + 1], "claude/claude-haiku-5-5");
  assert.ok(calls.some((c) => c[0] === "schedule" && c[1] === "run-once"), "the first look starts at once");
  const s = load(w.root, "dental");
  assert.equal(s.status, "watching");
  assert.ok(s.workspaceId && s.scheduleId);
  assert.ok(sc[2].startsWith("事项 dental 看一眼\n"), "the prompt's first line is the session's title");
});

test("a ticket is named by its number, works in its own directory without projects, and is not started twice", async () => {
  const w = world();
  const first = await ops.create(w.ctx, { id: "other-2", title: "#700 某某闪退", link: "gcp:#700", said: "帮我盯一下 #700", noWait: true });
  assert.equal(first.id, "700");
  assert.equal(load(w.root, "700").workdir, path.join(w.root, "700"));
  const ws = w.calls().find((c) => c[0] === "workspace" && c[1] === "create")!;
  assert.equal(ws[ws.indexOf("--path") + 1], path.join(w.root, "700"));
  const again = await ops.create(w.ctx, { id: "other-3", title: "#700 某某闪退", link: "gcp:#700", noWait: true });
  assert.match(again.text, /已经在盯/);
  assert.equal(w.calls().filter((c) => c[0] === "workspace" && c[1] === "create").length, 1);
});

test("no more than the active limit are watched at once", async () => {
  const w = world({ policy: { limits: { ...(await import("../server/lib/policy.mjs")).DEFAULT_POLICY.limits, maxActive: 2 } } });
  await started(w);
  await ops.create(w.ctx, { id: "other-4", title: "提现", noWait: true });
  const third = await ops.create(w.ctx, { id: "other-5", title: "体检", noWait: true });
  assert.equal(third.ok, false);
  assert.match(third.text, /已经 2 件了/);
});

test("report: sent back the first time with only the fields that failed, taken the second time", async () => {
  const w = world();
  const id = await started(w);
  await looking(w, id);
  w.advance(HOUR);
  const bad = good({ next: { at: "2026-11-02 11:05", waitingFor: "等你去约", why: "再看看", earlyIf: [] } });
  const first = await ops.report(w.ctx, id, bad);
  assert.equal(first.ok, false);
  assert.match(first.text, /"next":/);
  assert.doesNotMatch(first.text, /"status":/, "only the field that failed is asked for again");
  assert.equal(load(w.root, id).nowText, "", "nothing taken from a report that was sent back");
  // The second try hands in only the fixed field; the rest is what was handed in before.
  const second = await ops.report(w.ctx, id, { next: good().next });
  assert.equal(second.ok, true, second.text);
  const s = load(w.root, id);
  assert.equal(s.nowText, good().status);
  assert.equal(s.next?.waitingFor, "等你去约");
  assert.equal(s.next?.source, "look");
  assert.equal(s.attempt, 0);
});

test("report: three tries that do not pass are taken as far as they can be, with a next time of ours", async () => {
  const w = world();
  const id = await started(w);
  await looking(w, id);
  const bad = good({ next: { at: "2026-11-02 10:05", waitingFor: "等你去约", why: "再看看", earlyIf: [] } });
  assert.equal((await ops.report(w.ctx, id, bad)).ok, false);
  assert.equal((await ops.report(w.ctx, id, {})).ok, false);
  const third = await ops.report(w.ctx, id, {});
  assert.equal(third.ok, true);
  const s = load(w.root, id);
  assert.equal(s.nowText, good().status, "the rest is taken");
  assert.equal(s.next?.verdict, "fallback");
  assert.ok(Date.parse(s.next!.at) >= w.now() + 30 * 60_000, "never sooner than the shortest gap");
  assert.ok(s.flags.some((f: { what: string }) => f.what === "fallback"));
});

test("report: a next time the plan is made to follow, and an over-long wait is stopped", async () => {
  const w = world();
  const id = await started(w);
  await looking(w, id);
  assert.equal((await ops.report(w.ctx, id, good())).ok, true);
  const plan = w.paseo().schedules[0];
  assert.equal(plan.cadence.expression, "30 9 3 11 *");
  assert.equal(plan.cadence.timezone, "Asia/Shanghai");
  // Over the soft limit with no deadline and no quote: sent back.
  await looking(w, id);
  const far = await ops.report(w.ctx, id, good({ next: { ...good().next, at: "2026-12-30 09:00" } }));
  assert.equal(far.ok, false);
  assert.match(far.text, /L 是/);
});

test("report: finish needs evidence that checks out, then the affair is over and the plan is paused", async () => {
  const w = world();
  const id = await started(w);
  const spoken = await ops.note(w.ctx, id, { said: "洗牙约在下周三下午了", by: "user" });
  await looking(w, id);
  const nope = await ops.report(w.ctx, id, { status: "办完了", entry: "办完了", finish: { kind: "done", evidence: { quote: "飞书任务勾掉了", from: "said:99" } } });
  assert.equal(nope.ok, false);
  const yes = await ops.report(w.ctx, id, { finish: { kind: "done", evidence: { quote: "约在下周三下午", from: `said:${spoken.seq}` } } });
  assert.equal(yes.ok, true, yes.text);
  const s = load(w.root, id);
  assert.equal(s.status, "done");
  assert.equal(w.paseo().schedules[0].status, "paused");
});

test("note records the words as the person's and looks at once; a look's session cannot speak for the person", async () => {
  const w = world();
  const id = await started(w);
  await looking(w, id);
  await ops.report(w.ctx, id, good());
  ended(w, id);
  const before = w.calls().filter((c) => c[1] === "run-once").length;
  const said = await ops.note(w.ctx, id, { said: "约在下周三下午了" });
  assert.equal(said.ok, true);
  assert.equal(w.calls().filter((c) => c[1] === "run-once").length, before + 1);
  assert.equal(load(w.root, id).said.at(-1)?.by, "user");
  process.env.PASEO_AGENT_ID = "agent-1";
  process.env.FAKE_PASEO_LABELS = JSON.stringify({ "paseo.schedule-id": load(w.root, id).scheduleId });
  try {
    const forged = await ops.note({ ...w.ctx, by: await ops.callerOf(w.ctx) }, id, { said: "截止改到明年" });
    assert.match(forged.text, /不算他说的/);
    const s = load(w.root, id);
    assert.equal(s.said.at(-1)?.by, "look");
    assert.ok(!Object.keys(s.answers).length);
  } finally {
    delete process.env.PASEO_AGENT_ID;
    delete process.env.FAKE_PASEO_LABELS;
  }
});

test("stop, resume and undo", async () => {
  const w = world();
  const id = await started(w);
  await ops.note(w.ctx, id, { said: "约在下周三下午了", by: "user" });
  const undone = ops.undo(w.ctx, id);
  assert.match(undone.text, /撤了/);
  assert.match(ops.undo(w.ctx, id).text, /撤了/, "the first thing said can be taken back too");
  assert.equal(ops.undo(w.ctx, id).text, "没有可撤的话。");
  await ops.stop(w.ctx, id);
  assert.equal(load(w.root, id).status, "stopped");
  assert.equal(w.paseo().schedules[0].status, "paused");
  await ops.resume(w.ctx, id);
  assert.equal(load(w.root, id).status, "watching");
  assert.equal(w.paseo().schedules[0].status, "active");
});

test("pause until a time the person chose is not checked, and changes the plan", async () => {
  const w = world();
  const id = await started(w);
  const r = await ops.pause(w.ctx, id, "2026-11-09 10:00");
  assert.equal(r.ok, true);
  assert.equal(w.paseo().schedules[0].cadence.expression, "0 10 9 11 *");
  assert.equal(load(w.root, id).next?.source, "user");
  assert.equal((await ops.pause(w.ctx, id, "2027-12-30 10:00")).ok, false, "a year is the longest");
});

test("brief records why this look and puts the plan two hours out as a fallback; a look that never reports is looked for again", async () => {
  const w = world();
  const id = await started(w);
  await ops.note(w.ctx, id, { said: "约在下周三下午了", by: "user" });
  const text = await looking(w, id);
  assert.match(text, /他说了：「约在下周三下午了」/);
  const s = load(w.root, id);
  assert.equal(s.running, true);
  assert.equal(s.next?.source, "fallback");
  assert.equal(w.paseo().schedules[0].cadence.expression, "0 12 2 11 *");
  const lines = read(w.root, id);
  assert.ok(lines.some((l) => l.kind === "wake" && l.why.some((x: string) => x.startsWith("said:"))));
});

test("an answer of 不用盯了 stops the affair; 可以 on a proposal takes its time", async () => {
  const w = world();
  const id = await started(w);
  await looking(w, id);
  const ok = await ops.report(w.ctx, id, good({ ask: { title: "洗牙约上了吗？", line: "约上了告诉我哪天", options: ["约好了", "还没约", "不用盯了"] } }));
  assert.equal(ok.ok, true, ok.text);
  const q = load(w.root, id).asks[0];
  assert.equal(q.id, "dental-1");
  await ops.answer(w.ctx, id, q.id, "不用盯了");
  assert.equal(load(w.root, id).status, "stopped");
  const again = await ops.answer(w.ctx, id, q.id, "还没约");
  assert.match(again.text, /答过了/);
});

test("a day with its looks used up refuses another, and 今天再看一次 gets one more", async () => {
  const w = world();
  const id = await started(w);
  for (let i = 0; i < 8; i++) {
    await looking(w, id);
    await ops.report(w.ctx, id, good({ status: `x${i}` }));
    w.advance(10 * 60_000);
  }
  const refused = await ops.requestLook(w.ctx, id, "test");
  assert.equal(refused.ok, false);
  assert.match(refused.text, /8 次/);
  const forced = await ops.requestLook(w.ctx, id, "test", { force: true });
  assert.equal(forced.ok, true);
});

test("the plan is made to agree with the log: a paused plan of a watched affair is resumed, a later time is moved", async () => {
  const w = world();
  const id = await started(w);
  await looking(w, id);
  await ops.report(w.ctx, id, good());
  const state = JSON.parse(readFileSync(path.join(w.dir, "paseo.json"), "utf8"));
  state.schedules[0].status = "paused";
  state.schedules[0].cadence.expression = "0 0 1 1 *";
  w.file("paseo.json", JSON.stringify(state));
  const r = await ops.syncPlan(w.ctx, id);
  assert.deepEqual(r.changed.sort(), ["rescheduled", "resumed"]);
  assert.equal(w.paseo().schedules[0].status, "active");
});

test("a Paseo that fails to change the plan is written down, not lost", async () => {
  const w = world();
  const id = await started(w);
  await looking(w, id);
  process.env.FAKE_PASEO_FAIL = "schedule update";
  const r = await ops.report(w.ctx, id, good());
  assert.equal(r.ok, true, "the report itself is taken");
  assert.ok(load(w.root, id).flags.some((f: { what: string }) => f.what === "schedule"));
  delete process.env.FAKE_PASEO_FAIL;
  const fixed = await ops.syncPlan(w.ctx, id);
  assert.ok(fixed.changed.includes("rescheduled"));
});

test("find: one name is one affair; two are asked about; none lists what there is", async () => {
  const w = world();
  await started(w);
  await ops.create(w.ctx, { id: "other-6", title: "牙冠取模", noWait: true });
  assert.equal(ops.resolve(w.ctx, "洗牙").s?.id, "dental");
  assert.match(ops.resolve(w.ctx, "牙").text!, /「洗牙」还是「牙冠取模」/);
  assert.match(ops.resolve(w.ctx, "提现").text!, /没找到「提现」。在盯的有：洗牙、牙冠取模/);
});

test("nothing a person reads names the machinery", async () => {
  const w = world();
  const id = await started(w);
  const spoken: string[] = [];
  spoken.push((await ops.create(w.ctx, { id: "other-7", title: "体检", noWait: true })).text);
  spoken.push((await ops.note(w.ctx, id, { said: "约在下周三下午了", by: "user" })).text);
  spoken.push((await ops.pause(w.ctx, id, "2026-11-09 10:00")).text);
  spoken.push((await ops.stop(w.ctx, id)).text, ops.undo(w.ctx, id).text, ops.resolve(w.ctx, "没有的").text!);
  const { cardOf, rowsOf, say } = await import("../server/lib/view.mjs");
  const s = { ...load(w.root, id), lines: read(w.root, id) };
  spoken.push(JSON.stringify(cardOf(s, w.now(), w.ctx.policy)), ...rowsOf(s, w.now(), w.ctx.policy).map((r: { text: string }) => r.text));
  spoken.push(say.tooMany(30), say.budget("x", "今天看了 8 次"), say.done("洗牙", "飞书任务勾掉了"), say.troubleRead("#1", "崩溃库连不上（要开 VPN）", "开好了回「好了」，我马上看。"));
  for (const text of spoken) assert.doesNotMatch(text, /叫醒|校验|记录|计划|读数|会话|agent/i, text);
  void iso;
});

test("a time the person chose while a look was on stands over the look's own", async () => {
  const w = world();
  const id = await started(w);
  await looking(w, id);
  await ops.pause(w.ctx, id, "2026-11-09 10:00");
  const r = await ops.report(w.ctx, id, good());
  assert.equal(r.ok, true, r.text);
  assert.equal(load(w.root, id).next?.at, "2026-11-09T10:00:00+08:00");
  assert.equal(load(w.root, id).nowText, good().status, "the rest of what the look saw is taken");
});

test("nothing that looks like a credential, a token or a pairing link is written into an affair's folder", async () => {
  const w = world();
  const id = await started(w);
  const before = readFileSync(path.join(w.root, id, "log.jsonl"), "utf8");
  const bad = ["我的 token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", "密码是 hunter2hunter2", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA", "https://app.paseo.sh/#offer=abcdef", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "-----BEGIN OPENSSH PRIVATE KEY-----"];
  for (const said of bad) {
    const r = await ops.note(w.ctx, id, { said, by: "user" });
    assert.equal(r.ok, false, said);
    assert.match(r.text, /没记下/);
  }
  assert.equal((await ops.create(w.ctx, { id: "other-8", title: "令牌", said: "api_key = abcdef123456", noWait: true })).ok, false);
  await looking(w, id);
  const sent = await ops.report(w.ctx, id, good({ facts: ["拿到了 token=abcdefghijkl"] }));
  assert.equal(sent.ok, false, "a look that read a secret does not write it down");
  assert.doesNotMatch(readFileSync(path.join(w.root, id, "log.jsonl"), "utf8").replace(before, "").replace(/"data":{[^}]*}/g, ""), /ghp_|hunter2|sk-ant|#offer|BEGIN OPENSSH/);
  const fine = await ops.note(w.ctx, id, { said: "牙医说密码什么的不用管，约上就行", by: "user" });
  assert.equal(fine.ok, true, "ordinary words about a password are not a password");
});

test("an empty word is not a thing the person said, and not an answer", async () => {
  const w = world();
  const made = await ops.create(w.ctx, { id: "other-9", title: "洗牙", noWait: true });
  const before = read(w.root, made.id).length;
  assert.equal((await ops.note(w.ctx, made.id, { said: "  ", by: "user" })).ok, false);
  assert.equal((await ops.answer(w.ctx, made.id, `${made.id}-1`, "")).ok, false);
  assert.equal(read(w.root, made.id).length, before, "nothing was written");
});
