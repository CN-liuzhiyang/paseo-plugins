import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { moodOf } from "../server/lib/panel.mjs";
import { panelSchema } from "../shared/panel";
import { MOODS, tint } from "../shared/look";

// The panel tells how an affair stands by a colored dot, and uses only the host's theme colors: no color of our own.

const open = { status: "watching" };

test("an affair's mood: done and stopped first, then waiting for him, then trouble, then out of looks, else watching", () => {
  assert.equal(moodOf({ status: "done" }, true, true, true), "done");
  assert.equal(moodOf({ status: "stopped" }, true, false, false), "stopped");
  assert.equal(moodOf(open, true, true, true), "ask", "a question for him outranks trouble");
  assert.equal(moodOf({ ...open, system: true }, false, false, false), "ask", "a missing setting is also his to fix");
  assert.equal(moodOf(open, false, true, true), "error");
  assert.equal(moodOf(open, false, false, true), "paused");
  assert.equal(moodOf(open, false, false, false), "watching");
});

test("every mood the panel can send has a word and a theme color, and \"等你\" is the one that stands out", () => {
  const moods = panelSchema.shape.mood.options;
  assert.deepEqual(Object.keys(MOODS).sort(), [...moods].sort());
  const colors = { surface0: "s0", surface1: "s1", surface2: "s2", border: "b", foreground: "f", foregroundMuted: "fm", accent: "a", accentForeground: "af", statusSuccess: "ok", statusWarning: "warn", statusDanger: "bad" };
  assert.equal(MOODS.ask.color(colors), "warn");
  assert.equal(MOODS.done.color(colors), "ok");
  assert.equal(MOODS.error.color(colors), "bad");
  assert.equal(MOODS.watching.color(colors), "a");
  assert.equal(new Set(["ask", "done", "error", "watching"].map((m) => MOODS[m as keyof typeof MOODS].label)).size, 4);
});

test("a wash of a theme color is only made from a plain #rrggbb; anything else falls back to a surface", () => {
  assert.equal(tint("#c09664", "1f", "x"), "#c096641f");
  assert.equal(tint("rgb(1,2,3)", "1f", "x"), "x");
  assert.equal(tint("red", "1f", "x"), "x");
});

test("the client files name no color of their own (only the theme's), so light and dark both read", () => {
  const dir = path.resolve(import.meta.dirname, "../client");
  for (const f of ["look.tsx", "panel.tsx", "card.tsx"]) {
    const source = readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source.replace(/\/\^#\[0-9a-f\]\{6\}\$\/i/g, "")), `${f} has a hard-coded color`);
    assert.ok(!/\brgba?\(|\bhsla?\(/.test(source), `${f} has a hard-coded color`);
  }
});
