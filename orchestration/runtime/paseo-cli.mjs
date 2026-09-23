// Paseo CLI 的调用层。
//
// 为什么不直接 spawn paseo.cmd：Windows 上 .cmd 只能经 cmd.exe 启动，Node 要么
// shell:true（把参数拼成一行命令，中文 prompt、引号、换行都要自己转义，在这台
// 机器上已经踩过 PowerShell 同类坑），要么根本起不来。paseo.cmd 本身只是设四个
// 环境变量再调 Paseo.exe，所以这里复现它，参数以数组传给 CreateProcessW，
// 转义和编码都交给 Node。
//
// 代价是依赖 Paseo 安装目录的内部布局。启动前显式检查三个路径，缺了就报错说
// 该改哪个配置，不猜、不退回 .cmd。只支持 Windows：别的平台上 paseo 是普通
// 可执行文件，本来就不需要这一层，但那条路径还没实测过。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";

export const COMMAND_LINE_BUDGET = 32_000;
// Where the Windows installer puts Paseo for the current user. A fork build or
// a second install lives elsewhere; name it in config.json (`paseoInstallDir`).
const DEFAULT_INSTALL_DIR = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Paseo");

export class PaseoCliError extends Error {
  constructor(message, { argv, exitCode, stdout, stderr }) {
    super(message);
    this.name = "PaseoCliError";
    this.argv = argv;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function resolveLaunch(installDir) {
  const dir = installDir ?? process.env.PASEO_INSTALL_DIR ?? loadConfig().paseoInstallDir ?? DEFAULT_INSTALL_DIR;
  const resources = path.join(dir, "resources");
  const launch = {
    exe: path.join(dir, "Paseo.exe"),
    runner: path.join(resources, "app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js"),
    cli: path.join(resources, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js"),
  };

  // app.asar is an archive, so existsSync on the cli path inside it is a
  // directory-entry check that Node cannot do. Check the archive instead.
  const archive = path.join(resources, "app.asar");
  for (const [label, target] of [
    ["Paseo.exe", launch.exe],
    ["node-entrypoint-runner.js", launch.runner],
    ["app.asar", archive],
  ]) {
    if (!existsSync(target)) {
      throw new PaseoCliError(
        `Paseo install looks wrong: ${label} not found at ${target}. ` +
          `Set paseoInstallDir in ~/.paseo-orchestration/config.json (or PASEO_INSTALL_DIR) to the install directory.`,
        { argv: [], exitCode: null, stdout: "", stderr: "" },
      );
    }
  }

  return launch;
}

/**
 * Run one paseo CLI invocation.
 *
 * @param {string[]} args argv after `paseo`, e.g. ["run", "--json", prompt]
 * @param {{ timeoutMs?: number, cwd?: string, installDir?: string, host?: string }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runPaseo(args, options = {}) {
  const { timeoutMs, cwd, installDir, host } = options;
  const launch = resolveLaunch(installDir);
  const argv = host ? ["--host", host, ...args] : [...args];

  // Windows caps a command line at 32767 characters, and `paseo run` takes the
  // prompt only as an argument -- no stdin, no file (cli/src/commands/agent/run.ts).
  // Past the cap Node fails with a bare ENAMETOOLONG; say what it means instead.
  // Quoting grows the line a little, hence the margin.
  const length = [launch.exe, launch.runner, launch.cli, ...argv].reduce((sum, a) => sum + a.length + 3, 0);
  if (length > COMMAND_LINE_BUDGET) {
    return Promise.reject(
      new PaseoCliError(
        `paseo ${argv[0]}: command line is ${length} characters, over the ${COMMAND_LINE_BUDGET} this runtime allows ` +
          `(Windows caps it at 32767, and Paseo takes the prompt only as an argument). ` +
          `Hand large inputs to the agent as file paths to read.`,
        { argv: argv.map((a) => (a.length > 200 ? `${a.slice(0, 200)}...(${a.length})` : a)), exitCode: null, stdout: "", stderr: "" },
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      launch.exe,
      ["--disable-warning=DEP0040", launch.runner, "node-script", launch.cli, ...argv],
      {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PASEO_NODE_ENV: "production",
          PASEO_DESKTOP_MANAGED: "1",
        },
      },
    );

    let stdout = "";
    let stderr = "";
    let timer = null;
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
    }

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(new PaseoCliError(`Could not start Paseo: ${error.message}`, { argv, exitCode: null, stdout, stderr }));
    });

    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new PaseoCliError(`paseo ${argv[0]} exceeded ${timeoutMs}ms`, { argv, exitCode, stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
    });
  });
}

/**
 * Run one paseo CLI invocation with --json and parse stdout.
 *
 * A non-zero exit throws; the CLI's own stderr is carried on the error so the
 * caller reports what Paseo said rather than a parse failure downstream.
 */
/**
 * Known CLI error codes whose cause is not obvious from the message alone.
 * The hint is what the next person needs in order to act, not a restatement.
 */
const ERROR_HINTS = {
  OUTPUT_SCHEMA_FAILED:
    "The agent raised a permission request and nothing answered it, so it never produced structured output. " +
    "Unattended structured calls must use a mode that finishes without a human -- notably not Claude's `plan` " +
    "mode, which always asks at the end of a turn. See readOnlyMode() in runtime/agents.mjs.",
  INVALID_OUTPUT_SCHEMA:
    "Paseo could not parse the schema JSON. If this came from a shell, quoting ate it: pass arguments as an " +
    "array through runtime/paseo-cli.mjs rather than through cmd.exe or PowerShell.",
};

function describeFailure(argv, exitCode, stdout, stderr) {
  const raw = stderr.trim() || stdout.trim();
  try {
    const parsed = JSON.parse(raw);
    const code = parsed?.error?.code;
    if (code) {
      const hint = ERROR_HINTS[code];
      return `paseo ${argv[0]} failed: ${code} -- ${parsed.error.message}${hint ? `\n\n${hint}` : ""}`;
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return `paseo ${argv[0]} exited ${exitCode}: ${raw}`;
}

export async function runPaseoJson(args, options = {}) {
  const argv = args.includes("--json") ? args : [...args, "--json"];
  const { stdout, stderr, exitCode } = await runPaseo(argv, options);

  if (exitCode !== 0) {
    throw new PaseoCliError(describeFailure(argv, exitCode, stdout, stderr), {
      argv,
      exitCode,
      stdout,
      stderr,
    });
  }

  const text = stdout.trim();
  if (text === "") return null;

  try {
    return JSON.parse(text);
  } catch {
    throw new PaseoCliError(`paseo ${argv[0]} did not return JSON: ${text.slice(0, 400)}`, {
      argv,
      exitCode,
      stdout,
      stderr,
    });
  }
}
