import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { hrefOf, linkify, parseLink, partsOf } from "./links.mjs";
import { cardOf, rowsOf, sentOf, stamp } from "./view.mjs";

// What the "进展" panel beside an affair's conversation shows: three blocks (now, sources, materials), all drawn from the
// affair's log and its files/ folder, nothing remembered anywhere else. The words are what a person reads: none of
// 叫醒, 校验, 记录, 计划, 读数, 会话, agent (a test holds it to that).

export const SOURCES_SHOWN = 6;
export const MATERIALS_SHOWN = 5;
export const RECENT_ROWS = 10;
const FACTS_SHOWN = 12;

/** How a link kind is named to a person. */
const KIND_NAME = { gcp: "易协作", "feishu-task": "飞书任务", doc: "文档", svn: "提交" };

/** @returns {{ label: string, href: string | null } | null} the affair's own link, as one source */
function mainSource(state, lc) {
  const own = parseLink(state.link);
  if (!own) return null;
  const href = hrefOf(lc.templates, own.kind, own.ref);
  const name = KIND_NAME[own.kind] ?? own.kind;
  const label = own.kind === "gcp" ? `${name} #${own.ref}` : own.kind === "feishu-task" ? `${name}「${state.title}」` : `${name} ${own.ref}`;
  return { label, href };
}

/** What a person calls a thing that is read, by the name of the tool that reads it; an unknown tool shows its own name. */
const TOOL_NAME = { "feishu-task": "飞书任务", "http-json": "网页数据" };
const toolName = (tool) => TOOL_NAME[tool] ?? tool;

const shortWhen = (atIso, now, tz) => (atIso ? stamp(atIso, now, tz) : "");

/**
 * What the affair stands on: its own link first, then what is watched (with the value it has now), then the other things
 * it names (a ticket, a revision) and the other things it has read. Each is one line; a reference with an address can be opened.
 */
export function sourcesOf(state, now, policy, lc) {
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
    add({ label, status: w.lastError ? "读不到" : String(w.summary ?? "").slice(0, 60), at: shortWhen(w.readAt, now, policy.tz), href: null });
  }
  // The references in what is remembered and said: each once, newest wording kept.
  const texts = [...(state.facts ?? []), state.nowText ?? ""];
  for (const text of texts) {
    for (const seg of linkify(text, lc)) if (seg.href) add({ label: seg.text, status: "", at: "", href: seg.href });
  }
  // Things read once (not watched), newest of each tool and arguments.
  const newest = new Map();
  for (const r of state.reads ?? []) if (r.ok) newest.set(`${r.tool}|${JSON.stringify(r.args)}`, r);
  for (const r of [...newest.values()].reverse()) add({ label: toolName(r.tool), status: String(r.summary ?? "").slice(0, 60), at: shortWhen(r.at, now, policy.tz), href: null });
  return { items: out.slice(0, SOURCES_SHOWN), more: Math.max(0, out.length - SOURCES_SHOWN) };
}

/** What is in the affair's files/ folder: only what is really there. Pictures he typed into the conversation are not kept there, so they are not here. */
export function materialsOf(root, state, now, policy) {
  const dir = path.join(root, state.id, "files");
  if (!existsSync(dir)) return { items: [], more: 0 };
  const sent = new Set(sentOf(state).map((a) => path.resolve(a.path).toLowerCase()));
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const file = path.join(dir, d.name);
      const at = statSync(file).mtimeMs;
      return { name: d.name, who: sent.has(path.resolve(file).toLowerCase()) ? "你发的" : "整理的", at: stamp(new Date(at).toISOString(), now, policy.tz), ms: at };
    })
    .sort((a, b) => b.ms - a.ms);
  return { items: files.slice(0, MATERIALS_SHOWN).map(({ ms, ...rest }) => rest), more: Math.max(0, files.length - MATERIALS_SHOWN) };
}

const withParts = (text, lc) => {
  const parts = partsOf(text, lc);
  return parts ? { text, parts } : { text };
};

/** The whole panel for one affair. */
export function panelOf(root, state, now, policy, lc, { trouble = "", budget = "" } = {}) {
  const card = cardOf(state, now, policy, { budget, trouble });
  const rows = rowsOf(state, now, policy);
  const asks = (state.asks ?? []).filter((a) => a.state === "open");
  return {
    id: state.id,
    title: state.title,
    open: card.open,
    asks: asks.map((a) => ({ id: a.id, title: a.title, line: a.line, options: a.options })),
    waiting: withParts(card.waiting, lc),
    now: withParts(card.now, lc),
    next: withParts(card.next, lc),
    recent: rows.slice(-RECENT_ROWS).map((r) => ({ key: r.key, ...withParts(r.text, lc), tone: r.tone === "red" ? "red" : "normal" })),
    facts: (state.facts ?? []).slice(0, FACTS_SHOWN).map((f) => withParts(String(f), lc)),
    sources: sourcesOf(state, now, policy, lc),
    materials: materialsOf(root, state, now, policy),
  };
}
