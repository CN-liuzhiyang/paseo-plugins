// The command line over run.mjs and flow.mjs.
//
//   node runtime/orch.mjs run <flow.mjs | name> [--input <json | @file>] [--<input-name> value ...] [--timeout 2h]
//                                        [--host ssh://user@box --cwd /path/on/box]
//                                        [--run-id <id>] [--affair <json | @file>]
//   node runtime/orch.mjs resume <runId> [--run-id <id>] [--affair <json | @file>] [--timeout 2h]
//                                        [--host ssh://user@box --cwd /path/on/box] [--expect <print>] [--redo <step>]
//   node runtime/orch.mjs settle <runId> <step> --done <json> | --not-done
//   node runtime/orch.mjs steps <runId>
//   node runtime/orch.mjs check <flow.mjs | name>
//   node runtime/orch.mjs list
//
// `resume` carries on a run that stopped, failed, timed out or was cut off, from the resume point its flow declared
// (`$.resumeWith`, CONVENTIONS.md "接着跑"): it starts the flow that point names, with its input, as a new run whose
// run.start says `resumeOf: <runId>`. The affair, the directory and the host are the earlier run's unless given again.
// One stop is carried on once (resume.mjs). What the earlier runs of the line did is in their journal (journal.mjs) and is not done again;
// `--redo <step>` does that step, and what came after it that can be taken back, again. `--expect <print>` is for a caller that showed a person the point (its flow and input are the
// ones `resume-point.mjs` `pointPrint` fingerprints): if the point the run left says another now, nothing is started. It prints what `run`
// prints and exits the same way.
//
// `steps` prints what the journal of a run's line holds, one entry per place in the flow. `settle` says how a step that cannot be taken back
// (`once`) ended when it began and left no word of how: that it was done (with the value it would have returned) or that it was not. Only
// such a step can be settled, and only once the run that began it is no longer working.
//
// `list` prints the flows that exist -- the shipped ones and those in `flowsDirs` -- as JSON: name,
// description, phases, inputs, where the file is, and why a file that is not a usable flow is not
// (catalog.mjs). It starts nothing and costs nothing; a UI shows it as the list of flows.
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
//
// A bare name (`advisor`) is a flow looked up by file name in the shipped flows/
// and the `flowsDirs` of config.json (resolve.mjs); anything else is a path.
//
// --run-id gives the run its id (the caller's own, so it can find the run's
// files); a taken id is refused before anything is spent. --affair is the
// affair the run belongs to, recorded in run.start.affair (affair.mjs).
//
// --host runs every agent of the run on another daemon (any form `paseo
// --host` takes); --cwd is then required, a directory on that host. The
// runner and its events stay on this machine.

import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadFlow, checkFlow } from "./flow.mjs";
import { runFlow, jsonSafe, takeRunId, settleRefusal } from "./run.mjs";
import { resolveFlowFile, resolveTarget } from "./resolve.mjs";
import { listFlows } from "./catalog.mjs";
import { logDir as configuredLogDir } from "./config.mjs";
import { claimResumption, lineageOf, readResumePoint, ResumeRefused } from "./resume.mjs";
import { Journal, JournalError, known } from "./journal.mjs";
import { eventsFile, readEvents } from "./events.mjs";
import { readRunState } from "./state.mjs";
import { PRINT_SHAPE, pointPrint } from "./resume-point.mjs";

const USAGE = [
  "Usage:",
  "  node runtime/orch.mjs run <flow.mjs | name> [--input <json | @file>] [--<input-name> value ...] [--timeout 2h] [--host <host> --cwd <dir>]",
  "                                              [--run-id <id>] [--affair <json | @file>]",
  "  node runtime/orch.mjs resume <runId> [--timeout 2h] [--run-id <id>] [--affair <json | @file>] [--host <host> --cwd <dir>] [--expect <print>] [--redo <step>]",
  "  node runtime/orch.mjs settle <runId> <step> --done <json> | --not-done",
  "  node runtime/orch.mjs steps <runId>",
  "  node runtime/orch.mjs check <flow.mjs | name>",
  "  node runtime/orch.mjs list",
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

/** A flag's JSON value, inline or `@file`. */
async function readJson(flag, raw) {
  const text = raw.startsWith("@") ? await readFile(raw.slice(1), "utf8") : raw;
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(unmarked);
  } catch (error) {
    throw new UsageError(`--${flag}: not valid JSON (${error.message})`);
  }
}

async function readInput(raw) {
  if (raw === undefined) return {};
  const value = await readJson("input", raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UsageError("--input must be a JSON object");
  return value;
}

/**
 * A flow's input and the run's timeout from argv (what follows `run <flow>`).
 * Exported for the tests; throws UsageError.
 */
export async function parseRunArgs(f, argv) {
  const { options, convert } = inputOptions(f.inputs);
  const all = { ...options, input: { type: "string" }, timeout: { type: "string" }, host: { type: "string" }, cwd: { type: "string" }, "run-id": { type: "string" }, affair: { type: "string" } };
  // parseArgs refuses a value that starts with "-" as ambiguous, and a question
  // written as a Markdown list does. A value-taking flag always takes the next
  // argument, so join them before parseArgs sees them.
  const joined = [];
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].startsWith("--") && !argv[i].includes("=") ? argv[i].slice(2) : null;
    if (name && all[name]?.type === "string" && i + 1 < argv.length) {
      joined.push(`${argv[i]}=${argv[i + 1]}`);
      i += 1;
    } else {
      joined.push(argv[i]);
    }
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: joined,
      options: all,
      allowNegative: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(`${error.message}\nInputs of "${f.name}": ${Object.keys(f.inputs.properties).map((n) => `--${kebab(n)}`).join(" ") || "(none)"}`);
  }
  const input = await readInput(parsed.values.input);
  for (const [flag, raw] of Object.entries(parsed.values)) {
    if (["input", "timeout", "host", "cwd", "run-id", "affair"].includes(flag)) continue;
    const [name, value] = convert[flag](raw);
    input[name] = value;
  }
  // The affair's own shape is checked by the runner, which refuses before run.start.
  const given = {};
  if (parsed.values["run-id"] !== undefined) given.runId = parsed.values["run-id"];
  if (parsed.values.affair !== undefined) given.affair = await readJson("affair", parsed.values.affair);
  return { input, timeout: parsed.values.timeout ?? null, host: parsed.values.host ?? null, cwd: parsed.values.cwd ?? null, ...given };
}

/** The value of `--run-id` in argv, before the flow is read: the id is claimed first, so a failure after it is on record. */
function peekRunId(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--run-id") return argv[i + 1];
    if (argv[i].startsWith("--run-id=")) return argv[i].slice("--run-id=".length);
  }
  return undefined;
}

/** What the terminal gets of a result: JSON-safe, and (for a run) scrubbed as its events are. */
export function printable(result) {
  return jsonSafe(result, Infinity, typeof result?.redact === "function" ? result.redact : null);
}

async function run(name, argv) {
  // A caller-given id is taken before the flow is looked up and read, so that whatever
  // goes wrong from here (no such flow, a bad flag, a malformed --affair) is written to the claim
  // for a caller that started this process detached and cannot see its stderr.
  const requested = peekRunId(argv);
  const taken = requested !== undefined ? takeRunId({ runId: requested }) : undefined;
  try {
    const target = resolveTarget(name);
    const { flow: f } = await loadFlow(target);
    const { input, timeout, host, cwd, runId, affair } = await parseRunArgs(f, argv);
    if (taken && runId !== taken.runId) throw new UsageError(`--run-id is ambiguous: ${JSON.stringify(taken.runId)} was claimed, the flags say ${JSON.stringify(runId)}`);
    // The path, not the loaded value: the runner records it and scans its source.
    return await runFlow(target, {
      input,
      timeout,
      ...(host ? { host } : {}),
      ...(cwd ? { cwd } : {}),
      ...(taken ? { taken } : runId !== undefined ? { runId } : {}),
      ...(affair !== undefined ? { affair } : {}),
    });
  } catch (error) {
    // runFlow settles its own refusals; this is for what failed before it was called (settling twice is harmless: the claim is already stopped).
    if (taken) settleRefusal(taken, error);
    throw error;
  }
}

/**
 * What follows `resume <runId>`: the flags of a run that do not belong to a flow's input. Exported for the tests; throws UsageError.
 */
export async function parseResumeArgs(argv) {
  const all = { timeout: { type: "string" }, host: { type: "string" }, cwd: { type: "string" }, "run-id": { type: "string" }, affair: { type: "string" }, expect: { type: "string" }, redo: { type: "string" } };
  // As for a run: a value-taking flag takes the next argument whatever it starts with.
  const joined = [];
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].startsWith("--") && !argv[i].includes("=") ? argv[i].slice(2) : null;
    if (name && all[name]?.type === "string" && i + 1 < argv.length) {
      joined.push(`${argv[i]}=${argv[i + 1]}`);
      i += 1;
    } else {
      joined.push(argv[i]);
    }
  }
  let parsed;
  try {
    parsed = parseArgs({ args: joined, options: all, allowPositionals: false, strict: true });
  } catch (error) {
    throw new UsageError(`${error.message}
The input is the one the earlier run's flow declared, not a flag: resume takes --timeout, --run-id, --affair, --host, --cwd, --expect, --redo`);
  }
  const given = {};
  if (parsed.values["run-id"] !== undefined) given.runId = parsed.values["run-id"];
  if (parsed.values.affair !== undefined) given.affair = await readJson("affair", parsed.values.affair);
  if (parsed.values.expect !== undefined) {
    if (!PRINT_SHAPE.test(parsed.values.expect)) throw new UsageError("--expect is the 16 hex digits of the fingerprint of the point a caller showed (pointPrint)");
    given.expect = parsed.values.expect;
  }
  if (parsed.values.redo !== undefined) {
    if (parsed.values.redo.trim() === "") throw new UsageError("--redo is the name of a step of the run's journal (orch.mjs steps <runId> lists them)");
    given.redo = parsed.values.redo;
  }
  return { timeout: parsed.values.timeout ?? null, host: parsed.values.host ?? null, cwd: parsed.values.cwd ?? null, ...given };
}

/**
 * Carry on the run `previous`: read the resume point it left, take this run's id, take the stop (once), and start the flow the
 * point names. Throws what a refused run throws (RunRefused, or ResumeRefused for a stop that cannot be carried on); a caller-given
 * id keeps the reason with its claim, as for `run`. `logDir` is the directory `previous` is in; the run is written there too.
 *
 * @param {string} previous the run id to carry on
 * @param {string[]} argv the flags after it
 * @param {{ logDir?: string, runOptions?: object }} [options] `runOptions` go to runFlow as they are (tests: executor, roster)
 */
export async function resumeRun(previous, argv, { logDir = configuredLogDir(), runOptions = {} } = {}) {
  // The id this run will have is taken first, as `run` does: whatever goes wrong from here is on its claim for a caller that cannot see stderr.
  const requested = peekRunId(argv);
  const taken = takeRunId({ runId: requested, logDir });
  try {
    const { timeout, host, cwd, runId, affair, expect, redo } = await parseResumeArgs(argv);
    if (runId !== undefined && runId !== taken.runId) throw new UsageError(`--run-id is ambiguous: ${JSON.stringify(taken.runId)} was claimed, the flags say ${JSON.stringify(runId)}`);
    const { start, point } = readResumePoint({ dir: logDir, runId: previous });
    const target = resolveFlowFile(point.flow);
    // What a person was shown is what is started: the run's file is read again here, and a point that says another flow or another input now
    // (it was changed since, or the run went on after it was read as lost) is not carried on from. Nothing is taken or spent.
    const print = pointPrint(point);
    if (expect !== undefined && expect !== print) {
      throw new ResumeRefused(
        `the resume point of run ${previous} is not the one that was shown: it now names flow "${point.flow}" (${JSON.stringify(point.from)}) with a flow or input other than the one expected. Look at the run again before carrying it on`,
      );
    }
    // The run is one of a line that shares a journal. A step to do again is looked for before the stop is taken: a name that is not there
    // must not use up the once a stop is carried on.
    const lineage = lineageOf(start, previous);
    if (redo !== undefined) {
      try {
        new Journal({ dir: logDir, lineage, redo });
      } catch (error) {
        if (error instanceof JournalError) throw new ResumeRefused(error.message);
        throw error;
      }
    }
    claimResumption({ dir: logDir, runId: previous, by: taken.runId });
    // From here the id is named in a .resumed file, so somebody does look it up -- the next caller, to see whether this start came to
    // nothing and the stop is free again. A generated id's claim is normally taken away when the run is refused; this one keeps its reason.
    taken.callerGiven = true;
    // The earlier run's affair, directory and host unless the caller says otherwise: the agents and the gate cards of the stop it left
    // stay where the person looks for them (workspaces.mjs), and a flow that reads $.ctx.cwd finds what it had.
    const earlier = { affair: start.affair ?? null, cwd: typeof start.cwd === "string" ? start.cwd : null, host: typeof start.host === "string" ? start.host : null };
    return await runFlow(target, {
      ...runOptions,
      input: point.input,
      timeout,
      logDir,
      resumeOf: previous,
      resumePrint: print,
      lineage,
      ...(redo !== undefined ? { redo } : {}),
      taken,
      affair: affair !== undefined ? affair : earlier.affair,
      ...((cwd ?? earlier.cwd) ? { cwd: cwd ?? earlier.cwd } : {}),
      ...((host ?? earlier.host) ? { host: host ?? earlier.host } : {}),
    });
  } catch (error) {
    settleRefusal(taken, error);
    throw error;
  }
}

/** The journal of the line a run belongs to, found through the run's own run.start. */
function journalOf(dir, runId) {
  let start;
  try {
    start = readEvents(eventsFile(dir, runId))[0];
  } catch (error) {
    throw new UsageError(`run ${runId} has no events to read in ${dir} (${error.code ?? error.message}); the log directory is ORCH_LOG_DIR, then config.json's logDir`);
  }
  if (start?.kind !== "run.start") throw new UsageError(`the events of run ${runId} do not begin with run.start`);
  return new Journal({ dir, lineage: lineageOf(start, runId) });
}

/** What a journal holds, for a person: one row per place in the flow, in the order they were last written. */
export function listSteps(runId, { logDir = configuredLogDir() } = {}) {
  const journal = journalOf(logDir, runId);
  const brief = (e) => ({
    id: e.id,
    kind: e.kind,
    state: e.state,
    once: e.once === true,
    ...(e.state === "settled" ? { done: e.done, by: e.by } : {}),
    key: typeof e.keyPrint === "string" ? e.keyPrint.slice(0, 16) : null,
    runId: e.runId ?? null,
    callId: e.callId ?? null,
    at: e.at ?? null,
  });
  return { lineage: journal.lineage, entries: journal.steps().map(brief) };
}

/** The step could not be settled. Nothing was written. */
export class SettleRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "SettleRefused";
  }
}

/**
 * Say how a step that cannot be taken back ended, when its run left no word of it: `--done <json>` (it took effect; the JSON is the
 * value it would have returned) or `--not-done`. A later run of the line takes the one or does the other. Refused for a step that is
 * not in that state, and while the run that began it may still be working.
 */
export function settleRun(runId, argv, { logDir = configuredLogDir() } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { done: { type: "string" }, "not-done": { type: "boolean" } }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const [step, ...extra] = parsed.positionals;
  if (!step || extra.length > 0) throw new UsageError("settle takes the run id, the step's name, and --done <json> or --not-done");
  const { done: doneText, "not-done": notDone } = parsed.values;
  if ((doneText === undefined) === (notDone !== true)) throw new UsageError("say either --done <json> or --not-done");
  let value;
  if (doneText !== undefined) {
    try {
      value = JSON.parse(doneText);
    } catch (error) {
      throw new UsageError(`--done is the step's value as JSON (${error.message})`);
    }
  }
  const journal = journalOf(logDir, runId);
  const id = `step:${step}`;
  const entry = journal.get(id);
  if (!entry) throw new SettleRefused(`there is no step "${step}" in the journal of this line of runs (orch.mjs steps ${runId} lists them)`);
  const undecided = !known(entry) || (entry.once === true && (entry.state === "begun" || entry.state === "failed" || (entry.state === "done" && entry.dropped === true)));
  if (!undecided) {
    throw new SettleRefused(
      `step "${step}" is ${entry.state}${entry.state === "settled" ? (entry.done ? " as done" : " as not done") : ""}, not a step that may or may not have been done; only such a step is settled`,
    );
  }
  if (typeof entry.runId === "string") {
    const state = readRunState({ dir: logDir, runId: entry.runId });
    if (!(state.state === "ended" || (state.state === "lost" && state.processAlive === false))) {
      throw new SettleRefused(`run ${entry.runId}, which began step "${step}", is not known to be over (${state.state}); settle it once that run has ended or its process is gone`);
    }
  }
  const settled = journal.append(
    {
      id,
      kind: "step",
      state: "settled",
      done: doneText !== undefined,
      once: true,
      keyPrint: typeof entry.keyPrint === "string" ? entry.keyPrint : null,
      ...(doneText !== undefined ? (value === undefined ? { undefined: true } : { value }) : {}),
      by: "cli",
      runId: typeof entry.runId === "string" ? entry.runId : runId,
      callId: entry.callId ?? null,
    },
    { sync: true },
  );
  return { ok: true, lineage: journal.lineage, step, settled: settled.done ? "done" : "not-done", id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, target, ...rest] = process.argv.slice(2);
  const print = (value) => console.log(JSON.stringify(printable(value), null, 2));

  if (command === "list" && target === undefined) {
    try {
      print({ flows: await listFlows() });
      process.exit(0);
    } catch (error) {
      console.error(`${error.name}: ${error.message}`);
      process.exit(2);
    }
  }

  if (!["run", "check", "resume", "settle", "steps"].includes(command) || !target) {
    console.error(USAGE);
    process.exit(2);
  }

  try {
    if (command === "check") {
      if (rest.length > 0) throw new UsageError(`check takes only the flow path, got ${rest.join(" ")}`);
      const result = await checkFlow(resolveTarget(target));
      print(result);
      process.exit(result.ok ? 0 : 2);
    }
    if (command === "steps") {
      if (rest.length > 0) throw new UsageError(`steps takes only the run id, got ${rest.join(" ")}`);
      print(listSteps(target));
      process.exit(0);
    }
    if (command === "settle") {
      print(settleRun(target, rest));
      process.exit(0);
    }
    const result = command === "resume" ? await resumeRun(target, rest) : await run(target, rest);
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
