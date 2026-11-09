// What a run is doing now, in one object: `orch.mjs status <runId>`. A caller that started a run (a plugin showing it to a person)
// asks this instead of reading the events file itself: whether the run is alive (state.mjs, the one table), which phase it is in,
// what it is asking an agent, which person-gates are waiting and which were answered how, what it has cost, how it ended and where it
// can be carried on from. It reads two files and starts nothing.

import { existsSync } from "node:fs";
import { eventsFile, readEvents } from "./events.mjs";
import { readRunState } from "./state.mjs";
import { pointOf, pointPrint } from "./resume-point.mjs";

const oneLine = (text, limit = 120) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
const resumeStatus = (point) => point ? { ...pointOf(point), print: pointPrint(point) } : null;

/**
 * @param {{ dir: string, runId: string, now?: () => number, spawnedAt?: number | null }} options
 */
export function runStatus({ dir, runId, now = Date.now, spawnedAt = null }) {
  const live = readRunState({ dir, runId, now, spawnedAt });
  const out = {
    runId,
    state: live.state,
    reason: live.reason,
    refused: live.refused,
    refusedKind: live.refusedKind,
    outcome: live.outcome,
    flow: null,
    resumeOf: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    phase: null,
    asking: [],
    gates: [],
    costUsd: null,
    summary: null,
    stop: null,
    error: null,
    resume: null,
    lastEventAt: live.lastEventAt,
  };
  const file = eventsFile(dir, runId);
  if (!existsSync(file)) return out;

  let events;
  try {
    events = readEvents(file);
  } catch {
    return out;
  }
  const start = events.find((e) => e.kind === "run.start");
  if (!start) return out;
  const phaseTitles = new Map((start.flow?.phases ?? []).map((p) => [p.id, p.title ?? p.id]));
  out.flow = start.flow?.name ?? null;
  out.resumeOf = start.resumeOf ?? null;
  out.startedAt = start.ts;

  const calls = new Map();
  const open = [];
  let lastPhase = null;
  let spent = 0;
  let anyCost = false;
  let resume = null;
  let end = null;
  for (const e of events) {
    if (e.kind === "phase.start") {
      open.push(e.phase);
      lastPhase = e.phase;
    } else if (e.kind === "phase.end") {
      const at = open.lastIndexOf(e.phase);
      if (at >= 0) open.splice(at, 1);
    } else if (e.kind === "call.start") {
      calls.set(e.callId, { type: e.type, name: e.name, title: e.title, startedAt: e.ts, ended: false, agentId: null, output: null, ok: null });
    } else if (e.kind === "call.agent") {
      const call = calls.get(e.callId);
      if (call) call.agentId = e.agentId;
    } else if (e.kind === "call.end") {
      const call = calls.get(e.callId);
      if (call) Object.assign(call, { ended: true, ok: e.ok, output: e.output, endedAt: e.ts, agentId: e.agentId ?? call.agentId });
      if (typeof e.cost?.usd === "number") {
        spent += e.cost.usd;
        anyCost = true;
      }
    } else if (e.kind === "resume") {
      resume = e.cleared ? null : resumeStatus(e);
    } else if (e.kind === "run.end") {
      end = e;
    }
  }

  const current = open.length ? open[open.length - 1] : lastPhase;
  out.phase = current ? { id: current, title: phaseTitles.get(current) ?? current } : null;
  out.asking = [...calls.entries()]
    .filter(([, c]) => c.type === "ask" && !c.ended)
    .map(([callId, c]) => ({ callId, name: c.name, title: oneLine(c.title), agentId: c.agentId }));
  out.gates = [...calls.entries()]
    .filter(([, c]) => c.type === "gate")
    .map(([callId, c]) => ({
      callId,
      title: oneLine(c.title),
      // `waiting` until the call ends; then the person's answer, or `error` when the gate itself failed.
      state: !c.ended ? "waiting" : c.output?.outcome ?? "error",
      askedAt: c.output?.askedAt ?? c.startedAt,
      decidedAt: c.output?.decidedAt ?? null,
      agentId: c.output?.agentId ?? c.agentId,
      reason: c.output?.reason ? oneLine(c.output.reason) : null,
    }));
  out.costUsd = end?.cost?.totalUsd ?? (anyCost ? spent : null);
  if (end) {
    out.endedAt = end.ts;
    out.durationMs = end.durationMs ?? null;
    out.summary = end.summary ? oneLine(end.summary, 200) : null;
    out.stop = end.stop ? { reason: oneLine(end.stop.reason, 200), kind: end.stop.kind ?? null } : null;
    out.error = end.error ? { name: end.error.name, message: oneLine(end.error.message, 200) } : null;
    out.resume = resumeStatus(end.resume);
  } else {
    out.durationMs = Math.max(0, now() - Date.parse(start.ts));
    out.resume = resume;
  }
  return out;
}
