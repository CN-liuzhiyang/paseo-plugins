// Append-only audit of everything the orchestrator asked an agent to do.
//
// Two rules this file exists to enforce:
//   - Model-visible implies logged. Every value a script hands back to a model
//     has the same value in a log line.
//   - Prompts are stored in full, not summarized. an evaluation corpus is built
//     from these files, and a summary cannot be replayed.
//
// One JSONL file per day. Appends are atomic enough for concurrent scripts in
// one process; cross-process interleaving is acceptable because each line is
// written in a single append.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_HOME, loadConfig } from "./config.mjs";

// Outside the checkout: the logs hold full prompts and agent output, and this
// code lives in a public repository.
const DEFAULT_LOG_DIR = path.join(CONFIG_HOME, "logs");

function today() {
  return new Date().toISOString().slice(0, 10);
}

export class Audit {
  /**
   * @param {{ dir?: string, runId?: string, script?: string, caller?: string }} [options]
   */
  constructor(options = {}) {
    this.dir = options.dir ?? process.env.ORCH_LOG_DIR ?? loadConfig().logDir ?? DEFAULT_LOG_DIR;
    this.runId = options.runId ?? randomUUID();
    this.script = options.script ?? null;
    this.caller = options.caller ?? process.env.PASEO_AGENT_ID ?? null;
    this.entries = [];
  }

  /**
   * Record one event. Returns the entry so callers can attach an id to
   * whatever they return to the model.
   *
   * @param {string} kind e.g. "agent.run", "agent.wait", "gate.ask", "script.start"
   * @param {Record<string, unknown>} fields
   */
  async record(kind, fields = {}) {
    const entry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      runId: this.runId,
      script: this.script,
      caller: this.caller,
      kind,
      ...fields,
    };

    this.entries.push(entry);

    await mkdir(this.dir, { recursive: true });
    await appendFile(path.join(this.dir, `${today()}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");

    return entry;
  }

  /** Wrap an async operation: one line on start is skipped, one on settle. */
  async around(kind, fields, operation) {
    const startedAt = Date.now();
    try {
      const value = await operation();
      await this.record(kind, { ...fields, ok: true, durationMs: Date.now() - startedAt, result: value });
      return value;
    } catch (error) {
      await this.record(kind, {
        ...fields,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: { message: error.message, name: error.name, stderr: error.stderr?.slice?.(0, 2000) },
      });
      throw error;
    }
  }
}
