import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import type { RunView } from "../shared/graph";
import { issue, makeWorld } from "./helpers";
import { FLOW, rowOf, set, START, view, withFlow } from "./item-flow";
import { ago, MIN, runView } from "./run-files";

// What the review of the page and the list found (notes/2026-10-23-reconcile-batch6-review.md), one test for each
// thing that was wrong, written to fail on the code that was.

/** The flow of item-flow.ts with a `Notice` field that becomes the rule's statement that something looks wrong. */
const NOTICE_FLOW = FLOW.replace("facts: [], commitments: [] };", "facts: [], commitments: [], notice: f.Notice || undefined };");

/** What the page tells in words (the item's own key, which has its source's id in it, is data). */
const told = (v: ReturnType<typeof view>) => [v.hero, v.facts, v.marks, v.poll, v.schedule, v.history];

// ---- N6-01 ------------------------------------------------------------------------------------------------

test("the rule's notice is on the page and on the row whatever state the item is in; it used to show only on a stuck one", () =>
  withFlow(async (w) => {
    const cases: Array<[number, Record<string, string>]> = [
      [1, { Health: "on-track", Ball: "system" }],
      [2, { Health: "waiting", Ball: "them" }],
      [3, { Health: "stalled", Ball: "them" }],
      [4, { Health: "blocked", Ball: "me" }],
      [5, { Health: "done", Phase: "finished" }],
    ];
    for (const [id, fields] of cases) set(w, id, { ...fields, Notice: `外放日已过但没有提交 #${id}` });
    set(w, 6, { Health: "waiting" });
    await w.run("2026-10-13 10:30");
    for (const [id] of cases) {
      const v = view(w, id);
      const mark = v.marks.find((m) => m.kind === "notice");
      assert.equal(mark?.line, `外放日已过但没有提交 #${id}`, `on the page of #${id} (${v.situation})`);
      assert.equal(rowOf(w, id).notice, `外放日已过但没有提交 #${id}`, `on the row of #${id} (${v.situation})`);
    }
    assert.equal(view(w, 6).marks.find((m) => m.kind === "notice"), undefined, "an item the rule has nothing to say about has none");
    assert.equal(rowOf(w, 6).notice, null);
    // a stuck item's hero no longer repeats it: it is a mark of its own
    assert.equal(view(w, 3).hero.sub.includes("外放日已过"), false);
  }, NOTICE_FLOW));

test("stale data is a badge on the row as well as a mark on the page", () =>
  withFlow(async (w) => {
    set(w, 1, {});
    await w.run("2026-10-13 10:30");
    assert.equal(rowOf(w, 1).stale, false);
    const a = w.store.state.assessments["gcp-demo:1"]!;
    a.stale = true;
    assert.equal(rowOf(w, 1).stale, true);
    assert.ok(view(w, 1).marks.some((m) => m.kind === "stale"));
  }));

// ---- N6-02 ------------------------------------------------------------------------------------------------

/**
 * A world whose items have the runs given for them (the runs are what a reader of the event files would return).
 * `adopt`: the controller started them itself (it recorded their intent, and the end of those that are over), which is
 * what makes a run say what the item is; without, they are runs that only name the item, listed on its page and no more.
 */
async function withRuns<T>(runs: Record<number, RunView[]>, fields: Record<number, Record<string, string>>, body: (w: Awaited<ReturnType<typeof makeWorld>>) => Promise<T>, adopt = true): Promise<T> {
  const w = await makeWorld({ start: START, config: { rules: { "flow.mjs": FLOW } }, runs: (caseId) => runs[Number(caseId.split(":")[1])] ?? [], adopt });
  try {
    for (const [id, f] of Object.entries(fields)) {
      const item = w.items.get(`gcp-demo:${id}`) ?? issue(Number(id), { release: "2026-10-14" });
      w.items.set(`gcp-demo:${id}`, { ...item, fields: { ...item.fields, ...f } });
    }
    await w.run("2026-10-13 10:30");
    return await body(w);
  } finally {
    w.close();
  }
}

test("only the newest run of a stage says what the item is: a failure that was run again is not still a failure", () =>
  withRuns(
    {
      1: [runView("done", { runId: "new", stage: "draft", startedAt: "2026-10-13T09:50:00+08:00", endedAt: "2026-10-13T09:55:00+08:00", quiet: null }), runView("fail", { runId: "old", stage: "draft", startedAt: "2026-10-10T09:50:00+08:00", endedAt: "2026-10-10T09:55:00+08:00", quiet: null })],
      2: [runView("fail", { runId: "only", stage: "draft", startedAt: "2026-10-10T09:50:00+08:00", endedAt: "2026-10-10T09:55:00+08:00", quiet: null })],
    },
    { 1: { Ball: "them" }, 2: { Ball: "them" } },
    async (w) => {
      assert.deepEqual([rowOf(w, 1).situation, rowOf(w, 1).group], ["them", "them"], "the second run finished: the first one's failure is history");
      assert.deepEqual([rowOf(w, 2).situation, rowOf(w, 2).group], ["fail", "me"], "a failure nobody has run again still is");
      assert.equal(view(w, 1).runs.length, 2, "both are still listed on the page");
    },
  ));

test("a run that broke in a stage the item has left no longer says anything about it; one that broke in the stage it is in does", () =>
  withRuns(
    {
      1: [runView("lost", { runId: "lost-old", stage: "draft", startedAt: "2026-10-12T09:50:00+08:00", quiet: { ms: 9e8, limitMs: 9e5 } })],
      2: [runView("lost", { runId: "lost-now", stage: "review", startedAt: "2026-10-12T09:50:00+08:00", quiet: { ms: 9e8, limitMs: 9e5 } })],
      3: [runView("fail", { runId: "no-stage", stage: null, startedAt: "2026-10-12T09:50:00+08:00", endedAt: "2026-10-12T09:55:00+08:00", quiet: null })],
      4: [runView("slow", { runId: "slow-old", stage: "draft", startedAt: "2026-10-12T09:50:00+08:00" }), runView("doing", { runId: "doing-now", stage: "review", startedAt: "2026-10-13T09:50:00+08:00" })],
    },
    { 1: { Phase: "review", Ball: "them" }, 2: { Phase: "review", Ball: "them" }, 3: { Phase: "review", Ball: "them" }, 4: { Phase: "review", Ball: "them" } },
    async (w) => {
      assert.equal(rowOf(w, 1).situation, "them", "it left 'draft' after the run there went silent");
      assert.equal(rowOf(w, 2).situation, "lost");
      assert.equal(rowOf(w, 3).situation, "fail", "a run with no stage is of the stage the item is in");
      assert.equal(rowOf(w, 4).situation, "doing", "the silent one of the stage left is dropped, the one of this stage counts");
      assert.match(view(w, 1).hero.kicker, /别人/);
    },
  ));

test("the page's history lists the runs started for the item: when one began and how it ended", () =>
  withRuns(
    {
      1: [
        runView("done", { runId: "r-done", stage: "draft", flow: "示例流程", startedAt: "2026-10-13T09:50:00+08:00", endedAt: "2026-10-13T09:58:00+08:00", quiet: null, outcome: "完成了" }),
        runView("fail", { runId: "r-fail", stage: "draft", flow: "示例流程", startedAt: "2026-10-13T08:00:00+08:00", endedAt: "2026-10-13T08:10:00+08:00", quiet: null, error: { name: "OutputMismatch", plain: "agent 的回答不合约定的格式，这一步没拿到结果", raw: "x" } }),
        runView("lost", { runId: "r-lost", stage: "draft", flow: "示例流程", startedAt: "2026-10-13T07:00:00+08:00" }),
      ],
    },
    { 1: { Ball: "them" } },
    async (w) => {
      const lines = view(w, 1).history.filter((h) => h.kind === "run");
      assert.deepEqual(
        lines.map((h) => [h.at.slice(5, 16).replace("T", " "), h.line]),
        [["10-13 07:00", "起了流程「示例流程」"], ["10-13 08:00", "起了流程「示例流程」"], ["10-13 08:10", "流程「示例流程」失败了"], ["10-13 09:50", "起了流程「示例流程」"], ["10-13 09:58", "流程「示例流程」结束了"]],
        "a run that went silent has no end to tell",
      );
      assert.equal(lines[2]!.detail, "agent 的回答不合约定的格式，这一步没拿到结果");
      const all = view(w, 1).history;
      assert.deepEqual(all.map((h) => h.at), [...all.map((h) => h.at)].sort(), "in time order with everything else");
    },
    false,
  ));

// ---- N6R-02 -----------------------------------------------------------------------------------------------

test("a run whose record could not be read whole is not a break and does not pin the item: the page says it cannot tell", () =>
  withRuns(
    {
      1: [runView("unreadable", { runId: "r-big", stage: "review", flow: "示例流程", startedAt: "2026-10-12T09:50:00+08:00", unreadLines: 2, quiet: { ms: 9e8, limitMs: 9e5 } })],
      2: [runView("done", { runId: "r-ok", stage: "review", flow: "示例流程", startedAt: "2026-10-13T09:50:00+08:00", endedAt: "2026-10-13T09:58:00+08:00", unreadLines: 1, quiet: null })],
      3: [runView("unreadable", { runId: "r-left", stage: "draft", flow: "示例流程", startedAt: "2026-10-12T09:50:00+08:00", unreadLines: 1, quiet: { ms: 9e8, limitMs: 9e5 } })],
    },
    { 1: { Phase: "review", Ball: "them" }, 2: { Phase: "review", Ball: "them" }, 3: { Phase: "review", Ball: "them" } },
    async (w) => {
      // the item stands where its own judgment puts it: nothing about a run that cannot be read puts it among what is for you
      assert.deepEqual([rowOf(w, 1).situation, rowOf(w, 1).group], ["them", "them"]);
      const v = view(w, 1);
      assert.match(v.hero.kicker, /别人/);
      const mark = v.marks.find((m) => m.kind === "unread");
      assert.match(mark?.line ?? "", /流程「示例流程」的记录里有 2 行太长、没读：看不出它走到哪了、有没有结束。到「流程」页里按运行号 r-big 看/);
      assert.match(v.history.find((h) => h.kind === "run")!.detail ?? "", /2 行太长、没读，看不出它后来怎么样/);
      assert.equal(v.runs[0]!.unreadLines, 2);
      // one that is over is not marked on the page (nothing is in doubt but what it cost), and its start line says so
      assert.equal(view(w, 2).marks.find((m) => m.kind === "unread"), undefined);
      assert.match(view(w, 2).history.find((h) => h.kind === "run")!.detail ?? "", /1 行太长、没读，花费可能少算了/);
      // one of a stage the item has left is history, as a break there is: the page does not keep warning about it
      assert.equal(view(w, 3).marks.find((m) => m.kind === "unread"), undefined);
      assert.match(view(w, 3).history.find((h) => h.kind === "run")!.detail ?? "", /1 行太长/, "but its line in the history says it");
    },
  ));

// ---- N6-03 ------------------------------------------------------------------------------------------------

test("a clock that starts when tracking began says 'at least': the wait of an item first seen waiting, the length of one first seen over", () =>
  withFlow(async (w) => {
    set(w, 1, { Phase: "ship", Ball: "them" }); // first seen far along, waiting for somebody
    set(w, 2, { Phase: "finished", Health: "done" }); // first seen already over
    set(w, 3, { Phase: "ship", Ball: "them", Since: "2026-10-13T08:00:00+08:00" }); // the rule knows when it got there
    set(w, 6, { Phase: "finished", Health: "done", Since: "2026-10-13T09:59:30+08:00" }); // first seen over, and the rule says it ended as it was seen
    await w.run("2026-10-13 10:30");
    set(w, 4, { Phase: "draft" });
    await w.run("2026-10-13 12:00");
    set(w, 4, { Phase: "review", Ball: "them" }); // moved while being watched
    await w.run("2026-10-13 14:00");
    set(w, 5, { Phase: "draft" });
    await w.run("2026-10-13 15:00");
    set(w, 5, { Phase: "ship" });
    await w.run("2026-10-13 16:00");
    set(w, 5, { Phase: "finished", Health: "done" });
    await w.run("2026-10-13 17:00");

    const waiting = rowOf(w, 1);
    assert.equal(waiting.waiting.atLeast, true);
    const page = view(w, 1);
    assert.match(page.facts[2]!.value, /^至少 /);
    assert.match(page.facts[2]!.sub, /开始追踪起$/, "it says what the clock counts from");
    assert.match(page.hero.sub, /至少已等/);
    assert.equal(page.current.ball.atLeast, true);

    const over = rowOf(w, 2);
    assert.deepEqual([over.waiting.ended, over.waiting.ms, over.waiting.atLeast], [true, null, true], "how long it took is not known, and is not made up");
    assert.deepEqual([view(w, 2).facts[2]!.value, view(w, 2).hero.kicker], ["追踪前就结束了", "结束了 · 开始追踪时就已经结束了"]);

    const sameMoment = rowOf(w, 6);
    assert.deepEqual([sameMoment.waiting.ended, sameMoment.waiting.ms], [true, null], "a single stay that is the end says nothing of how long it took, even when the rule says when it ended: not 'used 0'");
    assert.equal(view(w, 6).facts[2]!.value, "追踪前就结束了");

    assert.equal(rowOf(w, 3).waiting.atLeast, false, "the rule said when: that is measured");
    assert.doesNotMatch(view(w, 3).facts[2]!.value, /至少/);

    assert.equal(rowOf(w, 4).waiting.atLeast, false, "it moved while watched: the wait began when it was seen to");
    assert.match(view(w, 4).hero.sub, /^已等/);

    const took = rowOf(w, 5);
    assert.deepEqual([took.waiting.ended, took.waiting.atLeast], [true, true], "it was first seen as a draft: it took at least that long");
    assert.equal(took.waiting.ms, 2 * 3_600_000, "from the first sight to the end");
    assert.match(view(w, 5).facts[2]!.value, /^至少 /);
  }));

// ---- N6-13 ------------------------------------------------------------------------------------------------

test("the page names its sources by label or says how many; their ids stay in the evidence layer, and no word of a function that is not there", async () => {
  const w = await makeWorld({ start: START, config: { rules: { "flow.mjs": FLOW }, sourceLabels: { "gcp-demo": "示例追踪器", "flags-demo": "示例开关" } } });
  try {
    set(w, 1, { Ball: "them" });
    await w.run("2026-10-13 10:30");
    const v = view(w, 1);
    assert.ok(v.poll, "an item reads from a source");
    assert.equal(v.poll!.what, "读 示例追踪器、示例开关", "the labels of the sources");
    assert.ok(!JSON.stringify(told(v)).includes("gcp-demo"), "the id of a source is not in anything the page tells");
    assert.ok(v.evidence.sources.some((s) => s.id === "gcp-demo"), "it is where the ids are");
    assert.ok(rowOf(w, 1).next.every((n) => !n.includes("gcp-demo")));
    assert.ok(!v.hero.sub.includes("催办"), "a function that is not there is not mentioned");
    assert.match(v.hero.sub, /已等/);
  } finally {
    w.close();
  }
});

test("sources with no label are counted, not named", async () => {
  const w = await makeWorld({ start: START, config: { rules: { "flow.mjs": FLOW } } });
  try {
    set(w, 1, { Ball: "them" });
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14", fields: { Release: "2026-10-14", Ball: "them" } }));
    await w.run("2026-10-13 10:30");
    assert.match(view(w, 1).poll!.what, /^读 \d+ 个来源$/);
    assert.ok(!JSON.stringify(told(view(w, 1))).includes("gcp-demo"));
  } finally {
    w.close();
  }
});

test("a failed, lost or quiet flow asks to be looked at, not to be decided by a person who has nothing to decide it with", () =>
  withRuns(
    { 1: [runView("fail", { runId: "r-1", stage: "draft", endedAt: "2026-10-13T09:55:00+08:00", quiet: null })], 2: [runView("lost", { runId: "r-2", stage: "draft" })], 3: [runView("slow", { runId: "r-3", stage: "draft" })] },
    { 1: {}, 2: {}, 3: {} },
    async (w) => {
      for (const id of [1, 2, 3]) {
        const v = view(w, id);
        assert.match(v.hero.kicker, /看一眼$/);
        assert.ok(!JSON.stringify(v.hero).includes("定下一步"));
        assert.equal(v.facts[3]!.value, "看一眼");
      }
    },
  ));

// ---- N6-04 ------------------------------------------------------------------------------------------------

test("a `since` the rule wrote in UTC is read as that instant and told in the instance's zone", () =>
  withFlow(async (w) => {
    set(w, 1, { Phase: "draft", Since: "2026-10-13T01:30:00.000Z" });
    await w.run("2026-10-13 10:30");
    const v = view(w, 1);
    assert.equal(v.visits[0]!.from, "2026-10-13T09:30:00+08:00", "told in the instance's zone");
    assert.equal(v.visits[0]!.fromKind, "happened");
    assert.equal(v.current.since, "2026-10-13T09:30:00+08:00");
  }));

// ---- N6-06, N6-15 -----------------------------------------------------------------------------------------------

test("working out the list for hundreds of items reads the journal's directory once, not once per row", async () => {
  const w = await makeWorld({ start: START, config: { rules: { "flow.mjs": FLOW } } });
  try {
    for (let id = 1; id <= 300; id++) w.items.set(`gcp-demo:${id}`, issue(id, { release: "2026-10-14" }));
    await w.run("2026-10-13 10:30");
    // a year of month files, as an old installation has
    for (let m = 1; m <= 11; m++) writeFileSync(path.join(w.dataDir, "journal", `2025-${String(m).padStart(2, "0")}.jsonl`), "");
    assert.equal(w.engine.status().cases.filter((c) => c.row).length, 300);
    const took: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      w.engine.status();
      took.push(performance.now() - t);
    }
    took.sort((a, b) => a - b);
    // measured: about 6 ms; with a read of the directory for every row, about 270 ms
    assert.ok(took[2]! < 80, `status() took ${took[2]!.toFixed(0)} ms for 300 items`);
  } finally {
    w.close();
  }
});

test("a row that cannot be worked out is left out of the list, once told, and does not take the status or the tick with it", async () => {
  const w = await makeWorld({
    start: START,
    config: { rules: { "flow.mjs": FLOW } },
    runs: (caseId) => {
      if (caseId === "gcp-demo:2") throw new Error("the runs of #2 cannot be read");
      return [];
    },
  });
  try {
    for (const id of [1, 2, 3]) w.items.set(`gcp-demo:${id}`, issue(id, { release: "2026-10-14" }));
    await w.run("2026-10-13 10:30");
    const cases = w.engine.status().cases;
    assert.deepEqual(cases.map((c) => [c.caseId, c.row !== null]).sort(), [["gcp-demo:1", true], ["gcp-demo:2", false], ["gcp-demo:3", true]]);
    w.engine.status();
    assert.equal(w.logs.filter((l) => l.includes("gcp-demo:2") && l.includes("cannot be read")).length, 1, "told once, not every five seconds");
    assert.ok(w.statuses.length > 0, "the status file went on being written after each tick");
  } finally {
    w.close();
  }
});
