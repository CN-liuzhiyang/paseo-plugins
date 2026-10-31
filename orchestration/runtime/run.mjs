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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import { loadFlow, describeFlow, scanSource, DEFAULT_GRANTS } from "./flow.mjs";
import { isStep, validate } from "./step.mjs";
import { CheckFailed, applyFix, extractJson, fixErrors, fixPrompt, normalizeProblems, planFix, problemsOf, schemaFailure, stripUndeclared } from "./answer.mjs";
import { unknownOption } from "./paseo-cli.mjs";
import { loadRoster, bindRole, composePrompt } from "./roster.mjs";
import { fenceFor } from "./fences.mjs";
import { EventLog, eventsFile } from "./events.mjs";
import { affairProblems } from "./affair.mjs";
import { affairKey, ensureWorkspace, normalizeDir, workspaceRefusal, workspaceTitle } from "./workspaces.mjs";
import { claimRun, ClaimTaken, runIdProblem } from "./claim.mjs";
import { checkResumePoint } from "./resume.mjs";
import { FROM_LIMIT, pointOf, pointProblems, PRINT_SHAPE } from "./resume-point.mjs";
import { paseoExecutor, sentTitle } from "./executor.mjs";
import { requestApproval, prepareGate, carrierKind, parseDuration, bytesDigest, contentDigest, INPUT_REDACTED } from "./gate.mjs";
import { Journal, JournalError, MAX_VALUE_BYTES, fingerprint, known, shortPrint } from "./journal.mjs";
import { LineBusy, takeLine } from "./line-lock.mjs";
import { loadConfig, logDir as configuredLogDir, resolveHost } from "./config.mjs";
import { AGENT_ID, wakeAtEnd } from "./wake.mjs";

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

/** How many times a call may send an agent back what is wrong with its answer (`$.ask`'s `fixes`), the CLI's own retry count. */
const DEFAULT_FIXES = 2;
const MAX_FIXES = 5;

const COST_NOTE =
  "per agent turn, LastUsage, added up over the rounds of a call (a turn the CLI retried inside one command counts only its last). Codex reports CostUsd 0, so totalUsd counts Claude only";

const sumOrNull = (a, b) => (a === null ? b : b === null ? a : a + b);
const addCost = (a, b) => (a === null ? b : b === null ? a : { usd: sumOrNull(a.usd, b.usd), inputTokens: sumOrNull(a.inputTokens, b.inputTokens), outputTokens: sumOrNull(a.outputTokens, b.outputTokens) });

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

/**
 * A run's own end. `kind` says why in a word a reader can act on without reading `reason`: "flow" (the flow's own $.stop), "check" (an
 * answer that never passed its check; `step` is the step asked) or "unknown" (a step that cannot be taken back, whose outcome is not
 * known; `step` is that step).
 */
class StopSignal extends Error {
  constructor(reason, value, phase, kind = "flow", step = null) {
    super(`flow stopped: ${reason}`);
    this.name = "StopSignal";
    this.reason = reason;
    this.value = value;
    this.phase = phase;
    this.kind = kind;
    this.step = step;
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
 * carries on (resume.mjs, `orch.mjs resume`), recorded as run.start.resumeOf. `lineage` is the first run of the line of runs
 * this one belongs to (its own id when it is the first): the line shares one journal (journal.mjs), so what a run did is not
 * done again by the runs that carry it on. `redo` names a step of that journal to do again (and what came after it).
 * `notify` is a session to tell when the run ends (`orch.mjs run --notify`), and `detached` says the run was started in the background
 * (`--detach`), so that its caller is told: see wake.mjs for who is told otherwise. `stewards` and `wakeTimeoutMs` stand in for the
 * config's `stewards` and the 30 seconds delivering may take, for a caller that embeds the runner.
 *
 * @param {string | object} target a flow module path, or a flow() value
 * @param {{ input?: object, timeout?: string | null, executor?: object, roster?: object, logDir?: string,
 *           cwd?: string, host?: string | null, caller?: string | null, gatePollMs?: number,
 *           agentProbeDelays?: number[], runId?: string, affair?: object | null, resumeOf?: string | null, resumePrint?: string | null,
 *           lineage?: string, redo?: string | null, notify?: string | null, detached?: boolean,
 *           stewards?: object, wakeTimeoutMs?: number,
 *           workspaceLock?: { waitMs?: number, staleMs?: number, pollMs?: number },
 *           taken?: ReturnType<typeof takeRunId> }} [options]
 * @returns {Promise<{ ok: boolean, outcome: "done"|"stopped"|"failed"|"timeout", value: unknown, summary: string | null, runId: string,
 *   events: string, cost: object | null, caveats: string[], durationMs: number,
 *   error: { name: string, message: string } | null, stop: { reason: string, phase: string | null, kind: "flow" | "check" | "unknown", step: string | null } | null,
 *   resume: { flow: string, input: object, from: string, spends: "nothing" | "maybe" } | null }>}
 */
export async function runFlow(target, options = {}) {
  checkKeys("runFlow", options, ["input", "timeout", "executor", "roster", "logDir", "cwd", "host", "caller", "gatePollMs", "agentProbeDelays", "runId", "affair", "resumeOf", "resumePrint", "lineage", "redo", "notify", "detached", "stewards", "wakeTimeoutMs", "taken", "workspaceLock"]);

  // --- The id, before anything slow ---------------------------------------
  // A caller that must hold the id sooner (orch.mjs, while it reads the flow's
  // inputs) takes it with takeRunId and hands it in.
  const taken = options.taken ?? takeRunId(options);
  try {
    return await runClaimed(target, options, taken);
  } catch (error) {
    settleRefusal(taken, error);
    // A refusal before run.start, or a failure of the runner itself: the line is not held on for a run that is not there.
    taken.line?.release();
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

async function runClaimed(target, options, taken) {
  const { runId, dir, claim } = taken;
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
  const lineage = options.lineage ?? runId;
  if (options.lineage !== undefined) {
    const problem = runIdProblem(lineage);
    if (problem) throw new RunRefused(`lineage: ${problem}`);
  }
  const redo = options.redo ?? null;
  if (redo !== null && (typeof redo !== "string" || redo.trim() === "" || resumeOf === null)) {
    throw new RunRefused("redo names a step of the line of runs this run carries on, so it needs a step name and resumeOf");
  }
  const notifyAgent = options.notify ?? null;
  if (notifyAgent !== null && (typeof notifyAgent !== "string" || !AGENT_ID.test(notifyAgent))) {
    throw new RunRefused("notify is the id of the session to tell when the run ends (letters, digits, . _ : -)");
  }
  if (options.detached !== undefined && typeof options.detached !== "boolean") throw new RunRefused("detached is true or false");
  if (options.wakeTimeoutMs !== undefined && !(Number.isFinite(options.wakeTimeoutMs) && options.wakeTimeoutMs > 0)) throw new RunRefused("wakeTimeoutMs is a positive number of milliseconds");
  // The line is taken before its journal is read, and held until nothing this run started can write to it (line-lock.mjs): the journal is
  // what the runs of this line did before this one, and it is read once.
  try {
    taken.line = takeLine({ dir, lineage, runId });
  } catch (error) {
    if (error instanceof LineBusy) throw new RunRefused(error.message);
    throw error;
  }
  let journal;
  try {
    journal = new Journal({ dir, lineage, redo });
  } catch (error) {
    if (error instanceof JournalError) throw new RunRefused(error.message);
    throw error;
  }
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
  // Who asked to be told when this run ends (wake.mjs): named, or the session that started it in the background.
  const notify = notifyAgent !== null ? { agent: notifyAgent, via: "explicit" } : options.detached === true && caller ? { agent: caller, via: "caller" } : null;
  if (notify && !AGENT_ID.test(notify.agent)) throw new RunRefused(`the caller ${JSON.stringify(notify.agent)} is not an agent id this runtime can tell when the run ends`);
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
  // A flow that runs again with the same input to be carried on (`resume: "auto"`): its point is made by the runner, and `from`
  // is worded at the end, when it is known how far the run got. `fromAuto` is set while the point held is one whose `from` is that.
  const auto = f.resume === "auto";
  let fromAuto = false;
  // The call a run came to grief in, for that wording.
  let lastBad = null;

  // The enclosing `$.step`: what is asked inside a step is named by it, so that a step taken from the journal (whose inside does not run)
  // does not move the names of what comes after it.
  // Its value is the names of the steps a place is inside, outermost first.
  const stepScope = new AsyncLocalStorage();
  const scoped = () => {
    const chain = stepScope.getStore();
    return chain && chain.length > 0 ? { scope: [...chain] } : {};
  };
  // Set while the `fn` of a `once` step runs (not its `before`): the step is already written as begun.
  const onceAct = new AsyncLocalStorage();
  // The calls that can write to the journal, until each has returned. A run that ends (a timeout, a stop in another branch) with one of them
  // still going -- above all a step that cannot be taken back, already begun -- keeps the line until it is over (line-lock.mjs).
  const inflight = new Set();
  const writing = (primitive) => (...args) => {
    const work = (async () => primitive(...args))();
    const over = work.then(() => {}, () => {});
    inflight.add(over);
    over.then(() => inflight.delete(over));
    return work;
  };
  const stepNames = new Set();
  const counters = new Map();
  const nextId = (kind, name = null) => {
    const scope = stepScope.getStore()?.at(-1) ?? null;
    const head = kind === "gate" ? `gate${scope ? `:${scope}` : ""}` : `${kind}:${scope ? `${scope}/` : ""}${name}`;
    const n = (counters.get(head) ?? 0) + 1;
    counters.set(head, n);
    return `${head}#${n}`;
  };

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

  const endCall = (record, { ok, output, error, agentId, cost, rounds, reused = false }) => {
    // Already closed when the run ended with this call in flight.
    if (!open.delete(record.callId)) return;
    if (!ok) lastBad = record.title ?? null;
    // An answer taken from the journal names the agent that gave it, but this run did not use that agent: nothing was spent.
    if (agentId && !reused) spent.set(agentId, addCost(spent.get(agentId) ?? null, cost));
    log.emit("call.end", {
      callId: record.callId,
      ok,
      durationMs: Date.now() - record.startedAt,
      output,
      error: error ? errorOf(error) : null,
      agentId,
      cost,
      ...(rounds === undefined ? {} : { rounds }),
    });
  };

  // Set once Paseo's CLI turns out not to know --max-retries (or send's --output-schema): from then on this run asks the
  // way it did before answers could be corrected in place -- the CLI retries a reply that does not fit by itself, and what
  // a check finds wrong cannot be sent back.
  let oldCli = false;

  // An ask's answers, round by round, until they pass or the corrections are used up. Round 1 is the CLI's `run`; each
  // later round is a `send` into the same agent that carries only the places that were wrong and a schema for only those
  // (answer.mjs). `state` is filled in as it goes, so a call that fails still has its rounds, cost and last answer to record.
  const converse = async (record, state, { step, check, fixes, timeout, phase, first }) => {
    const timeoutMs = parseDuration(timeout);
    const targeted = () => !oldCli && typeof executor.send === "function" && fixes > 0;
    let roundCost = null;
    // A turn's reply as the value it holds: what the CLI handed over, or, when it refused the reply as not fitting
    // the schema, the JSON read out of what the agent wrote. The turn's cost is taken whichever way it went.
    const read = async (turn, schema) => {
      let began = true;
      try {
        return { value: await turn(), text: null, cliErrors: [] };
      } catch (error) {
        began = unknownOption(error) === null;
        const refused = schemaFailure(error, schema);
        if (!refused) throw error;
        return { value: extractJson(refused.text), text: refused.text, cliErrors: refused.errors };
      } finally {
        if (began) {
          const found = await settleAgent(record);
          state.agentId = found.agentId;
          roundCost = found.cost;
          state.cost = addCost(state.cost, found.cost);
        }
      }
    };
    // What an agent added beyond the schema is not worth a round.
    const tidy = (schema, value, what) => {
      if (value === undefined) return undefined;
      const { value: kept, dropped } = stripUndeclared(schema, value);
      if (dropped.length > 0) log.emit("log", { level: "info", message: `${record.callId}: ${what} had fields the schema does not declare; dropped: ${dropped.join(", ")}` });
      return kept;
    };
    const mismatch = (found) =>
      Object.assign(new Error(`the answer does not fit the step's schema: ${found.problems.map((p) => `${p.at || "(root)"} ${p.say}`).join("; ")}`), { name: "OutputMismatch" });
    const failed = (found) => new CheckFailed({ step: step.name, problems: found.problems, value: state.value, rounds: state.rounds, phase });
    const whenOpen = (kind, fields) => {
      if (open.has(record.callId)) log.emit(kind, fields);
    };

    let reply = await read(() => first(targeted() ? 0 : undefined), step.schema);
    let value = tidy(step.schema, reply.value, "the answer");
    let cliErrors = reply.cliErrors;
    for (;;) {
      state.value = value ?? null;
      let problems = value === undefined ? [{ at: "", say: "no JSON could be read from the reply" }] : problemsOf(step.schema, value);
      // Keywords problemsOf does not know are the CLI's to judge; what it found stands.
      if (problems.length === 0 && value !== undefined) problems = cliErrors;
      cliErrors = [];
      let kind = "schema";
      if (problems.length === 0 && check) {
        kind = "check";
        problems = normalizeProblems(await check(structuredClone(value), { round: state.rounds }));
      }
      if (problems.length === 0) return;
      const found = { kind, problems, unread: value === undefined };
      const unsendable = () => (kind === "check" ? failed(found) : mismatch(found));

      if (!targeted()) throw unsendable();
      if (!state.agentId) {
        caveat(`answer: the agent of ${record.callId} could not be found, so what was wrong with its answer could not be sent back to it`, record.callId);
        throw unsendable();
      }
      if (state.rounds > fixes) throw failed(found);
      if (ending) throw new RunEnded();
      const left = timeoutMs - (Date.now() - record.startedAt);
      if (left < 1_000) throw Object.assign(new Error(`the call's ${timeout} ran out before the answer could be corrected`), { name: "CallTimeout" });

      const plan = planFix(step.schema, value, problems);
      for (const move of plan.moves) {
        log.emit("log", { level: "warn", message: `${record.callId}: a problem pointed at ${move.from}, which is not a place in the answer; asked for ${move.to || "the whole answer"} instead` });
      }
      const round = state.rounds + 1;
      const prompt = log.scrub(fixPrompt(plan, { unread: found.unread }));
      announceAgent(record, state.agentId);
      whenOpen("call.fix", { callId: record.callId, round, problems: plan.problems, prompt, schema: plan.schema });
      const sentAt = Date.now();
      try {
        reply = await read(() =>
          executor.send({
            agentId: state.agentId,
            prompt,
            schema: plan.schema,
            timeout: `${Math.ceil(left / 1_000)}s`,
            file: path.join(runDir, "prompts", `${record.callId}.r${round}.txt`),
          }),
          plan.schema,
        );
      } catch (error) {
        // Nothing was sent: the CLI refused the option before it began.
        if (!["--output-schema", "--max-retries"].includes(unknownOption(error))) throw error;
        oldCli = true;
        caveat("answer: this Paseo CLI's `send` does not take --output-schema, so what is wrong with an answer cannot be sent back to its agent; a reply that does not fit is not corrected, and a check that fails ends the call", record.callId);
        throw unsendable();
      }
      // Nothing came back at all (the CLI printed nothing): the agent did not answer, which is not a round.
      if (reply.text === null && (reply.value === null || reply.value === undefined)) throw Object.assign(new Error("the agent handed in nothing to the correction"), { name: "NoAnswer" });
      state.rounds = round;
      const given = tidy(plan.schema, reply.value, `the reply of round ${round}`);
      const fits = given !== undefined && reply.cliErrors.length === 0 && problemsOf(plan.schema, given).length === 0;
      whenOpen("call.fixed", { callId: record.callId, round, answer: reply.value ?? reply.text ?? null, ok: fits, cost: roundCost, durationMs: Date.now() - sentAt });
      value = applyFix(value, plan, given);
      // What the CLI said was wrong with the reply is a problem of the answer as it stands now, the next time round.
      cliErrors = fixErrors(plan, reply.cliErrors);
    }
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
        fromAuto = false;
        log.emit("resume", { cleared: true });
        return;
      }
      // A flow that is carried on by running again with its own input needs to say only what is different from that.
      const wording = auto && isPlainObject(point) && point.from === undefined;
      const given = auto && isPlainObject(point) ? { ...point, flow: point.flow ?? f.name, input: point.input ?? input, from: point.from ?? wordFrom(), spends: point.spends ?? "maybe" } : point;
      // The input as the events will hold it: JSON, and with whatever the run keeps secret already taken out.
      const plain = isPlainObject(given) ? { ...given, input: jsonSafe(given.input) } : given;
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
      fromAuto = wording;
      log.emit("resume", resumePoint);
    } catch (error) {
      log.emit("log", { level: "warn", message: `$.resumeWith: not recorded, ${describeThrown(error)}` });
    }
  };

  // What each answer an ask handed back was, by the object itself: `$.again` finds the agent and the call it came from
  // through the very object the flow got, so a copy or a part of it (a trimmed plan) is not one it knows.
  const answers = new WeakMap();
  // The objects `$.step` handed back: copies of JSON, which no answer's agent is behind.
  const stepResults = new WeakSet();
  const fromStep = (value) => {
    if (value !== null && typeof value === "object") stepResults.add(value);
    return value;
  };
  const ref = (rec) => (rec ? { runId, callId: rec.callId } : null);

  // The previous version in a file, for the agent that is to improve on it: one that was asked in a session the daemon
  // has since reloaded, or a new one, still has it. Written once, the first time it is asked for.
  const versionFile = (rec) => {
    if (!rec.file) {
      rec.file = path.join(runDir, "answers", `${rec.callId}.json`);
      mkdirSync(path.dirname(rec.file), { recursive: true });
      writeFileSync(rec.file, log.scrub(rec.text), "utf8");
    }
    return rec.file;
  };

  // Whether the agent behind an answer can be asked again, and if not why not: a CLI that cannot send a question with a schema, an
  // agent that was never found or is gone. (One that is archived is asked all the same: sending to it wakes it, and it is archived again.)
  const cannotContinue = async (rec) => {
    if (oldCli) return "cannot be sent a question with a schema by this Paseo CLI";
    if (typeof executor.send !== "function") return "cannot be sent to by this executor";
    if (!rec.agentId) return "was never found";
    try {
      await executor.inspect(rec.agentId);
    } catch (error) {
      if (error?.code === "AGENT_NOT_FOUND") return "is gone";
      throw error;
    }
    return null;
  };

  // The journal entry for an ask or an again that is still good, or null. A record made for another prompt is not one: that is asked
  // again, and said. An agent that may have changed files (`effects: "workspace"`) is not taken from its record unless the flow looks at
  // the files itself (`reuse`), because an answer says nothing of what is on the disk now.
  // The answer has to pass what this run asks of an answer -- its `check` -- as well: a check can read state that has changed, or have been
  // mended, since the answer was given. One that does not is set aside and asked for again (a new agent: the one that gave it may be gone).
  const recordedAnswer = async (id, print, kind, step, reuse, check) => {
    const entry = journal.get(id);
    if (!entry || !known(entry) || entry.kind !== kind || entry.state !== "done" || !isPlainObject(entry.value)) return null;
    if (entry.keyPrint !== print) {
      log.emit("log", { level: "warn", message: `${id}: the journal has an answer from ${entry.runId}, but not to what is asked now, so it is asked again` });
      setAside(id, "other-prompt");
      return null;
    }
    if (step.effects !== "none" && typeof reuse !== "function") {
      setAside(id, "workspace");
      return null;
    }
    if (typeof reuse === "function" && !(await reuse(structuredClone(entry.value)))) {
      setAside(id, "reuse");
      return null;
    }
    let problems = problemsOf(step.schema, entry.value);
    if (problems.length === 0 && check) problems = normalizeProblems(await check(structuredClone(entry.value), { round: 1 }));
    if (problems.length > 0) {
      const first = problems[0];
      caveat(`${id}: the answer the journal holds (from ${entry.runId}) does not pass this run's check (${`${first.at} ${first.say}`.trim().slice(0, 120)}), so it is asked again`, null);
      setAside(id, "check");
      return null;
    }
    return entry;
  };

  // This place is to be done again: the journal's word for it is set aside, so that a run that follows does not take it back -- above all
  // when what is done now cannot be kept (a secret, too big), and there will be no newer line to say so. Never fails the call.
  const setAside = (id, why) => {
    try {
      journal.setAside(id, why, runId);
    } catch (error) {
      log.emit("log", { level: "warn", message: `${id}: could not be set aside in the journal (${describeThrown(error)}); a run that carries this one on may take the old record` });
    }
  };

  // Whether `value` can go in the journal as it is, and if not why not. A value the run keeps secret must not be written to a file the
  // run's scrub does not reach.
  const unkeepable = (value) => {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_VALUE_BYTES) return "it is bigger than 1 MB";
    if (JSON.stringify(log.scrub(value)) !== text) return "it holds something this run keeps secret";
    return null;
  };

  // What an ask, an again or a card came to, written down so that a run that carries this one on does not do it again. Never fails the
  // call: an answer that was paid for is not thrown away because the disk said no; the place is just done again.
  const remember = (fields, callId) => {
    try {
      const why = unkeepable(fields.value);
      if (why) {
        log.emit("log", { level: "info", message: `${fields.id}: not kept in the journal, ${why}; a run that carries this one on does it again` });
        return;
      }
      journal.append({ ...fields, ...scoped(), runId, callId });
      rewordFrom();
    } catch (error) {
      log.emit("log", { level: "warn", message: `${fields.id}: could not be written to the journal (${describeThrown(error)}); a run that carries this one on does it again` });
    }
  };

  // One agent call: `$.ask`, and `$.again`, which says whose agent it asks again (`continues`) or whose answer a new
  // agent improves on (`revises`).
  const askCall = async (step, stepInput, callOptions, again = null) => {
    if (!isStep(step)) throw new TypeError("$.ask needs a step from define()");
    if (Object.hasOwn(callOptions ?? {}, "mode")) {
      throw new TypeError(`$.ask: mode is gone. The step declares effects ("${step.effects}"), and runtime/fences.mjs picks the mode`);
    }
    checkKeys(`$.ask(${step.name})`, callOptions, ["role", "provider", "thinking", "title", "cwd", "timeout", "archive", "check", "fixes", "reuse"]);
    if (callOptions.archive !== undefined && callOptions.archive !== "after") {
      throw new TypeError(`$.ask(${step.name}): archive can only be "after" (archive the agent once the call has handed in its answer), not ${JSON.stringify(callOptions.archive)}`);
    }
    const { check, fixes = DEFAULT_FIXES, reuse } = callOptions;
    if (check !== undefined && typeof check !== "function") throw new TypeError(`$.ask(${step.name}): check must be a function (answer, { round }) returning the problems found, as [{ at, say }]`);
    if (reuse !== undefined && typeof reuse !== "function") throw new TypeError(`$.ask(${step.name}): reuse must be a function (answer) returning whether the answer of an earlier run still holds`);
    if (!Number.isInteger(fixes) || fixes < 0 || fixes > MAX_FIXES) throw new TypeError(`$.ask(${step.name}): fixes is how many times the answer may be sent back to be corrected, 0 to ${MAX_FIXES} (default ${DEFAULT_FIXES})`);
    // Named before anything is awaited: the order a flow asks in is what the names follow.
    const journalId = again ? again.journalId : nextId("ask", step.name);
    const bound = bindRole(roster, callOptions);
    const fence = fenceFor(bound.provider, step.effects);
    const continues = again?.continues ?? null;
    if (continues && fence.mode !== continues.fenceMode) {
      throw new TypeError(
        `$.again(${step.name}): the step's effects ("${step.effects}") need mode ${fence.mode}, and the agent was started with ${continues.fenceMode}; ` +
          "a running agent keeps its fence, so ask this step with $.ask",
      );
    }
    const callCwd = callOptions.cwd ?? cwd;
    const prompt = promptOf(bound, step, stepInput, again);
    // What the answer was given for: the prompt (the role's instructions are in it), the schema, who was asked, and where -- a directory or
    // a host that is not the one it was given in describes other files.
    const print = again ? again.print : fingerprint({ prompt, schema: step.fingerprint, provider: bound.provider, thinking: bound.thinking, effects: step.effects, cwd: normalizeDir(callCwd), host });
    const timeout = callOptions.timeout ?? step.timeout ?? DEFAULT_CALL_TIMEOUT;
    parseDuration(timeout);
    // The call's own title, then the step's, then its name: one value for
    // the events and for the agent on Paseo.
    const title = sentTitle(callOptions.title ?? step.title ?? `[${step.name}]`);
    const recorded = again ? (again.reused ?? null) : await recordedAnswer(journalId, print, "ask", step, reuse, check);
    // Before the call exists: a wait for another run's workspace is not part of this call's time.
    // Without an affair nothing is awaited here, so such a run goes through exactly the steps it always did.
    // (An agent asked again is where it was, and an answer taken from the journal starts no agent.)
    const used = affair && !continues && !recorded ? workspaceFor(callCwd) : null;
    const workspace = used ? await used : null;

    const record = startCall();
    record.title = title;
    const startEvent = {
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
      continues: ref(continues),
      revises: ref(again?.revises ?? null),
    };
    // Registered under the object the flow gets, so that `$.again` finds the agent and the call it came from.
    const answered = (value, agentId, askedBy) => {
      if (!isPlainObject(value)) return;
      const { role, provider, thinking, cwd: at } = callOptions;
      answers.set(value, {
        callId: record.callId,
        journalId,
        print,
        step,
        stepInput,
        agentId,
        who: { role, provider, thinking },
        cwd: at,
        fenceMode: fence.mode,
        check,
        fixes: callOptions.fixes,
        archive: askedBy,
        text: JSON.stringify(value, null, 2),
        file: null,
      });
    };

    if (recorded) {
      // Nothing is asked and nothing is archived: the agent that gave this answer is still the one `$.again` asks.
      log.emit("call.start", { ...startEvent, archive: null, reused: reusedRef(recorded) });
      if (recorded.agentId) announceAgent(record, recorded.agentId);
      const value = structuredClone(recorded.value);
      endCall(record, { ok: true, output: safe(value), error: null, agentId: recorded.agentId ?? null, cost: null, rounds: recorded.rounds ?? 1, reused: true });
      answered(value, recorded.agentId ?? null, callOptions.archive);
      return value;
    }

    log.emit("call.start", { ...startEvent, archive: callOptions.archive ?? null, reused: null });
    if (!fence.enforced) caveat(`effects "${step.effects}" on ${bound.provider.split("/")[0]} is not enforced: ${fence.note}`, record.callId);
    // An agent asked again is known from the start; a new one is looked for by its labels while the call runs.
    if (continues) announceAgent(record, continues.agentId);
    else probeAgent(record);

    const askRequest = {
      provider: bound.provider,
      thinking: bound.thinking,
      mode: fence.mode,
      title,
      labels: { ...record.labels, "orch-step": step.name },
      prompt,
      schema: step.schema,
      timeout,
      cwd: callCwd,
    };
    // `retries` 0 hands a reply that does not fit back to the runner instead of the CLI asking again; an older CLI
    // that does not know the option is asked the old way, once and for the rest of the run.
    const first = continues
      ? async () => {
          try {
            return await executor.send({ agentId: continues.agentId, prompt, schema: step.schema, timeout, file: path.join(runDir, "prompts", `${record.callId}.r1.txt`) });
          } catch (error) {
            if (["--output-schema", "--max-retries"].includes(unknownOption(error))) {
              oldCli = true;
              caveat("again: this Paseo CLI's `send` does not take --output-schema, so an agent cannot be asked again; ask with `fresh: true`", record.callId);
            }
            throw error;
          }
        }
      : (retries) =>
          startIn(callCwd, used, workspace, async (inWorkspace) => {
            try {
              return await executor.ask({ ...askRequest, workspace: inWorkspace, maxRetries: retries });
            } catch (error) {
              if (retries === undefined || unknownOption(error) !== "--max-retries") throw error;
              oldCli = true;
              caveat(
                "answer: this Paseo CLI does not take --max-retries, so it retries a reply that does not fit by itself, and what is wrong with an answer cannot be sent back to its agent (a check that fails ends the call)",
                record.callId,
              );
              return executor.ask({ ...askRequest, workspace: inWorkspace });
            }
          });

    const state = { rounds: 1, cost: null, agentId: continues?.agentId ?? null, value: null };
    record.state = state;
    let failure = null;
    try {
      await converse(record, state, { step, check, fixes, timeout, phase: currentPhase(), first });
    } catch (error) {
      failure = error;
    }
    endCall(record, { ok: !failure, output: safe(state.value), error: failure, agentId: state.agentId, cost: state.cost, rounds: state.rounds });
    if (failure) throw failure;
    if (isPlainObject(state.value)) {
      answered(state.value, state.agentId, callOptions.archive);
      remember({ id: journalId, kind: again ? "again" : "ask", state: "done", keyPrint: print, value: state.value, agentId: state.agentId, rounds: state.rounds, mode: again ? (continues ? "continues" : "revises") : null }, record.callId);
    }
    // Only a call that came out well, and only when the flow asked for it: a call that failed keeps its agent to be looked into.
    if (callOptions.archive === "after") await archiveAfter(record, state.agentId);
    return state.value;
  };

  // The prompt as sent. A new agent gets the role's instructions and the step's prompt; one asked again has had them.
  // `again.text` is what the flow said about the previous version, which is in a file for whoever reads it. (An answer taken from the
  // journal sends nothing: the prompt shown is what would have been, without writing a file for it.)
  const promptOf = (bound, step, stepInput, again) => {
    if (again?.reused) return again.text === undefined ? step.for(stepInput) : again.text;
    if (again?.continues) {
      return again.text === undefined ? step.for(stepInput) : `${again.text}\n\nYour previous version is saved in ${again.file}. Reply with the complete revised answer.`;
    }
    const body = step.for(stepInput);
    if (again?.text !== undefined) {
      return composePrompt(bound, `${body}\n\n${again.text}\n\nA previous version of this answer, written by another agent, is saved in ${again.file}. Reply with the complete revised answer.`);
    }
    if (again?.handover) return composePrompt(bound, `${body}\n\nThe answer the previous agent gave to ${again.revises.step.name} is saved in ${again.file}.`);
    return composePrompt(bound, body);
  };

  // A step of the journal that is taken as it was done: the reference a call that took it says it took it from.
  const reusedRef = (entry) => ({ runId: entry.runId, callId: entry.callId ?? null });

  // The flow's own words on how this run could be carried on, made when the run ends, from how far the journal got.
  const wordFrom = () => {
    const done = journal.count("step") + journal.count("ask") + journal.count("again");
    const approved = journal.count("gate", (e) => e.value?.outcome === "allowed");
    const kept = done + approved === 0 ? "，没有可沿用的" : `，前面${done}步${approved > 0 ? `和${approved}次批准` : ""}沿用`;
    const room = FROM_LIMIT - [...`从「」接着${kept}`].length;
    const where = lastBad === null ? null : [...lastBad].length <= room ? lastBad : `${[...lastBad].slice(0, Math.max(1, room - 1)).join("")}…`;
    return where === null ? `再跑一遍${kept}` : `从「${where}」接着${kept}`;
  };

  // A point whose line is the runner's is worded again when the journal has grown, so that even a run that is cut off (no run.end) has said
  // how far it got in its last `resume` event.
  const rewordFrom = () => {
    if (!auto || !fromAuto || resumePoint === null) return;
    const from = wordFrom();
    if (from === resumePoint.from) return;
    resumePoint = { ...resumePoint, from };
    log.emit("resume", resumePoint);
  };

  // What the journal says of a step that cannot be undone, when it does not say it was done: it began, or failed, or its record cannot be
  // read -- the step may have taken effect or not. A probe looks outside; it never decides by guessing.
  const lookOutside = async (probe, name) => {
    if (probe === undefined) return null;
    try {
      const found = await probe();
      if (isPlainObject(found) && found.done === false) return { done: false };
      if (isPlainObject(found) && found.done === true) {
        const text = found.value === undefined ? undefined : JSON.stringify(found.value);
        return { done: true, value: text === undefined ? undefined : JSON.parse(text) };
      }
      log.emit("log", { level: "warn", message: `step "${name}": its probe returned neither { done: true, value } nor { done: false }, so the step is not known to be done or not` });
    } catch (error) {
      log.emit("log", { level: "warn", message: `step "${name}": its probe failed (${describeThrown(error)}), so the step is not known to be done or not` });
    }
    return null;
  };

  // The value a step handed back, as the journal keeps it: JSON, the same on the run that made it and on the runs that take it from the journal.
  const stepValue = (name, raw) => {
    let text;
    try {
      text = raw === undefined ? undefined : JSON.stringify(raw);
    } catch (error) {
      throw new TypeError(`$.step("${name}"): the value cannot be written as JSON (${error.message}); a step's value is JSON, so that what a later run takes from the journal is what this one got`);
    }
    if (text !== undefined && Buffer.byteLength(text) > MAX_VALUE_BYTES) {
      throw new TypeError(`$.step("${name}"): the value is bigger than 1 MB; write it to a file and return the path`);
    }
    return { text, value: text === undefined ? undefined : JSON.parse(text) };
  };

  // The stop is recorded now, the first one wins (see $.stop).
  const stopNow = (reason, value = null, kind = "flow", step = null) => {
    const signal = new StopSignal(reason, value, currentPhase(), kind, step);
    if (!ending) {
      stopped = signal;
      ending = true;
    }
    throw signal;
  };

  // --- Primitives -------------------------------------------------------
  const primitives = {
    /**
     * One agent call. Resolves to exactly what the step's schema declares.
     * Everything that can be wrong without an agent -- the step, the role,
     * the prompt's input, the fence -- throws before the call starts.
     */
    ask: (step, stepInput, callOptions = {}) => askCall(step, stepInput, callOptions),

    /**
     * Say something more to the agent that gave `prev` (what `$.ask` or `$.again` returned, as it is), and get the whole answer
     * again: `$.again(prev, "the reviewer said ...")`. The agent is the same one, with its conversation, even if it was archived
     * since; if it is gone, a new one is asked and given the previous version. `$.again(prev, otherStep, input)` asks another step of
     * the same agent. `{ fresh: true }` asks a new agent instead (from the previous version in a file), which can be another role.
     */
    async again(prev, ...args) {
      const rec = answers.get(prev);
      if (!rec) {
        throw new TypeError(
          stepResults.has(prev)
            ? "$.again: this object came out of $.step, which hands back a JSON copy of what its function returned, so it is not the object $.ask gave. " +
                'Ask and ask again inside the one step ($.step("plan", async () => { const a = await $.ask(...); return $.again(a, "...") })), or do not wrap the $.ask in a step'
            : "$.again: pass the object $.ask or $.again returned, as it is -- not a copy of it or a part of it",
        );
      }
      const stepForm = isStep(args[0]);
      const [step, stepInput, text, options = {}] = stepForm ? [args[0], args[1], undefined, args[2]] : [rec.step, rec.stepInput, args[0], args[1]];
      if (!stepForm && (typeof text !== "string" || text.trim() === "")) throw new TypeError("$.again(prev, text): text is what to say to the agent; to ask another step, $.again(prev, step, input)");
      checkKeys("$.again", options ?? {}, ["fresh", "check", "fixes", "title", "timeout", "archive", "role", "provider", "thinking", "cwd"]);
      const { fresh = false } = options ?? {};
      if (typeof fresh !== "boolean") throw new TypeError("$.again: fresh is true or false");
      const who = ["role", "provider", "thinking"].filter((k) => options[k] !== undefined);
      if (!fresh && (who.length > 0 || options.cwd !== undefined)) throw new TypeError(`$.again: ${[...who, ...(options.cwd === undefined ? [] : ["cwd"])].join(", ")} can only be given with fresh: true -- the agent asked again is where it was, as it was started`);
      if (fresh && stepForm) throw new TypeError("$.again: fresh with another step is a $.ask");
      if (options.archive !== undefined && options.archive !== null && options.archive !== "after") throw new TypeError('$.again: archive is "after" or null');

      // What this call runs as: the previous call's, as given, unless a new agent is asked and the flow names another.
      const callOptions = {
        ...(who.length > 0 ? Object.fromEntries(who.map((k) => [k, options[k]])) : Object.fromEntries(Object.entries(rec.who).filter(([, v]) => v !== undefined))),
        ...((options.cwd ?? rec.cwd) === undefined ? {} : { cwd: options.cwd ?? rec.cwd }),
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      };
      const check = options.check === undefined ? (stepForm ? undefined : rec.check) : (options.check ?? undefined);
      if (check !== undefined) callOptions.check = check;
      const fixes = options.fixes ?? (stepForm ? undefined : rec.fixes);
      if (fixes !== undefined) callOptions.fixes = fixes;
      const archive = options.archive === undefined ? rec.archive : (options.archive ?? undefined);
      if (archive !== undefined) callOptions.archive = archive;

      // Named before anything is awaited. What this asks is fingerprinted with the answer it follows, and with the agent that gave it, whose
      // conversation it goes on with: if either is not what the journal's was given, the journal's does not answer this.
      const journalId = nextId("again", rec.journalId);
      // A new agent is asked as what the roles say now (the provider and thinking they resolve to, and the instructions), not as the names the
      // flow wrote; an agent asked again is the one that was, so who it is answers that.
      const bound = bindRole(roster, callOptions);
      const print = fingerprint({
        prev: fingerprint(rec.text),
        prevPrint: rec.print,
        agent: fresh ? null : (rec.agentId ?? null),
        text: stepForm ? null : text,
        step: step.fingerprint,
        input: stepForm ? step.for(stepInput) : null,
        effects: step.effects,
        fresh,
        who: fresh ? { provider: bound.provider, thinking: bound.thinking, instructions: fingerprint(bound.instructions) } : null,
        cwd: normalizeDir(callOptions.cwd ?? cwd),
        host,
      });
      const reused = await recordedAnswer(journalId, print, "again", step, undefined, check);
      if (reused) {
        const asked = { reused, journalId, print, continues: reused.mode === "continues" ? rec : null, revises: reused.mode === "revises" ? rec : null, ...(stepForm ? {} : { text }) };
        return askCall(step, stepInput, callOptions, asked);
      }

      let why = null;
      if (!fresh) {
        why = await cannotContinue(rec);
        if (why) caveat(`again: the agent of ${rec.callId} ${why}, so a new agent is asked and given the previous version`, null);
      }
      if (fresh || why) {
        const again = { journalId, print, continues: null, revises: rec, file: versionFile(rec), ...(stepForm ? { handover: true } : { text }) };
        return askCall(step, stepInput, callOptions, again);
      }
      return askCall(step, stepInput, callOptions, { journalId, print, continues: rec, revises: null, ...(stepForm ? {} : { text, file: versionFile(rec) }) });
    },

    /**
     * A step of the flow that is done once for the line of runs it belongs to: a run that carries this one on takes its value from the
     * journal instead of doing it again, as long as its `key` is the same (and `still`, which looks at what the value stands for, agrees).
     * `once: true` is for what cannot be taken back: the step writes that it began before it acts (after `before`, which is where a
     * card that authorises it goes, since that is not part of the act), and a run that finds only that line does not do it again on its
     * own: `probe` looks outside to see, and without one the run stops for a person to say (`orch.mjs settle`).
     */
    async step(name, fn, options = {}) {
      if (typeof name !== "string" || name.trim() === "") throw new TypeError("$.step needs a name");
      if (typeof fn !== "function") throw new TypeError(`$.step("${name}") needs a function`);
      checkKeys(`$.step("${name}")`, options ?? {}, ["key", "still", "once", "probe", "before", "title"]);
      const { key = null, still, once = false, probe, before, title = name } = options ?? {};
      if (typeof once !== "boolean") throw new TypeError(`$.step("${name}"): once is true or false`);
      if (still !== undefined && typeof still !== "function") throw new TypeError(`$.step("${name}"): still must be a function (value) returning whether the value of the earlier run still holds`);
      for (const [option, value] of [["probe", probe], ["before", before]]) {
        if (value === undefined) continue;
        if (typeof value !== "function") throw new TypeError(`$.step("${name}"): ${option} must be a function`);
        if (!once) throw new TypeError(`$.step("${name}"): ${option} is for a step that cannot be taken back (once: true)`);
      }
      if (typeof title !== "string" || title.trim() === "") throw new TypeError(`$.step("${name}"): title must be a non-empty string`);
      if (stepNames.has(name)) {
        throw new TypeError(`$.step("${name}"): this run already has a step by that name, and the name is what the journal knows it by; give each round of a loop its own ("${name}-2")`);
      }
      stepNames.add(name);
      if (ending) throw new RunEnded();

      const id = `step:${name}`;
      const print = fingerprint(key);
      const entry = journal.get(id);
      const mine = entry && known(entry) && entry.kind === "step" ? entry : null;
      const asValue = (e) => (e.undefined === true ? undefined : structuredClone(e.value));
      // What the journal makes of this place: take the value (`taken`), do the step (`run`), or, for one that cannot be taken back, not know.
      let verdict = "run";
      let taken = null;
      // What a probe found, as this run gets it: the journal may keep less of it (a secret, too big).
      let probed = null;
      if (!once) {
        if (mine?.state === "done") {
          if (mine.keyPrint !== print) log.emit("log", { level: "info", message: `step "${name}": the journal has it from ${mine.runId}, for another key, so it is done again` });
          else if (still && !(await still(asValue(mine)))) log.emit("log", { level: "info", message: `step "${name}": its value from ${mine.runId} no longer holds (still said so), so it is done again` });
          else [verdict, taken] = ["taken", mine];
          if (!taken) setAside(id, "again");
        }
      } else if (entry !== null) {
        const settled = mine?.state === "settled";
        if (mine && (mine.state === "done" || (settled && mine.done === true)) && mine.dropped !== true) {
          // A step that cannot be taken back is done once whatever its key says now; the step's own word that its record does not show it took
          // effect (a refusal that left nothing behind) is what lets it be done again.
          if (still && !(await still(asValue(mine)))) log.emit("log", { level: "info", message: `step "${name}": its record from ${mine.runId} says it did not take effect (still said so), so it is done again` });
          else {
            if (mine.keyPrint !== print && mine.keyPrint !== null) log.emit("log", { level: "info", message: `step "${name}": its key is not the one it was done with in ${mine.runId}; it cannot be taken back, so it is not done again` });
            [verdict, taken] = ["taken", mine];
          }
        } else if (settled && mine.done === false) {
          verdict = "run";
        } else {
          verdict = "unknown";
        }
      } else if (journal.damaged.length > 0) {
        // No line for it, but there are lines the file holds that cannot be read, and one of them may be what this step wrote before it acted.
        verdict = "unknown";
      }
      if (verdict === "unknown") {
        const found = await lookOutside(probe, name);
        // The run may have ended while the probe looked: nothing is written for a run that is over.
        if (ending) throw new RunEnded();
        const from = { runId: entry?.runId ?? runId, callId: entry?.callId ?? null };
        if (found?.done === true) {
          // The step took effect, and that is written whatever the value is; the value goes the way a step's own does -- not kept, and the
          // record then says only that it was done, when it is bigger than a record may be or holds what this run keeps secret.
          const why = found.value === undefined ? null : unkeepable(found.value);
          if (why) log.emit("log", { level: "info", message: `step "${name}": the value its probe found is not kept in the journal, ${why}; a run that carries this one on has it looked for again` });
          taken = journal.append({ id, kind: "step", state: "settled", done: true, once: true, keyPrint: print, ...(why ? { dropped: true } : found.value === undefined ? { undefined: true } : { value: found.value }), by: "probe", ...from }, { sync: true });
          probed = { value: found.value };
          verdict = "taken";
        } else if (found?.done === false) {
          journal.append({ id, kind: "step", state: "settled", done: false, once: true, keyPrint: print, by: "probe", ...from }, { sync: true });
          verdict = "run";
        } else {
          lastBad = title;
          return stopNow(
            `「${title}」可能已经做了、也可能没做（${entry === null ? "日志里有读不懂的行，它可能就在其中" : "它开始过，没有留下结果"}）：去外面查一下，用 orch.mjs settle ${runId} ${name} --done '<值的 JSON>' 或 --not-done 了结，再接着跑`,
            { step: name, unknown: true },
            "unknown",
            name,
          );
        }
      }

      const record = startCall();
      record.title = title;
      log.emit("call.start", { callId: record.callId, type: "step", name, title, phase: currentPhase(), once, key: shortPrint(print), reused: taken ? reusedRef(taken) : null });
      if (taken) {
        const value = probed ? structuredClone(probed.value) : asValue(taken);
        endCall(record, { ok: true, output: safe(value, DO_STRING_LIMIT), error: null, agentId: null, cost: null });
        return fromStep(value);
      }
      let began = false;
      try {
        const raw = await stepScope.run([...(stepScope.getStore() ?? []), name], async () => {
          const given = before ? await before() : undefined;
          // A run that ended while `before` waited (a timeout, a stop in another branch) does not start the act: it could not be told of it.
          if (ending) throw new RunEnded();
          if (once) {
            // Written and on the disk before the act: from here, whatever happens, a run that finds this line knows the step may have taken effect.
            journal.append({ id, kind: "step", state: "begun", once: true, keyPrint: print, runId, callId: record.callId }, { sync: true });
            began = true;
          }
          return once ? onceAct.run(name, () => fn(given)) : fn(given);
        });
        let kept;
        try {
          kept = stepValue(name, raw);
        } catch (error) {
          // The act is done and its value cannot be kept: said so in the journal, so that a later run does not take the step for undone.
          if (began) journal.append({ id, kind: "step", state: "done", once: true, keyPrint: print, dropped: true, runId, callId: record.callId }, { sync: true });
          throw error;
        }
        const secret = kept.text !== undefined && JSON.stringify(log.scrub(kept.value)) !== kept.text;
        const fields = { id, kind: "step", state: "done", once, keyPrint: print, ...scoped(), runId, callId: record.callId };
        try {
          if (secret && !once) log.emit("log", { level: "info", message: `step "${name}": its value holds something this run keeps secret, so it is not kept in the journal and a run that carries this one on does the step again` });
          else {
            journal.append({ ...fields, ...(secret ? { dropped: true } : kept.value === undefined ? { undefined: true } : { value: kept.value }) }, { sync: once });
            rewordFrom();
          }
        } catch (error) {
          log.emit("log", { level: "warn", message: `step "${name}": could not be written to the journal (${describeThrown(error)}); ${once ? "a run that carries this one on will not know it was done" : "a run that carries this one on does it again"}` });
        }
        endCall(record, { ok: true, output: safe(kept.value, DO_STRING_LIMIT), error: null, agentId: null, cost: null });
        return fromStep(kept.value);
      } catch (error) {
        if (began) {
          try {
            journal.append({ id, kind: "step", state: "failed", once: true, keyPrint: print, error: log.scrub(errorOf(error)), runId, callId: record.callId }, { sync: true });
          } catch {
            // The `begun` line is there: the step is read as one that may have been done, which is what a failure leaves.
          }
        }
        endCall(record, { ok: false, output: null, error, agentId: null, cost: null });
        throw error;
      }
    },

    /** The flow's own deterministic action: read, run a CLI, write. Returns fn's value. */
    async do(name, fn, doOptions = {}) {
      if (typeof name !== "string" || name.trim() === "") throw new TypeError("$.do needs a name");
      if (typeof fn !== "function") throw new TypeError(`$.do("${name}") needs a function`);
      checkKeys(`$.do("${name}")`, doOptions, ["title"]);
      const { title = name } = doOptions ?? {};
      if (typeof title !== "string" || title.trim() === "") throw new TypeError(`$.do("${name}"): title must be a non-empty string`);
      const record = startCall();
      record.title = title;
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
      // One line: it heads the provider's three-line prompt, and a line break in it could pass for a pointer.
      const oneLineTitle = sentTitle(title.replace(/\s+/g, " ").trim());
      // A card a person answered in an earlier run of this line is not put to them again when it is the same card (same title, same
      // content): their word stands, so that the flow goes the way it went. Expired or broken cards, and a card that asks for a value
      // (which is kept nowhere), are asked afresh. Named before anything is awaited, like the asks.
      const gateId = nextId("gate");
      const print = fingerprint({ title: oneLineTitle, digest: contentDigest(content) });
      const existing = journal.get(gateId);
      const earlier = input === null ? existing : null;
      const taken = earlier && known(earlier) && earlier.kind === "gate" && earlier.state === "done" && earlier.keyPrint === print && ["allowed", "denied"].includes(earlier.value?.outcome) ? earlier : null;
      if (existing && !taken && existing.kind === "gate" && existing.state === "done") setAside(gateId, "asked-again");

      // The provider's card needs nothing of its directory (its prompt gives absolute paths), so it goes
      // with the run's own agents. A model carrier writes the receipt itself and stays where it was.
      // Resolved before the receipt path is looked at and claimed, not between the two: the wait would
      // let a parallel gate with the same path through the look. (No affair: nothing is awaited.)
      const used = affair && carrier === "provider" && !taken ? workspaceFor(cwd) : null;
      const workspace = used ? await used : null;

      // Two gates on one receipt path would remove each other's receipt (each starts by clearing its own).
      if (request.holdPath !== undefined && gateHolds.has(path.resolve(request.holdPath))) {
        throw new TypeError(`$.gate: holdPath ${request.holdPath} is already another gate's in this run`);
      }

      const record = startCall();
      record.title = oneLineTitle;
      const holdPath = request.holdPath ?? path.join(runDir, "gate", `${record.callId}.receipt.txt`);
      if (!taken) gateHolds.add(path.resolve(holdPath));
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
        reused: taken ? reusedRef(taken) : null,
      });
      if (taken) {
        // Nothing is asked: the card was answered before, and what the person said is what the flow gets, with the answer's own time and words.
        const decision = structuredClone(taken.value);
        endCall(record, { ok: true, output: decision, error: null, agentId: null, cost: null });
        return decision;
      }
      // A card with a value is asked afresh on every run, so it belongs before the step it authorises, not inside it: once the step is
      // written as begun, a run that is cut off while the person is still deciding reads as one that may have done the act.
      const acting = onceAct.getStore();
      if (input && acting) {
        caveat(`gate "${oneLineTitle}" asks for a value inside the act of the once step "${acting}": the step is already written as begun, so a run cut off while the person decides is read as one that may have done it, and has to be settled by hand; put the card in the step's \`before\``, record.callId);
      }
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
        const shown = typeof decision.input === "string" && input?.secret ? { ...decision, input: INPUT_REDACTED } : decision;
        endCall(record, { ok: true, output: shown, error: null, ...(await settleAgent(record)) });
        if (input === null && ["allowed", "denied"].includes(decision.outcome)) remember({ id: gateId, kind: "gate", state: "done", keyPrint: print, value: decision }, record.callId);
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
      return stopNow(reason, value);
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
    ctx: Object.freeze({ runId, caller, cwd, host, runDir, events: log.file, role, lineage, lineDir: path.join(dir, "runs", lineage), resumed: resumeOf !== null }),
  };
  const $ = Object.freeze({ ...primitives, ask: writing(primitives.ask), again: writing(primitives.again), step: writing(primitives.step), gate: writing(primitives.gate) });

  // --- Run and settle -----------------------------------------------------
  const startedAt = Date.now();
  // What a step to do again sets aside is written, so that the runs after this one leave it out too. Not before every check that can refuse
  // the run has been made: a run that is refused changes nothing, and the one that carries the line on next would otherwise do the step again.
  if (redo !== null) journal.persistRedo(runId);
  // pid and hostname let a reader on the same machine ask whether the run is
  // still alive instead of guessing from the time of the last event.
  log.emit("run.start", { flow: describeFlow(f), source, input, caller, cwd, host, pid: process.pid, hostname: os.hostname(), affair, resumeOf, resumePrint, lineage, redo, notify });
  if (journal.damaged.length > 0) {
    const where = journal.damaged.slice(0, 3).map((d) => d.line).join(", ");
    caveat(`journal: ${journal.damaged.length} line(s) of ${journal.file} cannot be read (line ${where}${journal.damaged.length > 3 ? ", ..." : ""}), so what they held is not known; a step that cannot be taken back and has no record is not done on that account`, null);
  }

  let outcome;
  let value = null;
  let stop = null;
  let error = null;
  let timer = null;
  if (auto) resumeChain = resumeChain.then(() => declareResume({}));
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
      stop = { reason: thrown.reason, phase: thrown.phase, kind: thrown.kind, step: thrown.step };
    } else if (thrown instanceof CheckFailed) {
      // Not a failure of the run: the flow did not catch an answer that never came right, and a run stopped here can be carried on.
      outcome = "stopped";
      value = null;
      stop = { reason: thrown.reason, phase: thrown.phase, kind: "check", step: thrown.step };
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
    stop = { reason: stopped.reason, phase: stopped.phase, kind: stopped.kind, step: stopped.step };
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
    const settled = await settleAgent(record);
    // An ask in a later round has the earlier rounds' cost already; the turn in flight is counted as it stands.
    endCall(record, {
      ok: false,
      output: null,
      error: { name: "RunEnded", message: `the run ended (${outcome}) before this call finished` },
      agentId: settled.agentId,
      cost: addCost(record.state?.cost ?? null, settled.cost),
      rounds: record.state?.rounds,
    });
  }
  if (unfinished > 0) {
    log.emit("log", { level: "warn", message: `${unfinished} call(s) were still running when the run ended; their agents were left running` });
  }
  for (const [id, depth] of openPhases) {
    for (let i = 0; i < depth; i += 1) log.emit("phase.end", { phase: id, ok: false });
  }
  openPhases.clear();

  if (outcome !== "done") rewordFrom();

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
  // Whoever should know is told before run.end, which must be the last line; a message that cannot be delivered is a line here and
  // nothing more. The daemon asked is this machine's, whichever host the run's own agents are on.
  let stewards = options.stewards;
  if (stewards === undefined) {
    try {
      stewards = loadConfig().stewards;
    } catch (configError) {
      caveat(`wake: the config could not be read, so no steward was looked for (${configError.message})`, null);
    }
  }
  const woken = await wakeAtEnd({
    run: {
      flow: f,
      source,
      runId,
      lineage,
      affair,
      caller,
      notify,
      outcome,
      reason: outcome === "stopped" ? stop?.reason : outcome === "failed" || outcome === "timeout" ? `${error?.name}: ${error?.message}` : summary,
      durationMs,
      usd: cost?.totalUsd ?? null,
      resume,
      working: inflight.size,
      events: log.file,
    },
    dir,
    executor: options.executor ?? (host ? paseoExecutor({ host: null }) : executor),
    roster,
    stewards,
    timeoutMs: options.wakeTimeoutMs,
    scrub: (text) => log.scrub(text),
  });
  log.emit("wake", woken.event);
  log.emit("run.end", { outcome, value: recorded, summary, stop, error, durationMs, cost, caveats: [...caveats], resume });
  process.removeListener("exit", sweepInputs);
  // The line goes back when nothing this run started can write to it any more; a step that cannot be taken back, begun before the run
  // ended, may still be acting, and a run that carried this one on now would do it again.
  const line = taken.line;
  taken.line = null;
  const settle = async () => {
    while (inflight.size > 0) await Promise.all([...inflight]);
    line.release();
  };
  if (inflight.size === 0) line.release();
  else void settle();

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
