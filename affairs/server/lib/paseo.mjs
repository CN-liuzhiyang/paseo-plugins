import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The paseo CLI, called with an argument array. paseo.cmd goes through cmd.exe, which splits "30 9 3 11 *" and mangles
// Chinese; the Windows install is started the way paseo.cmd itself starts it. PASEO_BIN names a script to run with
// node instead (the tests' fake paseo).

const installDirOf = () => {
  const named = process.env.PASEO_INSTALL_DIR;
  if (named) return named;
  if (/^paseo(fork)?\.exe$/i.test(path.basename(process.execPath))) return path.dirname(process.execPath);
  try {
    const dir = JSON.parse(readFileSync(path.join(os.homedir(), ".paseo-orchestration", "config.json"), "utf8")).paseoInstallDir;
    if (typeof dir === "string" && dir) return dir;
  } catch {
    // no machine config
  }
  return null;
};

function launch() {
  if (process.env.PASEO_BIN) return { exe: process.execPath, head: [process.env.PASEO_BIN], env: {} };
  if (process.platform === "win32") {
    const dir = installDirOf();
    if (!dir) throw new Error("找不到 Paseo 的安装目录：设 PASEO_INSTALL_DIR，或在 ~/.paseo-orchestration/config.json 里写 paseoInstallDir");
    const resources = path.join(dir, "resources");
    const runner = path.join(resources, "app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js");
    const cli = path.join(resources, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js");
    if (!existsSync(path.join(dir, "Paseo.exe")) || !existsSync(runner)) throw new Error(`Paseo 安装目录不对：${dir}`);
    return { exe: path.join(dir, "Paseo.exe"), head: ["--disable-warning=DEP0040", runner, "node-script", cli], env: { ELECTRON_RUN_AS_NODE: "1", PASEO_NODE_ENV: "production", PASEO_DESKTOP_MANAGED: "1" } };
  }
  return { exe: "paseo", head: [], env: {} };
}

/** @returns {(args: string[]) => Promise<{stdout: string, stderr: string, exitCode: number}>} a runner bound to one daemon home (null: the default). */
export function makeRun({ home = process.env.PASEO_HOME || null, timeoutMs = 60_000 } = {}) {
  // detachAfterMs: a command that stays running past that long (run-once waits for the whole look) is let go of, not waited for.
  return (args, { detachAfterMs = 0 } = {}) =>
    new Promise((resolve, reject) => {
      const { exe, head, env } = launch();
      const argv = [...args, ...(home ? ["--home", home] : [])];
      const child = spawn(exe, [...head, ...argv], { windowsHide: true, env: { ...process.env, ...env } });
      let stdout = "";
      let stderr = "";
      const timer = detachAfterMs
        ? setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            resolve({ stdout, stderr, exitCode: 0, detached: true });
          }, detachAfterMs)
        : setTimeout(() => child.kill(), timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
      child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
      });
    });
}

/** Runs a command that prints JSON; a failure carries what the CLI said. */
export async function json(run, args, options) {
  const { stdout, stderr, exitCode, detached } = await run([...args, "--json"], options);
  if (detached) return {};
  if (exitCode !== 0) throw new Error(`paseo ${args.slice(0, 2).join(" ")} 失败：${(stderr || stdout).trim().split("\n")[0]}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`paseo ${args.slice(0, 2).join(" ")} 的输出读不懂：${stdout.slice(0, 120)}`);
  }
}
