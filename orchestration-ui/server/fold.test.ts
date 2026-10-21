import assert from "node:assert/strict";
import { test } from "node:test";
import { foldList, foldText, LIST_PREVIEW_ITEMS, TEXT_PREVIEW_CHARS, TEXT_PREVIEW_LINES } from "../client/fold";
import { clampDrawerWidth, DRAWER_MAX, DRAWER_MIN, GRAPH_MIN } from "../client/sizes";

const lines = (count: number, width = 20) => Array.from({ length: count }, (_, i) => `${i}`.padEnd(width, "x")).join("\n");

test("fold: short texts stay whole", () => {
  assert.equal(foldText("ok").folded, false);
  assert.equal(foldText(lines(8)).folded, false);
  assert.equal(foldText("x".repeat(600)).folded, false);
});

test("fold: a long patch shows its first lines, and says how long it is", () => {
  // The shape of a drafted patch in a real run: 80 lines, about 3000 characters.
  const patch = lines(80, 38);
  const fold = foldText(patch);
  assert.equal(fold.folded, true);
  assert.equal(fold.lines, 80);
  assert.equal(fold.chars, patch.length);
  assert.equal(fold.preview.split("\n").length, TEXT_PREVIEW_LINES);
  assert.ok(fold.preview.length <= TEXT_PREVIEW_CHARS + 1);
});

test("fold: one long line is cut by characters", () => {
  const fold = foldText("y".repeat(700));
  assert.equal(fold.folded, true);
  assert.equal(fold.lines, 1);
  assert.equal(fold.preview, `${"y".repeat(TEXT_PREVIEW_CHARS)}…`);
});

test("fold: lists over five items show three", () => {
  assert.deepEqual(foldList(5), { folded: false, shown: 5 });
  assert.deepEqual(foldList(20), { folded: true, shown: LIST_PREVIEW_ITEMS });
  assert.deepEqual(foldList(0), { folded: false, shown: 0 });
});

test("drawer width: kept within its limits and leaves the graph room", () => {
  assert.equal(clampDrawerWidth(100, 1600), DRAWER_MIN);
  assert.equal(clampDrawerWidth(5000, 3000), DRAWER_MAX);
  assert.equal(clampDrawerWidth(700, 1000), 1000 - GRAPH_MIN);
  assert.equal(clampDrawerWidth(500, 1600), 500);
  // A window too small for both: the drawer keeps its minimum rather than vanish.
  assert.equal(clampDrawerWidth(500, 500), DRAWER_MIN);
});
