import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentArchiver, type AgentArchiver, type ArchiveOutcome } from "../server/archive";
import type { Conversation } from "../server/requests";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createRunsWiring } from "../server/runs";
import { advance, asks, finished, first, flowsOf, headline, idFor, look, req, running, withFlows } from "./flows-kit";
import { ago, AFFAIR, callEnd, callStart, fixture, MIN, start } from "./run-files";

// The agents of the calls that asked to be archived once they had handed in (`$.ask(..., { archive: "after" })`), which the runtime's CLI cannot
// archive when the call ran in a background workspace (the affair's): the plugin that started the run archives them. Three parts: how the run's
// events say which are left (the reader), what is checked about an agent before it is archived (the archiver), and when the engine tries
// (ended runs only, a few times, never holding anything up).

// ---- the events: which agents are left ----------------------------------------------------------------------------------

const archiveEvent = (ts: string, callId: string, ok: boolean, agentId: string | null = "agent-1", extra: Record<string, unknown> = {}) => ({
  kind: "call.archive",
  ts,
  callId,
  agentId,
  ok,
  code: ok ? null : "AGENT_NOT_FOUND",
  message: ok ? null : "Agent not found: agent-1",
  ...extra,
});
const ASKED = { archive: "after" };
const runEnd = (ts: string) => ({ kind: "run.end", ts, outcome: "done", value: null, stop: null, error: null, durationMs: 1, cost: null, caveats: [], summary: null });
const lines = (...events: Array<Record<string, unknown>>) => events;
const withRun = (events: Array<Record<string, unknown>>, body: (archives: Array<{ callId: string; agentId: string }>) => void | Promise<void>) => {
  const f = fixture();
  try {
    f.run("r1", [start(ago(40 * MIN), AFFAIR("tracker:1")), ...events, runEnd(ago(MIN))], { claimAgeMs: null });
    return Promise.resolve(body(f.reader.archives("r1")));
  } finally {
    f.close();
  }
};

test("a call that asked to be archived, came out well and has no call.archive is left to be archived: the agent is the call's", () =>
  withRun(
    lines(callStart(ago(30 * MIN), "c1", "ask", ASKED), callEnd(ago(29 * MIN), "c1", true, { agentId: "agent-1" })),
    (archives) => assert.deepEqual(archives, [{ callId: "c1", agentId: "agent-1" }]),
  ));

test("one the runtime archived (ok: true) is not left; one it tried and could not (ok: false) is; one it never got to write down (the process died) is", () =>
  withRun(
    lines(
      callStart(ago(30 * MIN), "c1", "ask", ASKED),
      callEnd(ago(29 * MIN), "c1", true, { agentId: "agent-1" }),
      archiveEvent(ago(28 * MIN), "c1", true, "agent-1"),
      callStart(ago(27 * MIN), "c2", "ask", ASKED),
      callEnd(ago(26 * MIN), "c2", true, { agentId: "agent-2" }),
      archiveEvent(ago(25 * MIN), "c2", false, "agent-2"),
      callStart(ago(24 * MIN), "c3", "ask", ASKED),
      callEnd(ago(23 * MIN), "c3", true, { agentId: "agent-3" }),
    ),
    (archives) => assert.deepEqual(archives, [{ callId: "c2", agentId: "agent-2" }, { callId: "c3", agentId: "agent-3" }]),
  ));

test("not left: a call that did not ask, one that failed (its agent is kept to be looked into), one that did not end, a call that is not an ask, one with no agent", () =>
  withRun(
    lines(
      callStart(ago(30 * MIN), "c1", "ask", {}),
      callEnd(ago(29 * MIN), "c1", true, { agentId: "agent-1" }),
      callStart(ago(28 * MIN), "c2", "ask", ASKED),
      callEnd(ago(27 * MIN), "c2", false, { agentId: "agent-2", error: { name: "Error", message: "x" } }),
      callStart(ago(26 * MIN), "c3", "ask", ASKED),
      callStart(ago(25 * MIN), "c4", "do", ASKED),
      callEnd(ago(24 * MIN), "c4", true, { agentId: "agent-4" }),
      callStart(ago(23 * MIN), "c5", "ask", ASKED),
      callEnd(ago(22 * MIN), "c5", true, { agentId: null }),
      callStart(ago(21 * MIN), "c6", "ask", { archive: "now" }),
      callEnd(ago(20 * MIN), "c6", true, { agentId: "agent-6" }),
    ),
    (archives) => assert.deepEqual(archives, []),
  ));

test("the agent is the one the events name, and only a name that looks like an agent id is taken (the file is not trusted)", () =>
  withRun(
    lines(
      callStart(ago(30 * MIN), "c1", "ask", ASKED),
      { kind: "call.agent", ts: ago(29 * MIN), callId: "c1", agentId: "agent-1" },
      callEnd(ago(28 * MIN), "c1", true, { agentId: "agent-1" }),
      callStart(ago(27 * MIN), "c2", "ask", ASKED),
      callEnd(ago(26 * MIN), "c2", true, { agentId: "../../etc/passwd" }),
    ),
    (archives) => assert.deepEqual(archives, [{ callId: "c1", agentId: "agent-1" }]),
  ));

test("a run that is not this plugin's (another plugin's affair), or that is not there, has none left", () => {
  const f = fixture();
  try {
    const events = [callStart(ago(30 * MIN), "c1", "ask", ASKED), callEnd(ago(29 * MIN), "c1", true, { agentId: "agent-1" }), runEnd(ago(MIN))];
    f.run("other", [start(ago(40 * MIN), { label: "x", link: { plugin: "someone-else", screen: "inbox", params: { case: "tracker:1" } } }), ...events], { claimAgeMs: null });
    f.run("none", [start(ago(40 * MIN), null), ...events], { claimAgeMs: null });
    f.run("mine", [start(ago(40 * MIN), AFFAIR("tracker:1")), ...events], { claimAgeMs: null });
    assert.deepEqual(f.reader.archives("other"), []);
    assert.deepEqual(f.reader.archives("none"), []);
    assert.deepEqual(f.reader.archives("never-written"), []);
    assert.equal(f.reader.archives("mine").length, 1);
  } finally {
    f.close();
  }
});

test("the plugin's wiring reads them from the log directory a run was started under: the one it was given, or the machine's, and nowhere when there is none", () => {
  const f = fixture();
  try {
    f.run("r1", [start(ago(40 * MIN), AFFAIR("tracker:1")), callStart(ago(30 * MIN), "c1", "ask", ASKED), callEnd(ago(29 * MIN), "c1", true, { agentId: "agent-1" }), runEnd(ago(MIN))], { claimAgeMs: null });
    const logDir = path.dirname(f.dir);
    const wiring = createRunsWiring({ tz: "Asia/Shanghai", now: () => Date.now(), log: () => {}, env: { ORCH_LOG_DIR: logDir } });
    const left = [{ callId: "c1", agentId: "agent-1" }];
    assert.deepEqual(wiring.archives("r1", null), left, "the machine's log directory");
    assert.deepEqual(wiring.archives("r1", logDir), left, "the directory the run was started under");
    assert.deepEqual(wiring.archives("r1", path.join(logDir, "elsewhere")), [], "another directory has no such run");
    assert.deepEqual(wiring.archives("r2", null), []);
    writeFileSync(path.join(logDir, "broken.json"), "{not json");
    const nowhere = createRunsWiring({ tz: "Asia/Shanghai", now: () => Date.now(), log: () => {}, env: { ORCH_CONFIG: path.join(logDir, "broken.json") } });
    assert.equal(nowhere.logDir, null);
    assert.deepEqual(nowhere.archives("r1", null), [], "no log directory is known: nothing is read");
  } finally {
    f.close();
  }
});

// ---- the archiver: what is checked about an agent before it is archived -----------------------------------------------

const OF = { runId: "run-9", callId: "c3" };
const agentOf = (patch: Partial<Conversation> = {}): Conversation => ({ labels: { "orch-run": OF.runId, "orch-call": OF.callId, "orch-step": "glance" }, cwd: null, turn: null, running: false, ...patch });
function archiverOver(agent: Conversation | null | Error) {
  const archived: string[] = [];
  const archiver = createAgentArchiver({
    conversation: async () => {
      if (agent instanceof Error) throw agent;
      return agent;
    },
    archive: async (id) => void archived.push(id),
  });
  return { archiver, archived };
}

test("an agent that is the call's and is not running is archived", async () => {
  const { archiver, archived } = archiverOver(agentOf());
  assert.deepEqual(await archiver("agent-3", OF), { done: "archived" });
  assert.deepEqual(archived, ["agent-3"]);
});

test("an agent whose labels are another run's, another call's or none is left alone for good, and says what the labels are", async () => {
  const others: Array<Record<string, string>> = [{ "orch-run": "other-run", "orch-call": OF.callId }, { "orch-run": OF.runId, "orch-call": "c9" }, {}, { "orch-run": OF.runId }, { source: "feishu" }];
  for (const labels of others) {
    const { archiver, archived } = archiverOver(agentOf({ labels }));
    const outcome = await archiver("agent-3", OF);
    assert.equal(outcome.done, "not-theirs", JSON.stringify(labels));
    assert.match((outcome as { why: string }).why, /not this call's/);
    assert.deepEqual(archived, [], `${JSON.stringify(labels)}: nothing was archived`);
  }
});

test("a running agent is not archived (that would interrupt it), whether the host says so or only names a turn it is in", async () => {
  for (const patch of [{ running: true }, { running: undefined, turn: { id: "t1", steps: [] } }]) {
    const { archiver, archived } = archiverOver(agentOf(patch));
    assert.deepEqual(await archiver("agent-3", OF), { done: "running" });
    assert.deepEqual(archived, []);
  }
  const { archiver } = archiverOver(agentOf({ running: undefined, turn: null }));
  assert.deepEqual(await archiver("agent-3", OF), { done: "archived" }, "a host that does not say, and names no turn: not running");
});

test("an agent the host does not know is gone: nothing to archive; a host that fails is the engine's to retry", async () => {
  const { archiver, archived } = archiverOver(null);
  assert.deepEqual(await archiver("agent-3", OF), { done: "gone" });
  assert.deepEqual(archived, []);
  await assert.rejects(archiverOver(new Error("host is down")).archiver("agent-3", OF), /host is down/);
});

// ---- the engine ------------------------------------------------------------------------------------------------------

/** An archiver that records what it is asked and answers as the test says (a thrown error for a function that throws). */
function recorder(answer: (agentId: string, of: { runId: string; callId: string }, n: number) => ArchiveOutcome | Promise<ArchiveOutcome> = () => ({ done: "archived" })) {
  const calls: Array<{ agentId: string; runId: string; callId: string }> = [];
  const archiver: AgentArchiver = async (agentId, of) => {
    calls.push({ agentId, ...of });
    return answer(agentId, of, calls.length);
  };
  return { archiver, calls };
}
const ID = idFor(1, "k1");
const LEFT = [{ callId: "c1", agentId: "agent-1" }];
const ledger = (w: Parameters<Parameters<typeof withFlows>[0]>[0], callId = "c1", runId = ID) => w.store.state.ledger[`archive:${runId}:${callId}`];

/** A run asked for, started, and over, with agents left to archive. */
async function over(w: Parameters<Parameters<typeof withFlows>[0]>[0], left = LEFT) {
  asks(w, 1, [req("k1")], { Watch: "triage:k1" });
  await first(w);
  w.flows.probes.set(ID, running());
  await advance(w, 5);
  w.flows.archives.set(ID, left);
  w.flows.probes.set(ID, finished({ found: 2 }));
  await first(w);
  assert.equal(flowsOf(w)[ID]!.ended?.outcome, "done");
}

test("the agent of a call of a run that has ended is archived, as that call's: the ledger says so, and it is not archived twice, not after a restart either", () => {
  const { archiver, calls } = recorder();
  return withFlows(
    async (w) => {
      await over(w);
      assert.deepEqual(calls, [{ agentId: "agent-1", runId: ID, callId: "c1" }]);
      const entry = ledger(w)!;
      assert.deepEqual([entry.status, entry.tries, entry.kind, entry.subject], ["done", 1, "archive", ID]);
      assert.match(entry.summary, /^归档「初查」的 agent agent-1$/);
      await advance(w, 30);
      await w.restart();
      await advance(w, 30);
      assert.equal(calls.length, 1, "once");
    },
    { archiveAgent: archiver },
  );
});

test("a run that is still going has its agents left alone, however many calls of it have handed in", () => {
  const { archiver, calls } = recorder();
  return withFlows(
    async (w) => {
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      w.flows.archives.set(ID, LEFT);
      w.flows.probes.set(ID, running());
      await advance(w, 30);
      assert.deepEqual(calls, []);
      w.flows.probes.set(ID, finished({ found: 2 }));
      await advance(w, 5);
      assert.equal(calls.length, 1, "and when it ends");
    },
    { archiveAgent: archiver },
  );
});

test("a run that ended without a result (it broke) has its agents archived too: they handed in, and the events say so", () => {
  const { archiver, calls } = recorder();
  return withFlows(
    async (w) => {
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      w.flows.archives.set(ID, LEFT);
      w.flows.probes.set(ID, finished(null, { outcome: "failed" }, 0.3));
      await advance(w, 5);
      assert.equal(flowsOf(w)[ID]!.ended?.outcome, "failed");
      assert.equal(calls.length, 1);
    },
    { archiveAgent: archiver },
  );
});

test("an archive that fails is tried again no sooner than five minutes after, five times at most, and holds nothing up: the reconcile goes on, the item is judged, the only trace is in the log and the ledger", () => {
  const { archiver, calls } = recorder(() => {
    throw new Error("the host refused");
  });
  return withFlows(
    async (w) => {
      await over(w);
      assert.equal(calls.length, 1);
      assert.deepEqual([ledger(w)!.status, ledger(w)!.tries, ledger(w)!.reason], ["failed", 1, "the host refused"]);
      assert.ok(w.logs.some((l) => /archiving the agent agent-1 failed \(1\/5\): the host refused/.test(l)), w.logs.join("\n"));
      assert.deepEqual(w.engine.status().problems, [], "no problem is shown for it");
      await look(w, 60);
      await look(w, 120);
      assert.equal(calls.length, 1, "not within five minutes of the last try");
      await look(w, 150);
      assert.equal(calls.length, 2);
      for (let i = 0; i < 10; i++) await look(w, 300);
      assert.equal(calls.length, 5, "five tries and no more");
      assert.deepEqual([ledger(w)!.status, ledger(w)!.tries], ["failed", 5]);
      assert.ok(w.engine.status().lastTickAt, "and the reconcile never stopped");
      assert.equal(headline(w, 1), 'r triage:k1=done{"found":2}', "and the item is judged all the same");
    },
    { archiveAgent: archiver },
  );
});

test("a running agent is tried again later like a failure, and archived when it is done", () => {
  const { archiver, calls } = recorder((_agent, _of, n) => (n < 3 ? { done: "running" } : { done: "archived" }));
  return withFlows(
    async (w) => {
      await over(w);
      assert.deepEqual([ledger(w)!.status, ledger(w)!.reason], ["failed", "agent 还在跑"]);
      await look(w, 300);
      await look(w, 300);
      await look(w, 300);
      assert.equal(calls.length, 3);
      assert.deepEqual([ledger(w)!.status, ledger(w)!.tries], ["done", 3]);
      await look(w, 600);
      assert.equal(calls.length, 3);
    },
    { archiveAgent: archiver },
  );
});

test("an agent that is not the call's, or that the host no longer has, is not tried again", async () => {
  for (const [outcome, status] of [[{ done: "not-theirs", why: "labels are other" }, "suppressed"], [{ done: "gone" }, "done"]] as const) {
    const { archiver, calls } = recorder(() => outcome);
    await withFlows(
      async (w) => {
        await over(w);
        await advance(w, 60, 5);
        assert.equal(calls.length, 1, outcome.done);
        assert.equal(ledger(w)!.status, status);
      },
      { archiveAgent: archiver },
    );
  }
});

test("a call is tried for itself: the same agents of other calls, and of other runs, are not mixed up", () => {
  const { archiver, calls } = recorder((agentId) => (agentId === "agent-2" ? { done: "running" } : { done: "archived" }));
  return withFlows(
    async (w) => {
      await over(w, [{ callId: "c1", agentId: "agent-1" }, { callId: "c2", agentId: "agent-2" }]);
      assert.deepEqual(calls.map((c) => [c.agentId, c.callId]), [["agent-1", "c1"], ["agent-2", "c2"]]);
      assert.deepEqual([ledger(w, "c1")!.status, ledger(w, "c2")!.status], ["done", "failed"]);
      await look(w, 300);
      assert.deepEqual(calls.map((c) => c.agentId), ["agent-1", "agent-2", "agent-2"], "only the one that is left");
    },
    { archiveAgent: archiver },
  );
});

test("a rehearsal archives nothing, and an engine with no archiver does not either; the live one that follows does", () => {
  const { archiver, calls } = recorder();
  return withFlows(
    async (w) => {
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      w.flows.probes.set(ID, finished({ found: 2 }));
      await advance(w, 5);
      w.flows.archives.set(ID, LEFT);
      await w.restart("dry-run");
      await advance(w, 30);
      assert.deepEqual(calls, [], "dry-run");
      await w.restart("live");
      await advance(w, 5);
      assert.equal(calls.length, 1);
    },
    { archiveAgent: archiver },
  ).then(() =>
    withFlows(async (w) => {
      await over(w);
      await advance(w, 30);
      assert.equal(ledger(w), undefined, "no archiver: nothing was tried, nothing is written");
    }),
  );
});

test("a run that ended more than three days ago is not looked at, and no more than six agents are archived in one reconcile (the rest at the next)", () => {
  const { archiver, calls } = recorder();
  return withFlows(
    async (w) => {
      asks(w, 1, [req("k1")], { Watch: "triage:k1" });
      await first(w);
      w.flows.probes.set(ID, finished({ found: 2 }));
      await advance(w, 5);
      w.clock.now += 4 * 86_400_000;
      w.flows.archives.set(ID, LEFT);
      await first(w);
      assert.deepEqual(calls, [], "too long ago");
    },
    { archiveAgent: archiver },
  ).then(() =>
    withFlows(
      async (w) => {
        const eight = Array.from({ length: 8 }, (_, i) => ({ callId: `c${i + 1}`, agentId: `agent-${i + 1}` }));
        await over(w, eight);
        assert.equal(calls.length, 6, "six in the reconcile that saw the end");
        await look(w, 60);
        assert.equal(calls.length, 8, "the two that were left at the next");
        assert.deepEqual(new Set(calls.map((c) => c.callId)).size, 8);
      },
      { archiveAgent: archiver },
    ),
  );
});
