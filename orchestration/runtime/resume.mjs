// Carrying on a run that did not finish: what `orch.mjs resume <runId>` reads and takes before it starts anything.
//
// A flow says how its run could be carried on with `$.resumeWith` (run.mjs); the runner writes the last of those
// into `run.end.resume`, or, for a run that was cut off before it could, leaves them as `resume` events. This
// reads that back (`readResumePoint`), checks it against the flow it names (`checkResumePoint`), and makes sure one
// stop is carried on once (`claimResumption`).
//
// Once is the part that matters. A stop that leads to a compile of an hour and then a commit must not be taken up by two
// processes because a person and a button clicked together: of any number of them asking to carry on run X, the one that
// creates `<logDir>/runs/<X>.resumed` first (an exclusive create, which the file system makes atomic, as
// claim.mjs does for a run id) is the one that does; the others are refused and spend nothing. The file says which
// run took it over. If that run was refused before it began, or nothing ever came of its start, or its process was
// certainly gone before it wrote run.start, the stop is free again and is taken under `<X>.resumed.2`, `.3`, ...; a run
// that began, whatever it came to, is the carrying on: if it stopped in its turn, it is that run that is carried on next.
//
// Nothing here starts a run or deletes anything.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { runIdProblem } from "./claim.mjs";
import { eventsFile, readEvents } from "./events.mjs";
import { loadFlow } from "./flow.mjs";
import { resolveFlowFile } from "./resolve.mjs";
import { pointProblems } from "./resume-point.mjs";
import { readRunState } from "./state.mjs";
import { validate } from "./step.mjs";

/** The run cannot be carried on, and why. Nothing was started and nothing was spent. */
export class ResumeRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "ResumeRefused";
  }
}

/** `<logDir>/runs/<runId>.resumed`, then `.resumed.2`, `.resumed.3` ... */
export const resumedFile = (dir, runId, attempt = 1) => path.join(dir, "runs", attempt === 1 ? `${runId}.resumed` : `${runId}.resumed.${attempt}`);

/**
 * What is wrong with a resume point, looked at where the flow it names can be looked up: its shape (resume-point.mjs), that
 * the name is a flow this machine knows, and that the input fits that flow's `inputs`. An empty list when it can be started.
 *
 * @param {unknown} point
 * @returns {Promise<string[]>}
 */
export async function checkResumePoint(point) {
  const problems = pointProblems(point);
  if (problems.length > 0) return problems;
  let file;
  try {
    file = resolveFlowFile(point.flow);
  } catch (error) {
    return [error.message];
  }
  let loaded;
  try {
    loaded = await loadFlow(file);
  } catch (error) {
    return [`flow "${point.flow}" cannot be loaded: ${error.message}`];
  }
  return validate(loaded.flow.inputs, point.input);
}

/**
 * The resume point of a run that did not finish, and its `run.start`, or ResumeRefused saying why not.
 *
 * - finished (`done`): nothing to carry on. Stopped, failed or timed out: `run.end.resume`, which the runner wrote.
 * - no `run.end`: only when the run is certainly dead -- the claim has gone stale *and* its process is gone on this
 *   machine (state.mjs: a pid that exists proves nothing, one that does not is proof). A claim that merely went stale may
 *   be a machine that was asleep, and two processes working on one directory is worse than the money a second pays.
 *   The point is then the last `resume` event the run wrote.
 *
 * @param {{ dir: string, runId: string, now?: () => number, probe?: object }} options
 * @returns {{ start: object, point: object, outcome: string }}
 */
export function readResumePoint({ dir, runId, now, probe }) {
  const problem = runIdProblem(runId);
  if (problem) throw new ResumeRefused(`${JSON.stringify(runId)} is not a run id: ${problem}`);
  const file = eventsFile(dir, runId);
  if (!existsSync(file)) throw new ResumeRefused(`run ${runId} has no events in ${path.dirname(file)}, so there is nothing to carry on (the log directory is ORCH_LOG_DIR, then config.json's logDir)`);
  let events;
  try {
    events = readEvents(file);
  } catch (error) {
    throw new ResumeRefused(`the events of run ${runId} cannot be read: ${error.message}`);
  }
  const start = events[0];
  if (start?.kind !== "run.start") throw new ResumeRefused(`the events of run ${runId} do not begin with run.start`);
  const end = events.at(-1)?.kind === "run.end" ? events.at(-1) : null;

  let point;
  let outcome;
  if (end) {
    outcome = end.outcome;
    if (outcome === "done") throw new ResumeRefused(`run ${runId} is done: there is nothing to carry on`);
    point = end.resume ?? null;
  } else {
    const state = readRunState({ dir, runId, ...(now ? { now } : {}), ...(probe ? { probe } : {}) });
    if (state.state !== "lost") {
      const claim = state.claim ? ` (its claim was touched ${Math.round(state.claim.touchedAgoMs / 1000)}s ago by pid ${state.claim.pid} on ${state.claim.hostname})` : "";
      throw new ResumeRefused(`run ${runId} has not ended and is not known to be dead: ${state.state}${claim}. A run is carried on after it ended, or once its process is gone`);
    }
    if (state.processAlive !== false) {
      const claim = state.claim ? `pid ${state.claim.pid} on ${state.claim.hostname}` : "its holder";
      throw new ResumeRefused(
        `run ${runId} stopped writing, but ${claim} is not known to be gone (${state.processAlive === true ? "that process still exists" : "it is on another machine"}): carrying on a run that is still working would run it twice. ` +
          "Once it is certain the run is dead (end that process), carry on again",
      );
    }
    outcome = "lost";
    const last = events.findLast((event) => event.kind === "resume");
    point = last && !last.cleared ? { flow: last.flow, input: last.input, from: last.from, spends: last.spends } : null;
  }
  if (point === null) {
    throw new ResumeRefused(`run ${runId} (${outcome}) did not say how it could be carried on: it declared no resume point, or took it back. Nothing is started from a guess`);
  }
  const bad = pointProblems(point);
  if (bad.length > 0) throw new ResumeRefused(`the resume point run ${runId} left does not fit:\n  - ${bad.join("\n  - ")}`);
  return { start, point, outcome };
}

/** The run id a `.resumed` file names, and when the file was made; null when it cannot be read as one (being written, or not ours). */
function holderOf(file) {
  try {
    const id = readFileSync(file, "utf8").trim();
    if (id === "" || runIdProblem(id) !== null) return null;
    return { id, madeMs: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Take the carrying on of run `runId` for the run `by`, or throw ResumeRefused. Exactly one of any number of callers
 * gets it (see the top of this file). `by` is the run id the caller already holds (run.mjs `takeRunId`), so that the file
 * names a run that exists in the sense claim.mjs gives the word.
 *
 * @param {{ dir: string, runId: string, by: string, now?: () => number }} options
 * @returns {{ file: string, attempt: number }}
 */
export function claimResumption({ dir, runId, by, now }) {
  mkdirSync(path.join(dir, "runs"), { recursive: true });
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const file = resumedFile(dir, runId, attempt);
    let fd;
    try {
      fd = openSync(file, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = holderOf(file);
      if (holder === null) {
        throw new ResumeRefused(
          `run ${runId} is being carried on right now (${path.basename(file)} cannot be read yet): look again in a moment. If the process that made it died, the file is empty: delete it`,
        );
      }
      const state = readRunState({ dir, runId: holder.id, spawnedAt: holder.madeMs, ...(now ? { now } : {}) });
      // Its start came to nothing: refused before run.start, or no claim and no events well after the process was started, or a claim that went
      // stale before run.start whose process is proved gone (nothing was spent, and nothing will write run.start now). A holder whose process still
      // exists, or is on another machine, is not free: it may only have been asleep.
      if (state.state === "refused" || (state.state === "absent" && state.safeToRestart) || (state.state === "dead-before-start" && state.processAlive === false)) continue;
      const how =
        state.state === "ended"
          ? `it ended as ${state.outcome}; if it stopped, carry on that run (${holder.id}) instead`
          : state.state === "pending" || state.state === "starting" || state.state === "running"
            ? "it is running"
            : `it reads as ${state.state}; a person decides what to do with it`;
      throw new ResumeRefused(`run ${runId} was already carried on, as run ${holder.id}: ${how}. A stop is carried on once`);
    }
    try {
      writeSync(fd, by);
    } finally {
      closeSync(fd);
    }
    return { file, attempt };
  }
  throw new ResumeRefused(`run ${runId} has been taken over and given up a thousand times; something is wrong with ${path.join(dir, "runs")}`);
}
