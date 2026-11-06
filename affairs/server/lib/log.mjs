import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { stepFields } from "./steps.mjs";
import { isoLocal } from "./time.mjs";
import { normalizedLink } from "./links.mjs";

// One log.jsonl per affair, append only: nothing here opens it for writing from the start. The commands and the plugin
// both write through append(), under a lock directory, and the plugin watches the root: the log is the only interface.

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const affairDir = (root, id) => path.join(root, id);
export const logFile = (root, id) => path.join(affairDir(root, id), "log.jsonl");
export const ID = /^(?:D\d{1,6}|\d{3,9}|[a-z][a-z0-9-]{1,39})$/;

function withLock(dir, fn) {
  const lock = path.join(dir, ".lock");
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      // Windows answers EPERM/EBUSY, not EEXIST, while the other writer's lock directory is being deleted.
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // released between the two calls
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`log is locked: ${lock}`);
      sleep(15);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
}

// Every line carries the plugin-written `seq` and `prev`: a short hash of the line before it, as it stands in the file.
// Whoever appends a line by hand does not know the hash of the one before, so a line added around the commands shows as a
// break in the chain. This is a smoke alarm, not a lock: a writer that works out the hash is not stopped by it.
export const hashOf = (raw) => createHash("sha1").update(raw).digest("hex").slice(0, 8);

/**
 * Lines of `text` in order. `previous` is the raw text of the line before the first one, or null at the top of the file.
 * A line whose `prev` is not the hash of the raw line before it is marked `__broken` (only the first such line is).
 */
function parseLines(text, previous, alreadyBroken) {
  const lines = [];
  let prevRaw = previous;
  let broken = alreadyBroken;
  for (const raw0 of text.split("\n")) {
    const raw = raw0.replace(/\r$/, "");
    if (!raw.trim()) continue;
    let line = null;
    try {
      line = JSON.parse(raw);
    } catch {
      // a half-written line is skipped, never repaired
    }
    if (line && Number.isInteger(line.seq) && typeof line.kind === "string") {
      if (prevRaw !== null && line.prev !== hashOf(prevRaw) && !broken) {
        broken = true;
        Object.defineProperty(line, "__broken", { value: true, enumerable: false });
      }
      lines.push(line);
    }
    prevRaw = raw;
  }
  return { lines, lastRaw: prevRaw, broken };
}

// What was read of each log so far: a log only grows, so a pass over it parses only what was added since.
const cache = new Map();

/** @returns {any[]} */
export function read(root, id) {
  const file = logFile(root, id);
  let size;
  let mtimeMs;
  try {
    ({ size, mtimeMs } = statSync(file));
  } catch {
    cache.delete(file);
    return [];
  }
  let c = cache.get(file);
  if (c && c.size === size && c.mtimeMs === mtimeMs) return c.lines;
  // Shorter, or the same length but touched: it was not only added to; read it again from the top.
  if (!c || size < c.offset || (size === c.size && mtimeMs !== c.mtimeMs)) c = { offset: 0, lines: [], lastRaw: null, broken: false, size: 0, mtimeMs: 0 };
  const fd = openSync(file, "r");
  let buf;
  try {
    buf = Buffer.alloc(size - c.offset);
    readSync(fd, buf, 0, buf.length, c.offset);
  } finally {
    closeSync(fd);
  }
  const cut = buf.lastIndexOf(0x0a) + 1;
  const whole = parseLines(buf.subarray(0, cut).toString("utf8"), c.lastRaw, c.broken);
  Object.assign(c, { offset: c.offset + cut, size, mtimeMs, lastRaw: whole.lastRaw, broken: whole.broken });
  c.lines = c.lines.concat(whole.lines);
  cache.set(file, c);
  if (cut === buf.length) return c.lines;
  // A last line without its newline yet: seen if it is whole, not kept.
  const tail = parseLines(buf.subarray(cut).toString("utf8"), c.lastRaw, c.broken);
  return c.lines.concat(tail.lines);
}

/** Appends entries ({ kind, ...fields }) and returns them with seq, at and prev. */
export function append(root, id, entries, { now = Date.now(), tz = "Asia/Shanghai" } = {}) {
  const dir = affairDir(root, id);
  mkdirSync(dir, { recursive: true });
  return withLock(dir, () => {
    const file = logFile(root, id);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const parsed = parseLines(text, null, false);
    let seq = parsed.lines.reduce((max, l) => Math.max(max, l.seq), 0);
    let prevRaw = parsed.lastRaw;
    const lines = [];
    const raws = [];
    for (const entry of entries) {
      const line = { ...entry, seq: ++seq, at: isoLocal(now, tz), ...(prevRaw === null ? {} : { prev: hashOf(prevRaw) }) };
      const raw = JSON.stringify(line);
      lines.push(line);
      raws.push(raw);
      prevRaw = raw;
    }
    appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${raws.join("\n")}\n`);
    return lines;
  });
}

export function listIds(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID.test(d.name) && existsSync(logFile(root, d.name)))
    .map((d) => d.name);
}

export function nextId(root) {
  const used = existsSync(root) ? readdirSync(root).map((n) => /^D(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number) : [];
  return `D${Math.max(0, ...used) + 1}`;
}

/** What a said line carries, kept only if each one has the four fields (a line written around the commands may have anything). */
export const attachmentsOf = (l) =>
  (Array.isArray(l.attachments) ? l.attachments : [])
    .filter((a) => a && typeof a.name === "string" && typeof a.path === "string")
    .map((a) => ({ name: a.name, path: a.path, mime: String(a.mime ?? ""), size: Number(a.size) || 0 }));

const last = (list) => list[list.length - 1] ?? null;

/**
 * The state of an affair, folded from its lines. Every field derives from the log and from nothing else.
 * @returns {any}
 */
export function fold(lines) {
  const s = {
    id: "", title: "", goal: "", domain: "work", link: null, links: [], projects: [], attached: [], workdir: "", createdAt: null,
    status: "watching", statusAt: null, doneEvidence: "",
    workspaceId: null, projectId: null, archived: false, titleShown: "", conversationId: null, scheduleId: null, paseoHome: "", roleName: "",
    next: null, nowText: "", nowAt: null, nowSeq: 0, facts: [], watches: {}, reads: [], asks: [], said: [], deadlines: [], answers: {},
    reports: [], wakes: [], running: false, runningSince: null, lastWake: null, lastEnd: null,
    pending: [], flags: [], rejected: null, attempt: 0, chatRejected: null, chatAttempt: 0, chats: [], chatId: null, chatTurn: null, notes: [], briefs: { look: 0, chat: 0 }, flows: [], appeals: [], crossed: [], lastSeq: 0, chainBroken: 0, held: false, breaker: false, system: false, cleared: null,
  };
  const undone = new Set(lines.filter((l) => l.kind === "undo").map((l) => l.target));
  for (const l of lines) {
    s.lastSeq = l.seq;
    if (l.__broken && !s.chainBroken) s.chainBroken = l.seq;
    switch (l.kind) {
      case "created":
        Object.assign(s, { id: l.id, title: l.title, goal: l.goal ?? "", domain: l.domain ?? "work", link: l.link ?? null, workdir: l.workdir ?? "", createdAt: l.at, paseoHome: l.paseoHome ?? "", roleName: l.role ?? "", system: l.system === true });
        s.links = [...new Set((l.links ?? (l.link ? [l.link] : [])).map(normalizedLink).filter(Boolean))];
        s.projects = l.projects ?? [];
        s.roleExplicit = l.roleExplicit;
        break;
      case "link":
        s.links = l.action === "rm" ? s.links.filter((v) => v !== l.link) : [...new Set([...s.links, l.link])];
        if (l.role !== undefined) s.roleName = l.role;
        break;
      case "project":
        s.projects = l.action === "rm" ? s.projects.filter((v) => v !== l.project) : [...new Set([...s.projects, l.project])];
        break;
      case "attached":
        if (l.agentId && !s.attached.includes(l.agentId)) s.attached.push(l.agentId);
        break;
      case "workspace":
        if (l.archived) Object.assign(s, { archived: true, workspaceId: null, conversationId: null, chatId: null, scheduleId: null });
        if (l.workspaceId) Object.assign(s, { workspaceId: l.workspaceId, archived: false });
        if (l.projectId) s.projectId = l.projectId;
        if (l.title !== undefined) s.titleShown = l.title;
        break;
      case "conversation":
        s.conversationId = l.agentId ?? null;
        break;
      case "schedule":
        s.scheduleId = l.scheduleId;
        break;
      case "chat":
        // The chat session of this affair (the person talks to it); an earlier one stays in the list, for `history`.
        if (l.agentId) {
          s.chats.push({ agentId: String(l.agentId), at: l.at, seq: l.seq, why: String(l.why ?? "") });
          s.chatId = String(l.agentId);
          s.chatTurn = null;
        }
        break;
      case "chat.turn":
        // One turn of the chat finished: when, how long the session's context is now, what it cost (the real figures from the turn).
        if (l.agentId === s.chatId) s.chatTurn = { at: l.at, tokens: Number(l.tokens) || 0, usd: Number(l.usd) || 0, usdTotal: Number(l.usdTotal) || 0 };
        break;
      case "chat.handoff":
        // Kept in lines so a chat brief can show it once using the normal seen sequence.
        break;
      case "note":
        // What the chat session wrote down for itself (a conclusion, a decision): its own words, never taken for his.
        if (l.by === "chat" && typeof l.text === "string") s.notes.push({ seq: l.seq, at: l.at, text: l.text, said: Number.isInteger(l.said) ? l.said : null });
        break;
      case "brief":
        // A session read the brief up to this line: what comes after is news to it.
        if (Number.isInteger(l.seen)) s.briefs[l.for === "chat" ? "chat" : "look"] = l.seen;
        break;
      case "said":
        s.said.push({ seq: l.seq, at: l.at, text: String(l.text ?? ""), via: l.via ?? "chat", by: l.by ?? "user", undone: undone.has(l.seq), attachments: attachmentsOf(l) });
        // What a look noted about its own view is not something he said: it does not call for another look.
        // (What he says in the chat is answered there: it does not call for a look.)
        if (!undone.has(l.seq) && (l.by ?? "user") === "user" && (l.via ?? "chat") !== "chat-session") s.pending.push(`said:${l.seq}`);
        break;
      case "deadline":
        s.deadlines.push({ at: l.deadline, from: l.from, quote: l.quote, seq: l.seq });
        break;
      case "ring":
        s.pending.push(`ring:${l.why}`);
        break;
      case "cleared":
        // A look the limits were checked for (by whoever asked for it) and that has not started yet.
        s.cleared = l.void ? null : { at: l.at, force: l.force === true };
        break;
      case "hold":
        s.held = l.on !== false;
        break;
      case "breaker.reset":
        s.breaker = false;
        break;
      case "wake":
        s.wakes.push({ seq: l.seq, at: l.at, why: l.why ?? ["time"], gapMinutes: l.gapMinutes ?? null, changed: null, reported: false });
        s.lastWake = l;
        s.running = true;
        s.runningSince = l.at;
        s.cleared = null;
        s.pending = [];
        s.attempt = 0;
        s.rejected = null;
        break;
      case "wake.end":
        s.running = false;
        s.lastEnd = l;
        break;
      case "report":
        if (l.from === "chat") {
          // The chat session's report: it has its own count of tries, and it is not the end of a look.
          if (l.verdict === "rejected") {
            s.chatAttempt += 1;
            s.chatRejected = l.data;
          } else {
            s.chatRejected = null;
            s.chatAttempt = 0;
            s.reports.push(l);
            // A chat hand-in that only carries the old text along (no status of its own) did not write the "now" again.
            if (typeof l.status === "string") {
              if (l.status !== s.nowText) Object.assign(s, { nowAt: l.at, nowSeq: l.seq });
              s.nowText = l.status;
            }
            if (Array.isArray(l.facts)) s.facts = l.facts.filter((f) => typeof f === "string");
          }
          break;
        }
        if (l.verdict === "rejected") {
          s.attempt += 1;
          s.rejected = l.data;
        } else {
          s.rejected = null;
          s.attempt = 0;
          s.reports.push(l);
          const w = last(s.wakes);
          if (w) Object.assign(w, { changed: l.changed ?? null, reported: true });
          // A field of the wrong shape (a line written around the check) is not taken: the card and the files stay readable.
          if (typeof l.status === "string") Object.assign(s, { nowText: l.status, nowAt: l.at, nowSeq: l.seq });
          if (Array.isArray(l.facts)) s.facts = l.facts.filter((f) => typeof f === "string");
        }
        break;
      case "next":
        if (typeof l.next !== "string" || Number.isNaN(Date.parse(l.next))) break;
        s.next = { at: l.next, waitingFor: l.waitingFor ?? "", waitingOn: l.waitingOn ?? "", why: l.why ?? "", earlyIf: l.earlyIf ?? [], remind: l.remind ?? "", verdict: l.verdict ?? "pass", source: l.source ?? "look", detail: l.detail ?? "", seq: l.seq };
        if (l.verdict === "recorded" && l.deadlineKey) s.crossed.push(l.deadlineKey);
        if (l.verdict === "appeal") s.appeals.push(l.at);
        break;
      case "watch":
        if (l.drop) delete s.watches[l.id];
        else s.watches[l.id] = { ...s.watches[l.id], ...l.watch, id: l.id };
        break;
      case "read":
        s.reads.push({ id: `r${l.seq}`, seq: l.seq, at: l.at, tool: l.tool, args: l.args ?? {}, ok: l.ok !== false, value: l.value ?? null, summary: l.summary ?? "", reason: l.reason ?? "", ...stepFields(l) });
        if (l.ok !== false && l.steps !== undefined) s.stepRead = { at: l.at, ...stepFields(l) };
        if (s.reads.length > 20) s.reads.shift();
        break;
      case "watch.read": {
        const w = s.watches[l.id];
        if (!w) break;
        if (l.expired) {
          delete s.watches[l.id];
          s.pending.push(`watch-until:${l.id}`);
        } else if (l.reset) {
          Object.assign(w, { failures: 0, downAsked: false });
        } else if (l.ok === false) {
          Object.assign(w, { failures: (w.failures ?? 0) + 1, lastError: l.reason ?? "", failedAt: l.at });
        } else {
          if (l.steps !== undefined) s.stepRead = { at: l.at, ...stepFields(l) };
          if (l.changed) {
            w.prev = { value: w.value ?? null, summary: w.summary ?? "" };
            w.changedAt = l.at;
            s.pending.push(`watch:${l.id}`);
          }
          Object.assign(w, { value: l.value ?? null, summary: l.summary ?? "", hash: l.hash ?? null, failures: 0, downAsked: false, lastError: "", readAt: l.at, ...stepFields(l) });
        }
        break;
      }
      case "asked":
        if (l.for === "breaker") s.breaker = true;
        s.asks.push({ id: String(l.id), title: String(l.title ?? ""), line: String(l.line ?? ""), options: Array.isArray(l.options) ? l.options.map(String) : [], runs: l.runs ?? {}, proposal: l.proposal ?? null, allowOther: l.allowOther !== false, for: l.for ?? "", at: l.at, seq: l.seq, state: "open", answer: "", answeredAt: null, via: "" });
        if (String(l.for ?? "").startsWith("down:") && s.watches[l.for.slice(5)]) s.watches[l.for.slice(5)].downAsked = true;
        break;
      case "answered": {
        const q = s.asks.find((a) => a.id === l.id);
        if (q && q.state === "open") Object.assign(q, { state: "answered", answer: l.answer, answeredAt: l.at, via: l.via ?? "" });
        // "It is fixed": the count of failed reads starts again, so a still-broken read asks once more after its own run of failures.
        if (q && String(q.for).startsWith("down:") && s.watches[q.for.slice(5)]) Object.assign(s.watches[q.for.slice(5)], { failures: 0, downAsked: false });
        s.answers[l.id] = l.answer;
        s.pending.push(`answered:${l.id}`);
        break;
      }
      case "ask.drop": {
        const q = s.asks.find((a) => a.id === l.id);
        if (q && q.state === "open") q.state = "dropped";
        break;
      }
      case "flow":
        // A flow he had started for this affair (`affair flow`): which, the run it is, what he said that asked for it.
        s.flows.push({ seq: l.seq, at: l.at, flow: String(l.flow ?? ""), runId: String(l.runId ?? ""), events: String(l.events ?? ""), timeoutMs: Number(l.timeoutMs) || 0, by: l.by ?? "chat", said: Number.isInteger(l.said) ? l.said : null, resumeOf: l.resumeOf ?? null, ...(l.trial === true ? { trial: true } : {}), failed: "", marks: [], outcome: "", summary: "", costUsd: null, endedAt: "", resume: null });
        break;
      case "flow.mark": {
        // A step of a run the plugin saw (a card waiting, answered, the end): written once for each (run, key), so the same
        // sighting twice is one. The end also says how the run came out.
        const f = s.flows.find((x) => x.runId === l.runId);
        if (!f || !l.key || f.marks.some((m) => m.key === l.key)) break;
        f.marks.push({ seq: l.seq, at: l.at, key: String(l.key), text: String(l.text ?? ""), tone: l.tone === "red" ? "red" : "normal" });
        if (l.key === "end") {
          f.outcome = String(l.outcome ?? "");
          f.summary = String(l.summary ?? "");
          f.costUsd = Number.isFinite(l.costUsd) ? l.costUsd : null;
          f.endedAt = l.at;
          f.resume = l.resume ?? null;
        }
        break;
      }
      case "flow.fail": {
        // The run did not start after all (the runtime turned it away, or another start was first): it counts for nothing.
        const f = s.flows.find((x) => x.runId === l.runId);
        if (f) f.failed = String(l.why ?? "没起成");
        break;
      }
      case "status":
        s.status = l.status;
        s.statusAt = l.at;
        s.doneEvidence = l.evidence ?? "";
        break;
      case "flag":
        s.flags.push({ seq: l.seq, at: l.at, what: l.what, detail: l.detail ?? "" });
        break;
      default:
        break;
    }
  }
  return s;
}

/** @returns {any} */
export const load = (root, id) => fold(read(root, id));
export const isOpen = (s) => s.status === "watching";
