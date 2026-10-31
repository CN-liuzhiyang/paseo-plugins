import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { layoutOf, stripOf } from "../shared/graph";
import { issue, makeWorld, type World } from "./helpers";

// The page of one item and the list's rows, through the engine: a rule with stages that carry
// metadata (a detour, an end that is not finishing) judging made-up items whose fields the test moves.

import { FLOW, rowOf, set, view, withFlow } from "./item-flow";

test("the stays of an item: each stage in order, when it was seen and when it happened, how long, and the current one", () =>
  withFlow(async (w) => {
    set(w, 1, { Phase: "draft" });
    await w.run("2026-10-13 10:30");
    set(w, 1, { Phase: "review" });
    await w.run("2026-10-13 12:00");
    set(w, 1, { Phase: "ship", Since: "2026-10-13T11:50:00+08:00" });
    await w.run("2026-10-13 14:00");
    const v = view(w, 1);
    assert.deepEqual(v.visits.map((s) => [s.stage, s.cur, s.cause]), [["draft", false, null], ["review", false, "data"], ["ship", true, "data"]]);
    const [draft, review, ship] = v.visits;
    assert.equal(v.trackingSince, draft!.observedAt, "tracking began with the first judgment");
    assert.equal(draft!.before, true, "the first stay began before anyone was looking: its start is when it was first seen");
    assert.equal(review!.before, false);
    assert.equal(ship!.fromKind, "happened", "the rule said when: that time, not the time it was checked");
    assert.equal(ship!.from, "2026-10-13T11:50:00+08:00");
    assert.ok(Date.parse(ship!.observedAt!) > Date.parse(ship!.from!), "and the time it was seen stays beside it");
    assert.equal(review!.to, ship!.from, "a stay ends where the next one begins");
    assert.equal(review!.durationMs, Date.parse(ship!.from!) - Date.parse(review!.from!));
    assert.equal(ship!.durationMs, Date.parse(v.now) - Date.parse(ship!.from!), "the current stay runs up to now");
    assert.deepEqual(v.deviations, []);
    assert.equal(v.current.stage, "ship");
    assert.equal(v.current.sinceKind, "happened");
    assert.deepEqual(v.history.map((h) => h.kind), ["stage", "stage", "stage"]);
    // the list's row tells the same
    const row = rowOf(w, 1);
    assert.deepEqual([row.group, row.situation, row.stageLabel], ["them", "them", "上线"]);
    assert.deepEqual(row.strip, ["done", "done", "cur", "todo"]);
    assert.equal(row.waiting.since, "2026-10-13T11:50:00+08:00");
    assert.equal(row.waiting.ms, Date.parse(v.now) - Date.parse("2026-10-13T11:50:00+08:00"));
  }));

test("an item first seen far along gets the stages before it as inferred ones, marked as such and with no times", () =>
  withFlow(async (w) => {
    set(w, 2, { Phase: "ship" });
    await w.run("2026-10-13 10:30");
    const v = view(w, 2);
    assert.deepEqual(v.visits.map((s) => [s.stage, s.inferred, s.before, s.fromKind, s.from]), [
      ["draft", true, true, "unknown", null],
      ["review", true, true, "unknown", null],
      ["ship", false, true, "observed", v.visits[2]!.from],
    ]);
    assert.equal(v.visits[0]!.durationMs, null, "how long it stayed in a stage nobody saw is not guessed");
    assert.deepEqual(rowOf(w, 2).strip, ["pre", "pre", "cur", "todo"]);
    assert.deepEqual(v.deviations, [], "nothing was skipped: it was already past them when tracking began");
  }));

test("a detour is drawn under the line and counted as a detour, not as a stage of the route", () =>
  withFlow(async (w) => {
    set(w, 3, { Phase: "review" });
    await w.run("2026-10-13 10:30");
    set(w, 3, { Phase: "rework" });
    await w.run("2026-10-13 11:30");
    set(w, 3, { Phase: "ship" });
    await w.run("2026-10-13 12:30");
    const v = view(w, 3);
    assert.deepEqual(v.visits.filter((s) => !s.inferred).map((s) => s.stage), ["review", "rework", "ship"]);
    assert.deepEqual(v.deviations.map((d) => [d.from, d.to, d.kind, d.why]), [["review", "rework", "off-graph", "评审打回时"]]);
    const pieces = layoutOf(v.visits, v.graph.stages);
    assert.deepEqual(pieces.map((p) => p.k), ["stage", "stage", "dip", "stage", "endghost"], "draft (inferred), review, the detour, ship, and only the end is left");
    const { cells, side } = stripOf(v.visits, v.graph.stages);
    assert.deepEqual(cells, ["pre", "done", "cur", "todo"]);
    assert.deepEqual(side, { after: 1, label: "返工" });
    assert.deepEqual(rowOf(w, 3).side, { after: 1, label: "返工" });
    assert.deepEqual(v.graph.normal, ["draft", "review", "ship", "finished"], "the route does not include the detour");
  }));

test("a stage the route went past without stopping is a skip, with the reason; going back is told as a way back and the stage's second visit is round 2", () =>
  withFlow(async (w) => {
    set(w, 4, { Phase: "draft" });
    await w.run("2026-10-13 10:30");
    set(w, 4, { Phase: "ship", Since: "2026-10-13T10:10:00+08:00" });
    await w.run("2026-10-13 12:00");
    set(w, 4, { Phase: "review", Since: "" });
    await w.run("2026-10-13 13:00");
    const v = view(w, 4);
    const ship = v.visits.find((s) => s.stage === "ship")!;
    assert.deepEqual(ship.skipped.map((s) => s.stage), ["review"]);
    assert.match(ship.skipped[0]!.why, /就到了后面|已经在后面/);
    assert.deepEqual(v.deviations.map((d) => [d.from, d.to, d.kind]), [["draft", "ship", "skip"], ["ship", "review", "back"]]);
    const second = v.visits[v.visits.length - 1]!;
    assert.deepEqual([second.stage, second.round, second.cur], ["review", 1, true], "review was never stayed in before: its first stay");
  }));

test("an end that is not finishing is the dropped situation and owes nothing of the route; a finishing end is done, with the time it took", () =>
  withFlow(async (w) => {
    set(w, 5, { Phase: "dropped", Ball: "nobody" });
    set(w, 6, { Phase: "review" });
    await w.run("2026-10-13 10:30");
    set(w, 6, { Phase: "ship" });
    await w.run("2026-10-13 11:30");
    set(w, 6, { Phase: "finished", Health: "done" });
    await w.run("2026-10-13 12:30");
    assert.deepEqual([rowOf(w, 5).situation, rowOf(w, 5).group], ["dropped", "done"]);
    const six = rowOf(w, 6);
    assert.deepEqual([six.situation, six.group, six.waiting.ended], ["done", "done", true]);
    assert.ok(six.waiting.ms! > 0, "how long it took, not how long it waits");
    const pieces = layoutOf(view(w, 6).visits, view(w, 6).graph.stages);
    assert.equal(pieces[pieces.length - 1]!.k, "end");
    assert.deepEqual(six.next, [], "nothing more is going to happen");
  }));

test("the list groups by who has to act: a question waiting, someone else, the system, you yourself, a broken check, a stuck item, a finished one", () =>
  withFlow(async (w) => {
    set(w, 11, { Ask: "2026-10-13" });
    set(w, 12, { Ball: "them" });
    set(w, 13, { Ball: "system" });
    set(w, 14, { Ball: "me" });
    set(w, 15, { Boom: "1" });
    set(w, 16, { Health: "blocked" });
    set(w, 17, { Phase: "finished", Health: "done" });
    await w.run("2026-10-13 10:30");
    const by = Object.fromEntries([11, 12, 13, 14, 15, 16, 17].map((n) => [n, [rowOf(w, n).group, rowOf(w, n).situation]]));
    assert.deepEqual(by, {
      11: ["me", "me"],
      12: ["them", "them"],
      13: ["system", "system"],
      14: ["mine", "mine"],
      15: ["errors", "error"],
      16: ["me", "stuck"],
      17: ["done", "done"],
    });
    assert.equal(rowOf(w, 11).asking, 1);
    assert.deepEqual(rowOf(w, 11).who, { actor: "me", label: "你 · 回答：H11" });
    assert.match(rowOf(w, 15).headline, /rule failed/, "an error is told as the error");
  }));

test("a word of the person's puts an item where it belongs: not following it any more is the dropped situation", () =>
  withFlow(async (w) => {
    set(w, 21, { Ball: "them" });
    await w.run("2026-10-13 10:30");
    assert.equal(rowOf(w, 21).situation, "them");
    // How a request becomes an annotation is said.test.ts's business; the page only needs one in force.
    w.store.append([{ type: "annotation.added", annotation: { id: "an_x", caseId: "gcp-demo:21", kind: "drop", said: "不用追了", by: "owner", via: null, how: "own-words", at: new Date(w.clock.now).toISOString(), until: null, person: null, what: null, expected: null, revoked: null } }] as never);
    await w.run("2026-10-13 10:45");
    assert.equal(rowOf(w, 21).situation, "dropped");
    assert.equal(view(w, 21).said.length, 1);
  }));

test("when the rules change the judgment of an item without its data changing, the earlier stay is not drawn as a step the item took", () =>
  withFlow(async (w) => {
    set(w, 31, { Phase: "review" });
    await w.run("2026-10-13 10:30");
    const file = path.join(w.configDir, "rules", "flow.mjs");
    writeFileSync(file, readFileSync(file, "utf8").replace('const stage = f.Phase || "draft";', 'const stage = f.Phase === "review" ? "ship" : (f.Phase || "draft");'));
    await w.run("2026-10-13 11:30");
    const v = view(w, 31);
    const real = v.visits.filter((s) => !s.inferred);
    assert.deepEqual(real.map((s) => [s.stage, s.superseded, s.cause]), [["review", true, null], ["ship", false, "rules-changed"]]);
    const drawn = layoutOf(v.visits, v.graph.stages).flatMap((p) => (p.k === "stage" ? [[p.v.stage, p.v.inferred]] : []));
    assert.deepEqual(drawn, [["draft", true], ["review", true], ["ship", false]], "the review it was judged to be in is not drawn as a stay; the route up to ship is what is inferred");
    assert.ok(v.history.some((h) => h.kind === "rules"), "the history says the judgment changed with the rules");
    assert.deepEqual(rowOf(w, 31).strip, ["pre", "pre", "cur", "todo"]);
    // whose move it is was seen anew with the stage: from the change, and a floor
    const wait = rowOf(w, 31).waiting;
    assert.deepEqual([wait.since, wait.atLeast, wait.rulesAt], [real[1]!.from, true, real[1]!.from]);
  }));

test("the wait is counted from when the holder got the ball: a change in what it is doing does not start it again, a change of holder does", () =>
  withFlow(async (w) => {
    set(w, 61, { Ball: "them", What: "等评审" });
    await w.run("2026-10-13 10:30");
    const since = rowOf(w, 61).waiting.since!;
    set(w, 61, { What: "等回复" });
    await w.run("2026-10-13 12:00");
    assert.equal(rowOf(w, 61).waiting.since, since, "still the same one holding the ball");
    assert.deepEqual(view(w, 61).visits.find((v) => v.cur)!.balls.map((b) => b.what), ["等评审", "等回复"], "what it was doing is kept in the stay");
    set(w, 61, { Ball: "system", What: "等开关" });
    await w.run("2026-10-13 13:00");
    assert.ok(Date.parse(rowOf(w, 61).waiting.since!) > Date.parse(since), "a new holder, a new wait");
  }));

test("a rule written the old way (stage ids as plain strings, no metadata, no `since`) gets a page too, with step numbers where the names are not, and the ids only in the evidence layer", () =>
  withFlow(
    async (w) => {
      set(w, 41, {});
      await w.run("2026-10-13 10:30");
      const v = view(w, 41);
      // a rule with no end of its own gets one for "not following it any more", so that a word of the person's has somewhere to go
      assert.deepEqual(v.graph.stages.map((s) => [s.id, s.label, s.side, s.end]), [["one", "第 1 步", false, false], ["two", "第 2 步", false, false], ["dropped", "不盯了", false, true]]);
      assert.equal(rowOf(w, 41).stageLabel, "第 1 步", "the list says the same, not the id");
      assert.equal(v.current.stageLabel, "第 1 步");
      assert.match(v.graph.stages[0]!.label, /第 1 步/);
      assert.deepEqual(v.evidence.stages.filter((s) => !s.named).map((s) => [s.id, s.label]), [["one", "第 1 步"], ["two", "第 2 步"]], "where the ids are");
      // what is for the page to show: the stage ids the data carries for logic (visits, current) are not text
      const shown = JSON.stringify({ ...v, evidence: null, graph: null, current: { ...v.current, stage: "" }, visits: v.visits.map((x) => ({ ...x, stage: "" })) });
      assert.ok(!/\bone\b|\btwo\b/.test(shown), "no id of a stage anywhere else on the page");
      assert.deepEqual(v.visits.map((s) => [s.stage, s.cur, s.fromKind]), [["one", true, "observed"]]);
      assert.deepEqual(rowOf(w, 41).strip, ["cur", "todo"]);
      assert.deepEqual(v.graph.normal, ["one", "two"]);
    },
    `export default { name: "old", description: "x", applies: { source: "gcp-demo" }, params: {}, stages: ["one", "two"],
      assess() { return { stage: "one", health: "on-track", headline: "h", next: { actor: "them", what: "w" }, facts: [], commitments: [] }; } };`,
  ));

test("a stage the rule no longer declares (the rule changed after the item was judged) is shown as a stage off the route, not dropped or crashed on", () =>
  withFlow(
    async (w) => {
      set(w, 51, { Phase: "legacy" });
      await w.run("2026-10-13 10:30");
      assert.equal(view(w, 51).current.stage, "legacy");
      const file = path.join(w.configDir, "rules", "flow.mjs");
      writeFileSync(file, readFileSync(file, "utf8").replace('{ id: "legacy", label: "旧阶段", side: true }, ', ""));
      await w.run("2026-10-13 11:30");
      const v = view(w, 51);
      assert.ok(v.visits.some((s) => s.stage === "legacy"), "the stay in it is still on the page");
      assert.deepEqual(v.graph.stages.filter((s) => s.id === "legacy").map((s) => [s.label, s.side, s.when]), [["已经没有的一步", true, "规则里已经没有这一步"]], "a stage the rule lost has no name to show, and its id is not shown instead");
      assert.equal(rowOf(w, 51).group, "errors", "and the rule now fails the item, which is what the list says");
    },
    FLOW.replace('{ id: "rework"', '{ id: "legacy", label: "旧阶段", side: true }, { id: "rework"'),
  ));

test("an item no rule has judged has a page that says so, and a key that is not an item has none", () =>
  withFlow(async (w) => {
    await w.run("2026-10-13 10:30");
    assert.equal(w.engine.graph("gcp-demo:999"), null);
    assert.equal(w.engine.graph("nonsense"), null);
  }));

// ---- what is next, and since when -------------------------------------------------------------------

/** FLOW, its question asked at a time of the day the item says (`AskAt`). */
const TIMED = FLOW.replace('trigger: { at: ctx.at(f.Ask, "10:00") }', 'trigger: { at: ctx.at(f.Ask, f.AskAt || "10:00") }');
const PERSON = { name: "测试用户", admin: true, tz: "Asia/Shanghai", quiet: { work: "workdays 09:30-20:00" } };
const lineOf = (w: World, id: number) => view(w, id).schedule.find((s) => s.line.startsWith("问你"))!;

test("what is next is when it will really be asked: past the quiet hours, after the day's pushes, as the asking decides", async () => {
  const w = await makeWorld({ start: "2026-10-13 10:00", config: { rules: { "flow.mjs": TIMED }, persons: { owner: { ...PERSON, pushPerDay: 1 } } } });
  try {
    set(w, 41, { Ask: "2026-10-13", AskAt: "10:00" }); // asked at once: the day's one push
    set(w, 42, { Ask: "2026-10-13", AskAt: "15:00" }); // due today, after it
    set(w, 43, { Ask: "2026-10-17" }); // due on a Saturday
    await w.run("2026-10-13 10:30");
    assert.equal(w.cards.length, 1);
    assert.deepEqual([lineOf(w, 42).at!.slice(0, 16), lineOf(w, 42).line], ["2026-10-14T09:30", "问你：q gcp-demo:42（那天的推送用完了）"]);
    assert.deepEqual([lineOf(w, 43).at!.slice(0, 16), lineOf(w, 43).line], ["2026-10-19T09:30", "问你：q gcp-demo:43（不打扰时段过了才问）"]);
    // and once its time has passed, the page says when it goes, not when it was due
    await w.run("2026-10-13 16:00");
    assert.equal(w.cards.length, 1, "not asked at its time");
    assert.deepEqual([lineOf(w, 42).at!.slice(0, 16), lineOf(w, 42).line], ["2026-10-14T09:30", "问你：q gcp-demo:42（10-13 15:00 就该问了，那天的推送用完了）"]);
    await w.run("2026-10-14 09:45");
    assert.equal(w.cards.length, 2, "asked when the page said");
    assert.ok(w.cards[1]!.content.questions.some((q) => q.question === "q gcp-demo:42?"), "with the one still unanswered");
  } finally {
    w.close();
  }
});

test("a question due in quiet hours is told at the window's opening, and the page says it was due earlier", async () => {
  const w = await makeWorld({ start: "2026-10-13 21:00", config: { rules: { "flow.mjs": TIMED }, persons: { owner: { ...PERSON, pushPerDay: 8 } } } });
  try {
    set(w, 44, { Ask: "2026-10-13", AskAt: "20:30" });
    await w.run("2026-10-13 21:30");
    assert.equal(w.cards.length, 0);
    assert.deepEqual([lineOf(w, 44).at!.slice(0, 16), lineOf(w, 44).line], ["2026-10-14T09:30", "问你：q gcp-demo:44（10-13 20:30 就该问了，不打扰时段过了才问）"]);
  } finally {
    w.close();
  }
});

/** FLOW, the rules changed: what was the system's move is the owner's, and the rule may say since when (`BallSince`). */
const toMe = (w: World) => {
  const file = path.join(w.configDir, "rules", "flow.mjs");
  writeFileSync(file, readFileSync(file, "utf8").replace('next: { actor: f.Ball || "them", what: f.What || "等" }', 'next: { actor: f.Ball === "system" ? "me" : (f.Ball || "them"), what: f.What || "等", ...(f.BallSince ? { since: f.BallSince } : {}) }'));
};

test("a wait the rules changed hands is counted from the rule's evidence, or, with none, from the change and said to be a floor", () =>
  withFlow(async (w) => {
    set(w, 71, { Ball: "system" }); // nothing says when: from the change, at least
    set(w, 72, { Ball: "system", BallSince: "2026-10-13T10:20:00+08:00" }); // the rule says when
    set(w, 73, { Ball: "system", BallSince: "2026-10-13T09:00:00+08:00" }); // before the system's turn began: not believed
    set(w, 74, { Ball: "system" }); // the data moves it
    set(w, 77, { Ball: "system", BallSince: "2026-10-13T13:00:00+08:00" }); // later than it was judged: not evidence
    set(w, 78, { Ball: "system", What: "等 a" }); // what the system waited on changes before the rule says it was the owner's
    await w.run("2026-10-13 10:30");
    set(w, 78, { What: "等 b", BallSince: "2026-10-13T10:10:00+08:00" });
    set(w, 74, { Ball: "me" });
    set(w, 71, { Other: "x" }); // data read meanwhile that changes nothing of the judgment: still the rules handed it over
    await w.run("2026-10-13 11:00");
    const byData = rowOf(w, 74).waiting.since;
    toMe(w);
    await w.run("2026-10-13 12:00");
    const changed = view(w, 71).current.ball.rulesAt!;
    assert.ok(changed.startsWith("2026-10-13T11:"), changed);

    const none = rowOf(w, 71).waiting;
    assert.deepEqual([none.since, none.atLeast, none.rulesAt], [changed, true, changed]);
    assert.match(view(w, 71).evidence.waitFrom, /^从 10-13 11:\d\d 起：判断方法这时更新，才算到你这边，之前多久不知道$/, "why, in the evidence");

    const told = rowOf(w, 72).waiting;
    assert.deepEqual([told.since?.slice(0, 16), told.atLeast, told.rulesAt], ["2026-10-13T10:20", false, changed]);
    assert.match(view(w, 72).evidence.waitFrom, /^从 10-13 10:20 起（判断方法 10-13 11:\d\d 更新后才算到你这边）$/);

    assert.deepEqual([rowOf(w, 73).waiting.since, rowOf(w, 73).waiting.atLeast], [changed, true], "a time before the turn before it is not believed");
    assert.deepEqual([rowOf(w, 77).waiting.since, rowOf(w, 77).waiting.atLeast], [changed, true], "nor one after the judgment");
    const turns = view(w, 78).visits.at(-1)!.balls.map((b) => [b.actor, b.what, b.from.slice(11, 16), b.to?.slice(11, 16) ?? null]);
    assert.deepEqual(turns, [["system", "等 a", "10:00", "10:10"], ["me", "等 b", "10:10", null]], "the system's later \"等 b\" was, by the rule, already the owner's: not drawn as the system's");

    const moved = rowOf(w, 74).waiting;
    assert.deepEqual([moved.since, moved.atLeast, moved.rulesAt], [byData, false, null], "the data moved it: not the rules, and not again when they change");
  }));

test("evidence a rule gives later of when the move became the holder's moves the start of the wait back; none from before the turn before it, or from the future", () =>
  withFlow(async (w) => {
    set(w, 75, { Ball: "system" });
    set(w, 76, { Ball: "system" });
    await w.run("2026-10-13 10:30");
    toMe(w);
    await w.run("2026-10-13 11:30");
    const changed = rowOf(w, 75).waiting.since!;
    set(w, 75, { Ball: "system", BallSince: "2026-10-13T10:20:00+08:00" });
    set(w, 76, { Ball: "system", BallSince: "2026-10-13T13:00:00+08:00" });
    await w.run("2026-10-13 12:00");
    assert.deepEqual([rowOf(w, 75).waiting.since?.slice(0, 16), rowOf(w, 75).waiting.atLeast], ["2026-10-13T10:20", false]);
    assert.deepEqual([rowOf(w, 76).waiting.since, rowOf(w, 76).waiting.atLeast], [changed, true], "a time after the judgment is not evidence");
    set(w, 75, { Ball: "system", BallSince: "2026-10-12T10:00:00+08:00" });
    await w.run("2026-10-13 12:30");
    assert.equal(rowOf(w, 75).waiting.since?.slice(0, 16), "2026-10-13T10:20", "nor one from before the system's turn began");
  }));
