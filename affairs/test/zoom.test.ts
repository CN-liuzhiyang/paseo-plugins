import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ZOOM_MAX, ZOOM_MIN, clampZoom, gapOf, zoomByPinch, zoomByWheel } from "../shared/zoom";

// A picture in the 资料 preview is pressed to be seen big, and pressed again to be put away: there is no 「放大看」 to look for.

const clientDir = path.resolve(import.meta.dirname, "../client");
const read = (f: string) => readFileSync(path.join(clientDir, f), "utf8");

test("no 「放大看」 anywhere the person can read, and the picture itself is what is pressed to enlarge", () => {
  for (const f of readdirSync(clientDir).filter((n) => /\.tsx?$/.test(n))) assert.ok(!read(f).includes("放大看"), `${f} still says 放大看`);
  const files = read("files.tsx");
  assert.match(files, /testID="preview-image"[^>]*onPress=\{\(\) => setBig\(true\)\}/, "pressing the preview's picture opens it big");
  assert.match(files, /\{big \? <Zoomed [^>]*onClose=\{\(\) => setBig\(false\)\}/, "and closing it puts it away");
  assert.match(files, /cursor: "pointer"/, "a hand over the picture, no words to say it can be pressed");
  assert.ok(!/["'`>]点[一击]下?放大|点击放大/.test(files), "no caption that tells how");
});

test("the big picture is put away by pressing the picture, the ground around it, or 关闭", () => {
  const zoom = read("zoom.tsx");
  for (const id of ["zoom-image", "zoom-backdrop", "zoom-close"]) assert.match(zoom, new RegExp(`testID="${id}"[^>]*onPress=\\{onClose\\}`), id);
  assert.match(zoom, /onRequestClose=\{onClose\}/, "the back button too");
  assert.match(zoom, /resizeMode="contain"/, "the whole picture is fitted to the screen at first");
  assert.match(zoom, /useState\(1\)/, "and starts at the whole picture");
  assert.match(zoom, /onWheel/);
  assert.match(zoom, /onTouchMove/);
});

test("the zoom stays between the whole picture and ZOOM_MAX: wheel and two fingers", () => {
  assert.equal(clampZoom(0.2), ZOOM_MIN);
  assert.equal(clampZoom(99), ZOOM_MAX);
  assert.equal(clampZoom(NaN), ZOOM_MIN);
  assert.ok(zoomByWheel(1, -100) > 1, "toward you is closer");
  assert.equal(zoomByWheel(1, 100), 1, "farther than the whole picture is still the whole picture");
  assert.ok(zoomByWheel(3, 100) < 3 && zoomByWheel(3, 100) > 1);
  assert.equal(zoomByWheel(ZOOM_MAX, -1000), ZOOM_MAX);
  assert.equal(zoomByPinch(1, 100, 200), 2);
  assert.equal(zoomByPinch(2, 100, 50), 1);
  assert.equal(zoomByPinch(4, 100, 1000), ZOOM_MAX);
  assert.equal(zoomByPinch(3, 0, 50), 3, "no gap to start from, no change");
  assert.equal(gapOf({ pageX: 0, pageY: 0 }, { pageX: 3, pageY: 4 }), 5);
});
