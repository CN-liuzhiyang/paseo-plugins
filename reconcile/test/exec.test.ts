import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CLOSE_GRACE_MS, exec } from "../server/exec";

// A command stopped is stopped with what it started, and the run returns within a bound even
// when something it started still holds its output. The commands are scripts of the test's own:
// a parent that starts a child sharing its stdout, then sleeps (or exits).

const sleep = (n: number) => new Promise((resolve) => setTimeout(resolve, n));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
  return !alive(pid);
}
async function pidIn(file: string): Promise<number> {
  for (let i = 0; i < 200 && !(existsSync(file) && readFileSync(file, "utf8")); i++) await sleep(25);
  return Number(readFileSync(file, "utf8"));
}

/** A parent in node: starts a child that shares its stdout and lives on, writes the child's pid, then sleeps (or exits: `exit`). */
const NODE_PARENT = `const { spawn } = require("child_process");
const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "inherit"] });
require("fs").writeFileSync(process.argv[2], String(c.pid));
if (process.argv[3] === "exit") process.exit(0);
setInterval(() => {}, 1000);
`;
/** The same in Python, as an observing command is: it starts what it reads with (a child) on its own stdout. */
const PY_PARENT = `import subprocess, sys, time
p = subprocess.Popen([sys.argv[1], "-e", "setTimeout(() => {}, 30000)"], stdout=sys.stdout, stderr=sys.stderr)
open(sys.argv[2], "w").write(str(p.pid))
if len(sys.argv) > 3 and sys.argv[3] == "exit":
    sys.exit(0)
time.sleep(60)
`;

/** A Python on this machine, by asking it where it is; null when there is none (the Python cases are skipped). */
function python(): string | null {
  for (const name of ["python", "python3"]) {
    const r = spawnSync(name, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    const found = r.status === 0 ? r.stdout.trim() : "";
    if (found && existsSync(found)) return found;
  }
  return null;
}
const PY = python();
/** Each case is bounded: a run that does not return fails it instead of hanging the suite. */
const BOUND = { timeout: 20_000 };

function withDir(body: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-exec-"));
    try {
      await body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "a command that times out is stopped with what it started, and the run returns though that held its output",
  BOUND,
  withDir(async (dir) => {
    const parent = path.join(dir, "parent.cjs");
    writeFileSync(parent, NODE_PARENT);
    const pidFile = path.join(dir, "child.pid");
    const started = Date.now();
    const r = await exec([process.execPath, parent, pidFile], [], { timeoutMs: 800, input: "{}" });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 7_000, `returned after ${Date.now() - started} ms`);
    const child = await pidIn(pidFile);
    assert.equal(await gone(child), true, "the child it started is gone too");
  }),
);

test(
  "a command aborted is stopped the same way, and says so",
  BOUND,
  withDir(async (dir) => {
    const parent = path.join(dir, "parent.cjs");
    writeFileSync(parent, NODE_PARENT);
    const pidFile = path.join(dir, "child.pid");
    const abort = new AbortController();
    const pending = exec([process.execPath, parent, pidFile], [], { timeoutMs: 60_000, input: "{}", signal: abort.signal });
    const child = await pidIn(pidFile);
    assert.ok(alive(child));
    abort.abort();
    const r = await pending;
    assert.deepEqual([r.aborted, r.timedOut], [true, false]);
    assert.equal(await gone(child), true);
  }),
);

// In Python when there is one: its child holds the output open (a node child here may not).
test(
  "a command that exits leaving something on its output returns soon after it exits",
  BOUND,
  withDir(async (dir) => {
    const parent = path.join(dir, PY ? "parent.py" : "parent.cjs");
    writeFileSync(parent, PY ? PY_PARENT : NODE_PARENT);
    const pidFile = path.join(dir, "child.pid");
    const started = Date.now();
    const command = PY ? [PY, parent, process.execPath, pidFile, "exit"] : [process.execPath, parent, pidFile, "exit"];
    const r = await exec(command, [], { timeoutMs: 60_000, input: "{}" });
    const child = await pidIn(pidFile);
    try {
      assert.deepEqual([r.code, r.timedOut], [0, false]);
      assert.ok(Date.now() - started < CLOSE_GRACE_MS + 3_000, `returned after ${Date.now() - started} ms`);
    } finally {
      if (alive(child)) process.kill(child);
    }
  }),
);

// No Python here: skipped, and the node cases above stand for it.
test(
  "a Python command that times out is stopped with the child it started on its output",
  { ...BOUND, skip: PY ? false : "no python on this machine" },
  withDir(async (dir) => {
    const py = PY!;
    const parent = path.join(dir, "parent.py");
    writeFileSync(parent, PY_PARENT);
    const pidFile = path.join(dir, "child.pid");
    const started = Date.now();
    const r = await exec([py, parent, process.execPath, pidFile], [], { timeoutMs: 1_500, input: "{}" });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 8_000, `returned after ${Date.now() - started} ms`);
    const child = await pidIn(pidFile);
    assert.equal(await gone(child), true, "the child it started is gone too");
  }),
);

// Run in a process of its own, with nothing of the test's on its stdio: it ends only when nothing
// holds it open, so it ending soon after says the pipes the child holds were let go of.
test(
  "the pipes of a command that exits leaving something on its output are let go of: the process that ran it can end",
  BOUND,
  withDir(async (dir) => {
    const parent = path.join(dir, PY ? "parent.py" : "parent.cjs");
    writeFileSync(parent, PY ? PY_PARENT : NODE_PARENT);
    const pidFile = path.join(dir, "child.pid");
    const command = PY ? [PY, parent, process.execPath, pidFile, "exit"] : [process.execPath, parent, pidFile, "exit"];
    const runner = path.join(dir, "runner.mts");
    const execUrl = pathToFileURL(path.join(import.meta.dirname, "..", "server", "exec.ts")).href;
    writeFileSync(runner, `import { exec } from ${JSON.stringify(execUrl)};\nawait exec(${JSON.stringify(command)}, [], { timeoutMs: 60000, input: "{}" });\n`);
    const started = Date.now();
    const r = spawnSync(process.execPath, ["--import", "tsx", runner], { cwd: path.join(import.meta.dirname, ".."), stdio: "ignore", windowsHide: true, timeout: 15_000 });
    const child = await pidIn(pidFile);
    try {
      assert.equal(r.status, 0);
      assert.ok(Date.now() - started < CLOSE_GRACE_MS + 6_000, `ended after ${Date.now() - started} ms`);
    } finally {
      if (alive(child)) process.kill(child);
    }
  }),
);

test("what is handed on stdin arrives whole, then its end; a command that exits without reading it is not an error", BOUND, async () => {
  const input = "汉".repeat(350_000);
  const read = await exec([process.execPath, "-e", "let n = 0; process.stdin.on('data', (d) => (n += d.length)); process.stdin.on('end', () => process.stdout.write(String(n)));"], [], { timeoutMs: 15_000, input });
  assert.deepEqual([read.code, Number(read.stdout)], [0, Buffer.byteLength(input, "utf8")]);
  const early = await exec([process.execPath, "-e", "process.exit(0)"], [], { timeoutMs: 15_000, input });
  assert.equal(early.code, 0);
});
