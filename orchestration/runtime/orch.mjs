// The command line over run.mjs and flow.mjs.
//
//   node runtime/orch.mjs run <flow.mjs> [--input <json | @file>] [--<input-name> value ...] [--timeout 2h]
//   node runtime/orch.mjs check <flow.mjs>
//
// `run` prints one JSON object, { ok, outcome, value, runId, events, cost,
// caveats, durationMs } plus error / stop when there is one. The events file
// holds everything else. Exit code: 0 done or stopped, 1 failed or timed out,
// 2 refused before anything ran (bad arguments, bad input, a check failed).
//
// Inputs come from the flow's own `inputs`: each one is a flag named in
// kebab-case (hotfixVersion -> --hotfix-version), parsed by its type --
// text and choice as strings, count as a number, flag as --name / --no-name,
// a list of text or numbers by repeating the flag. Groups and other lists go
// through --input. Flags win over --input, key by key.

import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadFlow, checkFlow } from "./flow.mjs";
import { runFlow, jsonSafe } from "./run.mjs";

const USAGE = [
  "Usage:",
  "  node runtime/orch.mjs run <flow.mjs> [--input <json | @file>] [--<input-name> value ...] [--timeout 2h]",
  "  node runtime/orch.mjs check <flow.mjs>",
].join("\n");

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/** parseArgs options for a flow's inputs, and how to turn each back into a value. */
function inputOptions(schema) {
  const options = {};
  const convert = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    const flag = kebab(name);
    const itemType = field.type === "array" ? field.items.type : null;
    if (field.type === "boolean") {
      options[flag] = { type: "boolean" };
    } else if (field.type === "string" || field.type === "number") {
      options[flag] = { type: "string" };
    } else if (itemType === "string" || itemType === "number") {
      options[flag] = { type: "string", multiple: true };
    } else {
      continue; // groups and lists of groups: --input only
    }
    convert[flag] = (raw) => {
      const number = (text) => {
        const value = Number(text);
        if (text.trim() === "" || !Number.isFinite(value)) throw new UsageError(`--${flag}: "${text}" is not a number`);
        return value;
      };
      const value = field.type === "number" ? number(raw) : itemType === "number" ? raw.map(number) : raw;
      return [name, value];
    };
  }
  return { options, convert };
}

async function readInput(raw) {
  if (raw === undefined) return {};
  const text = raw.startsWith("@") ? await readFile(raw.slice(1), "utf8") : raw;
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let value;
  try {
    value = JSON.parse(unmarked);
  } catch (error) {
    throw new UsageError(`--input: not valid JSON (${error.message})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UsageError("--input must be a JSON object");
  return value;
}

/**
 * A flow's input and the run's timeout from argv (what follows `run <flow>`).
 * Exported for the tests; throws UsageError.
 */
export async function parseRunArgs(f, argv) {
  const { options, convert } = inputOptions(f.inputs);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...options, input: { type: "string" }, timeout: { type: "string" } },
      allowNegative: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(`${error.message}\nInputs of "${f.name}": ${Object.keys(f.inputs.properties).map((n) => `--${kebab(n)}`).join(" ") || "(none)"}`);
  }
  const input = await readInput(parsed.values.input);
  for (const [flag, raw] of Object.entries(parsed.values)) {
    if (flag === "input" || flag === "timeout") continue;
    const [name, value] = convert[flag](raw);
    input[name] = value;
  }
  return { input, timeout: parsed.values.timeout ?? null };
}

async function run(target, argv) {
  const { flow: f } = await loadFlow(target);
  const { input, timeout } = await parseRunArgs(f, argv);
  // The path, not the loaded value: the runner records it and scans its source.
  return runFlow(target, { input, timeout });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, target, ...rest] = process.argv.slice(2);
  const print = (value) => console.log(JSON.stringify(jsonSafe(value), null, 2));

  if (!["run", "check"].includes(command) || !target) {
    console.error(USAGE);
    process.exit(2);
  }

  try {
    if (command === "check") {
      if (rest.length > 0) throw new UsageError(`check takes only the flow path, got ${rest.join(" ")}`);
      const result = await checkFlow(target);
      print(result);
      process.exit(result.ok ? 0 : 2);
    }
    const result = await run(target, rest);
    print(result);
    // Calls left running past a timeout hold child processes open; the run
    // is over, and its events say so.
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    // Refused before run.start: nothing ran, nothing was spent, no events file.
    console.error(`${error.name}: ${error.message}`);
    if (error.name === "UsageError") console.error(`\n${USAGE}`);
    process.exit(2);
  }
}
