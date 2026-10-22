import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { judge, loadRules, makeContext, scanRule } from "../server/rules";
import { createCalendar } from "../server/time";
import { EXAMPLE_RULE, issue, TZ } from "./helpers";

const calendar = createCalendar({});
const context = (nowLocal: string, params: Record<string, unknown> = {}) =>
  makeContext({ nowMs: Date.parse(`${nowLocal}:00+08:00`), tz: TZ, calendar, items: {}, recent: {}, notes: {}, commitments: {}, fresh: () => true }, params);

test("the scan refuses the obvious ways to be nondeterministic or reach out", () => {
  assert.equal(scanRule("export default { assess(k, ctx) { return ctx.now } }"), null);
  assert.match(scanRule("const t = Date.now();")!, /Date\.now/);
  assert.match(scanRule("const t = new Date();")!, /new Date\(\)/);
  assert.equal(scanRule('const t = new Date("2026-10-01");'), null);
  assert.match(scanRule("Math.random()")!, /Math\.random/);
  assert.match(scanRule('import fs from "node:fs";')!, /import/);
  assert.match(scanRule('await fetch("x")')!, /fetch/);
  assert.match(scanRule("process.env.X")!, /process/);
});

test("rules load by fingerprint; a broken file is an error, not a crash", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-rules-"));
  try {
    copyFileSync(EXAMPLE_RULE, path.join(dir, "release-followup.mjs"));
    writeFileSync(path.join(dir, "bad.mjs"), "export default { name: 'bad' };");
    writeFileSync(path.join(dir, "clock.mjs"), "export default { name: 'clock', assess() { return Date.now(); } };");
    const set = await loadRules(dir);
    assert.deepEqual(set.rules.map((r) => r.name), ["release-followup"]);
    assert.deepEqual(set.errors.map((e) => e.file).sort(), ["bad.mjs", "clock.mjs"]);
    const again = await loadRules(dir);
    assert.equal(again.fingerprint, set.fingerprint);
    writeFileSync(path.join(dir, "bad.mjs"), "export default { name: 'bad2' };");
    assert.notEqual((await loadRules(dir)).fingerprint, set.fingerprint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the example rule: open, closed with a date, closed without one", async () => {
  const set = await loadRules(path.dirname(EXAMPLE_RULE));
  const rule = set.rules[0]!;
  const ctx = context("2026-10-21 17:00", rule.params);
  const open = judge(rule, { id: "gcp-demo:1", primary: issue(1, { release: "2026-10-23外放" }), items: [], flags: [] }, ctx, set.fingerprint);
  assert.equal(open.assessment.stage, "open");
  assert.equal(open.assessment.headline, "开发中，计划 10-23 外放");
  assert.deepEqual(open.output!.facts.map((f) => [f.field, f.value]), [["plannedRelease", "2026-10-23"]]);
  assert.equal(open.output!.commitments.length, 0);

  const closedIssue = { id: "gcp-demo:1", primary: issue(1, { release: "2026-10-23外放", status: "关闭", closed: true }), items: [], flags: [] };
  // By default the release is checked in the background: nothing asked.
  const quiet = judge(rule, closedIssue, ctx, set.fingerprint);
  assert.equal(quiet.assessment.stage, "awaiting-release");
  assert.equal(quiet.output!.commitments.length, 0);
  assert.equal(quiet.assessment.headline, "关闭，10-23 外放；外网 release 里还没有这张单的提交");

  const closed = judge(rule, closedIssue, context("2026-10-21 17:00", { ...rule.params, releaseCheck: "ask" }), set.fingerprint);
  assert.equal(closed.assessment.stage, "awaiting-release");
  const [c] = closed.output!.commitments;
  assert.equal(c!.key, "release:gcp-demo:1:2026-10-23");
  // A workday of grace after the release day for the machines to say so, then ask.
  assert.equal(c!.trigger.at, "2026-10-26T18:00:00+08:00");
  assert.equal(c!.backstop.at, "2026-11-02T18:00:00+08:00");
  assert.deepEqual(c!.ask.options.map((o) => o.id), ["out-on", "out-off", "not-yet", "drop"]);

  const none = judge(rule, { id: "gcp-demo:1", primary: issue(1, { status: "关闭", closed: true }), items: [], flags: [] }, ctx, set.fingerprint);
  assert.equal(none.assessment.stage, "no-release-date");
});

test("judge turns a throw or an off-vocabulary answer into an error assessment", () => {
  const base = { file: "x.mjs", name: "x", source: "gcp-demo", stages: ["a"], params: {} };
  const ctx = context("2026-10-21 17:00");
  const kase = { id: "gcp-demo:1", primary: issue(1), items: [], flags: [] };
  const threw = judge({ ...base, assess: () => { throw new Error("boom"); } }, kase, ctx, "f");
  assert.equal(threw.assessment.stage, "error");
  assert.match(threw.assessment.error!, /boom/);
  const wrong = judge({ ...base, assess: () => ({ stage: "b", health: "waiting", headline: "h", next: { actor: "me", what: "" }, facts: [], commitments: [] }) }, kase, ctx, "f");
  assert.match(wrong.assessment.error!, /not one of the declared stages/);
  const extra = judge({ ...base, assess: () => ({ stage: "a", health: "waiting", headline: "h", next: { actor: "me", what: "" }, facts: [], commitments: [], mood: "x" }) }, kase, ctx, "f");
  assert.match(extra.assessment.error!, /mood|Unrecognized/i);
});

test("a rule cannot change what it is given", () => {
  const ctx = context("2026-10-21 17:00");
  const result = judge(
    {
      file: "x.mjs",
      name: "x",
      source: "gcp-demo",
      stages: ["a"],
      params: {},
      assess: (kase) => {
        (kase.primary as { title: string }).title = "changed";
        return { stage: "a", health: "waiting", headline: "h", next: { actor: "me", what: "" }, facts: [], commitments: [] };
      },
    },
    { id: "gcp-demo:1", primary: issue(1), items: [], flags: [] },
    ctx,
    "f",
  );
  assert.match(result.assessment.error ?? "", /read only|read-only|Cannot assign/i);
});
