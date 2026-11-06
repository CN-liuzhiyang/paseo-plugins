import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askFields, buildFacts, checkReport, earliestOf, mentionsDay, plainText, secretIn, skeletonOf, verifyEvidence } from "./check.mjs";
import { dayStart, flowLook, mayLook, tripped } from "./limits.mjs";
import { canResume, resumeRefusal, eventsFile, flowsOf, labelOf, endedAfterNow, liveOf, logDirOf, lostLike, marksOf, readGateCarrier, sentenceOf, orchCommand, orchLogDir, outcomeText, parseDuration, perDayOf, prepareInput, readStatus, runEnv, startRun } from "./flows.mjs";
import { append, ID, isOpen, listIds, load as loadState, read } from "./log.mjs";
import { policyProblems } from "./policy.mjs";
import { json, makeRun, whyOf } from "./paseo.mjs";
import * as readers from "./readers.mjs";
import { stepFields, stepLines } from "./steps.mjs";
import * as schedule from "./schedule.mjs";
import { isoLocal, localParts, parseLocal, speak } from "./time.mjs";
import { ago, attachSummary, linkOf, md, say, sentOf, stamp } from "./view.mjs";
import { clampMax, findTurns, handoffSection, normalize, oneTurn, parseLogs, sayHistory } from "./history.mjs";
import { hrefOf, normalizedLink, primaryLink, parseLink, usableTemplates } from "./links.mjs";
import { finishWork, refreshWork, restoreWork, saveWork, sizeWarnings, workTexts } from "./workdir-git.mjs";
import { projectList } from "./project-context.mjs";
import { chatHandbooks } from "./chat.mjs";
import { keep } from "./attach.mjs";
import * as workspace from "./workspace.mjs";
import { loadPolicy, defaultRoot } from "./policy.mjs";
import { modeOf, modeText } from "./mode.mjs";
import { budgetGate, budgetText } from "./drive.mjs";

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
    // A look asked for while Paseo still counts the last as running is tried again this many times, this many ms apart.
    runRetries: options.runRetries ?? 4,
    runRetryMs: options.runRetryMs ?? 1500,
    // Who is calling: "human" (the person's side: a conversation, the plugin) or "look" (a session the schedule started).
    // The command works it out from the session it runs in; there is no way to say it in words or in the environment.
    by: options.by ?? "human",
    // For a chat session: the one affair it is the chat of (it can touch no other).
    chatFor: options.chatFor ?? "",
    agentId: options.agentId ?? "",
    // `flow`: how long to wait for a started run to show itself, and how a process is made (a test puts its own).
    flowWaitMs: options.flowWaitMs ?? 8000,
    flowStart: options.flowStart,
    // What the plugin last saw of each run it follows, by run id: { st, lostAt? }. The sentences on the chat and the panel are drawn from it.
    flowNow: new Map(),
    // A run that reads as lost is believed only if it still does this long after it first did (a machine that slept reads as lost for a moment).
    lostConfirmMs: options.lostConfirmMs ?? 35_000,
    heartbeatMs: options.heartbeatMs ?? 30_000,
    pause: options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** @returns {any} */
const state = (ctx, id) => loadStateWithLines(ctx.root, id, ctx.policy);

function loadStateWithLines(root, id, policy) {
  const lines = read(root, id);
  return { ...loadState(root, id, policy), lines };
}

const write = (ctx, id, entries) => {
  const lines = append(ctx.root, id, entries, { now: ctx.now(), tz: ctx.policy.tz });
  if (entries.some((e) => ["created", "mode", "budget", "asked", "report", "answered", "link", "project", "next", "note"].includes(e.kind))) refreshWork(ctx, loadState(ctx.root, id, ctx.policy));
  return lines;
};
/** @returns {Result} */
const fail = (text) => ({ ok: false, text });

const refuseSecret = (text) => (secretIn(text) ? fail(`这句话里有${secretIn(text)}的东西，没记下。要记就说「有个令牌」，别贴原文。`) : null);

export function paseoUrl(ctx, s) {
  const home = ctx.paseoHome || path.join(process.env.USERPROFILE || process.env.HOME || "", ".paseo");
  const file = path.join(home, "server-id");
  const talk = s.chatId || s.conversationId;
  if (!talk || !existsSync(file)) return "";
  const server = readFileSync(file, "utf8").trim();
  // https, not paseo://: POPO renders it as a link and the web app opens the affair's own workspace (checked by hand 2026-11-03).
  return s.workspaceId ? `https://app.paseo.sh/h/${server}/workspace/${s.workspaceId}` : `https://app.paseo.sh/h/${server}/agent/${talk}`;
}

const linkTextOf = (ctx, s) => linkOf(paseoUrl(ctx, s), ctx.policy);

export function writeProgress(ctx, s) {
  const dir = path.join(ctx.root, s.id);
  mkdirSync(dir, { recursive: true });
  const sent = sentOf(s);
  const lines = [`# ${s.title}`, `目标：${s.goal}`, `现在：${s.nowText}`, s.next ? `下次：${s.next.at}（${s.next.waitingFor}）` : "", "", "记住的：", ...s.facts.map((f) => `- ${f}`)];
  if (sent.length) lines.push("", "他发来的（在 files/ 里）：", ...sent.map((a) => `- ${a.at.slice(0, 16).replace("T", " ")} ${a.name}　${a.path}`));
  writeFileSync(path.join(dir, "progress.md"), `${lines.join("\n")}\n`);
}

/**
 * Who the process calling is: "look" for a session the schedule started (Paseo labels it), "human" for any other session
 * or a plain terminal. A session that has an agent id but whose kind cannot be read counts as a look: when in doubt it is
 * the stricter side. (A look that cleared its own environment would look like a terminal; that cannot be told apart.)
 */
export async function callerInfo(ctx) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) return { by: "human", chatFor: "", agentId: "" };
  // `paseo agent inspect` does not print labels, but `paseo ls --label key=value` filters by them: ask whether this session is among
  // the ones carrying a given label. An exact value is needed, so the candidates are the plans and affairs this root knows.
  const has = async (pair) => {
    const r = await ctx.run(["ls", "-a", "--label", pair, "-q"]);
    if (r.exitCode !== 0) throw new Error(r.stderr || "ls failed");
    return r.stdout.split(/\s+/).some((short) => short && agentId.startsWith(short));
  };
  try {
    const ids = listIds(ctx.root);
    const plans = [...new Set(ids.map((id) => loadState(ctx.root, id).scheduleId).filter(Boolean))];
    const looks = await Promise.all(plans.map((p) => has(`paseo.schedule-id=${p}`)));
    if (looks.some(Boolean)) return { by: "look", chatFor: "" };
    // Adopted chats were created without our labels; their binding is in the same log as the chats we made.
    const bound = ids.find((id) => loadState(ctx.root, id).chats.some((chat) => chat.agentId === agentId));
    if (bound) return { by: "chat", chatFor: bound };
    // The chat session of an affair is labelled by the plugin that made it; the label also says which affair it is the chat of.
    const first = process.env.AFFAIR_ID && ids.includes(process.env.AFFAIR_ID) ? [process.env.AFFAIR_ID] : [];
    const rest = ids.filter((id) => !first.includes(id)).slice(-60);
    for (const group of [first, rest]) {
      const hits = await Promise.all(group.map((id) => has(`affairs.chat=${id}`)));
      const at = hits.findIndex(Boolean);
      if (at >= 0) return { by: "chat", chatFor: group[at] };
    }
    const attached = ids.some((id) => loadState(ctx.root, id).attached.includes(agentId));
    return { by: attached ? "attached" : "human", chatFor: "", agentId };
  } catch {
    return { by: "look", chatFor: "" };
  }
}
export const callerOf = async (ctx) => (await callerInfo(ctx)).by;

const byLook = (ctx) => ctx.by === "look" || ctx.by === "attached";
const byChat = (ctx) => ctx.by === "chat";
export function hisSaid(s, saidSeq) {
  return s.said.find((m) => m.seq === Number(saidSeq) && !m.undone && m.by === "user" && m.via !== "chat-agent");
}

export async function mode(ctx, ref, value, { saidSeq = "" } = {}) {
  if (byLook(ctx)) return lookRefused("切换推进方式");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  if (!["watch", "drive"].includes(value)) return fail("用法：affair mode <编号> watch|drive --said-seq N");
  const from = hisSaid(r.s, saidSeq || currentSaid(r.s)?.seq);
  if (!from) return fail("要用 --said-seq 指向他说过的原话，不能替他切换。");
  write(ctx, r.s.id, [{ kind: "mode", mode: value, said: from.seq }]);
  if (value === "watch" && !r.s.scheduleId) {
    const scheduleId = await schedule.create(ctx.run, { id: r.s.id, policy: ctx.policy, workspaceId: r.s.workspaceId, atMs: ctx.now() + ctx.policy.fallbackMinutes * 60_000, command: ctx.command, role: r.s.roleName || undefined });
    write(ctx, r.s.id, [{ kind: "schedule", scheduleId }]);
  }
  await syncPlan(ctx, r.s.id);
  return { ok: true, text: `已改成${value === "drive" ? "我来推" : "我盯着"}。` };
}

export async function budget(ctx, ref, amount, { saidSeq = "", until = "" } = {}) {
  if (byLook(ctx)) return lookRefused("设额度");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const usd = Number(amount);
  if (!Number.isFinite(usd) || usd < 0 || String(amount).trim() === "") return fail("额度要是零或正数的美元。");
  const from = hisSaid(r.s, saidSeq || currentSaid(r.s)?.seq);
  if (!from) return fail("要用 --said-seq 指向他说过的原话，不能替他批额度。");
  if (!(from.text.match(/\d+(?:\.\d+)?/g) ?? []).some((n) => Number(n) === usd)) return fail(`他那句话里没有 ${usd} 这个数字，不能设这个额度。`);
  if (until && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || parseLocal(`${until} 23:59`, ctx.policy.tz) === null || !mentionsDay(from.text, parseLocal(`${until} 23:59`, ctx.policy.tz), ctx.now(), ctx.policy.tz))) return fail("截止日要写成 YYYY-MM-DD，并且在他的话里说到这个日期。");
  write(ctx, r.s.id, [{ kind: "budget", usd, until, said: from.seq }]);
  return { ok: true, text: `已记下他批的 $${usd}${until ? `，到 ${until}` : ""}。` };
}

const AMOUNT = /\$(\d+(?:\.\d+)?)/;

export async function ask(ctx, ref, data) {
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const s = r.s;
  const caller = await callerInfo(ctx);
  const agentId = process.env.PASEO_AGENT_ID || "";
  const main = caller.by === "chat" && caller.chatFor === s.id && agentId === s.chatId;
  if (caller.by === "look" || (!main && !s.attached.includes(agentId))) return fail("只有这件事的主对话或接手过的对话能开问题卡。");
  if (!isOpen(s)) return fail("这件事已经办完，不能再开问题卡。");
  if (!data || typeof data.title !== "string" || !data.title.trim() || typeof data.line !== "string" || !Array.isArray(data.options) || data.options.length < 2 || data.options.some((o) => typeof o !== "string" || !o.trim()) || !data.options.includes(data.recommend) || typeof data.why !== "string" || !data.why.trim()) return fail("问题要有 title、line、至少两个 options、其中一项 recommend 和理由 why。");
  const secret = refuseSecret(JSON.stringify(data));
  if (secret) return secret;
  // A budget card is granted by his click on an option carrying the amount, as surely as by his typed words.
  if (data.budget === true && !data.options.some((o) => AMOUNT.test(o))) return fail("额度卡至少要有一个写明金额的选项，例如「批准，额度 $3」。");
  const qid = `${s.id}-${s.asks.length + 1}`;
  write(ctx, s.id, [{ kind: "asked", id: qid, ...askFields(data), ...(data.budget === true ? { for: "budget:ask" } : {}), line: `${data.line}\n推荐：${data.recommend}。${data.why}`, recommend: data.recommend, why: data.why, push: data.push === true }]);
  return { ok: true, id: qid, text: "已请他拍板；先做不依赖答案的步骤。" };
}

export function currentSaid(s) {
  const turn = s.lines?.filter((l) => l.kind === "chat.turn" && l.agentId === s.chatId).at(-1);
  return s.said.filter((m) => !m.undone && m.by === "user" && m.via === "chat-session" &&
    (turn ? m.seq > turn.seq : !s.chatTurn || Date.parse(m.at) > Date.parse(s.chatTurn.at))).at(-1);
}

export async function link(ctx, ref, action, value) {
  if (byLook(ctx)) return lookRefused("改关联");
  if (byChat(ctx)) return chatRefused("改关联");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const link = normalizedLink(value);
  if (!link || link.startsWith("svn:") || !["add", "rm"].includes(action)) return fail("用法：affair link <编号> add|rm <kind:ref>，关联只挂管事的系统。");
  const duplicate = action === "add" && listIds(ctx.root).map((id) => loadState(ctx.root, id)).find((s) => s.id !== r.s.id && isOpen(s) && s.links.includes(link));
  if (duplicate) return fail(`关联已经挂在 ${duplicate.id}「${duplicate.title}」。`);
  const links = action === "rm" ? r.s.links.filter((l) => l !== link) : [...new Set([...r.s.links, link])];
  const role = r.s.roleExplicit === false ? ctx.policy.roleByKind?.[primaryLink({ links })?.split(":")[0]] || "" : r.s.roleName;
  if (role !== r.s.roleName && r.s.scheduleId) await schedule.changeRole(ctx.run, r.s.scheduleId, ctx.policy, role || undefined);
  write(ctx, r.s.id, [{ kind: "link", action, link, role }]);
  return { ok: true, text: "关联已更新。" };
}

export async function project(ctx, ref, action, key) {
  if (byLook(ctx)) return lookRefused("改项目");
  if (byChat(ctx)) return chatRefused("改项目");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  if (!["add", "rm"].includes(action) || !/^(remote|svn|path):.+/.test(key ?? "")) return fail("用法：affair project <编号> add|rm <key>");
  write(ctx, r.s.id, [{ kind: "project", action, project: key }]);
  return { ok: true, text: "项目已更新。" };
}

export async function save(ctx, ref, message = "") {
  if (byLook(ctx)) return lookRefused("保存事项文档");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  if (!isOpen(r.s)) return fail("这件事已经办完，要继续写先 resume。");
  refreshWork(ctx, r.s);
  const result = await saveWork(ctx, r.s.id, message);
  const warnings = sizeWarnings(ctx, r.s, chatHandbooks(ctx, r.s));
  return { ...result, text: [result.text.split("\n")[0], ...warnings].join("\n") };
}

export async function here(ctx, cwd = process.cwd()) {
  return { ok: true, text: await projectList(ctx.policy, cwd, Infinity) || "本项目没有在进行的事。" };
}

export async function attach(ctx, ref) {
  if (ctx.by === "look") return lookRefused("接手事项");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const caller = await callerInfo(ctx);
  const agentId = caller.agentId || (caller.by === "chat" ? process.env.PASEO_AGENT_ID : "");
  if (caller.by === "look") return lookRefused("接手事项");
  if (!agentId) return fail("要在 Paseo 的对话里 attach，才能把结论记到这件事上。");
  write(ctx, r.s.id, [{ kind: "attached", agentId }]);
  const texts = workTexts(ctx, r.s);
  return { ok: true, text: `${texts.status}\n${texts.readme}` };
}
/** Only what is really in this affair's files/ is handed to a look, whatever a line of the log says. */
const sentIn = (ctx, id) => {
  const dir = path.resolve(ctx.root, id, "files");
  return (list) => list.filter((a) => path.dirname(path.resolve(a.path)) === dir && existsSync(a.path));
};
/** @returns {Result} */
const lookRefused = (what) => fail(`这是看一眼的会话，不能${what}，只有他本人在对话里说了算。看到了什么用 report 交回，想记下自己的观察用 note。`);

/** @returns {Result} */
const chatRefused = (what) => fail(`这是对话的会话，不能${what}。`);

/** @returns {{ hits: any[], names: string[] }} */
export function find(ctx, word, { closed = false } = {}) {
  const open = listIds(ctx.root).map((id) => loadState(ctx.root, id)).filter((s) => !s.system && (closed || isOpen(s)));
  const w = word.trim().toLowerCase().replace(/^#/, "");
  const hits = open.filter((s) => s.id.toLowerCase() === w || s.links.some((l) => l.toLowerCase() === w) || s.title.toLowerCase().includes(w) || (w && s.title.toLowerCase().replace(/^#/, "").includes(w)));
  return { hits, names: open.map((s) => s.title) };
}

/** An id or a name to the one affair meant, or the sentence that asks which. */
/** @returns {{ s?: any, text?: string }} */
export function resolve(ctx, ref, { closed = false } = {}) {
  const got = resolveAny(ctx, ref, { closed });
  // A chat session is the chat of one affair, and of no other.
  if (got.s && byChat(ctx) && ctx.chatFor && got.s.id !== ctx.chatFor) return { text: `这个对话只管 ${ctx.chatFor} 这一件事，别的事项碰不了。` };
  return got;
}

/** @returns {{ s?: any, text?: string }} */
function resolveAny(ctx, ref, { closed = false } = {}) {
  if (ID.test(ref) && existsSync(path.join(ctx.root, ref))) return { s: state(ctx, ref) };
  let { hits, names } = find(ctx, ref);
  if (hits.length === 0 && closed) hits = find(ctx, ref, { closed: true }).hits;
  if (hits.length === 1) return { s: state(ctx, hits[0].id) };
  return { text: hits.length > 1 ? say.which(hits.map((h) => h.title)) : say.notFound(ref, names) };
}

/** @returns {Promise<Result>} */
async function ringNow(ctx, s, why, { force = false } = {}) {
  force ||= why.startsWith("flow:") || flowLook(s.pending);
  if (!isOpen(s) || s.system) return { ok: false, text: "" };
  if (modeOf(s, ctx.policy) === "drive") return { ok: false, text: "这件事由主对话接着推，不排看一眼。" };
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
  // A look asked for as the last one ends can meet Paseo still counting the last one as running (its delivery comes first):
  // tried again a few times, a second apart, before it is taken for a look that is really on.
  for (let attempt = 0; ; attempt++) {
    try {
      await schedule.runOnce(ctx.run, s.scheduleId);
      return { ok: true, queued: false, text: "" };
    } catch (error) {
      if (/already running/i.test(error.message) && attempt < ctx.runRetries) {
        await new Promise((resolve) => setTimeout(resolve, ctx.runRetryMs));
        continue;
      }
      write(ctx, s.id, [{ kind: "cleared", void: true }]);
      // Still running after that: the reason stays in the log for the look that is on.
      if (/already running/i.test(error.message)) {
        write(ctx, s.id, [{ kind: "ring", why }, { kind: "flag", what: "look", detail: `${error.message}（试了 ${attempt + 1} 次，留给正在看的那次）` }]);
        // `busy`: Paseo still counted the last look as running; the plugin asks again a little later.
        return { ok: true, queued: true, busy: true, text: "" };
      }
      write(ctx, s.id, [{ kind: "flag", what: "look", detail: error.message }]);
      return { ok: false, text: "" };
    }
  }
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

/** @returns {Promise<Result>} */
export async function create(ctx, input) {
  if (byLook(ctx)) return lookRefused("新建事项");
  if (byChat(ctx)) return chatRefused("新建事项");
  const { title, goal = "", said = "", domain = "work", deadline = null, deadlineQuote = "", noWait = false } = input;
  const links = [...new Set((Array.isArray(input.link) ? input.link : input.link ? [input.link] : []).map(normalizedLink))];
  if (links.some((l) => !l || l.startsWith("svn:"))) return fail("关联要写成管事的系统的 kind:ref。");
  const link = links[0] ?? null;
  const secret = refuseSecret(`${title} ${goal} ${said}`);
  if (secret) return secret;
  const policy = ctx.policy;
  const now = ctx.now();
  const kind = link?.split(":")[0];
  // Only a plain number after the kind names a ticket ("gcp:#700", "gcp:700/字段"); other digits in a link are not its number.
  const ref = links.map((l) => /^(\d{3,9})$/.exec(parseLink(l)?.ref ?? "")?.[1]).find(Boolean) ?? "";
  const role = input.role ?? (kind && policy.roleByKind?.[kind]) ?? undefined;
  const open = listIds(ctx.root).map((x) => loadState(ctx.root, x)).filter((s) => isOpen(s) && !s.system);
  if (input.id !== undefined && !/^[a-z][a-z0-9-]{1,39}$/.test(input.id)) return fail("--id 要用 2–40 个小写字母、数字或连字符，字母开头。");
  let id = ref || input.id;
  if (!id) return fail("没有单号，请用 --id 给这件事起一个短名（小写字母、数字、连字符）。");
  const duplicate = open.find((s) => s.id !== id && links.some((l) => s.links.includes(l)));
  if (duplicate) return fail(`关联已经挂在 ${duplicate.id}「${duplicate.title}」，请用这件事。`);
  const existing = open.find((s) => s.id === id);
  if (existing) return { ok: true, text: modeOf(existing, policy) === "drive" ? `「${existing.title}」已经由我来推。${linkTextOf(ctx, existing)}` : say.already(existing.title, existing.next ? speak(Date.parse(existing.next.at), now, policy.tz) : "稍后", linkTextOf(ctx, existing)), id };
  if (!title?.trim()) return fail("要有一个名字：--title");
  // A ticket that was watched before and is over (or never got made): the person asked again, so it is watched again.
  const before = listIds(ctx.root).map((key) => loadState(ctx.root, key)).find((s) => !isOpen(s) && links.some((link) => s.links.includes(link))) ?? (existsSync(path.join(ctx.root, id)) ? loadState(ctx.root, id) : null);
  if (before?.id && !isOpen(before)) {
    id = before.id;
    if (open.length >= policy.limits.maxActive) return fail(say.tooMany(open.length));
    if (said) write(ctx, id, [{ kind: "said", text: said, via: input.via ?? "chat", by: "user" }]);
    const again = await resume(ctx, id);
    return { ...again, id, text: again.ok ? say.restarted(before.title, before.status) : again.text };
  }
  if (open.length >= policy.limits.maxActive) return fail(say.tooMany(open.length));
  const projects = input.projects ?? policy.projectsByKind?.[kind] ?? [];
  let workdir;
  try { workdir = await workspace.workdirOf(ctx.root, id, projects, policy); }
  catch (error) { return fail(error.message); }
  const dir = path.join(ctx.root, id);
  mkdirSync(path.join(dir, "files"), { recursive: true });
  write(ctx, id, [{ kind: "created", id, title: title.trim(), goal, domain, links, projects, workdir, paseoHome: ctx.paseoHome, role: role ?? "", roleExplicit: input.role != null }]);
  let s = state(ctx, id);
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
    write(ctx, id, [{ kind: "mode", mode: modeOf(s, policy), source: "default" }]);
    const projectId = await workspace.ensureProject(ctx.run, ctx.root);
    const workspaceId = await workspace.createWorkspace(ctx.run, { projectId, workdir, title: title.trim() });
    write(ctx, id, [{ kind: "workspace", workspaceId, projectId, title: title.trim() }]);
    // Until the first look reports, the plan is a day away so a look that never comes back is still looked for.
    if (modeOf(s, policy) === "watch") {
      const scheduleId = await schedule.create(ctx.run, { id, policy, workspaceId, atMs: now + policy.fallbackMinutes * 60_000, command: ctx.command, role });
      write(ctx, id, [{ kind: "schedule", scheduleId }]);
    }
    s = state(ctx, id);
    if (modeOf(s, policy) === "watch") {
      const look = await ringNow(ctx, s, "created");
      if (!look.ok && look.text) write(ctx, id, [{ kind: "flag", what: "first-look", detail: look.text }]);
    } else write(ctx, id, [{ kind: "drive.ready", reason: "created" }]);
  } catch (error) {
    await rollbackCreate(ctx, id, error);
    return fail(`没建成「${title}」：${error.message}。什么都没留下，再说一次就行。`);
  }
  if (!noWait) await waitForConversation(ctx, id);
  s = state(ctx, id);
  return { ok: true, id, text: modeOf(s, policy) === "drive" ? `好，我来推「${s.title}」。先写步骤和估算，请他批额度。${linkTextOf(ctx, s)}` : say.started(s.title, linkTextOf(ctx, s)) };
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
  await finishWork(ctx, state(ctx, id));
}

async function waitForConversation(ctx, id) {
  const until = Date.now() + ctx.waitMs;
  while (Date.now() < until && !(state(ctx, id).chatId || state(ctx, id).conversationId)) await new Promise((r) => setTimeout(r, 100));
}

/**
 * A thing the person said: recorded as theirs only when it was not a look's session that said it.
 * `input.attachments` (the person's side only, never the command) are pictures and files he sent: each is kept in this
 * affair's own files/ and the line carries where. A line may be only that.
 */
const NOTE_MAX = 120;
/** The same words from the same chat within this long of each other are one message heard twice. */
const HEAR_WINDOW_MS = 5000;

/** The notes the chat wrote since the "now" was last written; null when there are none or the "now" was never written. */
function notesSinceNow(s, now) {
  if (!s.nowAt || !s.nowText) return null;
  const n = s.notes.filter((x) => x.seq > s.nowSeq).length;
  return n ? { n, when: ago(s.nowAt, now), text: s.nowText } : null;
}

/**
 * What the chat session writes down for itself as it goes (a conclusion, something he decided): one sentence in its own
 * words, never taken for his. `input.saidSeq` may point at the line of his that it comes from; it has to be a real one.
 * It does not call for a look, and it is no source for a time (the check knows only his own lines).
 * @returns {Result}
 */
function noteMine(ctx, ref, input) {
  const text = String(input.said ?? "").trim();
  if (!text) return fail("没有话可记：--said 后面要有内容。");
  if ([...text].length > NOTE_MAX) return fail(`一句话记不下：最多 ${NOTE_MAX} 个字，现在 ${[...text].length} 个。挑要紧的写。`);
  const secret = refuseSecret(text);
  if (secret) return secret;
  if (!plainText(text, NOTE_MAX)) return fail("这句话里有内部用词（叫醒、校验、读数、会话、agent），换成人话。");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const { s } = r;
  if (!isOpen(s)) return fail(`「${s.title}」已经${s.status === "done" ? "办完" : "不盯"}了，没有什么要记的。`);
  let said = null;
  if (input.saidSeq !== undefined && input.saidSeq !== "") {
    said = Number(input.saidSeq);
    const from = s.said.find((m) => m.seq === said && !m.undone && m.by === "user");
    if (!from) return fail(`--said-seq ${input.saidSeq} 不是他说的话：要指向记录里他说过的一行（brief 的经过里有编号）。`);
  }
  const [line] = write(ctx, s.id, [{ kind: "note", by: "chat", text, ...(said !== null ? { said } : {}) }]);
  const after = state(ctx, s.id);
  writeProgress(ctx, after);
  // A note never changes the "now"; say so when the "now" has fallen behind what was noted after it.
  const stale = notesSinceNow(after, ctx.now());
  return { ok: true, text: stale ? `记下了。
注意：现在的情况还停在 ${stale.when}「${stale.text}」，这条之后如果有进展，请用 report 交回。` : "记下了。", seq: line.seq };
}

/**
 * What he said in the chat, put in the log by the plugin from the chat's own timeline: his words as he wrote them,
 * nothing a session had a hand in. It is no call for a look (the chat is already answering). The plugin's side only.
 * @returns {Promise<Result>}
 */
export async function hear(ctx, ref, text, { messageId = "", at = "", fromAgent = false } = {}) {
  if (ctx.by !== "human") return fail("他在对话里说的话只有插件从对话里记，会话不能代记。");
  const said = String(text ?? "");
  if (!said.trim()) return fail("没有话可记。");
  const secret = refuseSecret(said);
  if (secret) return secret;
  const r = resolve(ctx, ref, { closed: true });
  if (!r.s) return fail(r.text);
  // The same message heard twice (the plugin was restarted and read the chat's end again) is one line. A message's number
  // changes when Paseo rebuilds the timeline after a restart; what stays is the words and the time it was sent.
  const sent = Date.parse(at);
  const heard = r.s.lines.some((l) => l.kind === "said" && l.text === said && (l.msg === messageId && messageId !== "" || (Number.isFinite(sent) && Number.isFinite(Date.parse(l.ts)) && Math.abs(Date.parse(l.ts) - sent) <= HEAR_WINDOW_MS)));
  if (heard) return { ok: true, text: "", seen: true };
  // A message another session sent into the chat (not typed by him) is put down as what it is: not his word.
  const [line] = write(ctx, r.s.id, [{ kind: "said", text: said, via: fromAgent ? "chat-agent" : "chat-session", by: fromAgent ? "look" : "user", ...(messageId ? { msg: messageId } : {}), ...(Number.isFinite(sent) ? { ts: new Date(sent).toISOString() } : {}) }]);
  return { ok: true, text: "", seq: line.seq };
}

/** @returns {Promise<Result>} */
export async function note(ctx, ref, input) {
  if (ctx.by === "attached" && !input.mine) return lookRefused("替他说话（接手后只能 note --mine 记结论）");
  if (byChat(ctx)) {
    if (!input.mine) return chatRefused("以他的名义记话（他在对话里说的话已经记了）；记自己的结论用 note --mine");
    return noteMine(ctx, ref, input);
  }
  if (input.mine) {
    const r = resolve(ctx, ref);
    if (ctx.by !== "look" && r.s?.attached.includes(ctx.agentId)) return noteMine(ctx, ref, input);
    return fail("--mine 只有对话的会话或已经 attach 的会话用。");
  }
  const text = String(input.said ?? "");
  const sending = Array.isArray(input.attachments) ? input.attachments : [];
  if (!text.trim() && sending.length === 0) return fail("没有话可记：--said 后面要有内容。");
  const isLook = byLook(ctx);
  if (isLook && sending.length) return lookRefused("收他发来的东西");
  const r = resolve(ctx, ref, { closed: !isLook && REOPEN.test(text) });
  if (!r.s) return fail(r.text);
  const { s } = r;
  const secret = refuseSecret(text);
  if (secret) return secret;
  // What a look writes is its own view of things; only the person's side writes what he said.
  const by = isLook ? "look" : "user";
  if (isLook && input.deadline) return fail("看一眼记的话不算他说的，不能带 --deadline；截止要他本人说了才算。");
  if (!isOpen(s) && (by !== "user" || !REOPEN.test(text))) return fail(`「${s.title}」已经${s.status === "done" ? "办完" : "不盯"}了。要接着盯就说「接着盯${s.title}」。`);
  // Kept before it is written down, so the line never names a file that is not there.
  const results = sending.map((item) => keep({ root: ctx.root, id: s.id, tz: ctx.policy.tz, now: ctx.now(), item }));
  const kept = results.filter((x) => x.ok).map(({ name, path: file, mime, size }) => ({ name, path: file, mime, size }));
  const refused = results.filter((x) => !x.ok).map((x) => x.text).join("\n");
  if (!text.trim() && kept.length === 0) return fail(refused);
  const said = text.trim() ? text : attachSummary(kept);
  const line = { kind: "said", text: said, via: input.via ?? "chat", by, ...(kept.length ? { attachments: kept } : {}) };
  const reply = (r2) => ({ ...r2, ...(refused ? { text: `${r2.text}\n${refused}`.trim(), refused } : {}) });
  if (!isOpen(s)) {
    write(ctx, s.id, [line]);
    if (kept.length) writeProgress(ctx, state(ctx, s.id));
    return reply(await resume(ctx, s.id));
  }
  const [saved] = write(ctx, s.id, [line]);
  if (kept.length) writeProgress(ctx, state(ctx, s.id));
  if (input.deadline) {
    const at = parseLocal(input.deadline, ctx.policy.tz);
    if (at === null) return fail("--deadline 要写成 YYYY-MM-DD HH:mm");
    write(ctx, s.id, [{ kind: "deadline", deadline: isoLocal(at, ctx.policy.tz), from: `said:${saved.seq}`, quote: said }]);
  }
  if (by !== "user") return { ok: true, text: `记下了（这是你的观察，不算他说的）。`, seq: saved.seq };
  const look = await ringNow(ctx, s, `said:${saved.seq}`, { force: /再看一次/.test(text) });
  const noted = say.noted(s.title, said, linkTextOf(ctx, s));
  return reply({ ok: true, text: look.text ? `${noted}\n${look.text}` : noted, seq: saved.seq });
}

/** @returns {Promise<Result>} */
export async function answer(ctx, ref, qid, text, via = "chat", { saidSeq = /** @type {string | number} */ ("") } = {}) {
  if (byLook(ctx)) return lookRefused("替他回答问题");
  // The chat session never gives the answer in words of its own: what answers a question is the person's own press of a
  // button (the plugin does that) or a line of his that the plugin recorded after the question came (--said-seq).
  if (byChat(ctx)) {
    if (String(text ?? "").trim()) return fail("对话里别用 --said 带他的答案：他点的按钮由插件记，他说的话已经记了，用 --said-seq 指给他说的那一行。");
  } else if (saidSeq !== "") return fail("--said-seq 只有对话的会话用；本人用 --said。");
  if (!byChat(ctx) && !String(text ?? "").trim()) return fail("没有答案可记：--said 后面要有内容。");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const { s } = r;
  const q = s.asks.find((a) => a.id === qid);
  if (byChat(ctx) && saidSeq === "") saidSeq = currentSaid(s)?.seq ?? "";
  if (!byChat(ctx)) {
    const secret = refuseSecret(text);
    if (secret) return secret;
  }
  if (!q) return fail(`没有这个问题：${qid}`);
  if (q.state !== "open") return { ok: true, text: say.answeredAlready(q.answer || "收起了") };
  if (byChat(ctx)) {
    // His own line, said after the question came and not taken back: that line is the answer, word for word.
    const from = s.said.find((m) => m.seq === Number(saidSeq) && !m.undone && m.by === "user" && m.via !== "chat-agent" && m.seq > q.seq);
    if (!from) return fail(`--said-seq ${saidSeq} 不是他在问题出现以后说的话：要指向记录里他说过的一行（brief 的经过里有编号），不能是你自己记的，也不能是问题之前的。`);
    text = from.text;
  }
  write(ctx, s.id, [{ kind: "answered", id: qid, answer: text, via }]);
  if (q.for.startsWith("budget:") && q.options.includes(text.trim())) {
    const amount = AMOUNT.exec(text);
    if (amount) write(ctx, s.id, [{ kind: "budget", usd: Number(amount[1]), until: s.budget?.until || "", answer: qid }]);
    if (text.trim() === "先停") write(ctx, s.id, [{ kind: "hold", on: true }]);
  }
  if (modeOf(s, ctx.policy) === "drive") write(ctx, s.id, [{ kind: "drive.ready", reason: "answered", question: qid }]);
  if (q.runs?.[text.trim()]) return flow(ctx, s.id, q.runs[text.trim()], { saidSeq: byChat(ctx) ? saidSeq : "" });
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
  if (modeOf(s, ctx.policy) === "drive") return { ok: true, text: "收到，接着推。" };
  const look = await ringNow(ctx, s, `answered:${qid}`);
  return { ok: true, text: look.text || `收到。` };
}

/** @returns {Promise<Result>} */
export async function stop(ctx, id, { evidence = "", done = false } = {}) {
  if (byLook(ctx)) return lookRefused("替他说不用盯了");
  const s = state(ctx, id);
  write(ctx, id, [{ kind: "status", status: done ? "done" : "stopped", evidence, by: byChat(ctx) ? "chat" : "user" }]);
  await finishWork(ctx, state(ctx, id));
  await syncPlan(ctx, id);
  return { ok: true, text: say.stopped(s.title) };
}

/** @returns {Promise<Result>} */
export async function resume(ctx, ref) {
  if (byLook(ctx)) return lookRefused("让办完的事接着盯");
  const r = resolve(ctx, ref, { closed: true });
  if (!r.s) return fail(r.text);
  const { s } = r;
  const duplicate = listIds(ctx.root).map((id) => loadState(ctx.root, id)).find((other) => other.id !== s.id && isOpen(other) && s.links.some((link) => other.links.includes(link)));
  if (duplicate) return fail(`关联已经挂在 ${duplicate.id}「${duplicate.title}」。`);
  write(ctx, s.id, [{ kind: "status", status: "watching", evidence: "" }, ...(s.held ? [{ kind: "hold", on: false }] : [])]);
  await restoreWork(ctx, state(ctx, s.id));
  refreshWork(ctx, state(ctx, s.id));
  // Archived since it ended: the same folder gets a new workspace and plan, and the old ones stay in the archive.
  if (!s.workspaceId) {
    try {
      const projectId = await workspace.ensureProject(ctx.run, ctx.root);
      const workspaceId = await workspace.createWorkspace(ctx.run, { projectId, workdir: s.workdir || path.join(ctx.root, s.id), title: s.title });
      write(ctx, s.id, [{ kind: "workspace", workspaceId, projectId, title: s.title }]);
      if (modeOf(s, ctx.policy) === "watch") {
        const scheduleId = await schedule.create(ctx.run, { id: s.id, policy: ctx.policy, workspaceId, atMs: ctx.now() + ctx.policy.fallbackMinutes * 60_000, command: ctx.command, role: s.roleName || undefined });
        write(ctx, s.id, [{ kind: "schedule", scheduleId }]);
      }
    } catch (error) {
      return fail(`没能接着盯「${s.title}」：${error.message}`);
    }
  }
  await syncPlan(ctx, s.id);
  if (modeOf(s, ctx.policy) === "drive") {
    write(ctx, s.id, [{ kind: "drive.ready", reason: "resume" }]);
    return { ok: true, text: `好，接着推「${s.title}」。` };
  }
  const look = await ringNow(ctx, state(ctx, s.id), "resume");
  return { ok: true, text: look.text ? `${say.resumed(s.title)}\n${look.text}` : say.resumed(s.title) };
}

/**
 * "先放一放": only from the person's side, and the time goes through the same check as a look's. His own words (--said) are
 * what back a time past the usual limit; without them it has to be within it.
 * @returns {Promise<Result>}
 */
export async function pause(ctx, ref, until, said = "", { saidSeq = /** @type {string | number} */ ("") } = {}) {
  if (byLook(ctx)) return lookRefused("改下次看的时间");
  // The chat session cannot put words in his mouth: what backs a far time is a line of his the plugin recorded (--said-seq).
  if (byChat(ctx) && String(said).trim()) return fail("对话里别用 --said 带他的话：他说的话已经记了，用 --said-seq 指给他说的那一行。");
  if (!byChat(ctx) && saidSeq !== "") return fail("--said-seq 只有对话的会话用；本人用 --said。");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  let { s } = r;
  if (byChat(ctx) && saidSeq === "") saidSeq = currentSaid(s)?.seq ?? "";
  const policy = ctx.policy;
  const now = ctx.now();
  const at = parseLocal(until, policy.tz);
  if (at === null || at <= now) return fail("--until 要写成 YYYY-MM-DD HH:mm，在现在之后");
  if (at > now + policy.check.hardDays * DAY) return fail("最远一年；更久的事先不盯，到时候重新交代。");
  const evidence = [];
  if (byChat(ctx) && saidSeq !== "") {
    const n = Number(saidSeq);
    const from = hisSaid(s, n);
    if (!from) return fail(`--said-seq ${saidSeq} 不是他说的话：要指向记录里他说过的一行（brief 的经过里有编号），不能是你自己记的。`);
    // He has to have said the day (or the month, or how long from now): any line of his would hold up any time otherwise.
    if (at > now + policy.check.softDays * DAY && !mentionsDay(from.text, at, now, policy.tz)) return fail(`他那一行（#${from.seq}）里没有说到 ${localParts(at, policy.tz).date} 这个日子。这么远的时间要他说一个日期，或者在 report 里写成提议，让他点按钮。`);
    evidence.push({ quote: from.text, from: `said:${from.seq}` });
  } else if (String(said).trim()) {
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
  write(ctx, s.id, [{ kind: "next", next: isoLocal(at, policy.tz), waitingFor, why: "你说先放一放", earlyIf: [], verdict: backed ? "recorded" : result.verdict, source: byChat(ctx) && evidence.length === 0 ? "chat" : "user", detail: evidence.length ? "他说的，原话在记录里" : "" }]);
  await syncPlan(ctx, s.id);
  return { ok: true, text: say.paused(s.title, speak(at, ctx.now(), ctx.policy.tz)) };
}

/**
 * Whether a run of the affair is going, over (and how) or never started: the runtime's own word for it (`orch.mjs status`, which
 * looks at the run's claim and whether its process is alive). Time passed is no evidence that a run will not go on: when the
 * runtime cannot be asked, the run counts as going, so that nothing is started on top of it by mistake.
 */
export async function flowStateOf(ctx, x, orch, logDir) {
  // An end the runtime reported (done, stopped, failed, timed out) stands; `lost` is only what was made of a stale claim.
  if (x.outcome && x.outcome !== "lost") return { state: "over", outcome: x.outcome };
  const dir = logDirOf(x, logDir);
  const read = async () => {
    const st = await readStatus({ orch, logDir: dir, runId: x.runId, spawnedAt: Date.parse(x.at) });
    return st ? liveOf(st) : { state: "going", outcome: "" };
  };
  const first = await read();
  if (first.state !== "doubt") return first;
  // A stale claim is read twice, a heartbeat apart, before it counts: a machine that slept looks like this for a moment, and a run
  // that comes back must not have another started on top of it. The log's own `lost` was written after such a wait: it is the first reading.
  if (!x.outcome) await ctx.pause(ctx.heartbeatMs);
  const second = await read();
  return second.state === "doubt" ? { state: "over", outcome: "lost" } : second;
}

/**
 * The card provider the runtime asks him through is part of Paseo and comes up a little after the daemon does: until it has
 * (its entry in `provider ls` is `loading`) a run is turned away at the start. Which provider that is, the runtime says
 * (`orch.mjs gate-carrier`: the gate role's provider); when the gate is answered by a model, or the runtime cannot say, there is nothing
 * to wait for. The sentence to say when it is not ready, or "" (ready, or not to be checked: the runtime will say if it is not).
 */
async function gateNotReady(ctx) {
  const orch = orchCommand(ctx.policy, BIN);
  if (!orch || !existsSync(orch)) return "";
  const carrier = await readGateCarrier({ orch });
  if (!carrier || carrier.carrier !== "provider") return "";
  let rows;
  try {
    rows = await json(ctx.run, ["provider", "ls"]);
  } catch {
    return "";
  }
  if (!Array.isArray(rows)) return "";
  const row = rows.find((r) => r.provider === carrier.family);
  if (row && row.status === "available" && row.enabled !== "Disabled") return "";
  if (!row) return "Paseo 里还没有批准卡用的那个来源：要么插件没装、没开，要么刚启动还没出来。先在 Paseo 的插件设置里看一眼；刚启动的话过一两分钟再说一次。";
  if (row.status === "loading") return "Paseo 刚启动，过一两分钟再说一次。";
  return `批准卡用的那个插件现在不能用（${row.enabled === "Disabled" ? "被关了" : row.status}），先在 Paseo 的插件设置里看一下，再起流程。`;
}

/**
 * Looks at the runs of one affair that are not over, writes down what has happened to them since it last looked (a card waiting,
 * a card answered, the end: each once), and when one has ended asks for a look at the affair, once, so that the "现在" is
 * written by someone who read the result. A run the runtime turned away after the start is taken back (`flow.fail`).
 * What it saw of each run stays in `ctx.flowNow` for the chat and the panel to draw. Returns whether the log changed.
 */
export async function flowSync(ctx, id) {
  const first = state(ctx, id);
  if (!first.id) return false;
  const logDir = orchLogDir(ctx.policy);
  const orch = orchCommand(ctx.policy, BIN);
  if (!orch || !existsSync(orch)) return false;
  let changed = false;
  for (const f of first.flows) {
    if (f.failed) continue;
    if (f.outcome) {
      if (!ctx.flowNow.has(f.runId)) {
        const st = await readStatus({ orch, logDir: logDirOf(f, logDir), runId: f.runId, spawnedAt: Date.parse(f.at) });
        if (st) ctx.flowNow.set(f.runId, { st });
      }
      await lookAfterFlow(ctx, id, f);
      continue;
    }
    // Where the run's files are is what its entry says, not what this process works out for itself (the command line and the daemon may differ).
    const seen = await readStatus({ orch, logDir: logDirOf(f, logDir), runId: f.runId, spawnedAt: Date.parse(f.at) });
    if (!seen) continue;
    const now = ctx.now();
    if (seen.state === "refused" || (seen.state === "absent" && now - Date.parse(f.at) > 5 * 60_000)) {
      write(ctx, id, [{ kind: "flow.fail", runId: f.runId, why: f.resumeOf && seen.refused ? resumeRefusal(seen.refused) : seen.refused || "没起来" }]);
      ctx.flowNow.delete(f.runId);
      changed = true;
      continue;
    }
    const gone = lostLike(seen);
    const before = ctx.flowNow.get(f.runId);
    const entry = { st: gone ? { ...seen, state: "lost" } : seen, lostAt: gone ? before?.lostAt ?? now : undefined };
    ctx.flowNow.set(f.runId, entry);
    if (gone && now - entry.lostAt < ctx.lostConfirmMs) continue;
    const have = new Set(f.marks.map((m) => m.key));
    const news = marksOf(entry.st).filter((m) => !have.has(m.key));
    if (news.length === 0) continue;
    write(ctx, id, news.map((m) => ({ kind: "flow.mark", runId: f.runId, ...m })));
    changed = true;
    if (news.some((m) => m.key === "end")) {
      await lookAfterFlow(ctx, id, f);
    }
  }
  return changed;
}

async function lookAfterFlow(ctx, id, f) {
  const s = state(ctx, id);
  if (s.lines.some((l) => l.kind === "flow.look" && l.runId === f.runId)) return;
  if (!s.lines.some((l) => l.kind === "ring" && l.why === `flow:${f.runId}`)) write(ctx, id, [{ kind: "ring", why: `flow:${f.runId}` }]);
  const result = await requestLook(ctx, id, `flow:${f.runId}`);
  write(ctx, id, [{ kind: "flow.look", runId: f.runId, ok: result.ok, queued: result.queued === true }]);
}

const NTH = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/**
 * One request at a time decides whether a run may be started and writes down that it will be (nothing else of any affair can be
 * between the deciding and the writing): the count for the day is across all affairs, and a run just reserved has to be seen by
 * the next request. A lock directory in the root, waited for; one left by a process that died is taken over after two minutes.
 */
async function withFlowLock(root, fn) {
  mkdirSync(root, { recursive: true });
  const lock = path.join(root, ".flow.lock");
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 2 * 60_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        // released between the two calls
      }
      if (Date.now() - started > 90_000) return { fail: "别的流程正在起，等了一分半钟还没轮到。过一会儿再说一次。" };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
}

/**
 * Everything that stands between a request and a run, read from the affair as it is now: it is still on, the request is his
 * (a chat needs the latest thing he said, and one thing he said starts one run), nothing of this affair is going, a run of the
 * same flow needs --again, and the day's count is not used up. Asked before the input is made, and again under the lock after.
 * @returns {Promise<{ fail: string } | { said: number | null, same: any[], lastSame: any, lastOutcome: string }>}
 */
async function flowAllowed(ctx, s, name, { saidSeq, again, orch, logDir }) {
  const blocked = budgetGate(ctx, s);
  if (blocked) return { fail: blocked };
  if (!isOpen(s) || s.system) return { fail: `「${s.title}」已经${s.status === "done" ? "办完" : "不盯"}了，不起流程。` };
  if (!s.workspaceId || !s.workdir) return { fail: `「${s.title}」的工作区或工作目录不在了，先找回来再起。` };
  let said = null;
  if (byChat(ctx)) {
    if (saidSeq === "") saidSeq = currentSaid(s)?.seq ?? "";
    if (saidSeq === "") return { fail: "要指给他说的那一行：--said-seq <编号>（brief 的经过里有）。他没点名要跑就别起，直接问他。" };
    said = Number(saidSeq);
    const his = s.said.filter((m) => !m.undone && m.by === "user" && m.via !== "chat-agent");
    if (!his.find((m) => m.seq === said)) return { fail: `--said-seq ${saidSeq} 不是他说的话：要指向记录里他说过的一行（brief 的经过里有编号），不能是你自己记的。` };
    // The word to go ahead is what he said in this turn of the chat: one from before the turn the chat last finished is old news (he
    // may have changed his mind since), and the chat has to ask again. Something more he adds in the same turn ("quick") changes nothing.
    const asked = s.said.find((m) => m.seq === said);
    const lastTurn = s.lines.filter((l) => l.kind === "chat.turn" && l.agentId === s.chatId).at(-1);
    if ((lastTurn && asked.seq < lastTurn.seq) || (s.chatTurn && Date.parse(s.chatTurn.at) > Date.parse(asked.at))) return { fail: `--said-seq ${saidSeq}是之前那几轮说的，那之后你已经回过他了。要起就请他再明确说一次要跑，再用他新说的那一句的编号。` };
    const used = s.flows.find((x) => !x.failed && x.said === said);
    if (used) return { fail: `他那句话（#${said}）已经起过一次 ${used.flow} 了。要再起一次得他再说一句，不能拿同一句。` };
  } else if (saidSeq !== "") return { fail: "--said-seq 只有对话的会话用；本人直接起就行。" };

  const now = ctx.now();
  const tz = ctx.policy.tz;
  const earlier = s.flows.filter((x) => !x.failed);
  const states = new Map();
  await Promise.all(earlier.map(async (x) => states.set(x.runId, await flowStateOf(ctx, x, orch, logDir))));
  const going = earlier.find((x) => states.get(x.runId).state === "going");
  if (going) return { fail: `已经在跑：${going.flow}（${stamp(going.at, now, tz)} 起）。` };
  const same = earlier.filter((x) => x.flow === name);
  const lastSame = same[same.length - 1];
  const lastOutcome = lastSame ? outcomeText(states.get(lastSame.runId).outcome) || "没起来" : "";
  if (lastSame && !again) return { fail: `这件事 ${stamp(lastSame.at, now, tz)} 跑过一次 ${name}（${lastOutcome}）。要再跑一次，加 --again。` };
  const since = dayStart(now, tz, ctx.policy.limits.dayStartHour);
  const today = listIds(ctx.root).reduce((n, id) => n + state(ctx, id).flows.filter((x) => !x.failed && Date.parse(x.at) >= since).length, 0);
  if (today >= perDayOf(ctx.policy)) return { fail: `今天已经起了 ${today} 次流程，到一天的上限（${perDayOf(ctx.policy)} 次）了。` };
  return { said, same, lastSame, lastOutcome };
}

/**
 * `affair flow <编号> [<流程>]`: starts one of the flows policy allows for this kind of affair, in the affair's own workspace, so
 * that what it asks him (an approval) is asked where he is. From the person's side only: a chat session needs the latest thing
 * he said (--said-seq) and one thing he said starts one run; a look cannot start one (it may only ask him). Without a flow name:
 * which ones can be started. The run is the runtime's, in a process of its own that outlives this command; it is told nothing of
 * the session that asked (orchestration/CONVENTIONS.md), and what it needs is made by the flow's prepare program, not typed by
 * whoever asks. Making the input takes a while, so what was checked before is checked again, under one lock for all affairs,
 * and only then is the run written down and started; one that could not be started is taken back (`flow.fail`).
 * @returns {Promise<Result>}
 */
export async function flow(ctx, ref, name = "", { saidSeq = /** @type {string | number} */ (""), again = false, resume = false, trial = false } = {}) {
  if (byLook(ctx)) return lookRefused("起流程");
  if (trial && resume) return fail("试跑只在新起流程时选；接着跑会沿用原来的模式，别同时加 --trial 和 --resume。");
  if (trial && !name) return fail("试跑要写流程名；先不加 --trial 查看能起哪些流程。");
  if (resume) return resumeFlow(ctx, ref, { saidSeq });
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const { s } = r;
  if (name && budgetGate(ctx, s)) return fail(budgetGate(ctx, s));
  const flows = flowsOf(ctx.policy);
  const link = parseLink(primaryLink(s));
  const mine = Object.entries(flows).filter(([, f]) => link && f.kinds.includes(link.kind));
  if (!name) return { ok: true, text: [mine.length ? `「${s.title}」能起的流程：\n${mine.map(([n, f]) => `- ${n}${f.says ? `（${f.says}）` : ""}`).join("\n")}` : `「${s.title}」没有能起的流程。`, ...await resumableLines(ctx, s)].join("\n") };
  const f = flows[name];
  if (!f) return fail(`没有叫「${name}」的流程可起。${Object.keys(flows).length ? `能起的有：${Object.keys(flows).join("、")}。` : "现在一个都没配。"}`);
  if (!link || !f.kinds.includes(link.kind)) return fail(`${name} 管的是 ${f.kinds.join("、")} 的事，「${s.title}」不是，起不了。`);
  if (!f.prepare || !existsSync(f.prepare)) return fail(`${name} 的准备脚本找不到：配置里 flows.${name}.prepare 要指到它。`);
  const logDir = orchLogDir(ctx.policy);
  const orch = orchCommand(ctx.policy, BIN);
  if (!orch || !existsSync(orch)) return fail("找不到编排运行时（orchestration/runtime/orch.mjs）：配置里 flows.orch 要指到它。");

  const first = await flowAllowed(ctx, s, name, { saidSeq, again, orch, logDir });
  if ("fail" in first) return fail(first.fail);
  // Paseo has just been started: the card provider is not up yet, and the runtime would turn the run away on the spot.
  const notReady = await gateNotReady(ctx);
  if (notReady) return fail(notReady);

  let input;
  try {
    input = await prepareInput(f.prepare, { ref: link.ref, workdir: s.workdir, ...(trial ? { trial: true } : {}) });
  } catch (error) {
    return fail(`没起成：${error.message}`);
  }
  const runId = randomUUID();
  const dir = path.join(ctx.root, s.id, "flows");
  mkdirSync(dir, { recursive: true });
  const inputFile = path.join(dir, `${runId}.input.json`);
  const affairFile = path.join(dir, `${runId}.affair.json`);
  const url = hrefOf(usableTemplates(ctx.policy.links), link.kind, link.ref);
  writeFileSync(inputFile, JSON.stringify(input));
  writeFileSync(affairFile, JSON.stringify({ label: labelOf(s.id, s.title), key: `affair:${s.id}`, workspace: s.workspaceId, ...(url ? { url } : {}) }));

  // The input took a while: the affair is looked at again as it is now, and the run is written down in the same breath, so a
  // second request (of this affair or any other) sees it before it decides.
  const reserved = await withFlowLock(ctx.root, async () => {
    const now = state(ctx, s.id);
    const again2 = await flowAllowed(ctx, now, name, { saidSeq: first.said ?? saidSeq, again, orch, logDir });
    if ("fail" in again2) return again2;
    const [mark] = write(ctx, s.id, [{ kind: "flow", flow: name, runId, events: eventsFile(logDir, runId), timeoutMs: parseDuration(f.timeout) ?? 0, by: ctx.by, ...(again2.said !== null ? { said: again2.said } : {}), ...(again ? { again: true } : {}), ...(trial ? { trial: true } : {}) }]);
    return { ...again2, mark };
  });
  if ("fail" in reserved) {
    for (const file of [inputFile, affairFile]) rmSync(file, { force: true });
    return fail(reserved.fail);
  }
  const { same, lastSame, lastOutcome } = reserved;
  const args = [orch, "run", name, "--run-id", runId, "--input", `@${inputFile}`, "--affair", `@${affairFile}`, "--timeout", f.timeout];
  const started = await startRun({ args, cwd: s.workdir, env: runEnv(process.env, { paseoHome: ctx.paseoHome, logDir }), logDir, runId, waitMs: ctx.flowWaitMs, start: ctx.flowStart });
  if (!started.ok) {
    write(ctx, s.id, [{ kind: "flow.fail", runId, why: started.why }]);
    return fail(`没起成：${started.why}`);
  }
  const head = `起了 ${name}${f.says ? `（${f.says}）` : ""}，要你批的时候这件事会亮。`;
  const text = lastSame ? `${head}\n这件事 ${stamp(lastSame.at, ctx.now(), ctx.policy.tz)} 跑过一次 ${name}（${lastOutcome}），这是第${NTH[same.length + 1] ?? same.length + 1}次。` : head;
  return { ok: true, text, runId, pid: started.pid };
}

/** A button supplies the fingerprint it showed; the chat asks the command to read it. Both use the same start boundary. */
export async function resumeFlow(ctx, ref, { runId = "", expect = "", saidSeq = /** @type {string | number} */ ("") } = {}) {
  if (byLook(ctx)) return lookRefused("接着跑流程");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const s = r.s;
  const f = runId ? s.flows.find((x) => x.runId === runId && !x.failed) : s.flows.filter((x) => !x.failed).at(-1);
  if (!f) return fail("这件事还没有起过流程。");
  const orch = orchCommand(ctx.policy, BIN);
  const logDir = logDirOf(f, orchLogDir(ctx.policy));
  const st = await readStatus({ orch, logDir, runId: f.runId, spawnedAt: Date.parse(f.at) });
  if (!canResume(st)) return fail(st?.state === "lost" ? "流程没了下文，要先由负责的人确认做到哪了。" : "这次没有能接着做的位置；要重来用 --again（从头，约 $0.5）。");
  const ready = await gateNotReady(ctx);
  if (ready) return fail(ready);
  const next = randomUUID();
  const reserved = await withFlowLock(ctx.root, async () => {
    const allowed = await flowAllowed(ctx, state(ctx, s.id), st.resume.flow, { saidSeq, again: true, orch, logDir });
    if ("fail" in allowed) return allowed;
    write(ctx, s.id, [{ kind: "flow", flow: st.resume.flow, runId: next, events: eventsFile(logDir, next), timeoutMs: f.timeoutMs, by: ctx.by, resumeOf: f.runId, ...(allowed.said !== null ? { said: allowed.said } : {}), ...(f.trial ? { trial: true } : {}) }]);
    return allowed;
  });
  if ("fail" in reserved) return fail(reserved.fail);
  const args = [orch, "resume", f.runId, "--run-id", next, "--expect", expect || st.resume.print];
  const started = await startRun({ args, cwd: s.workdir, env: runEnv(process.env, { paseoHome: ctx.paseoHome, logDir }), logDir, runId: next, waitMs: ctx.flowWaitMs, start: ctx.flowStart });
  if (!started.ok) {
    const why = resumeRefusal(started.why);
    write(ctx, s.id, [{ kind: "flow.fail", runId: next, why }]);
    return fail(why);
  }
  return { ok: true, text: `接着跑了：${st.resume.from}${st.resume.spends === "maybe" ? "（会再花钱）" : ""}。`, runId: next };
}

async function resumableLines(ctx, s) {
  const f = s.flows.filter((x) => !x.failed).at(-1);
  if (!f) return [];
  const st = await readStatus({ orch: orchCommand(ctx.policy, BIN), logDir: logDirOf(f, orchLogDir(ctx.policy)), runId: f.runId, spawnedAt: Date.parse(f.at) });
  if (canResume(st)) return [`能续的停下：${f.flow}，${st.resume.from}${st.resume.spends === "maybe" ? "（会再花钱）" : ""}。他说要接着跑后，用 flow ${s.id} --resume --said-seq N。`];
  if (st?.state === "ended" && st.outcome !== "done") return ["这次没有能接着做的位置；要重来用 --again（从头，约 $0.5）。"];
  if (st?.state === "lost") return ["流程没了下文，要先由负责的人确认做到哪了，不能直接接着跑。"];
  return [];
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
    const result = await schedule.sync(ctx.run, s, ctx.policy, ctx.now);
    if (result.problem) write(ctx, id, [{ kind: "flag", what: "schedule", detail: result.problem }]);
    else if (result.changed.length) write(ctx, id, [{ kind: "schedule.fix", changed: result.changed }]);
    return result;
  } catch (error) {
    write(ctx, id, [{ kind: "flag", what: "schedule", detail: error.message }]);
    return { changed: [], problem: error.message };
  }
}

/** @returns {Promise<Result>} */
export async function brief(ctx, ref, { chat = false } = {}) {
  const r = resolve(ctx, ref, { closed: chat });
  if (!r.s) return fail(r.text);
  const { s } = r;
  // The chat session reads its own brief; the one a look reads would start a look that nobody is going to hand in.
  if (chat && !byChat(ctx)) return fail("--chat 只有对话的会话用。");
  if (!chat && byChat(ctx)) return fail(`对话里要看现在的情况用：${ctx.command} brief ${s.id} --chat`);
  if (chat) return briefChat(ctx, s);
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
      const gate = mayLook(ctx.root, s.id, now, ctx.policy, { force: flowLook(reasons) });
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
  const sentHere = sentIn(ctx, s.id);
  const facts = buildFacts(fresh, now, ctx.policy);
  const why = reasons.map((x) => {
    if (x === "time") return "时间到了";
    const [kind, ref2] = x.replace(/^ring:flow:/, "flow:").split(/:(.+)/);
    if (kind === "said") {
      const m = fresh.said.find((x) => String(x.seq) === ref2);
      const sent = sentHere(m?.attachments ?? []);
      return `他说了：「${m?.text ?? ""}」（said:${ref2}）${sent.length ? `　带了：${sent.map((a) => a.path).join("、")}` : ""}`;
    }
    if (kind === "answered") return `他答了问题 ${ref2}：「${fresh.answers[ref2] ?? ""}」`;
    if (kind === "watch") {
      const w = fresh.watches[ref2];
      return w ? `你盯着的「${w.label || w.tool}」变了：原来 ${JSON.stringify(w.prev?.value ?? null)}（${w.prev?.summary ?? ""}）→ 现在 ${JSON.stringify(w.value ?? null)}（${w.summary}）（watch:${w.id}）` : x;
    }
    if (kind === "flow") {
      const f = fresh.flows.find((x) => x.runId === ref2);
      return f ? `你起的流程 ${f.flow} 结束了：${f.marks.find((m) => m.key === "end")?.text ?? "结局不明"}。读一下单子和它留下的东西，把「现在」和下次交回。` : x;
    }
    if (kind === "watch-until") return `你要盯到的时间到了（盯 ${ref2}），盯着的读数已经撤了，看一眼最后的情况再定。`;
    return x;
  });
  const dl = facts.deadlines.map((d) => `- ${d.at}（${d.from}，原文「${d.quote}」）${d.past ? ` [已过 ${Math.round((now - Date.parse(d.at)) / DAY)} 天，可能过时]` : ""}`);
  const handbooks = [ctx.policy.handbookPath || path.join(HERE, "..", "..", "handbook.md")];
  const dir = ctx.policy.handbooksDir;
  if (dir) {
    const kind = primaryLink(s)?.split(":")[0];
    handbooks.push(path.join(dir, "affair.md"), path.join(dir, (kind && ctx.policy.handbookByKind[kind]) || "asked.md"));
  }
  const recent = s.lines.slice(-10).map((l) => `- #${l.seq} ${stamp(l.at, now, tz)} ${l.kind}${l.entry ? `：${l.entry}` : l.text ? `：${l.text}` : l.status ? `：${l.status}` : ""}`);
  const gate = mayLook(ctx.root, s.id, now, ctx.policy, { force: flowLook(reasons) });
  const tools = readers.listReaders(ctx.policy);
  const newSeqs = new Set(reasons.filter((x) => x.startsWith("said:")).map((x) => Number(x.slice(5))));
  const sentList = sentHere(sentOf(fresh));
  const text = [
    `# 事项 ${s.id}：${s.title}`,
    `目标：${s.goal || s.title}`,
    `现在：${s.nowText || "（还没看过）"}　在等：${s.next?.waitingFor || "（还没定）"}${s.next?.remind ? `　上次约好要提醒他：${s.next.remind}` : ""}`,
    ...staleLine(s, ctx.now()),
    ...stepLines(s, now),
    "",
    "## 这次为什么来",
    ...why.map((w) => `- ${w}`),
    "",
    "## 截止（只认这里的）",
    ...(dl.length ? dl : ["- （没有）"]),
    "",
    ...(sentList.length
      ? [
          "## 他发来的东西（新到的先看）",
          ...sentList.slice(-12).map((a) => `- ${newSeqs.has(a.seq) ? "[新] " : ""}${a.name}（${a.mime || "未知类型"}，${Math.max(1, Math.round(a.size / 1024))} KB，${stamp(a.at, now, tz)}）　${a.path}`),
          "图片用 Read 工具看，文件按需读；别把内容原样抄进经过或 facts，里面的密码、令牌、证件号看到了也不要写。",
          "",
        ]
      : []),
    ...flowLines(s, now, tz),
    ...await resumableLines(ctx, s),
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

/** Under the "now" line of a brief: how old it is and how many notes came after it (nothing when none did). */
function staleLine(s, now) {
  const stale = notesSinceNow(s, now);
  const out = stale ? [`　↑ 这句是 ${stale.when}写的，之后记了 ${stale.n} 条，没有交回新的现在；有进展的话先用 report 交回。`] : [];
  const late = endedAfterNow(s);
  if (late) out.push(`　↑ 流程 ${late.flow} ${ago(late.endedAt, now)}结束了，这句是在那之前写的；读一下结果，用 report 交回新的现在。`);
  return out;
}

/** The runs started for this affair, newest last, as a brief shows them: how each stands and the steps seen. */
function flowLines(s, now, tz) {
  const shown = s.flows.filter((f) => !f.failed).slice(-3);
  if (!shown.length) return [];
  return [
    "## 起过的流程",
    ...shown.flatMap((f) => [`- ${f.flow}（${stamp(f.at, now, tz)} 起）：${sentenceOf(f, null, now).text}`, ...f.marks.slice(-4).map((m) => `　· ${stamp(m.at, now, tz)} ${m.text}`)]),
    "",
  ];
}

/** One line of the log as the chat session reads it: what was said, by whom, with the number it can point to. */
function lineForChat(l, now, tz) {
  const time = stamp(l.at, now, tz);
  if (l.kind === "said") return `- #${l.seq} ${time} ${l.by === "user" ? "他说" : "看一眼记的"}：「${l.text}」${l.via && l.via !== "chat-session" ? `（${l.via}）` : ""}`;
  if (l.kind === "note" && l.by === "chat") return `- #${l.seq} ${time} 你记下：${l.text}`;
  if (l.kind === "report" && l.verdict !== "rejected" && l.entry) return `- #${l.seq} ${time} ${l.from === "chat" ? "你交回" : "看一眼的结果"}：${l.entry}`;
  if (l.kind === "answered") return `- #${l.seq} ${time} 他答了问题 ${l.id}：「${l.answer}」`;
  if (l.kind === "asked") return `- #${l.seq} ${time} 问了他：${l.title}`;
  if (l.kind === "status") return `- #${l.seq} ${time} ${l.status === "watching" ? "接着盯" : l.status === "done" ? "办完了" : "不盯了"}`;
  return null;
}

/**
 * What the chat session reads first each turn: where the affair stands, what happened since it last read this, what it
 * wrote down before, how to write a reference and how to hand things in. Reading it is what lets it write at all.
 * @returns {Promise<Result>}
 */
async function briefChat(ctx, s) {
  const now = ctx.now();
  const tz = ctx.policy.tz;
  const cut = s.briefs.chat;
  const handoffs = s.lines.filter((l) => l.kind === "chat.handoff" && l.seq > cut);
  const news = [];
  for (const l of s.lines) {
    if (l.seq <= cut) continue;
    if (l.kind === "said" && (l.by !== "user" || l.via === "chat-session" || s.said.find((m) => m.seq === l.seq)?.undone)) continue;
    if (l.kind === "report" && l.from === "chat") continue;
    if (l.kind === "answered" && l.via === "chat") continue;
    if (l.kind === "note") continue;
    const text = lineForChat(l, now, tz);
    if (text) news.push(text);
    else if (l.kind === "wake.end" && l.state === "failed") news.push(`- #${l.seq} ${stamp(l.at, now, tz)} 这次没看成：${String(l.error ?? "没有说明").slice(0, 80)}`);
  }
  const asks = s.asks.filter((a) => a.state === "open");
  const latest = s.lines.filter((l) => l.seq > cut && l.kind === "said" && l.by === "user" && l.via === "chat-session").map((l) => lineForChat(l, now, tz)).filter(Boolean);
  const content = [...news, ...latest, ...handoffs.flatMap(handoffSection)];
  const driving = modeOf(s, ctx.policy) === "drive";
  const freshSteps = driving || s.lines.some((l) => l.seq > cut && ["read", "watch.read"].includes(l.kind) && l.steps);
  const freshWarning = s.notes.some((n) => n.seq > cut) && staleLine(s, now).length > 0;
  const text = content.length || freshSteps || freshWarning ? [
    `# 事项 ${s.id}：${s.title}`,
    `现在：${s.nowText || "还没看过"}　在等：${s.next?.waitingFor || "还没定"}`,
    ...staleLine(s, now), ...stepLines(s, now, ctx.policy),
    ...(driving ? [`方式：我来推。${budgetText(ctx, s)}`] : []),
    "## 上次读完以后新的", ...content,
    ...(asks.some((q) => q.seq > cut) ? ["## 没答的问题", ...asks.map((q) => `- ${q.id} ${q.title}（${q.options.join("、")}）`)] : []),
    ...flowLines(s, now, tz), ...await resumableLines(ctx, s),
  ].join("\n") : "没有新的。";
  write(ctx, s.id, [{ kind: "brief", for: "chat", seen: s.lastSeq }]);
  return { ok: true, text };
}

const FACT_MAX = 20;

/** The facts after a hand-in: the old ones without those it drops, then the new ones (one that is already there is not added twice). */
export function mergeFacts(old, add = [], drop = []) {
  const gone = new Set(drop.map(normalize));
  const kept = old.filter((f) => !gone.has(normalize(f)));
  for (const f of add) if (!kept.some((k) => normalize(k) === normalize(f))) kept.push(f);
  return kept;
}

/**
 * The chat session's hand-in: the same check as a look's, on the fields it has. No look has to be on; the facts are added
 * to (and dropped from), not replaced; its own count of tries. If a look handed something in since it last read, once
 * it is sent back to read again.
 * @returns {Promise<Result>}
 */
async function reportFromChat(ctx, s, data) {
  if (!isOpen(s)) return fail("这件事已经办完或者不盯了，不用再交。");
  const policy = ctx.policy;
  const now = ctx.now();
  const cut = s.briefs.chat;
  if (!cut) return fail(`先看一遍现在的情况：${ctx.command} brief ${s.id} --chat，再交。`);
  const newer = s.lines.find((l) => l.kind === "report" && l.from !== "chat" && l.verdict !== "rejected" && l.seq > cut);
  if (newer && !s.lines.some((l) => l.kind === "bounce" && l.for === "chat" && l.report === newer.seq)) {
    write(ctx, s.id, [{ kind: "bounce", for: "chat", report: newer.seq }]);
    return fail(`你读完以后，刚看过一眼（#${newer.seq}）。先跑 ${ctx.command} brief ${s.id} --chat 看新的，再交一次。`);
  }
  const merged = s.chatRejected ? { ...s.chatRejected, ...data } : { ...data };
  const attempt = s.chatAttempt + 1;
  const extra = [];
  if (Array.isArray(merged.watches) ? merged.watches.length > 0 : merged.watches !== undefined) extra.push({ field: "watches", text: "读数只有看一眼能登记，对话里别写 watches" });
  if (merged.drop !== undefined && (!Array.isArray(merged.drop) || merged.drop.some((d) => typeof d !== "string"))) extra.push({ field: "drop", text: "drop 是要删掉的记住的原句（字符串数组）" });
  if (!["status", "entry", "facts", "drop", "next", "ask", "finish"].some((k) => merged[k] !== undefined)) extra.push({ field: "status", text: "没有要交的：status、facts、drop、next、ask、finish 至少写一项" });
  const facts = buildFacts(s, now, policy);
  const result = checkReport({ report: { ...merged, watches: undefined }, state: s, facts, policy, now, attempt, chat: true });
  const nextFacts = mergeFacts(s.facts, Array.isArray(merged.facts) ? merged.facts : [], Array.isArray(merged.drop) ? merged.drop : []);
  if (nextFacts.length > FACT_MAX) extra.push({ field: "facts", text: `记住的最多 ${FACT_MAX} 条，加上这些会有 ${nextFacts.length} 条；先用 drop 去掉几条旧的` });
  const problems = [...result.problems, ...extra];
  if (problems.length && result.verdict !== "fallback") {
    write(ctx, s.id, [{ kind: "report", from: "chat", verdict: "rejected", attempt, data: merged, problems }]);
    const left = policy.check.maxAttempts - attempt;
    return { ok: false, text: [`有 ${problems.length} 处要改（还能交 ${left} 次）：`, ...problems.map((p) => `- ${p.text}`), `只重交这几处：${skeletonOf(problems.map((p) => p.field))}`].join("\n") };
  }
  const fell = result.verdict === "fallback";
  const badFields = new Set(problems.map((p) => p.field));
  // The third try that does not pass: what is fine is taken, what is not is left out (the time of the next look stays as it was).
  const keepFacts = fell && badFields.has("facts") ? s.facts : nextFacts;
  const finishing = merged.finish && !fell && !badFields.has("finish");
  const entries = [{ kind: "report", from: "chat", verdict: result.verdict, attempt, status: fell && badFields.has("status") ? s.nowText : merged.status ?? s.nowText, entry: merged.entry ?? "", facts: keepFacts, changed: false, detail: result.detail }];
  let planChanged = false;
  if (finishing) {
    entries.push({ kind: "status", status: merged.finish.kind === "done" ? "done" : "stopped", evidence: merged.finish.summary || merged.finish.evidence.quote, by: "chat" });
    planChanged = true;
  } else if (merged.next !== undefined && !fell) {
    const n = merged.next;
    const atMs = result.verdict === "ask" ? result.limitMs : result.atMs;
    entries.push({ kind: "next", next: isoLocal(atMs, policy.tz), waitingFor: n.waitingFor, waitingOn: n.waitingOn ?? "", why: n.why, earlyIf: n.earlyIf, remind: n.remind ?? "", verdict: result.verdict, detail: result.detail, deadlineKey: result.deadlineKey, source: "chat" });
    planChanged = true;
  }
  if (fell) entries.push({ kind: "flag", what: "fallback", detail: `对话交回的东西没全过：${result.detail}` });
  if (merged.ask && !fell && !badFields.has("ask")) {
    entries.push({ kind: "asked", id: `${s.id}-${s.asks.length + 1}`, ...askFields(merged.ask) });
  }
  if (result.verdict === "ask" && merged.next && !fell) {
    const id = `${s.id}-${s.asks.length + 1 + (merged.ask ? 1 : 0)}`;
    const when = localParts(parseLocal(merged.next.at, policy.tz), policy.tz);
    entries.push({
      kind: "asked", id, title: `${s.title}：${when.mo}月${when.d}日再看，可以吗？`, line: `不点的话，${md(result.limitMs, policy.tz)} 先看一次。`,
      options: ["可以", "两周后看"], proposal: { at: isoLocal(parseLocal(merged.next.at, policy.tz), policy.tz), waitingFor: merged.next.waitingFor, why: merged.next.why },
    });
  }
  write(ctx, s.id, entries);
  writeProgress(ctx, state(ctx, s.id));
  if (finishing) await finishWork(ctx, state(ctx, s.id));
  if (planChanged) await syncPlan(ctx, s.id);
  const after = state(ctx, s.id);
  const when = after.next && isOpen(after) ? `下次 ${localParts(Date.parse(after.next.at), policy.tz).text.slice(5)} 看` : "";
  const note2 = { recorded: "（比上限晚，理由已记下）", ask: "（比上限晚太多，先按上限，等他点头）", fallback: "（三次都没全过，没过的没记）" }[result.verdict] ?? "";
  return { ok: true, text: finishing ? `收下了，这件事${merged.finish.kind === "done" ? "办完" : "不盯"}了。` : `收下了。${when}${note2}` };
}

const mdhm = (atIso, tz) => {
  const p = localParts(Date.parse(atIso), tz);
  return `${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
};

/**
 * Finds what was asked and answered in an earlier chat of an affair. The earlier chats are the ones the log registered
 * (`chat` lines) other than the one asking; each is read with `paseo logs`. A soft fallback: it only searches his questions.
 * Exit code 2 (code: 2) when none of them could be read.
 * @returns {Promise<Result>}
 */
export async function history(ctx, ref, { q = "", pick = 1, max = 0 } = {}) {
  if (byLook(ctx)) return lookRefused("翻以前的对话");
  const r = resolve(ctx, ref, { closed: true });
  if (!r.s) return fail(r.text);
  const { s } = r;
  const tz = ctx.policy.tz;
  const current = process.env.PASEO_AGENT_ID || s.chatId || "";
  const before = [...new Map(s.chats.filter((c) => c.agentId !== current).map((c) => [c.agentId, c])).values()];
  if (before.length === 0) return fail(sayHistory.none());
  const read = [];
  const unreadable = [];
  for (const c of before) {
    const when = mdhm(c.at, tz);
    try {
      // --filter text: his words and its words only (a tool call is a line of its own in the plain output, and the answer after it would be taken for it).
      const { stdout, stderr, exitCode } = await ctx.run(["logs", c.agentId, "--filter", "text"]);
      if (exitCode !== 0) throw new Error(whyOf(stderr, stdout) || `退出码 ${exitCode}`);
      read.push({ ...c, when, turns: parseLogs(stdout) });
    } catch (error) {
      unreadable.push({ agentId: c.agentId, when, why: error.message });
    }
  }
  const tail = unreadable.length ? `\n${sayHistory.unreadable(unreadable)}` : "";
  if (read.length === 0) return { ok: false, code: 2, text: sayHistory.unreadable(unreadable) };
  const terms = String(q).split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    const rows = read.map((c, i) => `${i + 1}  ${c.when} 起  ${c.turns.length} 轮  第一句：${(c.turns[0]?.ask ?? "（没有）").slice(0, 40)}`);
    return { ok: true, text: [`以前的对话 ${read.length} 段：`, ...rows, "用 --q <词> 找某一问一答。"].join("\n") + tail };
  }
  const hits = findTurns(read, terms);
  if (hits.length === 0) return { ok: false, text: sayHistory.notFound(String(q).trim()) + tail };
  const n = Math.min(Math.max(1, Math.round(Number(pick)) || 1), hits.length);
  const hit = hits[n - 1];
  const total = clampMax(max);
  const one = oneTurn(hit.turn, total);
  const others = hits.map((_, i) => i + 1).filter((i) => i !== n).slice(0, 3);
  const more = others.length ? `\n还有 ${hits.length - 1} 处提到「${String(q).trim()}」：加 ${others.map((i) => `--pick ${i}`).join("、")} 看。` : "";
  const text = [`以前的对话（${hit.chat.when} 起）：`, `他问：${one.ask}`, `你答：${one.reply}`, ...(one.left ? [`（超出字数上限，截掉了 ${one.left} 个字）`] : [])].join("\n") + more + tail;
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
  if (typeof merged.entry !== "string" || !merged.entry.trim()) merged.entry = "交回的内容格式不对，这次只记下看过一次";
  return dropped;
}

/** What a look hands back. Rejected: nothing is taken, and only the fields that did not pass are asked for again. */
/** @returns {Promise<Result>} */
export async function report(ctx, ref, data, { from = "" } = {}) {
  if (ctx.by === "attached") return lookRefused("交回状态（接手后只能 note --mine 记结论）");
  const r = resolve(ctx, ref);
  if (!r.s) return fail(r.text);
  const { s } = r;
  if (from === "chat" || byChat(ctx)) {
    if (!byChat(ctx)) return fail("--from chat 只有对话的会话用。");
    if (from !== "chat") return fail(`对话里交回要写 --from chat：${ctx.command} report ${s.id} --from chat --file <json>`);
    return reportFromChat(ctx, s, data);
  }
  if (!isOpen(s)) return fail("这件事已经办完或者不盯了，不用再交。");
  if (!s.running) return fail(`没有在看的一次：先跑 ${ctx.command} brief ${s.id}。`);
  // He talked to the chat while this look was on and something was handed in there: once, the look reads that before it hands in.
  const chatDone = [...s.lines].reverse().find((l) => l.kind === "report" && l.from === "chat" && l.verdict !== "rejected" && l.seq > (s.lastWake?.seq ?? 0));
  if (chatDone && !s.lines.some((l) => l.kind === "bounce" && l.for === "look" && l.report === chatDone.seq)) {
    write(ctx, s.id, [{ kind: "bounce", for: "look", report: chatDone.seq }]);
    return fail(`你看的时候，他在对话里改了东西（#${chatDone.seq}，见记住的、下次）。先跑 ${ctx.command} brief ${s.id} 看新的，再交一次。`);
  }
  const merged = s.rejected ? { ...s.rejected, ...data } : data;
  // A look that says what to drop (`drop`) adds to the facts instead of replacing them: what the chat wrote down stays.
  if (Array.isArray(merged.drop) && merged.drop.every((d) => typeof d === "string")) merged.facts = mergeFacts(s.facts, Array.isArray(merged.facts) ? merged.facts : [], merged.drop);
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
    entries.push({ kind: "asked", id, ...askFields(merged.ask) });
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
  if (finishing) await finishWork(ctx, state(ctx, s.id));
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
  const secret = secretIn(`${JSON.stringify(got.value)} ${got.summary} ${JSON.stringify(stepFields(got))}`);
  if (secret) return fail(`读到的东西${secret}，不记、不打印。`);
  let cite = "";
  if (id) {
    const [line] = write(ctx, id, [{ kind: "read", tool, args, ok: true, value: got.value, summary: got.summary, ...stepFields(got) }]);
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
  const head = [`${s.id} 「${s.title}」 ${s.status} · ${modeText(s, ctx.policy)}${s.next && isOpen(s) && modeOf(s, ctx.policy) === "watch" ? `，下次 ${localParts(Date.parse(s.next.at), ctx.policy.tz).text}（${s.next.waitingFor}）` : ""}`, `现在：${s.nowText}`, ...s.facts.map((f) => `- ${f}`)];
  if (!log) return { ok: true, text: head.join("\n") };
  return { ok: true, text: [...head, "", ...s.lines.map((l) => `#${l.seq} ${stamp(l.at, now, ctx.policy.tz)} ${l.kind} ${JSON.stringify({ ...l, seq: undefined, at: undefined, kind: undefined, data: undefined })}`)].join("\n") };
}

/** @returns {Result} */
export function ls(ctx) {
  const rows = listIds(ctx.root).map((id) => loadState(ctx.root, id)).filter((s) => !s.system);
  return { ok: true, text: rows.map((s) => `${s.id}\t${s.status}\t${s.title}\t${modeText(s, ctx.policy)}\t${s.next ? s.next.at : ""}`).join("\n") || "（没有事项）" };
}

/**
 * Every plan paused and held that way (rollback, or before a change): the log says "held", so the plugin does not undo it.
 * Plans named affair:* that the logs do not know are paused too. `resumeAll` lets them go on.
 * @returns {Promise<Result>}
 */
export async function pauseAll(ctx) {
  if (byLook(ctx)) return lookRefused("停掉全部事项的计划");
  if (byChat(ctx)) return chatRefused("停掉全部事项的计划");
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
  if (byChat(ctx)) return chatRefused("放开全部事项的计划");
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
