import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFacts, checkReport, upperLimit, verifyEvidence } from "../server/lib/check.mjs";
import { fold } from "../server/lib/log.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { iso } from "./kit";

const policy = DEFAULT_POLICY;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Line = Record<string, unknown>;
let seq = 0;
const line = (kind: string, fields: Line = {}, at = "2026-11-02T09:00:00+08:00"): Line => ({ seq: ++seq, at, kind, ...fields });

/** State folded from lines, then the facts the way the command works them out. */
function setup(now: string, lines: Line[] = []) {
  seq = 0;
  const all = [line("created", { id: "D1", title: "洗牙" }), ...lines];
  const state = fold(all.map((l, i) => ({ ...l, seq: i + 1 })) as never);
  const ms = iso(now);
  return { state, ms, facts: buildFacts(state, ms, policy) };
}

const base = { status: "还没约", entry: "还没约", next: { at: "2026-11-03 09:30", waitingFor: "等你去约", why: "他说今天最好搞定", earlyIf: [] as string[] } };
const run = (s: ReturnType<typeof setup>, report: Record<string, unknown>, attempt = 1) => checkReport({ report, state: s.state, facts: s.facts, policy, now: s.ms, attempt }) as { problems: Array<{ field: string; text: string }>; verdict: string; atMs: number | null; detail: string; limitMs: number };
const withNext = (over: Record<string, unknown>) => ({ ...base, next: { ...base.next, ...over } });

test("R1: the time is read in the zone and is in the future", () => {
  const s = setup("2026-11-02 10:00");
  assert.equal(run(s, withNext({ at: "明天" })).verdict, "rejected");
  assert.equal(run(s, withNext({ at: "2026-11-02 09:00" })).verdict, "rejected");
  assert.equal(run(s, withNext({ at: "2026-11-02 12:00" })).verdict, "pass");
});

test("R2: waiting-for, the reason and early-if must be there, and not a filler", () => {
  const s = setup("2026-11-02 10:00");
  for (const next of [withNext({ waitingFor: "" }), withNext({ why: "再看看" }), withNext({ why: "常规检查" }), withNext({ waitingFor: "等一个特别特别长的东西啊啊啊" }), { ...base, next: { at: base.next.at, waitingFor: "等你去约", why: "他说的" } }]) {
    const r = run(s, next);
    assert.equal(r.verdict, "rejected");
    assert.ok(r.problems.some((p) => p.field === "next"));
  }
});

test("R3: not sooner than the shortest gap, and the message says what to do instead", () => {
  const s = setup("2026-11-02 10:00");
  const r = run(s, withNext({ at: "2026-11-02 10:05" }));
  assert.equal(r.verdict, "rejected");
  assert.match(r.problems[0].text, /最早 10:30.*earlyIf/);
  assert.equal(run(s, withNext({ at: "2026-11-02 10:30" })).verdict, "pass");
  assert.equal(run(s, withNext({ at: "2026-11-02 10:29" })).verdict, "rejected", "one minute short is out");
});

test("R4: three timed looks in a row, close together and without change, may not be followed by another close one", () => {
  const wakes = [0, 1, 2].map((i) => line("wake", { why: ["time"], gapMinutes: 45 }, `2026-11-02T0${6 + i}:00:00+08:00`));
  const reports = wakes.map((_, i) => line("report", { verdict: "pass", status: "x", changed: false }, `2026-11-02T0${6 + i}:05:00+08:00`));
  const s = setup("2026-11-02 10:00", [wakes[0], reports[0], wakes[1], reports[1], wakes[2], reports[2]]);
  assert.match(run(s, withNext({ at: "2026-11-02 11:00" })).problems[0].text, /前 3 次/);
  assert.equal(run(s, withNext({ at: "2026-11-02 12:30" })).verdict, "pass");
  const changed = setup("2026-11-02 10:00", [wakes[0], reports[0], wakes[1], line("report", { verdict: "pass", status: "x", changed: true }), wakes[2], reports[2]]);
  assert.equal(run(changed, withNext({ at: "2026-11-02 11:00" })).verdict, "pass");
});

test("R5: the soft limit is 14 days; the limit before a deadline keeps a margin of a fifth, between an hour and a day", () => {
  const s = setup("2026-11-02 10:00");
  assert.equal(upperLimit(s.facts, s.ms, policy.check).limit, s.ms + 14 * DAY);
  assert.equal(run(s, withNext({ at: "2026-11-16 09:00" })).verdict, "pass");
  assert.equal(run(s, withNext({ at: "2026-11-17 09:00" })).verdict, "rejected");
  const d = setup("2026-11-02 10:00", [line("deadline", { deadline: "2026-11-03T18:00:00+08:00", from: "link:gcp:#1/字段", quote: "11-03" })]);
  assert.equal(upperLimit(d.facts, d.ms, policy.check).limit, iso("2026-11-03 11:36"));
  const close = setup("2026-11-02 17:00", [line("deadline", { deadline: "2026-11-02T18:00:00+08:00", from: "link:gcp:#1/字段", quote: "今天" })]);
  assert.ok(upperLimit(close.facts, close.ms, policy.check).limit >= close.ms + 30 * 60_000, "never earlier than the shortest gap");
});

test("R6: a quote counts only when it is found word for word in an allowed source", () => {
  const s = setup("2026-11-02 10:00", [line("said", { text: "这张等明年三月再说。", by: "user" }), line("said", { text: "我编的", by: "look" })]);
  assert.equal(verifyEvidence({ quote: "明年三月再说", from: "said:2" }, s.facts), null);
  assert.match(verifyEvidence({ quote: "明年三月再说", from: "said:3" }, s.facts)!, /找不到/);
  assert.match(verifyEvidence({ quote: "11-30 前要上线", from: "progress" }, s.facts)!, /不认/);
  assert.match(verifyEvidence({ quote: "x", from: "said:2" }, s.facts)!, /太短/);
  const undone = setup("2026-11-02 10:00", [line("said", { text: "明年三月再说", by: "user" }), line("undo", { target: 2 })]);
  assert.match(verifyEvidence({ quote: "明年三月再说", from: "said:2" }, undone.facts)!, /找不到/, "a taken-back word is not a source");
});

test("R7: one year at the most, appeal or not", () => {
  const s = setup("2026-11-02 10:00");
  const r = run(s, { ...withNext({ at: "2027-12-01 09:00", appeal: "我觉得对" }) }, 2);
  assert.equal(r.verdict, "rejected");
  assert.ok(r.problems.some((p) => /最远一年/.test(p.text)));
});

test("R8: a deadline that has passed is not a limit, and shows as maybe stale", () => {
  const s = setup("2026-11-02 10:00", [line("deadline", { deadline: "2026-10-16T17:00:00+08:00", from: "link:ticket:#700/截止日期", quote: "2026-10-16" })]);
  assert.equal(run(s, withNext({ at: "2026-11-10 09:00" })).verdict, "pass");
  assert.equal(s.facts.deadlines[0].past, true);
});

test("case 1: due tomorrow, wants next month: sent back; fixed: through; quoting the person: asks them", () => {
  const dl = line("deadline", { deadline: "2026-11-03T18:00:00+08:00", from: "link:feishu:t1/截止", quote: "11-03" });
  const s = setup("2026-11-02 10:00", [dl]);
  const far = run(s, withNext({ at: "2026-12-02 09:00" }));
  assert.equal(far.verdict, "rejected");
  assert.match(far.problems[0].text, /L 是 2026-11-03 11:36.*link:feishu:t1\/截止/);
  assert.equal(run(s, withNext({ at: "2026-11-03 10:00" })).verdict, "pass");
  const said = setup("2026-11-02 10:00", [dl, line("said", { text: "洗牙改到下个月了", by: "user" })]);
  const quoted = run(said, withNext({ at: "2026-12-02 09:00", evidence: [{ quote: "洗牙改到下个月了", from: "said:3" }] }));
  assert.equal(quoted.verdict, "ask");
  assert.equal(quoted.limitMs, iso("2026-11-03 11:36"), "until they answer, it is looked at by the limit");
});

test("case 2: every five minutes is sent back, and three quiet half hours are sent back again", () => {
  const s = setup("2026-11-02 10:00");
  assert.match(run(s, withNext({ at: "2026-11-02 10:05" })).problems[0].text, /earlyIf/);
  const wakes = [0, 1, 2].flatMap((i) => [line("wake", { why: ["time"], gapMinutes: 30 }), line("report", { verdict: "pass", changed: false, status: "x" })]);
  const quiet = setup("2026-11-02 10:00", wakes);
  assert.match(run(quiet, withNext({ at: "2026-11-02 10:35" })).problems[0].text, /前 3 次/);
});

test("case 3: a deadline the session made up is not one; the 14 days stand", () => {
  const s = setup("2026-11-02 10:00");
  const r = run(s, withNext({ at: "2026-11-30 09:00", evidence: [{ quote: "11-30 前要上线", from: "progress" }] }));
  assert.equal(r.verdict, "rejected");
  assert.ok(r.problems.some((p) => /不认/.test(p.text)));
});

test("case 4: said elsewhere, quote cannot be found: sent back twice, the third time the appeal goes through, and is told", () => {
  const s = setup("2026-11-02 10:00");
  const wants = withNext({ at: "2027-03-01 09:00", evidence: [{ quote: "等明年三月再说", from: "said:1" }], appeal: "他在群里说过等明年三月" });
  assert.equal(run(s, wants, 1).verdict, "rejected");
  const appeal = { ...withNext({ at: "2027-03-01 09:00", appeal: "他在群里说过等明年三月" }) };
  assert.equal(run(s, appeal, 1).verdict, "rejected", "an appeal on the first try is not looked at");
  const second = run(s, appeal, 2);
  assert.equal(second.verdict, "appeal");
  assert.equal(second.atMs, iso("2027-03-01 09:00"));
  const used = setup("2026-11-02 10:00", [line("next", { next: "2027-03-01T09:00:00+08:00", verdict: "appeal" }, "2026-10-30T09:00:00+08:00")]);
  assert.equal(run(used, appeal, 2).verdict, "ask", "a second appeal inside seven days becomes a question");
});

test("the 洗牙 of 10-29: due today 23:59, wants the next morning, quoting the answer: taken, with the reason written down", () => {
  const s = setup("2026-10-29 18:58", [
    line("deadline", { deadline: "2026-10-29T23:59:00+08:00", from: "said:1", quote: "今天" }),
    line("said", { text: "今天最好要搞定", by: "user" }),
    line("asked", { id: "D1-1", title: "洗牙约上了吗？" }),
    line("answered", { id: "D1-1", answer: "还没约" }),
  ]);
  const first = run(s, withNext({ at: "2026-10-30 09:30" }));
  assert.equal(first.verdict, "rejected");
  const second = run(s, withNext({ at: "2026-10-30 09:30", evidence: [{ quote: "还没约", from: "answer:D1-1" }] }), 2);
  assert.equal(second.verdict, "recorded");
  assert.match(second.detail, /比截止晚 10 小时/);
});

test("a deadline passed once with a recorded exception is asked about the next time", () => {
  const dl = line("deadline", { deadline: "2026-11-03T18:00:00+08:00", from: "link:x/截止", quote: "11-03" });
  const s = setup("2026-11-02 10:00", [dl, line("said", { text: "洗牙推迟了一点", by: "user" }), line("next", { next: "2026-11-03T20:00:00+08:00", verdict: "recorded", deadlineKey: "link:x/截止@2026-11-03T18:00:00+08:00" })]);
  const again = run(s, withNext({ at: "2026-11-03 17:00", evidence: [{ quote: "洗牙推迟了一点", from: "said:3" }] }));
  assert.equal(again.verdict, "ask");
});

test("three tries that do not pass fall back to the limit (or a workday, whichever is sooner), never under the shortest gap", () => {
  const s = setup("2026-11-06 10:00"); // a Friday
  const r = run(s, withNext({ at: "2026-11-06 10:01" }), 3);
  assert.equal(r.verdict, "fallback");
  assert.equal(r.atMs, iso("2026-11-09 10:00"), "the next workday skips the weekend");
  const near = setup("2026-11-02 17:50", [line("deadline", { deadline: "2026-11-02T18:00:00+08:00", from: "link:x/y", quote: "今天" })]);
  assert.ok((run(near, withNext({ at: "2026-11-02 17:51" }), 3).atMs as number) >= near.ms + 30 * 60_000);
});

test("report fields: status length, banned words, finish evidence", () => {
  const s = setup("2026-11-02 10:00", [line("said", { text: "洗牙约好了，周三", by: "user" })]);
  assert.ok(run(s, { ...base, status: "x".repeat(41) }).problems.some((p) => p.field === "status"));
  assert.ok(run(s, { ...base, entry: "计划里没有读数" }).problems.some((p) => p.field === "entry"));
  assert.equal(run(s, { entry: "办完了", finish: { kind: "done", evidence: { quote: "洗牙约好了，周三", from: "said:2" } } }).verdict, "pass");
  assert.equal(run(s, { entry: "办完了", finish: { kind: "done", evidence: { quote: "已经勾掉", from: "said:2" } } }).verdict, "rejected");
});
