import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { writeConfig } from "./helpers";

// The plugin entry against a fake host: what the daemon does at load -- register settings, the
// provider and the RPC handlers, then start -- so a name the SDK refuses or a start that throws
// fails here and not at `paseo plugin install`. Dry-run with a config whose source command
// fails, so nothing leaves the process.

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the entry registers, starts in dry-run, reconciles once, writes status and plan, and stops", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-entry-"));
  const configDir = path.join(dir, "config");
  const dataDir = path.join(dir, "data");
  writeConfig(configDir);
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const providers: ProviderRegistration[] = [];
  const values = { instanceId: "test", home: dir, configDir, mode: "live", tickSeconds: 3600, dataDir };
  const fake = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values, revision: "r1" }), subscribe: () => () => {} }),
    registerProvider: (provider: ProviderRegistration) => providers.push(provider),
    handle: (contract: { name: string }, handler: (input: unknown) => Promise<unknown>) => handlers.set(contract.name, handler),
    registerUsageSource: () => {},
  } as unknown as PluginServerContext;
  const { default: contribute } = await import("../index.server");
  // Nothing leaves the process: the tracker answers an empty list, the switch file is empty.
  const outward: string[] = [];
  const io = {
    exec: async (command: string[], args: string[]) => {
      outward.push(`exec ${command.join(" ")} ${args[0] ?? ""}`);
      const inner = { res_code: 1, data: { list: [] } };
      const text = JSON.stringify({ ok: true, code: "OK", data: { code: "OK", data: { code: "OK", data: [{ type: "text", text: JSON.stringify(inner) }] } } });
      return { code: 0, stdout: text, stderr: "", ms: 1, timedOut: false };
    },
    fetchText: async (url: string) => (outward.push(`fetch ${url}`), { status: 200, text: '{"switches":{}}', lastModified: null }),
  };
  const cleanup = contribute(fake, io);
  try {
    assert.deepEqual([...handlers.keys()].sort(), ["reconcile.answer", "reconcile.graph", "reconcile.overview", "reconcile.rules.release", "reconcile.test-card", "reconcile.tick"]);
    assert.deepEqual(providers.map((p) => p.id), ["reconcile"]);
    type Overview = { state: string; status: { lastTickAt: string | null; mode: string; problems: string[] } | null };
    const read = async () => (await handlers.get("reconcile.overview")!({})) as Overview;
    let overview = await read();
    for (let i = 0; i < 100 && !overview.status?.lastTickAt; i++) {
      await settle(50);
      overview = await read();
    }
    assert.equal(overview.state, "running");
    // live in the settings, but this fake host has no server.paseo: dry-run, and it says why.
    assert.equal(overview.status!.mode, "dry-run");
    assert.ok(overview.status!.problems.some((p) => p.includes("server.paseo")));
    assert.ok(outward.includes("fetch https://flags.example/outer.json"), "the switch file went through the fake");
    assert.ok(outward.some((c) => c.startsWith("exec node cli.js")), "the tracker went through the fake");
    assert.ok(existsSync(path.join(dataDir, "status.json")));
    assert.match(readFileSync(path.join(dataDir, "plan.md"), "utf8"), /# 事项追踪（test，演练）/);
  } finally {
    // The host awaits it: the engine stopped and the journal closed once it resolves.
    const done = (cleanup as () => Promise<void>)();
    assert.ok(done instanceof Promise);
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});
