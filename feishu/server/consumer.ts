import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { LarkCli } from "./lark";

export interface Consumer {
  stop(): Promise<void>;
}

const READY = "[event] ready event_key=";
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
// A consumer that stayed up this long was healthy; its next failure starts the backoff over.
const HEALTHY_MS = 60_000;
const STOP_GRACE_MS = 5_000;

/**
 * Keeps one `lark-cli event consume <eventKey>` running and hands each event to `onEvent`.
 *
 * One process per event key: lark-cli takes exactly one. Its stdin stays open for the process's
 * whole life, because EOF on stdin is how lark-cli is told to exit; stopping closes it rather than
 * killing, which would skip lark-cli's own unsubscribe. `--quiet` is never passed: it also hides
 * the warnings that say events were dropped.
 */
export function consume(options: {
  cli: LarkCli;
  eventKey: string;
  onEvent: (event: Record<string, unknown>) => void;
  log: (line: string) => void;
}): Consumer {
  const { cli, eventKey, onEvent, log } = options;
  let child: ChildProcessWithoutNullStreams | null = null;
  let stopping = false;
  let backoff = MIN_BACKOFF_MS;
  let retry: NodeJS.Timeout | null = null;
  let exited: Promise<void> = Promise.resolve();

  const start = () => {
    retry = null;
    const startedAt = Date.now();
    const current = spawn(
      cli.path,
      ["--profile", cli.profile, "event", "consume", eventKey, "--as", "bot"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    child = current;
    let ready = false;
    let lastStderr = "";
    exited = new Promise((resolve) => current.on("close", () => resolve()));

    // Nothing on stdout counts until the ready marker shows up on stderr.
    createInterface({ input: current.stdout }).on("line", (line) => {
      if (!ready || line.trim() === "") return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        log(`${eventKey}: unreadable event line: ${line.slice(0, 200)}`);
        return;
      }
      if (event !== null && typeof event === "object") onEvent(event as Record<string, unknown>);
    });
    createInterface({ input: current.stderr }).on("line", (line) => {
      if (line.trim() === "") return;
      lastStderr = line;
      if (line.startsWith(READY)) {
        ready = true;
        log(`${eventKey}: consuming`);
        return;
      }
      log(`${eventKey}: ${line}`);
    });

    current.on("error", (error) => log(`${eventKey}: could not start ${cli.path}: ${error.message}`));
    current.on("close", (code) => {
      if (child === current) child = null;
      if (stopping) return;
      if (Date.now() - startedAt >= HEALTHY_MS) backoff = MIN_BACKOFF_MS;
      log(`${eventKey}: exited ${code} (${lastStderr || "no output"}); restarting in ${backoff / 1000}s`);
      retry = setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });
  };

  start();

  return {
    async stop() {
      stopping = true;
      if (retry) clearTimeout(retry);
      const current = child;
      if (!current) return;
      current.stdin.end();
      const timer = setTimeout(() => current.kill(), STOP_GRACE_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}
