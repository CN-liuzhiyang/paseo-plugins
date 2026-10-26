import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RunView } from "../shared/graph";
import { endedMessage, unfinishedWhy } from "../server/flows";
import { createOutReader, probeFromRunnerOutput } from "../server/runs";
import { at } from "./helpers";
import { advance, asks, failedProbe, finished, first, flowsOf, headline, idFor, look, OWNER, POLICY, req, RULE, withFlows } from "./flows-kit";

// What the second review of the flows engine found (N7B-01 to N7B-11): a run whose files were cleaned out is not run again,
// the breaker counts what a change of rules asks for and not what was already waiting, a request taken over stays taken over,
// a run that came to no result is told for longer than good news is, and a sentence of the flow's is sent as a sentence.

const WHY = "连不上数据库，可能是 VPN 没开，这次没查";
const stop = (value: unknown, costUsd = 0) => finished(value, { outcome: "stopped", stop: "没查成", summary: null }, costUsd);

// ---- N7B-01: what the runner printed ---------------------------------------------------------------------------

/** What `orch.mjs run` prints at its end: its result, as JSON, two spaces to a level. */
const printed = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: true, outcome: "done", value: { found: 2 }, summary: "找到 2 处", runId: "rc-x", events: "/logs/runs/rc-x.jsonl", cost: null, caveats: [], durationMs: 5, error: null, stop: null, ...over }, null, 2) + "\n";

test("N7B-01: what the runner printed at its end says how the run ended, with its value and what it cost", () => {
  const done = probeFromRunnerOutput(printed(), 1234)!;
  assert.equal(done.state, "ended");
  assert.deepEqual([done.end!.outcome, done.end!.summary, done.end!.value, done.end!.valueDropped, done.end!.at], ["done", "找到 2 处", { found: 2 }, false, 1234]);
  assert.deepEqual([done.costUsd, done.costKnown, done.reachable, done.safeToRestart], [0, true, true, false], "no agent was asked anything: nothing was spent");
  const spent = probeFromRunnerOutput(printed({ cost: { totalUsd: 0.4, agentCount: 1, partial: "" } }), 1)!;
  assert.deepEqual([spent.costUsd, spent.costKnown, spent.end!.totalUsd], [0.4, true, 0.4]);
  const odd = probeFromRunnerOutput(printed({ cost: { agentCount: 1, partial: "" } }), 1)!;
  assert.deepEqual([odd.costUsd, odd.costKnown], [0, false], "agents were asked and no total was given: it spent something, and what is not known");
  const stopped = probeFromRunnerOutput(printed({ outcome: "stopped", value: { why: WHY }, stop: { reason: "没查成" } }), 1)!;
  assert.deepEqual([stopped.end!.outcome, stopped.end!.stop, stopped.end!.value], ["stopped", "没查成", { why: WHY }]);
  const failed = probeFromRunnerOutput(printed({ ok: false, outcome: "failed", value: null, summary: null, error: { name: "OutputMismatch", message: "回答不合格式" } }), 1)!;
  assert.deepEqual([failed.end!.outcome, failed.end!.error?.name], ["failed", "OutputMismatch"]);
  assert.equal(probeFromRunnerOutput(printed({ ok: false, outcome: "timeout", value: null }), 1)!.end!.outcome, "timeout");
  // a value past the bound is not kept, as the events' reader does
  const big = probeFromRunnerOutput(printed({ value: { pad: "x".repeat(20_000) } }), 1)!;
  assert.deepEqual([big.end!.outcome, big.end!.value, big.end!.valueDropped], ["done", null, true]);
});

test("N7B-01: a run started more than once has the last result in the file; a refusal, a process that printed nothing and a word it does not know are no result", () => {
  const later = probeFromRunnerOutput(`UsageError: the first try was refused\n\n${printed({ ok: false, outcome: "failed", value: null })}${printed()}`, 1)!;
  assert.equal(later.end!.outcome, "done", "the last one printed");
  for (const text of ["", "UsageError: --run-id is ambiguous\n", "{\n  \"ok\": true,\n  \"outcome\": \"mystery\"\n}\n", "not json at all", "{ \"outcome\": \"done\" }"]) assert.equal(probeFromRunnerOutput(text, 1), null, JSON.stringify(text));
  // cut short (or followed by words of a later try): that it ended, and how, is all there is; what it cost is not known
  const cut = probeFromRunnerOutput(printed().slice(0, 60), 1)!;
  assert.deepEqual([cut.end!.outcome, cut.end!.value, cut.end!.valueDropped, cut.costKnown], ["done", null, true, false]);
  const trailing = probeFromRunnerOutput(`${printed()}Error: something after\n`, 1)!;
  assert.deepEqual([trailing.end!.outcome, trailing.costKnown], ["done", false]);
});

test("N7B-01: the controller's own output file for a run is read, up to a bound; none, or none of a result, is nothing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-out-"));
  try {
    const read = createOutReader(dir);
    assert.equal(read("rc-none"), null);
    writeFileSync(path.join(dir, "rc-a.out"), printed());
    assert.equal(read("rc-a")!.end!.outcome, "done");
    writeFileSync(path.join(dir, "rc-refused.out"), "RunRefused: the id is taken\n");
    assert.equal(read("rc-refused"), null);
    // far past the bound: the head says how it ended, the rest is not read
    writeFileSync(path.join(dir, "rc-big.out"), printed({ value: { pad: "x".repeat(2 * 1024 * 1024) } }));
    const big = read("rc-big")!;
    assert.deepEqual([big.end!.outcome, big.end!.valueDropped, big.costKnown], ["done", true, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N7B-01: a run started, whose files are not there but which printed its result, is told as what it came to and not started again; one that printed nothing still is", () =>
  withFlows(async (w) => {
    const [a, b] = [idFor(1, "k1"), idFor(2, "k1")];
    asks(w, 1, [req("k1", { n: 1 })], { Watch: "triage:k1" });
    asks(w, 2, [req("k1", { n: 2 })], { Watch: "triage:k1" });
    await first(w);
    assert.equal(w.flows.launcher.started.length, 2);
    // nothing of either in the runtime's files (cleaned out), and the runtime allows a start again; only the first printed its result
    for (const id of [a, b]) w.flows.probes.set(id, { state: "absent", safeToRestart: true });
    w.flows.outs.set(a, finished({ found: 2 }, {}, 0.3));
    await advance(w, 10);
    const rec = flowsOf(w)[a]!;
    assert.deepEqual([rec.ended?.outcome, rec.ended?.value, rec.ended?.costUsd], ["done", { found: 2 }, 0.3]);
    assert.equal(w.flows.launcher.started.filter((s) => s.runId === a).length, 1, "the one that ran is not run again");
    assert.equal(headline(w, 1), 'r triage:k1=done{"found":2}');
    assert.ok(w.flows.launcher.started.filter((s) => s.runId === b).length > 1, "nothing to show it ran: it is started again under its id, as before");
  }));

// ---- N7B-02: a change of rules is counted for what it asks for ----------------------------------------------------

const EXTRA = RULE.replace("if (f.Runs) out.run = JSON.parse(f.Runs);", 'if (f.Runs) out.run = JSON.parse(f.Runs); if (f.Extra) out.run = (out.run || []).concat([{ flow: "quick", key: "x", input: { n: 1 }, label: "快查" }]);');
const TRIVIAL = RULE.replace('headline: "r "', 'headline: "r2 "');
const rulesFile = (w: { configDir: string }) => path.join(w.configDir, "rules", "flow.mjs");

test("N7B-02: requests already waiting for room are not asked for again by every change of the rules: a word of a headline does not hold them", () =>
  withFlows(
    async (w) => {
      for (let n = 1; n <= 6; n++) asks(w, n, [req("a")]);
      await first(w);
      assert.equal(w.flows.launcher.started.length, 2, "two at a time: four wait");
      assert.equal(w.engine.heldFlows().length, 4);
      writeFileSync(rulesFile(w), TRIVIAL);
      await look(w, 60);
      assert.ok(!w.store.state.rules.held, "nothing was asked for that was not before");
      assert.equal(w.engine.heldFlows().length, 4, "and they still wait");
      writeFileSync(rulesFile(w), RULE.replace('headline: "r "', 'headline: "r3 "'));
      await look(w, 60);
      assert.ok(!w.store.state.rules.held, "nor by the next change");
    },
    { policy: POLICY({ concurrent: 2 }) },
  ));

test("N7B-02: what a change of rules newly asks for is counted whether or not it can start now, on top of what waits already", async () => {
  for (const [extras, held] of [[3, false], [4, true]] as const) {
    await withFlows(
      async (w) => {
        for (let n = 1; n <= 6; n++) asks(w, n, [req("a")], n > 6 - extras ? { Extra: "1" } : {});
        await first(w);
        assert.equal(w.engine.heldFlows().length, 4);
        writeFileSync(rulesFile(w), EXTRA);
        await look(w, 60);
        assert.equal(!!w.store.state.rules.held, held, `${extras} new ones (limit 3), with four already waiting`);
        if (held) assert.equal(w.store.state.rules.held!.flows, extras, "the new ones only");
        else assert.equal(w.engine.heldFlows().length, 4 + extras, "asked for, and waiting with the rest");
      },
      { policy: POLICY({ concurrent: 2 }) },
    );
  }
});

// ---- N7B-03: a request taken over stays taken over ----------------------------------------------------------------

test("N7B-03: the newest round of a request set aside is the request set aside: the round before it does not come back as the item's condition, nor keep its buttons", async () => {
  for (const kind of ["failed", "unchecked"] as const) {
    for (const how of ["mine", "fold"] as const) {
      await withFlows(async (w) => {
        const bad = () => (kind === "failed" ? failedProbe() : stop({ why: WHY }));
        const [r0, r1] = [idFor(1, "a"), idFor(1, "a", "triage", 1)];
        asks(w, 1, [req("a")]);
        await first(w);
        w.flows.probes.set(r0, bad());
        await look(w, 60);
        assert.equal(w.engine.retryFlow(r0, "page").ok, true);
        await look(w, 5);
        w.flows.probes.set(r1, bad());
        await look(w, 60);
        const situation = () => w.engine.status().cases.find((c) => c.caseId === "gcp-demo:1")!.row!.situation;
        const runs = (): RunView[] => w.engine.graph("gcp-demo:1")!.runs;
        assert.equal(situation(), kind === "failed" ? "fail" : "unchecked", `${kind}: two rounds, both bad`);
        assert.deepEqual(runs().map((r) => [r.round, r.actions]), [[1, ["retry", "mine", "fold"]], [0, []]], "only the newest round has a way out: the earlier one is history");
        assert.equal(w.engine.dismissFlow(r1, how, "page").ok, true);
        await look(w, 5);
        assert.equal(situation(), "them", `${kind}/${how}: the item is as its rule says again`);
        assert.deepEqual(runs().map((r) => r.actions), [[], []], "and no round of it asks to be set aside");
        assert.equal(w.engine.graph("gcp-demo:1")!.hero.kicker.includes("看一眼"), false);
      });
    }
  }
});

// ---- N7B-06: what is told, and for how long ------------------------------------------------------------------------

const FRIDAY_NIGHT = "2026-10-16 20:30";

test("N7B-06: a run that came to no result is still told on Monday morning when it ended on Friday evening; good news that old is left for the next card, and so is anything past three days", () =>
  withFlows(
    async (w) => {
      const ids = [1, 2, 3, 4].map((n) => idFor(n, "k1"));
      for (const n of [1, 2, 3, 4]) asks(w, n, [req("k1")]);
      await first(w);
      w.clock.now = at(FRIDAY_NIGHT);
      w.flows.probes.set(ids[0]!, stop({ why: WHY }));
      w.flows.probes.set(ids[1]!, failedProbe());
      w.flows.probes.set(ids[2]!, finished({ ok: 1 }));
      await first(w);
      assert.equal(w.deliveries.length, 0, "20:30 is after the quiet hours began");
      w.clock.now = at("2026-10-19 09:35");
      await first(w);
      assert.deepEqual(w.deliveries.map((d) => d.title).sort(), ["初查没跑完", "初查没跑完"], "61 hours later, the two that need the person");
      assert.equal(w.store.state.ledger[`flow-notify:${ids[2]}:chat:u1`]!.status, "suppressed", "good news that old is news no more");
      // one that ended on Friday evening and is read on Thursday: six days
      w.flows.probes.set(ids[3]!, finished(null, { outcome: "failed", error: { name: "X", message: "m", headline: "m", plain: "x", raw: "x" } as never, at: at(FRIDAY_NIGHT) }, 0.1));
      w.clock.now = at("2026-10-22 09:35");
      await first(w);
      assert.equal(w.deliveries.length, 2);
      assert.equal(w.store.state.ledger[`flow-notify:${ids[3]}:chat:u1`]!.status, "suppressed");
    },
    { start: "2026-10-16 19:50", persons: OWNER(), policy: POLICY({}) },
  ));

// ---- N7B-07: a sentence of the flow's is sent as a sentence ---------------------------------------------------------

test("N7B-07: a why that is only marks says nothing: the run is a finished one; any letter or digit of any script makes it a sentence", () => {
  const stopWith = (why: unknown) => unfinishedWhy({ outcome: "stopped", value: { why } });
  for (const why of ["。", "...", "！？", "—— ", "（）", "…。"]) assert.equal(stopWith(why), null, why);
  for (const why of ["没连上", "x", "7", "VPN 没开。", "ネットワーク", "а"]) assert.notEqual(stopWith(why), null, why);
});

test("N7B-07: in a message what would make a link, a tag or code is not sent as one; the sentence still reads, and the page, which draws none of it, has it as it was", () =>
  withFlows(
    async (w) => {
      const raw = "[点这里修复](https://evil.example/x) <b>x</b> `code` **bold**";
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      asks(w, 2, [req("k1")]);
      await first(w);
      w.flows.probes.set(idFor(1, "k1"), stop({ why: raw }));
      w.flows.probes.set(idFor(2, "k1"), stop({ why: "。" }, 0));
      await advance(w, 10);
      const sent = w.deliveries.find((d) => d.text.startsWith("#1"))!;
      assert.equal(/[\[\]<>`]/.test(sent.text), false, sent.text);
      assert.equal(sent.text, "#1 初查没跑完：［点这里修复］(https://evil.example/x) ＜b＞x＜/b＞ ｀code｀ **bold**。详情在「事项追踪」里。");
      assert.equal(w.engine.graph("gcp-demo:1")!.runs[0]!.why, raw, "the page is not Markdown");
      const marks = w.deliveries.find((d) => d.text.startsWith("#2"))!;
      assert.equal(marks.title, "初查好了", "marks only: finished, not 'did not get done: 。'");
      assert.equal(w.engine.graph("gcp-demo:2")!.runs[0]!.situation, "done");
    },
    { persons: OWNER() },
  ));

test("N7B-07: the message of a plain sentence is as it was", () => {
  const told = endedMessage({ label: "初查", caseId: "gcp-demo:7" }, { at: "2026-10-13T02:00:00.000Z", costUsd: 0, valueDropped: false, why: "x", outcome: "stopped", summary: null, value: { why: `${WHY}。` } });
  assert.equal(told.text, `#7 初查没跑完：${WHY}。详情在「事项追踪」里。`);
});

// ---- N7B-09: no log directory known ----------------------------------------------------------------------------------

test("N7B-09: when the machine's orchestration config cannot be read nothing new is started and the reason says so, but the runs already going are still read", () =>
  withFlows(async (w) => {
    const id = idFor(1, "k1");
    asks(w, 1, [req("k1")], { Watch: "triage:k1" });
    asks(w, 2, [req("k1")]);
    await first(w);
    assert.equal(w.flows.launcher.started.length, 1 + 1);
    // the plugin comes back and the config cannot be read: no directory to start under (the intents keep theirs)
    w.flows.logDir = null;
    await w.crash();
    asks(w, 3, [req("k1")]);
    w.flows.probes.set(id, finished({ found: 2 }, {}, 0.2));
    await advance(w, 30);
    assert.equal(flowsOf(w)[id]!.ended?.outcome, "done", "the run that was going is read all the same, where its intent says");
    assert.equal(w.flows.launcher.started.length, 2, "and nothing is started");
    assert.ok(w.engine.heldFlows().every((h) => /编排配置读不了/.test(h.why)), JSON.stringify(w.engine.heldFlows()));
  }));
