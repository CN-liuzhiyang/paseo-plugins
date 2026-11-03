import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as ops from "../server/lib/ops.mjs";
import { append, fold, load, read } from "../server/lib/log.mjs";
import { plainText } from "../server/lib/check.mjs";
import { parseLogs } from "../server/lib/history.mjs";
import { rowsOf } from "../server/lib/view.mjs";
import { world } from "./kit";

const HOUR = 3_600_000;

type W = ReturnType<typeof world>;
const chatOf = (w: W, id: string) => ({ ...w.ctx, by: "chat", chatFor: id });
const lookOf = (w: W) => ({ ...w.ctx, by: "look" });
const runs = (w: W) => w.calls().filter((c) => c[1] === "run-once").length;

async function started(w: W, extra: Record<string, unknown> = {}) {
  const made = await ops.create(w.ctx, { title: "洗牙", goal: "约上洗牙", said: "帮我盯一下洗牙，今天最好要搞定", noWait: true, ...extra });
  assert.equal(made.ok, true, made.text);
  return made.id as string;
}

const lookReport = (over: Record<string, unknown> = {}) => ({
  status: "飞书任务还是待办。",
  entry: "我看了一眼：飞书里有「定期洗牙」，还没约。",
  facts: ["飞书任务 定期洗牙 未完成"],
  next: { at: "2026-11-03 09:30", waitingFor: "等你去约", waitingOn: "me", why: "他说今天最好搞定，明早再看一次", earlyIf: [] },
  ...over,
});

/** A look that has handed in. */
async function looked(w: W, id: string, over: Record<string, unknown> = {}) {
  const b = await ops.brief(lookOf(w), id);
  assert.equal(b.ok, true, b.text);
  const r = await ops.report(lookOf(w), id, lookReport(over));
  assert.equal(r.ok, true, r.text);
  append(w.root, id, [{ kind: "wake.end", state: "ok", usd: 0.01 }], { now: w.now() });
}

/** The chat session reads its brief (which is what lets it write). */
async function chatReads(w: W, id: string) {
  const r = await ops.brief(chatOf(w, id), id, { chat: true });
  assert.equal(r.ok, true, r.text);
  return r.text;
}

/** What he said in the chat, put in the log by the plugin. */
async function noted(c: ReturnType<typeof chatOf>, id: string) {
  return (await ops.note(c, id, { said: "他说约好了", mine: true })).seq as number;
}

async function heard(w: W, id: string, text: string) {
  const r = await ops.hear(w.ctx, id, text);
  assert.equal(r.ok, true, r.text);
  return r.seq as number;
}

const chatReport = (w: W, id: string, data: Record<string, unknown>) => ops.report(chatOf(w, id), id, data, { from: "chat" });

// ---- who is the chat -------------------------------------------------------

test("the chat session is told by its label, which says which affair it is the chat of; a look by the plan's label", async () => {
  const w = world();
  const id = await started(w);
  const plan = load(w.root, id).scheduleId;
  assert.ok(plan, "the affair has a plan");
  process.env.PASEO_AGENT_ID = "agent-chat";
  process.env.FAKE_PASEO_LABELS = JSON.stringify({ "affairs.chat": id });
  try {
    assert.deepEqual(await ops.callerInfo(w.ctx), { by: "chat", chatFor: id });
    process.env.FAKE_PASEO_LABELS = JSON.stringify({ "paseo.schedule-id": plan });
    assert.deepEqual(await ops.callerInfo(w.ctx), { by: "look", chatFor: "" });
    process.env.FAKE_PASEO_LABELS = JSON.stringify({ "paseo.schedule-id": plan, "affairs.chat": id });
    assert.equal((await ops.callerInfo(w.ctx)).by, "look", "a look that also claims to be a chat stays a look");
    process.env.FAKE_PASEO_LABELS = "{}";
    assert.equal((await ops.callerInfo(w.ctx)).by, "human");
  } finally {
    delete process.env.PASEO_AGENT_ID;
    delete process.env.FAKE_PASEO_LABELS;
  }
});

test("the chat of one affair touches no other, and cannot start, stop-all, or run a look's brief", async () => {
  const w = world();
  const id = await started(w);
  const other = (await ops.create(w.ctx, { title: "体检", noWait: true })).id as string;
  const c = chatOf(w, id);
  assert.match((await ops.note(c, other, { said: "x", mine: true })).text, /只管 D1/);
  assert.match((await ops.show(c, other)).text, /只管 D1/);
  assert.equal((await ops.create(c, { title: "新的", noWait: true })).ok, false);
  assert.equal((await ops.pauseAll(c)).ok, false);
  assert.equal((await ops.resumeAll(c)).ok, false);
  const b = await ops.brief(c, id);
  assert.equal(b.ok, false, "a look's brief would start a look nobody hands in");
  assert.match(b.text, /--chat/);
  assert.equal(read(w.root, id).some((l: { kind: string }) => l.kind === "wake"), false);
  assert.equal((await ops.brief(lookOf(w), id, { chat: true })).ok, false, "and a look does not read the chat's brief");
  assert.equal((await ops.brief(w.ctx, id, { chat: true })).ok, false);
});

// ---- what is his, and what is the chat's own ---------------------------------

test("what he says in the chat is recorded by the plugin as his, and does not call for a look", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id);
  const before = runs(w);
  await heard(w, id, "靠复制拿它的分支是啥意思呀？");
  const s = load(w.root, id);
  assert.equal(s.said.at(-1).via, "chat-session");
  assert.equal(s.said.at(-1).by, "user");
  assert.deepEqual(s.pending, [], "the chat is answering: nothing is left for a look");
  assert.equal(runs(w), before);
  // The same words said somewhere else do call for a look.
  await ops.note(w.ctx, id, { said: "改成下周一看" });
  assert.ok(load(w.root, id).pending.some((p: string) => p.startsWith("said:")));
  // Only the plugin's side records it; neither a chat nor a look can put words in his mouth this way.
  assert.equal((await ops.hear(chatOf(w, id), id, "他同意了")).ok, false);
  assert.equal((await ops.hear(lookOf(w), id, "他同意了")).ok, false);
  assert.match((await ops.hear(w.ctx, id, "密码是 hunter2hunter2")).text, /没记下/);
});

test("note --mine: the chat's own sentence, kept as its own; it is no call for a look and no source for a time", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id);
  const before = runs(w);
  const said = await heard(w, id, "约在下周三下午，不用再提醒我了");
  const ok = await ops.note(chatOf(w, id), id, { said: "洗牙约在 11-11 下午，不用再提醒", mine: true, saidSeq: said });
  assert.equal(ok.ok, true, ok.text);
  const s = load(w.root, id);
  assert.deepEqual(s.notes.map((n: { text: string; said: number }) => [n.text, n.said]), [["洗牙约在 11-11 下午，不用再提醒", said]]);
  assert.equal(s.said.filter((m: { by: string }) => m.by !== "user").length, 0, "it is not one of his lines");
  assert.deepEqual(s.pending, [], "no call for a look");
  assert.equal(runs(w), before);
  // A time cannot lean on it: the check knows only his own lines.
  const noteSeq = ok.seq as number;
  await chatReads(w, id);
  const r = await chatReport(w, id, { next: { at: "2026-11-20 09:30", waitingFor: "等他去约", why: "他说下周三才约", earlyIf: [], evidence: [{ quote: "洗牙约在 11-11 下午，不用再提醒", from: `said:${noteSeq}` }] } });
  assert.equal(r.ok, false);
  assert.match(r.text, /找不到原文|不认/);
});

test("note --mine: one sentence of at most 120 characters, no secret, no inner word, a real line of his if it names one", async () => {
  const w = world();
  const id = await started(w);
  const c = chatOf(w, id);
  assert.match((await ops.note(c, id, { said: "字".repeat(121), mine: true })).text, /最多 120/);
  assert.equal((await ops.note(c, id, { said: "字".repeat(120), mine: true })).ok, true);
  assert.match((await ops.note(c, id, { said: "他给了 token: abcdef123456789", mine: true })).text, /密码|令牌/);
  assert.match((await ops.note(c, id, { said: "我用 agent 查了一下", mine: true })).text, /内部用词/);
  assert.equal(plainText("洗牙约在 11-11", 120), true);
  assert.match((await ops.note(c, id, { said: "好", mine: true, saidSeq: 999 })).text, /不是他说的话/);
  const mine = (await ops.note(c, id, { said: "第一条", mine: true })).seq;
  assert.match((await ops.note(c, id, { said: "第二条", mine: true, saidSeq: mine })).text, /不是他说的话/, "its own note is not one of his lines");
  assert.match((await ops.note(c, id, { said: "", mine: true })).text, /没有话/);
  // Without --mine the chat cannot record anything in his name; and --mine is the chat's alone.
  assert.match((await ops.note(c, id, { said: "他说可以了" })).text, /不能以他的名义/);
  assert.match((await ops.note(w.ctx, id, { said: "x", mine: true })).text, /只有对话的会话用/);
  await ops.stop(w.ctx, id, { evidence: "不用了" });
  assert.match((await ops.note(c, id, { said: "收尾", mine: true })).text, /不盯了/);
});

// ---- the same check, said from the chat ------------------------------------

/** A fresh affair whose chat has read its brief: each case of the check starts from nothing (a rejected hand-in is carried into the next). */
async function ready() {
  const w = world();
  const id = await started(w);
  await looked(w, id);
  await chatReads(w, id);
  return { w, id };
}
const nextAt = (over: Record<string, unknown>) => ({ at: "2026-11-03 09:30", waitingFor: "等他去约", why: "他说明天再看", earlyIf: [], ...over });

test("report --from chat: the check holds for the chat as it does for a look", async () => {
  {
    const { w, id } = await ready();
    assert.match((await chatReport(w, id, { next: nextAt({ at: "2026-11-02 10:05" }) })).text, /最早/, "too soon");
  }
  {
    const { w, id } = await ready();
    assert.match((await chatReport(w, id, { next: nextAt({ waitingFor: "等变化" }) })).text, /缺『在等什么』/, "a filler for what it waits on");
  }
  {
    const { w, id } = await ready();
    const far = await chatReport(w, id, { next: nextAt({ at: "2026-12-20 09:30" }) });
    assert.equal(far.ok, false, "too far, with nothing of his behind it");
    assert.match(far.text, /L 是/);
  }
  {
    const { w, id } = await ready();
    assert.match((await chatReport(w, id, { status: "会话已读完" })).text, /内部用词/);
  }
  {
    const { w, id } = await ready();
    assert.match((await chatReport(w, id, { status: "token=abcdef0123456789" })).text, /密码|令牌/);
  }
  {
    const { w, id } = await ready();
    const fake = await chatReport(w, id, { next: nextAt({ at: "2026-11-20 09:30", evidence: [{ quote: "他说三个月后再看这件事", from: "said:1" }] }) });
    assert.equal(fake.ok, false, "a quote he never said");
    assert.match(fake.text, /找不到原文/);
  }
  const { w, id } = await ready();
  const said = await heard(w, id, "这件事先放放，下个月二十号左右再看吧");
  await chatReads(w, id);
  const good = await chatReport(w, id, { next: nextAt({ at: "2026-11-20 09:30", why: "他说下个月二十号左右再看", evidence: [{ quote: "下个月二十号左右再看", from: `said:${said}` }] }) });
  assert.equal(good.ok, true, good.text);
  assert.equal(load(w.root, id).next.source, "chat");
  assert.equal(load(w.root, id).next.verdict, "recorded", "a quote he did say: taken, with the reason on the record");
  // the third try that does not pass: what is fine is kept, the time of the next look stays
  const keep = load(w.root, id).next.at;
  await chatReads(w, id);
  for (let i = 0; i < 2; i++) assert.equal((await chatReport(w, id, { status: "不错", next: nextAt({ at: "2026-11-02 10:05" }) })).ok, false);
  const third = await chatReport(w, id, { status: "还是没约", next: nextAt({ at: "2026-11-02 10:05" }) });
  assert.equal(third.ok, true, third.text);
  assert.equal(load(w.root, id).next.at, keep, "the bad time was not taken");
  assert.equal(load(w.root, id).nowText, "还是没约");
  assert.ok(load(w.root, id).flags.some((f: { what: string }) => f.what === "fallback"));
  assert.equal(load(w.root, id).chatAttempt, 0, "its tries start again");
});

test("report --from chat: nothing to hand in, a watch, a bad drop are sent back; it must have read first", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id);
  assert.match((await chatReport(w, id, { status: "还没约" })).text, /brief .* --chat/, "it has not read yet");
  await chatReads(w, id);
  assert.match((await chatReport(w, id, {})).text, /至少写一项/);
  assert.match((await chatReport(w, id, { status: "x", watches: [{ id: "w1", tool: "t" }] })).text, /读数只有看一眼能登记/);
  assert.match((await chatReport(w, id, { drop: "不是数组" })).text, /drop/);
  // what was sent back stays in the hand-in; the fields that did not pass are the ones to send again
  assert.equal((await chatReport(w, id, { status: "还没约", watches: [], drop: [] })).ok, true);
});

test("report --from chat: only the chat says it; the plan and a look cannot", async () => {
  const w = world();
  const id = await started(w);
  await ops.brief(lookOf(w), id);
  assert.match((await ops.report(lookOf(w), id, { status: "x" }, { from: "chat" })).text, /只有对话/);
  assert.match((await ops.report(w.ctx, id, { status: "x" }, { from: "chat" })).text, /只有对话/);
  assert.match((await ops.report(chatOf(w, id), id, { status: "x" })).text, /--from chat/);
});

test("it can finish an affair from the chat, with his words behind it; not with words he did not say", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id);
  const said = await heard(w, id, "洗牙已经约好了，不用再盯了");
  await chatReads(w, id);
  const no = await chatReport(w, id, { finish: { kind: "done", evidence: { quote: "他说约好了就结束", from: `said:${said}` } } });
  assert.equal(no.ok, false);
  const yes = await chatReport(w, id, { finish: { kind: "done", evidence: { quote: "洗牙已经约好了", from: `said:${said}` }, summary: "洗牙约好了" } });
  assert.equal(yes.ok, true, yes.text);
  assert.equal(load(w.root, id).status, "done");
});

// ---- answers and pauses the chat makes for him -------------------------------

test("answer from the chat: only with a line of his made after the question, which is then the answer word for word; never a choice it names itself", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id, { ask: { title: "洗牙约上了吗？", options: ["约好了", "还没约", "不用盯了"] } });
  const q = load(w.root, id).asks[0];
  const c = chatOf(w, id);
  // the way the review found: the choice's own words, said by the chat session, he has said nothing
  for (const text of ["约好了", "不用盯了", "还没约"]) assert.match((await ops.answer(c, id, q.id, text)).text, /--said-seq/, text);
  assert.equal(load(w.root, id).asks[0].state, "open", "nothing was answered");
  assert.equal(load(w.root, id).status, "watching", "and nothing was stopped in his name");
  assert.match((await ops.answer(c, id, q.id, "", "chat", { saidSeq: "" })).text, /--said-seq/, "no line pointed to");
  // a line of his from before the question, a line that is not his, one taken back: none is an answer
  const early = load(w.root, id).said[0].seq;
  assert.match((await ops.answer(c, id, q.id, "", "chat", { saidSeq: early })).text, /不是他在问题出现以后说的话/);
  const other = (await ops.hear(w.ctx, id, "约好了，别的会话说的", { fromAgent: true, messageId: "call:1" })).seq;
  assert.match((await ops.answer(c, id, q.id, "", "chat", { saidSeq: other })).text, /不是他在问题出现以后说的话/, "another session's words are not his");
  assert.match((await ops.answer(c, id, q.id, "", "chat", { saidSeq: await noted(c, id) })).text, /不是他在问题出现以后说的话/, "nor its own note");
  const taken = await heard(w, id, "约好了，下周三下午两点");
  ops.undo(w.ctx, id);
  assert.match((await ops.answer(c, id, q.id, "", "chat", { saidSeq: taken })).text, /不是他在问题出现以后说的话/, "taken back");
  // his own line, after the question: that is the answer
  const said = await heard(w, id, "约好了，下周三下午两点");
  const ok = await ops.answer(c, id, q.id, "", "chat", { saidSeq: said });
  assert.equal(ok.ok, true, ok.text);
  const asked = load(w.root, id).asks[0];
  assert.deepEqual([asked.state, asked.answer], ["answered", "约好了，下周三下午两点"], "his words, not the chat's");
  // a human's way is as it was
  await looked(w, id, { ask: { title: "要不要提醒？", options: ["要", "不要"] } });
  const q2 = load(w.root, id).asks.find((x: { state: string }) => x.state === "open");
  assert.equal((await ops.answer(w.ctx, id, q2.id, "要")).ok, true);
});

test("the chat cannot approve its own proposal: a far time it asks for becomes a question, and answering it needs his word", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id);
  const c = chatOf(w, id);
  await chatReads(w, id);
  const r = await chatReport(w, id, { next: { at: "2027-03-01 09:30", waitingFor: "3月1日再看", why: "他说今天最好搞定", earlyIf: [], evidence: [{ from: "said:2", quote: "帮我盯一下洗牙，今天最好要搞定" }] } });
  void r;
  const q = load(w.root, id).asks.find((x: { state: string; proposal: unknown }) => x.state === "open" && x.proposal);
  assert.ok(q, "a proposal waits for him");
  assert.match((await ops.answer(c, id, q.id, "可以")).text, /--said-seq/);
  assert.notEqual(load(w.root, id).next?.at?.slice(0, 4), "2027", "the far time did not take effect");
  const said = await heard(w, id, "可以");
  assert.equal((await ops.answer(c, id, q.id, "", "chat", { saidSeq: said })).ok, true);
  assert.equal(load(w.root, id).next.at.slice(0, 7), "2027-03", "his word made it so");
});

test("pause from the chat: --said is refused; --said-seq must name a line of his; a time past the limit leans on it", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id);
  const c = chatOf(w, id);
  assert.match((await ops.pause(c, id, "2026-12-20 09:30", "他说三个月后再看")).text, /--said-seq/);
  assert.match((await ops.pause(c, id, "2026-12-20 09:30", "", { saidSeq: 999 })).text, /不是他说的话/);
  const mine = (await ops.note(c, id, { said: "他说三个月后再看", mine: true })).seq;
  assert.match((await ops.pause(c, id, "2026-12-20 09:30", "", { saidSeq: mine })).text, /不是他说的话/, "its own note is not his");
  assert.equal((await ops.pause(c, id, "2026-12-20 09:30")).ok, false, "past the limit, with nothing of his behind it");
  // a line of his that does not say the day does not back it, whatever else it says
  const vague = await heard(w, id, "这件事过年以后再看吧，不着急");
  assert.match((await ops.pause(c, id, "2026-11-20 09:30", "", { saidSeq: vague })).text, /没有说到 2026-11-20/);
  assert.equal(load(w.root, id).next.at.slice(0, 10) === "2026-11-20", false);
  const said = await heard(w, id, "这件事11月20号再看吧");
  const far = await ops.pause(c, id, "2026-11-20 09:30", "", { saidSeq: said });
  assert.equal(far.ok, true, far.text);
  assert.equal(load(w.root, id).next.source, "user", "his words backed it");
  assert.equal(load(w.root, id).next.at.slice(0, 10), "2026-11-20");
  assert.equal((await ops.pause(c, id, "2026-11-04 09:30")).ok, true, "within the limit it needs none");
  assert.equal(load(w.root, id).next.source, "chat");
  // a human's --said-seq is not a thing
  assert.match((await ops.pause(w.ctx, id, "2026-11-05 09:30", "", { saidSeq: said })).text, /只有对话/);
});

// ---- both sides handing in at once -------------------------------------------

test("what a look and the chat hand in at the same time: the later one is sent back once to read the other, then taken", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id);
  // the chat reads, a look comes and hands in, then the chat hands in
  await chatReads(w, id);
  w.advance(HOUR);
  await looked(w, id, { status: "刚看过一眼" });
  const first = await chatReport(w, id, { status: "他问过复制" });
  assert.equal(first.ok, false);
  assert.match(first.text, /刚看过一眼/);
  assert.equal(load(w.root, id).nowText, "刚看过一眼", "nothing of the chat's was taken");
  await chatReads(w, id);
  assert.equal((await chatReport(w, id, { status: "他问过复制" })).ok, true, "read again: taken");
  // the other way: a look is on, the chat hands in, the look hands in
  w.advance(HOUR);
  await ops.brief(lookOf(w), id);
  await chatReads(w, id);
  assert.equal((await chatReport(w, id, { facts: ["他说下周三去约"] })).ok, true);
  const back = await ops.report(lookOf(w), id, lookReport({ facts: ["飞书任务 未完成"] }));
  assert.equal(back.ok, false);
  assert.match(back.text, /在对话里改了东西/);
  assert.deepEqual(load(w.root, id).facts.includes("他说下周三去约"), true, "what the chat wrote stands");
  await ops.brief(lookOf(w), id);
  const again = await ops.report(lookOf(w), id, lookReport({ facts: ["飞书任务 未完成"], drop: [] }));
  assert.equal(again.ok, true, again.text);
  assert.equal(load(w.root, id).facts.includes("他说下周三去约"), true, "a look that says what to drop adds to the facts, it does not replace them");
});

test("a look that does not say what to drop still replaces the facts, as before", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id, { facts: ["旧的一条"] });
  w.advance(HOUR);
  await looked(w, id, { facts: ["新的一条"] });
  assert.deepEqual(load(w.root, id).facts, ["新的一条"]);
});

test("the chat's facts are added to and dropped from, not replaced; a repeat is not added twice; no more than 20", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id, { facts: ["飞书任务 定期洗牙 未完成"] });
  await chatReads(w, id);
  assert.equal((await chatReport(w, id, { facts: ["他问过复制", "飞书任务 定期洗牙 未完成"] })).ok, true);
  assert.deepEqual(load(w.root, id).facts, ["飞书任务 定期洗牙 未完成", "他问过复制"]);
  assert.equal((await chatReport(w, id, { drop: ["他问过复制"], facts: ["约在周三"] })).ok, true);
  assert.deepEqual(load(w.root, id).facts, ["飞书任务 定期洗牙 未完成", "约在周三"]);
  const many = Array.from({ length: 19 }, (_, i) => `第 ${i} 条`);
  const over = await chatReport(w, id, { facts: many });
  assert.equal(over.ok, false);
  assert.match(over.text, /最多 20 条/);
});

// ---- what a person sees and what the log says --------------------------------

test("the chat's own lines are drawn plainly: its notes in a row, its hand-ins and his chat words not; no mechanism word", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id);
  await heard(w, id, "靠复制拿它的分支是啥意思呀？");
  await chatReads(w, id);
  await ops.note(chatOf(w, id), id, { said: "约在下周三下午", mine: true });
  await chatReport(w, id, { status: "他问过复制", entry: "他问过复制，已答" });
  const s = ops.show(w.ctx, id, { log: true });
  assert.equal(s.ok, true);
  const rows = rowsOf({ ...load(w.root, id), lines: read(w.root, id) }, w.now(), w.ctx.policy);
  const texts = rows.map((r: { text: string }) => r.text);
  assert.ok(texts.some((t: string) => /我记下：约在下周三下午/.test(t)));
  assert.ok(!texts.some((t: string) => /复制/.test(t)), "his words in the chat are on his screen already, and its hand-in is no look");
  for (const t of texts) assert.doesNotMatch(t, /叫醒|校验|读数|会话|agent|计划/);
});

test("an unknown kind of line is skipped by the fold, and the lines after it still count", () => {
  const lines = [
    { seq: 1, at: "2026-11-02T10:00:00+08:00", kind: "created", id: "D1", title: "洗牙" },
    { seq: 2, at: "2026-11-02T10:00:01+08:00", kind: "from-the-future", whatever: { a: 1 } },
    { seq: 3, at: "2026-11-02T10:00:02+08:00", kind: "note", by: "chat", text: "一条" },
    { seq: 4, at: "2026-11-02T10:00:03+08:00", kind: "chat", agentId: "agent-1" },
    { seq: 5, at: "2026-11-02T10:00:04+08:00", kind: "said", text: "好", via: "chat-session", by: "user" },
  ];
  const s = fold(lines);
  assert.equal(s.title, "洗牙");
  assert.deepEqual(s.notes.map((n: { text: string }) => n.text), ["一条"]);
  assert.equal(s.chatId, "agent-1");
  assert.equal(s.lastSeq, 5);
  assert.deepEqual(s.pending, []);
});

// ---- the chat's brief ----------------------------------------------------------

test("brief --chat: where it stands, what is new since it last read, what it wrote down, how to write a reference; it starts no look", async () => {
  const w = world({ policy: { links: { gcp: "https://pm.example.invalid/v6/issues/{ref}" }, linkHash: "gcp" } });
  const id = await started(w, { link: "gcp:#555001", title: "#555001 引擎外放" });
  const wakes = () => read(w.root, id).filter((l: { kind: string }) => l.kind === "wake").length;
  const b0 = await chatReads(w, id);
  assert.match(b0, /事项 555001：#555001 引擎外放/);
  assert.match(b0, /#2 .*他说：「帮我盯一下洗牙/, "the first read shows what there is");
  assert.match(b0, /\[#555001\]\(https:\/\/pm\.example\.invalid\/v6\/issues\/555001\)/, "the affair's own ticket, written as a link");
  assert.match(b0, /gcp：\[<号>\]\(https:\/\/pm\.example\.invalid\/v6\/issues\/\{ref\}\)/);
  assert.match(b0, /没有（这是这件事的第一段对话）/);
  assert.equal(await chatReads(w, id).then((t) => /- 没有新的/.test(t)), true, "read again: nothing new");
  // news: a look's result, something he said elsewhere, a question, an answer given in the app
  w.advance(HOUR);
  await looked(w, id, { ask: { title: "要不要提醒？", options: ["要", "不要"] } });
  await ops.note(w.ctx, id, { said: "下周一我出差" });
  const q = load(w.root, id).asks[0];
  await ops.answer(w.ctx, id, q.id, "要", "workspace");
  await heard(w, id, "在对话里说的话不算新消息");
  const b1 = await chatReads(w, id);
  assert.match(b1, /看一眼的结果：我看了一眼/);
  assert.match(b1, /他说：「下周一我出差」/);
  assert.match(b1, /他答了问题 .*「要」/);
  assert.doesNotMatch(b1.split("## 没答的问题")[0], /在对话里说的话不算新消息/);
  assert.match(b1, /最近 10 行经过[\s\S]*在对话里说的话不算新消息/, "but it is in the lines she can point to");
  const wakesBefore = wakes();
  const runsBefore = runs(w);
  await chatReads(w, id);
  assert.equal(wakes(), wakesBefore, "reading it started no look");
  assert.equal(runs(w), runsBefore);
});

test("brief --chat: its own notes are listed (the latest ten), and a closed affair can still be read", async () => {
  const w = world();
  const id = await started(w);
  const c = chatOf(w, id);
  await chatReads(w, id);
  for (let i = 1; i <= 12; i++) await ops.note(c, id, { said: `结论${i}`, mine: true });
  const b = await chatReads(w, id);
  assert.match(b, /结论12/);
  assert.match(b, /结论3\b/);
  assert.doesNotMatch(b, /结论2\b/);
  await ops.stop(w.ctx, id, { evidence: "不用了" });
  const closed = await ops.brief(c, id, { chat: true });
  assert.equal(closed.ok, true);
  assert.match(closed.text, /已经不盯了/);
});

test("brief --chat names the earlier chats and tells when to look into them", async () => {
  const w = world();
  const id = await started(w);
  append(w.root, id, [{ kind: "chat", agentId: "agent-old" }, { kind: "chat", agentId: "agent-now" }], { now: w.now() });
  process.env.PASEO_AGENT_ID = "agent-now";
  try {
    const b = await chatReads(w, id);
    assert.match(b, /以前的对话[\s\S]*1 段（最早 11-02/);
    assert.match(b, /history D1 --q <词>/);
    assert.match(b, /别去读整段旧对话/);
  } finally {
    delete process.env.PASEO_AGENT_ID;
  }
});

// ---- history -------------------------------------------------------------------

const LOG_OLD = [
  "[User] 靠复制拿它的分支是啥意思呀？",
  "有些分支不自己提交代码，而是定期把发布分支的引擎目录整个复制过去。",
  "64711 现在只在发布分支，这些分支还没复制到，所以是空的。",
  "[User] win64r 到了吗",
  "到了 64711。",
  "[Tool] read 64711",
  "{\"commits\": 3}",
  "其余槽位还没到。",
  "[Message received] 3d36d376-d56d-4b42-9d9d-78f590754864",
  "复制的事别忘了查",
  "收到。",
  "[User] 复制到别的分支以后怎么确认？",
  "看那几个分支的引擎目录有没有 64711。",
].join("\n");

function chats(w: W, id: string, files: Record<string, string>, order: string[]) {
  const dir = path.join(w.dir, "logs");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, `${name}.txt`), text);
  process.env.FAKE_PASEO_LOGS = dir;
  append(w.root, id, order.map((agentId) => ({ kind: "chat", agentId })), { now: w.now() });
}

test("history reads what `paseo logs` prints: only his questions, with the words answered, tools and other senders left out", () => {
  const turns = parseLogs(LOG_OLD);
  assert.deepEqual(turns.map((t) => t.ask), ["靠复制拿它的分支是啥意思呀？", "win64r 到了吗", "复制到别的分支以后怎么确认？"]);
  assert.match(turns[0].reply, /整个复制过去/);
  assert.match(turns[1].reply, /到了 64711。/);
  assert.doesNotMatch(turns[1].reply, /commits|复制的事|收到/, "a tool block and a message from another session are not part of the answer");
});

test("history --q: his questions only, every word has to be in it, newer first, --pick for the others; skips the chat that asks", async () => {
  const w = world();
  const id = await started(w);
  chats(w, id, { "agent-old": LOG_OLD, "agent-new": "[User] 复制好了吗\n还没有。\n[User] 别的\n好。", "agent-now": "[User] 复制 现在这段\n不该出现" }, ["agent-old", "agent-new", "agent-now"]);
  process.env.PASEO_AGENT_ID = "agent-now";
  const c = chatOf(w, id);
  try {
    const hit = await ops.history(c, id, { q: "复制" });
    assert.equal(hit.ok, true, hit.text);
    assert.match(hit.text, /他问：复制好了吗/, "the newest chat first");
    assert.doesNotMatch(hit.text, /现在这段|不该出现/, "the chat that asks is not searched");
    assert.match(hit.text, /还有 2 处提到「复制」：加 --pick 2、--pick 3 看/);
    const second = await ops.history(c, id, { q: "复制", pick: 2 });
    assert.match(second.text, /他问：复制到别的分支以后怎么确认？/);
    assert.match(second.text, /你答：看那几个分支的引擎目录有没有 64711。/);
    // every word of the query must be there; words in the answer or in his other senders' messages do not count
    assert.equal((await ops.history(c, id, { q: "复制 分支" })).text.match(/他问：(.*)/)![1], "复制到别的分支以后怎么确认？");
    const none = await ops.history(c, id, { q: "二十号" });
    assert.equal(none.ok, false);
    assert.match(none.text, /以前的对话里没找到「二十号」/);
    assert.match(none.text, /都没有就直接问他，别猜/);
    assert.equal((await ops.history(c, id, { q: "64711" })).ok, false, "a word that is only in an answer is not a hit");
    // ignoring case, spaces and punctuation
    assert.equal((await ops.history(c, id, { q: "WIN64R" })).ok, true);
    assert.equal((await ops.history(c, id, { q: "分支，是啥" })).ok, true);
  } finally {
    delete process.env.PASEO_AGENT_ID;
  }
});

test("history without --q lists the earlier chats; with none there is nothing to find; a look cannot ask", async () => {
  const w = world();
  const id = await started(w);
  const c = chatOf(w, id);
  assert.match((await ops.history(c, id, {})).text, /还没有换过对话/);
  chats(w, id, { "agent-old": LOG_OLD }, ["agent-old", "agent-now"]);
  process.env.PASEO_AGENT_ID = "agent-now";
  try {
    const list = await ops.history(c, id, {});
    assert.match(list.text, /以前的对话 1 段/);
    assert.match(list.text, /3 轮  第一句：靠复制拿它的分支是啥意思呀？/);
    assert.equal((await ops.history(lookOf(w), id, { q: "复制" })).ok, false);
  } finally {
    delete process.env.PASEO_AGENT_ID;
  }
});

test("history cuts what it prints: the question at 300 characters, the answer at 1200, both within --max (default 1500, at most 3000)", async () => {
  const w = world();
  const id = await started(w);
  const long = `[User] 长${"问".repeat(400)}\n${"答".repeat(2000)}`;
  chats(w, id, { "agent-old": long }, ["agent-old", "agent-now"]);
  process.env.PASEO_AGENT_ID = "agent-now";
  const c = chatOf(w, id);
  const text = (r: { text: string }) => r.text.split("\n");
  const def = await ops.history(c, id, { q: "长" });
  const ask = text(def).find((l) => l.startsWith("他问："))!.slice(3);
  const reply = text(def).find((l) => l.startsWith("你答："))!.slice(3);
  assert.equal([...ask].length, 300);
  assert.equal([...reply].length, 1200, "1200 of the 1500 left after the question's 300");
  assert.match(def.text, /截掉了 \d+ 个字/);
  const small = await ops.history(c, id, { q: "长", max: 500 });
  const sAsk = text(small).find((l) => l.startsWith("他问："))!.slice(3);
  const sReply = text(small).find((l) => l.startsWith("你答："))!.slice(3);
  assert.equal([...sAsk].length + [...sReply].length, 500);
  const big = await ops.history(c, id, { q: "长", max: 99999 });
  const bAsk = text(big).find((l) => l.startsWith("他问："))!.slice(3);
  const bReply = text(big).find((l) => l.startsWith("你答："))!.slice(3);
  assert.ok([...bAsk].length + [...bReply].length <= 3000);
  assert.equal([...bReply].length, 1200, "the answer's own limit still holds");
  delete process.env.PASEO_AGENT_ID;
});

test("history: a chat that cannot be read is said so after what was found; none readable is exit code 2", async () => {
  const w = world();
  const id = await started(w);
  chats(w, id, { "agent-ok": "[User] 复制好了吗\n还没有。" }, ["agent-ok", "agent-gone", "agent-now"]);
  process.env.PASEO_AGENT_ID = "agent-now";
  const c = chatOf(w, id);
  const some = await ops.history(c, id, { q: "复制" });
  assert.equal(some.ok, true);
  assert.match(some.text, /他问：复制好了吗/);
  assert.match(some.text, /以前的对话 agen…（11-02 10:00）读不到：.*Agent not found.*，没查。/);
  const w2 = world();
  const id2 = await started(w2);
  chats(w2, id2, {}, ["agent-gone", "agent-now"]);
  const none = await ops.history(chatOf(w2, id2), id2, { q: "复制" });
  delete process.env.PASEO_AGENT_ID;
  assert.equal(none.ok, false);
  assert.equal(none.code, 2);
  assert.match(none.text, /读不到/);
});

// ---- the protections the review found untested ---------------------------------------------------------------------

test("--said-seq on note and pause must be a line of his that stands: another session's words and a line he took back are refused", async () => {
  const w = world();
  const id = await started(w);
  await looked(w, id);
  const c = chatOf(w, id);
  const other = (await ops.hear(w.ctx, id, "这件事11月20号再看吧，别的会话说的", { fromAgent: true, messageId: "call:7" })).seq as number;
  const taken = await heard(w, id, "这件事11月20号再看吧，我说错了");
  ops.undo(w.ctx, id);
  for (const seq of [other, taken]) {
    assert.match((await ops.note(c, id, { said: "他说11月20号再看", mine: true, saidSeq: seq })).text, /不是他说的话/, `note, line ${seq}`);
    assert.match((await ops.pause(c, id, "2026-11-20 09:30", "", { saidSeq: seq })).text, /不是他说的话/, `pause, line ${seq}`);
  }
  assert.notEqual(load(w.root, id).next.at.slice(0, 10), "2026-11-20");
  const real = await heard(w, id, "这件事11月20号再看吧");
  assert.equal((await ops.note(c, id, { said: "他说11月20号再看", mine: true, saidSeq: real })).ok, true);
  assert.equal((await ops.pause(c, id, "2026-11-20 09:30", "", { saidSeq: real })).ok, true);
});

test("the chat has to have read its brief before it hands anything in", async () => {
  const w = world();
  const id = await started(w);
  // nothing has happened since it began, so only the rule itself stops it
  const first = await chatReport(w, id, { status: "他问过复制" });
  assert.equal(first.ok, false);
  assert.match(first.text, /先看一遍/);
  await looked(w, id);
  const early = await chatReport(w, id, { status: "他问过复制" });
  assert.equal(early.ok, false);
  assert.match(early.text, /brief .*--chat/);
  assert.notEqual(load(w.root, id).nowText, "他问过复制");
  await chatReads(w, id);
  assert.equal((await chatReport(w, id, { status: "他问过复制" })).ok, true);
});

test("the day a time falls on has to be in his words: dates, months and spans, and not a word that only says later", async () => {
  const { mentionsDay } = await import("../server/lib/check.mjs");
  const tz = "Asia/Shanghai";
  const now = Date.parse("2026-11-03T10:00:00+08:00");
  const at = (s: string) => Date.parse(`${s}:00+08:00`);
  assert.equal(mentionsDay("11月20号再看", at("2026-11-20T09:30"), now, tz), true);
  assert.equal(mentionsDay("十一月二十日吧", at("2026-11-20T09:30"), now, tz), true, "numbers written in characters are read too");
  assert.equal(mentionsDay("2027-03-01", at("2027-03-01T09:30"), now, tz), true);
  assert.equal(mentionsDay("3/1 之后", at("2027-03-01T09:30"), now, tz), true);
  assert.equal(mentionsDay("三月再看", at("2027-03-01T09:30"), now, tz), true);
  assert.equal(mentionsDay("下个月再看", at("2026-12-10T09:30"), now, tz), true);
  assert.equal(mentionsDay("明年再看", at("2027-03-01T09:30"), now, tz), true);
  assert.equal(mentionsDay("两周后看", at("2026-11-17T09:30"), now, tz), true);
  assert.equal(mentionsDay("两周后看", at("2027-03-01T09:30"), now, tz), false);
  assert.equal(mentionsDay("三个月后再看", at("2027-02-03T09:30"), now, tz), true);
  assert.equal(mentionsDay("过年以后再看吧", at("2027-03-01T09:30"), now, tz), false);
  assert.equal(mentionsDay("帮我盯一下洗牙，今天最好要搞定", at("2027-03-01T09:30"), now, tz), false);
  assert.equal(mentionsDay("11月20号再看", at("2026-11-21T09:30"), now, tz), false, "another day");
});
