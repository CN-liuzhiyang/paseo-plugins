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
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import { loadFlow, describeFlow, scanSource, DEFAULT_GRANTS } from "./flow.mjs";
import { isStep, validate, assertBuilderSchema } from "./step.mjs";
import { loadRoster, bindRole, composePrompt } from "./roster.mjs";
import { fenceFor } from "./fences.mjs";
import { EventLog, eventsFile } from "./events.mjs";
import { affairProblems } from "./affair.mjs";
import { affairKey, ensureWorkspace, normalizeDir, workspaceRefusal, workspaceTitle } from "./workspaces.mjs";
import { claimRun, ClaimTaken, runIdProblem } from "./claim.mjs";
import { checkResumePoint } from "./resume.mjs";
import { pointOf, pointProblems, PRINT_SHAPE } from "./resume-point.mjs";
import { paseoExecutor, sentTitle } from "./executor.mjs";
import { requestApproval, prepareGate, carrierKind, parseDuration, bytesDigest, INPUT_REDACTED } from "./gate.mjs";
import { logDir as configuredLogDir, resolveHost } from "./config.mjs";

/** The call timeout for a step that declares none. R7 says declare one. */
export const DEFAULT_CALL_TIMEOUT = "30m";
/**
 * The gate's carrier. Shipped as the orchestration-gate plugin's provider,
 * which needs no model; a private role file can point it at a cheap model
 * instead, which then Writes the receipt (gate.mjs).
 */
export const GATE_ROLE = "gate";
/** `do` outputs are the script's own values, often file contents; the event keeps a prefix. */
const DO_STRING_LIMIT = 2_000;
/**
 * When to look for an ask's agent while the call runs: `run --output-schema`
 * does not return its id, so it is found by label, in the background, a few
 * times at most. Milliseconds after the call starts, between attempts.
 */
const AGENT_PROBE_DELAYS = [3_000, 5_000, 10_000, 20_000, 40_000];
/** setTimeout's ceiling; past it Node fires after 1ms, which would time a run out at its first call. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** run.end.summary is one line for a result bar; longer is cut here, in characters (code points). */
export const SUMMARY_LIMIT = 200;
/** How long the runner waits for a closing gate to finish denying its card before it moves on. */
const GATE_CLOSE_WAIT_MS = 15_000;

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

/** One `$.gate` evidence entry: what the person can unfold above the card. */
const isEvidence = (e) =>
  e !== null &&
  typeof e === "object" &&
  typeof e.label === "string" &&
  e.label.trim() !== "" &&
  typeof e.text === "string" &&
  (e.kind === undefined || e.kind === "diff" || e.kind === "text") &&
  (e.name === undefined || typeof e.name === "string");

/**
 * A `$.gate` input: { label, secret?, pattern?, hint? }. `secret` defaults to true -- a value is kept out of
 * the run's records unless the flow says it need not be. `pattern` is a regular expression the whole value must
 * match; it must compile.
 */
function gateInputOf(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("$.gate: input must be { label, secret?, pattern?, hint? }");
  checkKeys("$.gate input", input, ["label", "secret", "pattern", "hint"]);
  const { label, secret = true, pattern = null, hint = "" } = input;
  if (typeof label !== "string" || label.trim() === "") throw new TypeError("$.gate: input.label must be a non-empty string");
  if (typeof secret !== "boolean") throw new TypeError("$.gate: input.secret must be a boolean");
  if (pattern !== null && typeof pattern !== "string") throw new TypeError("$.gate: input.pattern must be a string");
  if (typeof hint !== "string") throw new TypeError("$.gate: input.hint must be a string");
  if (pattern !== null) {
    try {
      new RegExp(`^(?:${pattern})$`);
    } catch (error) {
      throw new TypeError(`$.gate: input.pattern is not a regular expression: ${error.message}`);
    }
  }
  return { label: label.trim(), secret, pattern, hint: hint.replace(/\s+/g, " ").trim() };
}

class RunEnded extends Error {
  constructor() {
    super("the run has ended; no new calls or phases");
    this.name = "RunEnded";
  }
}

class RunTimeout extends Error {
  constructor(limit) {
    super(`the run exceeded its ${limit} limit`);
    this.name = "RunTimeout";
  }
}

const errorOf = (error) => ({ name: error?.name ?? "Error", message: error?.message ?? String(error) });

/**
 * JSON-safe copy: errors as { name, message }, bigints as text. `redact` (the run's secret scrub) is applied to the
 * whole copy, and only then are strings cut to `limit`: a cut made first could leave half a secret that no longer
 * matches it.
 */
export function jsonSafe(value, limit = Infinity, redact = null) {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value, (key, v) => {
      if (v instanceof Error) return errorOf(v);
      if (typeof v === "bigint") return String(v);
      return v;
    });
    let plain = text === undefined ? null : JSON.parse(text);
    if (redact) plain = redact(plain);
    return Number.isFinite(limit) ? cutStrings(plain, limit) : plain;
  } catch (error) {
    return `[not serializable: ${error.message}]`;
  }
}

function cutStrings(node, limit) {
  if (typeof node === "string") return node.length > limit ? `${node.slice(0, limit)}…(truncated ${node.length - limit} chars)` : node;
  if (Array.isArray(node)) return node.map((item) => cutStrings(item, limit));
  if (node !== null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, cutStrings(item, limit)]));
  return node;
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether a step's schema is made of the builders, so `validate` understands all of it. */
function builderSchema(step) {
  try {
    assertBuilderSchema(step.schema, step.name);
    return true;
  } catch {
    return false;
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
 * The run takes its id first (claim.mjs), before anything slow: with `runId`
 * the caller's own id, otherwise a fresh one. An id that is already claimed, or
 * already has events, is refused and nothing is spent. `affair` is what the run
 * is for, recorded as run.start.affair (affair.mjs); the agents and gate cards of
 * the runs for one affair share a Paseo workspace per directory (workspaces.mjs). `resumeOf` is the run this one
 * carries on (resume.mjs, `orch.mjs resume`), recorded as run.start.resumeOf.
 *
 * @param {string | object} target a flow module path, or a flow() value
 * @param {{ input?: object, timeout?: string | null, executor?: object, roster?: object, logDir?: string,
 *           cwd?: string, host?: string | null, caller?: string | null, gatePollMs?: number,
 *           agentProbeDelays?: number[], runId?: string, affair?: object | null, resumeOf?: string | null, resumePrint?: string | null,
 *           workspaceLock?: { waitMs?: number, staleMs?: number, pollMs?: number },
 *           taken?: ReturnType<typeof takeRunId> }} [options]
 * @returns {Promise<{ ok: boolean, outcome: "done"|"stopped"|"failed"|"timeout", value: unknown, summary: string | null, runId: string,
 *   events: string, cost: object | null, caveats: string[], durationMs: number,
 *   error: { name: string, message: string } | null, stop: { reason: string, phase: string | null } | null,
 *   resume: { flow: string, input: object, from: string, spends: "nothing" | "maybe" } | null }>}
 */
export async function runFlow(target, options = {}) {
  checkKeys("runFlow", options, ["input", "timeout", "executor", "roster", "logDir", "cwd", "host", "caller", "gatePollMs", "agentProbeDelays", "runId", "affair", "resumeOf", "resumePrint", "taken", "workspaceLock"]);

  // --- The id, before anything slow ---------------------------------------
  // A caller that must hold the id sooner (orch.mjs, while it reads the flow's
  // inputs) takes it with takeRunId and hands it in.
  const taken = options.taken ?? takeRunId(options);
  try {
    return await runClaimed(target, options, taken);
  } catch (error) {
    settleRefusal(taken, error);
    throw error;
  } finally {
    taken.claim.stop();
  }
}

/**
 * Take the run's id: the caller's `runId`, or a fresh one. Every run holds a
 * claim, a caller-given id or not: one way to tell a run is alive (a claim
 * touched lately), instead of two. Throws RunRefused when the id is malformed,
 * already has events, or is already claimed.
 *
 * @param {{ runId?: string, logDir?: string }} [options]
 */
export function takeRunId({ runId, logDir } = {}) {
  if (runId !== undefined) {
    const problem = runIdProblem(runId);
    if (problem) throw new RunRefused(`--run-id: ${problem}`);
  }
  const id = runId ?? randomUUID();
  const dir = logDir ?? configuredLogDir();
  // Checked before the claim so that a refusal here leaves nothing behind: the id was never taken.
  if (existsSync(eventsFile(dir, id))) throw new RunRefused(`run id ${id} already has events; a run id is used once`);
  let claim;
  try {
    claim = claimRun({ dir, runId: id });
  } catch (error) {
    if (error instanceof ClaimTaken) throw new RunRefused(error.message);
    throw error;
  }
  return { runId: id, dir, claim, callerGiven: runId !== undefined };
}

/**
 * A run that ends before run.start. A caller who gave the id may look for the
 * reason later, not holding this process, so it stays with the claim; a
 * generated id is nobody's to look up, so no file is left.
 */
export function settleRefusal({ runId, dir, claim, callerGiven }, error) {
  if (existsSync(eventsFile(dir, runId))) return;
  if (callerGiven) claim.refuse(`${error?.name ?? "Error"}: ${error?.message ?? error}`);
  else claim.discard();
}

async function runClaimed(target, options, { runId, dir, claim }) {
  // --- Before anything is spent -----------------------------------------
  const affair = options.affair ?? null;
  const badAffair = affairProblems(affair);
  if (badAffair.length > 0) throw new RunRefused("--affair does not fit", badAffair);
  const resumeOf = options.resumeOf ?? null;
  if (resumeOf !== null) {
    const problem = runIdProblem(resumeOf);
    if (problem) throw new RunRefused(`resumeOf: ${problem}`);
  }
  const resumePrint = options.resumePrint ?? null;
  if (resumePrint !== null && !(resumeOf !== null && PRINT_SHAPE.test(resumePrint))) throw new RunRefused("resumePrint is a fingerprint of the point a run that carries on another started from");
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
    if (timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new RunRefused(`--timeout: ${options.timeout} is out of range (1s to 596h)`);
  }
  // What the run records is the name; what Paseo connects to may be a credential.
  let remote = null;
  if (options.host) {
    try {
      remote = resolveHost(options.host);
    } catch (error) {
      throw new RunRefused(error.message);
    }
  }
  const host = remote?.label ?? null;
  if (host) {
    // This process's directory is a path on this machine; another host's
    // agents need one on theirs.
    if (!options.cwd) throw new RunRefused(`a run on another host (${host}) needs cwd: a directory on that host`);
    // The gate's receipt and hold file are paths this process reads; a
    // carrier on another host would write them there.
    if (f.grants.includes("gate:deny")) throw new RunRefused(`flow "${f.name}" can gate, and a gate on another host (${host}) is not supported yet`);
  }
  let roster = options.roster;
  if (!roster) {
    try {
      roster = await loadRoster();
    } catch (error) {
      throw new RunRefused(`cannot load roles: ${error.message}`);
    }
  }
  const executor = options.executor ?? paseoExecutor({ host: remote?.endpoint ?? null });
  const grants = [...DEFAULT_GRANTS, ...f.grants];
  // A flow that can gate needs its carrier before the first spend: finding out
  // at the gate would throw away every paid step before it.
  if (grants.includes("gate:deny")) {
    let bound;
    try {
      bound = bindRole(roster, { role: GATE_ROLE });
      fenceFor(bound.provider, "ask-human");
    } catch (error) {
      throw new RunRefused(`flow "${f.name}" can gate, but its carrier cannot run: ${error.message}`);
    }
    if (carrierKind(bound.provider) === "provider") {
      const family = bound.provider.split("/")[0];
      if (typeof executor.providerAvailable !== "function") throw new RunRefused("the executor cannot say which providers are available");
      const available = await executor.providerAvailable(family).catch((error) => {
        throw new RunRefused(`cannot check that the gate's provider "${family}" is available: ${error.message}`);
      });
      if (!available) {
        throw new RunRefused(
          `flow "${f.name}" can gate, but Paseo has no available provider "${family}" (role "${GATE_ROLE}" is ${bound.provider}). ` +
            `Install and enable the orchestration-gate plugin, or point role "${GATE_ROLE}" at a model (roles/${GATE_ROLE}.md in a rolesDirs entry).`,
        );
      }
    }
  }
  const cwd = options.cwd ?? process.cwd();
  const caller = options.caller !== undefined ? options.caller : (process.env.PASEO_AGENT_ID ?? null);
  const gatePollMs = options.gatePollMs ?? 10_000;
  const agentProbeDelays = options.agentProbeDelays ?? AGENT_PROBE_DELAYS;

  const log = new EventLog({ dir, runId });
  // A heartbeat that cannot touch the claim makes this run look dead to a reader that goes by it.
  claim.onError = (error) => log.emit("log", { level: "warn", message: `the run's claim could not be touched, so readers will take the run for dead: ${error.message}` });
  // (claim.mjs ignores a handler that throws, as log.emit does when the disk is the problem.)
  const runDir = path.join(dir, "runs", runId);

  // --- Run state ----------------------------------------------------------
  const phaseScope = new AsyncLocalStorage();
  const currentPhase = () => phaseScope.getStore() ?? null;
  const declared = new Set(f.phases.map((p) => p.id));
  const openPhases = new Map();
  const open = new Map(); // callId -> { callId, labels, agentId, startedAt }
  const spent = new Map(); // agentId -> cost
  const caveats = [];
  // Receipt paths of the gates started in this run, resolved.
  const gateHolds = new Set();
  // Gates waiting on a person right now, and the files an input gate's value may be left in.
  const openGates = new Set();
  const inputFiles = new Set();
  const sweepInputs = () => {
    for (const file of inputFiles) rmSync(file, { force: true });
  };
  const safe = (value, limit) => jsonSafe(value, limit, (v) => log.scrub(v));
  let calls = 0;
  // Set the moment the flow's outcome is decided: when it returns, throws or
  // times out, or when it first calls $.stop. Code still running after that
  // (past a timeout, an unawaited branch, a flow that caught its own stop)
  // may not start a call or a phase -- nothing new is spent or recorded.
  let ending = false;
  // The first $.stop, recorded when it is called rather than when it reaches
  // the runner: a flow that catches it still ends as stopped.
  let stopped = null;
  // What the flow last said about carrying this run on (`$.resumeWith`): a resume point, or null. Declarations are
  // looked into one after another in the order they were made (the flow need not await them), and the run does not end
  // before the last one has been looked into.
  let resumePoint = null;
  let resumeChain = Promise.resolve();

  // The affair's workspace, per directory, found or made the first time a call
  // needs it (a run that never calls an agent makes none). Resolves to the
  // workspace id, or null: whatever goes wrong is a caveat and the call goes
  // on as it did before workspaces were shared, never a failed run.
  // Keyed by the directory as the file system compares it (normalizeDir), the same spelling the registry is named by.
  const affairWorkspaces = new Map(); // normalized cwd -> Promise<string | null>
  const key = affairKey(affair);
  // Set when Paseo says its CLI does not know --workspace: nothing later asks it to.
  let workspaceFlagRefused = false;
  const resolveWorkspace = async (callCwd) => {
    if (workspaceFlagRefused) return null;
    if (host) {
      caveat(`affair: the agents of a run on another host (${host}) are not put in a shared workspace`, null);
      return null;
    }
    if (key === null) {
      caveat("affair: it has no key, link or url, so there is nothing to tell its runs apart by and no shared workspace", null);
      return null;
    }
    if (typeof executor.listWorkspaces !== "function" || typeof executor.createWorkspace !== "function") {
      caveat("affair: the executor cannot list or make workspaces, so the agents are not put in a shared one", null);
      return null;
    }
    // Made once: this exact text is what Paseo is sent, what the event says and what the registry keeps.
    const title = workspaceTitle(affair.label, callCwd, cwd);
    try {
      const found = await ensureWorkspace({ dir, key, cwd: callCwd, title, runId, executor, lock: options.workspaceLock });
      log.emit("workspace", { workspaceId: found.workspaceId, cwd: callCwd, title, key, created: found.created });
      if (found.unreadable) caveat(`affair: the registry file for this affair could not be read (${found.unreadable}), so a workspace made for it earlier may not have been found`, null);
      if (found.unrecorded) caveat(`affair: the workspace was made but not recorded (${found.unrecorded}), so the next run of this affair will make another`, null);
      return found.workspaceId;
    } catch (error) {
      caveat(`affair: no shared workspace (${error?.message ?? error}); the agents are where Paseo puts them by default`, null);
      return null;
    }
  };
  const workspaceFor = (callCwd) => {
    const at = normalizeDir(callCwd);
    if (!affairWorkspaces.has(at)) affairWorkspaces.set(at, resolveWorkspace(callCwd));
    return affairWorkspaces.get(at);
  };

  // Start an agent in the workspace `used` resolved to. If Paseo refuses the workspace before it
  // makes the agent (workspaceRefusal says when that is certain: the workspace was archived since,
  // or this CLI is too old for --workspace), nothing was started or spent, so the start is made once
  // more with whatever resolving again gives -- a workspace made anew, or none. Any other failure is
  // the call's own and is not repeated: an agent that began has spent something.
  const startIn = async (callCwd, used, workspace, start) => {
    try {
      return await start(workspace ?? undefined);
    } catch (error) {
      const refusal = workspace ? workspaceRefusal(error) : null;
      if (!refusal) throw error;
      caveat(
        `affair: Paseo refused workspace ${workspace} before it started the agent (${refusal === "flag" ? "this CLI does not know --workspace" : "the workspace is gone"}); ` +
          `the start was made once more ${refusal === "flag" ? "without one" : "in the workspace found or made again, or without one"}`,
        null,
      );
      if (refusal === "flag") workspaceFlagRefused = true;
      // Only the answer that was refused is dropped: another call may have replaced it already.
      if (affairWorkspaces.get(normalizeDir(callCwd)) === used) affairWorkspaces.delete(normalizeDir(callCwd));
      const next = refusal === "flag" ? null : await workspaceFor(callCwd);
      return start(next && next !== workspace ? next : undefined);
    }
  };

  const caveat = (text, callId) => {
    if (caveats.includes(text)) return;
    caveats.push(text);
    log.emit("caveat", { callId, text });
  };

  const startCall = () => {
    if (ending) throw new RunEnded();
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

  // A call's agent, announced once, while the call is still open, so a
  // reader can open it before the call ends.
  const announceAgent = (record, agentId) => {
    if (record.announced || !agentId || !open.has(record.callId)) return;
    record.announced = true;
    record.agentId = agentId;
    log.emit("call.agent", { callId: record.callId, agentId });
  };

  // Look for an ask's agent by label in the background. A lookup that fails
  // or finds nothing is tried again later, a bounded number of times; none
  // of it touches the call itself.
  const probeAgent = (record, attempt = 0) => {
    if (attempt >= agentProbeDelays.length) return;
    const timer = setTimeout(async () => {
      if (record.announced || !open.has(record.callId)) return;
      const agentId = await executor.findAgent(record.labels).catch(() => null);
      if (agentId) announceAgent(record, agentId);
      else probeAgent(record, attempt + 1);
    }, agentProbeDelays[attempt]);
    timer.unref?.();
  };

  // The agent of an ask that came out well, archived (`archive: "after"`): what it was given and what it handed back are in the events,
  // so the agent itself is not a place anyone needs to open. It never makes the run fail: an agent that cannot be found, or that is
  // still running (the CLI refuses that without --force, and --force would interrupt it), is left as it is, with a caveat saying so.
  // Every try is written as a `call.archive` event, done or not, so that whoever started the run can tell from the events which agents
  // are still to be archived (a plugin can archive one the CLI cannot, EVENTS.md) without reading the caveat's words.
  const archiveAfter = async (record, agentId) => {
    const written = (ok, code, message) =>
      log.emit("call.archive", { callId: record.callId, agentId: agentId || null, ok, code, message: message === null ? null : message.replace(/\s+/g, " ").slice(0, 200) });
    if (!agentId) {
      caveat(`archive: the agent of ${record.callId} could not be found, so it was not archived`, record.callId);
      written(false, "NO_AGENT", null);
      return;
    }
    if (typeof executor.archiveAgent !== "function") {
      caveat("archive: the executor cannot archive an agent, so the agents asked to be archived are left as they are", record.callId);
      written(false, "NO_ARCHIVE", null);
      return;
    }
    try {
      await executor.archiveAgent(agentId);
      written(true, null, null);
    } catch (error) {
      const raw = String(error?.stderr?.trim() || error?.stdout?.trim() || error?.message || error);
      let code = "";
      let said = raw;
      try {
        // The CLI says why as JSON: { error: { code, message } }.
        const parsed = JSON.parse(raw.slice(raw.indexOf("{")));
        code = String(parsed?.error?.code ?? "");
        said = String(parsed?.error?.message ?? raw);
      } catch {
        // Not JSON: as it came.
      }
      // Measured 2026-10-29 (fork CLI 1.4.1): `paseo archive` looks the agent up in a list that leaves out the agents of a background
      // workspace, and the affair's workspace is one: it says the agent is not found when it is there. Said so, that it is no mystery,
      // and that it is not left to nobody: the plugin that started the run archives it (it reads call.archive for the ones not done).
      const hint =
        code === "AGENT_NOT_FOUND"
          ? "; the agent exists, but this CLI's archive does not list the agents of a background workspace, so it cannot find it: it is left to the plugin that started the run to archive (call.archive says it was not done)"
          : "";
      caveat(`archive: agent ${agentId} of ${record.callId} was not archived (${said.replace(/\s+/g, " ").slice(0, 200)})${hint}`, record.callId);
      written(false, code || "ERROR", said);
    }
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

  // One `$.resumeWith`, looked at. Never rejects: whatever goes wrong with a declaration is a warning, not a run that fails.
  const declareResume = async (point) => {
    try {
      if (point === null) {
        resumePoint = null;
        log.emit("resume", { cleared: true });
        return;
      }
      // The input as the events will hold it: JSON, and with whatever the run keeps secret already taken out.
      const plain = isPlainObject(point) ? { ...point, input: jsonSafe(point.input) } : point;
      const problems = pointProblems(plain);
      if (problems.length === 0 && JSON.stringify(log.scrub(plain)) !== JSON.stringify(plain)) {
        problems.push("the input holds a value this run keeps secret, which would be written as <已用> and the run could not be started from it; leave such values out of a resume input");
      }
      if (problems.length === 0) problems.push(...(await checkResumePoint(plain)));
      if (problems.length > 0) {
        log.emit("log", { level: "warn", message: `$.resumeWith: not recorded, ${problems.join("; ")}` });
        caveat(`resume: a resume point the flow declared was not recorded (${problems.join("; ").slice(0, 300)}), so the run may have none to be carried on from`, null);
        return;
      }
      resumePoint = pointOf(plain);
      log.emit("resume", resumePoint);
    } catch (error) {
      log.emit("log", { level: "warn", message: `$.resumeWith: not recorded, ${describeThrown(error)}` });
    }
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
      checkKeys(`$.ask(${step.name})`, callOptions, ["role", "provider", "thinking", "title", "cwd", "timeout", "archive"]);
      if (callOptions.archive !== undefined && callOptions.archive !== "after") {
        throw new TypeError(`$.ask(${step.name}): archive can only be "after" (archive the agent once the call has handed in its answer), not ${JSON.stringify(callOptions.archive)}`);
      }
      const bound = bindRole(roster, callOptions);
      const fence = fenceFor(bound.provider, step.effects);
      const prompt = composePrompt(bound, step.for(stepInput));
      const timeout = callOptions.timeout ?? step.timeout ?? DEFAULT_CALL_TIMEOUT;
      parseDuration(timeout);
      // The call's own title, then the step's, then its name: one value for
      // the events and for the agent on Paseo.
      const title = sentTitle(callOptions.title ?? step.title ?? `[${step.name}]`);
      const callCwd = callOptions.cwd ?? cwd;
      // Before the call exists: a wait for another run's workspace is not part of this call's time.
      // Without an affair nothing is awaited here, so such a run goes through exactly the steps it always did.
      const used = affair ? workspaceFor(callCwd) : null;
      const workspace = used ? await used : null;

      const record = startCall();
      log.emit("call.start", {
        callId: record.callId,
        type: "ask",
        name: step.name,
        title,
        headline: step.headline,
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
        archive: callOptions.archive ?? null,
      });
      if (!fence.enforced) caveat(`effects "${step.effects}" on ${bound.provider.split("/")[0]} is not enforced: ${fence.note}`, record.callId);
      probeAgent(record);

      let output = null;
      let failure = null;
      try {
        output = await startIn(callCwd, used, workspace, (inWorkspace) =>
          executor.ask({
            provider: bound.provider,
            thinking: bound.thinking,
            mode: fence.mode,
            title,
            labels: { ...record.labels, "orch-step": step.name },
            prompt,
            schema: step.schema,
            timeout,
            cwd: callCwd,
            workspace: inWorkspace,
          }),
        );
        // Paseo enforces the schema; this catches what reaches the flow anyway
        // (an empty stdout parses to null). The answer stays in call.end.
        const problems = builderSchema(step) ? validate(step.schema, output, step.name) : isPlainObject(output) ? [] : [`${step.name}: not an object`];
        if (problems.length > 0) failure = Object.assign(new Error(`the answer does not fit the step's schema: ${problems.join("; ")}`), { name: "OutputMismatch" });
      } catch (error) {
        failure = error;
      }
      const settled = await settleAgent(record);
      endCall(record, { ok: !failure, output: safe(output), error: failure, ...settled });
      if (failure) throw failure;
      // Only a call that came out well, and only when the flow asked for it: a call that failed keeps its agent to be looked into.
      if (callOptions.archive === "after") await archiveAfter(record, settled.agentId);
      return output;
    },

    /** The flow's own deterministic action: read, run a CLI, write. Returns fn's value. */
    async do(name, fn, doOptions = {}) {
      if (typeof name !== "string" || name.trim() === "") throw new TypeError("$.do needs a name");
      if (typeof fn !== "function") throw new TypeError(`$.do("${name}") needs a function`);
      checkKeys(`$.do("${name}")`, doOptions, ["title"]);
      const { title = name } = doOptions ?? {};
      if (typeof title !== "string" || title.trim() === "") throw new TypeError(`$.do("${name}"): title must be a non-empty string`);
      const record = startCall();
      log.emit("call.start", { callId: record.callId, type: "do", name, title, phase: currentPhase() });
      try {
        const value = await fn();
        endCall(record, { ok: true, output: safe(value, DO_STRING_LIMIT), error: null, agentId: null, cost: null });
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
      checkKeys("$.gate", request, ["title", "content", "name", "summary", "brief", "evidence", "timeout", "holdPath", "input"]);
      const { title, content, name = "content.txt", summary = "", brief = "", evidence = [], timeout = "2h" } = request ?? {};
      const input = request.input === undefined ? null : gateInputOf(request.input);
      if (typeof title !== "string" || title.trim() === "") throw new TypeError("$.gate needs a title");
      if (typeof content !== "string") throw new TypeError("$.gate: content must be a string");
      for (const [key, value] of Object.entries({ name, summary, brief })) {
        if (typeof value !== "string") throw new TypeError(`$.gate: ${key} must be a string`);
      }
      if (!Array.isArray(evidence) || !evidence.every(isEvidence)) {
        throw new TypeError('$.gate: evidence must be a list of { label, text, kind?: "diff" | "text", name? }');
      }
      parseDuration(timeout);
      // The provider writes only a *.receipt.txt next to its request (orchestration-gate request.ts).
      if (request.holdPath !== undefined && (typeof request.holdPath !== "string" || !request.holdPath.endsWith(".receipt.txt"))) {
        throw new TypeError("$.gate: holdPath must be a path ending in .receipt.txt");
      }
      if (!grants.includes("gate:deny")) throw new GrantError("gate:deny", grants);
      const bound = bindRole(roster, { role: GATE_ROLE });
      const fence = fenceFor(bound.provider, "ask-human");
      const carrier = carrierKind(bound.provider);
      if (input && carrier !== "provider") {
        throw new TypeError(`$.gate: a gate that asks for a value needs the orch-gate provider as its carrier, but role "${GATE_ROLE}" is ${bound.provider}`);
      }
      // The provider's card needs nothing of its directory (its prompt gives absolute paths), so it goes
      // with the run's own agents. A model carrier writes the receipt itself and stays where it was.
      // Resolved before the receipt path is looked at and claimed, not between the two: the wait would
      // let a parallel gate with the same path through the look. (No affair: nothing is awaited.)
      const used = affair && carrier === "provider" ? workspaceFor(cwd) : null;
      const workspace = used ? await used : null;

      // Two gates on one receipt path would remove each other's receipt (each starts by clearing its own).
      if (request.holdPath !== undefined && gateHolds.has(path.resolve(request.holdPath))) {
        throw new TypeError(`$.gate: holdPath ${request.holdPath} is already another gate's in this run`);
      }
      // One line: it heads the provider's three-line prompt, and a line break in it could pass for a pointer.
      const oneLineTitle = sentTitle(title.replace(/\s+/g, " ").trim());

      const record = startCall();
      const holdPath = request.holdPath ?? path.join(runDir, "gate", `${record.callId}.receipt.txt`);
      gateHolds.add(path.resolve(holdPath));
      const prepared = prepareGate({
        carrier,
        holdPath,
        title: oneLineTitle,
        content,
        name,
        summary,
        brief,
        evidence,
        timeout,
        runId,
        callId: record.callId,
        input,
      });
      log.emit("call.start", {
        callId: record.callId,
        type: "gate",
        name: "gate",
        title: oneLineTitle,
        phase: currentPhase(),
        brief,
        content,
        sha256: prepared.digest,
        bytesSha256: bytesDigest(content),
        timeout,
        holdPath,
        provider: bound.provider,
        fence,
        prompt: composePrompt(bound, prepared.prompt),
        carrier,
        contentName: name,
        summary,
        evidence,
        receipt: prepared.receipt,
        requestPath: prepared.requestPath,
        ...(input ? { input } : {}),
      });
      if (input) {
        caveat(
          "gate input: the value is typed into a Paseo card, so Paseo's own record of that answer may hold it. " +
            (input.secret
              ? "The run's events, return value, errors, summary and terminal output are scrubbed of the value as given " +
                "(and of a few exact re-spellings: digits as a number, hex, base64), but a flow that transforms it " +
                "(another case, a part, split, hashed, other encodings) is not covered, and what the flow itself writes elsewhere is not either"
              : "secret: false: the value is in the call's output"),
          record.callId,
        );
      }
      caveat(
        "gate: Paseo does not record who answers a permission card; answeredVia is what the answering client sent " +
          "(a card button id or none), a weak signal, and any local process can send either",
        record.callId,
      );

      const io = {
        spawn: async (prompt) => {
          const { agentId } = await startIn(cwd, used, workspace, (inWorkspace) =>
            executor.spawn({
              provider: bound.provider,
              thinking: bound.thinking,
              mode: fence.mode,
              title: sentTitle(`[gate] ${oneLineTitle}`),
              labels: { ...record.labels, "orch-step": "gate" },
              prompt: composePrompt(bound, prompt),
              cwd: path.dirname(holdPath),
              workspace: inWorkspace,
            }),
          );
          announceAgent(record, agentId);
          return agentId;
        },
        inspect: (agentId) => executor.inspect(agentId),
        deny: (agentId, how) => executor.deny(agentId, how),
        stop: (agentId) => executor.stop(agentId),
        transcript: (agentId, how) => executor.transcript(agentId, how),
      };
      // The run can end under this gate (total timeout, a stop, a failure): `controller` closes the card then,
      // and `done` is what the runner waits on before it settles.
      const controller = new AbortController();
      let finished;
      const entry = { controller, done: new Promise((resolve) => (finished = resolve)) };
      openGates.add(entry);
      if (prepared.inputPath) {
        inputFiles.add(prepared.inputPath);
        if (!process.listeners("exit").includes(sweepInputs)) process.once("exit", sweepInputs);
      }
      try {
        let decision;
        try {
          decision = await requestApproval(io, prepared, { pollMs: gatePollMs, signal: controller.signal });
        } catch (error) {
          endCall(record, { ok: false, output: null, error, ...(await settleAgent(record)) });
          throw error;
        }
        // The flow gets the value; the record gets a stand-in when it is a secret, and from here on
        // nothing the run writes may carry it (EventLog scrubs it wherever it turns up).
        if (typeof decision.input === "string" && input?.secret) log.addSecret(decision.input);
        const recorded = typeof decision.input === "string" && input?.secret ? { ...decision, input: INPUT_REDACTED } : decision;
        endCall(record, { ok: true, output: recorded, error: null, ...(await settleAgent(record)) });
        return decision;
      } finally {
        openGates.delete(entry);
        finished();
      }
    },

    /** Everything fn starts is inside phase `id`. Re-entering a phase is fine; so is running two at once. */
    async phase(id, fn) {
      if (!declared.has(id)) throw new TypeError(`$.phase("${id}") is not declared in the flow's phases`);
      if (typeof fn !== "function") throw new TypeError(`$.phase("${id}") needs a function`);
      if (ending) throw new RunEnded();
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
        // $.stop is how a flow ends on purpose, not a failure of the phase;
        // neither is a RunEnded that the stop caused.
        end(error instanceof StopSignal || (stopped !== null && error instanceof RunEnded));
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

    /**
     * End the flow here, on purpose. The stop is recorded now, the first one
     * wins, and from here no call or phase can start: catching what this
     * throws does not undo it, and the run ends as stopped whatever the flow
     * does next. Called after the outcome is already decided, it records nothing.
     */
    stop(reason, value = null) {
      if (typeof reason !== "string" || reason.trim() === "") throw new TypeError("$.stop needs a reason");
      const signal = new StopSignal(reason, value, currentPhase());
      if (!ending) {
        stopped = signal;
        ending = true;
      }
      throw signal;
    },

    /**
     * Say how this run could be carried on if it does not come to an end: another flow, or this one again, with an input
     * that says where to pick up, a line for the person who will see it, and whether a model may be called (resume.mjs,
     * CONVENTIONS.md "接着跑"). Called as often as the flow likes, the last one wins, `null` takes it back. It is looked at
     * when it is made: the flow must be one this machine can find by name and the input must fit it. One that does not fit
     * is written as a warning and a caveat and is not recorded -- it never fails the run, which may well be a good one --
     * and the one before it stands. A run that comes to `done` records none: there is nothing left to carry on.
     */
    async resumeWith(point) {
      if (ending) throw new RunEnded();
      const declared = resumeChain.then(() => declareResume(point));
      resumeChain = declared;
      await declared;
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
  // pid and hostname let a reader on the same machine ask whether the run is
  // still alive instead of guessing from the time of the last event.
  log.emit("run.start", { flow: describeFlow(f), source, input, caller, cwd, host, pid: process.pid, hostname: os.hostname(), affair, resumeOf, resumePrint });

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
  ending = true;
  // A recorded stop decides the outcome, whether or not the flow caught it
  // and whatever it returned or threw afterwards.
  if (stopped) {
    outcome = "stopped";
    value = stopped.value;
    stop = { reason: stopped.reason, phase: stopped.phase };
    error = null;
  }

  // A gate still waiting on a person is closed first: its card is denied and nothing it is answered with from
  // here on reaches the flow, which keeps running past a timeout. Then whatever an approval left on disk is swept
  // (the provider may have taken an allow a moment before the deny), here and again if the process exits.
  if (openGates.size > 0) {
    const gates = [...openGates];
    for (const gate of gates) gate.controller.abort(outcome);
    let giveUp;
    await Promise.race([Promise.all(gates.map((gate) => gate.done)), new Promise((resolve) => (giveUp = setTimeout(resolve, GATE_CLOSE_WAIT_MS)))]);
    clearTimeout(giveUp);
  }
  sweepInputs();
  // The last word on how the run could be carried on is in before it ends.
  await resumeChain;

  // Calls still in flight (a timeout, or a flow that threw without awaiting
  // everything it started) are closed here, so every call.start has its
  // call.end. Their agents are not stopped: whoever runs this decides.
  let unfinished = 0;
  while (open.size > 0) {
    const record = open.values().next().value;
    unfinished += 1;
    endCall(record, {
      ok: false,
      output: null,
      error: { name: "RunEnded", message: `the run ended (${outcome}) before this call finished` },
      ...(await settleAgent(record)),
    });
  }
  if (unfinished > 0) {
    log.emit("log", { level: "warn", message: `${unfinished} call(s) were still running when the run ended; their agents were left running` });
  }
  for (const [id, depth] of openPhases) {
    for (let i = 0; i < depth; i += 1) log.emit("phase.end", { phase: id, ok: false });
  }
  openPhases.clear();

  const cost =
    spent.size > 0
      ? { totalUsd: [...spent.values()].reduce((sum, c) => sum + (c?.usd ?? 0), 0), agentCount: spent.size, partial: COST_NOTE }
      : null;
  const recorded = safe(value);
  const summary = outcome === "done" || outcome === "stopped" ? summarizeRun(f, recorded, outcome, log) : null;
  const durationMs = Date.now() - startedAt;
  // What goes back to the caller as text -- the error, the stop, the summary -- is what the events say.
  error = log.scrub(error);
  stop = log.scrub(stop);
  // A run that came to its end has nothing to carry on. A point that a secret learned after it was declared has reached is not
  // one a run could start from: left out, and said.
  let resume = outcome === "done" ? null : resumePoint;
  if (resume !== null && JSON.stringify(log.scrub(resume)) !== JSON.stringify(resume)) {
    caveat("resume: the resume point holds a value this run came to keep secret, so it is not recorded and the run cannot be carried on", null);
    resume = null;
  }
  log.emit("run.end", { outcome, value: recorded, summary, stop, error, durationMs, cost, caveats: [...caveats], resume });
  process.removeListener("exit", sweepInputs);

  const result = {
    ok: outcome === "done" || outcome === "stopped",
    outcome,
    value,
    summary,
    runId,
    events: log.file,
    cost,
    caveats: [...caveats],
    durationMs,
    error,
    stop,
    resume,
  };
  // How the terminal scrubs the whole result as the events were (orch.mjs `printable`). Not enumerable: it is
  // a function, and a result that is serialized must not carry it.
  Object.defineProperty(result, "redact", { value: (v) => log.scrub(v), enumerable: false });
  return result;
}

/**
 * The flow's one line about how its run came out, or null. It sees the value
 * as run.end records it, so the line never says more than the record. Nothing
 * it does can change the outcome or keep run.end from being written: a throw,
 * or anything but a string, is a warning and a null. It is called without
 * waiting, so a promise counts as not a string rather than holding the run open.
 */
function summarizeRun(f, value, outcome, log) {
  if (!f.summarize) return null;
  let line;
  try {
    line = f.summarize(value, { outcome });
    // Inside the try: looking at what came back runs its code too (a getter, a proxy).
    if (typeof line !== "string") {
      const promise = line instanceof Promise;
      // An async summarize that rejects later must not crash the process.
      if (promise) line.catch(() => {});
      const got = promise ? "a promise (it is not awaited)" : line === null ? "null" : typeof line;
      log.emit("log", { level: "warn", message: `summarize returned ${got}, not a string, so run.end has no summary` });
      return null;
    }
  } catch (error) {
    log.emit("log", { level: "warn", message: `summarize threw, so run.end has no summary: ${describeThrown(error)}` });
    return null;
  }
  if (line.trim() === "") return null;
  // Scrubbed before it is cut: a cut through the middle of a secret leaves a piece nothing matches.
  const clean = log.scrub(line);
  const chars = [...clean];
  return chars.length > SUMMARY_LIMIT ? `${chars.slice(0, SUMMARY_LIMIT).join("")}…` : clean;
}

/** A thrown value as one line, whatever was thrown. */
function describeThrown(error) {
  try {
    const { name, message } = errorOf(error);
    return `${name}: ${message}`;
  } catch {
    return "an error that cannot be printed";
  }
}
