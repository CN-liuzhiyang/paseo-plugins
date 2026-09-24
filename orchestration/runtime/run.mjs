// The runner: the one way a flow runs, from the CLI (orch.mjs) or from code.
//
//   const result = await runFlow("flows/advisor.mjs", { input: { question, role: "fast" } });
//
// It owns everything around the flow's own logic: input checking before any
// spend, grants, the total timeout, the event stream, per-call cost, caveats,
// and settling -- a run that returned, stopped, threw or timed out ends the
// same way, with a run.end, because a failed run is exactly when its cost and
// its unenforced constraints matter most.
//
// The flow is not sandboxed and this does not pretend it is: it runs in this
// process with full Node access. Safety comes from the event stream, the
// grants, and the fact that only a local caller can reach this file.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { format } from "node:util";
import { loadFlow, describeFlow, scanSource, DEFAULT_GRANTS } from "./flow.mjs";
import { isStep, validate } from "./step.mjs";
import { loadRoster, bindRole, composePrompt } from "./roster.mjs";
import { fenceFor } from "./fences.mjs";
import { EventLog } from "./events.mjs";
import { paseoExecutor, sentTitle } from "./executor.mjs";
import { requestApproval, gatePrompt, contentDigest, parseDuration } from "./gate.mjs";
import { logDir as configuredLogDir } from "./config.mjs";

/** The call timeout for a step that declares none. R7 says declare one. */
export const DEFAULT_CALL_TIMEOUT = "30m";
/** The gate's carrier only copies text into a Write call; the cheap role is enough. */
const GATE_ROLE = "fast";
/** `do` outputs are the script's own values, often file contents; the event keeps a prefix. */
const DO_STRING_LIMIT = 2_000;

const COST_NOTE =
  "per agent, LastUsage: the last turn only (a structured call is one turn). Codex reports CostUsd 0, so totalUsd counts Claude only";

/** The input, the flow's source text, or its grants are wrong. Nothing ran and nothing was spent. */
export class RunRefused extends Error {
  constructor(message, problems = []) {
    super(problems.length > 0 ? `${message}:\n  - ${problems.join("\n  - ")}` : message);
    this.name = "RunRefused";
    this.problems = problems;
  }
}

export class GrantError extends Error {
  constructor(action, grants) {
    super(`"${action}" is not granted to this flow. Granted: ${grants.join(", ")}. Declare it in the flow's grants.`);
    this.name = "GrantError";
  }
}

class StopSignal extends Error {
  constructor(reason, value, phase) {
    super(`flow stopped: ${reason}`);
    this.name = "StopSignal";
    this.reason = reason;
    this.value = value;
    this.phase = phase;
  }
}

class RunTimeout extends Error {
  constructor(limit) {
    super(`the run exceeded its ${limit} limit`);
    this.name = "RunTimeout";
  }
}

const errorOf = (error) => ({ name: error?.name ?? "Error", message: error?.message ?? String(error) });

/** JSON-safe copy: errors as { name, message }, long strings cut to `limit`. */
export function jsonSafe(value, limit = Infinity) {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value, (key, v) => {
      if (v instanceof Error) return errorOf(v);
      if (typeof v === "bigint") return String(v);
      if (typeof v === "string" && v.length > limit) return `${v.slice(0, limit)}…(truncated ${v.length - limit} chars)`;
      return v;
    });
    return text === undefined ? null : JSON.parse(text);
  } catch (error) {
    return `[not serializable: ${error.message}]`;
  }
}

function checkKeys(where, object, allowed) {
  const unknown = Object.keys(object ?? {}).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${where}: unknown option ${unknown.join(", ")}; options: ${allowed.join(", ")}`);
}

/**
 * Run a flow to its end.
 *
 * Throws only `RunRefused`, and only before run.start -- a bad input or a
 * flow whose source has a problem found without running it. Everything after
 * that resolves, with the outcome in the result and in run.end.
 *
 * @param {string | object} target a flow module path, or a flow() value
 * @param {{ input?: object, timeout?: string | null, executor?: object, roster?: object, logDir?: string,
 *           cwd?: string, host?: string | null, caller?: string | null, gatePollMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, outcome: "done"|"stopped"|"failed"|"timeout", value: unknown, runId: string,
 *   events: string, cost: object | null, caveats: string[], durationMs: number,
 *   error: { name: string, message: string } | null, stop: { reason: string, phase: string | null } | null }>}
 */
export async function runFlow(target, options = {}) {
  checkKeys("runFlow", options, ["input", "timeout", "executor", "roster", "logDir", "cwd", "host", "caller", "gatePollMs"]);

  // --- Before anything is spent -----------------------------------------
  let loaded;
  try {
    loaded = await loadFlow(target);
  } catch (error) {
    // A malformed flow() or define() throws at import; so does a syntax error.
    throw new RunRefused(`cannot load ${typeof target === "string" ? target : "the flow"}: ${error.message}`);
  }
  const { flow: f, source, text } = loaded;
  const input = options.input ?? {};
  const inputProblems = validate(f.inputs, input);
  if (inputProblems.length > 0) throw new RunRefused(`flow "${f.name}": the input does not fit its inputs`, inputProblems);
  if (text !== null) {
    const found = scanSource(f, text);
    if (found.length > 0) throw new RunRefused(`flow "${f.name}": ${source}`, found);
  }
  let timeoutMs = null;
  if (options.timeout) {
    try {
      timeoutMs = parseDuration(options.timeout);
    } catch (error) {
      throw new RunRefused(`--timeout: ${error.message}`);
    }
  }
  let roster = options.roster;
  if (!roster) {
    try {
      roster = await loadRoster();
    } catch (error) {
      throw new RunRefused(`cannot load roles: ${error.message}`);
    }
  }
  const executor = options.executor ?? paseoExecutor({ host: options.host ?? null });
  const grants = [...DEFAULT_GRANTS, ...f.grants];
  const cwd = options.cwd ?? process.cwd();
  const host = options.host ?? null;
  const caller = options.caller !== undefined ? options.caller : (process.env.PASEO_AGENT_ID ?? null);
  const gatePollMs = options.gatePollMs ?? 10_000;

  const runId = randomUUID();
  const dir = options.logDir ?? configuredLogDir();
  const log = new EventLog({ dir, runId });
  const runDir = path.join(dir, "runs", runId);

  // --- Run state ----------------------------------------------------------
  const phaseScope = new AsyncLocalStorage();
  const currentPhase = () => phaseScope.getStore() ?? null;
  const declared = new Set(f.phases.map((p) => p.id));
  const openPhases = new Map();
  const open = new Map(); // callId -> { callId, labels, agentId, startedAt }
  const spent = new Map(); // agentId -> cost
  const caveats = [];
  let calls = 0;

  const caveat = (text, callId) => {
    if (caveats.includes(text)) return;
    caveats.push(text);
    log.emit("caveat", { callId, text });
  };

  const startCall = () => {
    const callId = `c${++calls}`;
    const record = { callId, labels: { "orch-run": runId, "orch-call": callId }, agentId: null, startedAt: Date.now() };
    open.set(callId, record);
    return record;
  };

  // Which agent a call ran as, and what it cost. `run --output-schema` does
  // not return an agent id, so an ask's agent is found by the labels it was
  // started with. A lookup that fails is recorded as unknown, not guessed.
  const settleAgent = async (record) => {
    const agentId = record.agentId ?? (await executor.findAgent(record.labels).catch(() => null));
    if (!agentId) return { agentId: null, cost: null };
    const detail = await executor.inspect(agentId).catch(() => null);
    return { agentId, cost: detail?.usage ? { usd: detail.usage.usd, inputTokens: detail.usage.inputTokens, outputTokens: detail.usage.outputTokens } : null };
  };

  const endCall = (record, { ok, output, error, agentId, cost }) => {
    // Already closed when the run ended with this call in flight.
    if (!open.delete(record.callId)) return;
    if (agentId) spent.set(agentId, cost);
    log.emit("call.end", {
      callId: record.callId,
      ok,
      durationMs: Date.now() - record.startedAt,
      output,
      error: error ? errorOf(error) : null,
      agentId,
      cost,
    });
  };

  const role = (name) => {
    const { instructions, ...bound } = bindRole(roster, { role: name });
    return bound;
  };

  // --- Primitives -------------------------------------------------------
  const $ = Object.freeze({
    /**
     * One agent call. Resolves to exactly what the step's schema declares.
     * Everything that can be wrong without an agent -- the step, the role,
     * the prompt's input, the fence -- throws before the call starts.
     */
    async ask(step, stepInput, callOptions = {}) {
      if (!isStep(step)) throw new TypeError("$.ask needs a step from define()");
      if (Object.hasOwn(callOptions ?? {}, "mode")) {
        throw new TypeError(`$.ask: mode is gone. The step declares effects ("${step.effects}"), and runtime/fences.mjs picks the mode`);
      }
      checkKeys(`$.ask(${step.name})`, callOptions, ["role", "provider", "thinking", "title", "cwd", "timeout"]);
      const bound = bindRole(roster, callOptions);
      const fence = fenceFor(bound.provider, step.effects);
      const prompt = composePrompt(bound, step.for(stepInput));
      const timeout = callOptions.timeout ?? step.timeout ?? DEFAULT_CALL_TIMEOUT;
      parseDuration(timeout);
      const title = sentTitle(callOptions.title ?? `[${step.name}]`);

      const record = startCall();
      log.emit("call.start", {
        callId: record.callId,
        type: "ask",
        name: step.name,
        title,
        phase: currentPhase(),
        role: bound.role,
        provider: bound.provider,
        thinking: bound.thinking,
        effects: step.effects,
        fence,
        prompt,
        schema: step.schema,
        schemaFingerprint: step.fingerprint,
        timeout,
      });
      if (!fence.enforced) caveat(`effects "${step.effects}" on ${bound.provider.split("/")[0]} is not enforced: ${fence.note}`, record.callId);

      let output = null;
      let failure = null;
      try {
        output = await executor.ask({
          provider: bound.provider,
          thinking: bound.thinking,
          mode: fence.mode,
          title,
          labels: { ...record.labels, "orch-step": step.name },
          prompt,
          schema: step.schema,
          timeout,
          cwd: callOptions.cwd ?? cwd,
        });
      } catch (error) {
        failure = error;
      }
      endCall(record, { ok: !failure, output, error: failure, ...(await settleAgent(record)) });
      if (failure) throw failure;
      return output;
    },

    /** The flow's own deterministic action: read, run a CLI, write. Returns fn's value. */
    async do(name, fn) {
      if (typeof name !== "string" || name.trim() === "") throw new TypeError("$.do needs a name");
      if (typeof fn !== "function") throw new TypeError(`$.do("${name}") needs a function`);
      const record = startCall();
      log.emit("call.start", { callId: record.callId, type: "do", name, title: name, phase: currentPhase() });
      try {
        const value = await fn();
        endCall(record, { ok: true, output: jsonSafe(value, DO_STRING_LIMIT), error: null, agentId: null, cost: null });
        return value;
      } catch (error) {
        endCall(record, { ok: false, output: null, error, agentId: null, cost: null });
        throw error;
      }
    },

    /**
     * Stop until a person decides. Resolves to the gate's decision whatever it
     * is -- check `approved` -- and throws only when the gate itself broke.
     */
    async gate(request) {
      checkKeys("$.gate", request, ["title", "content", "brief", "timeout", "holdPath"]);
      const { title, content, brief = "", timeout = "2h" } = request ?? {};
      if (typeof title !== "string" || title.trim() === "") throw new TypeError("$.gate needs a title");
      if (typeof content !== "string") throw new TypeError("$.gate: content must be a string");
      if (typeof brief !== "string") throw new TypeError("$.gate: brief must be a string");
      parseDuration(timeout);
      if (!grants.includes("gate:deny")) throw new GrantError("gate:deny", grants);
      const bound = bindRole(roster, { role: GATE_ROLE });
      const fence = fenceFor(bound.provider, "ask-human");

      const record = startCall();
      const holdPath = request.holdPath ?? path.join(runDir, "gate", `${record.callId}.txt`);
      log.emit("call.start", {
        callId: record.callId,
        type: "gate",
        name: "gate",
        title: sentTitle(title),
        phase: currentPhase(),
        brief,
        content,
        sha256: contentDigest(content),
        timeout,
        holdPath,
        provider: bound.provider,
        fence,
        prompt: composePrompt(bound, gatePrompt(holdPath, content, brief).prompt),
      });
      caveat("gate: Paseo does not record who answers a permission card, so an approval is recorded as unattributed", record.callId);

      const io = {
        spawn: async (prompt) => {
          const { agentId } = await executor.spawn({
            provider: bound.provider,
            thinking: bound.thinking,
            mode: fence.mode,
            title: sentTitle(`[gate] ${title}`),
            labels: { ...record.labels, "orch-step": "gate" },
            prompt: composePrompt(bound, prompt),
            cwd: path.dirname(holdPath),
          });
          record.agentId = agentId;
          return agentId;
        },
        inspect: (agentId) => executor.inspect(agentId),
        deny: (agentId, how) => executor.deny(agentId, how),
        stop: (agentId) => executor.stop(agentId),
        transcript: (agentId, how) => executor.transcript(agentId, how),
      };
      let decision;
      try {
        decision = await requestApproval(io, { holdPath, content, brief, timeout, pollMs: gatePollMs });
      } catch (error) {
        endCall(record, { ok: false, output: null, error, ...(await settleAgent(record)) });
        throw error;
      }
      endCall(record, { ok: true, output: decision, error: null, ...(await settleAgent(record)) });
      return decision;
    },

    /** Everything fn starts is inside phase `id`. Re-entering a phase is fine; so is running two at once. */
    async phase(id, fn) {
      if (!declared.has(id)) throw new TypeError(`$.phase("${id}") is not declared in the flow's phases`);
      if (typeof fn !== "function") throw new TypeError(`$.phase("${id}") needs a function`);
      log.emit("phase.start", { phase: id });
      openPhases.set(id, (openPhases.get(id) ?? 0) + 1);
      const end = (ok) => {
        const depth = openPhases.get(id) ?? 0;
        if (depth === 0) return; // closed when the run ended
        openPhases.set(id, depth - 1);
        log.emit("phase.end", { phase: id, ok });
      };
      try {
        const value = await phaseScope.run(id, fn);
        end(true);
        return value;
      } catch (error) {
        // $.stop is how a flow ends on purpose, not a failure of the phase.
        end(error instanceof StopSignal);
        throw error;
      }
    },

    /**
     * Run tasks together and wait for every one of them. Never rejects for a
     * failed task: each settles to { ok: true, value } or { ok: false, error },
     * so a failure cannot throw away another task's already-paid result (R6).
     * A $.stop inside any task still stops the flow, once all have settled.
     * Tasks are promises or functions returning one.
     */
    async all(tasks) {
      if (!Array.isArray(tasks)) throw new TypeError("$.all needs an array of promises or functions");
      const settled = await Promise.allSettled(tasks.map((task) => (typeof task === "function" ? (async () => task())() : task)));
      const stop = settled.find((s) => s.status === "rejected" && s.reason instanceof StopSignal);
      if (stop) throw stop.reason;
      return settled.map((s) => (s.status === "fulfilled" ? { ok: true, value: s.value } : { ok: false, error: s.reason }));
    },

    /** End the flow here, on purpose. Do not catch what this throws. */
    stop(reason, value = null) {
      if (typeof reason !== "string" || reason.trim() === "") throw new TypeError("$.stop needs a reason");
      throw new StopSignal(reason, value, currentPhase());
    },

    log: Object.freeze({
      info: (...args) => void log.emit("log", { level: "info", message: format(...args) }),
      warn: (...args) => void log.emit("log", { level: "warn", message: format(...args) }),
      error: (...args) => void log.emit("log", { level: "error", message: format(...args) }),
    }),

    /**
     * Read-only facts about this run. `runDir` is where this run's files may
     * go (`<logDir>/runs/<runId>/`); it is not created until something writes
     * there. `role(name)` resolves a role or throws -- a flow that takes a
     * role as input checks it here, before its first spend.
     */
    ctx: Object.freeze({ runId, caller, cwd, host, runDir, events: log.file, role }),
  });

  // --- Run and settle -----------------------------------------------------
  const startedAt = Date.now();
  log.emit("run.start", { flow: describeFlow(f), source, input, caller, cwd, host });

  let outcome;
  let value = null;
  let stop = null;
  let error = null;
  let timer = null;
  const running = Promise.resolve().then(() => f.run(input, $));
  // Past a timeout the flow keeps going in the background; its eventual
  // failure has nowhere to go and must not crash the process.
  running.catch(() => {});
  try {
    value = await (timeoutMs === null
      ? running
      : Promise.race([running, new Promise((_, reject) => (timer = setTimeout(() => reject(new RunTimeout(options.timeout)), timeoutMs)))]));
    outcome = "done";
  } catch (thrown) {
    if (thrown instanceof StopSignal) {
      outcome = "stopped";
      value = thrown.value;
      stop = { reason: thrown.reason, phase: thrown.phase };
    } else {
      outcome = thrown instanceof RunTimeout ? "timeout" : "failed";
      value = null;
      error = errorOf(thrown);
      if (thrown?.stack) log.emit("log", { level: "error", message: thrown.stack });
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Calls still in flight (a timeout, or a flow that threw without awaiting
  // everything it started) are closed here, so every call.start has its
  // call.end. Their agents are not stopped: whoever runs this decides.
  const unfinished = [...open.values()];
  for (const record of unfinished) {
    endCall(record, {
      ok: false,
      output: null,
      error: { name: "RunEnded", message: `the run ended (${outcome}) before this call finished` },
      ...(await settleAgent(record)),
    });
  }
  if (unfinished.length > 0) {
    log.emit("log", { level: "warn", message: `${unfinished.length} call(s) were still running when the run ended; their agents were left running` });
  }
  for (const [id, depth] of openPhases) {
    for (let i = 0; i < depth; i += 1) log.emit("phase.end", { phase: id, ok: false });
  }
  openPhases.clear();

  const cost =
    spent.size > 0
      ? { totalUsd: [...spent.values()].reduce((sum, c) => sum + (c?.usd ?? 0), 0), agentCount: spent.size, partial: COST_NOTE }
      : null;
  const durationMs = Date.now() - startedAt;
  log.emit("run.end", { outcome, value: jsonSafe(value), stop, error, durationMs, cost, caveats: [...caveats] });

  return {
    ok: outcome === "done" || outcome === "stopped",
    outcome,
    value,
    runId,
    events: log.file,
    cost,
    caveats: [...caveats],
    durationMs,
    error,
    stop,
  };
}
