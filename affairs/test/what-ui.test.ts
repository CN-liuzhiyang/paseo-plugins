import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function mount(openFile?: (input: { workspaceId: string; path: string }) => void) {
  const exports: any = {};
  const states: any[] = [];
  let cursor = 0;
  const requests: any[] = [];
  runInNewContext(ts.transpileModule(readFileSync(new URL("../client/files.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports,
    require: (name: string) => name === "react/jsx-runtime" ? require(name) : name === "react-native" ? { View: "View", Pressable: "Pressable" } : name === "react" ? {
      useState: (initial: any) => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (value: any) => { states[i] = value; }]; },
      useRef: (current: any) => ({ current }), useCallback: (f: any) => f,
    } : name === "@getpaseo/plugin/client" ? { useRpc: () => (input: any) => { requests.push(input); return Promise.resolve({}); } } : name === "./text" ? { Words: "Words" } : {},
  });
  const what = { text: "一段很长的事项说明。".repeat(20), path: "/workspace/sample/README.md" };
  return {
    what, requests,
    render() {
      cursor = 0;
      const files = exports.useFiles("workspace-sample", openFile);
      return exports.What({ what, files, c: { surface1: "surface", foreground: "text", accent: "accent" } });
    },
  };
}

test("clicking the introduction opens its README through the shared workspace file opener", () => {
  const opened: any[] = [];
  const ui = mount((input) => opened.push(input));
  const block = ui.render();
  assert.equal(block.props.children[0].props.numberOfLines, 3);
  assert.equal(block.props.children[1].props.children, "README ›");
  block.props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ workspaceId: "workspace-sample", path: ui.what.path }]);
  assert.equal(ui.render().props.children[0].props.numberOfLines, 3);
  assert.equal(ui.requests.length, 0);
});

test("without openFile the whole block toggles full text inline without requesting a file", () => {
  const ui = mount();
  const block = ui.render();
  block.props.onPress();
  const expanded = ui.render();
  assert.equal(expanded.props.children[0].props.numberOfLines, undefined);
  assert.equal(expanded.props.children[0].props.children, ui.what.text);
  assert.equal(expanded.props.children[1].props.children, "收起");
  expanded.props.onPress();
  const collapsed = ui.render();
  assert.equal(collapsed.props.children[0].props.numberOfLines, 3);
  assert.equal(collapsed.props.children[1].props.children, "README ›");
  assert.equal(ui.requests.length, 0);
});
