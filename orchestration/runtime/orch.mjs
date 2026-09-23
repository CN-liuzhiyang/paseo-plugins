// The entry point an agent calls.
//
//   node runtime/orch.mjs eval <file|-> [--grants spawn,send] [--name x] [--timeout ms]
//
// Reads a JavaScript source, runs it with the orchestration objects in scope,
// and prints one JSON object. Everything handed back to the model is also in
// the audit log.
//
// The script is NOT sandboxed, by design: it runs in this process with full
// Node access, and safety comes from the audit trail, the grant list, and the
// fact that only a local caller can reach this file. Do not add a sandbox here
// and then rely on it -- an escape would be silent.
//
// Scripts are wrapped in an async function rather than run through node:vm.
// A fresh vm context would hide Node's globals from the script, which fights
// the full-access decision above; an async function body gives the same "no
// shared script variables" property without pretending to isolate anything.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Orchestrator, DEFAULT_GRANTS, ALL_GRANTS, NO_EDITS_SUFFIX, readOnlyMode } from "./agents.mjs";
import { Audit } from "./audit.mjs";
import * as step from "./step.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function readSource(target) {
  if (target === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(target, "utf8");
}

/**
 * @param {string} source
 * @param {{ name?: string, grants?: string[], timeoutMs?: number, cwd?: string, host?: string }} [options]
 */
export async function evaluate(source, options = {}) {
  const audit = new Audit({ script: options.name ?? "(inline)" });
  const grants = options.grants ?? DEFAULT_GRANTS;
  const orch = await Orchestrator.create({ audit, grants, cwd: options.cwd, host: options.host });

  const logs = [];
  const log = {
    info: (...args) => logs.push({ level: "info", message: args.map(String).join(" ") }),
    warn: (...args) => logs.push({ level: "warn", message: args.map(String).join(" ") }),
    error: (...args) => logs.push({ level: "error", message: args.map(String).join(" ") }),
  };

  const ctx = {
    caller: process.env.PASEO_AGENT_ID ?? null,
    cwd: orch.cwd,
    host: orch.host,
    grants,
    runId: audit.runId,
  };

  await audit.record("script.start", { grants, source, sourceLength: source.length });

  const startedAt = Date.now();
  let timer = null;

  // Settling is the same work whether the script returned or threw: the spend
  // already happened, and a failed run is exactly when its cost and its
  // unenforced constraints matter most.
  const settle = async (outcome) => {
    const startedAgents = audit.entries.some((e) => e.kind === "agent.run" || e.kind === "agent.spawn");
    const cost = startedAgents ? await orch.collectCosts().catch(() => null) : null;
    const caveats = orch.caveats.length > 0 ? [...orch.caveats] : null;

    const entry = await audit.record("script.end", {
      ...outcome,
      durationMs: Date.now() - startedAt,
      logs,
      cost,
      caveats,
    });

    return { auditId: entry.id, runId: audit.runId, durationMs: entry.durationMs, cost, caveats, logs };
  };

  try {
    const body = new AsyncFunction("agents", "log", "ctx", "roster", "step", source);
    const run = body(orch, log, ctx, orch.roster, step);

    const value = await (options.timeoutMs
      ? Promise.race([
          run,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Script exceeded ${options.timeoutMs}ms`)), options.timeoutMs);
          }),
        ])
      : run);

    return { ok: true, value, ...(await settle({ ok: true, value })) };
  } catch (error) {
    const settled = await settle({
      ok: false,
      error: { message: error.message, name: error.name, stack: error.stack },
    });
    return { ok: false, error: { message: error.message, name: error.name }, ...settled };
  } finally {
    if (timer) clearTimeout(timer);
    // A script that timed out may have left agents running. They are not
    // killed: the caller decides, and `cost.agents` names them.
  }
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, target, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (command !== "eval" || !target) {
    console.error("Usage: node runtime/orch.mjs eval <file|-> [--grants a,b] [--name x] [--timeout ms]");
    console.error(`Grants: ${ALL_GRANTS.join(", ")} (default: ${DEFAULT_GRANTS.join(", ")})`);
    process.exit(2);
  }

  const result = await evaluate(await readSource(target), {
    name: flags.name ?? (target === "-" ? "(stdin)" : path.basename(target)),
    grants: flags.grants ? flags.grants.split(",") : undefined,
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    cwd: flags.cwd,
    host: flags.host,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

export { NO_EDITS_SUFFIX, readOnlyMode };
