import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Starting a flow for an affair (`affair flow`): which flows policy allows, where the run's files are, whether the last run
// is over, how the process is started. Nothing here writes the log; the command does, around these.
//
// policy.flows is { perDay: 3, "<name>": { kinds: ["<link kind>"], prepare: "<file>.mjs", timeout: "30h", says: "…" } }: a flow is a
// key whose value is an object. `prepare` is a program that reads the item and prints the flow's whole input (the same
// contract as a reading tool: stdin {"args": {"ref", "workdir"}}, stdout {"value", "summary"}), so that nobody types a path.

export const FLOW_NAME = /^[a-z][a-z0-9-]{0,40}$/;

/** What the run's process must not inherit: it would be taken for a run of the chat that started it (see orchestration/CONVENTIONS.md). */
export const DROPPED_ENV = ["PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** @returns {Record<string, { kinds: string[], prepare: string, timeout: string, says: string }>} */
export function flowsOf(policy) {
  const out = {};
  for (const [name, f] of Object.entries(policy.flows ?? {})) {
    if (!FLOW_NAME.test(name) || !isObject(f)) continue;
    out[name] = { kinds: Array.isArray(f.kinds) ? f.kinds.map(String) : [], prepare: String(f.prepare ?? ""), timeout: String(f.timeout ?? "2h"), says: String(f.says ?? "") };
  }
  return out;
}

export const perDayOf = (policy) => (Number.isInteger(policy.flows?.perDay) && policy.flows.perDay >= 0 ? policy.flows.perDay : 3);

/** What `flows` says is wrong with the policy, as sentences (for doctor and the plugin's start). */
export function flowProblems(policy) {
  const out = [];
  for (const [name, f] of Object.entries(flowsOf(policy))) {
    if (f.kinds.length === 0) out.push({ key: `flows.${name}.kinds`, text: `flows.${name}.kinds 要列出这个流程管哪几种引用（比如 ["gcp"]），不写就一件事也起不了` });
    if (!f.prepare || !existsSync(f.prepare)) out.push({ key: `flows.${name}.prepare`, text: `flows.${name}.prepare 要写成准备输入的脚本的完整路径，文件要在` });
    if (parseDuration(f.timeout) === null) out.push({ key: `flows.${name}.timeout`, text: `flows.${name}.timeout 要写成 90m、30h 这样` });
  }
  return out;
}

/** "90m" / "30h" / "2d" / "45s" in milliseconds, or null. */
export function parseDuration(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/.exec(String(text));
  return m ? Math.round(Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]) : null;
}

/** Where the runs' events go: the same order the runtime uses (ORCH_LOG_DIR, then its config.json), so both look in one place. */
export function orchLogDir(policy) {
  if (process.env.ORCH_LOG_DIR) return process.env.ORCH_LOG_DIR;
  if (policy.flows?.logDir) return String(policy.flows.logDir);
  const home = path.join(os.homedir(), ".paseo-orchestration");
  try {
    const dir = JSON.parse(readFileSync(process.env.ORCH_CONFIG || path.join(home, "config.json"), "utf8")).logDir;
    if (typeof dir === "string" && dir) return dir;
  } catch {
    // no settings of its own: the default
  }
  return path.join(home, "logs");
}

/** The runtime's command, from policy or from where the command itself sits (the repository has both side by side). */
export function orchCommand(policy, bin) {
  if (policy.flows?.orch) return String(policy.flows.orch);
  const base = policy.binPath || bin;
  return base ? path.join(path.dirname(base), "..", "..", "orchestration", "runtime", "orch.mjs") : "";
}

export const eventsFile = (logDir, runId) => path.join(logDir, "runs", `${runId}.jsonl`);
export const claimFile = (logDir, runId) => path.join(logDir, "runs", `${runId}.claim`);

/** The last bytes of a file, as text (a run's last line is its end). */
function tailOf(file, bytes = 16_384) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether a run is over, and how: "over" with its outcome (a word from the runtime: done, stopped, failed, timeout), "going",
 * or "never" when it has no events and was started long enough ago that it is not just late. The line `run.end` is the last
 * line of a finished run (orchestration/EVENTS.md); a run whose process died leaves none, so one that has gone on longer than
 * its own time limit (and an hour) is taken as over too, lost, rather than blocking the affair for good.
 * @returns {{ state: "going" | "over" | "never", outcome: string }}
 */
export function runState({ events, startedAt, timeoutMs, now }) {
  let tail = "";
  try {
    tail = tailOf(events);
  } catch {
    // no events yet
  }
  for (const raw of tail.split("\n").reverse()) {
    if (!raw.includes('"run.end"')) continue;
    try {
      const line = JSON.parse(raw);
      if (line.kind === "run.end") return { state: "over", outcome: String(line.outcome ?? "") };
    } catch {
      // a half line
    }
  }
  const age = now - startedAt;
  if (!existsSync(events)) return age > 5 * 60_000 ? { state: "never", outcome: "" } : { state: "going", outcome: "" };
  return age > (timeoutMs ?? 2 * 3_600_000) + 3_600_000 ? { state: "over", outcome: "lost" } : { state: "going", outcome: "" };
}

/** The words for how a run ended, as he reads them. */
export const outcomeText = (outcome) => ({ done: "做完了", stopped: "停了", failed: "出错停了", timeout: "超时停了", lost: "没了下文", "": "" })[outcome] ?? outcome;

/** The environment the run's process gets: what is ours minus the identity of the session that asked; the daemon it is for stays. */
export function runEnv(base, { paseoHome = "", logDir = "" } = {}) {
  const env = { ...base };
  for (const name of DROPPED_ENV) delete env[name];
  if (paseoHome) env.PASEO_HOME = paseoHome;
  if (logDir) env.ORCH_LOG_DIR = logDir;
  return env;
}

/** The affair's label as the runtime takes it: one line, no control or invisible characters, at most 120 characters. */
export function labelOf(id, title) {
  // An affair is usually titled with its own number already ("#1234 …"): not said twice.
  const named = title.trimStart().startsWith(`#${id}`) ? title : `#${id} ${title}`;
  const clean = named.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034F\u115F\u1160\u180E\u2800\u3164\uFFA0]/gu, " ").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > 120 ? `${chars.slice(0, 119).join("")}…` : clean;
}

/** Runs the prepare program once and returns the flow's input (an object) or throws a sentence. */
export function prepareInput(file, args, { timeoutMs = 120_000, node = process.env.AFFAIR_NODE || "node" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [file], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env });
    let out = "";
    let err = "";
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      done(reject, new Error(`准备输入的脚本 ${Math.round(timeoutMs / 1000)} 秒没跑完`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => done(reject, new Error(`准备输入的脚本起不来：${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return done(reject, new Error(`读不到单子：${err.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 200) || `脚本退出码 ${code}`}`));
      try {
        const parsed = JSON.parse(out.trim());
        if (!isObject(parsed?.value)) throw new Error("没有 value");
        done(resolve, parsed.value);
      } catch (error) {
        done(reject, new Error(`准备输入的脚本输出不对（要 {value: {…}, summary}）：${error.message}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ args }));
  });
}

/**
 * Starts the runtime for a run, detached from this process and from the session that asked, and waits a few seconds to see
 * whether it was turned away at once (a bad input is refused before anything is spent, and says why in the run's claim).
 * `start` is how a process is made (tests put their own).
 * @returns {Promise<{ ok: true, pid: number | undefined } | { ok: false, why: string }>}
 */
export async function startRun({ node = process.env.AFFAIR_NODE || "node", args, cwd, env, logDir, runId, waitMs = 8000, start = spawn }) {
  let exited = null;
  let failed = null;
  const child = start(node, args, { cwd, env, detached: true, stdio: "ignore", windowsHide: true });
  child.on?.("exit", (code) => (exited = code));
  child.on?.("error", (error) => (failed = error));
  const events = eventsFile(logDir, runId);
  const until = Date.now() + waitMs;
  while (Date.now() < until && failed === null && exited === null && !existsSync(events)) await new Promise((r) => setTimeout(r, 100));
  child.unref?.();
  if (failed) return { ok: false, why: `起不来：${failed.message}` };
  if (existsSync(events)) return { ok: true, pid: child.pid };
  if (exited !== null && exited !== 0) {
    let why = `退出码 ${exited}`;
    try {
      const refused = JSON.parse(readFileSync(claimFile(logDir, runId), "utf8")).refused;
      if (typeof refused === "string" && refused) why = refused.split(/\r?\n/)[0].slice(0, 300);
    } catch {
      // no claim written: the exit code is all there is
    }
    return { ok: false, why };
  }
  // Neither events nor an exit within the wait: it is slow to load, not refused; the log has its id.
  return { ok: true, pid: child.pid };
}
