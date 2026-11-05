import path from "node:path";
import { createHash } from "node:crypto";
import { hrefOf } from "./links.mjs";
import { clip } from "./clip.mjs";
import { attachSummary } from "./view.mjs";
import { localParts, speak } from "./time.mjs";

// What happened to an affair, as rows a person reads: worked out from its log alone, the same way each time, so the screen
// only draws them. A row says who did it (the dot, in the screen), what it was (the small title), and the result in one
// sentence. Nothing here says 叫醒, 校验, 记录, 计划, 读数, 会话 or agent (a test holds the words to that).

export const EVENTS_SHOWN = 50;
const SAME_SENTENCE = 60;

const pad = (n) => String(n).padStart(2, "0");
const WEEK = "日一二三四五六";

/** The same value however its keys were ordered or how the number was written. */
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const fingerprint = (value) => createHash("sha1").update(JSON.stringify(canon(value ?? null))).digest("hex").slice(0, 12);

/**
 * What a reading is "of": the tool and the one argument that says which thing (a ticket number, a revision, a reference),
 * written as text so 996915 and "996915" are the same thing. The other arguments (what to read of it) do not count.
 */
export const sourceKey = (tool, args) => `${tool}|${String(args?.id ?? args?.itemNo ?? args?.ref ?? args?.revision ?? "")}`;

const clock = (ms, tz) => {
  const p = localParts(ms, tz);
  return `${p.h}:${pad(p.mi)}`;
};

/** "刚刚", "25 分钟前" within the hour; the clock time (9:00) after that. */
export function whenOf(ms, now, tz) {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "刚刚";
  return minutes < 60 ? `${minutes} 分钟前` : clock(ms, tz);
}

/** The whole time, to the second, with the weekday: "11-03 周二 16:00:48". */
export function fullTime(ms, tz) {
  const p = localParts(ms, tz);
  return `${pad(p.mo)}-${pad(p.d)} 周${WEEK[p.dow]} ${pad(p.h)}:${pad(p.mi)}:${pad(Math.floor(ms / 1000) % 60)}`;
}

/** The heading of the day a row is under: "今天 · 11-04 周三", "昨天 · 11-03 周二", "11-01 周日". */
export function dayOf(ms, now, tz) {
  const p = localParts(ms, tz);
  const t = localParts(now, tz);
  const diff = Math.round((Date.UTC(t.y, t.mo - 1, t.d) - Date.UTC(p.y, p.mo - 1, p.d)) / 86_400_000);
  const base = `${pad(p.mo)}-${pad(p.d)} 周${WEEK[p.dow]}`;
  return diff === 0 ? `今天 · ${base}` : diff === 1 ? `昨天 · ${base}` : base;
}

/** The day in front of a time that is not today's: "昨天 ", "11-02 ", or nothing. */
function dayWord(ms, now, tz) {
  const p = localParts(ms, tz);
  const t = localParts(now, tz);
  const diff = Math.round((Date.UTC(t.y, t.mo - 1, t.d) - Date.UTC(p.y, p.mo - 1, p.d)) / 86_400_000);
  return diff <= 0 ? "" : diff === 1 ? "昨天 " : `${pad(p.mo)}-${pad(p.d)} `;
}

const md = (ms, tz) => {
  const p = localParts(ms, tz);
  return `${pad(p.mo)}-${pad(p.d)}`;
};

/** The old way of writing a look began "我看了一眼："; the title says that now. */
export const withoutLead = (entry) => String(entry ?? "").replace(/^\s*我看了一眼\s*[：:]\s*/, "").trim();

const shortAttach = (list) => attachSummary(list).replace(/：.*$/, "");

/** What the file is called without the time the folder put in front of it when he sent it. */
export const shownName = (name) => String(name).replace(/^\d{8}-\d{6}-/, "");

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** What a failure is called to a person, by the kind it was. The text a machine wrote is not shown. */
const TROUBLE = {
  chain: null,
  look: "这次没看成，过一会儿会再试",
  "first-look": "第一次没看成",
  breaker: "看得太频繁，先停着了",
  schedule: "下次的时间没排上",
  setup: "没建成",
  config: "还有几处要补",
};

/**
 * The rows of an affair, newest first, at most EVENTS_SHOWN.
 * @param {any} state the folded state with its `lines`
 * @param {number} now
 * @param {any} policy
 * @param {any} lc
 * @param {{ labelOf: (tool: string, args: any) => { name: string, kind?: string, ref?: string }, fileAt?: (name: string) => string | null }} helpers (`fileAt`: where a file of the affair's folder is, or null when it is not there)
 * @returns {{ items: any[], total: number }}
 */
export function eventsOf(state, now, policy, lc, helpers) {
  const { labelOf, fileAt = () => null } = helpers;
  const tz = policy.tz;
  const lines = state.lines ?? [];
  const saidBy = new Map((state.said ?? []).map((m) => [m.seq, m]));
  const askBy = new Map((state.asks ?? []).map((a) => [a.id, a]));
  const firstSaid = (state.said ?? []).find((m) => m.by === "user")?.seq ?? -1;
  const firstReport = lines.find((l) => l.kind === "report" && l.from !== "chat" && l.verdict !== "rejected" && l.entry);

  /** @type {any[]} chronological, merged later */
  const out = [];
  const lastValue = new Map(); // source key -> fingerprint of the last reading
  const watching = new Map(); // watch id -> its tool and label
  const flowRows = new Map(); // run id -> its row
  let wake = null; // the look in progress: what it was called for, what it read, its next time
  let lastError = null;

  const nextWords = (l) => `${speak(Date.parse(l.next), now, tz)}${l.why ? ` · ${clip(String(l.why), 40)}` : ""}`;

  const add = (l, e) => {
    const ms = Date.parse(l.at);
    const row = { key: `e${l.seq}`, at: l.at, ms, kind: "", label: "", sub: "", text: "", bubble: false, calm: false, strong: false, tone: "normal", changed: false, yours: false, files: [], ...e };
    out.push(row);
    return row;
  };

  const trouble = (l, what, text) => {
    // One failed look writes two lines (the end of the look and the note on it); that is one row.
    if (lastError && lastError.what === what && Date.parse(l.at) - lastError.ms < 120_000) return;
    lastError = { what, ms: Date.parse(l.at) };
    return add(l, { kind: "error", label: "出错", text, tone: "red", errorKey: what });
  };
  // A look that could not be asked for and is then started anyway (a moment later) did not fail: its note is taken back.
  let unasked = null;

  for (const l of lines) {
    switch (l.kind) {
      case "wake":
        wake = { why: Array.isArray(l.why) ? l.why : [], reads: [], next: null };
        if (unasked && Date.parse(l.at) - unasked.ms < 120_000) {
          out.splice(out.indexOf(unasked.row), 1);
          lastError = null;
        }
        unasked = null;
        break;
      case "wake.end":
        if (l.state === "failed") trouble(l, "look", TROUBLE.look);
        wake = null;
        break;
      case "watch":
        if (!l.drop && l.watch) watching.set(l.id, { tool: l.watch.tool, label: l.watch.label, args: l.watch.args ?? {} });
        break;
      case "read": {
        if (l.ok === false) {
          const name = labelOf(l.tool, l.args).name;
          trouble(l, `read:${sourceKey(l.tool, l.args)}`, `${name}读不到：${clip(l.reason ?? "", 40)}`);
          break;
        }
        const key = sourceKey(l.tool, l.args);
        const fp = fingerprint(l.value);
        const before = lastValue.get(key);
        lastValue.set(key, fp);
        if (wake) wake.reads.push({ tool: l.tool, args: l.args ?? {}, summary: String(l.summary ?? ""), seen: before === undefined ? "new" : before === fp ? "same" : "changed" });
        break;
      }
      case "watch.read": {
        const w = watching.get(l.id);
        const name = labelOf(w?.tool ?? "", w?.args ?? {}).name || w?.label || "数据";
        if (l.expired || l.reset) break;
        if (l.ok === false) {
          trouble(l, `down:${l.id}`, `${name}读不到：${clip(l.reason ?? "", 40)}`);
          break;
        }
        const key = `watch:${l.id}`;
        const was = lastValue.get(key);
        lastValue.set(key, l.hash ?? fingerprint(l.value));
        // A reading that says what it said before is not news; the first and every change are.
        if (was === undefined || was !== (l.hash ?? fingerprint(l.value))) add(l, { kind: "read", label: `读到 · ${name}`, sub: was === undefined ? "" : "有变化", text: clip(String(l.summary ?? ""), SAME_SENTENCE), changed: was !== undefined });
        break;
      }
      case "next": {
        if (typeof l.next !== "string" || Number.isNaN(Date.parse(l.next))) break;
        // The look hands in its sentence and then its next time: the row it made takes the time when it comes.
        if (wake && l.source === "look") {
          wake.next = l;
          if (wake.row) Object.assign(wake.row, { nextSeq: l.seq, basis: { ...wake.row.basis, next: nextWords(l) } });
        }
        const to = Date.parse(l.next);
        if (l.verdict === "appeal") {
          const cut = (state.deadlines ?? []).filter((d) => Date.parse(d.at) > Date.parse(l.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
          const was = cut ? md(Date.parse(cut.at), tz) : "";
          add(l, { kind: "next", label: `下次改到 ${md(to, tz)}`, sub: was ? `比单子上的 ${was} 晚` : "", text: String(l.detail ?? l.why ?? ""), meta: was ? `不对就说「改回 ${was}」` : "", tone: "warn", changed: true });
        } else if (l.source === "user" || l.source === "chat") {
          const held = l.why === "你说先放一放";
          add(l, { kind: "next", label: held ? `先放到 ${md(to, tz)}` : `下次改到 ${md(to, tz)}`, text: held ? "" : String(l.why ?? ""), yours: false });
        }
        break;
      }
      case "report": {
        if (l.verdict === "rejected" || typeof l.entry !== "string" || !l.entry.trim()) break;
        if (l.from === "chat") {
          add(l, { kind: "reply", label: "回你", text: l.entry.trim(), strong: false });
          break;
        }
        const reads = wake?.reads ?? [];
        const compared = reads.filter((r) => r.seen !== "new");
        const fresh = reads.length - compared.length;
        const first = firstReport === l;
        // Whether it changed is worked out from what was read, never from what the look says about itself (it says "changed"
        // by habit). A look that read nothing, or only things it had not read before, has no answer.
        let changed = null;
        if (!first) {
          if (compared.some((r) => r.seen === "changed")) changed = true;
          else if (compared.length > 0 && fresh === 0) changed = false;
        }
        const calledBy = (wake?.why ?? []).map((w) => /^said:(\d+)$/.exec(w)).filter(Boolean).map((m) => Number(m[1])).filter((n) => n !== firstSaid && saidBy.has(n));
        const asked = calledBy.length ? saidBy.get(calledBy[calledBy.length - 1]) : null;
        const verdict = first ? "第一次" : changed === true ? "有变化" : changed === false ? "没变化" : "";
        const names = reads.map((r) => labelOf(r.tool, r.args));
        const row = add(l, {
          kind: "look",
          label: "看了一眼",
          sub: [asked ? "你问了一句" : "", verdict].filter(Boolean).join(" · "),
          text: withoutLead(l.entry),
          strong: first || changed === true,
          calm: changed === false,
          changed: first || changed === true,
          noChange: !first && changed === false,
          basis: {
            rows: reads.map((r, i) => {
              const href = names[i].kind && names[i].ref ? hrefOf(lc.templates, names[i].kind, names[i].ref) : null;
              return { name: names[i].name, ...(href ? { href } : {}), text: clip(r.summary.replace(/\s+/g, " ").trim(), 120), state: r.seen };
            }),
            ...(wake?.next ? { next: nextWords(wake.next) } : {}),
            ...(asked ? { asked: clip(asked.text, 80) } : {}),
          },
          nextSeq: wake?.next?.seq ?? null,
        });
        if (wake) wake.row = row;
        break;
      }
      case "said": {
        const m = saidBy.get(l.seq);
        if (!m || m.undone || m.by !== "user") break;
        const list = m.attachments ?? [];
        add(l, {
          kind: "said",
          label: "你",
          sub: list.length ? shortAttach(list) : l.seq === firstSaid ? "交代了这件事" : "",
          text: String(l.text ?? "").trim(),
          bubble: true,
          yours: true,
          files: list.map((a) => path.basename(a.path)).flatMap((n) => { const at = fileAt(n); return at ? [{ name: n, shown: shownName(n), image: IMAGE.test(n), path: at }] : []; }),
        });
        break;
      }
      case "answered": {
        const q = askBy.get(String(l.id));
        add(l, { kind: "answered", label: "你", sub: `答了「${clip(String(l.answer ?? ""), 14)}」`, text: "", meta: q ? `问的是：${clip(q.title, 60)}` : "", yours: true });
        break;
      }
      case "asked": {
        const q = askBy.get(String(l.id));
        if (!q || q.state !== "open") break;
        add(l, { kind: "asked", label: "要你定", text: q.title, strong: true, changed: true });
        break;
      }
      case "note":
        if (l.by === "chat" && typeof l.text === "string") add(l, { kind: "note", label: "记下", text: l.text });
        break;
      case "status": {
        if (l.status === "done") add(l, { kind: "done", label: "办完了 ✓", text: String(l.evidence ?? ""), strong: true, changed: true });
        else if (l.status === "stopped") add(l, { kind: "stopped", label: "不盯了", text: l.by === "system" ? String(l.evidence ?? "") : "" });
        else if (l.status === "watching" && l.seq > 1) add(l, { kind: "resumed", label: "接着盯", text: "" });
        break;
      }
      case "flow": {
        // A flow he had started: one row, with the words that asked for it. One the runtime turned away at once never started.
        if (state.flows?.find((f) => f.seq === l.seq)?.failed) break;
        const asked = Number.isInteger(l.said) ? saidBy.get(l.said) : null;
        const began = asked ? `起了（你说：「${clip(String(asked.text).replace(/\s+/g, " ").trim(), 40)}」）` : "起了";
        // One row for the whole run; its steps are under it. The row says how it stands: the latest step.
        const row = add(l, { kind: "flow", label: `流程 · ${l.flow}`, text: "在跑", kids: [{ ms: Date.parse(l.at), text: began }] });
        flowRows.set(l.runId, row);
        break;
      }
      case "flow.mark": {
        const row = flowRows.get(l.runId);
        if (!row || row.kids.some((k) => k.key === l.key)) break;
        row.kids.push({ ms: Date.parse(l.at), text: String(l.text ?? ""), key: l.key });
        row.text = String(l.text ?? "");
        row.tone = l.tone === "red" ? "red" : "normal";
        row.changed = true;
        if (l.key === "end") row.strong = true;
        break;
      }
      case "flag": {
        if (l.what === "chain") trouble(l, "chain", String(l.detail ?? ""));
        else if (TROUBLE[l.what]) {
          const row = trouble(l, l.what, TROUBLE[l.what]);
          unasked = row && (l.what === "look" || l.what === "first-look") ? { row, ms: Date.parse(l.at) } : null;
        }
        break;
      }
      default:
        break;
    }
  }

  // Joining what repeats: looks that saw nothing new, one after another (nothing of his in between), are one row; so are
  // the same failure again and again.
  const rows = [];
  for (const e of out) {
    const prev = rows[rows.length - 1];
    if (prev && e.kind === "look" && e.noChange && prev.kind === "look" && prev.noChange) {
      if (prev.group !== "looks") rows[rows.length - 1] = joined(prev, "looks");
      absorb(rows[rows.length - 1], e);
    } else if (prev && e.kind === "error" && prev.kind === "error" && prev.errorKey === e.errorKey) {
      if (prev.group !== "errors") rows[rows.length - 1] = joined(prev, "errors");
      absorb(rows[rows.length - 1], e);
    } else rows.push(e);
  }

  const items = rows.reverse().slice(0, EVENTS_SHOWN).map((e) => finish(e, state, now, tz));
  return { items, total: rows.length };
}

function joined(first, group) {
  return { ...first, group, members: [first], count: 1 };
}

function absorb(row, e) {
  row.members.push(e);
  row.count = row.members.length;
  Object.assign(row, { text: e.text, basis: e.basis, nextSeq: e.nextSeq, at: e.at, ms: e.ms, endMs: e.ms });
}

/** The row as the screen gets it: the words, the time, no working-out left in it. */
function finish(e, state, now, tz) {
  const ownNext = state.next && e.nextSeq !== undefined && e.nextSeq === state.next.seq && state.status === "watching" ? `下次 ${speak(Date.parse(state.next.at), now, tz)}` : "";
  const merged = e.group;
  const firstMs = merged ? e.members[0].ms : e.ms;
  const label = merged === "looks" ? `看了 ${e.count} 次` : e.label;
  const sub = merged === "looks" ? "都没变化" : merged === "errors" ? `连着 ${e.count} 次` : e.sub;
  // a range that began on an earlier day says which
  const began = localParts(firstMs, tz).date === localParts(e.ms, tz).date ? "" : dayWord(firstMs, now, tz);
  const when = merged ? `${began}${clock(firstMs, tz)}–${clock(e.ms, tz)}` : whenOf(e.ms, now, tz);
  const row = {
    key: `e${merged ? e.members[0].key.slice(1) : e.key.slice(1)}`,
    kind: e.kind,
    label,
    sub,
    text: e.text,
    bubble: e.bubble,
    calm: e.calm,
    strong: e.strong,
    tone: e.tone,
    changed: e.members ? e.members.some((m) => m.changed) : e.changed,
    yours: e.yours,
    day: dayOf(e.ms, now, tz),
    when,
    whenFull: fullTime(e.ms, tz),
    files: e.files,
  };
  if (e.meta) row.meta = e.meta;
  if (e.basis) row.basis = e.basis;
  if (ownNext) row.next = ownNext;
  if (e.kids) row.children = e.kids.map((k) => ({ when: whenOf(k.ms, now, tz), text: k.text }));
  if (merged) row.children = [...e.members].reverse().map((m) => ({ when: whenOf(m.ms, now, tz), text: m.text }));
  return row;
}
