// Flow names to files. A caller that is not in this checkout (another plugin,
// another machine) knows a flow by its name, not by where it lives:
//
//   node runtime/orch.mjs run triage --question "..."
//
// The name is the file name without `.mjs`, looked up in the shipped flows/
// and then in the `flowsDirs` of config.json -- the same shape as `rolesDirs`
// for roles, and with the same rule: a name found in two places is an error,
// not an override, because which one wins would depend on the order of a list
// in a file nobody is looking at.
//
// Anything that is not a bare name (a path, a file name with an extension) is
// a path and is used as it was before.

import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";

export const FLOWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "flows");

const NAME = /^[a-z][a-z0-9-]*$/;

/** Whether `target` is a flow name rather than a path. */
export const isFlowName = (target) => typeof target === "string" && NAME.test(target);

/** The shipped flows, then any directories named in config.json. */
export function flowsDirs() {
  return [FLOWS_DIR, ...(loadConfig().flowsDirs ?? [])];
}

export class FlowLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = "FlowLookupError";
  }
}

// The same directory written with different letter case is one directory on Windows and macOS;
// the native form gives the case the file system keeps, which plain realpathSync does not.
const real = (file) => {
  try {
    return realpathSync.native(file);
  } catch {
    try {
      return realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  }
};

function namesIn(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -".mjs".length));
  } catch {
    return [];
  }
}

/**
 * The file of the flow called `name`. Throws FlowLookupError when no directory
 * has it, or when two different files do.
 *
 * @param {string} name
 * @param {string[]} [dirs]
 * @returns {string} an absolute path
 */
export function resolveFlowFile(name, dirs = flowsDirs()) {
  if (!isFlowName(name)) throw new FlowLookupError(`"${name}" is not a flow name (${NAME})`);
  const found = new Map(); // real path -> the path as found
  for (const dir of dirs) {
    const file = path.resolve(dir, `${name}.mjs`);
    if (existsSync(file)) found.set(real(file), file);
  }
  if (found.size === 1) return [...found.values()][0];
  if (found.size > 1) {
    throw new FlowLookupError(`flow "${name}" is defined more than once; keep one of: ${[...found.values()].join(", ")}`);
  }
  const missing = dirs.filter((dir) => !existsSync(dir));
  const available = [...new Set(dirs.flatMap(namesIn))].sort();
  throw new FlowLookupError(
    `no flow "${name}" in ${dirs.join(", ")}` +
      (missing.length > 0 ? ` (not a directory: ${missing.join(", ")})` : "") +
      `. Flows there: ${available.join(", ") || "(none)"}. Add a directory to "flowsDirs" in config.json, or pass a path.`,
  );
}

/** A flow name becomes the path it names; a path (or anything else) passes through. */
export const resolveTarget = (target) => (isFlowName(target) ? resolveFlowFile(target) : target);
