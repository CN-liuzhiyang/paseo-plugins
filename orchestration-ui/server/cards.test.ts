import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { cardItemId, cardKey, cardOf, urgentChange, type RunCard } from "../shared/card";
import { foldEvents, runStatus } from "../shared/run";
import type { Probe } from "./alive";
import { createCardFeed, isUnknownAgent, MAX_RETRY_MS, readCard, RECENT_END_MS, RETRY_MS, SPACING_MS, type CardItem } from "./cards";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const BASE = 15 * 60_000;
const HOST = "test-host";
const CALLER = "caller-agent-1";

function fixture(name: string): unknown[] {
  const text = readFileSync(path.join(FIXTURES, name), "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function lastTs(events: unknown[]): number {
  return Date.parse((events.at(-1) as { ts: string }).ts);
}

// ---- the card itself --------------------------------------------------------------------

test("card: a gate waiting says so, with who carries it and since when", () => {
  const events = fixture("docfix-waiting.jsonl");
  const run = foldEvents(events);
  const now = lastTs(events) + 1_000;
  const status = runStatus(run, now, BASE);
  assert.equal(status, "running");
  const card = cardOf("r1", run, status, now)!;
  assert.equal(card.tone, "warning");
  assert.equal(card.kicker, "需要你处理");
  assert.match(card.title, /^等你审批：/);
  assert.equal(card.gate?.callId, "c11");
  assert.equal(card.gate?.title, "批准发布 #4711 的文档修订");
  assert.ok(card.gate?.since);
  assert.equal(card.focus, "c11");
  assert.equal(card.flow, "docfix");
  assert.equal(card.endedAt, null);
  assert.equal(card.strip?.length, 6);
  // Nothing in the card counts time: a minute later it says the same.
  assert.equal(cardKey(cardOf("r1", run, status, now + 60_000)!), cardKey(card));
});

test("card: a finished run carries its outcome, duration and whole cost", () => {
  const run = foldEvents(fixture("committee-done.jsonl"));
  const card = cardOf("r2", run, "done", Date.now())!;
  assert.equal(card.status, "done");
  assert.equal(card.tone, "success");
  assert.equal(card.gate, null);
  assert.equal(card.costUsd, 0.82);
  assert.equal(card.durationMs, 209910);
  assert.match(card.costNote ?? "", /Codex/);
  assert.match(card.kicker, /^完成 · 用时/);
});

test("card: failed and stopped runs keep their tone; a run without run.start has no card", () => {
  const failed = foldEvents(fixture("advisor-failed.jsonl"));
  assert.equal(cardOf("r3", failed, runStatus(failed, Date.now(), BASE), Date.now())!.tone, "danger");
  const stopped = foldEvents(fixture("hotfix-stopped.jsonl"));
  const card = cardOf("r4", stopped, runStatus(stopped, Date.now(), BASE), Date.now())!;
  assert.equal(card.status, "stopped");
  assert.equal(card.gate, null, "a gate that was answered is not waiting");
  assert.equal(cardOf("r5", foldEvents([]), "starting", Date.now()), null);
});

test("card: lost with the process gone says so", () => {
  const events = fixture("survey-unfinished.jsonl");
  const run = foldEvents(events);
  const proc = { pid: 4242, alive: false };
  const status = runStatus(run, lastTs(events) + 1_000, BASE, proc);
  assert.equal(status, "lost");
  const card = cardOf("r6", run, status, lastTs(events) + 1_000, { proc })!;
  assert.deepEqual(card.lost, { pid: 4242, procGone: true, agents: true }, "a call with an agent was still open");
  assert.equal(card.tone, "warning");
});

test("urgent changes: first card, a gate opening or closing, the end", () => {
  const base = cardOf("r1", foldEvents(fixture("docfix-waiting.jsonl")), "running", Date.now())!;
  const noGate: RunCard = { ...base, gate: null };
  assert.equal(urgentChange(null, base), true);
  assert.equal(urgentChange(noGate, base), true);
  assert.equal(urgentChange(base, noGate), true);
  assert.equal(urgentChange(noGate, { ...noGate, title: "正在「别的」" }), false);
  assert.equal(urgentChange(noGate, { ...noGate, status: "done" }), true);
  assert.equal(urgentChange(noGate, { ...noGate, status: "lost" }), true);
});

test("unknown agent errors are recognised in the daemon's wording", () => {
  assert.equal(isUnknownAgent(new Error("Request failed: Unknown agent 'abc'")), true);
  assert.equal(isUnknownAgent(new Error("Request failed: Plugin timeline item data exceeds 65536 bytes")), false);
});

// ---- the feed ---------------------------------------------------------------------------

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-21T08:00:00.000Z");

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** A run file written event by event, with a clock the test moves. */
function harness({
  caller = CALLER as string | null,
  hostname = HOST,
  alive = true,
  failWith = null as (() => Error | null) | null,
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-cards-"));
  dirs.push(dir);
  let clock = T0;
  let seq = 0;
  const runId = "11111111-2222-4333-8444-555555555555";
  const file = path.join(dir, `${runId}.jsonl`);
  const appended: Array<{ agentId: string; item: CardItem }> = [];
  const probe: Probe = {
    hostname: HOST,
    kill: () => {
      if (alive) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
  };
  const feed = createCardFeed({
    append: async (agentId, item) => {
      const error = failWith?.();
      if (error) throw error;
      appended.push({ agentId, item });
    },
    where: async () => ({ runsDir: dir, staleMs: BASE }),
    now: () => clock,
    probe,
  });
  const emit = (kind: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ v: 1, seq: seq++, ts: iso(clock), runId, kind, ...fields });
    appendFileSync(file, `${line}\n`);
  };
  const start = () =>
    emit("run.start", {
      flow: { name: "demo", description: "", phases: [{ id: "a", title: "甲" }, { id: "b", title: "乙" }], inputs: {}, grants: [] },
      source: null,
      input: { ticket: "42" },
      caller,
      cwd: "/work",
      host: null,
      pid: 1234,
      hostname,
    });
  return {
    dir,
    file,
    runId,
    feed,
    appended,
    emit,
    start,
    advance(ms: number) {
      clock += ms;
    },
    setAlive(value: boolean) {
      alive = value;
    },
    last(): RunCard {
      return appended.at(-1)!.item.data;
    },
  };
}

test("feed: a run started by a local agent gets one card, replaced in place as it moves", async () => {
  const h = harness();
  h.start();
  await h.feed.scan();
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0]!.agentId, CALLER);
  assert.equal(h.appended[0]!.item.id, cardItemId(h.runId));
  assert.equal(h.appended[0]!.item.kind, "run-card");

  // Nothing new: looking again appends nothing.
  h.advance(5_000);
  await h.feed.recheck();
  assert.equal(h.appended.length, 1);

  // A change inside the spacing waits for the next look.
  h.emit("phase.start", { phase: "a" });
  await h.feed.touched([h.runId]);
  assert.equal(h.appended.length, 2, "spacing counts from the last append, 5s ago");
  h.emit("call.start", { callId: "c1", type: "do", name: "prep", title: "准备", phase: "a" });
  h.advance(500);
  await h.feed.touched([h.runId]);
  assert.equal(h.appended.length, 2, "within the spacing and not urgent");
  h.advance(SPACING_MS);
  await h.feed.recheck();
  assert.equal(h.appended.length, 3);
  assert.match(h.last().title, /准备/);
  assert.ok(h.appended.every((entry) => entry.item.id === cardItemId(h.runId)));
});

test("feed: a gate opening is appended at once, and the end settles the run", async () => {
  const h = harness();
  h.start();
  h.emit("phase.start", { phase: "a" });
  await h.feed.scan();
  const before = h.appended.length;
  h.advance(100);
  h.emit("call.start", { callId: "g1", type: "gate", name: "gate", title: "批准上线", phase: "a", timeout: "2h" });
  await h.feed.touched([h.runId]);
  assert.equal(h.appended.length, before + 1, "urgent: no spacing");
  assert.equal(h.last().gate?.title, "批准上线");
  assert.equal(h.last().tone, "warning");

  h.advance(100);
  h.emit("call.end", { callId: "g1", ok: true, durationMs: 200, output: { approved: true, outcome: "allowed" }, error: null, agentId: "carrier", cost: null });
  h.emit("phase.end", { phase: "a", ok: true });
  h.emit("run.end", { outcome: "done", value: null, stop: null, error: null, durationMs: 400, cost: { totalUsd: 0.01, agentCount: 1, partial: null }, caveats: [], summary: "上线了" });
  await h.feed.touched([h.runId]);
  assert.equal(h.last().status, "done");
  assert.equal(h.last().title, "上线了");
  assert.deepEqual(h.feed.following(), []);
  const count = h.appended.length;
  h.advance(60_000);
  await h.feed.recheck();
  await h.feed.touched([h.runId]);
  assert.equal(h.appended.length, count, "a settled run is left alone");
});

test("feed: no card without a caller, or for a run written on another machine", async () => {
  for (const options of [{ caller: null }, { hostname: "other-host" }]) {
    const h = harness(options);
    h.start();
    await h.feed.scan();
    assert.equal(h.appended.length, 0);
    assert.deepEqual(h.feed.following(), []);
  }
});

test("feed: a caller the daemon does not know is tried again later, not on every look", async () => {
  let unknown = true;
  let tries = 0;
  const h = harness({
    failWith: () => {
      tries += 1;
      return unknown ? new Error("Request failed: Unknown agent 'caller-agent-1'") : null;
    },
  });
  h.start();
  await h.feed.scan();
  assert.equal(tries, 1);
  h.advance(5_000);
  await h.feed.recheck();
  assert.equal(tries, 1, "waits RETRY_MS");
  unknown = false;
  h.advance(RETRY_MS);
  await h.feed.recheck();
  assert.equal(tries, 2);
  assert.equal(h.appended.length, 1);
});

test("feed: a process found gone ends the run as lost, appended once", async () => {
  const h = harness();
  h.start();
  h.emit("phase.start", { phase: "a" });
  await h.feed.scan();
  h.setAlive(false);
  h.advance(5_000);
  await h.feed.recheck();
  assert.equal(h.last().status, "lost");
  assert.equal(h.last().lost?.procGone, true);
  assert.deepEqual(h.feed.following(), []);
});

test("feed: after a restart, runs that ended a while ago get no card; recent ones do", async () => {
  const end = (h: ReturnType<typeof harness>) => {
    h.start();
    h.emit("run.end", { outcome: "done", value: null, stop: null, error: null, durationMs: 10, cost: null, caveats: [] });
  };
  const old = harness();
  end(old);
  old.advance(RECENT_END_MS + 60_000);
  await old.feed.scan();
  assert.equal(old.appended.length, 0);

  const recent = harness();
  end(recent);
  recent.advance(RECENT_END_MS / 2);
  await recent.feed.scan();
  assert.equal(recent.appended.length, 1);
  assert.equal(recent.last().status, "done");
});

test("feed: after a restart, a run that died long ago without run.end gets no card", async () => {
  const h = harness({ alive: false });
  h.start();
  h.emit("phase.start", { phase: "a" });
  h.advance(RECENT_END_MS * 2);
  await h.feed.scan();
  assert.equal(h.appended.length, 0);
  assert.deepEqual(h.feed.following(), []);
});

test("feed: files untouched for a day are not looked at", async () => {
  const h = harness();
  h.start();
  const day = (T0 - 25 * 60 * 60_000) / 1000;
  utimesSync(h.file, day, day);
  await h.feed.scan();
  assert.equal(h.appended.length, 0);
});

test("readCard folds a run straight from its file", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orch-cards-"));
  dirs.push(dir);
  const text = readFileSync(path.join(FIXTURES, "committee-done.jsonl"), "utf8");
  writeFileSync(path.join(dir, "x.jsonl"), text);
  const card = await readCard(dir, "x", BASE, { probe: { hostname: HOST, kill: () => true } });
  assert.equal(card?.status, "done");
  await assert.rejects(readCard(dir, "missing", BASE), /ENOENT/);
});

test("feed: an agent that never comes back is tried less and less often", async () => {
  let tries = 0;
  const h = harness({
    failWith: () => {
      tries += 1;
      return new Error("Request failed: Unknown agent 'caller-agent-1'");
    },
  });
  h.start();
  await h.feed.scan();
  const at: number[] = [];
  for (let minute = 0; minute < 60; minute += 0.5) {
    h.advance(30_000);
    const before = tries;
    await h.feed.recheck();
    if (tries > before) at.push(minute + 0.5);
  }
  // 30s, 1m, 2m, 4m, 8m, then every 10m: about a dozen tries in the first hour, not 120.
  assert.ok(tries <= 12, `tried ${tries} times`);
  const gaps = at.slice(1).map((value, index) => value - at[index]!);
  assert.ok(gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1]!), `gaps ${gaps}`);
  assert.ok(Math.max(...gaps) <= MAX_RETRY_MS / 60_000);
});

test("card: a run of script steps only shows no cost while it runs", () => {
  const run = foldEvents(fixture("hotfix-stopped.jsonl").slice(0, 3));
  assert.equal(cardOf("r7", run, "running", Date.now())!.costUsd, null);
});
