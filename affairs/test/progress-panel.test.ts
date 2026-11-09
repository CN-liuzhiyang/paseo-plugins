import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { panelOf, progressOf, sourcesOf } from "../server/lib/panel.mjs";
import { budgetOf, budgetText } from "../server/lib/drive.mjs";
import { stepLines } from "../server/lib/steps.mjs";
import { linkContext } from "../server/lib/links.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { world } from "./kit";

const lc = linkContext(DEFAULT_POLICY as never, null);
const checklist = ["定位", "修复", "观察", "收口"].map((title, i) => ({ id: String(i + 1), title, state: i < 2 ? "done" : i === 2 ? "now" : "todo", who: "agent" }));

test("enumerated and ranged facts join only their first step, stripping prefixes while preserving content and links", () => {
  const state = { mode: "watch", modeExplicit: true, stepRead: { steps: checklist }, facts: ["第 1、2 步： 已完成 doc:change；保留：正文  空格", "第 3–4 步先观察", "保留原始数据", "第 9 步待补"] };
  const result = progressOf(state, DEFAULT_POLICY, linkContext({ links: { doc: "https://example.com/{ref}" } }, null));
  assert.deepEqual(result.stepList.map((s: any) => s.notes.length), [1, 0, 1, 0]);
  assert.equal(result.stepList[0].notes[0].text, "已完成 doc:change；保留：正文  空格");
  assert.deepEqual(result.stepList[0].notes[0].parts, [{ text: "已完成 " }, { text: "doc:change", href: "https://example.com/change" }, { text: "；保留：正文  空格" }]);
  assert.equal(result.stepList[2].notes[0].text, "先观察");
  assert.deepEqual(result.facts.map((f: any) => f.text), state.facts.slice(2));
});

test("without a checklist, numbered facts form numbered nodes in appearance order and terminal states mark them done", () => {
  for (const status of ["watching", "done", "stopped"]) {
    const result = progressOf({ mode: "watch", modeExplicit: true, status, facts: ["第 3 步观察", "第 1、2 步修复", "第 5-6 步验证", "普通记录"] }, DEFAULT_POLICY, lc);
    assert.deepEqual(result.stepList.map((s: any) => s.number), [3, 1, 5]);
    assert.deepEqual(result.stepList.map((s: any) => s.notes[0].text), ["观察", "修复", "验证"]);
    assert.ok(result.stepList.every((s: any) => s.state === (status === "watching" ? "todo" : "done")));
    assert.deepEqual(result.facts, [{ text: "普通记录" }]);
  }
});

test("drive uses the README checklist; a stopped or done affair never asks for missing README steps", () => {
  const w = world();
  const policy = { ...DEFAULT_POLICY, workDir: w.dir };
  const state = { id: "sample", mode: "drive", modeExplicit: true, status: "watching", facts: ["第 1 步已提交"] };
  assert.match(stepLines(state, w.now(), policy).join(" "), /README/);
  for (const status of ["stopped", "done"]) assert.deepEqual(stepLines({ ...state, status }, w.now(), policy), []);
  mkdirSync(path.join(w.dir, state.id));
  writeFileSync(path.join(w.dir, state.id, "README.md"), "## 步骤\n- [x] 定位\n- [ ] 修复\n");
  const result = progressOf(state, policy, lc);
  assert.deepEqual(result.stepList.map((s: any) => [s.title, s.state]), [["定位", "done"], ["修复", "todo"]]);
  assert.equal(result.stepList[0].notes[0].text, "已提交");
});

test("source failure tone comes from lastError and successful readings stay neutral", () => {
  const result = sourcesOf({ facts: [], watches: { a: { label: "崩溃统计", lastError: "HTTP 403", summary: "上次统计" }, b: { label: "单子", summary: "已关闭" } } }, Date.now(), DEFAULT_POLICY, lc);
  assert.equal(result.items[0].tone, "bad");
  assert.equal(result.items[0].status, "读不到");
  assert.equal(result.items[0].full, "HTTP 403");
  assert.equal(result.items[1].tone, undefined);
});

test("the panel budget and budget text share spend totals, cap and unknown count", () => {
  const w = world();
  const state = { id: "sample", title: "修复", status: "stopped", mode: "drive", modeExplicit: true, facts: [], flows: [], asks: [], lines: [{ kind: "chat.turn", agentId: "a", usd: 1.25 }, { kind: "chat.turn", agentId: "b", unknown: true }], budget: { usd: 5 } };
  const result = panelOf(w.root, state, w.now(), w.ctx.policy, lc);
  assert.deepEqual(result.budget, { usd: 1.25, cap: 5, unknown: 1 });
  assert.deepEqual(result.budget, budgetOf({}, state));
  assert.equal(result.spent, budgetText({}, state));
  assert.deepEqual(result.steps, []);
  const uncapped = panelOf(w.root, { ...state, budget: undefined }, w.now(), w.ctx.policy, lc);
  assert.deepEqual(uncapped.budget, { usd: 1.25, unknown: 1 });
});
