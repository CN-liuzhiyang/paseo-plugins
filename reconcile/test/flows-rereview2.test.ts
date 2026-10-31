import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyConfig, preview } from "../server/preview";
import { createOutReader } from "../server/runs";
import { endedMessage } from "../server/flows";
import { at, makeWorld, probeOf, type World } from "./helpers";
import { advance, asks, failedProbe, finished, first, flowsOf, idFor, look, OWNER, POLICY, req, RULE, withFlows } from "./flows-kit";

// What the third look at the flows engine found (N7C-01 to N7C-08). The hold of the breaker goes first: a change of the rules that is
// held is held until a person lets it through, and saving the rules once more does not let it through.

/** The kit's rule, asking besides for one quick run for each item whose number is among `numbers` ("1234": the first four). */
const QUICK = (numbers: string) =>
  RULE.replace("if (f.Runs) out.run = JSON.parse(f.Runs);", `if (f.Runs) out.run = JSON.parse(f.Runs).concat(/:[${numbers}]$/.test(kase.id) ? [{ flow: "quick", key: "x", input: { n: 1 }, label: "快查" }] : []);`);
const rulesFile = (w: { configDir: string }) => path.join(w.configDir, "rules", "flow.mjs");
const save = async (w: World, text: string) => {
  writeFileSync(rulesFile(w), text);
  await look(w, 60);
};
const heldFlows = (w: World) => w.store.state.rules.held?.flows ?? null;
const started = (w: World) => w.flows.launcher.started.map((s) => s.flow);
/** Every run started so far ends, and the engine looks twice: the room is free for whatever waits. */
const endAll = async (w: World) => {
  for (const s of w.flows.launcher.started) w.flows.probes.set(s.runId, finished({ ok: true }, {}, 0));
  await look(w, 60);
  await look(w, 60);
};
const POLICY2 = POLICY({ concurrent: 2 });
const eight = (w: World) => {
  for (let n = 1; n <= 8; n++) asks(w, n, [req("k1")]);
};

// ---- N7C-01: a hold is not lifted by saving once more ---------------------------------------------------------------

test("N7C-01: what a held change of rules asks for waits for a person, however many times the rules are saved after: nothing is started until it is let through", () =>
  withFlows(
    async (w) => {
      eight(w);
      await first(w);
      assert.equal(started(w).length, 2, "two at a time: six wait");
      const four = QUICK("1234");
      await save(w, four);
      assert.equal(heldFlows(w), 4, "four new requests, over the limit of three: held");
      const firstHold = w.store.state.rules.held!.fingerprint;
      // the person looks at it and changes a word; nothing was let through
      await save(w, `// a word\n${four}`);
      assert.equal(heldFlows(w), 4, "the four are still what is asked for and nobody said yes: held, again, for this version");
      assert.notEqual(w.store.state.rules.held!.fingerprint, firstHold);
      assert.equal(w.store.state.rules.released.length, 0);
      await save(w, `// another word\n${four}`);
      assert.equal(heldFlows(w), 4, "and the next time");
      // the two that ran end and the room is free: nothing waiting starts, not the new ones and not the six that waited before
      await endAll(w);
      assert.equal(started(w).length, 2, JSON.stringify(started(w)));
      // a person lets this version through: now they start, as the room allows
      assert.equal(w.engine.releaseRules(w.store.state.rules.held!.fingerprint), true);
      await endAll(w);
      assert.ok(started(w).length > 2, "released");
      assert.ok(started(w).includes("quick-flow"), JSON.stringify(started(w)));
    },
    { policy: POLICY2 },
  ));

test("N7C-01: the hold ends the ways it should: the rules put back, or put right so that they ask for few enough; the six that waited before are not counted again", async () => {
  // put back as they were: the new requests are not asked for any more, and the hold goes with the version
  await withFlows(
    async (w) => {
      eight(w);
      await first(w);
      await save(w, QUICK("1234"));
      assert.equal(heldFlows(w), 4);
      await save(w, RULE);
      assert.equal(w.store.state.rules.held, null);
      await endAll(w);
      assert.ok(started(w).length > 2, "the queue of before goes on");
      assert.equal(started(w).includes("quick-flow"), false, "and none of the new ones was ever started");
    },
    { policy: POLICY2 },
  );
  // changed so that it asks for two (limit three): not held; the six that were waiting before are not asked for again by this change
  await withFlows(
    async (w) => {
      eight(w);
      await first(w);
      await save(w, QUICK("1234"));
      assert.equal(heldFlows(w), 4);
      await save(w, QUICK("12"));
      assert.equal(w.store.state.rules.held, null, "two new ones are not over the limit, and the six waiting are not this change's");
      await endAll(w);
      assert.equal(started(w).filter((f) => f === "quick-flow").length > 0, true, "what was left standing starts as the room comes");
    },
    { policy: POLICY2 },
  );
});

test("N7C-01: a hold that a person lets through is over: a word changed after it is not held for the queue that was let through (N7B-02 stays)", () =>
  withFlows(
    async (w) => {
      eight(w);
      await first(w);
      await save(w, QUICK("1234"));
      assert.equal(heldFlows(w), 4);
      assert.equal(w.engine.releaseRules(w.store.state.rules.held!.fingerprint), true);
      await look(w, 60);
      await save(w, `// a word\n${QUICK("1234")}`);
      assert.equal(w.store.state.rules.held, null, "ten wait, and none is asked for again by a word");
      assert.equal(w.engine.heldFlows().length >= 8, true);
      await save(w, `// another word\n${QUICK("1234")}`);
      assert.equal(w.store.state.rules.held, null);
    },
    { policy: POLICY2 },
  ));

test("N7C-01: a restart in the middle of a hold does not lift it either", () =>
  withFlows(
    async (w) => {
      eight(w);
      await first(w);
      await save(w, QUICK("1234"));
      assert.equal(!!w.store.state.rules.held, true);
      await w.restart();
      await first(w);
      await save(w, `// a word\n${QUICK("1234")}`);
      assert.equal(!!w.store.state.rules.held, true, "what the queue is made of is not known after a restart: it is counted for the version held");
      await endAll(w);
      assert.equal(started(w).length, 2, JSON.stringify(started(w)));
    },
    { policy: POLICY2 },
  ));

test("N7C-01: the preview counts the same: a word changed in a version that is held asks for what the held one asked for", async () => {
  const w = await makeWorld({ start: "2026-10-13 09:50", flows: true, config: { rules: { "flow.mjs": RULE }, policy: POLICY2 } });
  const candidate = mkdtempSync(path.join(os.tmpdir(), "reconcile-candidate-"));
  try {
    eight(w);
    await w.run("2026-10-13 10:00", 5);
    writeFileSync(rulesFile(w), QUICK("1234"));
    await w.run("2026-10-13 10:10", 5);
    assert.equal(heldFlows(w), 4);
    rmSync(candidate, { recursive: true });
    copyConfig(w.configDir, candidate);
    writeFileSync(path.join(candidate, "rules", "flow.mjs"), `// a word\n${QUICK("1234")}`);
    const held = await preview({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now });
    assert.ok(held.breaker, "held in use, and a word does not let it through");
    assert.ok(held.breaker!.changes.flows >= 4, JSON.stringify(held.breaker));
    assert.ok(held.caveats.some((c) => /排队等空位的流程请求/.test(c)), "and the preview says what it cannot tell");
    // the same candidate against rules that are not held: the queue is what waited, and a word asks for nothing
    assert.equal(w.engine.releaseRules(w.store.state.rules.held!.fingerprint), true);
    await w.run("2026-10-13 10:20", 5);
    const free = await preview({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now });
    assert.equal(free.breaker, null);
  } finally {
    w.close();
    rmSync(candidate, { recursive: true, force: true });
  }
});

// ---- N7C-03: the result is at the end of the file ---------------------------------------------------------------------

/** What `orch.mjs run` prints at its end: its result, as JSON, two spaces to a level. */
const printed = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: true, outcome: "done", value: { found: 2 }, summary: "找到 2 处", runId: "rc-x", events: "/logs/runs/rc-x.jsonl", cost: null, caveats: [], durationMs: 5, error: null, stop: null, ...over }, null, 2) + "\n";

test("N7C-03: the runner prints its result after everything the flow wrote, so the end of the file is read: a result past a megabyte of other words is found, the last one of several is the run's", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-out-"));
  try {
    const read = createOutReader(dir);
    const MB = 1024 * 1024;
    const noise = "log line of the flow\n".repeat(Math.ceil((1.3 * MB) / 21));
    writeFileSync(path.join(dir, "rc-noisy.out"), noise + printed({ cost: { totalUsd: 0.4, agentCount: 1, partial: "" } }));
    const probe = read("rc-noisy")!;
    assert.deepEqual([probe.end!.outcome, probe.end!.value, probe.end!.valueDropped, probe.costUsd, probe.costKnown], ["done", { found: 2 }, false, 0.4, true], "whole, with what it cost");
    // an earlier try's result is in there, and so is a flow's own print that looks like a result: the last result printed is the run's
    writeFileSync(path.join(dir, "rc-many.out"), printed({ outcome: "failed", ok: false, value: null }) + noise + '{\n  "ok": true,\n  "outcome": "mystery"\n}\n' + noise + printed({ value: { found: 9 } }));
    assert.deepEqual([read("rc-many")!.end!.outcome, read("rc-many")!.end!.value], ["done", { found: 9 }]);
    // past the window and nothing printed at the end: a run that has not finished (or was killed) has no result
    writeFileSync(path.join(dir, "rc-unfinished.out"), noise);
    assert.equal(read("rc-unfinished"), null);
    // a file the size of the window, and one a byte over, with the result at the very end
    for (const extra of [0, 1]) {
      const body = printed();
      writeFileSync(path.join(dir, `rc-edge${extra}.out`), "x".repeat(MB - body.length + extra) + body);
      assert.deepEqual(read(`rc-edge${extra}`)!.end!.value, { found: 2 }, `edge ${extra}`);
    }
    // an object inside the value that looks like a result is not one; and a result glued to a last line that had no new line is still the result
    writeFileSync(path.join(dir, "rc-nested.out"), "last words, no new line" + printed({ value: { inner: { ok: false, outcome: "failed" }, found: 2 } }));
    const nested = read("rc-nested")!;
    assert.deepEqual([nested.end!.outcome, nested.end!.value], ["done", { inner: { ok: false, outcome: "failed" }, found: 2 }]);
    // a result longer than the window began before it: the head of the file says how it ended, and what it cost is not known
    writeFileSync(path.join(dir, "rc-huge.out"), printed({ value: { pad: "x".repeat(2 * MB) } }));
    const huge = read("rc-huge")!;
    assert.deepEqual([huge.end!.outcome, huge.end!.valueDropped, huge.costKnown], ["done", true, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- N7C-02: what the run printed wins over "it never got going" ------------------------------------------------------------

test("N7C-02: the runtime's claim for a run is there and its events are not (cleaned out from under it), and the run printed its result: it is told as what it came to, not as one that never got going", async () => {
  await withFlows(async (w) => {
    const states = ["absent", "dead-before-start", "stalled-before-start"] as const;
    states.forEach((_, i) => asks(w, i + 1, [req("k1", { n: i })]));
    await first(w);
    const ids = states.map((_, i) => idFor(i + 1, "k1"));
    assert.equal(w.flows.launcher.started.length, 3);
    ids.forEach((id, i) => {
      w.flows.probes.set(id, probeOf({ state: states[i]!, safeToRestart: states[i] === "absent" }));
      w.flows.outs.set(id, finished({ found: i }, {}, 0.3));
    });
    await advance(w, 10);
    for (const [i, id] of ids.entries()) assert.deepEqual([states[i], flowsOf(w)[id]!.ended?.outcome, flowsOf(w)[id]!.ended?.value, flowsOf(w)[id]!.ended?.costUsd], [states[i], "done", { found: i }, 0.3]);
    assert.equal(w.flows.launcher.started.length, 3, "and none is started again");
  }, { policy: POLICY({}) });
  // with nothing printed, it is what the claim says, as before: it never got going, seen twice
  await withFlows(async (w) => {
    asks(w, 1, [req("k1")]);
    await first(w);
    w.flows.probes.set(idFor(1, "k1"), probeOf({ state: "stalled-before-start" }));
    await advance(w, 10);
    assert.equal(flowsOf(w)[idFor(1, "k1")]!.ended?.outcome, "not-started");
  });
});

// ---- N7C-06: every sentence of the flow's in a message is a sentence ----------------------------------------------------

test("N7C-06: what the flow says in a message -- its summary, why it stopped, the error it ended with -- is sent as words: nothing in it is drawn as a link, a tag, code, a mention, emphasis, a table or a heading", () => {
  const rec = { label: "初查", caseId: "gcp-demo:7" };
  const base = { at: "2026-10-13T02:00:00.000Z", costUsd: 0, valueDropped: false };
  const raw = "[点这里](https://evil.example/x) <b>x</b> `c` **b** _i_ ~s~ a|b @all #1 db_main";
  const plain = "［点这里］(https://evil.example/x) ＜b＞x＜/b＞ ｀c｀ ＊＊b＊＊";
  const done = endedMessage(rec, { ...base, outcome: "done", summary: raw, value: null, why: null });
  assert.ok(done.text.startsWith(`#7 初查好了：${plain}`), done.text);
  const unfinished = endedMessage(rec, { ...base, outcome: "stopped", summary: null, value: { why: raw }, why: "x" });
  assert.ok(unfinished.text.startsWith("#7 初查停了：［点这里］(https://evil.example/x) ＜b＞x＜/b＞"), `cut to a few words, and what is left is as words: ${unfinished.text}`);
  for (const m of [done, unfinished]) assert.equal(/[[\]<>`@*_~|#]/.test(m.text.replace("#7 ", "")), false, m.text);
  // a message tells what became of a run and not what the machine said about it: the error is on the page, so no mark of it can reach the push
  const failed = endedMessage(rec, { ...base, outcome: "failed", summary: null, value: null, why: `OutputMismatch：${raw}` });
  assert.match(failed.text, /^#7 初查出错了：[^[\]<>`@*_~|]*$/, failed.text);
  assert.ok(!failed.text.includes("evil.example"), "none of the machine's words");
});

test("N7C-06: a summary that is a good news goes through the same on its way to the person", () =>
  withFlows(
    async (w) => {
      asks(w, 1, [req("k1")]);
      await first(w);
      w.flows.probes.set(idFor(1, "k1"), finished({ ok: true }, { summary: "[打开报告](https://evil.example/r) **全好**" }));
      await advance(w, 10);
      const sent = w.deliveries.find((d) => d.text.startsWith("#1"))!;
      assert.equal(sent.title, "初查好了");
      assert.equal(sent.text, "#1 初查好了：［打开报告］(https://evil.example/r) ＊＊全好＊＊。");
    },
    { persons: OWNER() },
  ));

// ---- N7D-01: an item that is cold when the rules are saved still owes the count for the held version -------------------------

test("N7D-01: requests of items that are cold when the rules are saved were counted for the held version, and are counted again with the new one: the hold does not lift, whether the items are hot again by the time room frees or not", async () => {
  const w = await makeWorld({ start: "2026-10-13 10:00", flows: true, config: { rules: { "flow.mjs": RULE }, policy: POLICY2 } });
  try {
    eight(w);
    await first(w);
    const four = QUICK("1234");
    await save(w, four);
    assert.equal(heldFlows(w), 4, "four new requests, over the limit of three: held");
    // 3 and 4 only have queued requests (no run) and a quiet title: cold (heat.ts), so the rules do not judge them
    const cool = (n: number, cold: boolean) => {
      const key = `gcp-demo:${n}`;
      const item = w.items.get(key)!;
      w.items.set(key, { ...item, title: cold ? `长期维护 ${n}` : `issue ${n}`, fields: { ...item.fields, Release: cold ? "2027-03-01" : "2026-10-14" }, sourceUpdatedAt: cold ? "2026-10-13T10:05:00+08:00" : "2026-10-13T10:07:00+08:00" });
    };
    cool(3, true);
    cool(4, true);
    await advance(w, 30);
    await look(w, 60);
    assert.deepEqual(w.engine.status().cold.map((c) => c.caseId).filter((id) => /:[34]$/.test(id)).sort(), ["gcp-demo:3", "gcp-demo:4"], "cold: not judged by the next save");
    const heldFor = w.store.state.rules.held!.fingerprint;
    // the person changes a word while they are cold: nobody let anything through
    await save(w, `// a word\n${four}`);
    assert.equal(heldFlows(w), 4, "the two cold ones are owed to the new version with the two that were judged: still held");
    assert.notEqual(w.store.state.rules.held!.fingerprint, heldFor);
    // and once more while they are still cold: they are owed to the version that holds now, not only to the first
    await save(w, `// another word\n${four}`);
    assert.equal(heldFlows(w), 4, "still held after the next save");
    // they are hot again and judged: nothing changes
    cool(3, false);
    cool(4, false);
    await advance(w, 30);
    await look(w, 60);
    assert.equal(heldFlows(w), 4, "still held");
    await endAll(w);
    await endAll(w);
    assert.equal(started(w).length, 2, JSON.stringify(started(w)));
    // a person lets it through: now they start
    assert.equal(w.engine.releaseRules(w.store.state.rules.held!.fingerprint), true);
    await endAll(w);
    await endAll(w);
    assert.ok(started(w).includes("quick-flow"), JSON.stringify(started(w)));
  } finally {
    w.close();
  }
});

test("N7D-01: a cold item's queued requests owed to a held version, when the new version is not over the limit, are counted and let go (not owed for ever)", async () => {
  const w = await makeWorld({ start: "2026-10-13 10:00", flows: true, config: { rules: { "flow.mjs": RULE }, policy: POLICY2 } });
  try {
    eight(w);
    await first(w);
    await save(w, QUICK("1234"));
    assert.equal(heldFlows(w), 4);
    const key = "gcp-demo:3";
    const item = w.items.get(key)!;
    w.items.set(key, { ...item, title: "长期维护 3", fields: { ...item.fields, Release: "2027-03-01" }, sourceUpdatedAt: "2026-10-13T10:05:00+08:00" });
    await advance(w, 30);
    await look(w, 60);
    // the person puts it right so that the new version asks for two (cases 1 and 2); case 3 is cold and owes its one: three, not over
    await save(w, QUICK("12"));
    assert.equal(w.store.state.rules.held, null, "counted: 2 judged + 1 cold that was held = 3, not over the limit of 3");
    // and the cold one is not owed any more: a word saved after is not held
    await save(w, `// a word\n${QUICK("12")}`);
    assert.equal(w.store.state.rules.held, null);
  } finally {
    w.close();
  }
});
