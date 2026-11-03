import { isoLocal, localParts, parseLocal } from "./time.mjs";

// The check on what a look hands back, above all on the next time it asks to look. Pure: facts are worked out by the
// command from the log, never taken from the session. Only `affair report` calls checkReport.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Mechanism words a person should never read in a card, a line, a push or a question (the session writes those texts, so they are checked too). */
const INNER_WORDS = /叫醒|校验|读数|会话|agent/i;
/** A quote shorter than this does not prove anything, unless it is the whole of what was said. */
const MIN_QUOTE = 6;
const EVIDENCE_FROM = /^(?:said:\d+|answer:[\w-]+|link:\S+|watch:[\w.-]+|reader:\S+)$/;
/** What looks like a credential, a token or a pairing link: none of it goes into an affair's folder. */
const SECRETS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|密码|口令|令牌|密钥)["']?\s*[:=：是为]\s*["']?[^\s"',}]{6,}/i,
  /--(?:password|passwd|token|secret)(?:\s+|=)\S{4,}/i,
  /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/,
  /#offer=|paseo:\/\/pair|app\.paseo\.sh\/#/i,
];
/** A sentence a person may read as it stands: a string of the right length with no mechanism word and no secret in it. */
export const plainText = (text, max) => typeof text === "string" && text.trim() !== "" && [...text].length <= max && !INNER_WORDS.test(text) && !secretIn(text);
export const secretIn = (text) => (typeof text === "string" && SECRETS.some((re) => re.test(text)) ? "像是密码、令牌或配对链接" : null);

const normalize = (text) => String(text ?? "").replace(/[\s\p{P}\p{S}]/gu, "");

const DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 两: 2 };
const asNumber = (s) => (/^\d+$/.test(s) ? Number(s) : DIGITS[s] ?? NaN);
const NUM = "(\\d{1,2}|十二|十一|十|[一二三四五六七八九两])";

/**
 * Whether what he said names the day the time falls on: a date ("3月1日", "03-01", "3/1", "2027年3月1号"), a month
 * ("三月", "下个月" when it is next month, "明年" when it is next year), or a span from now ("两周后", "10天后", "三个月后"
 * within a day or a week of it). A time that is only "later" proves nothing about which day he meant.
 */
export function mentionsDay(text, at, now, tz) {
  const t = String(text ?? "");
  const d = localParts(at, tz);
  const n = localParts(now, tz);
  const monthDay = [...t.matchAll(new RegExp(`${NUM}\\s*月\\s*${NUM}\\s*[日号]?`, "g"))].some((m) => asNumber(m[1]) === d.mo && asNumber(m[2]) === d.d);
  if (monthDay) return true;
  if ([...t.matchAll(/(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/g)].some((m) => Number(m[1]) === d.mo && Number(m[2]) === d.d)) return true;
  if ([...t.matchAll(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/g)].some((m) => Number(m[1]) === d.y && Number(m[2]) === d.mo && Number(m[3]) === d.d)) return true;
  if ([...t.matchAll(new RegExp(`${NUM}\\s*月(?!\\s*${NUM}\\s*[日号])(?!份?\\s*底)`, "g"))].some((m) => asNumber(m[1]) === d.mo && !/个月/.test(m[0]))) return true;
  if (/下个?月/.test(t) && (d.y * 12 + d.mo) - (n.y * 12 + n.mo) === 1) return true;
  if (/明年/.test(t) && d.y === n.y + 1) return true;
  const spans = [
    [new RegExp(`${NUM}\\s*天后`), DAY, 1],
    [new RegExp(`${NUM}\\s*(?:个)?(?:周|星期|礼拜)后`), 7 * DAY, 3],
    [new RegExp(`${NUM}\\s*个月后`), 30 * DAY, 7],
  ];
  for (const [re, unit, slack] of spans) {
    const m = re.exec(t);
    if (m && Math.abs(at - (now + asNumber(m[1]) * unit)) <= slack * DAY) return true;
  }
  return false;
}

/** What the check needs to know, worked out from the log. */
export function buildFacts(state, now, policy) {
  const { tz, check } = policy;
  const sources = {};
  for (const s of state.said) if (!s.undone && s.by === "user") sources[`said:${s.seq}`] = s.text;
  for (const [id, answer] of Object.entries(state.answers)) sources[`answer:${id}`] = answer;
  for (const d of state.deadlines) sources[d.from] = `${sources[d.from] ?? ""} ${d.quote}`.trim();
  for (const w of Object.values(state.watches)) sources[`watch:${w.id}`] = `${JSON.stringify(w.value ?? "")} ${w.summary ?? ""}`;
  for (const r of state.reads) if (r.ok) sources[`reader:${r.id}`] = `${JSON.stringify(r.value ?? "")} ${r.summary}`;
  const appeal = state.appeals[state.appeals.length - 1];
  return {
    now: isoLocal(now, tz),
    tz,
    deadlines: state.deadlines.map((d) => ({ at: d.at, from: d.from, quote: d.quote, past: Date.parse(d.at) <= now })),
    sources,
    recent: state.wakes.filter((w) => w.reported || !state.running || w !== state.wakes[state.wakes.length - 1]).slice(-5).map((w) => ({ at: w.at, why: w.why.length === 1 && w.why[0] === "time" ? "time" : "event", gapMinutes: w.gapMinutes, changed: w.changed })),
    limits: { minGapMinutes: check.minGapMinutes, softDays: check.softDays, hardDays: check.hardDays, deadlineMarginRatio: check.deadlineMarginRatio },
    lastAppealAt: appeal ?? null,
    pendingAsks: state.asks.filter((a) => a.state === "open").map((a) => ({ id: a.id, text: a.title, at: a.at })),
  };
}

/** The earliest next look: the shortest gap from now, rounded up to the whole minute (the time is written to the minute, so the hint and the check agree). */
export const earliestOf = (now, check) => Math.ceil((now + check.minGapMinutes * MIN) / MIN) * MIN;

/** The latest the next look may be without a reason: the earliest deadline still ahead less a margin, or the soft limit. */
export function upperLimit(facts, now, check) {
  const soft = now + check.softDays * DAY;
  const floor = earliestOf(now, check);
  const ahead = facts.deadlines.filter((d) => !d.past).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (!ahead) return { limit: soft, deadline: null };
  const deadlineMs = Date.parse(ahead.at);
  const margin = Math.max(HOUR, Math.min(DAY, check.deadlineMarginRatio * (deadlineMs - now)));
  return { limit: Math.max(Math.min(deadlineMs - margin, soft), floor), deadline: { ...ahead, ms: deadlineMs } };
}

/** quote is a substring of the source once whitespace and punctuation are gone from both. */
export function verifyEvidence(evidence, facts, extraSources = {}) {
  if (!evidence || typeof evidence !== "object") return "证据要写成 {quote, from}";
  const { quote, from } = evidence;
  if (typeof from !== "string" || !EVIDENCE_FROM.test(from)) return `出处「${from ?? ""}」不认；能认的：你说过的话（said:编号）、你的回答（answer:问题）、外部系统的字段（link:…）、读数（watch:编号）、用 affair read --for 现读的结果（reader:编号）`;
  const q = normalize(quote);
  if (!q) return "引文没写";
  const source = normalize(facts.sources[from] ?? extraSources[from]);
  // Short is fine only when it is all there is to the source; otherwise a few words (or numbers) fit anywhere.
  if ((q.length < MIN_QUOTE || !/\p{L}/u.test(q)) && q !== source) return `引文太短（至少 ${MIN_QUOTE} 个字，不能只是数字和标点），引一整句原话`;
  return source.includes(q) ? null : `在「${from}」里找不到原文「${String(quote).slice(0, 40)}」`;
}

const textProblem = (field, text) => (INNER_WORDS.test(text ?? "") ? `${field} 里有内部用词（叫醒、校验、读数、会话、agent），换成人话` : null);

/** A workday after now, at the same clock time: Saturday and Sunday are skipped. */
export function nextWorkday(now, tz) {
  let ms = now + DAY;
  while ([0, 6].includes(localParts(ms, tz).dow)) ms += DAY;
  return ms;
}

function checkStructure(report, finishing, chat = false) {
  const out = [];
  const add = (field, text) => out.push({ field, text });
  // The chat session hands in only what it has: every field may be left out.
  if (chat ? report.status !== undefined : !finishing || report.status !== undefined) {
    if (typeof report.status !== "string" || !report.status.trim()) add("status", "status 要写现在的情况，一句话");
    else if ([...report.status].length > 40) add("status", "status 不超过 40 个字");
  }
  if (chat && report.entry === undefined) {
    // nothing to say about a look: there was none
  } else if (typeof report.entry !== "string" || !report.entry.trim()) add("entry", "entry 要写这次看到了什么，一句话");
  else if ([...report.entry].length > 200) add("entry", "entry 不超过 200 个字");
  if (report.facts !== undefined && (!Array.isArray(report.facts) || report.facts.length > 20 || report.facts.some((f) => typeof f !== "string" || f.length > 300))) add("facts", "facts 是字符串数组（≤20 条，每条 ≤300 字），整组替换");
  const watches = report.watches ?? [];
  if (!Array.isArray(watches) || watches.length > 5 || watches.some((w) => !w || typeof w.id !== "string" || !/^[\w.-]{1,20}$/.test(w.id) || typeof w.tool !== "string")) add("watches", "watches 最多 5 个，每个要有 id 和 tool");
  else if (new Set(watches.map((w) => w.id)).size !== watches.length) add("watches", "watches 的 id 不能重复");
  if (report.ask !== undefined) {
    const a = report.ask;
    if (!a || typeof a.title !== "string" || !a.title.trim() || !Array.isArray(a.options) || a.options.length < 1 || a.options.length > 3 || a.options.some((o) => typeof o !== "string" || !o.trim())) add("ask", "ask 要有 title 和 1–3 个选项（推荐的放第一个）");
  }
  const shown = [["status", report.status], ["entry", report.entry], ["ask", report.ask?.title], ["ask", report.ask?.line], ["next", report.next?.waitingFor], ["next", report.next?.why], ["finish", report.finish?.summary]];
  const noted = Array.isArray(report.facts) ? report.facts.map((f) => ["facts", f]) : [];
  for (const [field, text] of [...shown, ...noted]) {
    const p = typeof text === "string" && field !== "facts" ? textProblem(field, text) : null;
    if (p) add(field, p);
    const secret = secretIn(text);
    if (secret) add(field, `${field} 里有${secret}的东西，不要写进来（写「读到了一个令牌」这样的话就够）`);
  }
  for (const o of Array.isArray(report.ask?.options) ? report.ask.options : []) if (typeof o === "string" && INNER_WORDS.test(o)) add("ask", "ask 的选项里有内部用词，换成人话");
  return out;
}

/**
 * @returns {{ problems: Array<{field: string, text: string}>, verdict: string, atMs: number|null, detail: string, deadlineKey: string|null, limitMs: number }}
 * verdict: pass | recorded (past the limit with a quote that checks out) | ask (too far past: ask the person) | appeal |
 * rejected (nothing taken, hand it in again) | fallback (third failure: the rest is taken, the next time is ours).
 */
export function checkReport({ report, state, facts, policy, now, attempt, readerSources = {}, chat = false }) {
  const { check, tz } = policy;
  const finishing = Boolean(report.finish);
  const problems = checkStructure(report, finishing, chat);
  const hard = [];
  const add = (field, text) => hard.push({ field, text });
  const { limit, deadline } = upperLimit(facts, now, check);
  let atMs = null;
  let over = 0;
  let verified = 0;

  if (report.finish) {
    const f = report.finish;
    const bad = !["done", "stop"].includes(f.kind) ? "finish.kind 是 done（办完了）或 stop（不用盯了）" : verifyEvidence(f.evidence, facts, readerSources);
    if (bad) add("finish", bad);
    const all = [...problems, ...hard];
    if (all.length === 0) return { problems: all, verdict: "pass", atMs: null, detail: "", deadlineKey: null, limitMs: limit, attempt };
    if (attempt < check.maxAttempts) return { problems: all, verdict: "rejected", atMs: null, detail: "", deadlineKey: null, limitMs: limit, attempt };
    // A finish that cannot be shown is dropped on the third try and the affair goes on.
    return { problems: all, verdict: "fallback", atMs: Math.max(Math.min(limit, nextWorkday(now, tz)), earliestOf(now, check)), detail: all.map((p) => p.text).join("；"), deadlineKey: null, limitMs: limit, attempt };
  }

  const n = report.next;
  if (chat && n === undefined) {
    // The chat session did not touch the time of the next look.
  } else if (!n || typeof n !== "object") add("next", "缺 next：下次什么时候看、在等什么");
  else {
    atMs = parseLocal(n.at, tz);
    if (atMs === null || atMs <= now) add("next", "next.at 要写成 YYYY-MM-DD HH:mm，在现在之后");
    const missing = [];
    const vague = (t) => {
      const x = normalize(t);
      return x.length < 2 || check.filler.some((w) => normalize(w) === x);
    };
    if (typeof n.waitingFor !== "string" || vague(n.waitingFor) || [...n.waitingFor].length > 12) missing.push("waitingFor（≤12 字，写具体：谁、做什么）");
    if (typeof n.why !== "string" || vague(n.why)) missing.push("why（为什么挑这个时间）");
    if (!Array.isArray(n.earlyIf)) missing.push("earlyIf（可以是空数组）");
    if (missing.length) add("next", `缺『在等什么』：${missing.join("；")}`);
    const ids = new Set((report.watches ?? []).map((w) => `watch:${w.id}`));
    for (const e of Array.isArray(n.earlyIf) ? n.earlyIf : []) if (!ids.has(e)) add("next", `earlyIf 里的 ${e} 要先在 watches 里登记`);
    if (atMs !== null && atMs > now) {
      const earliest = earliestOf(now, check);
      if (atMs < earliest) add("next", `最早 ${localParts(earliest, tz).text.slice(11)}。在等某个变化就登记读数（watches）、写进 earlyIf，别轮询`);
      const loop = facts.recent.slice(-check.loopCount);
      if (loop.length === check.loopCount && loop.every((r) => r.why === "time" && r.gapMinutes !== null && r.gapMinutes < check.loopWindowMinutes && r.changed === false) && atMs < now + check.loopWindowMinutes * MIN) {
        add("next", `前 ${check.loopCount} 次都在 ${check.loopWindowMinutes / 60} 小时内看、没有变化；要么定远一点，要么登记一个读数让它变了叫你`);
      }
      if (atMs > now + check.hardDays * DAY) add("next", "最远一年；更久的事先不盯，到时候让他重新交代");
      over = atMs - limit;
    }
    for (const e of report.next.evidence ?? []) {
      const bad = verifyEvidence(e, facts, readerSources);
      if (bad) add("next", `证据不成立：${bad}`);
      else verified += 1;
    }
  }

  const all = [...problems, ...hard];
  const deadlineKey = deadline ? `${deadline.from}@${deadline.at}` : null;
  const lateBy = deadline && atMs ? Math.round((atMs - deadline.ms) / HOUR) : null;
  let verdict = "pass";
  let detail = "";
  if (hard.length === 0 && over > 0) {
    const allowed = Math.max(check.overAllowanceMinutes * MIN, check.overAllowanceRatio * (limit - now));
    const wantsAppeal = typeof n.appeal === "string" && n.appeal.trim() && attempt >= 2;
    if (verified > 0) {
      verdict = over <= allowed && !(deadlineKey && state.crossed.includes(deadlineKey)) ? "recorded" : "ask";
      detail = lateBy !== null && lateBy > 0 ? `比截止晚 ${lateBy} 小时，理由：${n.why}` : `比上限晚 ${Math.round(over / HOUR)} 小时，理由：${n.why}`;
    } else if (wantsAppeal) {
      const recent = state.appeals.length > 0 && now - Date.parse(state.appeals[state.appeals.length - 1]) < check.appealDays * DAY;
      verdict = recent ? "ask" : "appeal";
      detail = n.appeal;
    } else {
      const where = deadline ? `L 是 ${localParts(limit, tz).text}（截止 ${localParts(deadline.ms, tz).text}，出处 ${deadline.from}）` : `L 是 ${localParts(limit, tz).text}（没有截止，最多 ${check.softDays} 天）`;
      all.push({ field: "next", text: `${where}；你定的 ${n.at} 在后面。要么改到 L 之前，要么引原文（evidence），确定检查错了才写 appeal 和理由` });
    }
  }
  if (all.length === 0) return { problems: [], verdict, atMs, detail, deadlineKey, limitMs: limit, attempt };
  if (attempt < check.maxAttempts) return { problems: all, verdict: "rejected", atMs: null, detail: "", deadlineKey, limitMs: limit, attempt };
  const fallback = Math.max(Math.min(limit, nextWorkday(now, tz)), earliestOf(now, check));
  return { problems: all, verdict: "fallback", atMs: fallback, detail: all.map((p) => p.text).join("；"), deadlineKey, limitMs: limit, attempt };
}

/** The shape of just the fields that did not pass: what the session hands in again. */
export function skeletonOf(fields) {
  const shapes = {
    status: "\"现在的情况，≤40 字\"",
    entry: "\"我看了一眼：…\"",
    facts: "[\"记住的，整组\"]",
    watches: "[{\"id\":\"w1\",\"tool\":\"…\",\"args\":{}}]",
    next: "{\"at\":\"YYYY-MM-DD HH:mm\",\"waitingFor\":\"≤12 字\",\"waitingOn\":\"me|others|time\",\"why\":\"…\",\"earlyIf\":[],\"evidence\":[{\"quote\":\"原文\",\"from\":\"said:1\"}],\"appeal\":\"\"}",
    ask: "{\"title\":\"…\",\"line\":\"…\",\"options\":[\"…\"]}",
    finish: "{\"kind\":\"done|stop\",\"evidence\":{\"quote\":\"原文\",\"from\":\"said:1\"}}",
  };
  return `{${[...new Set(fields)].map((f) => `"${f}": ${shapes[f] ?? "…"}`).join(", ")}}`;
}
