import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { approvedHere, numbersLine, REUSED_LEAD, reusedLead, replayedStage, spendOf } from "../shared/detail";
import { callMarks, fixRounds } from "../shared/fixes";
import { buildGraph, hero } from "../shared/graph";
import { costSoFar, foldEvents, runStatus } from "../shared/run";
import { cardOf } from "../shared/card";
import { compactStages, stageRows } from "../shared/stages";
import { pageRuns, flowStanding } from "../shared/page";
import type { RunSummary } from "../shared/rpc";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const load = (name: string) =>
  readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    // A file that stops mid-write (survey-unfinished) ends in half a line.
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

const resumed = foldEvents(load("resume-auto-stopped.jsonl"));
const NOW = Date.parse("2026-11-09T10:05:00.000Z");
const status = runStatus(resumed, NOW, 15 * 60_000);

test("a run that carries on an earlier one: the front stages that only replayed fold into one line", () => {
  assert.deepEqual(resumed.problems, []);
  const graph = buildGraph(resumed, status, NOW);
  // 读单(a step taken over + a script that ran again), 写方案, 批方案, 出补丁, 批补丁: five stages, five steps.
  assert.deepEqual(reusedLead(graph), { pieces: 5, steps: 5 });
  assert.equal(REUSED_LEAD(5), "前面 5 步沿用上一段");
  // The stage that really ran this time is not in it, and neither is anything after.
  const next = graph.pieces[6]!;
  assert.ok(next.kind === "column" && next.stages[0]!.visit.title === "更新" && !replayedStage(next.stages[0]!));
  // A run that took nothing over has no lead.
  const fresh = foldEvents(load("committee-done.jsonl"));
  assert.equal(reusedLead(buildGraph(fresh, "done", NOW)), null);
});

test("a replay is not a second go: no rounds, no approval, no cost, no 'not counted' for what it took over", () => {
  const plan = resumed.calls.get("c3")!;
  assert.equal(plan.end?.rounds, 3, "the file still says how many rounds it took the first time");
  assert.equal(fixRounds(plan), 0);
  assert.deepEqual(callMarks(plan), []);
  assert.equal(approvedHere(resumed), 0, "two gates, both taken over: nobody was asked this time");
  assert.equal(costSoFar(resumed).uncounted, 0);
  assert.equal(spendOf(resumed, 0), null, "nothing was asked this time, so there is no figure, not $0");
  const rows = compactStages(stageRows(resumed, "stopped"));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  assert.equal(byKey.get("plan-ok")!.note, "沿用上一段", "a gate taken over does not say 你批了");
  assert.equal(byKey.get("plan")!.note, "沿用上一段", "and a taken answer does not say 改过 2 轮");
});

test("the card and the top sentence of a run that carried on are about what happened this time", () => {
  const card = cardOf("devrun-0002", resumed, status, NOW)!;
  assert.equal(card.costUsd, 0);
  const top = hero(resumed, status, NOW);
  assert.equal(top.kicker, "停了");
  assert.equal(top.title, "停在更新前：NtUniSdkBase.dll 本地和上游都改了，要你定留哪个");
  assert.equal(top.subtitle, null);
  assert.ok(![top.title, top.subtitle ?? "", top.kicker].join("").match(/\$\.stop|PRODUCT_PATTERNS|predict/));
});

test("the numbers line: time, cost, how often you approved; what is not known is left out", () => {
  const clock = Date.parse("2026-11-09T10:05:00.000Z");
  assert.match(numbersLine(resumed, status, clock, 0), /^[0-9]+ 秒$/, "a carried-on run: the time it took, no $0, no approval");
  const waiting = foldEvents(load("docfix-waiting.jsonl"));
  const line = numbersLine(waiting, "running", Date.parse(waiting.lastEventAt!) + 1_000, costSoFar(waiting).usd);
  assert.match(line, /^已跑 .+ · \$\d/);
  const done = foldEvents(load("committee-done.jsonl"));
  assert.match(numbersLine(done, "done", NOW, 0), /^\d+ 分 \d+ 秒 · \$\d/);
  assert.ok(!numbersLine(done, "done", NOW, 0).includes("agent"));
});

const summary = (runId: string, over: Partial<RunSummary>, status: "done" | "stopped" | "running" | "failed" = "done"): RunSummary => {
  const startedAt = over.startedAt ?? "2026-11-09T09:00:00.000Z";
  return {
    runId, flowName: "demo", description: null, startedAt, lastEventAt: startedAt, status, durationMs: null, costUsd: null, costNote: null, caller: null, host: null,
    affairLabel: null, affairLink: null, workspaceIds: [], resumeOf: null,
    card: { runId, flow: "demo", label: null, status, tone: "neutral", kicker: "", title: "x", startedAt, endedAt: status === "running" ? null : startedAt, durationMs: null, lastEventAt: startedAt,
      costUsd: null, costNote: null, strip: null, gate: null, lost: null, focus: "@end", remote: false, evaluatedAt: startedAt },
    activity: null, stop: null, error: null, problem: null, process: null, sizeBytes: 1, inputLabel: null, hero: null, needsYou: false, strip: null, ...over,
  };
};

test("the 流程 page: the bar's four groups; old, carried-on and unreadable runs are folded under 更早的", () => {
  const day = 24 * 60 * 60_000;
  const at = (ago: number) => new Date(NOW - ago).toISOString();
  const gated = summary("gated", { startedAt: at(60_000) }, "running");
  gated.card!.gate = { callId: "g", title: "批方案", since: at(60_000), timeout: null, carrierAgentId: null };
  const runs = [
    summary("done-new", { startedAt: at(2 * 60 * 60_000) }),
    summary("done-old", { startedAt: at(5 * day) }),
    summary("live", { startedAt: at(10 * 60_000) }, "running"),
    gated,
    summary("stopped", { startedAt: at(2 * day) }, "stopped"),
    summary("stopped-then-carried", { startedAt: at(3 * day) }, "stopped"),
    summary("carrier", { startedAt: at(1 * day), resumeOf: "stopped-then-carried" }, "stopped"),
    summary("bad", { card: null, status: "unreadable" as never }),
  ];
  const page = pageRuns(runs, NOW);
  assert.deepEqual(page.groups.map((g) => [g.title, g.runs.map((r) => r.runId)]), [
    ["等你", ["gated"]],
    ["在跑", ["live"]],
    ["停了", ["carrier", "stopped"]],
    ["完成", ["done-new"]],
  ]);
  assert.deepEqual(page.older.map((r) => r.runId).sort(), ["bad", "done-old", "stopped-then-carried"]);
  assert.equal(flowStanding("停了", "10-30", 7), "停了 · 10-30 · 7 次");
  assert.equal(flowStanding("还没跑过", null, 0), "还没跑过");
});

test("a time in a list has no seconds; today is just the clock", async () => {
  const { whenOf } = await import("../shared/page");
  const now = new Date(2026, 10, 9, 15, 0, 0).getTime();
  assert.equal(whenOf(new Date(2026, 10, 9, 9, 12, 33).toISOString(), now), "09:12");
  assert.equal(whenOf(new Date(2026, 9, 30, 9, 12, 33).toISOString(), now), "10-30 09:12");
  assert.equal(whenOf(null, now), null);
});

test("the top of a run page never speaks the runtime's language: no $.stop, no pid, no runDir, whatever state it is in", () => {
  const files = ["advisor-failed", "committee-done", "docfix-waiting", "hotfix-stopped", "redo-stopped", "resume-auto-stopped", "survey-unfinished"];
  const talk = /\$\.stop|\bpid\b|runDir|\bflow\b|人闸|占位文件|主动停下/;
  for (const file of files) {
    const run = foldEvents(load(`${file}.jsonl`));
    const last = Date.parse(run.lastEventAt!);
    // Live shortly after the last event, and long after it: the second one is a run gone quiet.
    for (const [now, proc] of [
      [last + 1_000, { pid: 4242, alive: true }],
      [last + 3 * 60 * 60_000, { pid: 4242, alive: false, gone: true }],
    ] as const) {
      const status = runStatus(run, now, 15 * 60_000, proc);
      const top = hero(run, status, now, { proc, staleMs: 15 * 60_000 });
      const said = [top.kicker, top.title, top.subtitle ?? "", top.action?.label ?? ""].join("\n");
      // What a flow wrote itself (its summary, its stop reason) is its own; everything else is ours.
      const flowOwn = [run.end?.summary, run.end?.stop?.reason].filter(Boolean) as string[];
      const ours = flowOwn.reduce((text, own) => text.replace(own, ""), said);
      assert.ok(!talk.test(ours.replace(/hotfix|人闸没有批准[^\n]*/g, "")), `${file} (${status}): ${ours}`);
    }
  }
});
