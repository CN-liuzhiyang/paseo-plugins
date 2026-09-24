import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  buildGraph,
  callTitle,
  END,
  headline,
  hero,
  inputLabel,
  phaseStrip,
  runClock,
  START,
  type Graph,
  type Piece,
  type Stage,
} from "../shared/graph";
import { foldEvents, runStatus, type RunState } from "../shared/run";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const BASE = 15 * 60_000;

function fixture(name: string): unknown[] {
  const text = readFileSync(path.join(FIXTURES, name), "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function at(iso: string, plusMs = 0): number {
  return Date.parse(iso) + plusMs;
}

/** The graph in words, left to right: what a reader sees without the styling. */
function shape(graph: Graph): string[] {
  const stage = (s: Stage) =>
    `${s.visit.loose ? "·" : s.visit.title}[${s.waves
      .map((wave) => (wave.kind === "group" ? `${wave.calls.length}do` : wave.calls.map((call) => call.callId).join("|")))
      .join(",")}]`;
  const column = (stages: Stage[]) => (stages.length > 1 ? `(${stages.map(stage).join(" ‖ ")})` : stage(stages[0]!));
  return graph.pieces.map((piece: Piece) => {
    switch (piece.kind) {
      case "input":
        return `in:${piece.label}`;
      case "column":
        return column(piece.stages);
      case "loop":
        return `↻${piece.title}×${piece.rounds.length}{${piece.rounds.map((round) => round.map(column).join(">")).join(" / ")}}`;
      case "ghost":
        return `ghost:${piece.phase.title}:${piece.text}`;
      case "end":
        return `end:${piece.label}`;
    }
  });
}

function nodeIds(graph: Graph): string[] {
  const ids: string[] = [];
  for (const piece of graph.pieces) {
    const stages = piece.kind === "column" ? piece.stages : piece.kind === "loop" ? piece.rounds.flat(2) : [];
    for (const stage of stages) for (const wave of stage.waves) ids.push(...wave.calls.map((call) => call.callId));
  }
  return ids.sort();
}

function allCalls(run: RunState): string[] {
  return [...run.calls.keys()].sort();
}

test("waiting gate: script group, repair loop, a call outside phases, gate beside another ask, a phase not reached", () => {
  const run = foldEvents(fixture("docfix-waiting.jsonl"));
  assert.equal(run.problems.length, 0, run.problems.join("\n"));
  const now = at(run.lastEventAt!, 30_000);
  const alive = { pid: 31337, alive: true };
  const status = runStatus(run, now, BASE, alive);
  assert.equal(status, "running");
  const graph = buildGraph(run, status, now);
  assert.deepEqual(shape(graph), [
    "in:#4711",
    "准备素材[4do]",
    "↻起草 ⇄ 校验×2{起草[c5]>校验[c6] / 起草[c7]>校验[c8]}",
    "·[c9]",
    "(交叉复核[c10] ‖ 人工审批[c11])",
    "ghost:发布:还没到",
    "end:进行中",
  ]);
  assert.deepEqual(nodeIds(graph), allCalls(run));
  assert.deepEqual(graph.groups.get("@gc1")?.map((call) => call.callId), ["c1", "c2", "c3", "c4"]);
  // Every node can be scrolled to.
  for (const id of run.calls.keys()) assert.ok(graph.pieceOf.has(id), id);
  assert.equal(graph.pieceOf.get("c11"), 4);
  assert.equal(graph.pieceOf.get(END), graph.pieces.length - 1);

  const top = hero(run, status, now, { proc: alive });
  assert.equal(top.tone, "warning");
  assert.equal(top.kicker, "需要你处理");
  assert.equal(top.title, "等你审批：批准发布 #4711 的文档修订");
  assert.match(top.subtitle ?? "", /2h 内没人处理/);
  assert.match(top.subtitle ?? "", /同时在跑：「交叉复核修订」/);
  assert.deepEqual(top.action, { label: "在 Paseo 打开审批卡片", agentId: "dd44ee55-ff66-4a77-8b88-cc9900112204" });
  assert.equal(top.select, "c11");
  assert.equal(top.needsYou, true);

  // The step named its headline field; the checks are counted; the gate waits.
  assert.equal(headline(run.calls.get("c5")!, status), "把两处 8080 改成 9090，并补一句防火墙说明");
  assert.equal(headline(run.calls.get("c6")!, status), "1 项不过 · 1 项通过");
  assert.equal(headline(run.calls.get("c8")!, status), "2 项全部通过");
  assert.equal(headline(run.calls.get("c11")!, status), "等你批准");
  assert.equal(headline(run.calls.get("c10")!, status), null);

  assert.deepEqual(
    phaseStrip(run, status).map((segment) => segment.state),
    ["done", "done", "done", "running", "waiting", "pending"],
  );
});

test("committee (an old log): the re-entered debate is a loop of two rounds, each two calls side by side", () => {
  const run = foldEvents(fixture("committee-done.jsonl"));
  const status = runStatus(run, Date.now(), BASE);
  const graph = buildGraph(run, status, Date.now());
  assert.deepEqual(shape(graph), [
    "in:编排运行时的裁决者（assess）该不该默认用比成员便宜的模型？",
    "↻辩论×2{辩论[c1|c2] / 辩论[c3|c4]}",
    "裁决[c5]",
    "end:完成",
  ]);
  assert.deepEqual(nodeIds(graph), allCalls(run));
  // No run.end.summary in this file: the sentence falls back and says where the result is.
  const top = hero(run, status, Date.now());
  assert.equal(top.tone, "success");
  assert.equal(top.title, "完成");
  assert.match(top.kicker, /^完成 · 用时 3 分 29 秒$/);
  assert.equal(top.select, END);
  assert.equal(top.needsYou, false);
  // With the new field it uses the flow's own sentence.
  const withSummary = foldEvents(fixture("committee-done.jsonl").map((event) =>
    (event as { kind: string }).kind === "run.end" ? { ...(event as object), summary: "第 2 轮收敛" } : event,
  ));
  assert.equal(hero(withSummary, "done", Date.now()).title, "第 2 轮收敛");
  assert.equal(hero(withSummary, "done", Date.now()).subtitle, null);
});

test("hotfix (an old log): a lone script outside phases, flat phases, stopped at the gate, the last phase not entered", () => {
  const run = foldEvents(fixture("hotfix-stopped.jsonl"));
  const status = runStatus(run, Date.now(), BASE);
  const graph = buildGraph(run, status, Date.now());
  assert.deepEqual(shape(graph).slice(1), [
    "·[d0]",
    "取工单[d1]",
    "钉版本[d2]",
    "起草修复[a1]",
    "校验[d3]",
    "人工审批[g1]",
    "ghost:写入 QA 目录:没有进入",
    "end:停下",
  ]);
  const approve = graph.pieces[6];
  assert.equal(approve?.kind === "column" ? approve.stages[0]!.state : null, "stopped");
  const top = hero(run, status, Date.now());
  assert.equal(top.tone, "warning");
  assert.equal(top.title, "人闸没有批准：4:3 没验证，先别写");
  assert.match(top.subtitle ?? "", /在「人工审批」主动停下/);
  assert.equal(headline(run.calls.get("g1")!, status), "被拒绝");
  assert.equal(headline(run.calls.get("d3")!, status), "通过");
});

test("advisor (an old log): the failed call is the sentence and the button", () => {
  const run = foldEvents(fixture("advisor-failed.jsonl"));
  const status = runStatus(run, Date.now(), BASE);
  const graph = buildGraph(run, status, Date.now());
  assert.deepEqual(shape(graph).slice(1), ["征询[a1]", "end:失败"]);
  const stage = graph.pieces[1];
  assert.equal(stage?.kind === "column" ? stage.stages[0]!.state : null, "failed");
  const top = hero(run, status, Date.now());
  assert.equal(top.tone, "danger");
  assert.equal(top.title, "「第二意见」没拿到结果：paseo run 等了 10m 仍未返回");
  assert.match(top.subtitle ?? "", /^reviewer · opus-5-5，花了 \$0\.08。/);
  assert.deepEqual(top.action, { label: "打开那个 agent", agentId: "d9c8b7a6-5f4e-4d3c-2b1a-0f9e8d7c6b55" });
  assert.equal(top.select, "a1");
});

test("survey: concurrent phases stack; a lost run's clock stops at its last event", () => {
  const run = foldEvents(fixture("survey-unfinished.jsonl"));
  const last = at(run.lastEventAt!);
  const soon = last + 5_000;
  const running = buildGraph(run, runStatus(run, soon, BASE), soon);
  assert.deepEqual(shape(running).slice(1), ["(查文档[a1] ‖ 查代码[a2])", "ghost:汇总:还没到", "end:进行中"]);
  assert.equal(running.clock, soon);

  const later = last + 3_600_000;
  const gone = { pid: 4242, alive: false };
  const status = runStatus(run, later, BASE, gone);
  assert.equal(status, "lost");
  const lost = buildGraph(run, status, later);
  assert.equal(lost.clock, last);
  assert.equal(runClock(run, status, later), last);
  assert.deepEqual(shape(lost).slice(-2), ["ghost:汇总:没有进入", "end:失联"]);
  // The open box and call measure to the last event, not to an hour later.
  const column = lost.pieces[1];
  const code = column?.kind === "column" ? column.stages.find((stage) => stage.visit.phase === "collect-code") : undefined;
  assert.equal(code?.state, "interrupted");
  assert.equal(code?.durationMs, last - at(run.visits.find((visit) => visit.phase === "collect-code")!.startedAt));

  const top = hero(run, status, later, { proc: gone });
  assert.equal(top.kicker, "失联");
  assert.equal(top.title, "运行进程不在了（pid 4242），不会再有结果");
  assert.match(top.subtitle ?? "", /「读 packages\/plugin\/src」（gpt-5\.5）/);
  assert.match(top.subtitle ?? "", /可能还在跑、还在花钱/);
  assert.equal(top.needsYou, true);
  assert.equal(top.select, "a2");
});

test("titles in brackets from older runtimes read as phase and step", () => {
  const head = { v: 1, ts: "2026-09-24T00:00:00Z", runId: "r" };
  const run = foldEvents([
    { ...head, seq: 0, kind: "run.start", flow: { name: "x", phases: [{ id: "draft", title: "起草" }] }, input: { ticket: 100231 } },
    { ...head, seq: 1, kind: "phase.start", phase: "draft" },
    { ...head, seq: 2, kind: "call.start", callId: "a", type: "ask", name: "draft", title: "[draft] #100231", phase: "draft", provider: "claude/x" },
    { ...head, seq: 3, kind: "call.start", callId: "b", type: "ask", name: "advise", title: "[advise]", phase: null, provider: "claude/x" },
    // A headline naming a field that is not there, or of the wrong type: fall back to the guess.
    { ...head, seq: 4, kind: "call.end", callId: "a", ok: true, output: { verdict: "hotfix", note: "x" } },
  ]);
  assert.equal(callTitle(run, run.calls.get("a")!), "起草 · draft #100231");
  assert.equal(callTitle(run, run.calls.get("b")!), "advise");
  assert.equal(inputLabel(run.start), "#100231");
  assert.equal(headline(run.calls.get("a")!, "running"), "hotfix");
  const wrong = foldEvents([
    { ...head, seq: 0, kind: "run.start", flow: { name: "x", phases: [] } },
    { ...head, seq: 1, kind: "call.start", callId: "a", type: "ask", name: "s", title: "S", phase: null, provider: "p/m", headline: 7 },
    { ...head, seq: 2, kind: "call.end", callId: "a", ok: true, output: { done: true } },
  ]);
  assert.equal(wrong.calls.get("a")!.ask?.headline, null);
  assert.equal(headline(wrong.calls.get("a")!, "done"), "done：是");
  // A named yes/no answers the title's question on its own, without the schema's description.
  const named = foldEvents([
    { ...head, seq: 0, kind: "run.start", flow: { name: "x", phases: [] } },
    {
      ...head, seq: 1, kind: "call.start", callId: "a", type: "ask", name: "assess", title: "裁决：收敛了吗", phase: null, provider: "p/m",
      headline: "converged", schema: { type: "object", properties: { converged: { type: "boolean", description: "True only if both positions agree." } } },
    },
    { ...head, seq: 2, kind: "call.end", callId: "a", ok: true, output: { converged: false } },
  ]);
  assert.equal(headline(named.calls.get("a")!, "done"), "否");
});

test("a shape the loop rule does not recognize stays flat and keeps every call", () => {
  const head = { v: 1, runId: "r" };
  const t = (s: number) => new Date(Date.parse("2026-09-24T00:00:00Z") + s * 1000).toISOString();
  let seq = 0;
  const e = (s: number, kind: string, rest: object) => ({ ...head, seq: seq++, ts: t(s), kind, ...rest });
  const run = foldEvents([
    e(0, "run.start", { flow: { name: "x", phases: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }] } }),
    e(1, "phase.start", { phase: "a" }),
    e(1, "call.start", { callId: "x1", type: "do", name: "x1", title: "x1", phase: "a" }),
    e(2, "call.end", { callId: "x1", ok: true, output: null }),
    e(2, "phase.end", { phase: "a", ok: true }),
    // b and c overlap: a column of two, which a loop row cannot hold.
    e(3, "phase.start", { phase: "b" }),
    e(3, "phase.start", { phase: "c" }),
    e(4, "phase.end", { phase: "b", ok: true }),
    e(5, "phase.end", { phase: "c", ok: true }),
    e(6, "phase.start", { phase: "a" }),
    e(6, "call.start", { callId: "x2", type: "do", name: "x2", title: "x2", phase: "a" }),
    e(7, "call.end", { callId: "x2", ok: true, output: null }),
    e(7, "phase.end", { phase: "a", ok: true }),
    e(8, "run.end", { outcome: "done", durationMs: 8000 }),
  ]);
  const graph = buildGraph(run, "done", Date.now());
  assert.deepEqual(shape(graph).slice(1), ["A[x1]", "(B[] ‖ C[])", "A[x2]", "end:完成"]);
  assert.deepEqual(nodeIds(graph), ["x1", "x2"]);
  assert.equal(graph.visits[3]!.round, 2);
});

test("the start and end are always there to select", () => {
  const graph = buildGraph(foldEvents(fixture("advisor-failed.jsonl")), "failed", Date.now());
  assert.equal(graph.pieceOf.get(START), 0);
  assert.equal(graph.pieces[0]!.kind, "input");
});
