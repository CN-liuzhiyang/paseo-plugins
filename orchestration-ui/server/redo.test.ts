import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CARD_SENTENCE_MAX, cardSentence, ROW_SENTENCE_MAX, rowSentence } from "../shared/bar";
import { cardOf } from "../shared/card";
import { callMarks, fixingOf, pathLabel, returnedFor, REUSED, stopLine } from "../shared/fixes";
import { buildGraph, hero, stageWaves, graphVisits } from "../shared/graph";
import { foldEvents, runStatus } from "../shared/run";
import { compactStages, stageRows } from "../shared/stages";
import { stewardRow, wakeLine } from "../shared/wake";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const BASE = 15 * 60_000;

function fixture(name: string): Array<Record<string, any>> {
  return readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

const events = fixture("redo-stopped.jsonl");
const kinds = (list: ReadonlyArray<Record<string, any>>) => list.map((event) => event.kind);
const sentenceLength = (text: string) => [...text].length;

/** The stream up to and including the first event matching `stop`. */
function until(stop: (event: Record<string, any>) => boolean) {
  return events.slice(0, events.findIndex(stop) + 1);
}

test("the new events fold into the run and none of them is an unknown kind or a problem", () => {
  const run = foldEvents(events);
  assert.deepEqual(run.problems, []);
  assert.deepEqual(run.unknownKinds, {});

  const patched = run.calls.get("c3")!;
  assert.equal(patched.end?.rounds, 3);
  assert.deepEqual(
    patched.fixes.map((fix) => [fix.round, fix.problems.length, fix.fixed?.ok]),
    [
      [2, 2, false],
      [3, 1, true],
    ],
  );
  assert.equal(run.calls.get("c4")!.continues?.callId, "c3");
  assert.equal(run.calls.get("c5")!.revises?.callId, "c4");
  assert.equal(run.calls.get("c1")!.type, "step");
  assert.ok(run.calls.get("c1")!.reused && run.calls.get("c2")!.reused);
  assert.equal(run.calls.get("c3")!.reused, null);
  assert.deepEqual([run.wake?.via, run.wake?.ok, run.wake?.to !== null], ["steward", true, true]);
  assert.deepEqual([run.end?.stop?.kind, run.end?.stop?.step], ["unknown", "submit"]);
});

test("a resume declaration is read and left alone, a kind nobody knows is still counted", () => {
  const extra = [{ v: 1, seq: 28, ts: "2026-10-30T09:01:00.000Z", runId: "x", kind: "resume", flow: "demo-flow", input: {}, from: "x", spends: "nothing" }];
  assert.deepEqual(foldEvents([...events, ...extra]).unknownKinds, {});
  assert.deepEqual(foldEvents([...events, { ...extra[0]!, kind: "something-else" }]).unknownKinds, { "something-else": 1 });
});

test("a file from before these events folds as it did: one round, nothing sent back, nobody told", () => {
  const old = foldEvents(fixture("committee-done.jsonl"));
  assert.deepEqual(old.problems, []);
  for (const call of old.calls.values()) {
    assert.deepEqual([call.fixes.length, call.reused, call.continues, call.revises], [0, null, null, null]);
    if (call.end) assert.equal(call.end.rounds, 1);
  }
  assert.equal(old.wake, null);
  assert.equal(old.end?.stop?.kind ?? null, null);
  assert.equal(cardOf("r", old, "done", Date.now())?.fixing ?? null, null);
});

test("a call.fixed with no call.fix before it is a problem, not a crash", () => {
  const run = foldEvents(events.filter((event) => event.kind !== "call.fix").map((event, seq) => ({ ...event, seq })));
  assert.equal(run.problems.length, 2, "one for each call.fixed");
  assert.equal(run.calls.get("c3")!.fixes.length, 0);
});

test("tags: sent back, asked again, redone by someone else; a reused call is not a tag", () => {
  const run = foldEvents(events);
  const labels = (id: string) => callMarks(run.calls.get(id)!).map((mark) => mark.label);
  assert.equal(labels("c3").length, 1);
  assert.match(labels("c3")[0]!, /2/, "two rounds of fixes");
  assert.equal(labels("c4").length, 1);
  assert.equal(labels("c5").length, 1);
  assert.notEqual(labels("c4")[0], labels("c5")[0]);
  assert.deepEqual([labels("c1"), labels("c2")], [[], []]);
  assert.ok(REUSED.length > 0);
});

test("the person reads the place that was wrong as a path, not a JSON pointer", () => {
  assert.equal(pathLabel(""), "整份答案");
  assert.equal(pathLabel("/tag"), "tag");
  const label = pathLabel("/edits/4/old");
  assert.ok(label.includes("edits") && label.includes("old") && label.includes("5"), label);
  assert.ok(!label.includes("/"));
  assert.equal(pathLabel("/a~1b/~0c"), "a/b › ~c");
});

test("what came back is matched to the problem it answers", () => {
  const fixes = foldEvents(events).calls.get("c3")!.fixes;
  assert.deepEqual(returnedFor(fixes[0]!, 0), { value: "if (!session) {\n  redirect(login);" });
  assert.deepEqual(returnedFor(fixes[0]!, 1), { value: "return next();" });
  assert.equal(returnedFor(fixes[0]!, 2), undefined);
  assert.deepEqual(returnedFor(fixes[1]!, 0), { value: "return next();\n" });
  // A round on the whole answer comes back as the answer; one that is still out has nothing.
  const whole = { round: 2, at: "", problems: [{ at: "", say: "x" }], prompt: null, schema: null, fixed: { at: "", answer: { a: 1 }, ok: true, cost: null, durationMs: null } };
  assert.deepEqual(returnedFor(whole, 0), { value: { a: 1 } });
  assert.equal(returnedFor({ ...whole, fixed: null }, 0), undefined);
});

test("while an answer is being sent back the card and the bar row say which step, how many places, which round", () => {
  const live = until((event) => event.kind === "call.fix" && event.round === 2);
  const run = foldEvents(live);
  const now = Date.parse(run.lastEventAt!) + 1_000;
  const status = runStatus(run, now, BASE);
  assert.equal(status, "running");
  assert.deepEqual(fixingOf(run.calls.get("c3")!), { round: 2, count: 2 });

  const card = cardOf("fixrun-0002", run, status, now)!;
  assert.deepEqual(card.fixing, { title: "出补丁", round: 2, count: 2 });
  for (const [sentence, max] of [
    [cardSentence(card, now), CARD_SENTENCE_MAX],
    [rowSentence(card, now), ROW_SENTENCE_MAX],
  ] as const) {
    assert.ok(sentenceLength(sentence) <= max, `${sentence} fits ${max}`);
    assert.ok(sentence.includes("出补丁"), sentence);
    assert.ok(sentence.includes("2"), "the count and the round are in it");
  }
  // A step with a long name is cut, the part about the fix is not.
  const longName = { ...card, fixing: { ...card.fixing!, title: "一个名字很长很长很长很长很长的步骤" } };
  const row = rowSentence(longName, now);
  assert.ok(sentenceLength(row) <= ROW_SENTENCE_MAX && row.endsWith("）"), row);
  assert.equal(hero(run, status, now).title.includes("2"), true);
});

test("between a round handed back and the next one sent, the call is open but nothing is being sent back", () => {
  const run = foldEvents(until((event) => event.kind === "call.fixed" && event.round === 2));
  assert.equal(run.calls.get("c3")!.end, null);
  assert.equal(fixingOf(run.calls.get("c3")!), null);
  const now = Date.parse(run.lastEventAt!) + 1_000;
  assert.equal(cardOf("fixrun-0002", run, runStatus(run, now, BASE), now)!.fixing, null);
});

test("once the fixed answer is in, nothing about it is on the card", () => {
  const settled = until((event) => event.kind === "call.end" && event.callId === "c3");
  const run = foldEvents(settled);
  const now = Date.parse(run.lastEventAt!) + 1_000;
  const card = cardOf("fixrun-0002", run, runStatus(run, now, BASE), now)!;
  assert.equal(card.fixing, null);
  assert.ok(!cardSentence(card, now).includes("轮"), cardSentence(card, now));
  // Finished: the same.
  const done = foldEvents([...settled, { v: 1, seq: 99, ts: run.lastEventAt, runId: "x", kind: "run.end", outcome: "done", value: null, summary: null, stop: null, error: null, durationMs: 1, cost: null, caveats: [] }]);
  const finished = cardOf("fixrun-0002", done, "done", now)!;
  assert.ok(!cardSentence(finished, now).includes("轮"));
});

test("stopping on a check that never passed names the step and the rounds; the flow's own stop is untouched", () => {
  const start = events[0]!;
  const stream = (stop: Record<string, unknown> | null, rounds = 3) => [
    start,
    { v: 1, seq: 1, ts: "2026-10-30T09:00:01.000Z", runId: "r", kind: "call.start", callId: "c1", type: "ask", name: "patch", title: "出补丁", phase: null, provider: "claude/claude-sonnet-5-5" },
    { v: 1, seq: 2, ts: "2026-10-30T09:00:02.000Z", runId: "r", kind: "call.end", callId: "c1", ok: false, durationMs: 1, output: {}, error: { name: "CheckFailed", message: "x" }, agentId: null, cost: null, rounds },
    { v: 1, seq: 3, ts: "2026-10-30T09:00:03.000Z", runId: "r", kind: "run.end", outcome: "stopped", value: null, summary: null, stop, error: null, durationMs: 3, cost: null, caveats: [] },
  ];
  const check = foldEvents(stream({ reason: "patch：核对 3 轮还不过：tag 格式不对", phase: null, kind: "check", step: "patch" }));
  assert.ok(stopLine(check)!.includes("出补丁") && stopLine(check)!.includes("3"), stopLine(check)!);
  const top = hero(check, "stopped", Date.now());
  assert.equal(top.title, stopLine(check));
  assert.equal(top.needsYou, false);
  assert.equal(top.tone, "warning");
  assert.ok(!top.title.includes("$.stop") && !(top.subtitle ?? "").includes("$.stop"));

  // A file from before `kind` was written, and a stop the flow asked for, keep the old words.
  for (const stop of [{ reason: "patch：核对 3 轮还不过", phase: null }, { reason: "不想继续了", phase: null, kind: "flow", step: null }]) {
    const run = foldEvents(stream(stop));
    assert.equal(stopLine(run), null);
    assert.ok(hero(run, "stopped", Date.now()).subtitle?.includes("$.stop"));
  }
});

test("a step that may or may not have happened is red, asks the person, and is a row of its own in the bar", () => {
  const run = foldEvents(events);
  const top = hero(run, "stopped", Date.now());
  assert.ok(top.title.includes("提交到主干"), "the title the runtime's sentence opened with, not the step's name");
  assert.deepEqual([top.tone, top.needsYou], ["danger", true]);
  const end = buildGraph(run, "stopped", Date.now()).pieces.at(-1)!;
  assert.ok(end.kind === "end" && end.tone === "danger");

  const rows = stageRows(run, "stopped");
  assert.deepEqual(
    rows.map((row) => row.key).filter((key) => key.startsWith("@stop")).length,
    1,
  );
  const last = rows.at(-1)!;
  assert.equal(last.state, "failed");
  assert.ok(last.title.includes("提交到主干") && last.note !== null);
  // A name only (no title in the sentence) falls back to the name.
  const bare = foldEvents(events.map((event) => (event.kind === "run.end" ? { ...event, stop: { ...event.stop, reason: "x" } } : event)));
  assert.ok(stopLine(bare)!.includes("submit"));
});

test("the bar's rows: what became of a stage's answers, one conversation per agent", () => {
  const run = foldEvents(events);
  const rows = compactStages(stageRows(run, "stopped"));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const draft = byKey.get("draft")!;
  assert.equal(draft.note, REUSED, "every call of the stage was taken from the run before");
  const check = byKey.get("check")!;
  assert.match(check.note ?? "", /2/, "the answer was sent back twice");
  // c3 and c4 are one agent's conversation; c5 is another agent.
  assert.deepEqual(
    check.talks.map((talk) => talk.agentId),
    ["bbbbbbbb-1111-4222-8333-444444444402", "cccccccc-1111-4222-8333-444444444403"],
  );
  // While it is being sent back the note says so, and not otherwise.
  const live = foldEvents(until((event) => event.kind === "call.fix" && event.round === 2));
  const liveCheck = stageRows(live, "running").find((row) => row.key === "check")!;
  assert.ok(liveCheck.note?.includes("2"));
  assert.ok(!stageRows(live, "stopped").find((row) => row.key === "check")!.note?.includes("在改"));
});

test("a step that holds calls goes ahead of them, not beside them", () => {
  const at = (second: number) => `2026-10-30T10:00:${String(second).padStart(2, "0")}.000Z`;
  const line = (seq: number, second: number, kind: string, body: Record<string, unknown>) => ({ v: 1, seq, ts: at(second), runId: "r", kind, ...body });
  const run = foldEvents([
    events[0],
    line(1, 1, "call.start", { callId: "c1", type: "step", name: "build", title: "构建", phase: null, once: false, key: "k", reused: null }),
    line(2, 2, "call.start", { callId: "c2", type: "do", name: "compile", title: "编译", phase: null }),
    line(3, 3, "call.end", { callId: "c2", ok: true, durationMs: 1000, output: null, error: null, agentId: null, cost: null }),
    line(4, 4, "call.end", { callId: "c1", ok: true, durationMs: 3000, output: null, error: null, agentId: null, cost: null }),
  ]);
  assert.deepEqual(run.problems, []);
  const visit = graphVisits(run)[0]!;
  const lanes = stageWaves(visit, Date.parse(at(5))).map((wave) => wave.calls.map((call) => call.callId));
  assert.deepEqual(lanes, [["c1"], ["c2"]]);
});

test("who was told: the session in charge, the conversation that started it, or nobody", () => {
  const wake = foldEvents(events).wake!;
  assert.ok(wakeLine(wake).includes("负责会话"));
  assert.deepEqual(stewardRow(wake), { agentId: wake.to, text: stewardRow(wake)!.text });
  assert.ok(!stewardRow({ ...wake, ok: false })!.text.includes("已告知"));

  const nobody = { ...wake, to: null, via: null, ok: null };
  assert.ok(wakeLine(nobody).includes("没人"));
  assert.equal(stewardRow(nobody), null);

  const caller = { ...wake, via: "caller" as const };
  assert.ok(wakeLine(caller).includes("发起"));
  assert.equal(stewardRow(caller), null, "the bar only has a row for the session in charge");
  assert.notEqual(wakeLine({ ...caller, ok: false }), wakeLine(caller), "a message that did not get there says so");
  assert.equal(stewardRow(null), null);
});

test("every kind in the fixture is one the run view reads", () => {
  assert.deepEqual(
    [...new Set(kinds(events))].sort(),
    ["call.agent", "call.end", "call.fix", "call.fixed", "call.start", "caveat", "phase.end", "phase.start", "run.end", "run.start", "wake"],
  );
});
