import { spawn, type ChildProcess } from "node:child_process";

// The one way a source runs a command: an argument array, no shell, hidden window, a timeout,
// and a cap on what is kept of its output (past it the command is stopped and what came so far
// is returned, marked truncated). `input` is written to its stdin, which is then closed.
// No shell because on Windows a .cmd/.ps1 shim goes through cmd.exe or PowerShell, which
// mangle Chinese text and inline JSON; sources name the real entry instead ("node <…>/cli.js").
//
// A command stopped (timed out, too much output, `signal` aborted) is stopped with what it
// started: on Windows `taskkill /T /F`, elsewhere its process group. And it returns within a
// bound even when something it left behind still holds its output open: past that the pipes are
// let go of.

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  /** The output went past maxBytes: stdout is its beginning. */
  truncated?: boolean;
  /** Stopped because `signal` was aborted. */
  aborted?: boolean;
}

export type Exec = (
  command: string[],
  args: string[],
  options: { timeoutMs: number; maxBytes?: number; input?: string; cwd?: string; signal?: AbortSignal },
) => Promise<ExecResult>;

const MAX_BYTES = 16 * 1024 * 1024;
/** After the command exits, how long its output may take to close (what it started may hold it). */
export const CLOSE_GRACE_MS = 2_000;
/** After it is stopped, how long before it is given up on, its pipes let go of. */
export const KILL_GRACE_MS = 5_000;

/** Stops a process and what it started. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { shell: false, windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    // Its own process group (detached below): the group goes, what it started with it.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export const exec: Exec = (command, args, { timeoutMs, maxBytes = MAX_BYTES, input, cwd, signal }) =>
  new Promise((resolve) => {
    const started = Date.now();
    const [file, ...prefix] = command;
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let aborted = false;
    let done = false;
    let child: ChildProcess;
    if (signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", ms: 0, timedOut: false, aborted: true });
      return;
    }
    try {
      child = spawn(file!, [...prefix, ...args], {
        shell: false,
        windowsHide: true,
        env: process.env,
        ...(cwd ? { cwd } : {}),
        ...(process.platform === "win32" ? {} : { detached: true }),
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: (error as Error).message, ms: 0, timedOut: false });
      return;
    }
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const finish = (code: number | null, extra = "") => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      // Let go of its pipes: what still holds the other end (a child it left) keeps nothing here waiting.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: stderr + extra, ms: Date.now() - started, timedOut, truncated, ...(aborted ? { aborted } : {}) });
    };
    let stopping = false;
    // Exited already (its output not closed yet): nothing to stop, and its id may be another's by now.
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    /** Stops it, marking why (`mark`), unless it has exited already: then it is not stopped, nor marked. */
    const stop = (mark: () => void) => {
      if (stopping || exited()) return;
      mark();
      stopping = true;
      killTree(child);
      timers.push(setTimeout(() => finish(null), KILL_GRACE_MS));
    };
    const onAbort = () => stop(() => (aborted = true));
    signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => stop(() => (timedOut = true)), timeoutMs));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      // Bytes, as it wrote them: the cap is on what is kept.
      if (outBytes + chunk.length > maxBytes) {
        out.push(chunk.subarray(0, maxBytes - outBytes));
        outBytes = maxBytes;
        truncated = true;
        stop(() => {});
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    if (input !== undefined) {
      // A command that exits without reading it all is not an error here; its exit code says.
      child.stdin?.on("error", () => {});
      // Written, then closed (it reads what was written, then the end): not ended, as ending a pipe
      // on Windows waits for whatever holds its other end to read it all, and a child the command
      // left may hold it and never read.
      child.stdin?.write(input, "utf8", () => child.stdin?.destroy());
    }
    child.on("error", (error) => finish(null, error.message));
    // Exited: what it started may still hold its output; that is waited for only so long.
    child.on("exit", (code) => !done && timers.push(setTimeout(() => finish(code), CLOSE_GRACE_MS)));
    child.on("close", (code) => finish(code));
  });
