import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadConfig } from "../server/config";
import { createEngine } from "../server/engine";
import type { Source } from "../server/sources/source";
import { openStore } from "../server/store";
import { issue, makeWorld, writeConfig } from "./helpers";

// Stopping and starting: a reconcile in flight when the plugin restarts its engine, and what
// the entry does with a settings write.

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a reconcile in flight when its engine is stopped writes nothing after; the next engine's journal is whole", async () => {
  const w = await makeWorld({ start: "2026-10-13 10:00" });
  w.store.close();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const config = loadConfig(w.configDir);
  const source = (slow: boolean, id: number): Source => ({
    id: "gcp-demo",
    domain: "work",
    async poll() {
      if (slow) await gate;
      return { snapshots: [{ ...issue(id, { release: "2026-10-14" }), observedAt: "2026-10-13T10:00:00+08:00" }], cursor: { n: id }, calls: 1, errors: [], more: false };
    },
  });
  const common = { config, carrier: null, mode: "dry-run" as const, instanceId: "t", home: w.dir, tickSeconds: 60, now: () => w.clock.now, log: () => {}, writeStatus: () => {} };
  try {
    const store1 = openStore({ dir: w.dataDir, now: () => w.clock.now });
    const engine1 = createEngine({ ...common, store: store1, sources: [source(true, 1)] });
    const tick1 = engine1.tick();
    assert.equal(engine1.busy(), true);
    // What the entry does: stop the engine, wait (here: not, the poll is stuck), close, reopen.
    const stopped = engine1.stop();
    store1.close();
    const store2 = openStore({ dir: w.dataDir, now: () => w.clock.now });
    const engine2 = createEngine({ ...common, store: store2, sources: [source(false, 2)] });
    await engine2.tick();
    release();
    await tick1;
    await stopped;
    store2.close();
    const file = path.join(w.dataDir, "journal", readdirSync(path.join(w.dataDir, "journal"))[0]!);
    const seqs = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).seq as number);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "one writer: sequence numbers only go up");
    assert.equal(new Set(seqs).size, seqs.length, "no sequence number twice");
    const store3 = openStore({ dir: w.dataDir, now: () => w.clock.now });
    assert.deepEqual(Object.keys(store3.state.items), ["gcp-demo:2"], "the stopped engine's poll result was not written");
    store3.close();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

/** The entry against a fake host whose settings can change, with an exec that can be held. */
async function entry(options: { mode: string; paseo?: unknown; held?: boolean; fails?: boolean }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-life-"));
  const configDir = path.join(dir, "config");
  const dataDir = path.join(dir, "data");
  writeConfig(configDir);
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  let values = { instanceId: "test", home: dir, configDir, mode: options.mode, tickSeconds: 3600, dataDir };
  let changed: () => void = () => {};
  let open: () => void = () => {};
  let hold: Promise<void> | null = options.held ? new Promise<void>((resolve) => (open = resolve)) : null;
  const fake = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values, revision: "r" }), subscribe: (listener: () => void) => ((changed = listener), () => {}) }),
    registerProvider: () => {},
    handle: (contract: { name: string }, handler: (input: unknown) => Promise<unknown>) => handlers.set(contract.name, handler),
    registerUsageSource: () => {},
    ...(options.paseo ? { paseo: options.paseo } : {}),
  } as unknown as PluginServerContext;
  const io = {
    exec: async () => {
      if (hold) await hold;
      if (options.fails) return { code: 1, stdout: "", stderr: "boom", ms: 1, timedOut: false };
      const inner = { res_code: 1, data: { list: [] } };
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { data: { data: [{ type: "text", text: JSON.stringify(inner) }] } } }), stderr: "", ms: 1, timedOut: false };
    },
    fetchText: async () => ({ status: 200, text: '{"switches":{}}', lastModified: null }),
  };
  const { default: contribute } = await import("../index.server");
  const cleanup = contribute(fake, io) as () => void;
  const rpc = (name: string) => handlers.get(name)!({}) as Promise<{ ok?: boolean; detail?: string; state?: string; status?: { lastTickAt: string | null } | null }>;
  const started = () =>
    readdirSync(path.join(dataDir, "journal"))
      .flatMap((f) => readFileSync(path.join(dataDir, "journal", f), "utf8").split("\n").filter(Boolean))
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === "started").length;
  const seqs = () =>
    readdirSync(path.join(dataDir, "journal"))
      .flatMap((f) => readFileSync(path.join(dataDir, "journal", f), "utf8").split("\n").filter(Boolean))
      .map((line) => JSON.parse(line).seq as number);
  const running = async () => {
    for (let i = 0; i < 100; i++) {
      if ((await rpc("reconcile.overview")).state === "running") return;
      await settle(30);
    }
    throw new Error("never started");
  };
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      const o = await rpc("reconcile.overview");
      if (o.status?.lastTickAt) return;
      await settle(30);
    }
    throw new Error("never reconciled");
  };
  return {
    dir,
    rpc,
    started,
    seqs,
    running,
    ready,
    change: (patch: Partial<typeof values>) => ((values = { ...values, ...patch }), changed()),
    release: () => ((hold = null), open()),
    close: () => (cleanup(), rmSync(dir, { recursive: true, force: true })),
  };
}

test("a settings write that changes nothing leaves the engine running; one that changes something restarts it after the reconcile in flight", async () => {
  // The first reconcile is held in its first call to the tracker.
  const e = await entry({ mode: "dry-run", held: true });
  try {
    await e.running();
    assert.equal(e.started(), 1);
    e.change({});
    await settle(100);
    assert.equal(e.started(), 1, "same settings: not restarted (cards would be raised again)");
    // Asked to reconcile while one is in flight, it says so instead of "done".
    const busy = await e.rpc("reconcile.tick");
    assert.equal(busy.ok, false);
    assert.match(busy.detail!, /上一轮检查还没结束/);
    e.change({ tickSeconds: 1800 });
    await settle(100);
    assert.equal(e.started(), 1, "the restart waits for the reconcile in flight");
    e.release();
    for (let i = 0; i < 100 && e.started() < 2; i++) await settle(30);
    assert.equal(e.started(), 2);
    await e.ready();
  } finally {
    e.close();
  }
});

test("rehearsing has no carrier: a host with server.paseo is never touched in dry-run", async () => {
  const touched: string[] = [];
  const paseo = new Proxy({}, { get: (_t, name) => (touched.push(String(name)), new Proxy(() => {}, { get: () => () => {} })) });
  const e = await entry({ mode: "dry-run", paseo });
  try {
    await e.ready();
    await e.rpc("reconcile.test-card");
    await settle(100);
    assert.deepEqual(touched, []);
  } finally {
    e.close();
  }
});

test("two settings writes while a reconcile is held, and the held call then failing: one engine writes at a time, each sequence number once", async () => {
  const e = await entry({ mode: "dry-run", held: true, fails: true });
  try {
    await e.running();
    await settle(200);
    e.change({ tickSeconds: 1800 });
    await settle(100);
    e.change({ tickSeconds: 900 });
    await settle(300);
    e.release();
    for (let i = 0; i < 100 && e.started() < 3; i++) await settle(50);
    await settle(300);
    assert.equal(e.started(), 3, "each write started its engine in turn");
    const seqs = e.seqs();
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length, "no sequence number twice");
  } finally {
    e.close();
  }
});

test("a data directory is opened once per process: a second store on it is refused until the first closes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-once-"));
  try {
    const first = openStore({ dir });
    assert.throws(() => openStore({ dir }), /already open in this process/);
    first.close();
    openStore({ dir }).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
