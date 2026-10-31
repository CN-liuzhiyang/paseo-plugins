import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createJournalBook } from "../server/journal-book";
import { loadRules } from "../server/rules";
import { clockText, durationText, layoutOf, normalizeStages, plainMd, routeOf, stripOf, type StageSpec, type Visit } from "../shared/graph";

// The stage metadata a rule declares, the pure layout of the chart and the list's strip, and the fold
// of a journal into the stays of an item. The journals here are written the way the store writes
// them (one json per line, `v`, `seq`, `at`, `type` first), with made-up items and the shapes the
// real logs have, including an old one that predates `since`, `notice` and stage metadata.

const SPECS: StageSpec[] = [{ id: "a" }, { id: "b", label: "第二步" }, { id: "c", side: true, when: "打回时" }, { id: "d" }, { id: "e" }, { id: "z", end: true }, { id: "x", end: true, endKind: "dropped" }];
const metas = normalizeStages(SPECS);

const visit = (stage: string, over: Partial<Visit> = {}): Visit => ({
  id: `${stage}#1`,
  stage,
  round: 1,
  cur: false,
  before: false,
  inferred: false,
  superseded: false,
  from: null,
  observedAt: null,
  fromKind: "observed",
  to: null,
  durationMs: null,
  cause: "data",
  headline: "",
  lastHeadline: "",
  balls: [],
  handoffs: [],
  evidence: [],
  skipped: [],
  ...over,
});

// ---- declarations --------------------------------------------------------------------------------

test("bare ids are stages with a neutral name, never their id; a stage goes on to the next of the usual route, a detour back to the first route stage after it", () => {
  const bare = normalizeStages(["open", "review", "closed"]);
  assert.deepEqual(bare.map((m) => [m.id, m.label, m.next, m.side, m.end]), [
    ["open", "第 1 步", ["review"], false, false],
    ["review", "第 2 步", ["closed"], false, false],
    ["closed", "第 3 步", [], false, false],
  ]);
  assert.deepEqual(bare.map((m) => m.named), [false, false, false]);
  assert.deepEqual(routeOf(metas), ["a", "b", "d", "e", "z"], "detours and ends that are not finishing are off the route");
  const byId = Object.fromEntries(metas.map((m) => [m.id, m]));
  assert.deepEqual(byId.a!.next, ["b"]);
  assert.deepEqual(byId.b!.next, ["d"]);
  assert.deepEqual(byId.c!.next, ["d"], "the detour comes back to the route at the first stage declared after it");
  assert.equal(byId.c!.when, "打回时");
  assert.equal(byId.b!.label, "第二步");
  assert.deepEqual([byId.z!.end, byId.z!.endKind, byId.x!.endKind, byId.a!.endKind], [true, "done", "dropped", null]);
  assert.deepEqual(byId.z!.next, []);
});

test("a wrong declaration says what is wrong", () => {
  assert.throws(() => normalizeStages(["a", "a"]), /declared twice/);
  assert.throws(() => normalizeStages([{ id: "a", next: ["nowhere"] }]), /not a declared stage/);
  assert.throws(() => normalizeStages([{ id: "a", endKind: "done" }]), /endKind needs end/);
  assert.throws(() => normalizeStages([{ id: "a", when: "x" }]), /when is for a detour/);
  assert.throws(() => normalizeStages([{ id: "a", side: true, end: true }]), /not an end/);
});

test("the loader takes string stages as before and object stages with their metadata, and reports a bad declaration as that file's error", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-stages-"));
  const rule = (name: string, stages: string) => `export default { name: ${JSON.stringify(name)}, description: "x", applies: { source: "s" }, params: {}, stages: ${stages}, assess() { return null; } };`;
  try {
    writeFileSync(path.join(dir, "plain.mjs"), rule("plain", '["one", "two"]'));
    writeFileSync(path.join(dir, "rich.mjs"), rule("rich", '[{ id: "one", label: "第一" }, "two", { id: "off", side: true, when: "岔路" }, { id: "end", end: true, endKind: "dropped" }]'));
    writeFileSync(path.join(dir, "twice.mjs"), rule("twice", '["one", "one"]'));
    writeFileSync(path.join(dir, "unknown-key.mjs"), rule("unknown-key", '[{ id: "one", colour: "red" }]'));
    const set = await loadRules(dir);
    assert.deepEqual(set.rules.map((r) => r.name).sort(), ["plain", "rich"]);
    const plain = set.rules.find((r) => r.name === "plain")!;
    const rich = set.rules.find((r) => r.name === "rich")!;
    assert.deepEqual(plain.stages, ["one", "two"]);
    assert.deepEqual(plain.stageMeta!.map((m) => [m.id, m.label]), [["one", "第 1 步"], ["two", "第 2 步"]]);
    assert.deepEqual(rich.stages, ["one", "two", "off", "end"], "the ids stay a string array for everything that checks a stage against them");
    assert.equal(rich.stageMeta![0]!.label, "第一");
    assert.equal(rich.stageMeta![2]!.side, true);
    assert.deepEqual(set.errors.map((e) => e.file).sort(), ["twice.mjs", "unknown-key.mjs"]);
    assert.match(set.errors.find((e) => e.file === "twice.mjs")!.error, /declared twice/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stage declaration that is wrong goes the way of any rule that stops loading: the last copy that loaded goes on, and the error is told with it", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-stages-keep-"));
  const kept = path.join(dir, "kept");
  const rules = path.join(dir, "rules");
  mkdirSync(rules);
  const rule = (stages: string) => `export default { name: "r", description: "x", applies: { source: "s" }, params: {}, stages: ${stages}, assess() { return null; } };`;
  try {
    writeFileSync(path.join(rules, "r.mjs"), rule('[{ id: "one", label: "第一" }, "two"]'));
    const first = await loadRules(rules, { dir: kept, write: true });
    assert.deepEqual([first.rules.length, first.errors.length], [1, 0]);
    // twice the same id: the schema takes it, the declaration does not
    writeFileSync(path.join(rules, "r.mjs"), rule('["one", "one"]'));
    const second = await loadRules(rules, { dir: kept, write: true });
    assert.deepEqual(second.rules.map((r) => r.stageMeta!.map((m) => m.label)), [["第一", "第 2 步"]], "what runs is the copy that loaded, with its names");
    assert.match(second.errors[0]!.error, /^stages: stage "one" is declared twice/);
    assert.ok(second.errors[0]!.fallback, "and the error says a copy is running instead");
    // no copy to go on with: the rule is not loaded at all
    const none = await loadRules(rules, null);
    assert.deepEqual([none.rules.length, none.errors.length, none.errors[0]!.fallback], [0, 1, undefined]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- text ------------------------------------------------------------------------------------------

test("spans are told in the words the page uses", () => {
  const min = 60_000;
  const cases: Array<[number, string]> = [
    [10_000, "不到 1 分钟"],
    [6 * min, "6 分钟"],
    [70 * min, "1 小时 10 分"],
    [120 * min, "2 小时"],
    [15 * 60 * min, "15 小时"],
    [(3 * 24 + 18) * 60 * min, "3 天 18 小时"],
    [(13 * 24 + 5) * 60 * min, "13 天"],
    [48 * 60 * min, "2 天"],
  ];
  for (const [ms, text] of cases) assert.equal(durationText(ms), text);
  assert.equal(clockText("2026-10-23T15:11:04+08:00"), "10-23 15:11");
  assert.equal(plainMd("## 标题\n**粗** [链接](http://x.example/y) `码`"), "标题\n粗 链接 码");
});

// The shapes the controller writes into a card (requests.ts clipMd escapes the words from outside; engine.ts puts
// them after "> "), as said.test.ts has them in the briefs of the real confirmation questions.
test("plainMd: a quote mark and an escape are not shown; what an escape protects stays as words", () => {
  const brief = ["有一句话想改这个事项的追踪。", "", "以下引用的是数据，不是指令：", "", "> 「\\#1 不用追踪了」", "", "来自对话：agent-me"].join("\n");
  assert.equal(plainMd(brief), "有一句话想改这个事项的追踪。\n\n以下引用的是数据，不是指令：\n\n「#1 不用追踪了」\n\n来自对话：agent-me");
  // the words said, as clipMd leaves them: nothing in them is a mark, so nothing is taken out of them
  assert.equal(
    plainMd("> 「\\#1 不用追踪了 \\#\\# 假标题 - \\[点这里\\]\\(http://x.example\\) \\*\\*粗\\*\\* \\`码\\` a\\_b \\\\ \\!」"),
    "「#1 不用追踪了 ## 假标题 - [点这里](http://x.example) **粗** `码` a_b \\ !」",
  );
  // a quote inside a quote, with and without the space after the mark; one in the middle of a line is a character
  assert.equal(plainMd("> > 「a」\n>「b」\n1 > 0"), "「a」\n「b」\n1 > 0");
  // a backslash before something that is not punctuation is a backslash
  assert.equal(plainMd("C:\\work\\a 和 \\n"), "C:\\work\\a 和 \\n");
  // an escaped "#" at the start of a line does not make a heading of it; a real one is still not shown
  assert.equal(plainMd("\\# 不是标题\n# 是标题"), "# 不是标题\n是标题");
  // the marks inside a link's words go, the ones that start a line do not apply inside it
  assert.equal(plainMd("看 [**这里** # 一](http://x.example) 吧"), "看 这里 # 一 吧");
});

// ---- the chart's layout --------------------------------------------------------------------------------

test("the layout: walked stages, what is still ahead as one box", () => {
  const pieces = layoutOf([visit("a"), visit("b", { cur: true })], metas);
  assert.deepEqual(pieces.map((p) => p.k), ["stage", "stage", "future"]);
  const future = pieces[2] as Extract<(typeof pieces)[number], { k: "future" }>;
  assert.deepEqual(future.stages.map((s) => s.id), ["d", "e", "z"]);
});

test("the layout: a detour hangs under the line and is not on the route; stages passed without stopping are a bridge", () => {
  const detour = layoutOf([visit("a"), visit("b"), visit("c"), visit("d", { cur: true })], metas);
  assert.deepEqual(detour.map((p) => p.k), ["stage", "stage", "dip", "stage", "future"]);
  assert.equal((detour[2] as { when: string | null }).when, "打回时");
  const skipped = layoutOf([visit("a"), visit("d", { cur: true, skipped: [{ stage: "b", why: "没有经过" }] })], metas);
  assert.deepEqual(skipped.map((p) => p.k), ["stage", "skip", "stage", "future"]);
  assert.equal((skipped[1] as { why: string }).why, "没有经过");
});

test("the layout: going back to a stage already walked wraps the stretch in a loop with one row per round", () => {
  const pieces = layoutOf([visit("a"), visit("b"), visit("d"), visit("b", { round: 2 }), visit("d", { round: 2, cur: true })], metas);
  assert.deepEqual(pieces.map((p) => p.k), ["stage", "loop", "future"]);
  const loop = pieces[1] as Extract<(typeof pieces)[number], { k: "loop" }>;
  assert.equal(loop.rounds.length, 2);
  assert.deepEqual(loop.rounds.map((row) => row.map((p) => (p.k === "stage" ? p.v.stage : p.k))), [["b", "d"], ["b", "d"]]);
  assert.equal(loop.label, "打回 1 次");
});

test("the layout: an end closes the chart; a dropped end does not owe the rest of the route; the last stage before the end is a ghost", () => {
  assert.deepEqual(layoutOf([visit("a"), visit("b"), visit("d"), visit("e"), visit("z", { cur: true })], metas).map((p) => p.k), ["stage", "stage", "stage", "stage", "end"]);
  assert.deepEqual(layoutOf([visit("a"), visit("b"), visit("x", { cur: true })], metas).map((p) => p.k), ["stage", "stage", "end"]);
  assert.deepEqual(layoutOf([visit("a"), visit("b"), visit("d"), visit("e", { cur: true })], metas).map((p) => p.k), ["stage", "stage", "stage", "stage", "endghost"]);
});

test("the layout leaves out a stay that changed rules judged again", () => {
  const pieces = layoutOf([visit("a"), visit("d", { superseded: true }), visit("b", { cur: true })], metas);
  assert.deepEqual(pieces.map((p) => (p.k === "stage" ? p.v.stage : p.k)), ["a", "b", "future"]);
});

test("the strip: one cell per stage of the route; walked, here, not yet, passed, inferred", () => {
  assert.deepEqual(stripOf([visit("a"), visit("b", { cur: true })], metas), { cells: ["done", "cur", "todo", "todo", "todo"], side: null });
  assert.deepEqual(stripOf([visit("a", { inferred: true }), visit("b", { cur: true })], metas).cells, ["pre", "cur", "todo", "todo", "todo"]);
  assert.deepEqual(stripOf([visit("a"), visit("d", { cur: true })], metas).cells, ["done", "skip", "cur", "todo", "todo"]);
  const dip = stripOf([visit("a"), visit("b"), visit("c"), visit("d", { cur: true })], metas);
  assert.deepEqual(dip.cells, ["done", "done", "cur", "todo", "todo"]);
  assert.deepEqual(dip.side, { after: 1, label: "岔路 1" }, "the detour was taken after the second cell");
});

// ---- the journal fold ----------------------------------------------------------------------------------------

let seq = 0;
const line = (type: string, at: string, body: Record<string, unknown>) => JSON.stringify({ v: 1, seq: ++seq, at, type, ...body }) + "\n";
const OLD = { rulesFingerprint: "aaaa", rule: "flow", stale: false, error: null };
const assessment = (caseId: string, at: string, stage: string, over: Record<string, unknown> = {}) =>
  line("assessment", at, { assessment: { caseId, at, stage, health: "on-track", headline: `在 ${stage}`, next: { actor: "them", what: "等" }, ...OLD, ...over } });
const snapshot = (key: string, at: string) => line("item.snapshot", at, { item: { key, source: "tracker", kind: "issue", title: "示例单", status: "x" } });
const annotation = (caseId: string, kind: "drop" | "hold" | "wrong", at: string, id = `an_${kind}`) =>
  line("annotation.added", at, { annotation: { id, caseId, kind, said: "这条不用了", by: "owner", via: null, how: "own-words", at, until: null, person: null, what: null, expected: null, revoked: null } });

function withJournal<T>(lines: string[], body: (dir: string, file: string) => T, shared: string[] = []): T {
  seq = 0;
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-book-"));
  mkdirSync(path.join(dir, "journal"));
  const file = path.join(dir, "journal", "2026-10.jsonl");
  writeFileSync(file, lines.join(""));
  try {
    return body(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const book = (dir: string, shared: string[] = []) => {
  const b = createJournalBook(dir, new Set(shared), "Asia/Shanghai");
  b.refresh();
  return b;
};

test("stays are read from the assessments: a stay ends when a judgment names another stage; the same stage again is the same stay", () =>
  withJournal(
    [
      assessment("tracker:1", "2026-10-20T01:00:00.000Z", "open"),
      assessment("tracker:1", "2026-10-20T02:00:00.000Z", "open", { headline: "还在 open", next: { actor: "me", what: "回答" } }),
      assessment("tracker:1", "2026-10-21T03:00:00.000Z", "review"),
    ],
    (dir) => {
      const chain = book(dir).chain("tracker:1")!;
      assert.deepEqual(chain.visits.map((v) => [v.stage, v.observed, v.cause]), [
        ["open", "2026-10-20T01:00:00.000Z", null],
        ["review", "2026-10-21T03:00:00.000Z", "data"],
      ]);
      const open = chain.visits[0]!;
      assert.equal(open.lastHeadline, "还在 open");
      assert.deepEqual(open.balls.map((b) => [b.actor, b.what, b.from]), [["them", "等", "2026-10-20T01:00:00.000Z"], ["me", "回答", "2026-10-20T02:00:00.000Z"]], "who has the ball is a list of turns inside the stay");
      assert.equal(chain.last!.stage, "review");
    },
  ));

test("an old journal, with no `since`, `notice` or metadata anywhere, reads: nothing is claimed about when it happened", () =>
  withJournal([assessment("tracker:2", "2026-10-20T01:00:00.000Z", "open"), assessment("tracker:2", "2026-10-22T01:00:00.000Z", "review")], (dir) => {
    const chain = book(dir).chain("tracker:2")!;
    assert.deepEqual(chain.visits.map((v) => v.happened), [null, null]);
    assert.equal(chain.last!.since, null);
    assert.equal(chain.last!.notice, null);
  }));

test("`since` is the time of the rule's own evidence, read only when it is not later than the judgment", () =>
  withJournal(
    [
      assessment("tracker:3", "2026-10-20T08:00:00.000Z", "open", { since: "2026-10-19T08:00:00+08:00" }),
      assessment("tracker:3", "2026-10-21T08:00:00.000Z", "review", { since: "2026-10-30T08:00:00+08:00" }),
      assessment("tracker:3", "2026-10-22T08:00:00.000Z", "review", { since: "2026-10-21T10:00:00+08:00" }),
    ],
    (dir) => {
      const [open, review] = book(dir).chain("tracker:3")!.visits;
      assert.equal(open!.happened, "2026-10-19T08:00:00+08:00");
      assert.equal(open!.observed, "2026-10-20T08:00:00.000Z", "the time it was seen stays beside the time it happened");
      assert.equal(review!.happened, "2026-10-21T10:00:00+08:00", "a time from the future is ignored, a later judgment may bring a good one");
    },
  ));

test("an assessment that is an error is not a stay; the stay goes on across it", () =>
  withJournal(
    [
      assessment("tracker:4", "2026-10-20T01:00:00.000Z", "open"),
      assessment("tracker:4", "2026-10-20T02:00:00.000Z", "open", { error: "rule threw", health: "blocked" }),
      assessment("tracker:4", "2026-10-20T03:00:00.000Z", "open"),
    ],
    (dir) => {
      const chain = book(dir).chain("tracker:4")!;
      assert.equal(chain.visits.length, 1);
      assert.equal(chain.errorSince, null);
      assert.deepEqual(chain.entries.map((e) => e.kind), ["stage", "error", "error"], "it began, it broke, it was checked again");
    },
  ));

test("why a stage changed: the item's data, a word of the person's, a correction, or changed rules", () =>
  withJournal(
    [
      assessment("tracker:5", "2026-10-20T01:00:00.000Z", "a"),
      snapshot("tracker:5", "2026-10-20T02:00:00.000Z"),
      assessment("tracker:5", "2026-10-20T02:00:01.000Z", "b", { rulesFingerprint: "bbbb" }),
      annotation("tracker:5", "drop", "2026-10-20T03:00:00.000Z"),
      assessment("tracker:5", "2026-10-20T04:00:00.000Z", "d", { rulesFingerprint: "bbbb" }),
      annotation("tracker:5", "wrong", "2026-10-20T05:00:00.000Z", "an_wrong"),
      assessment("tracker:5", "2026-10-20T06:00:00.000Z", "e", { rulesFingerprint: "bbbb" }),
      // new rules, no data of the item read since: the rules did it
      assessment("tracker:5", "2026-10-20T07:00:00.000Z", "z", { rulesFingerprint: "cccc" }),
    ],
    (dir) => {
      const visits = book(dir).chain("tracker:5")!.visits;
      assert.deepEqual(visits.map((v) => [v.stage, v.cause, v.superseded]), [
        ["a", null, false],
        ["b", "data", false],
        ["d", "said", false],
        ["e", "correction", true], // the new rules judged it again: it was not a step the item took
        ["z", "rules-changed", false],
      ]);
    },
  ));

test("a change of rules at the moment the item's data changed looks like the data, not like the rules", () =>
  withJournal([assessment("tracker:6", "2026-10-20T01:00:00.000Z", "a"), snapshot("tracker:6", "2026-10-20T02:00:00.000Z"), assessment("tracker:6", "2026-10-20T02:00:01.000Z", "b", { rulesFingerprint: "bbbb" })], (dir) => {
    const visits = book(dir).chain("tracker:6")!.visits;
    assert.equal(visits[1]!.cause, "data");
    assert.equal(visits[0]!.superseded, false);
  }));

test("a file every item reads (switches, versions) changing counts as a change in the data of all of them", () =>
  withJournal(
    [
      assessment("tracker:7", "2026-10-20T01:00:00.000Z", "a"),
      line("item.snapshot", "2026-10-20T02:00:00.000Z", { item: { key: "flags:outer", source: "flags", kind: "flags", title: "outer" } }),
      assessment("tracker:7", "2026-10-20T02:00:01.000Z", "b", { rulesFingerprint: "bbbb" }),
    ],
    (dir) => assert.equal(book(dir, ["flags"]).chain("tracker:7")!.visits[1]!.cause, "data"),
  ));

test("the journal is read once and then only what was appended; a half-written last line waits; a shorter file is read again", () =>
  withJournal([assessment("tracker:8", "2026-10-20T01:00:00.000Z", "a")], (dir, file) => {
    const b = book(dir);
    assert.equal(b.chain("tracker:8")!.visits.length, 1);
    const next = assessment("tracker:8", "2026-10-20T02:00:00.000Z", "b");
    appendFileSync(file, next.slice(0, 40));
    b.refresh();
    assert.equal(b.chain("tracker:8")!.visits.length, 1, "no new line yet");
    appendFileSync(file, next.slice(40));
    b.refresh();
    assert.deepEqual(b.chain("tracker:8")!.visits.map((v) => v.stage), ["a", "b"]);
    b.refresh();
    assert.equal(b.chain("tracker:8")!.visits.length, 2, "reading again adds nothing");
    writeFileSync(file, assessment("tracker:9", "2026-10-21T01:00:00.000Z", "a"));
    b.refresh();
    assert.equal(b.chain("tracker:8"), undefined, "a journal that got shorter is not an append: everything is read again");
    assert.equal(b.chain("tracker:9")!.visits.length, 1);
  }));

test("lines that are not assessments are passed over without being parsed, and a line that does not parse costs only itself", () =>
  withJournal(["{this is not json\n", line("source.state", "2026-10-20T01:00:00.000Z", { id: "x" }), assessment("tracker:10", "2026-10-20T02:00:00.000Z", "a")], (dir) => {
    assert.equal(book(dir).chain("tracker:10")!.visits.length, 1);
  }));

test("`since` is an instant: a rule may write it in UTC or with no offset, and the page reads it in the instance's zone", () =>
  withJournal(
    [
      assessment("tracker:11", "2026-10-13T10:00:00+08:00", "a", { since: "2026-10-13T01:00:00.000Z" }),
      assessment("tracker:11", "2026-10-14T10:00:00+08:00", "b", { since: "2026-10-14T09:00:00" }),
      assessment("tracker:11", "2026-10-15T10:00:00+08:00", "d", { since: "2026-10-15T09:30:00+08:00" }),
    ],
    (dir) => {
      assert.deepEqual(book(dir).chain("tracker:11")!.visits.map((v) => v.happened), ["2026-10-13T09:00:00+08:00", "2026-10-14T09:00:00+08:00", "2026-10-15T09:30:00+08:00"]);
    },
  ));

test("`since` that puts a stage before the one it came after is not believed", () =>
  withJournal(
    [
      assessment("tracker:12", "2026-10-23T10:00:00+08:00", "a", { since: "2026-10-22T10:00:00+08:00" }),
      assessment("tracker:12", "2026-10-23T11:00:00+08:00", "b", { since: "2026-10-21T10:00:00+08:00" }),
      assessment("tracker:12", "2026-10-23T12:00:00+08:00", "d", { since: "2026-10-23T11:30:00+08:00" }),
    ],
    (dir) => {
      const visits = book(dir).chain("tracker:12")!.visits;
      assert.deepEqual(visits.map((v) => v.happened), ["2026-10-22T10:00:00+08:00", null, "2026-10-23T11:30:00+08:00"], "b was not before a; it has only the time it was seen");
      assert.deepEqual(visits[1]!.balls.map((b) => b.from), ["2026-10-23T11:00:00+08:00"]);
    },
  ));

test("a journal that cannot be listed leaves the page as it was and is read again next time", () =>
  withJournal([assessment("tracker:13", "2026-10-20T01:00:00.000Z", "a")], (dir) => {
    const b = book(dir);
    rmSync(path.join(dir, "journal"), { recursive: true, force: true });
    writeFileSync(path.join(dir, "journal"), "not a directory"); // readdir now throws
    assert.doesNotThrow(() => b.refresh());
    assert.equal(b.chain("tracker:13")!.visits.length, 1, "what was read stays");
  }));

test("a stage the rule gave no name is never shown by its id: a step number, a detour number, or what kind of end", () => {
  const m = normalizeStages(["a", { id: "b", label: "有名字" }, { id: "x", side: true }, { id: "y", side: true, label: "打回" }, { id: "z", side: true }, "c", { id: "fin", end: true }, { id: "off", end: true, endKind: "dropped" }, { id: "odd", end: true, endKind: "other" }, "dropped"]);
  assert.deepEqual(m.map((s) => s.label), ["第 1 步", "有名字", "岔路 1", "打回", "岔路 2", "第 3 步", "结束", "不盯了", "另一种结束", "不盯了"]);
  assert.ok(m.every((s) => s.named === (s.id === "b" || s.id === "y")));
});
