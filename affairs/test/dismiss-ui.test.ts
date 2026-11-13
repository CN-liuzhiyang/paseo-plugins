import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function mount(onClose: () => void) {
  const exports: any = {};
  const states: any[] = [];
  let cursor = 0;
  runInNewContext(ts.transpileModule(readFileSync(new URL("../client/look.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports,
    require: (name: string) => name === "react/jsx-runtime" ? require(name) : name === "react-native" ? { View: "View", Pressable: "Pressable", TextInput: "TextInput" } : name === "react" ? {
      useState: (initial: any) => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (value: any) => { states[i] = value; }]; },
    } : name === "./text" ? { Words: "Words" } : name === "../shared/look" ? { MOODS: {}, tint: () => "" } : {},
  });
  return { render: () => { cursor = 0; return exports.DismissAsk({ c: { foreground: "t", foregroundMuted: "m" }, onClose, testID: "d" }); } };
}

const find = (node: any, id: string): any => {
  if (!node || typeof node !== "object") return null;
  if (node.props?.testID === id) return node;
  for (const child of [node.props?.children].flat()) { const hit = find(child, id); if (hit) return hit; }
  return null;
};

test("closing a question takes two presses: the first only asks, the second closes; 再想想 goes back and closes nothing", () => {
  let closed = 0;
  const ui = mount(() => closed++);
  const link = ui.render();
  assert.equal(link.props.testID, "d");
  link.props.onPress();
  assert.equal(closed, 0, "the first press closes nothing");
  const sure = ui.render();
  assert.equal(find(sure, "d"), null, "the link is replaced by the question");
  find(sure, "d-no").props.onPress();
  assert.equal(closed, 0);
  ui.render().props.onPress();
  find(ui.render(), "d-yes").props.onPress();
  assert.equal(closed, 1);
  assert.equal(ui.render().props.testID, "d", "back to the link afterwards");
});
