import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// What a writing tool can do to a source file without anyone seeing it: a raw NUL byte makes ripgrep
// and grep call the whole file binary (every search of it comes back empty), and a U+FFFD means a
// Chinese character was broken on the way in. Neither shows in a diff.

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", "dist", "build"]);
const TEXT = /\.(?:[cm]?[jt]sx?|json|md|mjs|txt|ya?ml)$/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (TEXT.test(name)) yield full;
  }
}

test("no source file of the plugin holds a raw NUL byte or a broken character", () => {
  const nul: string[] = [];
  const broken: string[] = [];
  for (const file of files(PLUGIN)) {
    const bytes = readFileSync(file);
    const rel = path.relative(PLUGIN, file);
    if (bytes.includes(0)) nul.push(rel);
    if (bytes.toString("utf8").includes(String.fromCharCode(0xfffd))) broken.push(rel);
  }
  assert.deepEqual(nul, [], "a NUL is written as the escape \\0 in source");
  assert.deepEqual(broken, []);
});
