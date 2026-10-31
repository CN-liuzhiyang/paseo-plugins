// The journal of a line of runs: what is read back, which line of an id counts, what `redo` sets aside. No run is made here.
//
//   npm test        (from orchestration/)

import "./hermetic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Journal, JournalError, fingerprint, journalFile, known, shortPrint } from "../runtime/journal.mjs";
import { tempDir } from "./temp.mjs";

const open = async (options = {}) => new Journal({ dir: await tempDir("orch-journal-"), lineage: "line-1", ...options });
const reopen = (journal, options = {}) => new Journal({ dir: path.dirname(path.dirname(path.dirname(journal.file))), lineage: journal.lineage, ...options });

test("an entry is read back by a journal that opens the file later; of an id the last line counts", async () => {
  const journal = await open();
  assert.equal(journal.get("step:a"), null);
  journal.append({ id: "step:a", kind: "step", state: "done", keyPrint: "k1", value: 1, runId: "r1", callId: "c1" });
  journal.append({ id: "step:a", kind: "step", state: "done", keyPrint: "k2", value: 2, runId: "r2", callId: "c1" });
  journal.append({ id: "step:b", kind: "step", state: "done", keyPrint: "k1", value: 3, runId: "r1", callId: "c2" });

  const later = reopen(journal);
  assert.equal(later.get("step:a").value, 2);
  assert.equal(later.get("step:a").runId, "r2");
  assert.deepEqual(later.steps().map((e) => e.id), ["step:a", "step:b"], "in the order they were last written");
  assert.ok(later.get("step:a").at && known(later.get("step:a")));
  assert.equal(journalFile("D:/logs", "line-1").replaceAll("\\", "/"), "D:/logs/runs/line-1/journal.jsonl");
});

test("a line that is not an entry says nothing, and a last line without its newline is a write in progress", async () => {
  const journal = await open();
  journal.append({ id: "step:a", kind: "step", state: "done", keyPrint: "k", value: 1 });
  appendFileSync(journal.file, "not json\n{\"no\":\"id\"}\n[1]\n", "utf8");
  journal.append({ id: "step:b", kind: "step", state: "done", keyPrint: "k", value: 2 });
  appendFileSync(journal.file, JSON.stringify({ v: 1, id: "step:c", kind: "step", state: "done", keyPrint: "k", value: 3 }), "utf8");
  const later = reopen(journal);
  assert.deepEqual(later.steps().map((e) => e.id), ["step:a", "step:b"]);
});

test("an entry another version of the runtime wrote is read, and not known", async () => {
  const journal = await open();
  mkdirSync(path.dirname(journal.file), { recursive: true });
  appendFileSync(journal.file, `${JSON.stringify({ v: 2, id: "step:a", kind: "step", state: "done", value: 1 })}\n`, "utf8");
  const later = reopen(journal);
  assert.equal(later.get("step:a").v, 2);
  assert.equal(known(later.get("step:a")), false);
});

test("append can be flushed to the disk, and creates the line's directory", async () => {
  const dir = await tempDir("orch-journal-");
  const journal = new Journal({ dir, lineage: "fresh" });
  assert.equal(readFileSafe(journal.file), null);
  journal.append({ id: "step:a", kind: "step", state: "begun", once: true }, { sync: true });
  assert.match(readFileSafe(journal.file), /"state":"begun"/);
  mkdirSync(path.join(dir, "runs", "other"), { recursive: true });
  writeFileSync(path.join(dir, "runs", "other", "journal.jsonl"), "", "utf8");
  assert.deepEqual(new Journal({ dir, lineage: "other" }).steps(), []);
});
const readFileSafe = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

test("redo: the step and what came after it that can be taken back are set aside, until they are written again; what cannot be taken back is not", async () => {
  const journal = await open();
  const write = (id, kind, extra = {}) => journal.append({ id, kind, state: "done", keyPrint: "k", value: id, ...extra });
  write("step:compile", "step");
  write("step:build", "step");
  write("ask:review#1", "ask");
  write("gate#1", "gate");
  write("step:commit", "step", { once: true });
  write("step:report", "step");
  write("again:ask:review#1#1", "again");

  const again = reopen(journal, { redo: "build" });
  assert.equal(again.get("step:compile").value, "step:compile", "before it: kept");
  for (const id of ["step:build", "ask:review#1", "step:report", "again:ask:review#1#1"]) assert.equal(again.get(id), null, `${id} is set aside`);
  assert.ok(again.get("gate#1"), "a person's answer stays: a card with other content is asked anyway");
  assert.ok(again.get("step:commit"), "what cannot be taken back stays");
  assert.equal(again.count("step"), 2, "what the journal still holds of steps: compile and commit");

  again.append({ id: "step:build", kind: "step", state: "done", keyPrint: "k2", value: "again" });
  assert.equal(again.get("step:build").value, "again");
  assert.equal(again.get("step:report"), null, "the rest stays set aside");
});

test("redo: a step that is not in the journal, or that cannot be taken back, is refused with what can be", async () => {
  const journal = await open();
  journal.append({ id: "step:build", kind: "step", state: "done", keyPrint: "k", value: 1 });
  journal.append({ id: "step:commit", kind: "step", state: "done", keyPrint: "k", value: 1, once: true });
  assert.throws(() => reopen(journal, { redo: "biuld" }), (error) => error instanceof JournalError && /no step "biuld"[\s\S]*build, commit/.test(error.message));
  assert.throws(() => reopen(journal, { redo: "commit" }), (error) => error instanceof JournalError && /cannot be undone/.test(error.message));
});

test("a fingerprint does not depend on the order keys were written in, and shows 16 digits", () => {
  assert.equal(fingerprint({ a: 1, b: [1, { c: 2, d: 3 }] }), fingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  assert.equal(fingerprint(undefined), fingerprint(null), "no key is the null key");
  assert.match(shortPrint(fingerprint("x")), /^[0-9a-f]{16}$/);
});
