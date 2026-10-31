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
// The journal is read once, when a run starts. Only one run of a line works at a time (claim.mjs, resume.mjs), and appends
// within a process are synchronous, so nothing here locks.

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
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

/** The complete lines of the file that read as entries; a last line without its newline is a write in progress. */
function readEntries(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) {
    if (line === "") continue;
    try {
      const entry = JSON.parse(line);
      if (entry !== null && typeof entry === "object" && typeof entry.id === "string") entries.push(entry);
    } catch {
      // A line that is not JSON says nothing.
    }
  }
  return entries;
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
    const entries = readEntries(this.file);
    entries.forEach((entry, at) => this.current.set(entry.id, { entry, at }));
    this.next = entries.length;
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
      writeSync(fd, text);
      if (sync) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.current.set(entry.id, { entry, at: this.next++ });
    this.ignored.delete(entry.id);
    return entry;
  }
}

/** Whether `entry` is one this runtime wrote and can read; anything else is treated as no record (a step that cannot be undone: as unknown). */
export const known = (entry) => entry?.v === JOURNAL_VERSION;
