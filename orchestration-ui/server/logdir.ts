import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LogDirInfo } from "../shared/rpc";

// The same order the runtime uses (orchestration/runtime/config.mjs, EVENTS.md): ORCH_LOG_DIR,
// then logDir in the config file (ORCH_CONFIG or ~/.paseo-orchestration/config.json), then
// ~/.paseo-orchestration/logs. The plugin setting, when set, comes before all of them: the
// daemon's environment is not necessarily the one the flows ran in.

export type Resolved = { ok: true; info: LogDirInfo } | { ok: false; detail: string };

export interface Where {
  override: string;
  env: NodeJS.ProcessEnv;
  home: string;
  read?: (file: string) => Promise<string>;
}

function info(logDir: string, source: LogDirInfo["source"], configFile: string | null): Resolved {
  return { ok: true, info: { logDir, runsDir: path.join(logDir, "runs"), source, configFile } };
}

export async function resolveLogDir({ override, env, home, read = (file) => readFile(file, "utf8") }: Where): Promise<Resolved> {
  if (override.trim() !== "") return info(override.trim(), "settings", null);
  if (env.ORCH_LOG_DIR) return info(env.ORCH_LOG_DIR, "env", null);
  const configHome = path.join(home, ".paseo-orchestration");
  const file = env.ORCH_CONFIG ?? path.join(configHome, "config.json");
  let source: string | null;
  try {
    source = await read(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only an absent default file means "no settings", as in the runtime.
    if (code !== "ENOENT" || env.ORCH_CONFIG) {
      return { ok: false, detail: `读不了配置文件 ${file}（${code ?? String(error)}）` };
    }
    source = null;
  }
  if (source !== null) {
    let value: unknown;
    try {
      value = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
    } catch (error) {
      return { ok: false, detail: `配置文件 ${file} 不是合法的 JSON（${(error as Error).message}）` };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, detail: `配置文件 ${file} 必须是一个 JSON 对象` };
    }
    const logDir = (value as Record<string, unknown>).logDir;
    if (logDir !== undefined) {
      if (typeof logDir !== "string" || logDir === "") {
        return { ok: false, detail: `配置文件 ${file} 里的 logDir 不是非空字符串` };
      }
      return info(logDir, "config", file);
    }
  }
  return info(path.join(configHome, "logs"), "default", source === null ? null : file);
}

export function defaultHome(): string {
  return os.homedir();
}
