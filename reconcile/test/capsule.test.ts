import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { capsuleFile, capsuleId, expectSchema, loadCapsules, parseCapsule, readCapsule, writeCapsule, type Capsule } from "../server/capsule";
import { CTX_KIND, makeContext, recordingContext } from "../server/rules";
import { createCalendar } from "../server/time";
import { cleanDemos, capture, demoRuleText, loadDemo } from "./replay-helpers";
import { TZ } from "./helpers";

after(cleanDemos);

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "reconcile-capsule-"));

test("every member of the rule's context is classed for the tape, and none is left out", () => {
  const ctx = makeContext({ nowMs: Date.parse("2026-10-21T09:00:00+08:00"), tz: TZ, calendar: createCalendar({}), items: {}, recent: {}, notes: {}, commitments: {}, fresh: () => true }, {});
  assert.deepEqual(Object.keys(CTX_KIND).sort(), Object.keys(ctx).sort());
  for (const [name, kind] of Object.entries(CTX_KIND)) {
    // Only what is read from the controller's state is taped; the rest is the clock and the tables.
    assert.equal(typeof (ctx as unknown as Record<string, unknown>)[name] === "function", kind !== "value", name);
  }
});

test("the recording context tapes each call once, as JSON, and hands the rule what the context does", () => {
  const items = { "gcp-demo:5": { key: "gcp-demo:5", status: "开发中" } } as never;
  const ctx = makeContext({ nowMs: Date.parse("2026-10-21T09:00:00+08:00"), tz: TZ, calendar: createCalendar({}), items, recent: {}, notes: {}, commitments: {}, fresh: () => true }, { a: 1 });
  const rec = recordingContext(ctx);
  assert.equal(rec.ctx.now, ctx.now);
  assert.deepEqual(rec.ctx.params, { a: 1 });
  const first = rec.ctx.item("gcp-demo:5");
  const again = rec.ctx.item("gcp-demo:5");
  assert.deepEqual(first, again);
  assert.ok(Object.isFrozen(first), "what is handed over is as frozen as ever");
  assert.equal(rec.ctx.item("gcp-demo:9"), null);
  assert.deepEqual(rec.ctx.notes("gcp-demo:5"), {});
  // The calendar members are worked out again on replay: not taped.
  rec.ctx.addWorkdays(ctx.now, 1, "10:00");
  rec.ctx.at("2026-10-23", "09:30");
  const calls = rec.calls();
  assert.deepEqual(
    calls.map((c) => [c.m, c.args]),
    [
      ["item", ["gcp-demo:5"]],
      ["item", ["gcp-demo:9"]],
      ["notes", ["gcp-demo:5"]],
    ],
  );
  assert.equal(calls[1]!.result, null);
  assert.deepEqual(calls[0]!.result, { key: "gcp-demo:5", status: "开发中" });
  assert.throws(() => ((rec.ctx as unknown as { now: string }).now = "x"), TypeError, "the context is frozen");
});

test("a capsule is the same when written, read back and built: gzipped or plain", async () => {
  const dir = tmp();
  try {
    const capsule = capture(await loadDemo(demoRuleText()), "2026-10-21 17:00");
    assert.match(capsule.id, /^k_[0-9a-f]{16}$/);
    assert.equal(capsule.outcome.error, null);
    assert.ok(capsule.calls.length >= 10, "the rule read from most of the context");
    for (const gzip of [true, false]) {
      const file = writeCapsule(path.join(dir, gzip ? "gz" : "plain"), capsule, { gzip });
      assert.match(path.relative(dir, file).replace(/\\/g, "/"), gzip ? /^gz\/gcp-demo_1\/20261021T1700-stage-[0-9a-f]{8}\.json\.gz$/ : /^plain\/gcp-demo_1\/20261021T1700-stage-[0-9a-f]{8}\.json$/);
      const read = readCapsule(file);
      assert.ok("capsule" in read, JSON.stringify(read));
      assert.deepEqual(read.capsule, capsule);
    }
    // Written again: the file already there is left alone.
    const file = writeCapsule(path.join(dir, "gz"), capsule);
    assert.equal(readdirSync(path.dirname(file)).length, 1);
    assert.equal(capsuleFile(capsule, true), path.basename(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the id is of what the rule was given and when, not of why it was kept or what was said of it", async () => {
  const rule = await loadDemo(demoRuleText());
  const a = capture(rule, "2026-10-21 17:00", { trigger: ["stage"] });
  const b = capture(rule, "2026-10-21 17:00", { trigger: ["sample", "first"], expect: { stage: "open" } });
  assert.equal(a.id, b.id);
  assert.equal(a.id, capsuleId(a));
  const later = capture(rule, "2026-10-21 17:01");
  assert.notEqual(later.id, a.id);
  const other = capture(rule, "2026-10-21 17:00", { notes: { "gcp-demo:1": { plan: { key: "gcp-demo:1", field: "plan", value: "x", kind: "fact", basis: "source-derived", by: "r", at: "2026-10-21T10:00:00+08:00", evidence: null } } } });
  assert.notEqual(other.id, a.id, "another note is another capsule");
});

test("a capsule that cannot be read is told with why, and is not taken", async () => {
  const dir = tmp();
  try {
    const capsule = capture(await loadDemo(demoRuleText()), "2026-10-21 17:00");
    const bad = (name: string, body: Buffer | string) => {
      const file = path.join(dir, name);
      writeFileSync(file, body);
      return readCapsule(file);
    };
    assert.match((bad("a.json", JSON.stringify({ ...capsule, v: 2 })) as { error: string }).error, /不认识的存档版本：v=2/);
    assert.match((bad("b.json", JSON.stringify({ ...capsule, extra: 1 })) as { error: string }).error, /extra|Unrecognized/);
    assert.match((bad("c.json", JSON.stringify({ ...capsule, expect: { stage: "x", flavour: 1 } })) as { error: string }).error, /expect/);
    assert.match((bad("d.json", JSON.stringify({ ...capsule, id: "x" })) as { error: string }).error, /id/);
    assert.match((bad("e.json", JSON.stringify({ ...capsule, outcome: { output: { stage: "x" }, error: null } })) as { error: string }).error, /outcome/);
    assert.ok("error" in bad("f.json", "{not json"));
    assert.ok("error" in bad("g.json.gz", Buffer.from("not gzip")));
    assert.ok("capsule" in bad("h.json.gz", gzipSync(JSON.stringify(capsule))));
    assert.ok("error" in readCapsule(path.join(dir, "missing.json")));
    mkdirSync(path.join(dir, "dir.json"));
    assert.deepEqual(readCapsule(path.join(dir, "dir.json")), { error: "不是普通文件" });
    assert.throws(() => parseCapsule({ ...capsule, trigger: [] }), /trigger/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loading goes through the roots in order: a later root's capsule of the same id wins, the oldest comes first, a bad file is listed", async () => {
  const [kept, controller] = [tmp(), tmp()];
  try {
    const rule = await loadDemo(demoRuleText());
    const early = capture(rule, "2026-10-21 17:00");
    const late = capture(rule, "2026-10-22 17:00");
    writeCapsule(controller, late);
    writeCapsule(controller, early);
    // The same capsule kept by a person, with what they say is right.
    const mine = { ...early, trigger: ["wrong"], expect: { stage: "open" } } as Capsule;
    writeCapsule(kept, mine, { gzip: false });
    writeFileSync(path.join(kept, ".hidden.json"), "{}");
    mkdirSync(path.join(kept, "x"));
    writeFileSync(path.join(kept, "x", "broken.json"), "{");
    writeFileSync(path.join(kept, "x", "notes.txt"), "not a capsule");
    const loaded = loadCapsules([controller, kept, path.join(controller, "nowhere")]);
    assert.deepEqual(loaded.capsules.map((c) => [c.capsule.at.slice(0, 10), c.capsule.expect !== null]), [["2026-10-21", true], ["2026-10-22", false]]);
    assert.equal(loaded.capsules[0]!.file.startsWith(kept), true);
    assert.deepEqual(loaded.unreadable.map((u) => path.basename(u.file)), ["broken.json"]);
    assert.equal(existsSync(path.join(controller, "gcp-demo_1")), true);
  } finally {
    rmSync(kept, { recursive: true, force: true });
    rmSync(controller, { recursive: true, force: true });
  }
});

test("an expectation says something, and only what it knows how to say", () => {
  assert.ok(expectSchema.safeParse({ stage: ["finished", "dropped"], health: "done", actor: ["nobody"], error: false, notice: false, asks: { has: ["rollout-step:"], none: ["release-check:"] }, facts: { "released.cn": "confirmed", paused: null }, headline: { has: ["已外放"], not: ["推断"] } }).success);
  for (const bad of [{}, { stage: [] }, { health: "great" }, { actor: "you" }, { asks: { has: [""] } }, { asks: { all: ["x"] } }, { facts: { a: 1 } }, { headline: { equals: "x" } }, { colour: "red" }]) {
    assert.equal(expectSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});
