import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LockedError, openStore, StoreClosedError } from "../server/store";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "reconcile-store-"));

test("events are appended, folded, and replayed after a restart", () => {
  const dir = tmp();
  try {
    const store = openStore({ dir, now: () => Date.parse("2026-10-21T08:00:00Z") });
    store.append([{ type: "workspace", workspaceId: "w1" }, { type: "eval.candidate", kind: "woke-noop", subject: "x", detail: "" }]);
    assert.equal(store.state.seq, 2);
    store.close();
    const again = openStore({ dir });
    assert.equal(again.state.workspaceId, "w1");
    assert.equal(again.state.evals, 1);
    assert.equal(again.state.seq, 2);
    const file = readdirSync(path.join(dir, "journal"))[0]!;
    assert.equal(file, "2026-10.jsonl");
    const lines = readFileSync(path.join(dir, "journal", file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.v, l.seq, l.type]), [[1, 1, "workspace"], [1, 2, "eval.candidate"]]);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a half-written last line is skipped, and events after the snapshot are replayed", () => {
  const dir = tmp();
  try {
    const store = openStore({ dir });
    store.append([{ type: "workspace", workspaceId: "w1" }]);
    store.snapshot();
    store.append([{ type: "workspace", workspaceId: "w2" }]);
    const file = path.join(dir, "journal", readdirSync(path.join(dir, "journal"))[0]!);
    appendFileSync(file, '{"v":1,"seq":3,"type":"workspa');
    store.abandon();
    rmSync(path.join(dir, "LOCK"));
    const again = openStore({ dir });
    assert.equal(again.state.workspaceId, "w2");
    assert.equal(again.skipped, 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live lock from another process refuses; a stale one is taken over", () => {
  const dir = tmp();
  try {
    openStore({ dir }).close();
    writeFileSync(path.join(dir, "LOCK"), JSON.stringify({ pid: 999_999 }));
    assert.throws(() => openStore({ dir, alive: () => true }), LockedError);
    const taken = openStore({ dir, alive: () => false });
    assert.equal(JSON.parse(readFileSync(path.join(dir, "LOCK"), "utf8")).pid, process.pid);
    taken.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a LOCK whose pid is alive but was not touched for a while is stale (the pid may be another process's now)", () => {
  const dir = tmp();
  try {
    openStore({ dir }).close();
    const lock = path.join(dir, "LOCK");
    writeFileSync(lock, JSON.stringify({ pid: 999_999 }));
    assert.throws(() => openStore({ dir, alive: () => true, staleLockMs: 60_000 }), LockedError, "touched just now");
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(lock, old, old);
    const taken = openStore({ dir, alive: () => true, staleLockMs: 60_000 });
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
    utimesSync(lock, old, old);
    taken.touch();
    assert.ok(Date.now() - statSync(lock).mtimeMs < 10_000, "the holder's touch keeps it fresh");
    taken.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a closed store refuses to write, so a reconcile still running after a stop cannot write into the journal", () => {
  const dir = tmp();
  try {
    const store = openStore({ dir });
    store.append([{ type: "workspace", workspaceId: "w1" }]);
    store.close();
    assert.equal(store.closed, true);
    assert.throws(() => store.append([{ type: "workspace", workspaceId: "w2" }]), StoreClosedError);
    assert.throws(() => store.snapshot(), StoreClosedError);
    const again = openStore({ dir });
    assert.equal(again.state.workspaceId, "w1");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn last line is closed off on open, so the next batch is not welded onto it", () => {
  const dir = tmp();
  try {
    const now = () => Date.parse("2026-10-22T10:00:00Z");
    const s1 = openStore({ dir, now });
    s1.append([{ type: "started", instanceId: "i", mode: "dry-run", pid: 1, home: "h" }]);
    s1.close();
    // A hard kill never writes the snapshot: replay is from the journal alone.
    rmSync(path.join(dir, "snapshot.json"));
    const file = path.join(dir, "journal", readdirSync(path.join(dir, "journal"))[0]!);
    appendFileSync(file, '{"v":1,"seq":2,"at":"2026-10-22T10:00:01.000Z","type":"workspace","workspaceId":"half');
    const s2 = openStore({ dir, now });
    s2.append([{ type: "workspace", workspaceId: "important-1" }]);
    s2.append([{ type: "workspace", workspaceId: "important-2" }]);
    s2.abandon();
    rmSync(path.join(dir, "LOCK"), { force: true });
    const s3 = openStore({ dir, now });
    assert.equal(s3.state.workspaceId, "important-2");
    assert.equal(s3.skipped, 1, "only the torn line");
    s3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn snapshot is ignored and the journal replayed instead of refusing to start", () => {
  const dir = tmp();
  try {
    const store = openStore({ dir });
    store.append([{ type: "workspace", workspaceId: "w1" }]);
    store.close();
    writeFileSync(path.join(dir, "snapshot.json"), "");
    const again = openStore({ dir });
    assert.equal(again.state.workspaceId, "w1");
    assert.ok(again.snapshotIgnored);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
