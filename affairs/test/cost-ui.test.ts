import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { panelOf } from "../server/lib/panel.mjs";
import { linkContext } from "../server/lib/links.mjs";
import { world } from "./kit";

const require = createRequire(import.meta.url);
const walk = (node: any): any[] => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const textOf = (node: any): string => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(textOf).join("") : node?.props ? textOf(node.props.children) : "";
function render(budget: any) {
  const w = world();
  const panel = { ...panelOf(w.root, { id: "cost", title: "费用", status: "stopped", mode: "drive", modeExplicit: true, facts: [], flows: [], asks: [], lines: [] }, w.now(), w.ctx.policy, linkContext(w.ctx.policy, null)), budget };
  const exports: any = {};
  let cursor = 0;
  runInNewContext(ts.transpileModule(readFileSync(new URL("../client/panel.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports,
    require: (name: string) => name === "react/jsx-runtime" ? require(name) : name === "react-native" ? { View: "View", ScrollView: "ScrollView" } : name === "react" ? {
      useState: (initial: any) => [++cursor === 3 ? panel : initial, () => {}], useEffect: () => {},
    } : name === "@getpaseo/plugin/client" ? { useRpc: () => async () => ({}) } : name === "./files" ? { useFiles: () => ({}), What: "What", Materials: "Materials" } : name === "../shared/look" ? { tint: () => "tint" } : new Proxy({}, { get: (_, key) => String(key) }),
  });
  return walk(exports.Panel({ theme: { colors: {} }, workspaceId: "fixture" }));
}

test("actual panel budget row marks estimates and retains the unknown-session count", () => {
  const nodes = render({ usd: 1.25, cap: 5, unknown: 2, estimated: true });
  assert.ok(nodes.some((n) => n.type === "Words" && textOf(n) === "$1.25（含估算） / $5"));
  assert.ok(nodes.some((n) => n.type === "Words" && textOf(n) === "另 2 个会话花费不明"));
});

test("actual panel budget row accepts old payloads and keeps zero as a known amount", () => {
  const nodes = render({ usd: 0, cap: 5 });
  assert.ok(nodes.some((n) => n.type === "Words" && textOf(n) === "$0.00 / $5"));
  assert.ok(!nodes.some((n) => n.type === "Words" && /含估算|花费不明/.test(textOf(n))));
});
