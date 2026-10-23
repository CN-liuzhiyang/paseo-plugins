import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import { classify } from "../shared/liveness.mjs";
import type { ProcessCheck } from "../shared/run";

// Is the runtime process of an unfinished run still there? Only answerable on the machine that
// ran it: the run names its pid and hostname, and a pid means nothing on another host.

export type Kill = (pid: number, signal: 0) => unknown;

export interface Probe {
  hostname: string;
  kill: Kill;
}

export const localProbe: Probe = {
  hostname: os.hostname(),
  kill: (pid, signal) => process.kill(pid, signal),
};

/**
 * Whether the run that wrote `eventsFile` is alive, for a run that has written run.start and not
 * run.end. The word is the claim's (`<runId>.claim` beside the events, shared/liveness.mjs): touched
 * within two minutes is alive. The pid is asked as well, but only to show death: it is gone on this
 * machine and the run is dead whatever the claim says; present, it proves nothing. A file without a
 * claim (written before claims existed) is answered by the pid alone, as it always was.
 * `null` when there is nothing to go by.
 */
export async function checkLiveness(
  eventsFile: string,
  start: { pid: number | null; hostname: string | null } | null,
  probe: Probe,
  now: number,
): Promise<ProcessCheck | null> {
  const claimFile = eventsFile.replace(/\.jsonl$/, ".claim");
  let touched: number;
  try {
    touched = (await stat(claimFile)).mtimeMs;
  } catch {
    return checkProcess(start, probe);
  }
  let body: { pid?: unknown; hostname?: unknown; refused?: unknown } | null = null;
  try {
    const parsed = JSON.parse(await readFile(claimFile, "utf8"));
    body = parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    body = null;
  }
  // The holder is whoever the claim names; a claim that cannot be read yet falls back to run.start.
  const pid = typeof body?.pid === "number" ? body.pid : (start?.pid ?? null);
  const hostname = typeof body?.hostname === "string" ? body.hostname : (start?.hostname ?? null);
  const seen = checkProcess({ pid, hostname }, probe);
  const verdict = classify({
    claim: { ageMs: now - touched, refused: typeof body?.refused === "string", unreadable: body === null },
    events: "open",
    pid: seen === null ? "unknown" : seen.alive ? "alive" : "gone",
  });
  return { pid, alive: verdict.state !== "lost", gone: seen === null ? null : !seen.alive };
}

/** `null` when it cannot be checked: another host, no pid (older files), or an unexpected error. */
export function checkProcess(
  start: { pid: number | null; hostname: string | null } | null,
  probe: Probe,
): ProcessCheck | null {
  if (!start || start.pid === null || !start.hostname) return null;
  if (start.hostname.toLowerCase() !== probe.hostname.toLowerCase()) return null;
  try {
    probe.kill(start.pid, 0);
    return { pid: start.pid, alive: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM: it exists, we just may not signal it.
    if (code === "EPERM") return { pid: start.pid, alive: true };
    if (code === "ESRCH") return { pid: start.pid, alive: false };
    return null;
  }
}
