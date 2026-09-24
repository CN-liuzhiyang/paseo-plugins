// Per-machine settings. They live outside every repository, in
// ~/.paseo-orchestration/config.json, because they are facts about one machine
// -- where Paseo is installed, which private role directories to add, where
// audit logs go -- and this code is public.
//
//   {
//     "paseoInstallDir": "C:\\Users\\me\\AppData\\Local\\Programs\\Paseo",
//     "rolesDirs": ["D:\\private\\roles"],
//     "logDir": "D:\\private\\logs"
//   }
//
// Every key is optional; a missing file means all defaults. Parsing is strict
// for the same reason roles are: a misspelled key that is silently ignored is a
// machine that silently runs on defaults. ORCH_CONFIG points at another file.
// The older environment variables (PASEO_INSTALL_DIR, ORCH_LOG_DIR) still win
// over the file, so a single run can be redirected without editing it.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_HOME = path.join(os.homedir(), ".paseo-orchestration");

const KEYS = {
  paseoInstallDir: (v) => typeof v === "string" && v.length > 0,
  rolesDirs: (v) => Array.isArray(v) && v.every((d) => typeof d === "string" && d.length > 0),
  logDir: (v) => typeof v === "string" && v.length > 0,
};

/** Parse one config document. Throws naming the file on anything unexpected. */
export function parseConfig(source, where) {
  const unmarked = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  let value;
  try {
    value = JSON.parse(unmarked);
  } catch (error) {
    throw new Error(`${where}: not valid JSON (${error.message})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where}: must be a JSON object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(KEYS, key)) {
      throw new Error(`${where}: unknown key "${key}"; known keys: ${Object.keys(KEYS).join(", ")}`);
    }
    if (!KEYS[key](entry)) throw new Error(`${where}: "${key}" has the wrong shape`);
  }
  return value;
}

let cached;

/** @returns {{ paseoInstallDir?: string, rolesDirs?: string[], logDir?: string }} */
export function loadConfig() {
  if (cached) return cached;
  const file = process.env.ORCH_CONFIG ?? path.join(CONFIG_HOME, "config.json");
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    // Only an absent default file means "no settings". A file named through
    // ORCH_CONFIG that cannot be read is a mistake worth stopping on.
    if (error.code === "ENOENT" && !process.env.ORCH_CONFIG) return (cached = {});
    throw new Error(`${file}: cannot read (${error.code ?? error.message})`);
  }
  return (cached = parseConfig(source, file));
}

/**
 * Where run events go: ORCH_LOG_DIR, then `logDir` in config.json, then
 * ~/.paseo-orchestration/logs. Outside every checkout by default: the events
 * hold full prompts and agent output, and this code is public.
 */
export function logDir() {
  return process.env.ORCH_LOG_DIR ?? loadConfig().logDir ?? path.join(CONFIG_HOME, "logs");
}
