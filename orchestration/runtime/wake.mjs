// What the runtime does when a run ends: tell the one who should know, and keep the account.
//
// One recipient at most, taken in this order:
//   1. a session that asked -- `--notify <agent>` (via "explicit"), or the caller of a `--detach`ed run (via "caller");
//   2. nobody, when a session ran the flow in front of itself: it reads the result off the command;
//   3. the steward -- the session that watches the runs of flows -- when the flow has one in `stewards` of config.json. It is looked
//      for (a configured agent that is still there; else a session with the label orch-steward in the configured workspace) and, if there
//      is none, started there, with this message as its first one.
// The message goes into the turn the recipient is in (`--behavior steer`) and is not waited for. Failing to deliver it is a line in the
// events, never a different outcome. Every run of a flow that has a steward also adds a line to `<logDir>/steward/ledger.jsonl`, sent
// to anyone or not: a steward woken after a while is told how many runs it has not heard of, and reads the rest from there.
//
// A run whose process died before it could write run.end says nothing itself; `wakeLost` is for what finds those (orch.mjs wake-lost).

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindRole, composePrompt } from "./roster.mjs";
import { affairKey, cutTitle, ensureWorkspace, normalizeDir, samePath, withLock } from "./workspaces.mjs";
import { eventsFile, readEvents } from "./events.mjs";
import { readRunState } from "./state.mjs";

/** How long delivering a message may take, a session started for it included. */
export const WAKE_TIMEOUT_MS = 30_000;

/** The label that makes a session the steward: `orch-steward=<flow name>`, or `all` for the one that covers the flows nobody else does. */
export const STEWARD_LABEL = "orch-steward";

export const ORCH_PATH = fileURLToPath(new URL("./orch.mjs", import.meta.url));

const REASON_LIMIT = 300;
const WORDS = { done: "跑完", stopped: "停了", failed: "出错了", timeout: "超时了", lost: "失联了" };

export const ledgerFile = (dir) => path.join(dir, "steward", "ledger.jsonl");

/** A recipient that is an agent id: it goes to the CLI as an argument, so it must not be taken for an option. */
export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** `stewards` of the config for a flow: its own entry, else `*`. Null when neither. */
export function stewardTarget(stewards, flowName) {
  if (!stewards) return null;
  const key = Object.hasOwn(stewards, flowName) ? flowName : Object.hasOwn(stewards, "*") ? "*" : null;
  return key === null ? null : { key, label: key === "*" ? "all" : key, spec: stewards[key] };
}

// --- The account -------------------------------------------------------------------------------------------------------

/** The lines of the ledger that read as entries; one that does not is skipped. */
export function readLedger(dir) {
  let text;
  try {
    text = readFileSync(ledgerFile(dir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) {
    if (line === "") continue;
    try {
      const entry = JSON.parse(line);
      if (entry !== null && typeof entry === "object" && typeof entry.runId === "string") entries.push(entry);
    } catch {
      // A line that is not JSON says nothing.
    }
  }
  return entries;
}

/** How many runs the account holds since the last one that was delivered to the steward: what it has not been told of. */
export function unseenCount(entries) {
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].via === "steward" && entries[i].ok === true) break;
    count += 1;
  }
  return count;
}

function appendLedger(dir, entry) {
  const file = ledgerFile(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

// --- The message -------------------------------------------------------------------------------------------------------

const oneLine = (text, limit = REASON_LIMIT) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : flat;
};

/** 95s -> "1m35s", 5760000 -> "1h36m". */
export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 === 0 ? "" : `${s % 60}s`}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 === 0 ? "" : `${m % 60}m`}`;
  return `${Math.floor(h / 24)}d${h % 24 === 0 ? "" : `${h % 24}h`}`;
}

/**
 * The message, made from what run.start and run.end say and nothing else: a run that is done is one line, any other ends in the
 * way to look at it and to carry it on. `facts`: { flow, outcome, affair (a label or null), durationMs, usd, runId, lineage, events,
 * reason, resume ({ from } or null), working (calls that have not returned: the line is held until they do), manual (a path or null),
 * unseen, ledger (the path) }.
 */
export function wakeText(facts) {
  const head = [`[流程] ${facts.flow} ${WORDS[facts.outcome] ?? facts.outcome}`];
  if (facts.affair) head.push(oneLine(facts.affair, 80));
  const took = duration(facts.durationMs);
  if (took) head.push(took);
  if (typeof facts.usd === "number" && facts.usd > 0) head.push(facts.usd < 0.005 ? "<$0.01" : `$${facts.usd.toFixed(2)}`);
  const lines = [];
  if (facts.outcome === "done") {
    lines.push(`${head.join(" · ")} · 运行 ${facts.runId}`);
  } else {
    lines.push(head.join(" · "));
    lines.push(`原因：${oneLine(facts.reason)}`);
    lines.push(`运行 ${facts.runId}${facts.lineage && facts.lineage !== facts.runId ? `（接着线 ${facts.lineage}）` : ""} · 事件 ${facts.events}`);
    if (facts.resume) lines.push(`接着跑：node ${ORCH_PATH} resume ${facts.runId}（${oneLine(facts.resume.from, 80)}）`);
    if (facts.working > 0) {
      lines.push(`还有 ${facts.working} 个调用没回来，这条线暂时被占着，现在接着跑会被拒。运行的进程还在，就等它们回来再接着跑；进程已经退出（命令行入口跑完就退出），它们可能被截断，接着跑会停在“可能做了也可能没做”，要先用 settle 了结`);
    }
    if (facts.manual) lines.push(`手册：${facts.manual}`);
  }
  if (facts.unseen > 0) lines.push(`账里自上次以来还有 ${facts.unseen} 次运行（${facts.ledger}）`);
  return lines.join("\n");
}

/** What a steward started by the runtime is told to be, ahead of the message that started it. */
export function stewardIntro({ guide, ledger }) {
  const lines = [
    "你是这台机器上编排流程的负责会话（steward）：流程每次运行结束，运行时往这个会话发一条消息——流程、结局、原因、事件文件、接着跑的命令，和该流程的手册路径。",
    guide.length > 0 ? `先读：${guide.join("；")}。` : null,
    "每条消息怎么办，按那个流程的手册：跑完的记一笔就行；停了、出错、失联的先查原因，能接着跑的接着跑，要改流程或手册的照手册里写的做。",
    `账：${ledger}，每运行一次一行；换会话、上下文太长要交接时，从这里接上。`,
    "你被叫醒时可能正在做别的事：消息会并进当前这一轮，不用回复它。",
    "下面是起这个会话的那次运行：",
  ];
  return lines.filter(Boolean).join("\n");
}

// --- Finding the steward -----------------------------------------------------------------------------------------------

/** An agent row's cwd as the CLI lists it: the home directory is shown as "~". */
const listedDir = (cwd) => (typeof cwd === "string" && cwd.startsWith("~") ? path.join(os.homedir(), cwd.slice(1)) : cwd);

/**
 * Looking for the steward and starting one is one step for everyone: runs that end together would each find none and each start one. The lock
 * is per (label, directory), held until the session is started and its id is written down, and it belongs to the work, not to whoever waits
 * for it -- a delivery that gives up (`within`) leaves the work, and the lock, to finish.
 */
const STEWARD_LOCK = { waitMs: WAKE_TIMEOUT_MS, staleMs: 120_000, pollMs: 100 };

/** Where the steward started for (label, cwd) is written down (`json`), and its lock (`lock`). */
const stewardFile = (dir, label, cwd, ext) =>
  path.join(dir, "steward", `${createHash("sha256").update(`${label}\0${normalizeDir(cwd)}`).digest("hex").slice(0, 32)}.${ext}`);

/** The agent id written down in `file` if that session is still there, else null. Throws what the daemon throws, but "not found". */
async function recordedSteward(file, executor) {
  let agentId;
  try {
    agentId = JSON.parse(readFileSync(file, "utf8")).agentId;
  } catch {
    // None written, or not readable: the listing is all there is to go by.
    return null;
  }
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) return null;
  try {
    return (await executor.inspect(agentId)).archived === true ? null : agentId;
  } catch (error) {
    if (error?.code === "AGENT_NOT_FOUND") return null;
    throw error;
  }
}

/**
 * The steward session for `target`, started if there is none: { agentId, started } -- `started` when it was made just now, with `message` as its
 * first one -- or { none } saying why there is nobody. Throws what the daemon throws.
 */
async function findSteward({ target, executor, roster, dir, runId, message }) {
  const { spec, label } = target;
  if (spec.agent) {
    try {
      const state = await executor.inspect(spec.agent);
      if (state.archived !== true) return { agentId: spec.agent, started: false };
    } catch (error) {
      if (error?.code !== "AGENT_NOT_FOUND") throw error;
    }
    return { none: `the steward agent ${spec.agent} of "${target.key}" is gone or archived, and no workspace is configured to start another in` };
  }
  let workspaceId;
  let cwd;
  if (spec.workspace) {
    const there = (await executor.listWorkspaces()).find((w) => w.workspaceId === spec.workspace);
    if (!there) return { none: `the steward workspace ${spec.workspace} of "${target.key}" is not there` };
    [workspaceId, cwd] = [spec.workspace, there.cwd];
  } else {
    const made = await ensureWorkspace({ dir, key: "steward", cwd: spec.cwd, title: cutTitle("Flow steward"), runId, executor });
    [workspaceId, cwd] = [made.workspaceId, spec.cwd];
  }
  mkdirSync(path.join(dir, "steward"), { recursive: true });
  return withLock(stewardFile(dir, label, cwd, "lock"), STEWARD_LOCK, async () => {
    const found = (await executor.listAgents({ [STEWARD_LABEL]: label })).filter((row) => row.cwd && samePath(listedDir(row.cwd), cwd));
    if (found.length > 0) return { agentId: found[0].id, started: false, several: found.length > 1 };
    const recorded = await recordedSteward(stewardFile(dir, label, cwd, "json"), executor);
    if (recorded) return { agentId: recorded, started: false };
    const bound = bindRole(roster, { role: spec.role ?? "steward" });
    const prompt = composePrompt(bound, `${stewardIntro({ guide: spec.guide ?? [], ledger: ledgerFile(dir) })}\n\n${message}`);
    const spawned = await executor.spawn({
      provider: bound.provider,
      thinking: bound.thinking,
      title: "Flow steward",
      labels: { [STEWARD_LABEL]: label },
      prompt,
      cwd,
      workspace: workspaceId,
    });
    try {
      writeFileSync(stewardFile(dir, label, cwd, "json"), JSON.stringify({ label, cwd, agentId: spawned.agentId, at: new Date().toISOString() }));
    } catch {
      // The session is started and is given what ran; the listing finds it for the next one. Only the second way of finding it is lost.
    }
    return { agentId: spawned.agentId, started: true };
  });
}

const timedOut = (ms) => `no answer in ${ms / 1000}s`;

/** `work` or a rejection after `ms`; what `work` does afterwards is no longer waited for. */
function within(ms, work) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timedOut(ms))), ms);
  });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const describe = (error) => oneLine(`${error?.name ?? "Error"}: ${error?.message ?? error}`, 300);

/**
 * Tell whoever should be told that a run ended, and add it to the account. Never throws: what went wrong is in the result.
 *
 * `run` is what run.start and run.end say: { flow ({ name, wake }), source, runId, lineage, affair, caller, notify ({ agent, via } | null),
 * outcome, reason, durationMs, usd, resume, events }. `executor` is the local daemon's. `stewards` is the config's.
 *
 * @returns {Promise<{ event: { to: string | null, via: string | null, ok: boolean | null, error: string | null, why: string | null,
 *   started: boolean, unseen: number, ledger: boolean }, text: string }>}
 */
export async function wakeAtEnd({ run, dir, executor, roster, stewards, timeoutMs = WAKE_TIMEOUT_MS, scrub = (text) => text }) {
  const event = { to: null, via: null, ok: null, error: null, why: null, started: false, unseen: 0, ledger: false };
  const target = stewardTarget(stewards, run.flow.name);
  let text = "";
  let entries = [];
  try {
    entries = target ? readLedger(dir) : [];
    event.unseen = target ? unseenCount(entries) : 0;
    const manualFile = run.source ? path.join(path.dirname(run.source), `${run.flow.name}.steward.md`) : null;
    text = scrub(
      wakeText({
        flow: run.flow.name,
        outcome: run.outcome,
        affair: run.affair?.label ?? null,
        durationMs: run.durationMs,
        usd: run.usd,
        runId: run.runId,
        lineage: run.lineage,
        events: run.events,
        reason: run.reason,
        resume: run.resume,
        working: run.working ?? 0,
        manual: manualFile && existsSync(manualFile) ? manualFile : null,
        unseen: event.unseen,
        ledger: ledgerFile(dir),
      }),
    );
  } catch (error) {
    event.ok = false;
    event.error = `could not make the message: ${describe(error)}`;
    return { event, text };
  }

  const send = async (agentId, via) => {
    event.to = agentId;
    event.via = via;
    event.ok = false;
    await within(timeoutMs, executor.notify(agentId, text, { file: path.join(dir, "steward", "wake", `${run.runId}.txt`), timeoutMs }));
    event.ok = true;
  };
  try {
    if (run.notify) await send(run.notify.agent, run.notify.via);
    else if (run.caller) event.why = "a session ran this flow in front of itself and reads the result off the command";
    else if (!target) event.why = `no steward is configured for flow "${run.flow.name}" (stewards in config.json: its name, or *)`;
    else if (run.flow.wake === "problems" && run.outcome === "done") event.why = 'the flow says its steward hears only of runs that did not come to done (wake: "problems")';
    else {
      const found = await within(timeoutMs, findSteward({ target, executor, roster, dir, runId: run.runId, message: text }));
      if (found.none) event.why = found.none;
      else {
        event.to = found.agentId;
        event.via = "steward";
        event.started = found.started;
        event.ok = false;
        // A steward started for this message was given it as its first one; one that was there is told.
        if (!found.started) await send(found.agentId, "steward");
        else event.ok = true;
        if (found.several) event.why = `several sessions carry the label ${STEWARD_LABEL}=${target.label} there; the first was taken`;
      }
    }
  } catch (error) {
    event.ok = false;
    event.error = describe(error);
  }

  if (target) {
    try {
      appendLedger(dir, {
        v: 1,
        at: new Date().toISOString(),
        runId: run.runId,
        lineage: run.lineage,
        flow: run.flow.name,
        affair: run.affair ? { key: affairKey(run.affair), label: run.affair.label } : null,
        outcome: run.outcome,
        why: run.reason ? oneLine(scrub(run.reason), 200) : null,
        durationMs: run.durationMs ?? null,
        usd: run.usd ?? null,
        to: event.to,
        via: event.via,
        ok: event.ok,
        started: event.started,
      });
      event.ledger = true;
    } catch (error) {
      event.error = event.error ?? `could not add to the account: ${describe(error)}`;
    }
  }
  return { event, text };
}

// --- Runs that died ----------------------------------------------------------------------------------------------------

/** The run ids that have an events file in `dir`. */
function runIds(dir) {
  try {
    return readdirSync(path.join(dir, "runs"))
      .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".claim"))
      .map((name) => name.slice(0, -".jsonl".length));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Tell about the runs whose process is known to be gone and that never wrote run.end (state.mjs: `lost`, on this machine, pid not there),
 * unless they have been told of: the account holds a line for them, or their events hold a wake. Each is told the way a run that ended is,
 * with the outcome "lost". Returns what was done; with `dryRun` nothing is sent or written.
 *
 * @returns {Promise<Array<{ runId: string, flow: string, to: string | null, via: string | null, ok: boolean | null, why: string | null, error: string | null }>>}
 */
export async function wakeLost({ dir, executor, roster, stewards, dryRun = false, timeoutMs = WAKE_TIMEOUT_MS, scrub = (text) => text }) {
  const known = new Set(readLedger(dir).map((entry) => entry.runId));
  const done = [];
  for (const runId of runIds(dir)) {
    if (known.has(runId)) continue;
    let state;
    let events;
    try {
      state = readRunState({ dir, runId });
      if (!(state.state === "lost" && state.processAlive === false)) continue;
      events = readEvents(eventsFile(dir, runId));
    } catch {
      continue;
    }
    const start = events[0];
    if (start?.kind !== "run.start" || events.some((e) => e.kind === "wake" || e.kind === "run.end")) continue;
    const resumes = events.filter((e) => e.kind === "resume");
    const lastResume = resumes.at(-1);
    const lastAt = Date.parse(state.lastEventAt ?? "") || Date.parse(events.at(-1)?.ts ?? "");
    const flow = { name: start.flow.name, wake: null };
    const run = {
      flow,
      source: start.source ?? null,
      runId,
      lineage: start.lineage ?? runId,
      affair: start.affair ?? null,
      caller: start.caller ?? null,
      notify: start.notify ?? null,
      outcome: "lost",
      reason: `进程没了，没有写出结局；最后一条事件在 ${state.lastEventAt ?? events.at(-1)?.ts ?? "?"}`,
      durationMs: Number.isFinite(lastAt) ? lastAt - Date.parse(start.ts) : null,
      usd: null,
      resume: lastResume && lastResume.cleared !== true ? { from: lastResume.from } : null,
      events: eventsFile(dir, runId),
    };
    if (dryRun) {
      const target = stewardTarget(stewards, flow.name);
      done.push({ runId, flow: flow.name, to: run.notify?.agent ?? null, via: run.notify?.via ?? (run.caller || !target ? null : "steward"), ok: null, why: "dry run", error: null });
      continue;
    }
    const { event } = await wakeAtEnd({ run, dir, executor, roster, stewards, timeoutMs, scrub });
    // The account is the only thing that remembers a lost run was told of; one the steward is not configured for would be looked at again
    // every time, so it is entered too.
    if (!event.ledger) {
      try {
        appendLedger(dir, { v: 1, at: new Date().toISOString(), runId, lineage: run.lineage, flow: flow.name, affair: null, outcome: "lost", why: null, durationMs: null, usd: null, to: event.to, via: event.via, ok: event.ok, started: event.started });
      } catch {
        // Told again next time, which is the lesser harm.
      }
    }
    done.push({ runId, flow: flow.name, to: event.to, via: event.via, ok: event.ok, why: event.why, error: event.error });
  }
  return done;
}
