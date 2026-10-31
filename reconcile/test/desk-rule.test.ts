import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { World } from "./helpers";
import { assessed, comes, commitmentsOf, deskRule, fact, going, idOf, item, looksOf, note, own, pass, POLICY, proposal, say, tell, track, undoLast, withDesk } from "./desk-kit";
import { failedProbe, finished, flowsOf } from "./flows-kit";

// The example rule for matters a person told (examples/desk.mjs), run by the real engine against a launcher that only records and
// looks the test says come back as they would: when it looks, what it keeps of what a look proposes, what it asks, what it never
// does by itself. 2026-10-13 is a Tuesday; the working hours of "work" are workdays 09:30-20:00, "personal" has none.

const SAID = "帮我盯一下体检，月底前要约上";
const input = (w: World, n: number) => JSON.parse(readFileSync(w.flows.launcher.started[n]!.inputFile, "utf8")) as Record<string, unknown>;
const log = (w: World, n = 1) => JSON.parse(fact(w, n, "log") || "[]") as Array<{ n: number; why: string; looked: string; status: string; next: string; clamp: string | null; question?: string | null }>;
const waiting = (w: World, n = 1) => commitmentsOf(w, n).filter((c) => c.status === "scheduled" || c.status === "waiting");
/** Every look the launcher started and the test has not answered comes back with this. */
const answerAll = (w: World, value: unknown, costUsd = 0.01) => {
  for (const s of w.flows.launcher.started) if (!w.flows.probes.has(s.runId)) w.flows.probes.set(s.runId, finished(value, { summary: "看了一眼：…" }, costUsd));
};

// ---- the first look ---------------------------------------------------------------------------------------------

test("a matter told starts its first look in the same round, with all the look needs, and the page says what is going on", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    assert.equal(w.flows.launcher.started.length, 1);
    assert.deepEqual(input(w, 0), { id: "D1", title: "年度体检", said: SAID, domain: "personal", n: 1, why: "first", now: "2026-10-13 周二 10:00", tz: "Asia/Shanghai", status: "", log: [], askQuestion: "", askOptions: [], askAt: "", answers: [], notes: [], minLookMinutes: 60, maxLookDays: 14, hint: "", workdir: "" });
    const rec = flowsOf(w)[idOf(1, 1)]!;
    assert.deepEqual([rec.flow, rec.name, rec.key, rec.timeout, rec.maxUsd, rec.notify, rec.selfRetry, rec.label], ["item-glance", "look", "look-1", "20m", 0.5, false, true, "第 1 次看一眼"]);
    assert.equal(rec.affairLabel, "年度体检（D1）");
    assert.equal(assessed(w, 1)!.headline, "正在看第一眼");
    assert.equal(assessed(w, 1)!.next.what, "正在看");
    assert.equal(assessed(w, 1)!.next.actor, "system");
    assert.equal(fact(w, 1, "looks"), "1");
  }));

test("a look that is going is the same input in every round, however long it takes: not another look, not a changed request", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    going(w, 1, 1);
    await pass(w, 120, 10);
    assert.equal(w.flows.launcher.started.length, 1);
    assert.equal(w.engine.graph("desk:D1")!.runs[0]!.inputDrifted ?? false, false, "what it reads at 10:00 and at 12:00 is the same");
    assert.equal(assessed(w, 1)!.headline, "正在看第一眼");
  }));

test("what a look came back with is kept, said as it is, and the next look is told with the day of the week", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    comes(w, 1, 1, proposal({ status: "飞书任务没完成，截止已过", looked: "读了飞书任务", nextLook: "2026-10-15 10:00" }));
    await pass(w, 5);
    const a = assessed(w, 1)!;
    assert.equal(a.stage, "watching");
    assert.equal(a.headline, "飞书任务没完成，截止已过");
    assert.deepEqual([a.next.actor, a.next.what], ["system", "下次看 10-15 周四 10:00"]);
    assert.equal(fact(w, 1, "next"), "2026-10-15T10:00:00+08:00");
    assert.equal(fact(w, 1, "status"), "飞书任务没完成，截止已过");
    assert.deepEqual(log(w).map((e) => [e.n, e.why, e.looked, e.clamp]), [[1, "first", "读了飞书任务", null]]);
    // nothing until then
    await pass(w, 24 * 60, 60);
    assert.equal(w.flows.launcher.started.length, 1, "10-14 10:05: not yet");
    await pass(w, 24 * 60, 60);
    assert.equal(w.flows.launcher.started.length, 2, "10-15 10:05: it is time");
    const second = input(w, 1);
    assert.deepEqual([second.n, second.why, second.status, second.now], [2, "time", "飞书任务没完成，截止已过", "2026-10-15 周四 10:05"]);
    assert.deepEqual(second.log, [{ at: "2026-10-13 周二 10:05", looked: "读了飞书任务", status: "飞书任务没完成，截止已过" }]);
    assert.equal(assessed(w, 1)!.headline, "飞书任务没完成，截止已过（正在看第 2 次）");
  }));

// ---- what it keeps of a proposal ------------------------------------------------------------------------------------

test("when the next look is: never nearer than the minimum nor further than the maximum, in working hours for work, and a time it cannot read is three workdays", async () => {
  // [domain, what the look proposed, the next look it comes to, a word of what was changed]
  const cases: Array<[string, string, string, RegExp | null]> = [
    ["personal", "2026-10-13 10:10", "2026-10-13T11:05:00+08:00", /太近了，推到 60 分钟后/],
    ["personal", "2026-12-30 10:00", "2026-10-27T10:05:00+08:00", /太远了，拉到 14 天内/],
    ["personal", "2026-10-17 11:00", "2026-10-17T11:00:00+08:00", null], // a Saturday: no hours for a matter of one's own
    ["work", "2026-10-17 11:00", "2026-10-19T10:00:00+08:00", /不在工作时间，挪到下一个工作日 10:00/],
    ["work", "2026-10-14 21:00", "2026-10-15T10:00:00+08:00", /不在工作时间，挪到下一个工作日/],
    ["work", "2026-10-14 08:00", "2026-10-14T10:00:00+08:00", /不在工作时间，挪到当天 10:00/],
    ["work", "2026-10-14 15:30", "2026-10-14T15:30:00+08:00", null],
    ["personal", "过两天", "2026-10-16T10:00:00+08:00", /它没给读得懂的下次时间，按 3 个工作日算/],
    ["personal", "2026-13-45 99:99", "2026-10-16T10:00:00+08:00", /读得懂/],
  ];
  for (const [domain, proposed, expected, said] of cases) {
    await withDesk(async (w) => {
      await tell(w, SAID, "年度体检", domain);
      comes(w, 1, 1, proposal({ nextLook: proposed }));
      await pass(w, 5);
      assert.equal(fact(w, 1, "next"), expected, `${domain} ${proposed}`);
      const clamp = log(w)[0]!.clamp;
      if (said) assert.match(clamp ?? "", said, `${domain} ${proposed}`);
      else assert.equal(clamp, null, `${domain} ${proposed}`);
    });
  }
});

test("at most two looks a day because the clock said so; the rest wait for tomorrow morning", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    // every look says "in an hour"
    for (let i = 0; i < 40; i++) {
      answerAll(w, proposal({ nextLook: "2026-10-13 10:00" }));
      await pass(w, 15, 5);
    }
    // first (10:00) + two asked by the clock = 3 starts; the fourth is a day later
    assert.equal(w.flows.launcher.started.length, 3, JSON.stringify(log(w).map((e) => [e.n, e.why])));
    assert.deepEqual(log(w).map((e) => e.why), ["first", "time", "time"]);
    assert.equal(fact(w, 1, "next"), "2026-10-14T10:00:00+08:00");
  }));

// ---- asking the person -----------------------------------------------------------------------------------------------

test("a question the look puts is a question on a card with the person's own ways out, and no more looks while it waits", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    comes(w, 1, 1, proposal({ question: "体检约上了吗？", options: ["已约上了", "还没约"] }));
    await pass(w, 5);
    const a = assessed(w, 1)!;
    assert.equal(a.stage, "asking");
    assert.deepEqual([a.next.actor, a.next.what], ["me", "等你定：体检约上了吗？"]);
    assert.match(a.headline, /^任务还没完成（等你定：体检约上了吗？）$/);
    const [c] = waiting(w);
    assert.equal(c!.key, "desk:D1:ask:1");
    assert.deepEqual([c!.owner, c!.domain, c!.nag.max, c!.nag.everyWorkdays, c!.ask.header, c!.ask.allowOther], ["owner", "personal", 2, 1, "年度体检（D1）", true]);
    assert.deepEqual(c!.ask.options.map((o) => [o.id, o.label]), [["p1", "已约上了"], ["p2", "还没约"], ["later3", "过 3 天再看"], ["drop", "不用盯了"]]);
    await pass(w, 5);
    assert.equal(w.cards.length, 1, "the person is asked, once");
    // the line under the question says when it was asked and when it is asked again, with the day of the week
    assert.match(w.engine.graph("desk:D1")!.hero.sub, /^你 · 已等 [^·]+ · 10-14 10:00 再问$/, "who has it, how long, and when it is asked again: three things, no sentence");
    // days go by: it is not looked at again for the clock's sake while the question is open
    await pass(w, 24 * 60 * 2, 60);
    assert.equal(w.flows.launcher.started.length, 1);
  }));

test("a question that is a fixed way out or words of their own: the look that follows is told what they said, and a question put lately is not put again", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    comes(w, 1, 1, proposal({ question: "体检约上了吗？", options: ["已约上了", "还没约"] }));
    await pass(w, 10);
    w.answer({ "年度体检（D1）": "还没约，打算下周一去约" });
    await pass(w, 5);
    assert.equal(w.flows.launcher.started.length, 2);
    const second = input(w, 1);
    assert.equal(second.why, "answer");
    assert.equal(second.askQuestion, "体检约上了吗？");
    assert.deepEqual(second.askOptions, ["已约上了", "还没约"]);
    assert.deepEqual(second.answers, [{ question: "体检约上了吗？", answer: "还没约，打算下周一去约", at: second.answers instanceof Array ? (second.answers[0] as { at: string }).at : "" }]);
    assert.match((second.answers as Array<{ at: string }>)[0]!.at, /^2026-10-13 周二 10:\d\d$/);
    // the look asks the same thing again, a little differently: one question in three days
    comes(w, 1, 2, proposal({ question: "体检约上了吗", options: ["已约上了"] }));
    await pass(w, 5);
    assert.equal(waiting(w).length, 0, "no second card");
    assert.equal(assessed(w, 1)!.stage, "watching");
    assert.match(log(w).at(-1)!.question ?? "", /3 天内问过同一个，没再问/);
  }));

test("'过 3 天再看' costs no look and 'next look' is three days on; '不用盯了' ends it with no look", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    comes(w, 1, 1, proposal({ question: "体检约上了吗？", options: ["已约上了", "还没约"] }));
    await pass(w, 10);
    w.answer({ "年度体检（D1）": "过 3 天再看" });
    await pass(w, 5);
    assert.equal(w.flows.launcher.started.length, 1, "no look for that answer");
    assert.equal(assessed(w, 1)!.stage, "watching");
    assert.equal(fact(w, 1, "next"), "2026-10-16T10:00:00+08:00");
    assert.equal(assessed(w, 1)!.next.what, "下次看 10-16 周五 10:00");
    await pass(w, 3 * 24 * 60, 60);
    assert.equal(w.flows.launcher.started.length, 2);
    assert.equal(input(w, 1).why, "time");

    comes(w, 1, 2, proposal({ question: "复查也要约吗？", options: ["要"] }));
    await pass(w, 10);
    assert.equal(waiting(w).length, 1);
    w.answer({ "年度体检（D1）": "不用盯了" });
    await pass(w, 5);
    const a = assessed(w, 1)!;
    assert.equal(a.stage, "dropped");
    assert.match(a.headline, /^不盯了（\d\d-\d\d 周[日一二三四五六] \d\d:\d\d 你说不用盯了）$/);
    assert.equal(waiting(w).length, 0);
    await pass(w, 5 * 24 * 60, 120);
    assert.equal(w.flows.launcher.started.length, 2, "and nothing more is ever started for it");
  }));

test("a line the person adds brings a look at once, with the line; one added while a look is going is looked at when that one is over", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    own(w, "约在下周三下午了");
    going(w, 1, 1);
    say(w, note("D1", "约在下周三下午了"));
    await pass(w, 5);
    assert.equal(w.flows.launcher.started.length, 1, "the first look has not come back: one at a time");
    comes(w, 1, 1, proposal());
    await pass(w, 5);
    await pass(w, 5);
    assert.equal(w.flows.launcher.started.length, 2);
    const second = input(w, 1);
    assert.equal(second.why, "note");
    assert.deepEqual((second.notes as Array<{ text: string }>).map((n) => n.text), ["约在下周三下午了"]);
    assert.match((second.notes as Array<{ at: string }>)[0]!.at, /^2026-10-13 周二 10:\d\d$/);
  }));

// ---- "it is done" ----------------------------------------------------------------------------------------------------

test("a look that sees it done is a question to the person, never the end by itself; yes ends it, no is not asked again for a while", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    comes(w, 1, 1, proposal({ finished: "yes", finishedWhy: "飞书任务已完成，备注约了 11-05", question: "要不要提醒你去？", options: ["要"] }));
    await pass(w, 10);
    const a = assessed(w, 1)!;
    assert.equal(a.stage, "closing");
    assert.deepEqual([a.next.actor, a.next.what], ["me", "等你确认结束"]);
    const [c] = waiting(w);
    assert.equal(c!.key, "desk:D1:done:1");
    assert.equal(c!.ask.question, "看起来办完了，结束吗？");
    assert.deepEqual(c!.ask.options.map((o) => o.id), ["yes", "no"]);
    assert.match(c!.brief, /依据：飞书任务已完成，备注约了 11-05/);
    assert.equal(commitmentsOf(w, 1).filter((x) => x.key.includes(":ask:")).length, 0, "no question beside it: it would ask the other thing again");
    w.answer({ "年度体检（D1）": "还没完" });
    await pass(w, 10);
    assert.equal(w.flows.launcher.started.length, 2, "an answer is a look");
    // it says done again at once: it was said no to, so it is not asked
    comes(w, 1, 2, proposal({ finished: "yes", finishedWhy: "还是那条任务" }));
    await pass(w, 10);
    assert.equal(waiting(w).length, 0);
    assert.equal(assessed(w, 1)!.stage, "watching");
  }));

test("yes to 'it is done': it is over", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    comes(w, 1, 1, proposal({ finished: "yes", finishedWhy: "飞书任务已完成" }));
    await pass(w, 10);
    w.answer({ "年度体检（D1）": "对，结束" });
    await pass(w, 5);
    const a = assessed(w, 1)!;
    assert.equal(a.stage, "done");
    assert.match(a.headline, /^办完了（\d\d-\d\d 周[日一二三四五六] \d\d:\d\d 你确认）$/);
    await pass(w, 3 * 24 * 60, 120);
    assert.equal(w.flows.launcher.started.length, 1);
  }));

// ---- what goes wrong -------------------------------------------------------------------------------------------------

test("a look that failed is the rule's to ask again, tomorrow: told as that, no button, and not in what the person has to do", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    w.flows.probes.set(idOf(1, 1), failedProbe());
    await pass(w, 5);
    const a = assessed(w, 1)!;
    // in words for a person: not the runtime's (OutputMismatch, what it says about the answer), which the log and the run's page keep
    assert.equal(a.headline, "这次没看成：交回来的格式不对；10-14 周三 10:00 再看");
    assert.doesNotMatch(JSON.stringify([a, w.engine.graph("desk:D1")!.hero, w.engine.graph("desk:D1")!.history]), /OutputMismatch|回答不合格式/);
    assert.match(w.engine.graph("desk:D1")!.history.map((h) => h.line + " " + (h.detail ?? "")).join(" | "), /看一眼出错了.* → 下次看 10-14 周三 10:00/);
    assert.deepEqual([a.next.actor, a.next.what], ["system", "下次看 10-14 周三 10:00"]);
    assert.equal(a.stage, "watching");
    assert.equal(fact(w, 1, "fails"), "1");
    const g = w.engine.graph("desk:D1")!;
    assert.equal(g.situation, "system", "the system is on it: not a failed run for the person to do something about");
    assert.equal(w.engine.status()!.cases.find((c) => c.caseId === "desk:D1")?.row?.group, "system", "and in the list it is not among what they have to do");
    const view = g.runs[0]!;
    assert.deepEqual([view.selfRetry, view.actions, view.retry], [true, [], null]);
    // pressing the button some other way is refused too
    const refused = w.engine.retryFlow(idOf(1, 1), "page");
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /自己重试/);
    assert.match(log(w)[0]!.looked, /^没看成：/);
    assert.match(w.engine.graph("desk:D1")!.runs[0]!.error?.plain ?? w.engine.graph("desk:D1")!.runs[0]!.why ?? "", /.+/, "the run's own page still has its words");
    // tomorrow: the next key, and a look that comes back clears it
    await pass(w, 24 * 60, 60);
    assert.equal(w.flows.launcher.started.length, 2);
    assert.equal(flowsOf(w)[idOf(1, 2)]!.key, "look-2");
    comes(w, 1, 2, proposal());
    await pass(w, 10);
    assert.equal(fact(w, 1, "fails"), "0");
    assert.doesNotMatch(assessed(w, 1)!.headline, /没看成/);
  }));

test("a look that ran out of time says so in words", async () => {
  for (const [probe, words] of [[finished(null, { outcome: "timeout" }, 0.1), "超时了"]] as const) {
    await withDesk(async (w) => {
      await tell(w, SAID, "年度体检");
      w.flows.probes.set(idOf(1, 1), probe);
      await pass(w, 5);
      assert.equal(assessed(w, 1)!.headline, `这次没看成：${words}；10-14 周三 10:00 再看`);
    });
  }
});

test("a look the day's limits keep back is said with the reason, and it starts when there is room", () =>
  withDesk(
    async (w) => {
      await tell(w, SAID, "年度体检");
      await tell(w, "还要盯着体检的预约", "体检预约");
      assert.equal(w.flows.launcher.started.length, 1);
      await pass(w, 5); // the rule reads where the run stands in the round after it was asked for
      assert.equal(assessed(w, 2)!.stage, "watching");
      assert.match(assessed(w, 2)!.headline, /^这次「看一眼」先没起：今天看的次数用完了，明天再看$/, "in the person's words: no flow name, no limit");
      assert.doesNotMatch(assessed(w, 2)!.headline, /item-glance|流程|上限/);
      assert.equal(assessed(w, 2)!.next.what, "明天自己再看");
      comes(w, 1, 1, proposal({ nextLook: "2026-10-20 10:00" }));
      await pass(w, 24 * 60, 60);
      assert.equal(w.flows.launcher.started.length, 2, "tomorrow's room");
      assert.equal(flowsOf(w)[idOf(2, 1)]!.key, "look-1");
    },
    { policy: POLICY({ "item-glance": { perDay: 1, usdPerDay: 3, perCasePerDay: 4, concurrent: 1 } }) },
  ));

test("the other flows' day does not take the looks' room, and the looks' does not take theirs (the general limits are narrow here)", () =>
  withDesk(
    async (w) => {
      await tell(w, SAID, "年度体检");
      assert.equal(w.flows.launcher.started.length, 1, "the general limits are 0 a day, and a look is not counted in them");
    },
    { policy: POLICY({ "item-glance": { perDay: 5, usdPerDay: 3 } }, { perDay: 0, usdPerDay: 0 }) },
  ));

test("'过 3 天再看' is three days on, not three workdays: a Thursday's answer is a Sunday's look for what has no working hours, and the Monday after for work", async () => {
  const later = async (domain: string) => {
    let next = "";
    await withDesk(
      async (w) => {
        await tell(w, SAID, "年度体检", domain);
        comes(w, 1, 1, proposal({ question: "体检约上了吗？", options: ["已约上了"] }));
        await pass(w, 10);
        w.answer({ "年度体检（D1）": "过 3 天再看" });
        await pass(w, 5);
        next = fact(w, 1, "next");
      },
      { start: "2026-10-15 10:00" }, // a Thursday
    );
    return next;
  };
  assert.equal(await later("personal"), "2026-10-18T10:00:00+08:00", "Sunday");
  assert.equal(await later("family"), "2026-10-18T10:00:00+08:00");
  assert.equal(await later("work"), "2026-10-19T10:00:00+08:00", "work is then put into a workday: the Monday");
});

// ---- the rules held: the line must not say a look is going on ------------------------------------------------------------

const HELD = { ...POLICY(), ruleBreakerChanges: 0 };
const editRule = (w: World, text: string) => writeFileSync(path.join(w.configDir, "rules", "desk.mjs"), text);

test("while the rules are held nothing is looked at, and the matter says so, with who has to do what; the receipt says so; letting them through starts the look", () =>
  withDesk(
    async (w) => {
      await w.engine.tick();
      // a change of the rule, and a matter told in the round it is read: that change is held, for it makes a look
      editRule(w, deskRule() + "\n// a word\n");
      await tell(w, SAID, "年度体检");
      const held = w.store.state.rules.held;
      assert.ok(held, "held");
      assert.equal(looksOf(w, 1).length, 0, "no look was started");
      assert.match(assessed(w, 1)!.headline, /^判断方法的改动停着，要在「事项追踪」页面顶上放行，才会开始「看一眼」$/);
      assert.deepEqual([assessed(w, 1)!.next.actor, assessed(w, 1)!.next.what], ["me", "放行判断方法的改动"]);
      assert.doesNotMatch(assessed(w, 1)!.headline, /正在看/);
      // another, told while they are held: the receipt does not promise a look in a minute, and the line is the same truth
      const second = await tell(w, "还要盯着续费", "续费", "personal");
      assert.match(second.text, /这里现在不会自己去看（判断方法的改动停着等放行/);
      assert.doesNotMatch(second.text, /一分钟左右/);
      assert.equal(assessed(w, 2)!.headline, assessed(w, 1)!.headline);
      await pass(w, 30);
      assert.equal(looksOf(w, 1).length + looksOf(w, 2).length, 0, "and still none half an hour on");
      assert.match(assessed(w, 1)!.headline, /^判断方法的改动停着/, "the line does not go back to saying it is looking");
      assert.equal(w.engine.releaseRules(held!.fingerprint), true);
      await pass(w, 5);
      assert.equal(looksOf(w, 1).length, 1, "let through, the first look starts");
      assert.equal(assessed(w, 1)!.headline, "正在看第一眼");
    },
    { policy: HELD },
  ));

// ---- the input of a look stays inside what the runtime takes ------------------------------------------------------------------

test("a look whose input would be over the runtime's 16 KB is still looked at: a long hint is cut first", () =>
  withDesk(
    async (w) => {
      await tell(w, SAID, "年度体检");
      assert.equal(w.flows.launcher.started.length, 1, "started, not 'judgment failed'");
      assert.notEqual(assessed(w, 1)!.stage, "error");
      const i = input(w, 0);
      assert.ok(Buffer.byteLength(JSON.stringify(i), "utf8") <= 14000);
      assert.equal((i.hint as string).length, 1500);
      assert.equal(i.said, SAID, "and what the person said is whole");
    },
    { params: { hints: { work: "", personal: "字".repeat(6000), family: "" } } },
  ));

test("a smaller budget leaves out the oldest of the earlier looks and lines first, and the newest stay", () =>
  withDesk(
    async (w) => {
      const long = (c: string) => c.repeat(100);
      await tell(w, SAID, "年度体检");
      for (let k = 1; k <= 3; k++) {
        comes(w, 1, k * 2 - 1, proposal({ status: long("状"), looked: long("看"), nextLook: "2026-10-30 12:00" }));
        await pass(w, 10);
        own(w, long(String(k)));
        say(w, note("D1", long(String(k))));
        await pass(w, 5);
        answerAll(w, proposal({ status: long("状"), looked: long("看"), nextLook: "2026-10-30 12:00" }));
        await pass(w, 10);
      }
      const last = input(w, w.flows.launcher.started.length - 1);
      assert.ok(Buffer.byteLength(JSON.stringify(last), "utf8") <= 2600, "inside the budget");
      const notes = last.notes as Array<{ text: string }>;
      assert.ok(notes.length >= 1 && notes.at(-1)!.text === long("3"), "the newest line is kept");
      assert.ok((last.log as unknown[]).length + notes.length < 8, "and something older was left out");
      assert.notEqual(assessed(w, 1)!.stage, "error");
    },
    { params: { inputBytes: 2600, hints: { work: "", personal: "", family: "" } } },
  ));

test("with a budget no history can fit in, only the words of the matter go: nothing before it, a short hint", () =>
  withDesk(
    async (w) => {
      await tell(w, SAID, "年度体检");
      const i = input(w, 0);
      assert.deepEqual([i.log, i.notes, i.answers], [[], [], []]);
      assert.equal(i.said, SAID);
      assert.equal((i.hint as string).length, 200);
    },
    { params: { inputBytes: 300, hints: { work: "", personal: "提".repeat(900), family: "" } } },
  ));

// ---- what the person reads ---------------------------------------------------------------------------------------------

test("the reasons a look does not start are told in words for a person: no flow name, no 'flow', no limit", async () => {
  const reason = async (limits: Record<string, unknown>) => {
    let line = "";
    let next = "";
    await withDesk(
      async (w) => {
        await tell(w, SAID, "年度体检");
        await tell(w, "还要盯着续费", "续费", "personal");
        await pass(w, 5);
        line = assessed(w, 2)!.headline;
        next = assessed(w, 2)!.next.what;
      },
      { policy: POLICY({ "item-glance": { perDay: 10, usdPerDay: 3, perCasePerDay: 4, concurrent: 5, ...limits }, }) },
    );
    return [line, next];
  };
  assert.deepEqual(await reason({ concurrent: 1 }), ["这次「看一眼」先没起：另一件事正在看，排在它后面", "排在后面，轮到了自己看"]);
  assert.deepEqual(await reason({ perDay: 1 }), ["这次「看一眼」先没起：今天看的次数用完了，明天再看", "明天自己再看"]);
  assert.deepEqual(await reason({ usdPerDay: 0.1 }), ["这次「看一眼」先没起：今天看一眼用的钱用完了，明天再看", "明天自己再看"]);
  for (const limits of [{ concurrent: 1 }, { perDay: 1 }, { usdPerDay: 0.1 }]) assert.doesNotMatch((await reason(limits))[0]!, /item-glance|流程|上限/);
});

test("the matter's page names the look as people do, and the end of each look says when the next one is; no flow name", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    const going = w.engine.graph("desk:D1")!;
    assert.equal(going.hero.line, "正在看第一眼", "what the rule says it is doing, not 'flow ... is running'");
    assert.doesNotMatch(going.hero.sub, /只算已经结束的调用/);
    assert.ok(going.history.some((h) => h.line === "起了「看一眼」"), "while it goes, one line says it began");
    comes(w, 1, 1, proposal({ nextLook: "2026-10-15 10:00" }));
    await pass(w, 10);
    const lines = w.engine.graph("desk:D1")!.history.map((h) => (h.detail ? h.line + " " + h.detail : h.line));
    assert.ok(lines.some((l) => /^看一眼好了（.+） 看了一眼：.* → 下次看 10-15 周四 10:00$/.test(l)), lines.join(" | "));
    assert.ok(!lines.some((l) => l === "起了「看一眼」"), "a look that has ended is one line, not a start and an end");
    assert.ok(!lines.join(" ").includes("item-glance") && !lines.join(" ").includes("流程「"));
  }));

// ---- what the rule does not do by itself --------------------------------------------------------------------------------

test("a matter with no owner to ask is still looked at, and a rule that is told nothing about where to read passes on an empty hint", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "年度体检");
    assert.equal(input(w, 0).hint, "");
    assert.equal(input(w, 0).workdir, "");
  }));

test("params: where a look runs and what it is told about where to read are by domain", () =>
  withDesk(
    async (w) => {
      await tell(w, SAID, "年度体检", "personal");
      await tell(w, "盯一下发版的排期", "发版排期", "work");
      assert.deepEqual([input(w, 0).workdir, input(w, 0).hint], ["/desk/personal", "读飞书任务"]);
      assert.deepEqual([looksOf(w, 2).length, w.flows.launcher.started.length], [0, 1], "the second waits for room: one at a time");
    },
    { params: { cwd: { work: "/desk/work", personal: "/desk/personal", family: "" }, hints: { work: "", personal: "读飞书任务", family: "" } } },
  ));

test("the rule file reads on its own: no ticket, no tracker, nothing it needs but its facts", () => {
  const rule = deskRule();
  assert.ok(!/ctx\.(item|siblings|observations|flag|naming)\(/.test(rule), "it asks the context for nothing outside the matter");
  assert.ok(!/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(rule), "no local path in the public example");
});
