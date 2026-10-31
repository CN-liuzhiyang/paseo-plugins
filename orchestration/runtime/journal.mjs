// What a line of runs has done: a run and the runs that carry it on (resume.mjs) share one journal, so that a step that was
// done, an answer that was paid for and a card that a person answered are not done, paid for and asked again.
//
//   <logDir>/runs/<lineage>/journal.jsonl     one JSON object per line, appended, never rewritten
//
// An entry is { v, id, kind, state, keyPrint, ... }: `id` names the place in the flow ("step:build", "ask:analyze#1",
// "gate#2"), `keyPrint` fingerprints what it was done with (the step's key, the prompt, the card's content), `state` says how
// far it got. Of every id the last line is the one that counts. A step that cannot be undone (`once`) writes `begun` before it
// acts and fsyncs it, so a process that dies in the middle leaves a line that says "started, no word of how it ended".
//
// The journal is read once, when a run starts. Only one run of a line works at a time (line-lock.mjs holds the line for the run that
// writes; this file does not lock), and appends within a process are synchronous.
//
// A write that was cut off leaves a last line without its newline. It was never acknowledged -- an append returns after the newline is
// on the disk, and nothing is done on the strength of a line before that -- so it says nothing, and the first append after it takes it
// away (`#mend`) rather than join its own line to it. A line that is complete (it has its newline) and cannot be read is another
// thing: something damaged the file, and what it held is not known. It is kept, counted in `damaged`, and a step that cannot be
// taken back is not done on the strength of there being no line for it.

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonical } from "./resume-point.mjs";

export const JOURNAL_VERSION = 1;

/** One entry's value: bigger than this is a file's job, with the path in the entry. */
export const MAX_VALUE_BYTES = 1 << 20;

/** Kinds `--redo` takes back. A card a person answered is kept: a card with other content is asked again anyway. */
const REDONE_KINDS = ["step", "ask", "again"];

export class JournalError extends Error {
  constructor(message) {
    super(message);
    this.name = "JournalError";
  }
}

/** `<logDir>/runs/<lineage>/journal.jsonl` */
export const journalFile = (dir, lineage) => path.join(dir, "runs", lineage, "journal.jsonl");

/** The fingerprint of a value as JSON, whatever order its keys were written in. */
export const fingerprint = (value) => createHash("sha256").update(canonical(value)).digest("hex");

/** The first 16 hex digits: what events and listings show. */
export const shortPrint = (print) => print.slice(0, 16);

/**
 * The complete lines of the file that read as entries, and the complete lines that do not (their number and a start of them); a last
 * line without its newline is a write in progress and is neither.
 */
function readEntries(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { entries: [], damaged: [] };
    throw error;
  }
  const entries = [];
  const damaged = [];
  text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .forEach((line, index) => {
      if (line === "") return;
      try {
        const entry = JSON.parse(line);
        if (entry !== null && typeof entry === "object" && typeof entry.id === "string") entries.push(entry);
        else damaged.push({ line: index + 1, start: line.slice(0, 80) });
      } catch {
        damaged.push({ line: index + 1, start: line.slice(0, 80) });
      }
    });
  return { entries, damaged };
}

export class Journal {
  /**
   * @param {{ dir: string, lineage: string, redo?: string | null }} options `redo` is a step to do again: it and every undoable
   *   entry that came after it are left out of what `get` returns, until they are written again.
   */
  constructor({ dir, lineage, redo = null }) {
    this.file = journalFile(dir, lineage);
    this.lineage = lineage;
    /** @type {Map<string, { entry: object, at: number }>} the last entry of every id, and where in the file it is */
    this.current = new Map();
    const { entries, damaged } = readEntries(this.file);
    entries.forEach((entry, at) => this.current.set(entry.id, { entry, at }));
    this.next = entries.length;
    /** @type {{ line: number, start: string }[]} complete lines that could not be read: what they held is not known */
    this.damaged = damaged;
    this.mended = false;
    this.ignored = new Set();
    if (redo !== null) this.#redo(redo);
  }

  #redo(name) {
    const target = this.current.get(`step:${name}`);
    if (!target) {
      const known = this.steps().filter((e) => e.kind === "step").map((e) => e.id.slice("step:".length));
      throw new JournalError(`there is no step "${name}" in this line of runs to do again${known.length > 0 ? `; its steps: ${known.join(", ")}` : ""}`);
    }
    if (target.entry.once === true) throw new JournalError(`step "${name}" cannot be undone, so it is not done again; settle it (orch.mjs settle) if its record is wrong`);
    for (const [id, { entry, at }] of this.current) {
      if (at >= target.at && entry.once !== true && REDONE_KINDS.includes(entry.kind)) this.ignored.add(id);
    }
  }

  /** The last entry of `id`, or null when there is none or it is to be done again. */
  get(id) {
    if (this.ignored.has(id)) return null;
    return this.current.get(id)?.entry ?? null;
  }

  /** The last entry of every id, in the order they were last written. */
  steps() {
    return [...this.current.values()].sort((a, b) => a.at - b.at).map(({ entry }) => entry);
  }

  /** How many entries of a kind are done (and not set aside): what a carried-on run does not do again. */
  count(kind, test = () => true) {
    return this.steps().filter((e) => e.kind === kind && e.state === "done" && !this.ignored.has(e.id) && test(e)).length;
  }

  /**
   * Write an entry. `sync` flushes it to the disk before this returns, for the line a crash must not lose (`begun`, and the
   * `done` of a step that cannot be undone).
   */
  append(fields, { sync = false } = {}) {
    const entry = { v: JOURNAL_VERSION, ...fields, at: new Date().toISOString() };
    const text = `${JSON.stringify(entry)}\n`;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = openSync(this.file, "a");
    try {
      if (!this.mended) {
        this.#mend();
        this.mended = true;
      }
      // writeFileSync goes on until all of it is written; writeSync may stop short.
      writeFileSync(fd, text);
      if (sync) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.current.set(entry.id, { entry, at: this.next++ });
    this.ignored.delete(entry.id);
    return entry;
  }

  // A last line without its newline is a write that was cut off: cut it away, so that the next line starts on a line of its own and is not
  // read as part of it. Flushed, because a line written after this one must not be able to come back together with it. The caller holds the
  // line (line-lock.mjs), so no one else is in the middle of an append.
  #mend() {
    const content = readFileSync(this.file);
    if (content.length === 0 || content[content.length - 1] === 0x0a) return;
    // Not through the descriptor that appends: on Windows that one may not truncate.
    const fd = openSync(this.file, "r+");
    try {
      ftruncateSync(fd, content.lastIndexOf(0x0a) + 1);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/** Whether `entry` is one this runtime wrote and can read; anything else is treated as no record (a step that cannot be undone: as unknown). */
export const known = (entry) => entry?.v === JOURNAL_VERSION;
