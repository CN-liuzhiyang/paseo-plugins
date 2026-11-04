import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { eventsOf, sourceKey, whenOf } from "../server/lib/events.mjs";
import { fold } from "../server/lib/log.mjs";
import { linkContext } from "../server/lib/links.mjs";
import { namesOf, panelOf } from "../server/lib/panel.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { panelSchema } from "../shared/panel";
import { scratch, world } from "./kit";

// The rows of "经过" are worked out from the log alone. The log below has the shape of a real one (a ticket watched for a
// day: the first look, a question of his and the look it called, a picture, a quiet look the next afternoon) with
// made-up content.

const MECHANISM = /叫醒|校验|记录|计划|读数|会话|agent|槽位|gcp-issue|release|online/i;
const NOW = Date.parse("2026-11-04T08:30:00+08:00");
const sec = (at: string, ss: number) => at.replace(/:dd+08:00$/, `:${ss}+08:00`);
const day3 = (clock: string) => `2026-11-03T${clock}+08:00`;

function dirWithReaders() {
  const dir = scratch("affairs-readers-");
  writeFileSync(path.join(dir, "ticket.mjs"), "// 单子：状态（只读）\n// label: 易协作\n");
  writeFileSync(path.join(dir, "slots.mjs"), "// 各处的版本（只读）\n// label: 外网版本\n// 输入 …\n");
  return dir;
}

const policyOf = (dir: string) => ({ ...DEFAULT_POLICY, tz: "Asia/Shanghai", links: { gcp: "https://pm.example.invalid/issues/{ref}" }, linkHash: "gcp", readers: { ...DEFAULT_POLICY.readers, dirs: [dir] } });

/** Lines are given in order; seq counts up as the writer's would. */
function make(spec: Array<[string, string, Record<string, unknown>?]>) {
  let seq = 0;
  return spec.map(([at, kind, extra]) => ({ kind, ...(extra ?? {}), seq: ++seq, at }));
}

const ticket = { status: "等待审核", closed: false, fields: { 外放版本: "待定" }, commits: ["R-64757"], notes: 3 };
const slots = { android: { now: 64464, since: [64109, 64464] }, ios: { now: 64378, since: [63657, 64378] } };
const look = (over: Record<string, unknown> = {}) => ({ verdict: "pass", attempt: 1, status: "x", facts: [], changed: true, detail: "", ...over });

/** The affair of the story: nothing in it is a real one. */
function story() {
  const filesDir = "C:/data/affairs/555001/files";
  const lines = make([
    [day3("10:28:25"), "created", { id: "555001", title: "#555001 某个功能", goal: "", link: "gcp:555001" }],
    [day3("10:28:25"), "said", { text: "这几天需要持续跟进 #555001（某个功能）", via: "chat", by: "user" }],
    [day3("10:28:27"), "workspace", { workspaceId: "wks_1" }],
    [day3("10:28:36"), "wake", { why: ["said:2"], gapMinutes: null }],
    [day3("10:28:36"), "next", { next: "2026-11-03T12:28:36+08:00", waitingFor: "", why: "没交回时的兜底", verdict: "pass", source: "fallback" }],
    [day3("10:29:06"), "read", { tool: "ticket", args: { id: 555001 }, ok: true, value: ticket, summary: "#555001：等待审核；1 个关联提交" }],
    [day3("10:29:12"), "read", { tool: "slots", args: { itemNo: 555001, want: ["trunk", "online"] }, ok: true, value: slots, summary: "外网最高 64464（android），没到 64757" }],
    [day3("10:29:19"), "report", look({ entry: "单子在等审核，外网都还没带上这次改动。", changed: true })],
    [day3("10:29:19"), "next", { next: "2026-11-04T10:30:00+08:00", waitingFor: "等审核和出包", why: "出包要几天", verdict: "pass", source: "look" }],
    [day3("10:29:20"), "schedule.fix", { changed: ["rescheduled"] }],
    [day3("10:29:30"), "wake.end", { state: "ok" }],
    [day3("10:45:29"), "said", { text: "这个是啥知道么", via: "workspace", by: "user" }],
    [day3("10:45:38"), "wake", { why: ["said:12"], gapMinutes: 17 }],
    [day3("10:45:39"), "read", { tool: "ticket", args: { id: 555001 }, ok: true, value: ticket, summary: "#555001：等待审核；1 个关联提交" }],
    [day3("10:46:32"), "report", look({ entry: "我看了一眼：这是一张功能单，现在在等审核。", changed: true })],
    [day3("10:46:32"), "next", { next: "2026-11-03T16:00:00+08:00", waitingFor: "等审核和出包", why: "下午再看", verdict: "pass", source: "look" }],
    [day3("10:46:44"), "wake.end", { state: "ok" }],
    [day3("11:14:16"), "said", { text: "能看懂吗", via: "workspace", by: "user", attachments: [{ name: "图片.png", path: `${filesDir}/20261103-111416-图片.png`, mime: "image/png", size: 43634 }] }],
    [day3("11:14:24"), "wake", { why: ["said:18"], gapMinutes: 29 }],
    [day3("11:14:41"), "report", look({ entry: "能看懂：是一张事项卡片。单子还在等审核。", changed: true })],
    [day3("11:14:51"), "wake.end", { state: "ok" }],
    [day3("16:00:11"), "wake", { why: ["time"], gapMinutes: 286 }],
    [day3("16:00:12"), "next", { next: "2026-11-03T18:00:11+08:00", waitingFor: "等审核和出包", why: "没交回时的兜底", verdict: "pass", source: "fallback" }],
    [day3("16:00:30"), "read", { tool: "ticket", args: { id: 555001 }, ok: true, value: ticket, summary: "#555001：等待审核；1 个关联提交" }],
    // the same thing read again: the number is written as text this time and it asks for less
    [day3("16:00:36"), "read", { tool: "slots", args: { itemNo: "555001", want: ["online"] }, ok: true, value: slots, summary: "外网最高 64464（android），没到 64757" }],
    [day3("16:00:48"), "report", look({ entry: "还在等审核，外网都还没带上。", changed: true })],
    [day3("16:00:48"), "next", { next: "2026-11-04T09:00:00+08:00", waitingFor: "等审核和出包", why: "审核和出包都不会很快", verdict: "pass", source: "look" }],
    [day3("16:00:59"), "wake.end", { state: "ok" }],
    [day3("18:08:53"), "chat", { agentId: "c1", why: "migrate" }],
  ]);
  const state = { ...fold(lines as never), lines };
  return { state, filesDir };
}

function eventsFor(state: any, extra: { now?: number } = {}) {
  const dir = dirWithReaders();
  const policy = policyOf(dir);
  const lc = linkContext(policy as never, state.link);
  const { labelOf } = namesOf(policy as never, state, lc);
  return eventsOf(state, extra.now ?? NOW, policy as never, lc, { labelOf, fileAt: (n: string) => `C:/data/affairs/555001/files/${n}` });
}

test("the rows of the story: newest first, what each was, and what was left out", () => {
  const { state } = story();
  const { items, total } = eventsFor(state);
  assert.equal(total, 7);
  assert.deepEqual(
    items.map((e: { label: string; sub: string; when: string }) => [e.label, e.sub, e.when]),
    [
      ["看了一眼", "没变化", "16:00"],
      ["看了一眼", "你问了一句", "11:14"],
      ["你", "发了一张图", "11:14"],
      ["看了一眼", "你问了一句 · 没变化", "10:46"],
      ["你", "", "10:45"],
      ["看了一眼", "第一次", "10:29"],
      ["你", "交代了这件事", "10:28"],
    ],
  );
  assert.ok(items.every((e: { label: string }) => e.label !== "回你"), "a look is never called a reply");
  // his words in the workspace are there (the old list skipped them), and what is not an event of the affair is not
  assert.equal(items[4].text, "这个是啥知道么");
  assert.ok(!items.some((e: { kind: string }) => e.kind === "next"), "the fallback next time and the schedule fix are not shown");
});

test("the sentence of a look loses the old lead; what was only said in one look is not a change; the two days are headed", () => {
  const { state } = story();
  const { items } = eventsFor(state);
  assert.equal(items[3].text, "这是一张功能单，现在在等审核。");
  assert.equal(items[0].day, "昨天 · 11-03 周二");
  assert.equal(items[0].whenFull, "11-03 周二 16:00:48");
  const today = eventsFor(state, { now: Date.parse("2026-11-03T16:31:00+08:00") }).items;
  assert.equal(today[0].day, "今天 · 11-03 周二");
  assert.equal(today[0].when, "30 分钟前", "within the hour it is how long ago, later it is the time of day");
  assert.equal(whenOf(Date.parse(day3("16:00:48")), Date.parse(day3("16:00:50")), "Asia/Shanghai"), "刚刚");
});

test("no change is worked out from what was read, not from the look's own word: the same thing read with the number written as text is the same thing", () => {
  const { state } = story();
  const { items } = eventsFor(state);
  const last = items[0];
  assert.equal(last.calm, true);
  assert.equal(last.next, "下次 今天 9:00", "the time of the next look is told on the latest look only");
  assert.equal(items[3].next, undefined);
  assert.equal(last.changed, false);
  assert.deepEqual(last.basis.rows.map((r: { name: string; state: string }) => [r.name, r.state]), [["易协作 #555001", "same"], ["外网版本", "same"]]);
  assert.equal(items[5].changed, true, "the first look counts as news");
  assert.equal(items[1].changed, false, "a look that read nothing has no answer: it is neither a change nor no change");
  assert.equal(sourceKey("slots", { itemNo: 555001, want: ["a"] }), sourceKey("slots", { itemNo: "555001", want: ["b"] }));
  assert.notEqual(sourceKey("slots", { itemNo: 555001 }), sourceKey("slots", { itemNo: 555002 }));
  // a changed value is a change
  const changed = story();
  const lines = changed.state.lines.map((l: any) => (l.seq === 25 ? { ...l, value: { ...slots, ios: { now: 64400, since: [64400] } } } : l));
  assert.equal(eventsFor({ ...changed.state, lines }).items[0].changed, true);
  assert.equal(eventsFor({ ...changed.state, lines }).items[0].sub, "有变化");
});

test("a look of one reading names its sources by what a person calls them; the affair's own ticket opens", () => {
  const { state } = story();
  const first = eventsFor(state).items[5];
  assert.deepEqual(first.basis.rows.map((r: { name: string; href?: string }) => [r.name, r.href]), [["易协作 #555001", "https://pm.example.invalid/issues/555001"], ["外网版本", undefined]]);
  assert.equal(first.basis.next, "今天 10:30 · 出包要几天");
});

test("his picture is a row of his with a file to open; a file that is not in the folder is not offered", () => {
  const { state } = story();
  const row = eventsFor(state).items[2];
  assert.equal(row.yours, true);
  assert.equal(row.bubble, true);
  assert.deepEqual(row.files, [{ name: "20261103-111416-图片.png", shown: "图片.png", image: true, path: "C:/data/affairs/555001/files/20261103-111416-图片.png" }]);
  const dir = dirWithReaders();
  const policy = policyOf(dir);
  const lc = linkContext(policy as never, state.link);
  const gone = eventsOf(state, NOW, policy as never, lc, { labelOf: namesOf(policy as never, state, lc).labelOf, fileAt: () => null }).items[2];
  assert.deepEqual(gone.files, []);
});

test("looks that saw nothing new, one after another, are one row; a word of his in between keeps them apart", () => {
  const quiet = (at: string, entry: string) => [[at, "wake", { why: ["time"] }], [sec(at, 10), "read", { tool: "ticket", args: { id: 555001 }, ok: true, value: ticket, summary: "等待审核" }], [sec(at, 30), "report", look({ entry })], [sec(at, 40), "wake.end", { state: "ok" }]] as Array<[string, string, Record<string, unknown>]>;
  const head: Array<[string, string, Record<string, unknown>?]> = [[day3("09:00:00"), "created", { id: "555001", title: "#555001", link: "gcp:555001" }], [day3("09:00:00"), "said", { text: "盯一下", via: "chat", by: "user" }]];
  const run = (middle: Array<[string, string, Record<string, unknown>?]> = []) => {
    const lines = make([...head, ...quiet(day3("09:10:00"), "还在等审核。"), ...quiet(day3("10:10:00"), "还是在等审核。"), ...middle, ...quiet(day3("12:10:00"), "仍在等审核。"), ...quiet(day3("14:10:00"), "依旧在等审核。")]);
    return eventsFor({ ...fold(lines as never), lines });
  };
  const joined = run().items;
  // the first look is news (first), the three after it saw nothing new
  assert.deepEqual(joined.map((e: { label: string; sub: string }) => [e.label, e.sub]), [["看了 3 次", "都没变化"], ["看了一眼", "第一次"], ["你", "交代了这件事"]]);
  assert.equal(joined[0].text, "依旧在等审核。", "the latest one speaks");
  assert.deepEqual(joined[0].children.map((c: { text: string }) => c.text), ["依旧在等审核。", "仍在等审核。", "还是在等审核。"], "each is listed, newest first");
  assert.equal(joined[0].when, "10:10–14:10");
  const split = run([[day3("11:00:00"), "said", { text: "别忘了周五", via: "workspace", by: "user" }]]).items;
  assert.deepEqual(split.map((e: { label: string }) => e.label), ["看了 2 次", "你", "看了一眼", "看了一眼", "你"]);
  assert.equal(split[0].label, "看了 2 次");
  assert.equal(split[1].label, "你");
  assert.equal(split[2].label, "看了一眼");
});

test("the same failure again and again is one row, and one failed look is one row (its end and its note on it are not two)", () => {
  const fail = (at: string) => [[at, "wake", { why: ["time"] }], [sec(at, 30), "wake.end", { state: "failed" }], [sec(at, 31), "flag", { what: "look", detail: "内部出错 stack trace at x.mjs:1" }]] as Array<[string, string, Record<string, unknown>]>;
  const lines = make([[day3("09:00:00"), "created", { id: "555001", title: "#555001", link: "gcp:555001" }], ...fail(day3("10:00:00")), ...fail(day3("12:00:00")), ...fail(day3("14:00:00"))]);
  const items = eventsFor({ ...fold(lines as never), lines }).items;
  assert.deepEqual(items.map((e: { label: string; sub: string }) => [e.label, e.sub]), [["出错", "连着 3 次"]]);
  assert.equal(items[0].tone, "red");
  assert.equal(items[0].text, "这次没看成，过一会儿会再试", "what a machine wrote is not shown");
  assert.equal(items[0].children.length, 3);
});

test("a reading that failed in a look is a failure of its source, by the name a person knows it by", () => {
  const lines = make([
    [day3("09:00:00"), "created", { id: "555001", title: "#555001", link: "gcp:555001" }],
    [day3("10:00:00"), "wake", { why: ["time"] }],
    [day3("10:00:05"), "read", { tool: "slots", args: { itemNo: 555001 }, ok: false, reason: "连不上" }],
    [day3("10:00:30"), "wake.end", { state: "ok" }],
  ]);
  const [row] = eventsFor({ ...fold(lines as never), lines }).items;
  assert.equal(row.label, "出错");
  assert.equal(row.text, "外网版本读不到：连不上");
});

test("his answer, a question still open, what the chat noted, a time moved after he asked, done: each is a row of its own kind", () => {
  const lines = make([
    [day3("09:00:00"), "created", { id: "555001", title: "#555001", link: "gcp:555001" }],
    [day3("09:00:00"), "said", { text: "盯一下", via: "chat", by: "user" }],
    [day3("09:05:00"), "asked", { id: "555001-1", title: "外网版本读不到了", line: "", options: ["好了", "不用盯了"] }],
    [day3("09:06:00"), "answered", { id: "555001-1", answer: "好了", via: "panel" }],
    [day3("09:10:00"), "asked", { id: "555001-2", title: "11-06 再看，可以吗？", line: "", options: ["可以"] }],
    [day3("09:11:00"), "note", { by: "chat", text: "他说周五前要有结果" }],
    [day3("09:12:00"), "next", { next: "2026-11-06T09:00:00+08:00", waitingFor: "等你", why: "你说先放一放", verdict: "recorded", source: "user", detail: "" }],
    [day3("09:13:00"), "next", { next: "2026-11-09T09:00:00+08:00", waitingFor: "等审核", why: "审核慢", verdict: "appeal", source: "look", detail: "审核通常要一周" }],
    [day3("09:14:00"), "status", { status: "done", evidence: "外网都带上了", by: "look" }],
  ]);
  const state = { ...fold(lines as never), lines };
  Object.assign(state, { deadlines: [{ at: "2026-11-05T18:00:00+08:00", from: "said:2", quote: "x", seq: 1 }] });
  const items = eventsFor(state).items;
  assert.deepEqual(items.map((e: { kind: string }) => e.kind), ["done", "next", "next", "note", "asked", "answered", "said"]);
  assert.equal(items[0].label, "办完了 ✓");
  assert.equal(items[1].label, "下次改到 11-09");
  assert.equal(items[1].sub, "比单子上的 11-05 晚");
  assert.equal(items[1].meta, "不对就说「改回 11-05」");
  assert.equal(items[1].tone, "warn");
  assert.equal(items[2].label, "先放到 11-06");
  assert.equal(items[4].label, "要你定", "the question still open is shown; the one answered is only his answer");
  assert.deepEqual([items[5].label, items[5].sub, items[5].meta], ["你", "答了「好了」", "问的是：外网版本读不到了"]);
  assert.equal(items.filter((e: { kind: string }) => e.kind === "asked").length, 1);
});

test("a reply the chat handed in is a reply, with its own kind", () => {
  const lines = make([
    [day3("09:00:00"), "created", { id: "555001", title: "#555001", link: "gcp:555001" }],
    [day3("09:00:00"), "said", { text: "盯一下", via: "chat", by: "user" }],
    [day3("09:30:00"), "report", { from: "chat", verdict: "pass", attempt: 1, entry: "改到周五再看。", status: "x" }],
  ]);
  const [row] = eventsFor({ ...fold(lines as never), lines }).items;
  assert.deepEqual([row.kind, row.label, row.text], ["reply", "回你", "改到周五再看。"]);
});

test("a reading that says what it said before is not news; the first and each change are", () => {
  const read = (at: string, hash: string, summary: string) => [at, "watch.read", { id: "w1", ok: true, value: { n: 1 }, summary, hash, changed: false }] as [string, string, Record<string, unknown>];
  const lines = make([
    [day3("09:00:00"), "created", { id: "555001", title: "#555001", link: "gcp:555001" }],
    [day3("09:01:00"), "watch", { id: "w1", watch: { tool: "slots", args: {}, label: "" } }],
    read(day3("09:02:00"), "a", "外网最高 64464"),
    read(day3("10:02:00"), "a", "外网最高 64464"),
    read(day3("11:02:00"), "b", "外网最高 64500"),
    read(day3("12:02:00"), "b", "外网最高 64500"),
  ]);
  const items = eventsFor({ ...fold(lines as never), lines }).items;
  assert.deepEqual(items.map((e: { label: string; sub: string; text: string }) => [e.label, e.sub, e.text]), [["读到 · 外网版本", "有变化", "外网最高 64500"], ["读到 · 外网版本", "", "外网最高 64464"]]);
});

test("a day's rows are at most 50, the newest ones; the count says how many there are", () => {
  const spec: Array<[string, string, Record<string, unknown>?]> = [[day3("00:00:00"), "created", { id: "555001", title: "#555001", link: "gcp:555001" }]];
  for (let i = 0; i < 60; i++) spec.push([`2026-11-03T${String(1 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00+08:00`, "said", { text: `第 ${i} 句`, via: "workspace", by: "user" }]);
  const lines = make(spec);
  const out = eventsFor({ ...fold(lines as never), lines });
  assert.equal(out.items.length, 50);
  assert.equal(out.total, 60);
  assert.equal(out.items[0].text, "第 59 句");
});

test("what a person reads in the rows names no machinery, and the whole panel is what the screen's schema takes", async () => {
  const { state } = story();
  const { items } = eventsFor(state);
  const texts = items.flatMap((e: any) => [e.label, e.sub, e.text, e.meta ?? "", e.next ?? "", e.day, e.when, ...(e.basis ? [...e.basis.rows.flatMap((r: any) => [r.name, r.text]), e.basis.next ?? "", e.basis.asked ?? ""] : []), ...(e.children ?? []).map((c: any) => c.text)]);
  for (const t of texts) assert.doesNotMatch(t, MECHANISM, t);
  const w = world({ policy: { links: { gcp: "https://pm.example.invalid/issues/{ref}" }, linkHash: "gcp" } });
  const dir = path.join(w.root, "555001");
  mkdirSync(path.join(dir, "files"), { recursive: true });
  const s = { ...state, id: "555001", status: "watching" };
  const panel = panelOf(w.root, s, NOW, w.ctx.policy, linkContext(w.ctx.policy, "gcp:555001"));
  assert.doesNotThrow(() => panelSchema.parse(panel));
  assert.equal(panel.events.items.length, 7);
});

test("a look that could not be asked for and was started a moment later did not fail; one that was not started did", () => {
  const head: Array<[string, string, Record<string, unknown>?]> = [[day3("09:00:00"), "created", { id: "555001", title: "#555001", link: "gcp:555001" }], [day3("09:00:00"), "said", { text: "盯一下", via: "chat", by: "user" }]];
  const flag = (at: string): [string, string, Record<string, unknown>] => [at, "flag", { what: "look", detail: "paseo 说它在跑（留给正在看的那次）" }];
  const started = make([...head, flag(day3("10:00:00")), [day3("10:00:04"), "wake", { why: ["time"] }], [day3("10:00:50"), "wake.end", { state: "ok" }]]);
  assert.deepEqual(eventsFor({ ...fold(started as never), lines: started }).items.map((e: { kind: string }) => e.kind), ["said"]);
  const lost = make([...head, flag(day3("10:00:00")), [day3("13:00:00"), "wake", { why: ["time"] }], [day3("13:00:50"), "wake.end", { state: "ok" }]]);
  assert.deepEqual(eventsFor({ ...fold(lost as never), lines: lost }).items.map((e: { kind: string }) => e.kind), ["error", "said"]);
});

test("a run of quiet looks that began on an earlier day says so in its time range", () => {
  const quiet = (day: string, clockAt: string): Array<[string, string, Record<string, unknown>?]> => [
    [`${day}T${clockAt}:00+08:00`, "wake", { why: ["time"] }],
    [`${day}T${clockAt}:10+08:00`, "read", { tool: "ticket", args: { id: 555001 }, ok: true, value: ticket, summary: "等待审核" }],
    [`${day}T${clockAt}:30+08:00`, "report", look({ entry: "还在等审核。" })],
    [`${day}T${clockAt}:40+08:00`, "wake.end", { state: "ok" }],
  ];
  const lines = make([[day3("09:00:00"), "created", { id: "555001", title: "#555001", link: "gcp:555001" }], [day3("09:00:00"), "said", { text: "盯一下", via: "chat", by: "user" }], ...quiet("2026-11-03", "10:00"), ...quiet("2026-11-03", "16:00"), ...quiet("2026-11-04", "07:00")]);
  const [row] = eventsFor({ ...fold(lines as never), lines }).items;
  assert.equal(row.label, "看了 2 次", "the first of the three is the first look; the two after it saw nothing new");
  assert.equal(row.when, "昨天 16:00–7:00");
  assert.equal(row.day, "今天 · 11-04 周三");
});
