import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CrsClient } from "../server/crs-client";
import { discover, originOf } from "../server/discovery";
import { UsageService } from "../server/service";
import { mapUsage } from "../server/usage";
import { settingsDefinition } from "../shared/settings";
import { estimate, snapshotSchema } from "../shared/snapshot";
import { panelEntrySchema } from "../shared/rpc";
import { fixture, startFakeCrs, TEST_KEY } from "./fake-crs";

async function config(origin = "https://crs.example") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crs-usage-test-"));
  const models = {
    providers: {
      "crs-claude": { baseUrl: `${origin}/claude` },
      "crs-codex": { baseUrl: `${origin}/openai` },
    },
  };
  const auth = {
    "crs-claude": { type: "api_key", key: TEST_KEY },
    "crs-codex": { type: "api_key", key: TEST_KEY },
  };
  await writeFile(path.join(dir, "models.json"), JSON.stringify(models));
  await writeFile(path.join(dir, "auth.json"), JSON.stringify(auth));
  return {
    dir,
    models,
    auth,
    settings: settingsDefinition.schema.parse({ allowedOrigins: [origin], piConfigDir: dir }),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
test("discovery: empty defaults hide; opt-in merges origin+key, separates keys/origins, respects session directory", async () => {
  const c = await config();
  try {
    assert.deepEqual(
      await discover(settingsDefinition.schema.parse({ piConfigDir: c.dir }), { kind: "global" }),
      [],
    );
    const entries = await discover(c.settings, { kind: "global" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].providers.length, 2);
    assert.equal(JSON.stringify(entries.map((e) => ({ id: e.id }))).includes(TEST_KEY), false);
    assert.deepEqual(
      await discover(c.settings, { kind: "session", provider: "codex", env: {} }),
      [],
    );
    assert.deepEqual(
      await discover(c.settings, {
        kind: "session",
        provider: "pi",
        model: "crs-claude/model",
        env: { PI_CODING_AGENT_DIR: path.join(c.dir, "missing") },
      }),
      [],
    );
    assert.equal(
      (
        await discover(c.settings, {
          kind: "session",
          provider: "pi",
          model: "crs-codex/model",
          env: { PI_CODING_AGENT_DIR: c.dir },
        })
      )[0].providers.length,
      1,
    );
    c.auth["crs-codex"].key = "sk-test-different";
    await writeFile(path.join(c.dir, "auth.json"), JSON.stringify(c.auth));
    assert.equal((await discover(c.settings, { kind: "global" })).length, 2);
    c.models.providers["crs-codex"].baseUrl = "https://other.example/openai";
    c.auth["crs-codex"].key = TEST_KEY;
    await writeFile(path.join(c.dir, "models.json"), JSON.stringify(c.models));
    await writeFile(path.join(c.dir, "auth.json"), JSON.stringify(c.auth));
    assert.equal(
      (await discover({ ...c.settings, providerNames: ["crs-codex"] }, { kind: "global" })).length,
      2,
    );
    for (const bad of [
      "https://user:pass@crs.example",
      "https://crs.example/?apiKey=secret",
      "file:///etc",
      "https://crs.example/#secret",
    ])
      assert.equal(originOf(bad), null);
  } finally {
    await c.close();
  }
});
test("mapping: null stays null, statuses, stale data, estimates, zero limit, exhausted key", async () => {
  const raw = await fixture();
  const snapshot = snapshotSchema.parse(raw);
  const mapped = mapUsage(snapshot, ["crs-claude", "crs-codex"]);
  assert.equal(mapped.status, "available");
  if (mapped.status !== "available") return;
  assert.equal(mapped.windows.length, 10);
  assert.equal(mapped.balances?.[0].remaining, 17.7);
  assert.equal(mapped.balances?.[2].limit, null);
  assert.ok(Math.abs(estimate(snapshot.pools[0])! - (20 * 22 + 5 * 55 + 90) / 26) < 0.00001);
  for (const state of ["normal", "rate_limited", "unavailable", "unknown"] as const) {
    snapshot.pools[0].accounts[0].state = state;
    assert.equal(mapUsage(snapshot, []).status, "available");
  }
  const account = snapshot.pools[0].accounts[0];
  account.windows[0].usedPct = null;
  account.stale = true;
  const partial = mapUsage(snapshot, []);
  assert.equal(estimate(snapshot.pools[0]), null);
  if (partial.status === "available") {
    assert.equal(partial.windows[0].usedPct, null);
    assert.equal(partial.windows[0].remainingPct, null);
  }
  for (const a of snapshot.pools[1].accounts) a.tier = "unknown";
  assert.equal(estimate(snapshot.pools[1]), null);
  snapshot.key.daily.limit = 0;
  snapshot.key.daily.used = 3;
  const exhausted = mapUsage(snapshot, []);
  if (exhausted.status === "available") assert.equal(exhausted.balances?.[0].remaining, 0);
  for (const status of ["expired", "disabled", "inactive"] as const) {
    snapshot.key.status = status;
    assert.equal(mapUsage(snapshot, []).status, "error");
  }
});
test("real HTTP: single flight, 12s interval, exponential backoff, Retry-After and shared panel/native reader", async () => {
  const fake = await startFakeCrs();
  const c = await config(fake.origin);
  let now = Date.now();
  const http = new CrsClient({ now: () => now, random: () => 0 });
  const service = new UsageService(async () => c.settings, http);
  try {
    const accounts = await service.discover({ kind: "global" });
    assert.equal(accounts.length, 1);
    const [report, panel] = await Promise.all([service.fetch(accounts[0].input), service.panel()]);
    assert.equal(report.status, "available");
    assert.equal(fake.requests, 1);
    assert.equal(panel.length, 1);
    panelEntrySchema.parse(panel[0]);
    assert.equal(JSON.stringify([accounts, report, panel]).includes(TEST_KEY), false);
    await service.panel();
    now += 11999;
    await service.panel();
    assert.equal(fake.requests, 1);
    now++;
    fake.setMode("down");
    const failed = await service.fetch(accounts[0].input);
    assert.equal(failed.status, "error");
    assert.equal(fake.requests, 2);
    const stale = await service.panel();
    assert.ok(stale[0].error);
    assert.equal(stale[0].successfulAt, panel[0].successfulAt);
    assert.ok(stale[0].snapshot);
    now += 59999;
    await service.panel();
    assert.equal(fake.requests, 2);
    now++;
    await service.panel();
    assert.equal(fake.requests, 3);
    now += 60000;
    await service.panel();
    assert.equal(fake.requests, 4);
    now += 119999;
    await service.panel();
    assert.equal(fake.requests, 4);
    now++;
    fake.setMode("normal");
    await service.panel();
    assert.equal(fake.requests, 5);
    c.settings.allowedOrigins = [];
    assert.deepEqual(await service.identities(), []);
    assert.equal((await service.fetch(accounts[0].input)).status, "error");
  } finally {
    service.close();
    await fake.close();
    await c.close();
  }
});
test("HTTP error variants, timeout really aborts, redirects rejected, key never in serialized reports or logs", async () => {
  const fake = await startFakeCrs();
  const c = await config(fake.origin);
  let now = Date.now();
  const logs: unknown[] = [];
  const original = console.error;
  console.error = (...args) => {
    logs.push(args);
  };
  const service = new UsageService(
    async () => c.settings,
    new CrsClient({ now: () => now, random: () => 0, timeoutMs: 35 }),
  );
  try {
    const [account] = await service.discover({ kind: "global" });
    for (const mode of [
      "limited",
      "missing",
      "expired",
      "disabled",
      "redirect",
      "slow",
      "body_slow",
      "echo",
    ] as const) {
      now += 400000;
      fake.setMode(mode);
      const report = await service.fetch(account.input);
      const panel = await service.panel();
      assert.equal(
        report.status,
        ["limited", "missing", "echo"].includes(mode) ? "available" : "error",
        mode,
      );
      assert.equal(JSON.stringify([report, panel, logs]).includes(TEST_KEY), false, mode);
      assert.equal(JSON.stringify(panel).includes("private@example.test"), false);
      assert.equal(panel[0].links.usage.includes("?"), false);
    }
    assert.ok(fake.aborted >= 1);
  } finally {
    console.error = original;
    service.close();
    await fake.close();
    await c.close();
  }
});
test("escaped credentials are redacted after parsing, response body is bounded, window identities survive reorder", async () => {
  const key = 'sk-test-"\\escaped';
  const raw = await fixture();
  raw.pools[0].accounts[0].alias = key;
  const http = new CrsClient({ fetch: async () => new Response(JSON.stringify(raw)) });
  const result = await http.read("escaped", "https://crs.example", key);
  assert.ok(result.snapshot);
  assert.equal(JSON.stringify(result).includes(JSON.stringify(key).slice(1, -1)), false);
  assert.equal(result.snapshot!.pools[0].accounts[0].alias, "[redacted]");
  const oversized = new CrsClient({ fetch: async () => new Response("x".repeat(1024 * 1024 + 1)) });
  assert.ok((await oversized.read("large", "https://crs.example", TEST_KEY)).error);
  const snapshot = snapshotSchema.parse(await fixture());
  const before = mapUsage(snapshot, []);
  snapshot.pools[0].accounts.reverse();
  const after = mapUsage(snapshot, []);
  if (before.status === "available" && after.status === "available") {
    assert.deepEqual(
      Object.fromEntries(before.windows.map((w) => [w.label, w.id])),
      Object.fromEntries(after.windows.map((w) => [w.label, w.id])),
    );
  } else assert.fail("fixture should map successfully");
  http.close();
  oversized.close();
});
test("unknown window durations retain key spending and accurate labels; minimal inactive status is explicit", async () => {
  const raw = await fixture();
  raw.pools[1].accounts[0].windows[0].id = "primary";
  raw.pools[1].accounts[0].windows[1].id = "secondary";
  const snapshot = snapshotSchema.parse(raw);
  const report = mapUsage(snapshot, []);
  assert.equal(report.status, "available");
  assert.equal(estimate(snapshot.pools[1]), null);
  if (report.status === "available") {
    assert.ok(report.windows.some((w) => w.label.includes("主窗口（时长未知）")));
    assert.equal(report.balances?.[0].used, 12.3);
  }
  const http = new CrsClient({
    fetch: async () =>
      new Response(JSON.stringify({ schemaVersion: 1, key: { status: "inactive" } })),
  });
  assert.match((await http.read("inactive", "https://crs.example", TEST_KEY)).error!, /尚未激活/);
  http.close();
});
test("401/429, malformed response, HTTP-date retry and credential rotation reset failure identity", async () => {
  let now = Date.parse("2026-11-08T00:00:00Z");
  let calls = 0;
  let status = 429;
  const http = new CrsClient({
    now: () => now,
    random: () => 0,
    fetch: async () => {
      calls++;
      return new Response("bad", {
        status,
        headers: { "Retry-After": "Sun, 08 Nov 2026 00:02:00 GMT" },
      });
    },
  });
  assert.match((await http.read("a", "https://crs.example", TEST_KEY)).error!, /限流/);
  now += 119999;
  await http.read("a", "https://crs.example", TEST_KEY);
  assert.equal(calls, 1);
  now++;
  status = 401;
  assert.match((await http.read("a", "https://crs.example", TEST_KEY)).error!, /无效/);
  status = 200;
  assert.ok((await http.read("rotated", "https://crs.example", "sk-test-new")).error);
  assert.equal(calls, 3);
  http.close();
});
