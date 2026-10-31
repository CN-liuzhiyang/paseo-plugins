import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  BAR_ORDER,
  CARD_SENTENCE_MAX,
  DONE_WINDOW_MS,
  ROW_SENTENCE_MAX,
  STOPPED_WINDOW_MS,
  barAffair,
  barGroups,
  barRows,
  cardButton,
  cardSentence,
  stateWord,
  groupOf,
  NAME_LABEL_MAX,
  nameOf,
  inWorkspace,
  rowAction,
  rowSentence,
  supersededRuns,
  type BarGroup,
} from "../shared/bar";
import { cardOf, type RunCard } from "../shared/card";
import type { RunSummary } from "../shared/rpc";
import { foldEvents, runStatus } from "../shared/run";
import { compactStages, stageRows, type StageRow } from "../shared/stages";
import { summarize } from "./runs";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const BASE = 15 * 60_000;
const T = Date.parse("2026-09-24T06:04:00.000Z");
const DAY = 24 * 60 * 60_000;

function fixture(name: string, shiftMs = 0): Array<Record<string, unknown>> {
  const text = readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      return shiftMs === 0 ? event : { ...event, ts: new Date(Date.parse(event.ts as string) + shiftMs).toISOString() };
    });
}

/** The list's row for a fixture run, as the daemon would work it out at `now`. */
function summary(name: string, { now = T, shiftMs = 0, runId = name, edit = (events: Array<Record<string, unknown>>) => events } = {}): RunSummary {
  const events = edit(fixture(name, shiftMs)).map((event) => ({ ...event, runId }));
  return summarize(runId, foldEvents(events), 1, now, BASE);
}

const withStart = (fields: Record<string, unknown>) => (events: Array<Record<string, unknown>>) => [{ ...events[0]!, ...fields }, ...events.slice(1)];

const LINK = { plugin: "tracker", screen: "item", params: { item: "1234" } };

function everyCard(): Array<{ name: string; now: number; card: RunCard }> {
  const names = ["advisor-failed", "committee-done", "docfix-waiting", "hotfix-stopped", "survey-unfinished"];
  const nows = [T, T + 60 * 60_000, T + 3 * DAY];
  return names.flatMap((name) =>
    nows.map((now) => {
      const events = fixture(name);
      const run = foldEvents(events);
      // Each fixture's own clock, so a live one reads as live at the first look and as lost later.
      const at = Date.parse(events.at(-1)!.ts as string) + (now - T);
      return { name, now: at, card: cardOf(name, run, runStatus(run, at, BASE), at) as RunCard };
    }),
  );
}

test("groups: what needs you, then what runs, then what stopped; the finished last, and an empty group is not there", () => {
  const rows = barRows(
    [
      summary("committee-done"),
      summary("hotfix-stopped"),
      summary("survey-unfinished", { now: Date.parse("2026-09-24T03:10:33.000Z") }),
      summary("docfix-waiting", { now: Date.parse("2026-09-24T06:03:58.000Z") }),
      summary("advisor-failed"),
    ],
    new Set(),
    T,
  );
  const groups = barGroups(rows);
  assert.deepEqual(
    groups.map((entry) => entry.group),
    ["waiting", "running", "stopped", "done"],
  );
  assert.deepEqual(
    groups.map((entry) => entry.group),
    BAR_ORDER.filter((group) => groups.some((entry) => entry.group === group)),
  );
  assert.equal(groups.find((entry) => entry.group === "stopped")?.rows.length, 2, "a stop and a failure are both 停了");
  assert.deepEqual(
    barGroups(rows.filter((row) => row.group === "done")).map((entry) => entry.group),
    ["done"],
  );
  assert.deepEqual(barGroups([]), []);
  // Newest start first inside a group.
  const stopped = groups.find((entry) => entry.group === "stopped")!.rows.map((row) => row.card.startedAt!);
  assert.deepEqual([...stopped].sort().reverse(), stopped);
});

test("a run that is lost is in the stopped group and says it went wrong", () => {
  const lost = summary("survey-unfinished", { now: T });
  assert.equal(lost.status, "lost");
  assert.equal(groupOf(lost.card!), "stopped");
  assert.match(rowSentence(lost.card!, T), /^出错了/);
  assert.match(cardSentence(lost.card!, T), /^出错了/);
});

test("windows: a finished run for a day, a stopped one for a week, and one something carried on not at all", () => {
  const done = summary("committee-done");
  const stopped = summary("hotfix-stopped");
  const at = (now: number, ...runs: RunSummary[]) => barRows(runs, new Set(), now).map((row) => row.run.runId);
  const doneEnd = Date.parse(done.card!.endedAt!);
  assert.deepEqual(at(doneEnd + DONE_WINDOW_MS - 1_000, done), ["committee-done"]);
  assert.deepEqual(at(doneEnd + DONE_WINDOW_MS + 1_000, done), []);
  const stoppedEnd = Date.parse(stopped.card!.endedAt!);
  assert.deepEqual(at(stoppedEnd + STOPPED_WINDOW_MS - 1_000, stopped), ["hotfix-stopped"]);
  assert.deepEqual(at(stoppedEnd + STOPPED_WINDOW_MS + 1_000, stopped), []);
  // A live run has no age.
  const live = summary("docfix-waiting", { now: Date.parse("2026-09-24T06:03:58.000Z") });
  assert.deepEqual(at(T + 365 * DAY, live), ["docfix-waiting"]);

  const carried = summary("committee-done", { runId: "second", edit: withStart({ resumeOf: "hotfix-stopped" }) });
  assert.equal(carried.resumeOf, "hotfix-stopped");
  assert.deepEqual([...supersededRuns([stopped, carried])], ["hotfix-stopped"]);
  assert.deepEqual(
    barRows([stopped, carried], supersededRuns([stopped, carried]), T).map((row) => row.run.runId),
    ["second"],
  );
});

test("which runs are a workspace's: the runtime put agents there, or the agent that started them lives there", () => {
  const named = summary("committee-done", {
    edit: (events) => [events[0]!, { v: 1, seq: 1, ts: events[1]!.ts, runId: "x", kind: "workspace", workspaceId: "w-1", cwd: "/tmp/demo", title: "t", key: "key:k", created: true }, ...events.slice(1)],
  });
  assert.deepEqual(named.workspaceIds, ["w-1"]);
  // The workspace event sits second, so the sequence numbers after it are off by one; that is a problem with the run, not with the list.
  assert.equal(inWorkspace(named, "w-1", new Set()), true);
  assert.equal(inWorkspace(named, "w-2", new Set()), false);
  const caller = named.caller!;
  assert.equal(inWorkspace({ workspaceIds: [], caller }, "w-2", new Set([caller])), true);
  assert.equal(inWorkspace({ workspaceIds: [], caller }, "w-2", new Set(["someone-else"])), false);
  assert.equal(inWorkspace({ workspaceIds: [], caller: null }, "w-2", new Set([caller])), false, "a run started in a terminal has no caller to be inside anything");
});

test("one workspace event per workspace, and one without an id is a problem, not a crash", () => {
  const event = (workspaceId: unknown) => ({ v: 1, seq: 0, ts: "2026-09-24T02:00:00.000Z", runId: "r", kind: "workspace", workspaceId, cwd: "/tmp/a" });
  const run = foldEvents([event("w-1"), event("w-1"), event("w-2"), event(null)]);
  assert.deepEqual(
    run.workspaces.map((workspace) => workspace.workspaceId),
    ["w-1", "w-2"],
  );
  assert.ok(run.problems.some((text) => text.includes("workspaceId")));
});

test("buttons: the card and the row each have at most one, and only a gate or a stop is worth one", () => {
  const waiting = summary("docfix-waiting", { now: Date.parse("2026-09-24T06:03:58.000Z") }).card!;
  assert.equal(groupOf(waiting), "waiting");
  assert.deepEqual(rowAction(waiting, false), { kind: "approve", agentId: "dd44ee55-ff66-4a77-8b88-cc9900112204" });
  assert.equal(cardButton(waiting)?.select, waiting.gate!.callId);
  assert.equal(rowAction({ ...waiting, gate: { ...waiting.gate!, carrierAgentId: null } }, true), null, "a gate nobody carries cannot be opened");

  const stopped = summary("hotfix-stopped").card!;
  assert.equal(groupOf(stopped), "stopped");
  assert.deepEqual(rowAction(stopped, true), { kind: "affair" });
  assert.equal(rowAction(stopped, false), null, "no page to go to, no button");

  const running = summary("survey-unfinished", { now: Date.parse("2026-09-24T03:10:33.000Z") }).card!;
  assert.equal(groupOf(running), "running");
  const done = summary("committee-done").card!;
  assert.equal(groupOf(done), "done");
  for (const card of [running, done]) assert.equal(rowAction(card, true), null);
  assert.equal(cardButton(running)?.select, running.focus);
  assert.equal(cardButton(done), null, "a finished run has nothing to do; its line still opens it");
  // Where there is a button on the card the labels tell the groups apart.
  const labels = new Map<BarGroup, string>([waiting, stopped, running].map((card) => [groupOf(card), cardButton(card)!.label]));
  assert.equal(new Set(labels.values()).size, 3);
});

test("one line: the sentence after the flow's name stays inside its budget, whatever the run is and however long ago", () => {
  for (const { name, now, card } of everyCard()) {
    for (const text of [cardSentence(card, now), rowSentence(card, now)]) {
      assert.ok(text.length > 0, `${name}: a line says something`);
      assert.ok(!/[\r\n]/.test(text), `${name}: it is one line`);
      assert.ok(!/\$\.stop|\bpid\b|runDir/.test(text), `${name}: no developer words in it: ${text}`);
    }
    assert.ok([...cardSentence(card, now)].length <= CARD_SENTENCE_MAX, `${name}: ${cardSentence(card, now)}`);
    assert.ok([...rowSentence(card, now)].length <= ROW_SENTENCE_MAX, `${name}: ${rowSentence(card, now)}`);
  }
});

test("one line: a flow's name carries the input that tells its runs apart, but only so much of it", () => {
  const card = summary("committee-done").card!;
  assert.ok(card.label !== null && [...card.label].length > NAME_LABEL_MAX, "the fixture's input is a long question");
  assert.ok([...nameOf(card)].length <= card.flow!.length + 1 + NAME_LABEL_MAX);
  assert.ok(nameOf(card).startsWith(`${card.flow} `));
  assert.equal(nameOf({ flow: null, label: null }), "流程");
  assert.equal(nameOf({ flow: "demo-flow", label: "#1234" }), "demo-flow #1234");
});

test("one line: a long reason, a long gate title and a lost run with agents still open are cut, not wrapped", () => {
  const base = summary("committee-done").card!;
  const long = "很长很长的原因".repeat(30);
  const cases: RunCard[] = [
    { ...base, title: long },
    { ...base, status: "stopped", title: long },
    { ...base, status: "failed", title: long },
    { ...base, status: "running", endedAt: null, title: long, gate: { callId: "c", title: long, since: new Date(T - 3 * 60 * 60_000).toISOString(), timeout: null, carrierAgentId: "a" } },
    { ...base, status: "lost", title: long, lost: { pid: 1, procGone: true, agents: true } },
    { ...base, status: "lost", title: long, lost: { pid: 1, procGone: false } },
  ];
  for (const card of cases) {
    assert.ok([...cardSentence(card, T)].length <= CARD_SENTENCE_MAX);
    assert.ok([...rowSentence(card, T)].length <= ROW_SENTENCE_MAX);
  }
  // The cost is what a finished run's line must keep.
  assert.match(rowSentence({ ...base, title: long, costUsd: 1.14 }, T), /\$1\.14$/);
  assert.match(cardSentence({ ...base, title: long, costUsd: 1.14 }, T), /\$1\.14$/);
});

test("the stages: one row per declared phase, a gate that waits has the button to approve it, one that was answered says by whom", () => {
  const waitingEvents = fixture("docfix-waiting");
  const waitingRun = foldEvents(waitingEvents);
  const rows = stageRows(waitingRun, "running");
  assert.equal(rows.length, waitingRun.phaseOrder.length);
  const review = rows.find((row) => row.key === "review")!;
  assert.equal(review.state, "waiting");
  assert.equal(review.talks.filter((talk) => talk.waiting).length, 1);
  assert.ok(review.note, "a gate that waits says so");
  // A phase that has not started is a row with nothing to open.
  const ahead = rows.filter((row) => row.state === "pending");
  assert.ok(ahead.every((row) => row.talks.length === 0 && row.note === null));

  const stopped = stageRows(foldEvents(fixture("hotfix-stopped")), "stopped");
  assert.ok(stopped.some((row) => row.state === "stopped"), "the phase the run stopped in is marked");
  const answered = stopped.find((row) => row.note !== null && row.talks.length > 0);
  assert.ok(answered, "a gate that was answered keeps its conversation and what was decided");

  const done = stageRows(foldEvents(fixture("committee-done")), "done");
  assert.ok(done.every((row) => row.state === "done"));
});

test("a flow that declares no phases lists its calls as the steps", () => {
  const run = foldEvents([
    { v: 1, seq: 0, ts: "2026-09-24T02:00:00.000Z", runId: "r", kind: "run.start", flow: { name: "demo-flow", description: "", phases: [], inputs: {}, grants: [] }, input: {} },
    { v: 1, seq: 1, ts: "2026-09-24T02:00:01.000Z", runId: "r", kind: "call.start", callId: "c1", type: "ask", name: "ask", title: "问一句", provider: "claude/x" },
    { v: 1, seq: 2, ts: "2026-09-24T02:00:02.000Z", runId: "r", kind: "call.agent", callId: "c1", agentId: "agent-1" },
  ]);
  const rows = stageRows(run, "running");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "running");
  assert.deepEqual(rows[0]!.talks, [{ callId: "c1", agentId: "agent-1", waiting: false, label: null }]);
});

test("the list carries the card, the workspaces and the page of the affair -- and still not the outside address", () => {
  const affair = { label: "#1234 demo", url: "https://example.invalid/secret-path", link: LINK };
  const linked = summary("committee-done", { edit: withStart({ affair }) });
  assert.deepEqual(linked.affairLink, LINK);
  assert.equal(linked.card?.runId, "committee-done");
  assert.ok(!JSON.stringify(linked).includes("secret-path"));
  const rows = barRows([linked], new Set(), Date.parse(linked.card!.endedAt!) + 1_000);
  assert.deepEqual(barAffair(rows), { label: "#1234 demo", link: LINK });
  assert.equal(barAffair([]), null);
});

test("the stages of an opened run: steps with nothing to open sit on one line, the ones with a conversation or a decision do not", () => {
  const row = (key: string, state: StageRow["state"], extra: Partial<StageRow> = {}): StageRow => ({ key, title: key, state, note: null, talks: [], ...extra });
  const talk = { callId: "x", agentId: "y", waiting: false, label: null };
  const compact = compactStages([
    row("a", "done"),
    row("b", "done"),
    row("c", "done", { talks: [talk] }),
    row("d", "done", { note: "你批了" }),
    row("e", "waiting", { note: "等你批准" }),
    row("f", "pending"),
    row("g", "pending"),
    row("h", "pending"),
  ]);
  assert.deepEqual(
    compact.map((entry) => entry.title),
    ["a、b", "c", "d", "e", "f · g · h"],
  );
  assert.deepEqual(compactStages([]), []);
  // On a real run nothing is lost: every step is still in a row, in order.
  const rows = stageRows(foldEvents(fixture("hotfix-stopped")), "stopped");
  const joined = compactStages(rows);
  assert.ok(joined.length < rows.length);
  assert.deepEqual(
    joined.flatMap((entry) => entry.title.split(/、| · /)),
    rows.map((entry) => entry.title),
  );
});

test("the word for where a run is: an error is not a stop", () => {
  const base = summary("committee-done").card!;
  assert.equal(stateWord({ ...base, status: "stopped" }), "停了");
  for (const status of ["failed", "timeout", "lost"] as const) assert.equal(stateWord({ ...base, status }), "出错了");
  assert.equal(stateWord(base), "完成");
  assert.equal(stateWord(summary("docfix-waiting", { now: Date.parse("2026-09-24T06:03:58.000Z") }).card!), "等你");
});
