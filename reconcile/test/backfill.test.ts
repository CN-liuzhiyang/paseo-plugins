import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { backfill, backfillPoints, BackfillError } from "../server/backfill";
import { buildCapsule, loadCapsules, readCapsule, writeCapsule, type Capsule, type CaptureInput } from "../server/capsule";
import { loadRules, type LoadedRule } from "../server/rules";
import { replayOn } from "../server/replay";
import type { JournalEvent } from "../server/state";
import { readEvents } from "../server/store";
import { exampleRule, issue, makeWorld, TEST_POLICY, TEST_RULE_PARAMS, type World } from "./helpers";

// The engine tapes what a rule reads when a tool asks it to (deps.capture), a capsule made of that
// is enough to judge again, and the journal is enough to make capsules after the fact.

type Judgment = Omit<CaptureInput, "trigger" | "origin">;

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "reconcile-preview.mjs");

const keyed = (patch: Parameters<typeof issue>[1] = {}) =>
  issue(1, {
    release: "2026-10-23",
    status: "关闭",
    closed: true,
    text: "示例单 1：新开关 feature_x，先灰度",
    revisions: [{ id: "R-101", repo: "demo", branch: "trunk", at: "2026-10-12T10:00:00+08:00", author: "甲", summary: "add feature_x", added: [["feature_x", 'if switches.on("feature_x") then']] }],
    ...patch,
  });

/** The machine way (a switch file says how far it is) and the question way (a release day nobody can read). */
type Config = Parameters<typeof makeWorld>[0]["config"];
const SCENARIOS: Array<[string, string, (w: World) => Promise<void>, Config?]> = [
  [
    "switch",
    "2026-10-21 17:00",
    async (w) => {
      w.flags.set("other_key", 100);
      w.items.set("gcp-demo:1", keyed());
      await w.run("2026-10-21 17:00");
      w.flags.set("feature_x", { enabled: true, grey: 0 });
      await w.run("2026-10-21 17:30");
      w.flags.set("feature_x", { enabled: true, grey: 20 });
      await w.run("2026-10-26 10:00");
      w.flags.set("feature_x", { enabled: true, grey: 100 });
      await w.run("2026-10-28 10:00");
    },
  ],
  [
    "two leads",
    "2026-10-23 10:00",
    async (w) => {
      w.flags.set("feature_x", 30);
      w.items.set("gcp-demo:1", keyed());
      w.items.set("gcp-demo:3", issue(3, { ...keyed(), key: "gcp-demo:3", url: null, fields: { Release: "2026-10-30" } }));
      await w.run("2026-10-23 10:15");
    },
  ],
  [
    "a sibling's key",
    "2026-10-21 10:00",
    async (w) => {
      w.flags.set("feature_x", 10);
      w.items.set("gcp-demo:2", issue(2, { release: "2026-10-23", status: "关闭", closed: true, parent: "gcp-demo:9", text: "引擎侧的版本检查，配合灰度" }));
      w.items.set("gcp-demo:1", keyed({ parent: "gcp-demo:9" }));
      await w.run("2026-10-21 10:00");
      w.answer({ "#2 key": "feature_x" });
      await w.run("2026-10-21 10:15");
    },
    { rules: { "release-followup.mjs": exampleRule({ ...TEST_RULE_PARAMS, keyHint: "灰度" }) } },
  ],
  [
    "asked",
    "2026-10-21 17:00",
    async (w) => {
      w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23外放（例行）" }));
      await w.run("2026-10-21 17:00");
      w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23外放（例行）", status: "关闭", closed: true, sourceUpdatedAt: "2026-10-22T15:00:00+08:00" }));
      await w.run("2026-10-23 18:00");
      w.answer({ "#1": "已外放，灰度开了" });
      await w.run("2026-10-23 19:15");
    },
  ],
];

async function inWorld(start: string, body: (w: World) => Promise<void>, capture?: (j: Judgment) => void, config?: Config) {
  const w = await makeWorld({ start, capture, config });
  try {
    await body(w);
  } finally {
    w.close();
  }
}

/** Every file under a directory with its size: what a read-only tool must leave as it was. */
const listing = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${path.relative(dir, path.join(e.parentPath, e.name))} ${statSync(path.join(e.parentPath, e.name)).size}`)
    .sort();

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "reconcile-backfill-"));

test("a rule's judgments are offered to whoever asks for them, with everything it read, and each is enough to judge again", async () => {
  const members = new Set<string>();
  let judged = 0;
  for (const [name, start, steps, config] of SCENARIOS) {
    const taken: Judgment[] = [];
    const loaded: { rule?: LoadedRule } = {};
    await inWorld(start, async (w) => {
      await steps(w);
      loaded.rule = (await loadRules(path.join(w.configDir, "rules"))).rules[0];
    }, (j) => taken.push(j), config);
    assert.ok(taken.length >= 4, `${name}: judged`);
    for (const j of taken) {
      const capsule: Capsule = buildCapsule({ ...j, trigger: ["stage"], origin: "live" });
      assert.equal(capsule.seq, j.seq);
      for (const c of capsule.calls) members.add(c.m);
      // Through a file, so that the replay has only what a capsule holds.
      const dir = tmp();
      try {
        const read = readCapsule(writeCapsule(dir, capsule));
        assert.ok("capsule" in read);
        const run = replayOn(read.capsule, loaded.rule!);
        assert.deepEqual(run.missing, [], `${name} ${capsule.case} ${capsule.at}`);
        assert.deepEqual(run.outcome, capsule.outcome, `${name} ${capsule.case} ${capsule.at}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      judged++;
    }
  }
  assert.ok(judged >= 20);
  // The example rule reads from most of the context: the tape holds them all.
  for (const m of ["notes", "commitments", "naming", "flagsOf", "siblings"]) assert.ok(members.has(m), `${m} was taped`);
});

// A rule that changes what it asks to have watched is judged again on the new request, for which
// nothing is read yet: it is that judgment that is offered, with what that one read.
const WATCHER = `export default {
  name: "watcher", description: "x", applies: { source: "gcp-demo" }, params: {}, stages: ["s"],
  assess(kase, ctx) {
    const o = ctx.observation("watch-demo", "w-1");
    return { stage: "s", health: "waiting", headline: "v " + o.verdict + " " + (o.why || "-"), next: { actor: "system", what: "x" }, facts: [], commitments: [],
      observe: [{ source: "watch-demo", key: "w-1", window: { from: ctx.at("2026-10-13", "10:00"), to: ctx.at("2026-10-13", "10:30") }, reread: [60], params: { region: kase.primary.fields.Region || "a" } }] };
  },
};`;
const COMMAND = 'let i="";process.stdin.on("data",(d)=>(i+=d)).on("end",()=>{const r=JSON.parse(i);process.stdout.write(JSON.stringify({results:r.requests.map((q)=>({key:q.key,verdict:"no-signal",freshUntil:r.now,numbers:{}}))}));});';

test("a judgment made again on a request the rule changed is offered as the second one, with what that one read", async () => {
  const taken: Judgment[] = [];
  const w = await makeWorld({
    start: "2026-10-13 09:50",
    capture: (j) => taken.push(j),
    config: { rules: { "watcher.mjs": WATCHER }, policy: TEST_POLICY, extraSources: [{ id: "watch-demo", kind: "command", command: [process.execPath, "-e", COMMAND], everyMinutes: 10, maxCallsPerHour: 30, timeoutSeconds: 30, domain: "work" }] },
  });
  try {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14" }));
    await w.run("2026-10-13 10:40", 5);
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.headline, "v no-signal -", "read to its end");
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14", fields: { Release: "2026-10-14", Region: "b" } }));
    await w.run("2026-10-13 11:05", 5);
    // The round the rule first asks for it: the judgment offered is the second one it made in that round.
    const asking = taken.filter((x) => x.judged.output?.observe?.[0]?.params.region === "b");
    assert.ok(asking.length > 0);
    const j = asking[0]!;
    const capsule = buildCapsule({ ...j, trigger: ["sample"], origin: "live" });
    const told = capsule.calls.find((c) => c.m === "observation")!.result as { verdict: string; why: string };
    assert.deepEqual([told.verdict, told.why], ["insufficient-data", "none-yet"], "what the second judgment read, not the first");
    const rule = (await loadRules(path.join(w.configDir, "rules"))).rules[0]!;
    const run = replayOn(capsule, rule);
    assert.deepEqual(run.missing, []);
    assert.deepEqual(run.outcome, capsule.outcome);
    assert.equal(run.outcome.output!.headline, "v insufficient-data none-yet");
  } finally {
    await w.engine.stop();
    w.close();
  }
});

test("nothing about a judgment changes when it is offered: the journal is the same with and without", async () => {
  const journal = async (capture?: (j: Judgment) => void) => {
    let events: JournalEvent[] = [];
    await inWorld(SCENARIOS[0]![1], async (w) => {
      await SCENARIOS[0]![2](w);
      // Where it ran is the only thing in it that differs.
      events = readEvents(w.dataDir).filter((e) => e.type !== "started");
    }, capture);
    return events;
  };
  let offered = 0;
  const [without, withOne] = [await journal(), await journal(() => offered++)];
  assert.ok(offered > 0);
  assert.ok(without.length > 40);
  assert.deepEqual(withOne, without);
});

// ---- the moments worth a capsule, from a journal made by hand -------------------------------

let seq = 0;
const batch = (at: string, ...bodies: object[]): JournalEvent[] => bodies.map((b) => ({ v: 1, seq: ++seq, at, ...b }) as JournalEvent);
const T = (day: number, time = "17:00") => `2026-10-${day}T${time}:00+08:00`;
const assessment = (caseId: string, at: string, stage: string, more: object = {}) => ({
  type: "assessment",
  assessment: { caseId, at, rule: "r", rulesFingerprint: "f", stage, health: "on-track", headline: `${caseId} ${stage}`, next: { actor: "me", what: "x" }, notice: null, stale: false, error: null, ...more },
});
const commitment = (id: string, caseId: string, at: string, by = "rule") => ({
  type: "commitment.created",
  commitment: { id, key: id, title: id, domain: "work", owner: "owner", caseId, trigger: { at }, ask: {}, brief: "", nag: {}, backstop: { at, outcome: "expire" }, level: "push", origin: { by, who: "r" }, status: "scheduled", rounds: 0, lastAskedAt: null, answer: null, createdAt: at, updatedAt: at, reason: null },
});

test("the moments to keep a judgment at: first, a stage, a failure, a notice, a question made or taken back, a judgment said to be wrong", () => {
  seq = 0;
  const events: JournalEvent[] = [
    ...batch("2026-10-21T09:00:00.000Z", { type: "started" }),
    // 10-21: both items judged for the first time, and a question made for A.
    ...batch("2026-10-21T09:00:01.000Z", { type: "item.snapshot", item: {} }),
    ...batch("2026-10-21T09:00:01.100Z", assessment("gcp-demo:1", T(21), "open"), assessment("gcp-demo:2", T(21), "open")),
    ...batch("2026-10-21T09:00:01.200Z", commitment("c1", "gcp-demo:1", T(21)), commitment("c-human", "gcp-demo:2", T(21), "human")),
    // 10-22: A changes stage and its question is taken back; B starts to fail.
    ...batch("2026-10-22T09:00:01.100Z", assessment("gcp-demo:1", T(22), "waiting"), assessment("gcp-demo:2", T(22), "error", { error: "boom" })),
    ...batch("2026-10-22T09:00:01.200Z", { type: "commitment.changed", id: "c1", patch: { status: "cancelled", updatedAt: T(22) } }),
    // 10-23: A gets a notice and its question comes back; B does not change (a judgment that says the same is not written).
    ...batch("2026-10-23T09:00:01.100Z", assessment("gcp-demo:1", T(23), "waiting", { notice: "看着不对" })),
    ...batch("2026-10-23T09:00:01.200Z", { type: "commitment.changed", id: "c1", patch: { status: "scheduled", updatedAt: T(23) } }),
    // 10-24: a question made with no judgment written that round; a question answered is not a change.
    ...batch("2026-10-24T09:00:01.200Z", commitment("c2", "gcp-demo:2", T(24))),
    ...batch("2026-10-24T09:05:01.200Z", { type: "commitment.changed", id: "c2", patch: { status: "done", updatedAt: T(24, "17:05") } }),
    // 10-25: A's judgment said to be wrong.
    ...batch("2026-10-25T09:00:01.000Z", { type: "annotation.added", annotation: { id: "a_1", caseId: "gcp-demo:1", kind: "wrong", said: "错了", by: "owner", via: null, how: "own-words", at: T(25), until: null, person: null, what: null, expected: null, revoked: null } }),
  ];
  const points = backfillPoints(events).map((p) => [p.caseId, p.at.slice(5, 16), p.start, [...p.why].sort().join("+")]);
  assert.deepEqual(points, [
    ["gcp-demo:1", "10-21T17:00", 3, "first+questions"],
    ["gcp-demo:2", "10-21T17:00", 3, "first"],
    ["gcp-demo:1", "10-22T17:00", 7, "questions+stage"],
    ["gcp-demo:2", "10-22T17:00", 7, "error+stage"],
    ["gcp-demo:1", "10-23T17:00", 10, "notice+questions"],
    ["gcp-demo:2", "10-24T17:00", 12, "questions"],
    ["gcp-demo:1", "10-25T17:00", 14, "wrong"],
  ]);
  // The state to fold to is the one before the round's judgments; for a round with none, before its own writes.
  assert.equal(backfillPoints(events)[6]!.annotation!.id, "a_1");
  assert.equal(backfillPoints(events)[0]!.logged!.stage, "open");
  assert.equal(backfillPoints(events)[5]!.logged, null);
});

// ---- after the fact, from a journal a controller wrote --------------------------------------

test("capsules made from a journal are of the judgments it holds, kept where asked, and made once", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const to = tmp();
    try {
      const before = listing(w.dataDir);
      const result = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      assert.ok(result.points >= 4);
      assert.equal(result.made.length + result.skipped.length, result.points);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(readdirSync(to), ["gcp-demo_1"], "kept where asked, under the item");
      const stages = result.made.map((m) => m.capsule.outcome.output!.stage);
      assert.deepEqual(stages.slice(0, 2), ["awaiting-release", "rolling-out"]);
      assert.equal(stages[stages.length - 1], "finished");
      for (const { capsule } of result.made) {
        assert.equal(capsule.origin, "backfill");
        assert.ok(capsule.trigger.length > 0);
        assert.equal(capsule.instance, "test");
        // The rules are the ones that judged it then, so the journal's judgment and the capsule's are one.
        const logged = capsule.logged;
        if (logged) assert.deepEqual([logged.stage, logged.health, logged.headline, logged.actor, logged.what], [capsule.outcome.output!.stage, capsule.outcome.output!.health, capsule.outcome.output!.headline, capsule.outcome.output!.next.actor, capsule.outcome.output!.next.what]);
      }
      assert.ok(result.made.some((m) => m.capsule.trigger.includes("first")));
      assert.ok(result.made.some((m) => m.capsule.trigger.includes("stage")));
      // They are what a later replay loads, and a replay of the rule that made them finds nothing amiss.
      const loaded = loadCapsules([to]);
      assert.deepEqual(loaded.unreadable, []);
      assert.equal(loaded.capsules.length, result.made.length);
      const rule = (await loadRules(path.join(w.configDir, "rules"))).rules[0]!;
      for (const { capsule } of loaded.capsules) {
        const run = replayOn(capsule, rule);
        assert.deepEqual(run.missing, []);
        assert.deepEqual(run.outcome, capsule.outcome);
      }
      // Again: the same capsules, the same files.
      const files = readdirSync(to, { recursive: true }).sort();
      const again = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      assert.deepEqual(again.made.map((m) => m.capsule.id), result.made.map((m) => m.capsule.id));
      assert.deepEqual(readdirSync(to, { recursive: true }).sort(), files);
      // The data directory was only read.
      assert.deepEqual(listing(w.dataDir), before);
    } finally {
      rmSync(to, { recursive: true, force: true });
    }
  });
});

test("a journal that does not begin at the beginning, or is not there, cannot be folded: said so, nothing written", async () => {
  await inWorld(SCENARIOS[3]![1], async (w) => {
    await SCENARIOS[3]![2](w);
    const [data, to] = [tmp(), tmp()];
    try {
      cpSync(w.dataDir, data, { recursive: true });
      const file = path.join(data, "journal", readdirSync(path.join(data, "journal"))[0]!);
      writeFileSync(file, readFileSync(file, "utf8").split("\n").slice(1).join("\n"));
      await assert.rejects(backfill({ configDir: w.configDir, dataDir: data, to }), (e: Error) => e instanceof BackfillError && /不是从头开始/.test(e.message));
      mkdirSync(path.join(data, "empty"));
      await assert.rejects(backfill({ configDir: w.configDir, dataDir: path.join(data, "empty"), to }), (e: Error) => e instanceof BackfillError && /数据目录里没有日志/.test(e.message));
      assert.deepEqual(readdirSync(to), []);
    } finally {
      rmSync(data, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });
});

test("the command: cases backfill writes where asked and says what it made; another subcommand or flag is refused", async () => {
  await inWorld(SCENARIOS[3]![1], async (w) => {
    await SCENARIOS[3]![2](w);
    const to = tmp();
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
      const ok = run("cases", "backfill", "--config", w.configDir, "--data", w.dataDir, "--to", to);
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /补录了 \d+ 份存档到/);
      assert.match(ok.stdout, /gcp-demo:1 2026-10-2\d \d\d:\d\d first/);
      assert.ok(readdirSync(to, { recursive: true }).some((f) => String(f).endsWith(".json.gz")));
      const json = JSON.parse(run("cases", "backfill", "--config", w.configDir, "--data", w.dataDir, "--to", to, "--json").stdout) as { made: Array<{ case: string; trigger: string[] }> };
      assert.ok(json.made.length > 0 && json.made.every((m) => m.case === "gcp-demo:1"));
      for (const args of [["cases"], ["cases", "nope"], ["cases", "backfill", "--candidate", "x"], ["backfill"]]) {
        const bad = run(...args, "--config", w.configDir, "--data", w.dataDir);
        assert.equal(bad.status, 2, args.join(" "));
      }
    } finally {
      rmSync(to, { recursive: true, force: true });
    }
  });
});
