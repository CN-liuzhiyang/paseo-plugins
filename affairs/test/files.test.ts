import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PICTURE_BYTES, materialFile, materialsOf } from "../server/lib/panel.mjs";
import { listReaders } from "../server/lib/readers.mjs";
import { rowsOf } from "../server/lib/view.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { scratch, world } from "./kit";

// The 资料 block and the file the panel asks for: only the affair's own folder, a picture as data (not a huge one), a text as its first part.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function setup() {
  const root = scratch("affairs-files-");
  const dir = path.join(root, "D1", "files");
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

test("a file of the folder: a picture comes as data, a text is cut at 20000, anything else says what it is; a path or a folder or a missing name is refused", () => {
  const { root, dir } = setup();
  writeFileSync(path.join(dir, "a.png"), PNG);
  writeFileSync(path.join(dir, "n.md"), "字".repeat(25_000));
  writeFileSync(path.join(dir, "z.zip"), Buffer.from([80, 75, 0, 0, 1, 2]));
  writeFileSync(path.join(dir, "big.png"), Buffer.alloc(PICTURE_BYTES + 1, 1));
  const img = materialFile(root, "D1", "a.png");
  assert.deepEqual([img.ok, img.kind, img.mime, img.truncated], [true, "image", "image/png", false]);
  assert.match(img.dataUrl!, /^data:image\/png;base64,/);
  assert.ok(img.path.endsWith("/D1/files/a.png") && !img.path.includes("\\"));
  const text = materialFile(root, "D1", "n.md");
  assert.deepEqual([text.kind, text.text!.length, text.truncated], ["text", 20_000, true]);
  assert.deepEqual([materialFile(root, "D1", "z.zip").kind, materialFile(root, "D1", "z.zip").text], ["other", undefined]);
  const big = materialFile(root, "D1", "big.png");
  assert.deepEqual([big.ok, big.kind, big.dataUrl, big.truncated], [true, "image", undefined, true], "a picture over 3 MB is not sent to be drawn");
  mkdirSync(path.join(dir, "子目录"));
  writeFileSync(path.join(root, "D1", "log.jsonl"), "secret");
  for (const name of ["../log.jsonl", "..\\log.jsonl", "子目录", "nope.png", "", "/etc/passwd", path.join(root, "D1", "log.jsonl")]) assert.equal(materialFile(root, "D1", name).ok, false, name);
});

test("a row of the files: the name without the folder's time, the size and when, who gave it, and what to draw; two of one name are told apart by the time", () => {
  const w = world();
  const dir = path.join(w.root, "D1", "files");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "20261103-111416-图片.png"), PNG);
  writeFileSync(path.join(dir, "20261103-120000-图片.png"), PNG);
  writeFileSync(path.join(dir, "说明.md"), "x".repeat(2048));
  const state = { id: "D1", said: [{ seq: 2, by: "user", undone: false, attachments: [{ name: "图片.png", path: path.join(dir, "20261103-111416-图片.png"), mime: "image/png", size: 70 }] }] };
  const { items } = materialsOf(w.root, state as never, w.now(), w.ctx.policy);
  const by = (n: string) => items.find((i: { name: string }) => i.name === n)!;
  assert.equal(by("说明.md").shown, "说明.md");
  assert.deepEqual([by("说明.md").kind, by("说明.md").ext, by("说明.md").size, by("说明.md").thumb], ["text", "MD", "2 KB", false]);
  assert.equal(by("20261103-111416-图片.png").shown, "图片.png · 11:14");
  assert.equal(by("20261103-120000-图片.png").shown, "图片.png · 12:00");
  assert.equal(by("20261103-111416-图片.png").who, "你发的");
  assert.equal(by("20261103-120000-图片.png").who, "整理的");
  assert.deepEqual([by("20261103-111416-图片.png").thumb, by("20261103-111416-图片.png").version.split("-").length], [true, 2]);
});

test("a look's sentence in the conversation says who looked; one that already says so is not told twice", () => {
  const lines = [
    { kind: "created", seq: 1, at: "2026-11-02T10:00:00+08:00" },
    { kind: "report", seq: 2, verdict: "pass", entry: "洗牙还没约。", at: "2026-11-02T10:05:00+08:00" },
    { kind: "report", seq: 3, verdict: "pass", entry: "我看了一眼：还没约。", at: "2026-11-02T10:06:00+08:00" },
  ];
  const rows = rowsOf({ lines, said: [], deadlines: [] } as never, Date.parse("2026-11-02T11:00:00+08:00"), DEFAULT_POLICY as never);
  assert.deepEqual(rows.map((r: { text: string }) => r.text), ["10:05  看了一眼：洗牙还没约。", "10:06  我看了一眼：还没约。"]);
});

test("a reading tool's label is the line `// label: …` near the top of its file; none is left empty", () => {
  const dir = scratch("affairs-readers-");
  writeFileSync(path.join(dir, "a.mjs"), "// 什么都读（只读）\n// label: 外网版本\n// 输入 {}\n");
  writeFileSync(path.join(dir, "b.mjs"), "// 另一个\n// 输入 {}\n");
  const policy = { ...DEFAULT_POLICY, readers: { ...DEFAULT_POLICY.readers, dirs: [dir] } };
  const got = Object.fromEntries(listReaders(policy as never).filter((r: { name: string }) => ["a", "b"].includes(r.name)).map((r: { name: string; label: string; what: string }) => [r.name, [r.label, r.what]]));
  assert.deepEqual(got, { a: ["外网版本", "什么都读（只读）"], b: ["", "另一个"] });
});
