import os from "node:os";
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
