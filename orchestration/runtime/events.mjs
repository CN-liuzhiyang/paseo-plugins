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
import { affairProblems } from "./affair.mjs";
import { PRINT_SHAPE, pointProblems } from "./resume-point.mjs";

export const EVENTS_VERSION = 1;

/** What a secret value is replaced with wherever it would be written (an input gate's value, gate.mjs). */
const SECRET_MARK = "<已用>";

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
    this.secrets = [];
    mkdirSync(path.dirname(this.file), { recursive: true });
  }

  /**
   * From now on a secret `value` is written as `<已用>` wherever it turns up in an event, whoever put it there:
   * the flow's logs, its return value, an error message, a key. What is matched, exactly:
   *   - the value as text, and its JSON-escaped spelling (it was logged as part of a JSON string);
   *   - for a value of digits, the number it becomes when its leading zeros go (`Number("004839")`);
   *   - its hex, base64 (padded or not, and the URL-safe one) and URL-encoded spelling, as a whole;
   *   - a number or bigint whose decimal text contains any of these (the whole number is replaced);
   *   - an array of single characters or single digits that reads as one of them, and an array or
   *     index-keyed object of bytes (a Buffer, a Uint8Array after JSON) that decodes to one.
   * What is not: another case, a part of the value, the value reversed, hashed, split across fields or
   * written in any other encoding. A flow that transforms the value escapes this (docs/gate-input.md).
   */
  addSecret(value) {
    if (typeof value !== "string" || value === "") return;
    const bytes = Buffer.from(value, "utf8");
    const spellings = new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url")]);
    if (/^\d+$/.test(value) && value.replace(/^0+/, "").length >= 4) spellings.add(value.replace(/^0+/, ""));
    for (const spelling of spellings) if (!this.secrets.includes(spelling)) this.secrets.push(spelling);
    this.secrets.sort((a, b) => b.length - a.length);
  }

  #text(text) {
    return this.secrets.reduce((result, secret) => result.split(secret).join(SECRET_MARK), text);
  }

  #hides(text) {
    return this.#text(text) !== text;
  }

  #walk(node) {
    if (typeof node === "string") return this.#text(node);
    if (typeof node === "number" || typeof node === "bigint") {
      const text = String(node);
      return this.#hides(text) ? this.#text(text) : node;
    }
    if (Array.isArray(node)) {
      if (this.#spellsSecret(node)) return SECRET_MARK;
      return node.map((item) => this.#walk(item));
    }
    if (node !== null && typeof node === "object") {
      const keys = Object.keys(node);
      // A Uint8Array that went through JSON: { "0": 52, "1": 56, ... }.
      if (keys.length > 1 && keys.every((key, i) => key === String(i)) && this.#spellsSecret(Object.values(node))) return SECRET_MARK;
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [this.#text(key), this.#walk(item)]));
    }
    return node;
  }

  /** Whether a list reads as the secret: its single characters or digits joined, or its bytes decoded. */
  #spellsSecret(list) {
    if (list.length < 2) return false;
    if (list.every((item) => (typeof item === "string" && [...item].length === 1) || (Number.isInteger(item) && item >= 0 && item <= 9))) {
      if (this.#hides(list.join(""))) return true;
    }
    if (list.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      const bytes = Buffer.from(list);
      return this.#hides(bytes.toString("utf8")) || this.#hides(bytes.toString("latin1")) || this.#hides(bytes.toString("utf16le"));
    }
    return false;
  }

  /**
   * `value` with every secret replaced (a copy; the original is not touched). `keep` names top-level keys the
   * caller owns and a secret must not reach (numbers like durationMs).
   */
  scrub(value, keep = []) {
    if (this.secrets.length === 0) return value;
    if (value !== null && typeof value === "object" && !Array.isArray(value) && keep.length > 0) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.#text(key), keep.includes(key) ? item : this.#walk(item)]));
    }
    return this.#walk(value);
  }

  emit(kind, fields = {}) {
    if (this.closed) return null;
    // The envelope (v, seq, ts, runId, kind) is the runtime's own and is not scrubbed: a short value must not eat a timestamp.
    const event = { v: EVENTS_VERSION, seq: this.seq++, ts: new Date().toISOString(), runId: this.runId, kind, ...this.scrub(fields, ["durationMs", "cost"]) };
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
  // A field added to v1 after files were already written: strict wants it,
  // a reader of older files takes it as absent, and when present it must fit.
  const added = (event, key, ok, message) => {
    if (!(key in event)) {
      if (strict) bad(event, `${key} is missing`);
      return;
    }
    need(event, ok, message);
  };

  if (events.length === 0) return ["no events"];
  const first = events[0];
  if (first.kind !== "run.start") problems.push("the first event is not run.start");
  const runId = first.runId;

  let phases = new Set();
  const phaseDepth = new Map();
  const calls = new Map(); // callId -> call.start
  const ended = new Set();
  const agents = new Map(); // callId -> agentId from call.agent
  const endedOk = new Set(); // calls whose call.end said ok
  const archived = new Set(); // calls that have a call.archive
  const agentOf = new Map(); // callId -> the agent it ended with
  const fixRound = new Map(); // callId -> round of its latest call.fix
  const fixedRound = new Map(); // callId -> round of its latest call.fixed
  const caveatTexts = new Set();
  let runEnd = null;
  let wakeSeen = false;

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
        need(event, Number.isInteger(event.pid) && event.pid > 0, "pid is not a positive integer");
        need(event, isString(event.hostname) && event.hostname.length > 0, "hostname is not a string");
        {
          const affair = "affair" in event ? affairProblems(event.affair) : [];
          added(event, "affair", affair.length === 0, `affair is not null or { label, url?, link? }: ${affair.join("; ")}`);
        }
        added(event, "resumeOf", isNullableString(event.resumeOf), "resumeOf is not string | null");
        added(event, "resumePrint", event.resumePrint === null || (typeof event.resumePrint === "string" && PRINT_SHAPE.test(event.resumePrint) && event.resumeOf !== null), "resumePrint is not null, or the fingerprint of the point a run that carries on another started from");
        added(event, "lineage", isString(event.lineage) && event.lineage !== "" && (event.resumeOf !== null || event.lineage === runId), "lineage is not the id of the first run of the line this run belongs to (its own id when it carries nothing on)");
        added(event, "redo", isNullableString(event.redo) && (event.redo === null || event.resumeOf !== null), "redo is not null, or the name of a step of the line of runs that a run which carries one on does again");
        added(
          event,
          "notify",
          event.notify === null || (isObject(event.notify) && isString(event.notify.agent) && event.notify.agent !== "" && ["explicit", "caller"].includes(event.notify.via)),
          "notify is not null | { agent, via: explicit | caller }",
        );
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
        need(event, ["ask", "do", "gate", "step"].includes(event.type), `type "${event.type}" is not ask | do | gate | step`);
        need(event, isString(event.name) && isString(event.title), "name / title are not strings");
        need(event, event.phase === null || phases.has(event.phase), `phase ${JSON.stringify(event.phase)} is not null or declared`);
        if (event.type === "gate") need(event, event.name === "gate", 'a gate call is named "gate"');
        if (event.type !== "do") {
          // Taken from the journal rather than done: what it was taken from. callId is null for a record that no call of the journal's run made (a probe or `settle` wrote it).
          const reused = event.reused;
          added(event, "reused", reused === null || (isObject(reused) && isString(reused.runId) && (isString(reused.callId) || reused.callId === null)), "reused is not null | { runId, callId }");
        }
        if (event.type === "step") {
          need(event, typeof event.once === "boolean", "once is not a boolean");
          need(event, isString(event.key) && /^[0-9a-f]{16}$/.test(event.key), "key is not the 16 hex digits of the fingerprint of the step's key");
        }
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
          added(
            event,
            "headline",
            event.headline === null || (isString(event.headline) && Object.hasOwn(event.schema?.properties ?? {}, event.headline)),
            "headline is not null or a field of schema",
          );
          added(event, "archive", event.archive === null || event.archive === "after", 'archive is not null | "after"');
          for (const key of ["continues", "revises"]) {
            const ref = event[key];
            added(event, key, ref === null || (isObject(ref) && isString(ref.runId) && isString(ref.callId)), `${key} is not null | { runId, callId }`);
            // Within this run the call it names must have started before this one.
            if (isObject(ref) && ref.runId === runId) need(event, calls.has(ref.callId), `${key} names ${ref.callId}, which has not started`);
          }
          need(event, !(event.continues && event.revises), "a call that continues an agent does not also revise an answer: a new agent revises, the same one continues");
        }
        if (event.type === "gate") {
          for (const key of ["brief", "content", "sha256", "timeout"]) need(event, isString(event[key]), `${key} is not a string`);
          if ("input" in event) {
            const i = event.input;
            need(event, isObject(i) && isString(i.label) && typeof i.secret === "boolean" && isNullableString(i.pattern) && isString(i.hint), "input is not { label, secret, pattern, hint }");
          }
        }
        break;
      }
      case "call.agent": {
        const start = calls.get(event.callId);
        if (!start) {
          bad(event, `callId ${JSON.stringify(event.callId)} has no call.start`);
          break;
        }
        need(event, start.type !== "do" && start.type !== "step", `a ${start.type} call has no agent`);
        need(event, !ended.has(event.callId), "call.agent after the call's call.end");
        need(event, !agents.has(event.callId), "second call.agent for this call");
        need(event, isString(event.agentId) && event.agentId.length > 0, "agentId is not a string");
        agents.set(event.callId, event.agentId);
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
        if (event.ok === true) endedOk.add(event.callId);
        need(event, typeof event.ok === "boolean", "ok is not a boolean");
        need(event, typeof event.durationMs === "number" && event.durationMs >= 0, "durationMs is not a number");
        need(event, "output" in event, "output is missing");
        need(event, event.error === null || isError(event.error), "error is not { name, message } | null");
        need(event, event.ok ? event.error === null : event.error !== null, "ok and error disagree");
        need(event, isNullableString(event.agentId), "agentId is not string | null");
        if (start.type === "do" || start.type === "step") need(event, event.agentId === null, `a ${start.type} call has no agent`);
        if (agents.has(event.callId) && event.agentId !== null) {
          need(event, event.agentId === agents.get(event.callId), "agentId differs from the call's call.agent");
        }
        if (event.agentId) agentOf.set(event.callId, event.agentId);
        {
          // A call that asked an agent again ends with that agent.
          const asked = start.continues?.runId === runId ? agentOf.get(start.continues.callId) : undefined;
          if (asked && event.agentId) need(event, event.agentId === asked, `agentId differs from ${start.continues.callId}'s, which this call continues`);
        }
        if (start.type === "ask") {
          added(event, "rounds", Number.isInteger(event.rounds) && event.rounds >= Math.max(1, fixedRound.get(event.callId) ?? 0), "rounds is not an integer of at least 1, and at least the last round that call.fixed answered");
        }
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
      case "call.fix":
      case "call.fixed": {
        const start = calls.get(event.callId);
        if (!start) {
          bad(event, `callId ${JSON.stringify(event.callId)} has no call.start`);
          break;
        }
        const fixing = event.kind === "call.fix";
        need(event, start.type === "ask", `${event.kind} for a call that is not an ask`);
        need(event, !ended.has(event.callId), `${event.kind} after the call's call.end`);
        need(event, Number.isInteger(event.round) && event.round >= 2, "round is not an integer of at least 2 (round 1 is the first answer)");
        const before = fixRound.get(event.callId) ?? 1;
        if (fixing) {
          need(event, event.round > before, "round does not come after the call's earlier call.fix");
          need(event, (fixedRound.get(event.callId) ?? 1) === before, "call.fix while the call's earlier call.fix has no call.fixed");
          fixRound.set(event.callId, event.round);
          need(
            event,
            Array.isArray(event.problems) && event.problems.length > 0 && event.problems.every((p) => isObject(p) && isString(p.at) && isString(p.say)),
            "problems is not a non-empty [{ at, say }]",
          );
          need(event, isString(event.prompt) && event.prompt.length > 0, "prompt is missing");
          need(event, isObject(event.schema), "schema is not an object");
        } else {
          need(event, event.round === before && (fixedRound.get(event.callId) ?? 1) < before, "call.fixed is not the answer to the call's latest call.fix");
          fixedRound.set(event.callId, event.round);
          need(event, "answer" in event, "answer is missing");
          need(event, typeof event.ok === "boolean", "ok is not a boolean");
          need(event, typeof event.durationMs === "number" && event.durationMs >= 0, "durationMs is not a number");
          need(
            event,
            event.cost === null || (isObject(event.cost) && isNullableNumber(event.cost.usd) && isNullableNumber(event.cost.inputTokens) && isNullableNumber(event.cost.outputTokens)),
            "cost is not { usd, inputTokens, outputTokens } | null",
          );
        }
        break;
      }
      case "call.archive": {
        const start = calls.get(event.callId);
        if (!start) {
          bad(event, `callId ${JSON.stringify(event.callId)} has no call.start`);
          break;
        }
        need(event, start.type === "ask" && start.archive === "after", 'call.archive for a call that did not ask for archive: "after"');
        need(event, endedOk.has(event.callId), "call.archive for a call that has no call.end, or whose call.end is not ok");
        need(event, !archived.has(event.callId), "second call.archive for this call");
        archived.add(event.callId);
        need(event, typeof event.ok === "boolean", "ok is not a boolean");
        need(event, isNullableString(event.agentId), "agentId is not string | null");
        need(event, isNullableString(event.code) && isNullableString(event.message), "code / message are not string | null");
        need(event, event.ok === (event.code === null), "ok and code disagree: code is null when it was done, a string when it was not");
        if (event.ok === true) need(event, isString(event.agentId) && event.agentId !== "", "an archive that was done names its agent");
        break;
      }
      case "workspace":
        need(event, isString(event.workspaceId) && event.workspaceId !== "", "workspaceId is not a non-empty string");
        need(event, isString(event.cwd) && isString(event.title), "cwd / title are not strings");
        need(event, isString(event.key) && event.key !== "", "key is not a non-empty string");
        need(event, typeof event.created === "boolean", "created is not a boolean");
        break;
      case "resume": {
        if (event.cleared === true) {
          need(event, !("flow" in event) && !("input" in event) && !("from" in event) && !("spends" in event), "a resume event that takes the point back carries no point");
          break;
        }
        const { v, seq, ts, runId: id, kind, ...point } = event;
        const bad = pointProblems(point);
        need(event, bad.length === 0, `not { cleared: true } and not a resume point: ${bad.join("; ")}`);
        break;
      }
      case "wake": {
        need(event, !wakeSeen, "a second wake");
        wakeSeen = true;
        need(event, isNullableString(event.to) && (event.to === null || event.to !== ""), "to is not null or an agent id");
        need(event, [null, "explicit", "caller", "steward"].includes(event.via) && (event.to === null) === (event.via === null), "via is explicit | caller | steward when there is a recipient and null when there is none");
        need(event, event.to === null ? event.ok === null || event.ok === false : typeof event.ok === "boolean", "ok is a boolean when there is a recipient, and null (false when looking for one failed) when there is none");
        need(event, isNullableString(event.error) && (event.ok !== false || event.error !== null), "error is a string when delivering failed (ok false) and null or a string otherwise");
        need(event, isNullableString(event.why), "why is not string | null");
        need(event, typeof event.started === "boolean" && (!event.started || event.via === "steward"), "started is a boolean, and only a steward is started");
        need(event, Number.isInteger(event.unseen) && event.unseen >= 0, "unseen is not a non-negative integer");
        need(event, typeof event.ledger === "boolean", "ledger is not a boolean");
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
        added(
          event,
          "summary",
          event.summary === null || (outcome !== "failed" && outcome !== "timeout" && isString(event.summary) && event.summary.trim() !== ""),
          "summary must be null, or a non-empty string when done or stopped",
        );
        need(
          event,
          outcome === "stopped" ? isObject(event.stop) && isString(event.stop.reason) && isNullableString(event.stop.phase) : event.stop === null,
          "stop must be { reason, phase, kind, step } when stopped and null otherwise",
        );
        // `kind` was added after files were written: strict wants it, and a reader of older files takes it as absent.
        if (outcome === "stopped" && isObject(event.stop)) {
          const { kind, step } = event.stop;
          if (!("kind" in event.stop) && !("step" in event.stop)) {
            if (strict) bad(event, "stop.kind is missing");
          } else {
            need(
              event,
              ["flow", "check", "unknown"].includes(kind) && (kind === "flow" ? step === null : isString(step) && step !== ""),
              "stop.kind is flow (step null), check or unknown (step the name of the step)",
            );
          }
        }
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
        added(
          event,
          "resume",
          event.resume === null || (outcome !== "done" && pointProblems(event.resume).length === 0),
          "resume must be null, or a resume point when the run did not come to done",
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
