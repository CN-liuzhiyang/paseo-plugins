import { spawn } from "node:child_process";

// The one way a source runs a command: an argument array, no shell, hidden window, a timeout,
// and a cap on what is kept of its output (past it the command is stopped and what came so far
// is returned, marked truncated).
// No shell because on Windows a .cmd/.ps1 shim goes through cmd.exe or PowerShell, which
// mangle Chinese text and inline JSON; sources name the real entry instead ("node <…>/cli.js").

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  /** The output went past maxBytes: stdout is its beginning. */
  truncated?: boolean;
}

export type Exec = (command: string[], args: string[], options: { timeoutMs: number; maxBytes?: number }) => Promise<ExecResult>;

const MAX_BYTES = 16 * 1024 * 1024;

export const exec: Exec = (command, args, { timeoutMs, maxBytes = MAX_BYTES }) =>
  new Promise((resolve) => {
    const started = Date.now();
    const [file, ...prefix] = command;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file!, [...prefix, ...args], { shell: false, windowsHide: true, env: process.env });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: (error as Error).message, ms: 0, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (truncated) return;
      stdout += chunk;
      if (stdout.length > maxBytes) {
        stdout = stdout.slice(0, maxBytes);
        truncated = true;
        child.kill();
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + error.message, ms: Date.now() - started, timedOut, truncated });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut, truncated });
    });
  });
