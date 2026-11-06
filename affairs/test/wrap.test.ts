import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLIP_CHARS, FULL_CHARS, clip } from "../server/lib/clip.mjs";
import { sourcesOf } from "../server/lib/panel.mjs";
import { linkContext } from "../server/lib/links.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { WRAP } from "../shared/wrap";

// What the person sees must never run out of its box: every Text goes through client/text.tsx, which lays it out so it
// folds anywhere it has to; what is read from outside is cut to a length before it gets to the panel.

const clientDir = path.resolve(import.meta.dirname, "../client");
const clientFiles = [...readdirSync(clientDir).map((f) => path.join(clientDir, f)), path.resolve(import.meta.dirname, "../index.client.tsx")].filter((f) => /\.tsx?$/.test(f));

test("no text in the panel or the cards is made without the shared layout: a bare Text outside client/text.tsx fails here", () => {
  assert.ok(clientFiles.length >= 4);
  for (const file of clientFiles) {
    if (path.basename(file) === "text.tsx") continue;
    const source = readFileSync(file, "utf8");
    assert.ok(!/<Text[\s>]/.test(source), `${path.basename(file)} uses a bare <Text>: use Words or Clip from ./text`);
    assert.ok(!/import\s*\{[^}]*\bText\b[^}]*\}\s*from\s*"react-native"/.test(source), `${path.basename(file)} imports Text from react-native`);
  }
  const shared = readFileSync(path.join(clientDir, "text.tsx"), "utf8");
  assert.match(shared, /WRAP/, "and the shared one does use the layout");
});

test("the layout lets a text fold anywhere and give way to what is beside it", () => {
  assert.equal(WRAP.minWidth, 0);
  assert.equal(WRAP.flexShrink, 1);
  assert.equal(WRAP.overflowWrap, "anywhere");
  assert.equal(WRAP.wordBreak, "break-word");
});

test("a long reading is cut to CLIP_CHARS with … and the whole (to FULL_CHARS) comes along to open; a short one has no second copy", () => {
  assert.equal(clip("短", 5), "短");
  assert.equal(clip("abcdef", 4), "abc…");
  assert.equal(Array.from(clip("😀".repeat(10), 4)).length, 4, "a pair of halves is not split");
  const long = "#987735【PC引擎】HexProfile运行中关闭导致采样栈配写坏返回地址(NV包启动: merge到public分支之后还要再看一下)".repeat(3);
  const nospace = "x".repeat(900);
  const url = `https://example.invalid/${"a/b?c=d&".repeat(40)}`;
  const state = {
    id: "dental",
    status: "watching",
    link: null,
    facts: [],
    nowText: "",
    reads: [],
    watches: {
      a: { id: "a", label: "gcp-issue", tool: "gcp-issue", summary: long, readAt: "2026-11-03T10:00:00+08:00" },
      b: { id: "b", label: "无空格", tool: "x", summary: nospace, readAt: "2026-11-03T10:00:00+08:00" },
      c: { id: "c", label: "网址", tool: "x", summary: url, readAt: "2026-11-03T10:00:00+08:00" },
      d: { id: "d", label: "短的", tool: "x", summary: "已进：trunk\n、  release", readAt: "2026-11-03T10:00:00+08:00" },
    },
  };
  const now = Date.parse("2026-11-03T12:00:00+08:00");
  const { items } = sourcesOf(state as never, now, DEFAULT_POLICY as never, linkContext(DEFAULT_POLICY as never, null));
  const by = (label: string) => items.find((i: { label: string }) => i.label === label)!;
  for (const label of ["gcp-issue", "无空格", "网址"]) {
    const item = by(label);
    assert.ok(Array.from(item.status).length <= CLIP_CHARS, label);
    assert.ok(item.status.endsWith("…"), label);
    assert.ok(item.full && Array.from(item.full).length <= FULL_CHARS && item.full.length > item.status.length, label);
  }
  assert.equal(by("短的").status, "已进：trunk 、 release", "line breaks and runs of spaces become one space");
  assert.equal(by("短的").full, undefined);
});

test("the panel says what today cost in dollars, with the sign (a template can lose it without anything failing)", async () => {
  const { world } = await import("./kit");
  const { append, load, read } = await import("../server/lib/log.mjs");
  const { panelOf } = await import("../server/lib/panel.mjs");
  const ops = await import("../server/lib/ops.mjs");
  const w = world();
  const made = await ops.create(w.ctx, { id: "dental", title: "洗牙", goal: "洗牙", said: "盯一下洗牙", noWait: true });
  const id = made.id as string;
  const view = () => panelOf(w.root, { ...load(w.root, id), lines: read(w.root, id) }, w.now(), w.ctx.policy, linkContext(w.ctx.policy, null));
  assert.equal(view().spent, "", "nothing spent, nothing said");
  append(w.root, id, [{ kind: "chat.turn", agentId: "c", tokens: 1000, usd: 0.0187, usdTotal: 0.0187 }], { now: w.now() });
  assert.match(view().spent, /^今天花了 \$0\.0[12]\d?$|^今天花了 \$0\.02$/);
});
