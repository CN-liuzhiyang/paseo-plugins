import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFacts, checkReport, earliestOf, plainText, secretIn, skeletonOf, verifyEvidence } from "./check.mjs";
import { mayLook, tripped } from "./limits.mjs";
import { append, isOpen, listIds, load as loadState, nextId, read } from "./log.mjs";
import { policyProblems } from "./policy.mjs";
import { json, makeRun } from "./paseo.mjs";
import * as readers from "./readers.mjs";
import * as schedule from "./schedule.mjs";
import { isoLocal, localParts, parseLocal, speak } from "./time.mjs";
import { linkOf, md, say, stamp } from "./view.mjs";
import * as workspace from "./workspace.mjs";
import { loadPolicy, defaultRoot } from "./policy.mjs";

// The operations behind the `affair` command and the plugin. Every one reads the log, appends to it and then makes
// Paseo (schedule, workspace) agree; the replies are the sentences a person may read.

/** @typedef {{ ok: boolean, text: string, [key: string]: any }} Result */

// The host evaluates a plugin as one bundle, where import.meta.url is not there: run from the plugin, the command's
// path comes from policy.binPath; run as the command itself, it is this file's own place.
const HERE = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return "";
  }
})();
export const BIN = HERE ? path.join(HERE, "..", "..", "bin", "affair.mjs") : "";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STALE_RUN_MS = 45 * 60_000;
/** Taking an affair up again is something he says at the start of a sentence ("还没完", "接着盯洗牙"); "不用接着盯了" is not. */
const REOPEN = /^\s*(?:还没完|接着盯)/;
/** A look that was checked when it was asked for may start within this long without being checked again. */
const CLEARED_MS = 10 * 60_000;

export function makeCtx(options = {}) {
  const root = options.root ?? defaultRoot();
  const paseoHome = options.paseoHome ?? process.env.PASEO_HOME ?? "";
  const policy = options.policy ?? loadPolicy(root);
  const flags = [options.root ? `--root "${root}"` : "", options.paseoHome ? `--paseo-home "${paseoHome}"` : ""].filter(Boolean).join(" ");
  return {
    root, policy, paseoHome,
    run: options.run ?? makeRun({ home: paseoHome || null }),
    now: options.now ?? Date.now,
    command: options.command ?? ((policy.binPath || BIN) ? `node "${policy.binPath || BIN}"` : "affair") + (flags ? ` ${flags}` : ""),
    waitMs: options.waitMs ?? 3000,
    // Who is calling: "human" (the person's side: a conversation, the plugin) or "look" (a session the schedule started).
    // The command works it out from the session it runs in; there is no way to say it in words or in the environment.
    by: options.by ?? "human",
  };
}

/** @returns {any} */
const state = (ctx, id) => loadStateWithLines(ctx.root, id);

function loadStateWithLines(root, id) {
  const lines = read(root, id);
  return { ...loadState(root, id), lines };
}

const write = (ctx, id, entries) => append(ctx.root, id, entries, { now: ctx.now(), tz: ctx.policy.tz });
/** @returns {Result} */
const fail = (text) => ({ ok: false, text });

const refuseSecret = (text) => (secretIn(text) ? fail(`这句话里有${secretIn(text)}的东西，没记下。要记就说「有个令牌」，别贴原文。`) : null);

export function paseoUrl(ctx, s) {
  const home = ctx.paseoHome || path.join(process.env.USERPROFILE || process.env.HOME || "", ".paseo");
  const file = path.join(home, "server-id");
  if (!s.conversationId || !existsSync(file)) return "";
  return `paseo://h/${readFileSync(file, "utf8").trim()}/agent/${s.conversationId}`;
}

const linkTextOf = (ctx, s) => linkOf(paseoUrl(ctx, s), ctx.policy);

export function writeProgress(ctx, s) {
  const dir = path.join(ctx.root, s.id);
  mkdirSync(dir, { recursive: true });
  const lines = [`# ${s.title}`, `目标：${s.goal}`, `现在：${s.nowText}`, s.next ? `下次：${s.next.at}（${s.next.waitingFor}）` : "", "", "记住的：", ...s.facts.map((f) => `- ${f}`)];
  writeFileSync(path.join(dir, "progress.md"), `${lines.join("\n")}\n`);
}

/**
 * Who the process calling is: "look" for a session the schedule started (Paseo labels it), "human" for any other session
 * or a plain terminal. A session that has an agent id but whose kind cannot be read counts as a look: when in doubt it is
 * the stricter side. (A look that cleared its own environment would look like a terminal; that cannot be told apart.)
 */
export async function callerOf(ctx) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) return "human";
  try {
    const info = await json(ctx.run, ["agent", "inspect", agentId]);
    return JSON.stringify(info?.labels ?? {}).includes("paseo.schedule-id") ? "look" : "human";
  } catch {
    return "look";
  }
}

const byLook = (ctx) => ctx.by === "look";
/** @returns {Result} */
const lookRefused = (what) => fail(`这是看一眼的会话，不能${what}，只有他本人在对话里说了算。看到了什么用 report 交回，想记下自己的观察用 note。`);

/** @returns {{ hits: any[], names: string[] }} */
export function find(ctx, word, { closed = false } = {}) {
  const open = listIds(ctx.root).map((id) => loadState(ctx.root, id)).filter((s) => !s.system && (closed || isOpen(s)));
  const w = word.trim().toLowerCase().replace(/^#/, "");
  const hits = open.filter((s) => s.id.toLowerCase() === w || s.title.toLowerCase().includes(w) || (w && s.title.toLowerCase().replace(/^#/, "").includes(w)));
  return { hits, names: open.map((s) => s.title) };
}

/** An id or a name to the one affair meant, or the sentence that asks which. */
/** @returns {{ s?: any, text?: string }} */
export function resolve(ctx, ref, { closed = false } = {}) {
  if (/^(?:D\d+|\d{3,9})$/.test(ref) && existsSync(path.join(ctx.root, ref))) return { s: state(ctx, ref) };
  let { hits, names } = find(ctx, ref);
  if (hits.length === 0 && closed) hits = find(ctx, ref, { closed: true }).hits;
  if (hits.length === 1) return { s: state(ctx, hits[0].id) };
  return { text: hits.length > 1 ? say.which(hits.map((h) => h.title)) : say.notFound(ref, names) };
}

/** @returns {Promise<Result>} */
async function ringNow(ctx, s, why, { force = false } = {}) {
  if (!isOpen(s) || s.system) return { ok: false, text: "" };
  if (s.breaker) return { ok: false, text: say.stoppedByBreaker(s.title) };
  const now = ctx.now();
  const gate = mayLook(ctx.root, s.id, now, ctx.policy, { force });
  if (!gate.ok) {
    write(ctx, s.id, [{ kind: "budget", blocked: gate.text, until: isoLocal(gate.until, ctx.policy.tz) }]);
    return { ok: false, text: say.budget(s.title, gate.text) };
  }
  const trip = tripped(ctx.root, now, ctx.policy, s.id);
  if (trip.tripped) {
    await stopForBreaker(ctx, s.id, trip);
    return { ok: false, text: `看得太频繁了（${trip.text}），先停一下。` };
  }
  if (s.running && now - Date.parse(s.runningSince) < STALE_RUN_MS) return { ok: true, queued: true, text: "" };
  if (!s.scheduleId) return { ok: false, text: "" };
  // The limits were checked here, for this look; the look's own start does not count it twice.
  write(ctx, s.id, [{ kind: "cleared", why, force }]);
  try {
    await schedule.runOnce(ctx.run, s.scheduleId);
  } catch (error) {
    write(ctx, s.id, [{ kind: "cleared", void: true }]);
    // Paseo refuses a second run while one is going; the reason stays in the log for the look that is on.
    if (/already running/i.test(error.message)) {
      write(ctx, s.id, [{ kind: "ring", why }]);
      return { ok: true, queued: true, text: "" };
    }
    write(ctx, s.id, [{ kind: "flag", what: "look", detail: error.message }]);
    return { ok: false, text: "" };
  }
  return { ok: true, queued: false, text: "" };
}

/** Looking far too often: this affair's plan is paused and the person is asked once; "接着看" lets it go on. */
async function stopForBreaker(ctx, id, trip) {
  const s = state(ctx, id);
  if (s.breaker) return;
  write(ctx, id, [
    { kind: "flag", what: "breaker", detail: trip.text },
    { kind: "asked", id: `${id}-${s.asks.length + 1}`, for: "breaker", title: `${s.title}：先停着`, line: `${trip.text}，我先停了这件事。没问题就点「接着看」。`, options: ["接着看", "不用盯了"] },
  ]);
  await syncPlan(ctx, id);
}

export const requestLook = (ctx, id, why, options) => ringNow(ctx, state(ctx, id), why, options);

function claudeMd(ctx, s) {
  return [
    `# ${s.title}`,
    "",
    `这是他让我盯着的一件事（编号 ${s.id}）。这个目录里：log.jsonl 是经过（只往后加，别手改）、progress.md 是进展、files/ 放他发来的东西。`,
    `要改什么都用命令，不要直接改文件：${ctx.command} show ${s.id}（看进展）、note（记他说的话）、report（看一眼的结果）。`,
    "只碰这一件事的目录。不要写密码、令牌、配对链接。",
    "",
  ].join("\n");
}

/** @returns {Promise<Result>} */
export async function create(ctx, input) {
  if (byLook(ctx)) return lookRefused("新建事项");
  const { title, goal = "", said = "", link = null, domain = "work", deadline = null, deadlineQuote = "", noWait = false } = input;
  const secret = refuseSecret(`${title} ${goal} ${said}`);
  if (secret) return secret;
  const policy = ctx.policy;
  const now = ctx.now();
  const kind = link?.split(":")[0];
  // Only a plain number after the kind names a ticket ("gcp:#700", "gcp:700/字段"); other digits in a link are not its number.
  const ref = /^#?(\d{3,9})(?:[\/\s].*)?$/.exec(link?.split(":").slice(1).join(":") ?? "")?.[1] ?? "";
  const role = input.role ?? (kind && policy.roleByKind?.[kind]) ?? undefined;
  const open = listIds(ctx.root).map((x) => loadState(ctx.root, x)).filter((s) => isOpen(s) && !s.system);
  const id = kind && /^\d{3,9}$/.test(ref) ? ref : nextId(ctx.root);
  const existing = open.find((s) => s.id === id);
  if (existing) return { ok: true, text: say.already(existing.title, existing.next ? speak(Date.parse(existing.next.at), now, policy.tz) : "稍后", linkTextOf(ctx, existing)), id };
  if (!title?.trim()) return fail("要有一个名字：--title");
  // A ticket that was watched before and is over (or never got made): the person asked again, so it is watched again.
  const before = kind && existsSync(path.join(ctx.root, id)) ? loadState(ctx.root, id) : null;
  if (before?.id && !isOpen(before)) {
    if (open.length >= policy.limits.maxActive) return fail(say.tooMany(open.length));
    if (said) write(ctx, id, [{ kind: "said", text: said, via: input.via ?? "chat", by: "user" }]);
    const again = await resume(ctx, id);
    return { ...again, id, text: again.ok ? say.restarted(before.title, before.status) : again.text };
  }
  if (open.length >= policy.limits.maxActive) return fail(say.tooMany(open.length));
  const workdir = workspace.workdirOf(ctx.root, id, link, policy);
  const dir = path.join(ctx.root, id);
  mkdirSync(path.join(dir, "files"), { recursive: true });
  write(ctx, id, [{ kind: "created", id, title: title.trim(), goal, domain, link, workdir, paseoHome: ctx.paseoHome, role: role ?? "" }]);
  let s = state(ctx, id);
  writeFileSync(path.join(dir, "CLAUDE.md"), claudeMd(ctx, s));
  writeProgress(ctx, s);
  if (said) {
    const [line] = write(ctx, id, [{ kind: "said", text: said, via: input.via ?? "chat", by: "user" }]);
    if (deadline) {
      const at = parseLocal(deadline, policy.tz);
      if (at === null) return fail("--deadline 要写成 YYYY-MM-DD HH:mm");
      write(ctx, id, [{ kind: "deadline", deadline: isoLocal(at, policy.tz), from: `said:${line.seq}`, quote: deadlineQuote || said }]);
    }
  }
  try {
    const projectId = await workspace.ensureProject(ctx.run, ctx.root);
    const workspaceId = await workspace.createWorkspace(ctx.run, { projectId, workdir, title: title.trim() });
    write(ctx, id, [{ kind: "workspace", workspaceId, projectId, title: title.trim() }]);
    // Until the first look reports, the plan is a day away so a look that never comes back is still looked for.
    const scheduleId = await schedule.create(ctx.run, { id, policy, workspaceId, atMs: now + policy.fallbackMinutes * 60_000, command: ctx.command, role });
    write(ctx, id, [{ kind: "schedule", scheduleId }]);
    s = state(ctx, id);
    const look = await ringNow(ctx, s, "created");
    if (!look.ok && look.text) write(ctx, id, [{ kind: "flag", what: "first-look", detail: look.text }]);
  } catch (error) {
    await rollbackCreate(ctx, id, error);
    return fail(`没建成「${title}」：${error.message}。什么都没留下，再说一次就行。`);
  }
  if (!noWait) await waitForConversation(ctx, id);
  s = state(ctx, id);
  return { ok: true, id, text: say.started(s.title, linkTextOf(ctx, s)) };
}

/** A half-made affair is taken apart: what was made in Paseo is put away, and the affair is over, so it blocks nothing. */
async function rollbackCreate(ctx, id, error) {
  const s = state(ctx, id);
  if (s.scheduleId) await schedule.remove(ctx.run, s.scheduleId).catch(() => undefined);
  if (s.workspaceId) {
    await workspace.archiveWorkspace(ctx.run, s.workspaceId).catch(() => undefined);
    write(ctx, id, [{ kind: "workspace", archived: true }]);
  }
  write(ctx, id, [{ kind: "flag", what: "setup", detail: error.message }, { kind: "status", status: "stopped", evidence: "没建成", by: "system" }]);
}

async function waitForConversation(ctx, id) {
  const until = Date.now() + ctx.waitMs;
  while (Date.now() < until && !state(ctx, id).conversationId) await new Promise((r) => setTimeout(r, 100));
}

/** A thing the person said: recorded as theirs only when it was not a look's session that said it. */
/** @returns {Promise<Result>} */
export async function note(ctx, ref, input) {
  if (!String(input.said ?? "").trim()) return fail("没有话可记：--said 后面要有内容。");
  const isLook = byLook(ctx);
  const r = resolve(ctx, ref, { closed: !isLook && REOPEN.test(input.said) });
  if (!r.s) return fail(r.text);
  const { s } = r;
  const secret = refuseSecret(input.said);
  if (secret) return secret;
  // What a look writes is its own view of things; only the person's side writes what he said.
  const by = isLook ? "look" : "user";
  if (isLook && input.deadline) return fail("看一眼记的话不算他说的，不能带 --deadline；截止要他本人说了才算。");
  if (!isOpen(s)) {
    if (by !== "user" || !REOPEN.test(input.said)) return fail(`「${s.title}」已经${s.status === "done" ? "办完" : "不盯"}了。要接着盯就说「接着盯${s.title}」。`);
    write(ctx, s.id, [{ kind: "said", text: input.said, via: input.via ?? "chat", by }]);
    return resume(ctx, s.id);
  }
  const [line] = write(ctx, s.id, [{ kind: "said", text: input.said, via: input.via ?? "chat", by }]);
  if (input.deadline) {
    const at = parseLocal(input.deadline, ctx.policy.tz);
    if (at === null) return fail("--deadline 要写成 YYYY-MM-DD HH:mm");
    write(ctx, s.id, [{ kind: "deadline", deadline: isoLocal(at, ctx.policy.tz), from: `said:${line.seq}`, quote: input.said }]);
  }
  if (by !== "user") return { ok: true, text: `记下了（这是你的观察，不算他说的）。`, seq: line.seq };
  const look = await ringNow(ctx, s, `said:${line.seq}`, { force: /再看一次/.test(input.said) });
  const text = say.noted(s.title, input.said, linkTextOf(ctx, s));
  return { ok: true, text: look.text ? `${text}\n${look.text}` : text, seq: line.seq };
}

/** @returns {Promise<Result>} */
export async function answer(ctx, ref, qid, text, via = "chat") {
  if (byLook(ctx)) return lookRefused("替他回答问题");
  if (!String(text ?? "").trim()) return fail("没有答案可记：--said 后面要有内容。");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const { s } = r;
  const secret = refuseSecret(text);
  if (secret) return secret;
  const q = s.asks.find((a) => a.id === qid);
  if (!q) return fail(`没有这个问题：${qid}`);
  if (q.state !== "open") return { ok: true, text: say.answeredAlready(q.answer || "收起了") };
  write(ctx, s.id, [{ kind: "answered", id: qid, answer: text, via }]);
  if (/^不用盯了$/.test(text.trim())) return stop(ctx, s.id, { evidence: text });
  if (q.for === "breaker" && text.trim() === "接着看") {
    write(ctx, s.id, [{ kind: "breaker.reset" }]);
    await syncPlan(ctx, s.id);
    const go = await ringNow(ctx, state(ctx, s.id), "breaker");
    return { ok: true, text: go.text || "好，接着看。" };
  }
  const proposal = q.proposal ?? null;
  if (proposal && /^(可以|两周后看)$/.test(text.trim())) {
    const at = text.trim() === "可以" ? Date.parse(proposal.at) : ctx.now() + 14 * DAY;
    write(ctx, s.id, [{ kind: "next", next: isoLocal(at, ctx.policy.tz), waitingFor: proposal.waitingFor, why: proposal.why, earlyIf: [], verdict: "recorded", source: "user", detail: "你点了头" }]);
    await syncPlan(ctx, s.id);
    return { ok: true, text: say.paused(s.title, speak(at, ctx.now(), ctx.policy.tz)) };
  }
  const look = await ringNow(ctx, s, `answered:${qid}`);
  return { ok: true, text: look.text || `收到。` };
}

/** @returns {Promise<Result>} */
export async function stop(ctx, id, { evidence = "", done = false } = {}) {
  if (byLook(ctx)) return lookRefused("替他说不用盯了");
  const s = state(ctx, id);
  write(ctx, id, [{ kind: "status", status: done ? "done" : "stopped", evidence, by: "user" }]);
  await syncPlan(ctx, id);
  return { ok: true, text: say.stopped(s.title) };
}

/** @returns {Promise<Result>} */
export async function resume(ctx, ref) {
  if (byLook(ctx)) return lookRefused("让办完的事接着盯");
  const r = resolve(ctx, ref, { closed: true });
  if (!r.s) return fail(r.text);
  const { s } = r;
  write(ctx, s.id, [{ kind: "status", status: "watching", evidence: "" }, ...(s.held ? [{ kind: "hold", on: false }] : [])]);
  // Archived since it ended: the same folder gets a new workspace and plan, and the old ones stay in the archive.
  if (!s.workspaceId) {
    try {
      const projectId = await workspace.ensureProject(ctx.run, ctx.root);
      const workspaceId = await workspace.createWorkspace(ctx.run, { projectId, workdir: s.workdir || path.join(ctx.root, s.id), title: s.title });
      write(ctx, s.id, [{ kind: "workspace", workspaceId, projectId, title: s.title }]);
      const scheduleId = await schedule.create(ctx.run, { id: s.id, policy: ctx.policy, workspaceId, atMs: ctx.now() + ctx.policy.fallbackMinutes * 60_000, command: ctx.command, role: s.roleName || undefined });
      write(ctx, s.id, [{ kind: "schedule", scheduleId }]);
    } catch (error) {
      return fail(`没能接着盯「${s.title}」：${error.message}`);
    }
  }
  await syncPlan(ctx, s.id);
  const look = await ringNow(ctx, state(ctx, s.id), "resume");
  return { ok: true, text: look.text ? `${say.resumed(s.title)}\n${look.text}` : say.resumed(s.title) };
}

/**
 * "先放一放": only from the person's side, and the time goes through the same check as a look's. His own words (--said) are
 * what back a time past the usual limit; without them it has to be within it.
 * @returns {Promise<Result>}
 */
export async function pause(ctx, ref, until, said = "") {
  if (byLook(ctx)) return lookRefused("改下次看的时间");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  let { s } = r;
  const policy = ctx.policy;
  const now = ctx.now();
  const at = parseLocal(until, policy.tz);
  if (at === null || at <= now) return fail("--until 要写成 YYYY-MM-DD HH:mm，在现在之后");
  if (at > now + policy.check.hardDays * DAY) return fail("最远一年；更久的事先不盯，到时候重新交代。");
  const evidence = [];
  if (String(said).trim()) {
    const [line] = write(ctx, s.id, [{ kind: "said", text: said.trim(), via: "chat", by: "user" }]);
    evidence.push({ quote: said.trim(), from: `said:${line.seq}` });
    s = state(ctx, s.id);
  }
  const waitingFor = `先放到${localParts(at, policy.tz).mo}月${localParts(at, policy.tz).d}日`;
  const result = checkReport({ report: { status: "先放一放", entry: "先放一放", next: { at: until, waitingFor, why: "你说先放一放", earlyIf: [], evidence } }, state: s, facts: buildFacts(s, now, policy), policy, now, attempt: 1 });
  const backed = evidence.length > 0 && (result.verdict === "ask" || result.verdict === "appeal");
  if (result.verdict === "rejected" || ((result.verdict === "ask" || result.verdict === "appeal") && !backed)) {
    return fail(`这个时间没放进去：${result.problems.map((p) => p.text).join("；") || result.detail}。要放得更远，带上他的原话（--said）。`);
  }
  write(ctx, s.id, [{ kind: "next", next: isoLocal(at, policy.tz), waitingFor, why: "你说先放一放", earlyIf: [], verdict: backed ? "recorded" : result.verdict, source: "user", detail: evidence.length ? "他说的，原话在记录里" : "" }]);
  await syncPlan(ctx, s.id);
  return { ok: true, text: say.paused(s.title, speak(at, ctx.now(), ctx.policy.tz)) };
}

/** @returns {Result} */
export function undo(ctx, ref) {
  if (byLook(ctx)) return lookRefused("撤他说的话");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const last = [...r.s.said].reverse().find((x) => !x.undone && x.by === "user");
  if (!last) return fail(say.nothingToUndo());
  write(ctx, r.s.id, [{ kind: "undo", target: last.seq }]);
  return { ok: true, text: say.undone(last.text) };
}

/** Makes the plan agree with the log; a failure is written down and tried again at the next start or command. */
/** @returns {Promise<{ changed: string[], problem: string }>} */
export async function syncPlan(ctx, id) {
  const s = state(ctx, id);
  try {
    const result = await schedule.sync(ctx.run, s, ctx.policy);
    if (result.problem) write(ctx, id, [{ kind: "flag", what: "schedule", detail: result.problem }]);
    else if (result.changed.length) write(ctx, id, [{ kind: "schedule.fix", changed: result.changed }]);
    return result;
  } catch (error) {
    write(ctx, id, [{ kind: "flag", what: "schedule", detail: error.message }]);
    return { changed: [], problem: error.message };
  }
}

/** @returns {Promise<Result>} */
export async function brief(ctx, ref) {
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const { s } = r;
  if (!isOpen(s) || s.system) return fail("这件事已经办完或者不盯了，不用看。");
  const now = ctx.now();
  const tz = ctx.policy.tz;
  const cur = s.wakes[s.wakes.length - 1];
  // Asking for the brief again before handing anything in is the same look, not another one.
  const again = Boolean(s.running && cur && !cur.reported && now - Date.parse(cur.at) < STALE_RUN_MS);
  const reasons = again ? [...cur.why] : [...s.pending];
  if (!again) {
    if (s.breaker) return fail(say.stoppedByBreaker(s.title));
    // A look somebody asked for was checked when it was asked; one the schedule starts is checked here. Both count.
    const cleared = s.cleared && now - Date.parse(s.cleared.at) < CLEARED_MS;
    if (!cleared) {
      const gate = mayLook(ctx.root, s.id, now, ctx.policy);
      if (!gate.ok) {
        write(ctx, s.id, [
          { kind: "budget", blocked: gate.text, until: isoLocal(gate.until, tz) },
          { kind: "next", next: isoLocal(gate.until, tz), waitingFor: s.next?.waitingFor ?? "", why: "今天看够了", earlyIf: [], verdict: "pass", source: "budget", detail: "" },
        ]);
        await syncPlan(ctx, s.id);
        return fail(`今天看到上限了：${gate.text}。这次不看，什么也不用交。`);
      }
      const trip = tripped(ctx.root, now, ctx.policy, s.id);
      if (trip.tripped) {
        await stopForBreaker(ctx, s.id, trip);
        return fail(`看得太频繁了（${trip.text}），已经停下，等他点头。这次不看，什么也不用交。`);
      }
    }
  }
  const due = s.next && now >= Date.parse(s.next.at) - 5 * 60_000;
  if (reasons.length === 0) reasons.push("time");
  if (!again) {
    const gapMinutes = cur ? Math.round((now - Date.parse(cur.at)) / 60_000) : null;
    const failed = s.wakes.length > 0 && !cur.reported;
    const fallbackAt = now + (failed ? DAY : ctx.policy.fallbackMinutes * 60_000);
    const lines = [{ kind: "wake", why: reasons, gapMinutes, estUsd: schedule.roleOf(ctx.policy, s.roleName || undefined).estimateUsd ?? 0 }];
    if (reasons.length === 1 && reasons[0] === "time" && !due && s.next && s.wakes.length > 0) lines.push({ kind: "flag", what: "no-reason", detail: "没有人叫它来，下次也没到" });
    write(ctx, s.id, lines);
    // If this look never reports, the plan is not left to look at nothing: a short fallback, written down like any next.
    write(ctx, s.id, [{ kind: "next", next: isoLocal(fallbackAt, tz), waitingFor: s.next?.waitingFor ?? "", why: "没交回时的兜底", earlyIf: [], verdict: "pass", source: "fallback", detail: "" }]);
    await syncPlan(ctx, s.id);
  }
  const fresh = state(ctx, s.id);
  const facts = buildFacts(fresh, now, ctx.policy);
  const why = reasons.map((x) => {
    if (x === "time") return "时间到了";
    const [kind, ref2] = x.split(/:(.+)/);
    if (kind === "said") return `他说了：「${fresh.said.find((m) => String(m.seq) === ref2)?.text ?? ""}」（said:${ref2}）`;
    if (kind === "answered") return `他答了问题 ${ref2}：「${fresh.answers[ref2] ?? ""}」`;
    if (kind === "watch") {
      const w = fresh.watches[ref2];
      return w ? `你盯着的「${w.label || w.tool}」变了：原来 ${JSON.stringify(w.prev?.value ?? null)}（${w.prev?.summary ?? ""}）→ 现在 ${JSON.stringify(w.value ?? null)}（${w.summary}）（watch:${w.id}）` : x;
    }
    if (kind === "watch-until") return `你要盯到的时间到了（盯 ${ref2}），盯着的读数已经撤了，看一眼最后的情况再定。`;
    return x;
  });
  const dl = facts.deadlines.map((d) => `- ${d.at}（${d.from}，原文「${d.quote}」）${d.past ? ` [已过 ${Math.round((now - Date.parse(d.at)) / DAY)} 天，可能过时]` : ""}`);
  const handbooks = [ctx.policy.handbookPath || path.join(HERE, "..", "..", "handbook.md")];
  const dir = ctx.policy.handbooksDir;
  if (dir) {
    const kind = s.link?.split(":")[0];
    handbooks.push(path.join(dir, "affair.md"), path.join(dir, (kind && ctx.policy.handbookByKind[kind]) || "asked.md"));
  }
  const recent = s.lines.slice(-10).map((l) => `- #${l.seq} ${stamp(l.at, now, tz)} ${l.kind}${l.entry ? `：${l.entry}` : l.text ? `：${l.text}` : l.status ? `：${l.status}` : ""}`);
  const gate = mayLook(ctx.root, s.id, now, ctx.policy);
  const tools = readers.listReaders(ctx.policy);
  const text = [
    `# 事项 ${s.id}：${s.title}`,
    `目标：${s.goal || s.title}`,
    `现在：${s.nowText || "（还没看过）"}　在等：${s.next?.waitingFor || "（还没定）"}${s.next?.remind ? `　上次约好要提醒他：${s.next.remind}` : ""}`,
    "",
    "## 这次为什么来",
    ...why.map((w) => `- ${w}`),
    "",
    "## 截止（只认这里的）",
    ...(dl.length ? dl : ["- （没有）"]),
    "",
    "## 记住的",
    ...(s.facts.length ? s.facts.map((f) => `- ${f}`) : ["- （还没有）"]),
    "",
    "## 没答的问题",
    ...(facts.pendingAsks.length ? facts.pendingAsks.map((a) => `- ${a.id}：${a.text}（别换个说法再问）`) : ["- （没有）"]),
    "",
    "## 最近的经过",
    ...(recent.length ? recent : ["- （还没有）"]),
    "",
    "## facts（检查用的，不要改）",
    JSON.stringify({ ...facts, sources: undefined }, null, 1),
    "",
    "## 你盯着的读数",
    ...(Object.keys(fresh.watches).length ? Object.values(fresh.watches).map((w) => `- ${w.id}（${w.label || w.tool}，每 ${w.every ?? ctx.policy.readers.everyMinutes} 分钟读一次${w.until ? `，盯到 ${localParts(Date.parse(w.until), tz).text}` : ""}）：${w.summary || "还没读到"}${w.failures ? `　[连着 ${w.failures} 次读不到：${w.lastError}]` : ""}`) : ["- （没有）"]),
    "",
    "## 读数工具",
    `现读一次：${ctx.command} read <名字> --args '<json>' --for ${s.id}（加 --for 会登记，它打印的出处 reader:r编号 能当证据；读不到就如实写读不到）`,
    ...(tools.length ? tools.map((t) => `- ${t.name}${t.what ? `：${t.what}` : ""}`) : ["- （没有）"]),
    "",
    `限额：${gate.ok ? "还能看" : gate.text}。`,
    `手册（先读）：${handbooks.filter((f) => existsSync(f)).join("　")}`,
    `交回：${ctx.command} report ${s.id} --file <json>（next 要有 at、waitingFor、why、earlyIf；先放行的时间最早 ${localParts(earliestOf(now, ctx.policy.check), tz).text.slice(11)}）`,
    "",
  ].join("\n");
  return { ok: true, text };
}

/** The third try that does not pass is taken for what can be taken: a field of the wrong shape is left out (and said so), never written as it is. */
function dropBadFields(merged, problems) {
  const dropped = [];
  for (const field of new Set(problems.map((p) => p.field))) {
    if (["status", "entry", "facts", "watches", "ask"].includes(field) && field in merged) {
      delete merged[field];
      dropped.push(field);
    }
  }
  if (typeof merged.entry !== "string" || !merged.entry.trim()) merged.entry = "我看了一眼（交回的内容格式不对，只记下了这一次）";
  return dropped;
}

/** What a look hands back. Rejected: nothing is taken, and only the fields that did not pass are asked for again. */
/** @returns {Promise<Result>} */
export async function report(ctx, ref, data) {
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const { s } = r;
  if (!isOpen(s)) return fail("这件事已经办完或者不盯了，不用再交。");
  if (!s.running) return fail(`没有在看的一次：先跑 ${ctx.command} brief ${s.id}。`);
  const merged = s.rejected ? { ...s.rejected, ...data } : data;
  const now = ctx.now();
  const policy = ctx.policy;
  const facts = buildFacts(s, now, policy);
  const attempt = s.attempt + 1;
  let result = checkReport({ report: merged, state: s, facts, policy, now, attempt });
  // A watch needs a tool that exists; the check itself does not know where tools are.
  const unknown = (Array.isArray(merged.watches) ? merged.watches : []).filter((w) => typeof w?.tool === "string" && !readers.findReader(policy, w.tool));
  if (unknown.length && result.verdict !== "rejected" && result.verdict !== "fallback") {
    result = { verdict: "rejected", problems: [{ field: "watches", text: `watches 里的「${unknown.map((w) => w.tool).join("、")}」没有这个读取工具；有的：${readers.listReaders(policy).map((t) => t.name).join("、") || "（没有）"}` }] };
  } else if (unknown.length && result.verdict === "fallback") {
    merged.watches = merged.watches.filter((w) => !unknown.includes(w));
  }
  if (result.verdict === "rejected") {
    write(ctx, s.id, [{ kind: "report", verdict: "rejected", attempt, data: merged, problems: result.problems }]);
    const left = policy.check.maxAttempts - attempt;
    return { ok: false, text: [`有 ${result.problems.length} 处要改（还能交 ${left} 次）：`, ...result.problems.map((p) => `- ${p.text}`), `只重交这几处：${skeletonOf(result.problems.map((p) => p.field))}`].join("\n") };
  }
  const fell = result.verdict === "fallback";
  const dropped = fell ? dropBadFields(merged, result.problems) : [];
  const changed = merged.status !== s.nowText || JSON.stringify(merged.facts ?? s.facts) !== JSON.stringify(s.facts) || Object.values(s.watches).length > 0 && (merged.watches ?? []).some((w) => JSON.stringify(w.value ?? null) !== JSON.stringify(s.watches[w.id]?.value ?? null));
  const detail = dropped.length ? `${result.detail}${result.detail ? "；" : ""}${dropped.join("、")} 的格式不对，没有记下` : result.detail;
  const entries = [{ kind: "report", verdict: result.verdict, attempt, status: merged.status ?? s.nowText, entry: merged.entry, facts: merged.facts ?? s.facts, changed, detail }];
  if (Array.isArray(merged.watches)) {
    for (const w of merged.watches) {
      const before = s.watches[w.id];
      const until = typeof w.until === "string" ? parseLocal(w.until, policy.tz) ?? Date.parse(w.until) : NaN;
      const every = Number.isFinite(Number(w.every)) && Number(w.every) > 0 ? Math.max(policy.readers.minEveryMinutes, Math.round(Number(w.every))) : null;
      // The look's own reading is the baseline; without one the loop's first reading is.
      const value = w.value !== undefined ? w.value : before?.value ?? null;
      entries.push({
        kind: "watch", id: w.id,
        watch: { tool: w.tool, args: w.args ?? {}, label: String(w.label ?? before?.label ?? "").slice(0, 12), every, value, hash: w.value !== undefined ? readers.hashOf(value) : before?.hash ?? null, summary: w.summary ?? before?.summary ?? "", until: Number.isFinite(until) ? isoLocal(until, policy.tz) : null },
      });
    }
    for (const id of Object.keys(s.watches)) if (!merged.watches.some((w) => w.id === id)) entries.push({ kind: "watch", id, drop: true });
  }
  const finishing = merged.finish && !fell;
  if (finishing) {
    entries.push({ kind: "status", status: merged.finish.kind === "done" ? "done" : "stopped", evidence: merged.finish.summary || merged.finish.evidence.quote, by: "look" });
  } else if (s.lines.some((l) => l.kind === "next" && l.source === "user" && l.seq > (s.lastWake?.seq ?? 0))) {
    // The person chose a time while this look was on: theirs stands, whatever this look would have asked for.
  } else {
    const n = merged.next ?? {};
    const atMs = result.verdict === "ask" ? result.limitMs : result.atMs;
    entries.push({
      kind: "next", next: isoLocal(atMs, policy.tz), waitingFor: fell ? (plainText(n.waitingFor, 12) ? n.waitingFor : s.next?.waitingFor ?? "") : n.waitingFor, waitingOn: n.waitingOn ?? "", why: fell ? "检查三次没过，先按上限定" : n.why,
      earlyIf: fell ? [] : n.earlyIf, remind: n.remind ?? "", verdict: result.verdict, detail: result.detail, deadlineKey: result.deadlineKey, source: "look",
    });
    if (fell) entries.push({ kind: "flag", what: "fallback", detail: result.detail });
  }
  if (merged.ask && !fell) {
    const id = `${s.id}-${s.asks.length + 1}`;
    entries.push({ kind: "asked", id, title: merged.ask.title, line: merged.ask.line ?? "", options: merged.ask.options });
  }
  if (result.verdict === "ask") {
    const id = `${s.id}-${s.asks.length + 1 + (merged.ask ? 1 : 0)}`;
    const when = localParts(parseLocal(merged.next.at, policy.tz), policy.tz);
    const said = s.said.filter((m) => !m.undone && m.by === "user").slice(-1)[0];
    entries.push({
      kind: "asked", id, title: `${s.title}：${when.mo}月${when.d}日再看，可以吗？`, line: said ? `你 ${md(Date.parse(said.at), policy.tz)} 说过「${said.text.slice(0, 30)}」。不点的话，${md(result.limitMs, policy.tz)} 先看一次。` : "不点的话，先按原来的时间看一次。",
      options: ["可以", "两周后看"], proposal: { at: isoLocal(parseLocal(merged.next.at, policy.tz), policy.tz), waitingFor: merged.next.waitingFor, why: merged.next.why },
    });
  }
  write(ctx, s.id, entries);
  writeProgress(ctx, state(ctx, s.id));
  await syncPlan(ctx, s.id);
  const after = state(ctx, s.id);
  const when = after.next && isOpen(after) ? `下次 ${localParts(Date.parse(after.next.at), policy.tz).text.slice(5)} 看` : "";
  const note2 = { recorded: "（比上限晚，理由已记下）", ask: "（比上限晚太多，先按上限，等他点头）", appeal: "（你申诉了，会告诉他）", fallback: "（三次都没过，下次按上限）" }[result.verdict] ?? "";
  return { ok: true, text: finishing ? `收下了，这件事${merged.finish.kind === "done" ? "办完" : "不盯"}了。` : `收下了。${when}${note2}` };
}

/** Reads once with a tool. With `forId` the result is written to that affair's log, and what is printed says how to cite it. */
/** @returns {Promise<Result>} */
export async function readTool(ctx, tool, args = {}, { forId = "" } = {}) {
  let id = "";
  if (forId) {
    const r = resolve(ctx, forId);
    if (!r.s) return fail(r.text);
    id = r.s.id;
  }
  const got = await readers.readOnce(ctx.policy, tool, args);
  if (!got.ok) {
    if (id && !got.missing) write(ctx, id, [{ kind: "read", tool, args, ok: false, reason: got.reason }]);
    return fail(`读不到：${got.reason}`);
  }
  const secret = secretIn(`${JSON.stringify(got.value)} ${got.summary}`);
  if (secret) return fail(`读到的东西${secret}，不记、不打印。`);
  let cite = "";
  if (id) {
    const [line] = write(ctx, id, [{ kind: "read", tool, args, ok: true, value: got.value, summary: got.summary }]);
    cite = `
出处：reader:r${line.seq}`;
  }
  return { ok: true, value: got.value, summary: got.summary, text: `${got.summary}
${JSON.stringify(got.value)}${cite}` };
}

/** @returns {Result} */
export function show(ctx, ref, { log = false } = {}) {
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const s = r.s;
  const now = ctx.now();
  const head = [`${s.id} 「${s.title}」 ${s.status}${s.next && isOpen(s) ? `，下次 ${localParts(Date.parse(s.next.at), ctx.policy.tz).text}（${s.next.waitingFor}）` : ""}`, `现在：${s.nowText}`, ...s.facts.map((f) => `- ${f}`)];
  if (!log) return { ok: true, text: head.join("\n") };
  return { ok: true, text: [...head, "", ...s.lines.map((l) => `#${l.seq} ${stamp(l.at, now, ctx.policy.tz)} ${l.kind} ${JSON.stringify({ ...l, seq: undefined, at: undefined, kind: undefined, data: undefined })}`)].join("\n") };
}

/** @returns {Result} */
export function ls(ctx) {
  const rows = listIds(ctx.root).map((id) => loadState(ctx.root, id)).filter((s) => !s.system);
  return { ok: true, text: rows.map((s) => `${s.id}\t${s.status}\t${s.title}\t${s.next ? s.next.at : ""}`).join("\n") || "（没有事项）" };
}

/**
 * Every plan paused and held that way (rollback, or before a change): the log says "held", so the plugin does not undo it.
 * Plans named affair:* that the logs do not know are paused too. `resumeAll` lets them go on.
 * @returns {Promise<Result>}
 */
export async function pauseAll(ctx) {
  if (byLook(ctx)) return lookRefused("停掉全部事项的计划");
  const done = [];
  const failed = [];
  for (const id of listIds(ctx.root)) {
    const s = state(ctx, id);
    if (s.system) continue;
    write(ctx, id, [{ kind: "hold", on: true }]);
    if (!s.scheduleId) continue;
    try {
      await schedule.pause(ctx.run, s.scheduleId);
      done.push(id);
    } catch (error) {
      failed.push(`${id}（${error.message}）`);
    }
  }
  // Plans the logs have lost track of: found by their names.
  try {
    const all = await json(ctx.run, ["schedule", "ls"]);
    for (const p of Array.isArray(all) ? all : []) {
      if (typeof p?.name === "string" && p.name.startsWith("affair:") && p.status === "active") {
        await schedule.pause(ctx.run, p.id).then(() => done.push(p.name), (error) => failed.push(`${p.name}（${error.message}）`));
      }
    }
  } catch (error) {
    failed.push(`列不出计划：${error.message}`);
  }
  return { ok: failed.length === 0, done, failed, text: `停了 ${done.length} 个${failed.length ? `；没停成：${failed.join("、")}` : ""}。` };
}

/** @returns {Promise<Result>} */
export async function resumeAll(ctx) {
  if (byLook(ctx)) return lookRefused("放开全部事项的计划");
  let n = 0;
  for (const id of listIds(ctx.root)) {
    const s = state(ctx, id);
    if (!s.held) continue;
    write(ctx, id, [{ kind: "hold", on: false }]);
    await syncPlan(ctx, id);
    n += 1;
  }
  return { ok: true, text: `放开了 ${n} 个。` };
}

/**
 * What is wrong with the setup, where a person will see it: one affair of its own ("事项还没配好", not watched, no plan) with
 * the problems on a question card. Said once per start; when nothing is wrong any more it is put away.
 * @returns {Promise<void>}
 */
export async function setupCard(ctx, problems) {
  const id = "D0";
  const text = problems.map((p) => `${p.key}：${p.text}`).join("；");
  const known = existsSync(path.join(ctx.root, id));
  if (problems.length === 0) {
    if (!known) return;
    const s = state(ctx, id);
    if (isOpen(s)) write(ctx, id, [...s.asks.filter((a) => a.state === "open").map((a) => ({ kind: "ask.drop", id: a.id })), { kind: "status", status: "stopped", evidence: "配置补齐了", by: "system" }]);
    return;
  }
  if (!known) {
    mkdirSync(path.join(ctx.root, id), { recursive: true });
    write(ctx, id, [{ kind: "created", id, title: "事项还没配好", goal: "配置有缺项", domain: "work", link: null, workdir: path.join(ctx.root, id), paseoHome: ctx.paseoHome, role: "", system: true }]);
    const projectId = await workspace.ensureProject(ctx.run, ctx.root);
    const workspaceId = await workspace.createWorkspace(ctx.run, { projectId, workdir: path.join(ctx.root, id), title: "事项还没配好" });
    write(ctx, id, [{ kind: "workspace", workspaceId, projectId, title: "事项还没配好" }]);
  }
  let s = state(ctx, id);
  if (!isOpen(s)) write(ctx, id, [{ kind: "status", status: "watching", evidence: "" }]);
  s = state(ctx, id);
  if (s.asks.some((a) => a.state === "open" && a.line === text.slice(0, 400))) return;
  write(ctx, id, [
    { kind: "flag", what: "config", detail: text },
    { kind: "asked", id: `${id}-${s.asks.length + 1}`, for: "config", title: `事项还没配好，有 ${problems.length} 处要补`, line: text.slice(0, 400), options: ["我知道了"] },
  ]);
}

/** How the checks have gone: what the thresholds are tuned from. */
/** @returns {Result} */
export function stats(ctx) {
  const tally = {};
  for (const id of listIds(ctx.root)) {
    for (const l of read(ctx.root, id)) {
      if (l.kind === "report" || l.kind === "next") {
        const key = `${l.kind}.${l.verdict ?? "-"}`;
        tally[key] = (tally[key] ?? 0) + 1;
      }
    }
  }
  return { ok: true, text: Object.entries(tally).sort().map(([k, v]) => `${k}\t${v}`).join("\n") || "（还没有）" };
}

export { verifyEvidence };
