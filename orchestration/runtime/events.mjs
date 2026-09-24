// The run's event stream: one JSONL file per run, the runtime's only output.
// The contract is EVENTS.md; `checkEvents` below is that contract as code, for
// the tests here and for any reader that wants to know it is reading it right.
//
// Two rules the stream exists to keep:
//   - Model-visible implies logged. Every prompt sent to a model is in a
//     call.start, in full, and every structured answer is in its call.end.
//   - Prompts are stored in full, not summarized: an evaluation corpus is
//     built from these files, and a summary cannot be replayed.
//
// This replaces the per-day audit files. Keeping both would mean two records
// of the same calls that can disagree; the old files stay where they are.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const EVENTS_VERSION = 1;

/** `<logDir>/runs/<runId>.jsonl` */
export const eventsFile = (dir, runId) => path.join(dir, "runs", `${runId}.jsonl`);

/**
 * Append-only writer. Writes are synchronous so that the line is on disk, in
 * `seq` order, before the call it describes goes further -- a reader tailing
 * the file sees a call start before the call can finish, and a crash loses at
 * most the line being written.
 *
 * After `run.end` the log is closed and later writes are dropped: a call still
 * in flight when the run ended has already been closed with a call.end, and a
 * second one would break the contract.
 */
export class EventLog {
  constructor({ dir, runId }) {
    this.runId = runId;
    this.file = eventsFile(dir, runId);
    this.seq = 0;
    this.closed = false;
    this.events = [];
    mkdirSync(path.dirname(this.file), { recursive: true });
  }

  emit(kind, fields = {}) {
    if (this.closed) return null;
    const event = { v: EVENTS_VERSION, seq: this.seq++, ts: new Date().toISOString(), runId: this.runId, kind, ...fields };
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    this.events.push(event);
    if (kind === "run.end") this.closed = true;
    return event;
  }
}

/**
 * Read an events file. A last line without its newline is a write in
 * progress and is left out, as EVENTS.md tells readers to do.
 */
export function readEvents(file) {
  const text = readFileSync(file, "utf8");
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  return complete.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// --- Contract check ---------------------------------------------------

const isString = (v) => typeof v === "string";
const isNullableString = (v) => v === null || typeof v === "string";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNullableNumber = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
const isError = (v) => isObject(v) && isString(v.name) && isString(v.message);

const GATE_OUTCOMES = ["allowed", "denied", "expired", "mismatch", "error"];
const GATE_FIELDS = ["outcome", "approved", "agentId", "sha256", "askedAt", "decidedAt", "waitedMs", "reason", "agentReport", "by", "agentStatusAtDecision"];

/**
 * Check a run's events against EVENTS.md v1. Returns a list of problems,
 * empty when the stream conforms.
 *
 * `strict` (for this runtime's own output) also refuses kinds the contract
 * does not define; a reader must ignore those instead. `complete` requires a
 * run.end.
 *
 * @param {object[]} events
 * @param {{ strict?: boolean, complete?: boolean }} [options]
 */
export function checkEvents(events, { strict = false, complete = false } = {}) {
  const problems = [];
  const bad = (event, message) => problems.push(`seq ${event?.seq ?? "?"} (${event?.kind ?? "?"}): ${message}`);
  const need = (event, ok, message) => ok || bad(event, message);

  if (events.length === 0) return ["no events"];
  const first = events[0];
  if (first.kind !== "run.start") problems.push("the first event is not run.start");
  const runId = first.runId;

  let phases = new Set();
  const phaseDepth = new Map();
  const calls = new Map(); // callId -> call.start
  const ended = new Set();
  const caveatTexts = new Set();
  let runEnd = null;

  events.forEach((event, index) => {
    need(event, event.v === EVENTS_VERSION, `v is ${event.v}, expected ${EVENTS_VERSION}`);
    need(event, event.seq === index, `seq is ${event.seq}, expected ${index}`);
    need(event, isString(event.ts) && !Number.isNaN(Date.parse(event.ts)), "ts is not an ISO time");
    need(event, event.runId === runId && isString(runId), "runId differs from run.start");
    need(event, isString(event.kind), "kind is not a string");
    if (runEnd) bad(event, "comes after run.end");

    switch (event.kind) {
      case "run.start": {
        need(event, index === 0, "run.start is not the first event");
        const flow = event.flow;
        if (!isObject(flow)) {
          bad(event, "flow is not an object");
          break;
        }
        need(event, isString(flow.name) && isString(flow.description), "flow.name / flow.description are not strings");
        need(event, Array.isArray(flow.phases) && flow.phases.every((p) => isString(p?.id) && isString(p?.title)), "flow.phases is not [{ id, title }]");
        need(event, isObject(flow.inputs), "flow.inputs is not a JSON Schema object");
        need(event, Array.isArray(flow.grants) && flow.grants.every(isString), "flow.grants is not string[]");
        phases = new Set((flow.phases ?? []).map((p) => p?.id));
        need(event, isNullableString(event.source), "source is not string | null");
        need(event, isObject(event.input), "input is not an object");
        need(event, isNullableString(event.caller), "caller is not string | null");
        need(event, isString(event.cwd), "cwd is not a string");
        need(event, isNullableString(event.host), "host is not string | null");
        break;
      }
      case "phase.start":
      case "phase.end": {
        if (!phases.has(event.phase)) {
          bad(event, `phase "${event.phase}" is not declared in run.start`);
          break;
        }
        const depth = phaseDepth.get(event.phase) ?? 0;
        if (event.kind === "phase.start") phaseDepth.set(event.phase, depth + 1);
        else {
          need(event, typeof event.ok === "boolean", "ok is not a boolean");
          need(event, depth > 0, "phase.end without a phase.start");
          phaseDepth.set(event.phase, Math.max(0, depth - 1));
        }
        break;
      }
      case "call.start": {
        if (!isString(event.callId) || calls.has(event.callId)) {
          bad(event, `callId ${JSON.stringify(event.callId)} is missing or reused`);
          break;
        }
        calls.set(event.callId, event);
        need(event, ["ask", "do", "gate"].includes(event.type), `type "${event.type}" is not ask | do | gate`);
        need(event, isString(event.name) && isString(event.title), "name / title are not strings");
        need(event, event.phase === null || phases.has(event.phase), `phase ${JSON.stringify(event.phase)} is not null or declared`);
        if (event.type === "gate") need(event, event.name === "gate", 'a gate call is named "gate"');
        if (event.type === "ask") {
          need(event, isNullableString(event.role), "role is not string | null");
          need(event, isString(event.provider), "provider is not a string");
          need(event, isNullableString(event.thinking), "thinking is not string | null");
          need(event, ["none", "workspace"].includes(event.effects), "effects is not none | workspace");
          need(
            event,
            isObject(event.fence) && isNullableString(event.fence.mode) && typeof event.fence.enforced === "boolean" && isString(event.fence.note),
            "fence is not { mode, enforced, note }",
          );
          need(event, isString(event.prompt) && event.prompt.length > 0, "prompt is missing");
          need(event, isObject(event.schema), "schema is not an object");
          need(event, isString(event.schemaFingerprint), "schemaFingerprint is not a string");
          need(event, isString(event.timeout), "timeout is not a string");
        }
        if (event.type === "gate") {
          for (const key of ["brief", "content", "sha256", "timeout"]) need(event, isString(event[key]), `${key} is not a string`);
        }
        break;
      }
      case "call.end": {
        const start = calls.get(event.callId);
        if (!start) {
          bad(event, `callId ${JSON.stringify(event.callId)} has no call.start`);
          break;
        }
        need(event, !ended.has(event.callId), "second call.end for this call");
        ended.add(event.callId);
        need(event, typeof event.ok === "boolean", "ok is not a boolean");
        need(event, typeof event.durationMs === "number" && event.durationMs >= 0, "durationMs is not a number");
        need(event, "output" in event, "output is missing");
        need(event, event.error === null || isError(event.error), "error is not { name, message } | null");
        need(event, event.ok ? event.error === null : event.error !== null, "ok and error disagree");
        need(event, isNullableString(event.agentId), "agentId is not string | null");
        if (start.type === "do") need(event, event.agentId === null, "a do call has no agent");
        need(
          event,
          event.cost === null ||
            (isObject(event.cost) && isNullableNumber(event.cost.usd) && isNullableNumber(event.cost.inputTokens) && isNullableNumber(event.cost.outputTokens)),
          "cost is not { usd, inputTokens, outputTokens } | null",
        );
        if (start.type === "gate" && event.ok) {
          const output = event.output;
          need(event, isObject(output) && GATE_FIELDS.every((key) => key in output), `gate output lacks ${GATE_FIELDS.filter((k) => !(k in (output ?? {}))).join(", ")}`);
          need(event, GATE_OUTCOMES.includes(output?.outcome), `gate outcome "${output?.outcome}" is unknown`);
        }
        break;
      }
      case "caveat":
        need(event, event.callId === null || calls.has(event.callId), "callId is not null or a started call");
        need(event, isString(event.text), "text is not a string");
        caveatTexts.add(event.text);
        break;
      case "log":
        need(event, ["info", "warn", "error"].includes(event.level), `level "${event.level}" is unknown`);
        need(event, isString(event.message), "message is not a string");
        break;
      case "run.end": {
        runEnd = event;
        const outcome = event.outcome;
        need(event, ["done", "stopped", "failed", "timeout"].includes(outcome), `outcome "${outcome}" is unknown`);
        need(event, "value" in event, "value is missing");
        need(
          event,
          outcome === "stopped" ? isObject(event.stop) && isString(event.stop.reason) && isNullableString(event.stop.phase) : event.stop === null,
          "stop must be { reason, phase } when stopped and null otherwise",
        );
        need(
          event,
          outcome === "failed" || outcome === "timeout" ? isError(event.error) : event.error === null,
          "error must be { name, message } when failed or timed out and null otherwise",
        );
        need(event, typeof event.durationMs === "number", "durationMs is not a number");
        need(
          event,
          event.cost === null || (isObject(event.cost) && typeof event.cost.totalUsd === "number" && typeof event.cost.agentCount === "number" && isString(event.cost.partial)),
          "cost is not { totalUsd, agentCount, partial } | null",
        );
        need(event, Array.isArray(event.caveats) && event.caveats.every(isString), "caveats is not string[]");
        need(event, new Set(event.caveats).size === (event.caveats ?? []).length, "caveats has duplicates");
        for (const text of caveatTexts) need(event, (event.caveats ?? []).includes(text), `caveat missing from run.end: ${text.slice(0, 80)}`);
        const open = [...calls.keys()].filter((id) => !ended.has(id));
        need(event, open.length === 0, `calls without call.end: ${open.join(", ")}`);
        const openPhases = [...phaseDepth].filter(([, depth]) => depth > 0).map(([id]) => id);
        need(event, openPhases.length === 0, `phases without phase.end: ${openPhases.join(", ")}`);
        break;
      }
      default:
        if (strict) bad(event, "kind is not in the contract");
    }
  });

  if (complete && !runEnd) problems.push("no run.end");
  return problems;
}
