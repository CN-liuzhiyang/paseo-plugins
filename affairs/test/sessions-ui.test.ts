import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const exports: any = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../client/sessions.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
  exports,
  require: (name: string) => name === "react/jsx-runtime" ? require(name) : name === "react-native" ? { View: "View", Pressable: "Pressable" } : name === "../shared/look" ? { tint: () => "tint" } : name === "./look" ? { Dot: "Dot", Tag: "Tag" } : name === "./text" ? { Words: "Words" } : {},
});
const walk = (node: any): any[] => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const sessions = [
  { agentId: "closed", title: "早先尝试", role: "派活", status: "已关闭" },
  { agentId: "done", title: "定位", role: "派活", status: "做完了", usd: 0.625 },
  { agentId: "running", title: "读取统计", role: "流程", status: "干活中" },
  { agentId: "waiting", title: "合入修复", role: "派活", status: "等你批" },
  { agentId: "main", title: "主对话", role: "主对话", status: "已关闭" },
  { agentId: "waiting-2", title: "确认版本", role: "派活", status: "等你批" },
  ...Array.from({ length: 7 }, (_, i) => ({ agentId: `done-${i}`, title: `检查 ${i}`, role: "派活", status: "做完了" })),
];
const render = (openAgent?: any) => walk(exports.Sessions({ sessions, c: {}, openAgent }));

test("sessions show the main conversation first, sort states stably and show every delegated session", () => {
  const nodes = render(() => {});
  const rows = nodes.filter((n) => n.props?.testID?.startsWith("session-"));
  assert.equal(rows.length, sessions.length);
  assert.deepEqual(rows.slice(0, 6).map((n) => n.props.testID), ["session-main", "session-waiting", "session-waiting-2", "session-running", "session-done", "session-done-0"]);
  assert.equal(rows.at(-1).props.testID, "session-closed");
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
