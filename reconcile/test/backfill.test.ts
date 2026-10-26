import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { backfill, backfillPoints, BackfillError } from "../server/backfill";
import { buildCapsule, loadCapsules, readCapsule, replaceExpect, writeCapsule, type Capsule, type CaptureInput } from "../server/capsule";
import { listCases, setExpect } from "../server/cases";
import { applyCandidate, copyConfig, preview, PreviewError } from "../server/preview";
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
      assert.deepEqual(again.made, [], "nothing is written that is already there");
      assert.deepEqual(again.existing.map((m) => m.capsule.id), result.made.map((m) => m.capsule.id), "and it says so, not that it made them");
      assert.deepEqual(again.superseded, []);
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
      assert.match(ok.stdout, /新补录了 \d+ 份存档到.*，0 份是同样的输入、早就有了，没动。/);
      assert.match(ok.stdout, /冷热、关联、来源是否过时是按折叠出来的状态和现在的配置重算的/);
      assert.match(ok.stdout, /gcp-demo:1 2026-10-2\d \d\d:\d\d first/);
      const files = readdirSync(to, { recursive: true }).map(String).filter((f) => f.endsWith(".json") || f.endsWith(".json.gz"));
      assert.ok(files.length > 0 && files.every((f) => f.endsWith(".json")), "plain JSON, which a repository shows the changes of");
      // Again: all of it is there already, and the command says so instead of saying it made them.
      const json = JSON.parse(run("cases", "backfill", "--config", w.configDir, "--data", w.dataDir, "--to", to, "--json").stdout) as { made: unknown[]; existing: Array<{ case: string }>; superseded: unknown[] };
      assert.deepEqual(json.made, []);
      assert.equal(json.existing.length, files.length);
      assert.ok(json.existing.every((m) => m.case === "gcp-demo:1"));
      const again = run("cases", "backfill", "--config", w.configDir, "--data", w.dataDir, "--to", to);
      assert.match(again.stdout, new RegExp(`新补录了 0 份存档到.*，${files.length} 份是同样的输入、早就有了，没动。`));
      // --gzip: the compact form, for a place nobody reads the changes of.
      const zipped = tmp();
      try {
        assert.equal(run("cases", "backfill", "--config", w.configDir, "--data", w.dataDir, "--to", zipped, "--gzip").status, 0);
        const zfiles = readdirSync(zipped, { recursive: true }).map(String).filter((f) => f.endsWith(".json") || f.endsWith(".json.gz"));
        assert.equal(zfiles.length, files.length);
        assert.ok(zfiles.every((f) => f.endsWith(".json.gz")));
      } finally {
        rmSync(zipped, { recursive: true, force: true });
      }
      for (const args of [["cases"], ["cases", "nope"], ["cases", "backfill", "--candidate", "x"], ["backfill"]]) {
        const bad = run(...args, "--config", w.configDir, "--data", w.dataDir);
        assert.equal(bad.status, 2, args.join(" "));
      }
    } finally {
      rmSync(to, { recursive: true, force: true });
    }
  });
});

// ---- a backfill again: plain JSON, only real writes, the same moment from other inputs, a journal with a hole (review F5, F8) ----

const filesIn = (dir: string) => readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".json") || f.endsWith(".json.gz")).sort();

test("a backfill writes plain JSON unless asked to compress, and a capsule already there in either form is not written again", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const [plain, zipped, mixed] = [tmp(), tmp(), tmp()];
    try {
      const first = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: plain });
      assert.ok(first.made.length > 0);
      assert.ok(filesIn(plain).every((f) => f.endsWith(".json")), "plain by default");
      assert.ok(readFileSync(first.made[0]!.file, "utf8").includes("\n  "), "indented");
      await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: zipped, gzip: true });
      assert.ok(filesIn(zipped).every((f) => f.endsWith(".json.gz")));
      assert.equal(filesIn(zipped).length, filesIn(plain).length);
      // Compressed first, plain after (or the other way): the same capsules, not a second copy of each.
      await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: mixed, gzip: true });
      const files = filesIn(mixed);
      const after = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: mixed });
      assert.deepEqual(after.made, []);
      assert.equal(after.existing.length, first.made.length);
      assert.deepEqual(filesIn(mixed), files);
    } finally {
      for (const d of [plain, zipped, mixed]) rmSync(d, { recursive: true, force: true });
    }
  });
});

test("a backfill after the rule in use changed what it reads: the new capsules are told apart from the old ones for the same moments, which stay unless replaced", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const to = tmp();
    try {
      const ruleFile = path.join(w.configDir, "rules", readdirSync(path.join(w.configDir, "rules"))[0]!);
      const first = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      const old = first.made.map((m) => m.capsule.id);
      // Another version of the rule: it reads one thing more, so the tape (and the id) differs.
      writeFileSync(ruleFile, readFileSync(ruleFile, "utf8").replace("assess(kase, ctx) {", 'assess(kase, ctx) {\n    ctx.item("gcp-demo:98");'));
      const second = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      assert.equal(second.made.length, first.made.length, "written now: they are others");
      assert.ok(second.made.every((m) => !old.includes(m.capsule.id)));
      assert.deepEqual(second.existing, []);
      assert.deepEqual(second.superseded.map((x) => [x.capsule.id, x.removed]).sort(), old.map((id) => [id, false]).sort(), "the earlier ones are named, and left");
      assert.equal(filesIn(to).length, first.made.length * 2, "two of each moment now");
      // A capsule of another origin for the same moment is never taken away, nor one that is kept elsewhere.
      const live: Capsule = { ...first.made[0]!.capsule, origin: "live", id: `k_${"0".repeat(16)}` };
      const liveFile = writeCapsule(to, live, { gzip: false });
      const third = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to, replace: true });
      assert.deepEqual(third.made, []);
      assert.equal(third.existing.length, second.made.length);
      assert.deepEqual(third.superseded.map((x) => [x.capsule.id, x.removed]).sort(), old.map((id) => [id, true]).sort());
      assert.equal(filesIn(to).length, second.made.length + 1, "the old ones are gone; the live one and the new ones are there");
      assert.ok(readdirSync(path.dirname(liveFile)).some((f) => f === path.basename(liveFile)), "a capsule that was not made by a backfill stays");
      // And a backfill with nothing to replace says nothing is.
      const fourth = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to, replace: true });
      assert.deepEqual(fourth.superseded, []);
    } finally {
      rmSync(to, { recursive: true, force: true });
    }
  });
});

test("the command says when an earlier backfill's capsule for the same moment is left, and takes it away only with --replace", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const to = tmp();
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, [BIN, "cases", "backfill", "--config", w.configDir, "--data", w.dataDir, "--to", to, ...args], { encoding: "utf8" });
      assert.equal(run().status, 0);
      const before = filesIn(to).length;
      const ruleFile = path.join(w.configDir, "rules", readdirSync(path.join(w.configDir, "rules"))[0]!);
      writeFileSync(ruleFile, readFileSync(ruleFile, "utf8").replace("assess(kase, ctx) {", 'assess(kase, ctx) {\n    ctx.item("gcp-demo:98");'));
      const left = run();
      assert.match(left.stdout, /同一时刻早先补录过另一份（输入不同，用的是别的判断方法）：gcp-demo:1 .*没动，两份都会进重放；要换掉旧的，加 --replace/);
      assert.equal(filesIn(to).length, before * 2);
      const replaced = run("--replace", "--json");
      const json = JSON.parse(replaced.stdout) as { made: unknown[]; superseded: Array<{ removed: boolean }> };
      assert.equal(json.made.length, 0);
      assert.equal(json.superseded.length, before);
      assert.ok(json.superseded.every((x) => x.removed));
      assert.equal(filesIn(to).length, before);
      assert.match(run("--replace").stdout, /新补录了 0 份/);
    } finally {
      rmSync(to, { recursive: true, force: true });
    }
  });
});

test("a journal with a hole in the middle is refused: the state folded over it was never one", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const [data, to] = [tmp(), tmp()];
    try {
      cpSync(w.dataDir, data, { recursive: true });
      const file = path.join(data, "journal", readdirSync(path.join(data, "journal")).sort()[0]!);
      const lines = readFileSync(file, "utf8").split("\n");
      assert.ok(lines.length > 10);
      const gone = JSON.parse(lines[4]!) as { seq: number };
      writeFileSync(file, [...lines.slice(0, 4), ...lines.slice(5)].join("\n"));
      await assert.rejects(backfill({ configDir: w.configDir, dataDir: data, to }), (e: Error) => e instanceof BackfillError && new RegExp(`日志中间缺了东西（seq ${gone.seq - 1} 后面是 ${gone.seq + 1}）`).test(e.message));
      assert.deepEqual(readdirSync(to), [], "nothing is made");
    } finally {
      rmSync(data, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });
});

// ---- what a person wrote on a capsule is not lost when it is replaced; a file in the way; the candidate's rules (re-review R1, R3, R5) ----

/** The rule in use read one thing more (another version of it): a backfill of it is other capsules for the same moments. */
const readsMore = (dir: string, item = "gcp-demo:98") => {
  const ruleFile = path.join(dir, "rules", readdirSync(path.join(dir, "rules"))[0]!);
  writeFileSync(ruleFile, readFileSync(ruleFile, "utf8").replace("assess(kase, ctx) {", `assess(kase, ctx) {\n    ctx.item("${item}");`));
};
const expectOf = (file: string) => (readCapsule(file) as { capsule: Capsule }).capsule.expect;
const SAID = { headline: { has: ["示例"] } };

test("--replace carries what a person wrote on an old backfill capsule to the new one before it takes the old one away", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const [a, b] = [tmp(), tmp()];
    try {
      // Replaced at once: the new one is written with what the old one had.
      const first = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: a });
      const mine = first.made[0]!;
      replaceExpect(mine.file, SAID);
      readsMore(w.configDir);
      const second = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: a, replace: true });
      assert.equal(second.made.length, first.made.length);
      const moved = second.superseded.find((s) => s.capsule.id === mine.capsule.id)!;
      assert.deepEqual([moved.removed, moved.carried, moved.kept], [true, true, null]);
      assert.equal(existsSync(mine.file), false, "the old one is gone");
      const there = second.made.find((m) => m.capsule.case === mine.capsule.case && m.capsule.at === mine.capsule.at)!;
      assert.deepEqual(expectOf(there.file), SAID, "and what was said is on the new one, in its file");
      assert.deepEqual(there.capsule.expect, SAID, "and in what is returned");
      assert.equal(second.superseded.filter((s) => s.carried).length, 1, "only the one that had something");
      assert.ok(second.superseded.filter((s) => s.capsule.id !== mine.capsule.id).every((s) => s.removed && !s.carried));
      assert.equal(loadCapsules([a]).capsules.filter((c) => c.capsule.expect !== null).length, 1, "one expect before, one after");

      // Replaced later, the new capsules being there already (an earlier backfill without --replace): it is written into the file that is there.
      const base = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: b });
      replaceExpect(base.made[0]!.file, SAID);
      readsMore(w.configDir, "gcp-demo:97");
      const left = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: b });
      const old = left.superseded.find((s) => s.capsule.id === base.made[0]!.capsule.id)!;
      assert.deepEqual([old.removed, old.carried], [false, false], "without --replace nothing is taken away, and nothing is moved");
      assert.ok(old.capsule.expect, "and the old one still has it");
      const now = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: b, replace: true });
      assert.deepEqual(now.made, [], "the new ones were there");
      const moved2 = now.superseded.find((s) => s.capsule.id === base.made[0]!.capsule.id)!;
      assert.deepEqual([moved2.removed, moved2.carried], [true, true]);
      const target = now.existing.find((m) => m.capsule.case === base.made[0]!.capsule.case && m.capsule.at === base.made[0]!.capsule.at)!;
      assert.deepEqual(expectOf(target.file), SAID, "in the file already there");
    } finally {
      for (const d of [a, b]) rmSync(d, { recursive: true, force: true });
    }
  });
});

test("--replace does not take away an old backfill capsule whose expect the new one contradicts; the same expect on both is not a conflict", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const to = tmp();
    try {
      const first = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      const [one, two] = [first.made[0]!, first.made[1]!];
      replaceExpect(one.file, SAID);
      replaceExpect(two.file, SAID);
      readsMore(w.configDir);
      await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      // The new capsule of the first moment says another thing; of the second, the same.
      const fresh = loadCapsules([to]).capsules.filter((c) => c.capsule.expect === null);
      const ofMoment = (m: { capsule: Capsule }) => fresh.find((c) => c.capsule.case === m.capsule.case && c.capsule.at === m.capsule.at)!;
      replaceExpect(ofMoment(one).file, { stage: "finished" });
      replaceExpect(ofMoment(two).file, SAID);
      const result = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to, replace: true });
      const s1 = result.superseded.find((s) => s.capsule.id === one.capsule.id)!;
      const s2 = result.superseded.find((s) => s.capsule.id === two.capsule.id)!;
      assert.deepEqual([s1.removed, s1.carried, s1.kept], [false, false, "expect"], "kept, and said so");
      assert.equal(existsSync(one.file), true);
      assert.deepEqual(expectOf(one.file), SAID, "what the person wrote is where they wrote it");
      assert.deepEqual([s2.removed, s2.carried, s2.kept], [true, false, null], "the same on both: the old one goes, nothing to carry");
      assert.equal(existsSync(two.file), false);
    } finally {
      rmSync(to, { recursive: true, force: true });
    }
  });
});

test("the command says what --replace did with what a person wrote, and what it would do without", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const to = tmp();
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, [BIN, "cases", "backfill", "--config", w.configDir, "--data", w.dataDir, "--to", to, ...args], { encoding: "utf8" });
      const first = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      replaceExpect(first.made[0]!.file, SAID);
      readsMore(w.configDir);
      const left = run();
      assert.match(left.stdout, /没动，两份都会进重放；要换掉旧的，加 --replace（只删这个目录里补录出的旧存档；它带着 expect，会搬到新的那份上，不会丢）/);
      const moved = JSON.parse(run("--replace", "--json").stdout) as { superseded: Array<{ carried: boolean; removed: boolean; kept: string | null; expect: boolean }> };
      assert.equal(moved.superseded.filter((s) => s.carried && s.removed && s.kept === null && s.expect).length, 1);
      // And the text, with one that is kept: the new one says another.
      const base = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      assert.deepEqual(base.superseded, [], "nothing left over now");
      assert.equal(base.existing.length, first.made.length);
    } finally {
      rmSync(to, { recursive: true, force: true });
    }
  });
});

test("a file of the capsule's name that cannot be read is not written over and not counted as made: the backfill says it could not write", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const to = tmp();
    try {
      const first = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      const victim = first.made[0]!;
      writeFileSync(victim.file, '{ "v": 7 }');
      const again = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to });
      assert.deepEqual(again.made, [], "nothing was written");
      assert.deepEqual(again.blocked.map((b) => [b.file, b.capsule.id]), [[victim.file, victim.capsule.id]]);
      assert.equal(again.existing.length, first.made.length - 1);
      assert.equal(readFileSync(victim.file, "utf8"), '{ "v": 7 }', "the file is as it was");
      const args = [BIN, "cases", "backfill", "--config", w.configDir, "--data", w.dataDir, "--to", to];
      const run = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.match(run.stdout, /新补录了 0 份/);
      assert.match(run.stdout, /1 份没能写/);
      assert.match(run.stdout, /没写：gcp-demo:1 .*同名的文件在，读不了，没覆盖/);
      const json = JSON.parse(spawnSync(process.execPath, [...args, "--json"], { encoding: "utf8" }).stdout) as { made: unknown[]; blocked: Array<{ id: string }> };
      assert.deepEqual([json.made.length, json.blocked.map((b) => b.id)], [0, [victim.capsule.id]]);
    } finally {
      rmSync(to, { recursive: true, force: true });
    }
  });
});

test("a backfill with a candidate asks the candidate's rules, so the capsules hold what it reads; one that does not load, or is not outside the config, is refused", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const [inUseTo, candTo, cand] = [tmp(), tmp(), tmp()];
    try {
      rmSync(cand, { recursive: true });
      copyConfig(w.configDir, cand);
      readsMore(cand);
      const candFile = path.join(cand, "rules", readdirSync(path.join(cand, "rules"))[0]!);
      const candText = readFileSync(candFile, "utf8");
      const mine = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: inUseTo });
      const theirs = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: candTo, candidateDir: cand });
      const reads98 = (c: Capsule) => c.calls.some((x) => x.m === "item" && JSON.stringify(x.args) === JSON.stringify(["gcp-demo:98"]));
      assert.ok(mine.made.length > 0 && mine.made.every((m) => !reads98(m.capsule)), "the rule in use does not read it");
      assert.equal(theirs.made.length, mine.made.length);
      assert.ok(theirs.made.every((m) => reads98(m.capsule)), "the candidate's capsules hold the read");
      assert.ok(theirs.made.every((m) => m.capsule.rule.sha256 === createHash("sha256").update(candText).digest("hex")), "and say whose rule made them");
      assert.ok(theirs.made.every((m, i) => m.capsule.id !== mine.made[i]!.capsule.id), "they are other capsules");
      // The candidate with a rule that does not load: no last-good copy of the rule in use stands in for it.
      writeFileSync(candFile, "export default {");
      const to3 = tmp();
      try {
        await assert.rejects(backfill({ configDir: w.configDir, dataDir: w.dataDir, to: to3, candidateDir: cand }), (e: Error) => e instanceof BackfillError && /候选的判断方法加载不上，补不了/.test(e.message));
        assert.deepEqual(readdirSync(to3), []);
        const inside = path.join(w.configDir, "inside");
        mkdirSync(inside);
        await assert.rejects(backfill({ configDir: w.configDir, dataDir: w.dataDir, to: to3, candidateDir: inside }), PreviewError);
      } finally {
        rmSync(to3, { recursive: true, force: true });
      }
      // The command says whose rules it asked.
      writeFileSync(candFile, candText);
      const run = spawnSync(process.execPath, [BIN, "cases", "backfill", "--config", w.configDir, "--data", w.dataDir, "--to", candTo, "--candidate", cand], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /用的是候选（.*）的判断方法/);
      assert.match(run.stdout, /新补录了 0 份/);
    } finally {
      for (const d of [inUseTo, candTo, cand]) rmSync(d, { recursive: true, force: true });
    }
  });
});

test("the way out of 'cannot be told': a backfill of the candidate's rules with --replace carries the correction over, and then it is put right, or not, for real", async () => {
  await inWorld(SCENARIOS[0]![1], async (w) => {
    await SCENARIOS[0]![2](w);
    const cand = tmp();
    try {
      rmSync(cand, { recursive: true });
      const cases = path.join(w.configDir, "cases", "backfill");
      const first = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: cases });
      const mine = first.made[first.made.length - 1]!.capsule;
      assert.ok(!mine.outcome.output!.headline.includes("已核对"));
      setExpect({ configDir: w.configDir, id: mine.id, expect: { headline: { has: ["已核对"] } } });
      // The candidate says it ("已核对"), and reads one thing more to do so: the capsule cannot tell.
      copyConfig(w.configDir, cand);
      const ruleFile = path.join(cand, "rules", readdirSync(path.join(cand, "rules"))[0]!);
      writeFileSync(ruleFile, readFileSync(ruleFile, "utf8").replace("assess(kase, ctx) {", 'assess(kase, ctx) {\n    ctx.item("gcp-demo:98");').replace("`${headline}${headTail}`", "`${headline}（已核对）${headTail}`"));
      const options = { configDir: w.configDir, candidateDir: cand, dataDir: w.dataDir, nowMs: w.clock.now };
      const stuck = await preview(options);
      assert.deepEqual(stuck.replay.expect.unknown.map((e) => e.id), [mine.id], "cannot be told");
      assert.deepEqual(stuck.replay.expect.fixed, []);
      await assert.rejects(applyCandidate({ ...options, expect: stuck.id }), (e: Error) => e instanceof PreviewError && /纠错核对不了 1 处/.test(e.message));

      // The way out the preview points at: the capsules again, with the candidate's rules, the correction going to the new one.
      const result = await backfill({ configDir: w.configDir, dataDir: w.dataDir, to: cases, candidateDir: cand, replace: true });
      assert.equal(result.superseded.filter((s) => s.carried).length, 1);
      const rows = listCases({ configDir: w.configDir, dataDir: w.dataDir });
      assert.equal(rows.filter((r) => r.expect).length, 1, "the correction is still held, once");
      assert.notEqual(rows.find((r) => r.expect)!.id, mine.id, "on the capsule that holds what the candidate reads");

      const now = await preview(options);
      assert.deepEqual(now.replay.expect.unknown, [], "told for real now");
      assert.deepEqual(now.replay.expect.fixed.map((e) => e.id), [rows.find((r) => r.expect)!.id], "and it is put right");
      assert.deepEqual(now.stops, []);
      assert.deepEqual((await applyCandidate({ ...options, expect: now.id })).applied, [`rules/${path.basename(ruleFile)}`]);
    } finally {
      rmSync(cand, { recursive: true, force: true });
    }
  });
});
