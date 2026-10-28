import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { World } from "./helpers";
import { assessed, comes, commitmentsOf, deskRule, fact, going, idOf, item, looksOf, note, own, pass, POLICY, proposal, say, tell, track, undoLast, withDesk } from "./desk-kit";
import { failedProbe, finished, flowsOf } from "./flows-kit";

// The example rule for matters a person told (examples/desk.mjs), run by the real engine against a launcher that only records and
// looks the test says come back as they would: when it looks, what it keeps of what a look proposes, what it asks, what it never
// does by itself. 2026-10-13 is a Tuesday; the working hours of "work" are workdays 09:30-20:00, "personal" has none.

const SAID = "帮我盯一下洗牙，月底前要约上";
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
    await tell(w, SAID, "定期洗牙");
    assert.equal(w.flows.launcher.started.length, 1);
    assert.deepEqual(input(w, 0), { id: "D1", title: "定期洗牙", said: SAID, domain: "personal", n: 1, why: "first", now: "2026-10-13 周二 10:00", tz: "Asia/Shanghai", status: "", log: [], askQuestion: "", askOptions: [], askAt: "", answers: [], notes: [], hint: "", workdir: "" });
    const rec = flowsOf(w)[idOf(1, 1)]!;
    assert.deepEqual([rec.flow, rec.name, rec.key, rec.timeout, rec.maxUsd, rec.notify, rec.selfRetry, rec.label], ["item-glance", "look", "look-1", "20m", 0.5, false, true, "第 1 次看一眼"]);
    assert.equal(rec.affairLabel, "定期洗牙（D1）");
    assert.equal(assessed(w, 1)!.headline, "正在看第一眼");
    assert.equal(assessed(w, 1)!.next.what, "正在看");
    assert.equal(assessed(w, 1)!.next.actor, "system");
    assert.equal(fact(w, 1, "looks"), "1");
  }));

test("a look that is going is the same input in every round, however long it takes: not another look, not a changed request", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "定期洗牙");
    going(w, 1, 1);
    await pass(w, 120, 10);
    assert.equal(w.flows.launcher.started.length, 1);
    assert.equal(w.engine.graph("desk:D1")!.runs[0]!.inputDrifted ?? false, false, "what it reads at 10:00 and at 12:00 is the same");
    assert.equal(assessed(w, 1)!.headline, "正在看第一眼");
  }));

test("what a look came back with is kept, said as it is, and the next look is told with the day of the week", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "定期洗牙");
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
      await tell(w, SAID, "定期洗牙", domain);
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
    await tell(w, SAID, "定期洗牙");
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
    await tell(w, SAID, "定期洗牙");
    comes(w, 1, 1, proposal({ question: "洗牙约上了吗？", options: ["已约上了", "还没约"] }));
    await pass(w, 5);
    const a = assessed(w, 1)!;
    assert.equal(a.stage, "asking");
    assert.deepEqual([a.next.actor, a.next.what], ["me", "等你定：洗牙约上了吗？"]);
    assert.match(a.headline, /^任务还没完成（等你定：洗牙约上了吗？）$/);
    const [c] = waiting(w);
    assert.equal(c!.key, "desk:D1:ask:1");
    assert.deepEqual([c!.owner, c!.domain, c!.nag.max, c!.nag.everyWorkdays, c!.ask.header, c!.ask.allowOther], ["owner", "personal", 2, 1, "定期洗牙（D1）", true]);
    assert.deepEqual(c!.ask.options.map((o) => [o.id, o.label]), [["p1", "已约上了"], ["p2", "还没约"], ["later3", "过 3 天再看"], ["drop", "不用盯了"]]);
    await pass(w, 5);
    assert.equal(w.cards.length, 1, "the person is asked, once");
    // days go by: it is not looked at again for the clock's sake while the question is open
    await pass(w, 24 * 60 * 2, 60);
    assert.equal(w.flows.launcher.started.length, 1);
  }));

test("a question that is a fixed way out or words of their own: the look that follows is told what they said, and a question put lately is not put again", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "定期洗牙");
    comes(w, 1, 1, proposal({ question: "洗牙约上了吗？", options: ["已约上了", "还没约"] }));
    await pass(w, 10);
    w.answer({ "定期洗牙（D1）": "还没约，打算下周一去约" });
    await pass(w, 5);
    assert.equal(w.flows.launcher.started.length, 2);
    const second = input(w, 1);
    assert.equal(second.why, "answer");
    assert.equal(second.askQuestion, "洗牙约上了吗？");
    assert.deepEqual(second.askOptions, ["已约上了", "还没约"]);
    assert.deepEqual(second.answers, [{ question: "洗牙约上了吗？", answer: "还没约，打算下周一去约", at: second.answers instanceof Array ? (second.answers[0] as { at: string }).at : "" }]);
    assert.match((second.answers as Array<{ at: string }>)[0]!.at, /^2026-10-13 周二 10:\d\d$/);
    // the look asks the same thing again, a little differently: one question in three days
    comes(w, 1, 2, proposal({ question: "洗牙约上了吗", options: ["已约上了"] }));
    await pass(w, 5);
    assert.equal(waiting(w).length, 0, "no second card");
    assert.equal(assessed(w, 1)!.stage, "watching");
    assert.match(log(w).at(-1)!.question ?? "", /3 天内问过同一个，没再问/);
  }));

test("'过 3 天再看' costs no look and 'next look' is three workdays on; '不用盯了' ends it with no look", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "定期洗牙");
    comes(w, 1, 1, proposal({ question: "洗牙约上了吗？", options: ["已约上了", "还没约"] }));
    await pass(w, 10);
    w.answer({ "定期洗牙（D1）": "过 3 天再看" });
    await pass(w, 5);
    assert.equal(w.flows.launcher.started.length, 1, "no look for that answer");
    assert.equal(assessed(w, 1)!.stage, "watching");
    assert.equal(fact(w, 1, "next"), "2026-10-16T10:00:00+08:00");
    assert.equal(assessed(w, 1)!.next.what, "下次看 10-16 周五 10:00");
    await pass(w, 3 * 24 * 60, 60);
    assert.equal(w.flows.launcher.started.length, 2);
    assert.equal(input(w, 1).why, "time");

    comes(w, 1, 2, proposal({ question: "体检也要约吗？", options: ["要"] }));
    await pass(w, 10);
    assert.equal(waiting(w).length, 1);
    w.answer({ "定期洗牙（D1）": "不用盯了" });
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
    await tell(w, SAID, "定期洗牙");
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
    await tell(w, SAID, "定期洗牙");
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
    w.answer({ "定期洗牙（D1）": "还没完" });
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
    await tell(w, SAID, "定期洗牙");
    comes(w, 1, 1, proposal({ finished: "yes", finishedWhy: "飞书任务已完成" }));
    await pass(w, 10);
    w.answer({ "定期洗牙（D1）": "对，结束" });
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
    await tell(w, SAID, "定期洗牙");
    w.flows.probes.set(idOf(1, 1), failedProbe());
    await pass(w, 5);
    const a = assessed(w, 1)!;
    assert.match(a.headline, /^这次没看成：.+；10-14 周三 10:00 再看$/);
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
    assert.match(refused.detail, /会自己再起一次/);
    assert.match(log(w)[0]!.looked, /^没看成：/);
    // tomorrow: the next key, and a look that comes back clears it
    await pass(w, 24 * 60, 60);
    assert.equal(w.flows.launcher.started.length, 2);
    assert.equal(flowsOf(w)[idOf(1, 2)]!.key, "look-2");
    comes(w, 1, 2, proposal());
    await pass(w, 10);
    assert.equal(fact(w, 1, "fails"), "0");
    assert.doesNotMatch(assessed(w, 1)!.headline, /没看成/);
  }));

test("a look the day's limits keep back is said with the reason, and it starts when there is room", () =>
  withDesk(
    async (w) => {
      await tell(w, SAID, "定期洗牙");
      await tell(w, "还要盯着体检的预约", "体检预约");
      assert.equal(w.flows.launcher.started.length, 1);
      await pass(w, 5); // the rule reads where the run stands in the round after it was asked for
      assert.equal(assessed(w, 2)!.stage, "watching");
      assert.match(assessed(w, 2)!.headline, /^这次「看一眼」先没起：今天「item-glance」流程已经起了 1 次（上限 1）/);
      assert.equal(assessed(w, 2)!.next.what, "等有空位自己再看");
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
      await tell(w, SAID, "定期洗牙");
      assert.equal(w.flows.launcher.started.length, 1, "the general limits are 0 a day, and a look is not counted in them");
    },
    { policy: POLICY({ "item-glance": { perDay: 5, usdPerDay: 3 } }, { perDay: 0, usdPerDay: 0 }) },
  ));

// ---- what the rule does not do by itself --------------------------------------------------------------------------------

test("a matter with no owner to ask is still looked at, and a rule that is told nothing about where to read passes on an empty hint", () =>
  withDesk(async (w) => {
    await tell(w, SAID, "定期洗牙");
    assert.equal(input(w, 0).hint, "");
    assert.equal(input(w, 0).workdir, "");
  }));

test("params: where a look runs and what it is told about where to read are by domain", () =>
  withDesk(
    async (w) => {
      await tell(w, SAID, "定期洗牙", "personal");
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
