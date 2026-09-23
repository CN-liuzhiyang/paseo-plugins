// The orchestration surface a script calls.
//
// Every method is a thin, audited wrapper over a `paseo` CLI verb. There is no
// second code path: if the CLI cannot express something, neither can this.

import { runPaseo, runPaseoJson, PaseoCliError } from "./paseo-cli.mjs";
import { Audit } from "./audit.mjs";
import { NO_EDITS_SUFFIX } from "./step.mjs";
import { loadRoster, DEFAULT_ROLE } from "./roster.mjs";

export { NO_EDITS_SUFFIX };

/** Titles are truncated for Paseo; the audit records the same truncated text. */
const sentTitle = (title) => (title ? title.slice(0, 120) : null);

/**
 * Pick the mode for a step that must not change anything.
 *
 * No provider offers "read-only AND unattended", so `enforced` is false
 * everywhere and `readOnly` is a request in the prompt that the model can
 * ignore. Do not flatten this away -- saying the work was sandboxed when it
 * was not is the failure mode this field exists to prevent.
 *
 * Claude's `plan` looks like the read-only mode and is not usable here: plan
 * mode means "produce a plan, then ask permission to act", so the agent raises
 * a permission request at the end of the turn. Unattended, nobody answers it,
 * and Paseo fails the call with
 * `OUTPUT_SCHEMA_FAILED: Agent is waiting for permission before producing
 * structured output` -- after the tokens are already paid for. Measured
 * 2026-09-22 on claude-sonnet-5. `auto` is the strictest mode on either
 * provider that still finishes a turn without a human.
 */
export function readOnlyMode(provider) {
  const family = provider.split("/")[0];
  if (family === "claude" || family === "codex") return { mode: "auto", enforced: false };
  return { mode: null, enforced: false };
}

/**
 * Action classes a script can be granted, split by blast radius rather than by
 * which CLI verb they use.
 *
 * `spawn`/`send`/`wait`/`read` are things the calling agent could already do
 * itself, so they are the default. The rest are not: `archive` destroys
 * another agent's session, and answering a permission request decides in a
 * person's place -- the one action this runtime must never make convenient.
 */
export const DEFAULT_GRANTS = ["spawn", "send", "wait", "read"];
export const ALL_GRANTS = [...DEFAULT_GRANTS, "archive", "gate:allow", "gate:deny"];

export class GrantError extends Error {
  constructor(action, grants) {
    super(`Action "${action}" is not granted to this script. Granted: ${grants.join(", ") || "(none)"}`);
    this.name = "GrantError";
    this.action = action;
    this.grants = grants;
  }
}

export class Orchestrator {
  /**
   * @param {{ audit?: Audit, roster?: object, cwd?: string, host?: string, grants?: string[] }} [options]
   */
  constructor(options = {}) {
    this.audit = options.audit ?? new Audit();
    this.roster = options.roster ?? null;
    this.cwd = options.cwd ?? process.cwd();
    this.host = options.host ?? null;
    this.grants = options.grants ?? DEFAULT_GRANTS;
    /** Unenforced constraints, collected so a script can report them honestly. */
    this.caveats = [];
  }

  static async create(options = {}) {
    const roster = options.roster ?? (await loadRoster());
    return new Orchestrator({ ...options, roster });
  }

  /**
   * What a role runs as. An unknown role is an error, not a default. A string
   * with a slash is a literal provider/model: no thinking level, no
   * instructions -- fine for a one-off, but a script that is kept should name
   * a role so the model can change without touching it.
   */
  resolve(role) {
    if (role.includes("/")) return { role: null, provider: role, thinking: null, instructions: "" };
    const entry = this.roster?.roles?.[role];
    if (!entry) {
      throw new Error(`Unknown role "${role}". Roles: ${Object.keys(this.roster?.roles ?? {}).join(", ")}`);
    }
    return { role, provider: entry.provider, thinking: entry.thinking ?? null, instructions: entry.instructions ?? "" };
  }

  provider(role) {
    return this.resolve(role).provider;
  }

  /**
   * Who runs one call.
   *
   * - `role` supplies provider, thinking and instructions.
   * - `provider` alone is a literal call: no role, no instructions.
   * - Neither: the default role.
   * - `role` plus a different `provider` runs the role's instructions on that
   *   model. If the role pins a thinking level this throws unless `thinking`
   *   is passed too: the level may not exist on the new model (opus-5-5 has
   *   no "off"), and dropping it would lower the depth silently -- the thing
   *   pinning it exists to prevent.
   * - An explicit `thinking` always wins.
   */
  #bind({ role, provider, thinking }) {
    const named = role ?? (provider ? null : (this.roster?.defaultRole ?? DEFAULT_ROLE));
    const entry = named === null ? null : this.resolve(named);
    const swapped = Boolean(provider) && provider !== entry?.provider;
    if (swapped && entry?.thinking && !thinking) {
      throw new Error(
        `Role "${entry.role}" pins thinking "${entry.thinking}" for ${entry.provider}. ` +
          `Running it on ${provider} needs an explicit { thinking } for that model.`,
      );
    }
    return {
      role: entry?.role ?? null,
      provider: provider ?? entry.provider,
      thinking: thinking ?? (swapped ? null : (entry?.thinking ?? null)),
      instructions: entry?.instructions ?? "",
    };
  }

  /** The prompt as sent: role instructions first, then the call's own prompt. */
  #compose(bound, prompt) {
    return bound.instructions ? `${bound.instructions}\n\n${prompt}` : prompt;
  }

  async #requireGrant(action, fields) {
    if (this.grants.includes(action)) return;
    await this.audit.record("grant.denied", { action, grants: this.grants, ...fields });
    throw new GrantError(action, this.grants);
  }

  #noteCaveat(text) {
    if (!this.caveats.includes(text)) this.caveats.push(text);
  }

  /**
   * Ask an agent to perform one step and return exactly what the step's schema
   * declares -- nothing wrapped, nothing added. Unenforced constraints land in
   * `this.caveats` instead of the result, so a caller can use the value
   * directly without unwrapping it.
   *
   * @param {ReturnType<import("./step.mjs").define>} step
   * @param {unknown} input passed to the step's prompt function
   * @param {{ role?: string, provider?: string, thinking?: string, title?: string, cwd?: string,
   *           labels?: Record<string,string>, timeout?: string, mode?: string }} [options]
   *   `mode` is required for a step that is not readOnly, and refused for one that is.
   */
  async ask(step, input, options = {}) {
    if (typeof step?.for !== "function") {
      throw new TypeError("ask() needs a step from step.define(); pass a prompt to run() instead");
    }
    const materialized = step.for(input);
    const { provider } = this.#bind(options);

    // A step that may write has to say how its tool calls get approved.
    // Left to Paseo, Claude runs in ask-first `default`: the first read outside
    // the workspace raises a request nobody answers, and the call fails with
    // OUTPUT_SCHEMA_FAILED after the tokens are spent (hotfix draft,
    // 2026-09-23). Which mode is safe enough to write in is the script's
    // decision, not a default this runtime should pick.
    let mode = options.mode;
    if (materialized.readOnly && mode) {
      throw new Error(`step "${step.name}" is readOnly; its mode comes from readOnlyMode(), do not pass one`);
    }
    if (!materialized.readOnly && !mode) {
      throw new Error(
        `step "${step.name}" is not readOnly, so it may write: pass { mode } explicitly. ` +
          `Paseo's default for Claude asks a person, and a structured call cannot wait for one.`,
      );
    }
    if (materialized.readOnly) {
      const readOnly = readOnlyMode(provider);
      mode = readOnly.mode ?? undefined;
      if (!readOnly.enforced) {
        this.#noteCaveat(
          `step "${step.name}" asked ${provider} not to edit, but it had write access throughout: ` +
            `no provider offers read-only without a human answering permissions`,
        );
      }
    }

    return this.run({
      role: options.role,
      provider: options.provider,
      thinking: options.thinking,
      mode,
      prompt: materialized.prompt,
      schema: materialized.schema,
      step: step.name,
      fingerprint: step.fingerprint,
      title: options.title ?? `[${step.name}]`,
      cwd: options.cwd,
      timeout: options.timeout ?? materialized.timeout,
      labels: options.labels,
    });
  }

  #baseArgs({ provider, thinking, title, mode, workspace, labels, step }) {
    const args = ["--provider", provider];
    if (thinking) args.push("--thinking", thinking);
    if (title) args.push("--title", sentTitle(title));
    if (mode) args.push("--mode", mode);
    if (workspace) args.push("--workspace", workspace);

    // Every agent this runtime starts is labelled with the run that started it.
    // `run --output-schema` does not return an agent id (it returns the agent's
    // structured output instead), so the label is the only way to find these
    // agents again for cost collection or cleanup.
    const all = { "orch-run": this.audit.runId, ...(step ? { "orch-step": step } : {}), ...(labels ?? {}) };
    for (const [key, value] of Object.entries(all)) args.push("--label", `${key}=${value}`);

    return args;
  }

  /**
   * Run an agent to completion.
   *
   * With `schema`, Paseo returns the agent's structured output as the command's
   * own JSON, so this resolves to the parsed object. Without one, it resolves
   * to Paseo's `{ agentId, status, ... }` descriptor.
   *
   * @param {{ role?: string, provider?: string, thinking?: string, prompt: string, schema?: object,
   *           title?: string, cwd?: string, mode?: string, timeout?: string,
   *           workspace?: string, labels?: Record<string,string>,
   *           step?: string, fingerprint?: string }} spec
   */
  async run(spec) {
    const bound = this.#bind(spec);
    const { provider, thinking } = bound;
    const prompt = this.#compose(bound, spec.prompt);
    const cwd = spec.cwd ?? this.cwd;

    await this.#requireGrant("spawn", { provider, step: spec.step ?? null });

    const args = [
      "run",
      ...this.#baseArgs({ ...spec, provider, thinking }),
      "--wait-timeout",
      spec.timeout ?? "30m",
    ];
    if (spec.schema) args.push("--output-schema", JSON.stringify(spec.schema));
    args.push(prompt);

    return this.audit.around(
      "agent.run",
      {
        provider,
        role: bound.role,
        thinking,
        step: spec.step ?? null,
        schemaFingerprint: spec.fingerprint ?? null,
        title: sentTitle(spec.title),
        cwd,
        mode: spec.mode ?? null,
        structured: Boolean(spec.schema),
        prompt,
      },
      () => runPaseoJson(args, { cwd, host: this.host }),
    );
  }

  /**
   * Start an agent without waiting. Returns Paseo's descriptor including agentId.
   *
   * Structured output is not available here: Paseo rejects `--output-schema`
   * together with `--background`. Parallelism therefore comes from running
   * several blocking `run()` calls at once, not from spawn-then-wait.
   */
  async spawn(spec) {
    if (spec.schema) {
      throw new Error("spawn() cannot take a schema: Paseo rejects --output-schema with --background. Use run().");
    }
    const bound = this.#bind(spec);
    const { provider, thinking } = bound;
    const prompt = this.#compose(bound, spec.prompt);
    const cwd = spec.cwd ?? this.cwd;

    await this.#requireGrant("spawn", { provider });

    const args = ["run", "--background", ...this.#baseArgs({ ...spec, provider, thinking }), prompt];
    return this.audit.around(
      "agent.spawn",
      { provider, role: bound.role, thinking, title: sentTitle(spec.title), cwd, mode: spec.mode ?? null, prompt },
      () => runPaseoJson(args, { cwd, host: this.host }),
    );
  }

  async send(agentId, prompt) {
    await this.#requireGrant("send", { agentId });
    return this.audit.around("agent.send", { agentId, prompt }, () =>
      runPaseoJson(["send", agentId, prompt], { cwd: this.cwd, host: this.host }),
    );
  }

  /**
   * Interrupt a running agent (a no-op if it is idle). Under the `send` grant:
   * like send, it steers a live agent and destroys nothing. A denied agent
   * keeps running rather than stopping itself (CONVENTIONS R8), so cleanup
   * needs this.
   */
  async stop(agentId) {
    await this.#requireGrant("send", { agentId });
    return this.audit.around("agent.stop", { agentId }, () =>
      runPaseoJson(["stop", agentId], { cwd: this.cwd, host: this.host }),
    );
  }

  /** Wait for an agent to go idle. `timeoutSec` omitted means no limit. */
  async wait(agentId, { timeoutSec } = {}) {
    const args = ["wait", agentId];
    if (timeoutSec !== undefined) args.push("--timeout", String(timeoutSec));
    return this.audit.around("agent.wait", { agentId, timeoutSec: timeoutSec ?? null }, () =>
      runPaseoJson(args, { cwd: this.cwd, host: this.host }),
    );
  }

  /** Note: `inspect --json` returns PascalCase keys, unlike `ls --json`. */
  async inspect(agentId) {
    return runPaseoJson(["inspect", agentId], { cwd: this.cwd, host: this.host });
  }

  /** Timeline text for an agent. Paseo renders this, so it is text, not JSON. */
  async transcript(agentId, { tail = 50, filter = "text" } = {}) {
    const args = ["logs", agentId, "--filter", filter];
    if (tail) args.push("--tail", String(tail));
    const { stdout } = await runPaseo(args, { cwd: this.cwd, host: this.host });
    return stdout;
  }

  /** Agents started by this run. `-g` is required: `ls` filters by cwd otherwise. */
  async ownAgents({ includeArchived = true } = {}) {
    const args = ["ls", "-g", ...(includeArchived ? ["-a"] : []), "--label", `orch-run=${this.audit.runId}`];
    return (await runPaseoJson(args, { cwd: this.cwd, host: this.host })) ?? [];
  }

  /**
   * Total spend for this run. Structured calls never return an agent id, so
   * the agents are found by label and inspected one at a time.
   *
   * `LastUsage` is the most recent turn, not a lifetime total: an agent driven
   * through several `send()` turns is undercounted here. Collect per turn if
   * that matters.
   */
  async collectCosts() {
    const found = await this.ownAgents();
    const agents = [];
    let totalUsd = 0;

    for (const entry of found) {
      const detail = await this.inspect(entry.id).catch(() => null);
      const usage = detail?.LastUsage ?? null;
      if (usage?.CostUsd) totalUsd += usage.CostUsd;
      agents.push({
        agentId: entry.id,
        name: entry.name ?? null,
        provider: entry.provider ?? null,
        lastTurnUsd: usage?.CostUsd ?? null,
        inputTokens: usage?.InputTokens ?? null,
        outputTokens: usage?.OutputTokens ?? null,
      });
    }

    return { totalUsd, agentCount: agents.length, agents, partial: "LastUsage covers the last turn only" };
  }

  async archive(agentId) {
    await this.#requireGrant("archive", { agentId });
    return this.audit.around("agent.archive", { agentId }, () =>
      runPaseoJson(["archive", agentId], { cwd: this.cwd, host: this.host }),
    );
  }

  // --- Human gate -------------------------------------------------------
  //
  // Paseo already owns the decision surface: an agent that needs permission
  // raises a request, a person answers it in the app, and `permit` is the same
  // queue. This runtime reads and records; it does not auto-answer.

  async pendingPermissions() {
    return runPaseoJson(["permit", "ls"], { cwd: this.cwd, host: this.host });
  }

  async allow(agentId, requestId) {
    await this.#requireGrant("gate:allow", { agentId, requestId: requestId ?? null });
    const args = ["permit", "allow", agentId];
    if (requestId) args.push(requestId);
    return this.audit.around("gate.allow", { agentId, requestId: requestId ?? null }, () =>
      runPaseoJson(args, { cwd: this.cwd, host: this.host }),
    );
  }

  /** `all` denies every pending request of the agent; `message` reaches the agent as the reason. */
  async deny(agentId, requestId, { all = false, message } = {}) {
    await this.#requireGrant("gate:deny", { agentId, requestId: requestId ?? null });
    const args = ["permit", "deny", agentId];
    if (requestId) args.push(requestId);
    if (all) args.push("--all");
    if (message) args.push("--message", message);
    return this.audit.around("gate.deny", { agentId, requestId: requestId ?? null, all, message: message ?? null }, () =>
      runPaseoJson(args, { cwd: this.cwd, host: this.host }),
    );
  }
}

export { PaseoCliError };
