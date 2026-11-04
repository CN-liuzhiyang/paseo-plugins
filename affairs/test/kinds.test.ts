import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_KINDS } from "../shared/panel";
import { FILTERS, KINDS, filterCounts } from "../shared/look";

// Each kind of row has its dot and colors, from the host's theme only; a look and a reply are both ours but are told apart at a glance.

const c = { surface0: "s0", surface1: "s1", surface2: "s2", border: "b", foreground: "f", foregroundMuted: "fm", accent: "a", accentForeground: "af", statusSuccess: "ok", statusWarning: "warn", statusDanger: "bad" };

test("every kind of row has a dot and colors, and a look and a reply look different", () => {
  assert.deepEqual(Object.keys(KINDS).sort(), [...EVENT_KINDS].sort());
  for (const kind of EVENT_KINDS) assert.ok(KINDS[kind].color(c) && KINDS[kind].title(c), kind);
  assert.notEqual(KINDS.look.color(c), KINDS.reply.color(c), "the dots differ");
  assert.notEqual(KINDS.look.title(c), KINDS.reply.title(c), "the titles differ");
  assert.equal(Boolean(KINDS.reply.bar), true, "and a reply's sentence has a bar beside it");
  assert.equal(KINDS.said.dot, "ring", "his are hollow, ours are filled");
  assert.equal(KINDS.look.dot, "solid");
  assert.equal(KINDS.done.color(c), "ok");
  assert.equal(KINDS.error.color(c), "bad");
});

test("the filters: all, what he said, what changed; their counts say how many each keeps", () => {
  const row = (over: object) => ({ yours: false, changed: false, ...over }) as never;
  const counts = filterCounts([row({ yours: true }), row({ changed: true }), row({})]);
  assert.deepEqual(counts.map((x) => [x.id, x.n]), [["all", 3], ["yours", 1], ["changed", 1]]);
  assert.equal(FILTERS.length, 3);
});
