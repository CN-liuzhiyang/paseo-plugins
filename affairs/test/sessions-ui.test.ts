import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { sessionWhen } from "../shared/time.mjs";
const now = new Date(2026, 10, 9, 14).getTime();
const at = (h: number, m = 0, day = 9) => new Date(2026, 10, day, h, m).toISOString();

const require = createRequire(import.meta.url);
const exports: any = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../client/sessions.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
  exports,
  require: (name: string) => name === "react/jsx-runtime" ? require(name) : name === "react-native" ? { View: "View", Pressable: "Pressable" } : name === "../shared/time.mjs" ? { sessionWhen: (at: string) => sessionWhen(at, now) } : name === "../shared/look" ? { tint: () => "tint" } : name === "./look" ? { Dot: "Dot", Tag: "Tag" } : name === "./text" ? { Words: "Words" } : {},
});
const walk = (node: any): any[] => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const sessions = [
  { agentId: "closed", title: "早先尝试", role: "派活", status: "做完了", at: at(10) },
  { agentId: "done", title: "定位", role: "派活", status: "做完了", at: at(11), usd: 0.625 },
  { agentId: "running", title: "读取统计", role: "流程", status: "干活中", at: at(13, 55) },
  { agentId: "waiting", title: "合入修复", role: "派活", status: "等你批", at: at(13, 45) },
  { agentId: "main", title: "主对话", role: "主对话", status: "做完了", at: at(13, 40) },
  { agentId: "error", title: "修复检查", role: "派活", status: "出错", at: at(13) },
  { agentId: "waiting-2", title: "确认版本", role: "派活", status: "等你批", at: at(13, 50) },
  ...Array.from({ length: 7 }, (_, i) => ({ agentId: `done-${i}`, title: `检查 ${i}`, role: "派活", status: "做完了", at: at(9, 0, 8) })),
];
const render = (openAgent?: any) => walk(exports.Sessions({ sessions, c: { foreground: "foreground", statusSuccess: "success", statusDanger: "danger", surface0: "surface" }, openAgent }));

test("sessions show the main conversation first, sort by urgency and latest activity and show every delegated session", () => {
  const nodes = render(() => {});
  const rows = nodes.filter((n) => n.props?.testID?.startsWith("session-"));
  assert.equal(rows.length, sessions.length);
  assert.deepEqual(rows.slice(0, 7).map((n) => n.props.testID), ["session-main", "session-waiting-2", "session-waiting", "session-error", "session-running", "session-done", "session-closed"]);
  assert.equal(rows.at(-1).props.testID, "session-done-6");
  assert.ok(nodes.some((n) => n.props?.children === "$0.63"));
  const title = nodes.find((n) => n.props?.children === "早先尝试");
  assert.equal(title.props.numberOfLines, 1);
});

test("the entire session row opens its agent and an older host keeps a plain row without a chevron", () => {
  const opened: string[] = [];
  const nodes = render(({ agentId }: any) => opened.push(agentId));
  const row = nodes.find((n) => n.props?.testID === "session-running");
  assert.equal(row.type, "Pressable");
  row.props.onPress();
  assert.deepEqual(opened, ["running"]);
  const plain = render();
  assert.ok(plain.filter((n) => n.props?.testID?.startsWith("session-")).every((n) => n.type === "View" && !n.props.onPress));
  assert.equal(plain.filter((n) => n.props?.children === "›").length, 0);
  assert.ok(plain.some((n) => n.props?.children === "读取统计"));
});

test("session rows show completion checks, danger marks and activity with and without cost", () => {
  const nodes = render();
  const row = (id: string) => walk(nodes.find((n) => n.props?.testID === `session-${id}`));
  assert.ok(row("closed").some((n) => n.props?.children === "✓" && n.props.style.color === "success"));
  assert.equal(row("closed").find((n) => n.props?.children === "早先尝试").props.style.color, "foreground");
  assert.ok(row("error").some((n) => n.props?.children === "✕"));
  assert.ok(row("error").some((n) => n.props?.text === "出错" && n.props.color === "danger"));
  assert.ok(row("done").some((n) => n.props?.children === "$0.63"));
  assert.ok(row("done").some((n) => n.props?.children === "3 小时前"));
  assert.ok(row("running").some((n) => n.props?.children === "5 分钟前"));
  assert.ok(row("done-0").some((n) => n.props?.children === "11-08"));
  assert.ok(!nodes.some((n) => String(n.props?.children).includes("花费不明")));
});

test("session summaries count each active state and all completed sessions use a success dot", () => {
  const c = { statusWarning: "warning", statusDanger: "danger", accent: "accent", statusSuccess: "success" };
  const nodes = walk(exports.SessionSummary({ sessions, c }));
  assert.deepEqual(nodes.filter((n) => n.type === exports.SessionPill).map((n) => [n.props.text, n.props.color]), [["2 等你批", "warning"], ["1 出错", "danger"], ["1 干活中", "accent"]]);
  const done = walk(exports.SessionSummary({ sessions: sessions.filter((s) => s.status === "做完了"), c }));
  assert.ok(done.some((n) => n.props?.children === "都做完了"));
  assert.ok(done.some((n) => n.type === "Dot" && n.props.color === "success"));
  const errorOnly = walk(exports.SessionSummary({ sessions: sessions.filter((s) => s.status === "出错"), c }));
  assert.ok(errorOnly.some((n) => n.props?.text === "1 出错"));
  assert.ok(!errorOnly.some((n) => n.props?.children === "都做完了"));
});

test("session time changes to the month and day at local midnight", () => {
  assert.equal(sessionWhen(at(13, 59), now), "1 分钟前");
  assert.equal(sessionWhen(at(11), now), "3 小时前");
  assert.equal(sessionWhen(at(23, 59, 8), new Date(2026, 10, 9, 0, 1).getTime()), "11-08");
  assert.equal(sessionWhen("invalid", now), "");
});
