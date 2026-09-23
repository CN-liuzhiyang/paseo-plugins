import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The record of the human gate: what was asked, who allowed or denied it, how long it waited, and
// every click that was refused. Same shape as the orchestration runtime's audit -- one JSONL file
// per UTC day, `id` / `ts` / `kind` on every line -- so one evaluation pass can read both. The
// records name people and hold full tool input: keep them out of repositories.

export type Audit = (kind: string, fields: Record<string, unknown>) => void;

/** `<PASEO_HOME>/plugin-data/feishu/audit`, resolving PASEO_HOME the way the daemon does. */
export function defaultAuditDir(env: NodeJS.ProcessEnv = process.env): string {
  // Plugin processes inherit the daemon's environment, so this is the daemon's own home.
  const raw = env.PASEO_HOME ?? "~/.paseo";
  const home = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.join(path.resolve(home), "plugin-data", "feishu", "audit");
}

export function createAudit(options: {
  dir: () => Promise<string>;
  log: (line: string) => void;
}): Audit {
  let writes = Promise.resolve();
  return (kind, fields) => {
    const ts = new Date().toISOString();
    const line = `${JSON.stringify({ id: randomUUID(), ts, kind, ...fields })}\n`;
    // In order, and never in the way: an approval does not wait for its record to be written.
    writes = writes
      .then(async () => {
        const dir = await options.dir();
        await mkdir(dir, { recursive: true });
        await appendFile(path.join(dir, `${ts.slice(0, 10)}.jsonl`), line, "utf8");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        options.log(`audit ${kind} not written: ${message}`);
      });
  };
}
