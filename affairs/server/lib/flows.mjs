import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { localParts } from "./time.mjs";

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

/** The words for how a run ended, as he reads them. */
export const outcomeText = (outcome) => ({ done: "做完了", stopped: "停了", failed: "出错停了", timeout: "超时停了", lost: "没了下文", "": "" })[outcome] ?? outcome;

/** Only an explicit end can offer the person a continuation. A lost writer needs its steward first. */
export const canResume = (st) => st?.state === "ended" && ["stopped", "failed", "timeout"].includes(st.outcome) && Boolean(st.resume?.print);
/** A run that was itself carried on from a stop, and that stopped at the very same declared point: carrying on again would spend the same money to arrive at the same place. */
export function sameSpotAgain(runs, latest, st) {
  const print = st?.resume?.print;
  if (!latest?.resumeOf || !print) return false;
  const prev = runs.find((f) => f.runId === latest.resumeOf);
  return Boolean(prev) && (prev.resume?.print ?? "") === print;
}
export const SAME_SPOT_TEXT = "刚接着跑过一次，同一处又停了";
export const resumeRefusal = (why) => /not the one that was shown/.test(why) ? "接着做的位置变了，请刷新后再点一次。" : /already carried on|being carried on/.test(why) ? "这次停下已经接着跑过了，请看最新的一次。" : `没接上：${why}`;

export const flowMessageId = (runId) => `affair-flow:${runId}`;

/** The runtime alone decides which missing writers are known dead and which steward should hear. */
export const wakeLostRuns = ({ orch, logDir, paseoHome }) => promisify(execFile)(process.env.AFFAIR_NODE || "node", [orch, "wake-lost"], { env: runEnv(process.env, { paseoHome, logDir }), windowsHide: true, timeout: 60_000 });

/** A fixed message, rather than a second model's interpretation of the result. */
export function flowFinishedMessage(ctx, s, f, st) {
  const nth = (s.flows ?? []).filter((x) => x.flow === f.flow && !x.failed && x.seq <= f.seq).length;
  const began = localParts(Date.parse(f.at), ctx.policy.tz).text.slice(5);
  const cost = Number.isFinite(st?.costUsd ?? f.costUsd) ? `$${(st?.costUsd ?? f.costUsd).toFixed(3)}` : "";
  const result = f.marks.find((m) => m.key === "end")?.text ?? outcomeText(f.outcome);
  const again = sameSpotAgain(s.flows ?? [], f, st);
  const resume = canResume(st) && !again ? `可以接着跑：${st.resume.from}${st.resume.spends === "maybe" ? "（会再花钱）" : ""}；只在他说要之后才接着跑。` : again ? "刚接着跑过一次，同一处又停了，先别再接着跑。" : f.outcome === "done" ? "" : f.outcome === "lost" ? "不能直接接着跑，先由负责的人确认做到哪了。" : !st ? "没拿到能否接着跑的状态，先查清楚，别猜。" : "没有能接着做的位置，不能接着跑；要重来得从头新起（约 $0.5）。";
  return [
    `事项 ${s.id} 的流程 ${f.flow} 第 ${nth} 次（${began} 起的那次）结束了：${result}。${cost ? `花费 ${cost}。` : "花费未拿到。"}`,
    f.outcome === "done" ? `结果：${st?.summary || f.summary || "没有另写摘要"}。` : "",
    resume,
    "先看最新进展，再用一两句话告诉他。只汇报，不要再起任何东西；这条不是他的授权。",
  ].filter(Boolean).join("\n");
}

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

// --- What `orch.mjs status` says, read for the person -----------------------------------------------------------------------

/**
 * The runtime's status of a run (`orch.mjs status <runId>`), or null when it cannot be had (the command is missing, it printed
 * nothing that parses): the caller then takes the run as going, since it cannot tell it is not.
 * @returns {Promise<any | null>}
 */
export function readStatus({ node = process.env.AFFAIR_NODE || "node", orch, logDir, runId, spawnedAt = null, timeoutMs = 20_000, env = process.env }) {
  return new Promise((resolve) => {
    if (!orch) return resolve(null);
    const args = [orch, "status", runId, ...(spawnedAt ? ["--spawned-at", String(spawnedAt)] : [])];
    const child = spawn(node, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { ...env, ORCH_LOG_DIR: logDir } });
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => (clearTimeout(timer), resolve(null)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(out);
        resolve(isObject(parsed) && typeof parsed.state === "string" ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** The runtime's states that say a run has been given up on: the claim is stale. Read once, that is a doubt and no more (see `liveOf`). */
export const lostLike = (st) => ["lost", "dead-before-start"].includes(st?.state);

/**
 * What the runtime's states come to for the affair: still on, over (with how), never started, or in doubt. Only a state that says
 * for certain that a run has ended gives "over", and one that says it never began gives "never". A stale claim (`lost`,
 * `dead-before-start`) is a doubt until it has been read twice, a heartbeat apart (EVENTS.md: a machine that slept looks like it),
 * and `stalled-before-start` (stale, but its process is alive) and any state not known here count as going: nothing is started on top.
 * @returns {{ state: "going" | "over" | "never" | "doubt", outcome: string }}
 */
export function liveOf(st) {
  if (st.state === "ended") return { state: "over", outcome: String(st.outcome ?? "") };
  if (lostLike(st)) return { state: "doubt", outcome: "lost" };
  if (["absent", "refused"].includes(st.state)) return { state: "never", outcome: "" };
  return { state: "going", outcome: "" };
}

/** The directory a run's files are in: the one its entry in the log was made with (`<dir>/runs/<id>.jsonl`), else `fallback`. */
export const logDirOf = (entry, fallback) => (entry?.events ? path.dirname(path.dirname(entry.events)) : fallback);

/**
 * Who answers a gate's card in the runtime (`orch.mjs gate-carrier`): { provider, carrier: "provider" | "model", family }, or null when
 * it cannot be had.
 * @returns {Promise<{ provider: string, carrier: string, family: string } | null>}
 */
export function readGateCarrier({ node = process.env.AFFAIR_NODE || "node", orch, env = process.env, timeoutMs = 20_000 }) {
  return new Promise((resolve) => {
    if (!orch) return resolve(null);
    const child = spawn(node, [orch, "gate-carrier"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env });
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => (clearTimeout(timer), resolve(null)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(out);
        resolve(isObject(parsed) && typeof parsed.carrier === "string" && typeof parsed.family === "string" ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

const clip = (text, n) => {
  const chars = [...String(text ?? "").replace(/\s+/g, " ").trim()];
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : chars.join("");
};

/** "不到 1 分钟", "4 分钟", "2 小时 5 分", "1 天 3 小时". */
export function spanText(ms) {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "不到 1 分钟";
  if (min < 60) return `${min} 分钟`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ""}`;
  return `${Math.floor(min / 1440)} 天${Math.floor((min % 1440) / 60) ? ` ${Math.floor((min % 1440) / 60)} 小时` : ""}`;
}

/** What a run cost, or nothing when it is under a cent: "$0.00" says nothing. */
export const usdText = (usd) => (Number.isFinite(usd) && usd >= 0.01 ? "$" + (usd < 10 ? usd.toFixed(2) : usd.toFixed(1)) : "");

/** What a card's answer comes to in a few words, for a step in the history of a run. */
function gateWords(g) {
  // The card is a question ("…，开始出补丁？"): said after the answer, the question mark goes.
  const t = clip(g.title, 24).replace(/[？?]$/, "");
  if (g.state === "waiting") return `等你批：${t}`;
  if (g.state === "allowed") return `批了：${t}`;
  if (g.state === "denied") return `没批：${t}${g.reason ? `（${clip(g.reason, 24)}）` : ""}`;
  if (g.state === "expired") return `没批，过期了：${t}`;
  return `没批成：${t}`;
}

/**
 * What went wrong, for the few kinds that are known, in words ("：等回答超时"); anything else is just "出错停了": the runtime's own words
 * are English and about its inside, and are kept in the run's details, not in the chat or on the panel.
 */
function errorWords(error) {
  const said = `${error?.name ?? ""} ${error?.message ?? ""}`;
  if (/time[ds]? ?out/i.test(said)) return "：等回答超时";
  if (/OUTPUT_SCHEMA_FAILED/.test(said)) return "：回答格式不对";
  return "";
}

/** How a run ended, in words: [text, bad]. */
export function endWords(st) {
  const cost = usdText(st.costUsd);
  const tail = cost ? ` · ${cost}` : "";
  if (st.state === "lost") return ["没了下文，不知道做到哪了", true];
  if (st.outcome === "done") return [`做完了${st.summary ? `：${clip(st.summary, 50)}` : ""}${tail}`, false];
  if (st.outcome === "stopped") return [`停了${st.stop?.reason ? `：${clip(st.stop.reason, 50)}` : ""}${tail}`, true];
  if (st.outcome === "timeout") return [`超时停了${tail}`, true];
  return [`出错停了${errorWords(st.error)}${tail}`, true];
}

/**
 * The steps of a run the log should hold, from its status: a card waiting, a card answered (the waiting is held too if it was
 * not seen), the end. Each has a key that is the same every time the same step is seen, so a step is written once.
 * @returns {Array<{ key: string, text: string, tone: "normal" | "red", outcome?: string, summary?: string, costUsd?: number | null }>}
 */
export function marksOf(st) {
  const out = [];
  for (const g of st.gates ?? []) {
    out.push({ key: `gate:${g.callId}:waiting`, text: gateWords({ ...g, state: "waiting" }), tone: "normal" });
    if (g.state !== "waiting") out.push({ key: `gate:${g.callId}:${g.state}`, text: gateWords(g), tone: g.state === "allowed" ? "normal" : "red" });
  }
  const over = st.state === "ended" || st.state === "lost";
  if (over) {
    const [text, bad] = endWords(st);
    const outcome = st.state === "lost" ? "lost" : String(st.outcome ?? "");
    out.push({ key: "end", text, tone: bad ? "red" : "normal", outcome, summary: String(st.summary ?? ""), costUsd: Number.isFinite(st.costUsd) ? st.costUsd : null, resume: canResume(st) ? st.resume : null });
  }
  return out;
}

/**
 * The sentence for a run as the chat and the panel say it. `st` is the live status when there is one; `f` is the run's entry
 * in the log, which holds what was seen before (so a restart, or a run seen only after it ended, still reads right).
 * `short` is what it is doing in a word or two (the phase, 等你批, 做完了), `rest` what goes with it (the card, the result): the block on the
 * panel gives them two lines, the chat one sentence.
 * @returns {{ text: string, short: string, rest: string, tone: "normal" | "warn" | "red", waiting: boolean, over: boolean, agentId: string | null }}
 */
/** "做完了：提交了 r1 · $2.40" is ["做完了", "提交了 r1"]; a text with no "：" has nothing after it. */
const splitText = (text) => {
  const body = text.replace(/ · \$[\d.]+$/, "");
  const at = body.indexOf("：");
  return at < 0 ? [body, ""] : [body.slice(0, at), body.slice(at + 1)];
};

export function sentenceOf(f, st, now) {
  const marks = f.marks ?? [];
  const last = marks[marks.length - 1];
  const waitingGate = st ? (st.gates ?? []).find((g) => g.state === "waiting") : null;
  if (f.outcome || (st && (st.state === "ended" || st.state === "lost"))) {
    const text = f.outcome ? marks.find((m) => m.key === "end")?.text ?? "" : endWords(st)[0];
    const bad = f.outcome ? f.outcome !== "done" : endWords(st)[1];
    const [short, rest] = splitText(text);
    return { text, short, rest, tone: bad ? "red" : "normal", waiting: false, over: true, agentId: null };
  }
  if (waitingGate) {
    const text = `等你批：${clip(waitingGate.title, 24)}`;
    return { text, short: "等你批", rest: clip(waitingGate.title, 40), tone: "warn", waiting: true, over: false, agentId: waitingGate.agentId ?? null };
  }
  if (!st) {
    const waitingMark = last && /^等你批/.test(last.text) ? last : null;
    const text = waitingMark ? waitingMark.text : last ? "在跑" : "刚起，在准备";
    const [short, rest] = splitText(text);
    return { text, short, rest, tone: waitingMark ? "warn" : "normal", waiting: Boolean(waitingMark), over: false, agentId: null };
  }
  const doing = st.phase?.title ? clip(st.phase.title, 16) : "在跑";
  return { text: `${doing} · ${spanText(now - Date.parse(f.at))}`, short: doing, rest: "", tone: "normal", waiting: false, over: false, agentId: null };
}

/** The latest run that ended after the "现在" was written, so the "现在" does not know of it yet; null when there is none. */
export function endedAfterNow(s) {
  const nowAt = s.nowAt ? Date.parse(s.nowAt) : 0;
  const late = (s.flows ?? []).filter((f) => !f.failed && f.endedAt && Date.parse(f.endedAt) > nowAt);
  return late.length ? late[late.length - 1] : null;
}
