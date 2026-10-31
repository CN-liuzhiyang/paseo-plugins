import assert from "node:assert/strict";
import { test } from "node:test";
import { planText } from "../index.server";
import { passesOf } from "../server/desk";
import type { Status } from "../shared/status";
import type { World } from "./helpers";
import { assessed, chat, comes, fact, item, PERSONS, proposal, say, track, withDesk, pass } from "./desk-kit";

// The matters a person told, asked in their chat and answered there: the push of a question of a look, the answer by number, and
// plan.md (the questions waiting with their numbers, the list by group, and the last looks of a matter).

const MINE = { source: "chatapp", "chatapp-chat": "p2p:owner" };
const SAID = "帮我盯一下体检，月底前要约上";
const persons = () => PERSONS({ chats: [MINE], notify: [{ channel: "im", to: "p2p:owner", label: "IM" }] });
const quoted = (text: string, typed: string) => `[回复 机器人 的消息]\n${text}\n\n${typed}`;

/** A matter told in the admin's chat, looked at, and the look put a question. */
async function asked(w: World) {
  chat(w, MINE, SAID);
  say(w, track("-", "年度体检", "personal"));
  await w.engine.tick();
  comes(w, 1, 1, proposal({ status: "任务还没完成", question: "体检约上了吗？", options: ["已约上了", "还没约"] }));
  await pass(w, 10);
}
async function answerIn(w: World, message: string, ask: string) {
  chat(w, MINE, message);
  const id = say(w, { cmd: "answer", ask, said: "-" });
  await w.engine.tick();
  return w.receipt(id)!;
}

test("the push of a look's question: the matter and the question in the title, the look's status, the options numbered, the number last", () =>
  withDesk(
    async (w) => {
      await asked(w);
      assert.equal(w.deliveries.length, 1);
      assert.equal(w.deliveries[0]!.title, "年度体检（D1）：体检约上了吗？");
      assert.equal(w.deliveries[0]!.text, "年度体检：任务还没完成\n1 已约上了\n2 还没约\n3 过 3 天再看\n4 不用盯了\n（问题 D1-1）");
    },
    { persons: persons() },
  ));

test("answering 过 3 天再看 by its number: the look that was waiting is not asked for, the next one is three days on, and the page says it was answered in the chat", () =>
  withDesk(
    async (w) => {
      await asked(w);
      const receipt = await answerIn(w, quoted(w.deliveries[0]!.text, "3"), "D1-1");
      assert.equal(receipt.outcome, "applied");
      assert.equal(receipt.text, "好，D1-1 记下：过 3 天再看。");
      await pass(w, 5);
      assert.equal(w.flows.launcher.started.length, 1, "no look for an answer that costs none");
      assert.match(fact(w, 1, "next"), /^2026-10-16T10:00/);
      const history = w.engine.graph("desk:D1")!.history.map((h) => h.line);
      assert.ok(history.some((l) => /在对话里回答：过 3 天再看/.test(l)), history.join("\n"));
    },
    { persons: persons() },
  ));

test("answering with a sentence: the look that follows is told it, as it is when the answer is typed on a card", () =>
  withDesk(
    async (w) => {
      await asked(w);
      const receipt = await answerIn(w, quoted(w.deliveries[0]!.text, "还没约，打算下周一去约"), "D1-1");
      assert.equal(receipt.outcome, "applied");
      assert.match(receipt.text, /记下：「还没约，打算下周一去约」/);
      await pass(w, 5);
      assert.equal(w.flows.launcher.started.length, 2, "a look is asked for by the words");
    },
    { persons: persons() },
  ));

test("不用盯了 by its number ends the matter, as on the card; the chat does not need a second step", () =>
  withDesk(
    async (w) => {
      await asked(w);
      await answerIn(w, quoted(w.deliveries[0]!.text, "4"), "D1-1");
      await pass(w, 5);
      assert.equal(assessed(w, 1)!.stage, "dropped");
      assert.match(assessed(w, 1)!.headline, /^不盯了/);
    },
    { persons: persons() },
  ));

// ---- plan.md ------------------------------------------------------------------------------------------------------------

test("plan.md: the questions waiting with their numbers, then the list by group with who has the ball, and the last looks of a matter", () =>
  withDesk(
    async (w) => {
      await asked(w);
      const status = w.engine.status();
      const text = planText(status);
      assert.match(text, /^# 事项追踪（test，正式）\n/);
      assert.match(text, /\n## 没答的问题（1）\n答的时候用编号：推送最后一行「（问题 D1-1）」就是它；在聊天里答，让对话里的 agent 跑 `reconcile-say answer --ask <编号> --said -`。\n- D1-1 · 年度体检（D1）：体检约上了吗？ — 1 已约上了；2 还没约；3 过 3 天再看；4 不用盯了；或者自己写一句 · \d\d-\d\d \d\d:\d\d 问的\n/);
      assert.match(text, /\n## 要你做的（1）\n- D1 年度体检：任务还没完成（等你定：体检约上了吗？） · 你 · .+\n/);
      assert.match(text, /\n {2}- 热：/);
      assert.match(text, /\n {2}- 第 1 次看（\d\d-\d\d \d\d:\d\d）：读了飞书任务，没有预约记录 → 任务还没完成；下次 10-15 10:00\n/);
      assert.ok(text.indexOf("## 没答的问题") < text.indexOf("## 要你做的"), "what waits for the person comes first");
      assert.ok(text.indexOf("## 要你做的") < text.indexOf("## 这次检查打算做的"));
      assert.ok(!/^## 在等别人/m.test(text) && !/^## 系统盯着/m.test(text), "a group with nothing in it has no heading");
      assert.match(text, /\n冷的 0 个事项不判断、不显示。\n/);
    },
    { persons: persons() },
  ));

test("plan.md: answered, the question is gone from the list of waiting ones and the item goes where the page puts it", () =>
  withDesk(
    async (w) => {
      await asked(w);
      await answerIn(w, quoted(w.deliveries[0]!.text, "3"), "D1-1");
      await pass(w, 5);
      const text = planText(w.engine.status());
      assert.ok(!text.includes("## 没答的问题"));
      assert.ok(!/^## 要你做的/m.test(text), "nothing waits for the person now");
      assert.match(text, /\n## 系统盯着（1）\n- D1 年度体检：/);
    },
    { persons: persons() },
  ));

test("plan.md keeps the last three looks of a matter, oldest first, and nothing from a model is made into a heading or a link", () => {
  const log = JSON.stringify([1, 2, 3, 4, 5].map((n) => ({ n, at: `2026-10-1${n}T10:00:00+08:00`, looked: `读了第 ${n} 次\n## 假标题 [点这里](http://x.example)`, status: "还行", next: `2026-10-2${n} 10:00` })));
  assert.deepEqual(passesOf(log, 3).map((p) => p.n), [3, 4, 5]);
  assert.deepEqual(passesOf("not json", 3), []);
  assert.deepEqual(passesOf(undefined, 3), []);
  const base = {
    instanceId: "x",
    mode: "live" as const,
    lastTickAt: null,
    sources: [],
    problems: [],
    plan: [],
    flows: [],
    said: [],
    cold: [],
    questions: [],
    cases: [{ caseId: "desk:D1", title: "体检", url: null, status: "open", closed: false, observedAt: "", assessment: null, commitments: [], open: false, hot: ["a"], row: null, passes: passesOf(log, 3) }],
  } as unknown as Status;
  const text = planText(base);
  const passLines = text.split("\n").filter((l) => /^ {2}- 第 \d 次看/.test(l));
  assert.equal(passLines.length, 3);
  assert.match(passLines[0]!, /第 3 次看（10-13 10:00）：读了第 3 次 \\#\\# 假标题 \\\[点这里\\\]\\\(http:\/\/x\.example\\\)/);
  assert.ok(!/^## 假标题/m.test(text));
  assert.match(text, /\n## 没分组的（1）\n- desk:D1 体检：（还没判断）\n/);
});
