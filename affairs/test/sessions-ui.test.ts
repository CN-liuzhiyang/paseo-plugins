import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

test("related session rows open their own agent, expand after eight and hide navigation on older hosts", () => {
  const panel = { sessions: Array.from({ length: 11 }, (_, i) => ({ agentId: `a-${i}`, title: `长标题${"目录".repeat(20)} ${i}`, role: "派活", status: "做完了", project: "代码项目", usd: 0.012 })), asks: [], steps: ["下一步"], waiting: { text: "等结果" }, now: { text: "" }, next: { text: "" }, facts: [], events: { items: [] }, sources: { items: [] }, materials: { items: [] } };
  const values: any[] = [false, "", panel, false, false];let cursor = 0;
  const hooks = { useEffect() {}, useState(initial: any) { const index = cursor++;return [values[index] ?? initial, (v: any) => { values[index] = v; }]; } };
  const require = createRequire(import.meta.url);
  const exports: any = {};
  const source = readFileSync(new URL("../client/panel.tsx", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports,
    require: (name: string) => name === "react" ? hooks : name === "react/jsx-runtime" ? require(name) : name === "react-native" ? { View: "View", Pressable: "Pressable", ScrollView: "ScrollView" } : name === "@getpaseo/plugin/client" ? { useRpc: () => () => {} } : name === "./files" ? { useFiles: () => ({}), Materials: "Materials" } : name === "./look" ? { Heading: "Heading" } : name === "./text" ? { Words: "Words" } : {},
  });
  const walk = (node: any): any[] => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
  const opened: string[] = [];
  const render = (navigation?: any) => { cursor = 0;return walk(exports.Panel({ theme: { colors: {} }, workspaceId: "w", navigation })); };
  const navigation = { openAgent: ({ agentId }: any) => opened.push(agentId) };
  let nodes = render(navigation);
  const buttons = (items: any[]) => items.filter((n) => n.type === "Pressable" && n.props.accessibilityLabel?.startsWith("打开 "));
  assert.equal(buttons(nodes).length, 8);
  buttons(nodes)[3].props.onPress();assert.deepEqual(opened, ["a-3"]);
  const toggle = nodes.find((n) => n.type === "Pressable" && walk(n).some((child) => child.props?.children === "看全部 11 条 ›"));
  assert.ok(toggle);toggle.props.onPress();nodes = render(navigation);assert.equal(buttons(nodes).length, 11);
  assert.ok(nodes.some((n) => n.props?.children === "收起 ›"));
  assert.ok(nodes.some((n) => n.props?.children === "派活 · 做完了 · 代码项目 · $0.012"));
  assert.equal(buttons(render()).length, 0);
  assert.equal(render().filter((n) => n.props?.children === panel.sessions[10].title).length, 1, "text remains without navigation");
  const row = nodes.find((n) => n.type === "View" && n.props.children?.[0]?.props.children?.[0]?.props.children === panel.sessions[0].title);
  assert.equal(row.props.children[0].props.style.flex, 1);assert.equal(row.props.children[0].props.style.minWidth, 0);assert.equal(row.props.children[1].props.style.flexShrink, 0);
});
