import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { primaryLink, hrefOf, linkify, parseLink, partsOf } from "./links.mjs";
import { CLIP_CHARS, FULL_CHARS, clip } from "./clip.mjs";
import { counts } from "./limits.mjs";
import { cardOf, sentOf, stamp } from "./view.mjs";
import { eventsOf, shownName, whenOf } from "./events.mjs";
import { SAME_SPOT_TEXT, sameSpotAgain, canResume, endedAfterNow, sentenceOf, spanText, usdText } from "./flows.mjs";
import { listReaders } from "./readers.mjs";
import { modeOf, modeText } from "./mode.mjs";
import { budgetOf, budgetText } from "./drive.mjs";
import { stepLines, stepsOf } from "./steps.mjs";

// The progress panel draws its status, sources, steps and history from the affair's log and files.

export const SOURCES_SHOWN = 6;
export const MATERIALS_SHOWN = 5;
const MATERIAL_CHARS = 20_000;
/** A picture bigger than this is not sent to the panel to be drawn: it is a block with its type on it. */
export const PICTURE_BYTES = 3 * 1024 * 1024;

const PICTURE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
const extOf = (name) => path.extname(String(name)).slice(1).toLowerCase();
const slashed = (file) => file.replace(/\\/g, "/");

/** The file in the affair's files/ folder by that name, or null when the name is anything else (a path, a folder, nothing). */
export function fileIn(root, id, name) {
  const dir = path.resolve(root, id, "files");
  const file = path.resolve(dir, String(name ?? ""));
  if (path.dirname(file) !== dir || !existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

/** A picture, a text or something else; a text is told by its look (no zero byte at the start), not only by its name. */
/** @returns {"image" | "text" | "other"} */
function kindOf(file) {
  if (PICTURE_TYPES[extOf(file)]) return "image";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4000);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0) ? "other" : "text";
  } finally {
    closeSync(fd);
  }
}

/**
 * One file in the affair's files/ folder, to show where it is listed: a picture as data to draw, a text as its first part; a name that is not a file there is refused.
 * @returns {{ ok: boolean, kind: "image" | "text" | "other", mime: string, size: number, truncated: boolean, path: string, dataUrl?: string, text?: string }}
 */
export function materialFile(root, id, name) {
  const file = fileIn(root, id, name);
  if (!file) return { ok: false, kind: "other", mime: "", size: 0, truncated: false, path: "" };
  const size = statSync(file).size;
  const kind = kindOf(file);
  const base = { ok: true, kind, size, path: slashed(file) };
  if (kind === "image") {
    const mime = PICTURE_TYPES[extOf(file)];
    return size <= PICTURE_BYTES ? { ...base, mime, truncated: false, dataUrl: `data:${mime};base64,${readFileSync(file).toString("base64")}` } : { ...base, mime, truncated: true };
  }
  if (kind === "text") {
    const text = readFileSync(file, "utf8");
    return { ...base, mime: "text/plain", text: text.slice(0, MATERIAL_CHARS), truncated: text.length > MATERIAL_CHARS };
  }
  return { ...base, mime: "", truncated: false };
}

/** How a link kind is named to a person. */
const KIND_NAME = { gcp: "易协作", "feishu-task": "飞书任务", doc: "文档", svn: "提交" };

/** @returns {{ label: string, href: string | null } | null} the affair's own link, as one source */
function mainSource(state, lc) {
  const own = parseLink(primaryLink(state));
  if (!own) return null;
  const href = hrefOf(lc.templates, own.kind, own.ref);
  const name = KIND_NAME[own.kind] ?? own.kind;
  const label = own.kind === "gcp" ? `${name} #${own.ref}` : own.kind === "feishu-task" ? `${name}「${state.title}」` : `${name} ${own.ref}`;
  return { label, href };
}

/** What a person calls a thing that is read, by the name of the tool that reads it; an unknown tool shows its own name. */
const TOOL_NAME = { "feishu-task": "飞书任务", "http-json": "网页数据" };

/**
 * The names of the reading tools: what the tool's own second line says (`// label: 外网版本`), else the plain name above,
 * else its own name. A tool whose label is the name of the kind of link the affair itself has (易协作) and that read that
 * very thing is named with its number and opens its address.
 */
export function namesOf(policy, state, lc) {
  const labels = new Map(listReaders(policy).map((r) => [r.name, r.label]));
  const toolName = (tool) => labels.get(tool) || TOOL_NAME[tool] || tool;
  const own = parseLink(primaryLink(state));
  const labelOf = (tool, args) => {
    const name = toolName(tool);
    const ref = String(args?.id ?? args?.itemNo ?? "");
    if (own && ref && ref === own.ref && name === KIND_NAME[own.kind] && hrefOf(lc.templates, own.kind, own.ref)) return { name: `${name} #${ref}`, kind: own.kind, ref };
    return { name };
  };
  return { toolName, labelOf };
}

const shortWhen = (atIso, now, tz) => (atIso ? stamp(atIso, now, tz) : "");

/** What a source says about what it read: the first CLIP_CHARS characters, and the whole text (up to FULL_CHARS) to open when it is longer. A reading can be a long title or a long list; the panel does not grow with it. */
function shown(summary) {
  const text = String(summary ?? "").replace(/\s+/g, " ").trim();
  const status = clip(text, CLIP_CHARS);
  return status === text ? { status } : { status, full: clip(text, FULL_CHARS) };
}

/**
 * What the affair stands on: its own link first, then what is watched (with the value it has now), then the other things
 * it names (a ticket, a revision) and the other things it has read. Each is one line; a reference with an address can be opened.
 */
export function sourcesOf(state, now, policy, lc) {
  const { toolName } = namesOf(policy, state, lc);
  const out = [];
  const seen = new Set();
  const add = (item) => {
    const key = item.href || `${item.label}|${item.status ?? ""}`;
    if (seen.has(key) || (item.href && out.some((o) => o.href === item.href))) return;
    seen.add(key);
    out.push(item);
  };
  const main = mainSource(state, lc);
  if (main) add({ label: main.label, status: state.status === "done" ? "办完了" : state.status === "stopped" ? "不盯了" : "", at: "", href: main.href });
  for (const w of Object.values(state.watches ?? {})) {
    const label = w.label || toolName(w.tool);
    add({ label, ...(w.lastError ? { status: "读不到", full: clip(String(w.lastError), FULL_CHARS), tone: "bad" } : shown(w.summary)), at: shortWhen(w.readAt, now, policy.tz), href: null });
  }
  // The references in what is remembered and said: each once, newest wording kept.
  const texts = [...(state.facts ?? []), state.nowText ?? ""];
  for (const text of texts) {
    for (const seg of linkify(text, lc)) if (seg.href) add({ label: seg.text, status: "", at: "", href: seg.href });
  }
  // Things read once (not watched), newest of each tool and arguments.
  const newest = new Map();
  for (const r of state.reads ?? []) if (r.ok) newest.set(`${r.tool}|${JSON.stringify(r.args)}`, r);
  for (const r of [...newest.values()].reverse()) add({ label: toolName(r.tool), ...shown(r.summary), at: shortWhen(r.at, now, policy.tz), href: null });
  return { items: out.slice(0, SOURCES_SHOWN), more: Math.max(0, out.length - SOURCES_SHOWN) };
}

/** "43 KB", "1.2 MB". */
const sizeText = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** The time the folder put in front of a name when he sent it (20261103-111416-), as 11:14, or "". */
const prefixTime = (name) => {
  const m = /^\d{8}-(\d{2})(\d{2})\d{2}-/.exec(name);
  return m ? `${Number(m[1])}:${m[2]}` : "";
};

/** What is in the affair's files/ folder: only what is really there. Pictures he typed into the conversation are not kept there, so they are not here. */
export function materialsOf(root, state, now, policy) {
  const dir = path.join(root, state.id, "files");
  if (!existsSync(dir)) return { items: [], more: 0 };
  const sent = new Set(sentOf(state).map((a) => path.resolve(a.path).toLowerCase()));
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const file = path.join(dir, d.name);
      const stat = statSync(file);
      return { name: d.name, file, size: stat.size, ms: stat.mtimeMs, you: sent.has(path.resolve(file).toLowerCase()) };
    })
    .sort((a, b) => b.ms - a.ms);
  const count = new Map();
  for (const f of files) count.set(shownName(f.name), (count.get(shownName(f.name)) ?? 0) + 1);
  const items = files.slice(0, MATERIALS_SHOWN).map((f) => {
    const name = shownName(f.name);
    const when = count.get(name) > 1 ? prefixTime(f.name) : "";
    const kind = kindOf(f.file);
    return {
      name: f.name,
      shown: when ? `${name} · ${when}` : name,
      who: f.you ? "你发的" : "整理的",
      at: now - f.ms < 60 * 60_000 ? whenOf(f.ms, now, policy.tz) : stamp(new Date(f.ms).toISOString(), now, policy.tz),
      size: sizeText(f.size),
      kind,
      ext: extOf(f.name).toUpperCase().slice(0, 4),
      thumb: kind === "image" && f.size <= PICTURE_BYTES,
      // a thumbnail is fetched once per file as it stands: the same size and time are the same picture
      version: `${f.size}-${Math.round(f.ms)}`,
      path: slashed(f.file),
    };
  });
  return { items, more: Math.max(0, files.length - MATERIALS_SHOWN) };
}

const withParts = (text, lc) => {
  const parts = partsOf(text, lc);
  return parts ? { text, parts } : { text };
};

/** The one word for how the affair stands, for the colour of its dot: waiting for him, trouble, held (out of looks today), watching, done, or not watched any more. */
export function moodOf(state, asked, trouble, held) {
  if (state.status === "done") return "done";
  if (state.status !== "watching") return "stopped";
  if (asked || state.system) return "ask";
  if (trouble) return "error";
  return held ? "paused" : "watching";
}

/** A run stays on the panel this long after it ended. */
const FLOW_SHOWN_MS = 24 * 3_600_000;

/**
 * The block above the "现在": the latest run started for this affair while it is on, and for a day after it ended. What it is
 * doing now comes from what the plugin last saw of it (`flowNow`); without that, from the steps the log holds.
 */
export function flowBlockOf(state, now, flowNow = new Map()) {
  const runs = (state.flows ?? []).filter((f) => !f.failed);
  const latest = runs[runs.length - 1];
  if (!latest) return null;
  const st = flowNow.get(latest.runId)?.st ?? null;
  const sent = sentenceOf(latest, st, now);
  const ended = latest.endedAt ? Date.parse(latest.endedAt) : 0;
  if (sent.over && now - (ended || Date.parse(latest.at)) > FLOW_SHOWN_MS) return null;
  const took = spanText((sent.over && ended ? ended : now) - Date.parse(latest.at));
  const cost = usdText(sent.over ? latest.costUsd : st?.costUsd);
  const late = sent.over ? endedAfterNow(state) : null;
  const stop = st ?? { state: latest.outcome ? "ended" : "", outcome: latest.outcome, resume: latest.resume };
  const again = canResume(stop) && sameSpotAgain(runs, latest, stop);
  return {
    name: latest.flow,
    ...(latest.trial ? { trial: true } : {}),
    text: sent.short,
    detail: sent.rest,
    tone: sent.tone === "red" ? "red" : "normal",
    meta: [took, cost].filter(Boolean).join(" · "),
    note: again ? SAME_SPOT_TEXT : "",
    action: canResume(stop) && !again ? { kind: "resume", runId: latest.runId, expect: stop.resume.print, spends: stop.resume.spends } : sent.waiting && sent.agentId ? { kind: "approve", agentId: sent.agentId } : { kind: "detail", runId: latest.runId },
    more: runs.length - 1,
    // The "现在" is written by a look; until it has read the result it still says what was before.
    stale: late ? (state.running ? "「现在」正在按结果更新" : "「现在」还是流程结束之前的，下一次看一眼会更新") : "",
  };
}

/** Attach numbered facts before limiting or presenting the remaining notes. Ranges belong to their first step. */
export function progressOf(state, policy, lc) {
  const list = stepsOf(state, policy).map(({ title, state, who, note }) => ({ title, state, who, ...(note ? { note } : {}), notes: [] }));
  const synthetic = !list.length;
  const facts = [];
  for (const fact of state.facts ?? []) {
    const text = String(fact);
    const match = /^第\s*(\d+(?:\s*[、,，–—\-至]\s*\d+)*)\s*步/.exec(text);
    const numbers = match ? (/[–—\-至]/.test(match[1]) ? [Number(match[1].match(/\d+/)[0])] : match[1].match(/\d+/g).map(Number)) : [];
    const targets = [...new Set(numbers)].filter((n) => n > 0 && (synthetic || n <= list.length));
    if (!targets.length) { facts.push(withParts(text, lc)); continue; }
    for (const n of targets) {
      if (synthetic && !list.some((s) => s.number === n)) list.push({ title: `第 ${n} 步`, number: n, state: ["done", "stopped"].includes(state.status) ? "done" : "todo", who: "agent", notes: [] });
      (synthetic ? list.find((s) => s.number === n) : list[n - 1]).notes.push(withParts(text, lc));
    }
  }
  return { stepList: list, facts };
}

export function panelOf(root, state, now, policy, lc, { trouble = "", budget = "", flowNow = new Map(), sessions = /** @type {any[]} */ ([]) } = {}) {
  const card = cardOf(state, now, policy, { budget, trouble });
  const { labelOf } = namesOf(policy, state, lc);
  const happened = eventsOf(state, now, policy, lc, { labelOf, fileAt: (name) => { const f = fileIn(root, state.id, name); return f ? slashed(f) : null; } });
  const spent = counts(root, now, policy).per[state.id]?.usd ?? 0;
  const asks = (state.asks ?? []).filter((a) => a.state === "open");
  const drive = modeOf(state, policy) === "drive";
  const costs = drive ? budgetOf({ flowNow }, state) : undefined;
  return {
    id: state.id,
    title: state.title,
    mode: modeText(state, policy),
    steps: stepLines(state, now, policy).filter((l) => l && !l.startsWith("##")),
    ...progressOf(state, policy, lc),
    ...(costs ? { budget: costs } : {}),
    sessions: sessionsOf(state, sessions),
    open: card.open,
    mood: moodOf(state, asks.length > 0, Boolean(trouble), Boolean(budget)),
    asks: asks.map((a) => ({ id: a.id, title: a.title, line: a.line, options: a.options })),
    flow: flowBlockOf(state, now, flowNow),
    waiting: withParts(card.waiting, lc),
    now: withParts(card.now, lc),
    next: withParts(modeOf(state, policy) === "drive" ? "" : card.next, lc),
    spent: drive ? budgetText({ policy, flowNow, now: () => now }, state, costs) : spent > 0 ? `今天花了 $${spent.toFixed(2)}` : "",
    events: { total: happened.total, items: happened.items.map((e) => ({ ...e, ...withParts(e.text, lc) })) },
    sources: sourcesOf(state, now, policy, lc),
    materials: materialsOf(root, state, now, policy),
  };
}

export function sessionsOf(state, snapshots) {
  const activity = (a) => Math.max(...[a.updatedAt, a.lastUserMessageAt, a.createdAt].map((t) => Date.parse(t) || 0));
  return snapshots.filter(({ agent: a }) => a.id === state.chatId || a.labels?.["affairs.affair"] === state.id)
    .sort((a, b) => activity(b.agent) - activity(a.agent)).map(({ agent: a, project }) => ({
      agentId: a.id, title: a.title || state.title,
      role: a.id === state.chatId || a.labels?.["affairs.chat"] ? "主对话" : a.labels?.["affairs.role"] === "dispatched" ? "派活" : "流程",
      status: a.pendingPermissions?.length ? "等你批" : a.archivedAt || ["closed", "error"].includes(a.status) ? "已关闭" : ["running", "initializing"].includes(a.status) ? "干活中" : "做完了",
      project: project?.projectName || "",
      ...(Number.isFinite(a.lastUsage?.totalCostUsd) ? { usd: a.lastUsage.totalCostUsd } : {}),
    }));
}
