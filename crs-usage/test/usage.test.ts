import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CrsClient } from "../server/crs-client";
import { discover, originOf } from "../server/discovery";
import { UsageService } from "../server/service";
import { mapUsage, shortUsageError } from "../server/usage";
import { settingsDefinition } from "../shared/settings";
import {
  compactReset,
  estimate,
  estimateWindow,
  relativeCollection,
  relativeReset,
  snapshotSchema,
  windowState,
} from "../shared/snapshot";
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
    env: { HOME: dir, USERPROFILE: dir },
    settings: settingsDefinition.schema.parse({ allowedOrigins: [origin], piConfigDir: dir }),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
test("candidates: automatic defaults, merging, optional filters, separate keys/origins and session directories", async () => {
  const c = await config();
  try {
    assert.equal(
      (
        await discover(
          settingsDefinition.schema.parse({ piConfigDir: c.dir }),
          { kind: "global" },
          c.env,
        )
      ).length,
      1,
    );
    const entries = await discover(c.settings, { kind: "global" }, c.env);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].providers.length, 2);
    assert.equal(JSON.stringify(entries.map((e) => ({ id: e.id }))).includes(TEST_KEY), false);
    assert.deepEqual(
      await discover(c.settings, { kind: "session", provider: "codex", env: c.env }),
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
    assert.equal((await discover(c.settings, { kind: "global" }, c.env)).length, 2);
    c.models.providers["crs-codex"].baseUrl = "https://other.example/openai";
    c.auth["crs-codex"].key = TEST_KEY;
    await writeFile(path.join(c.dir, "models.json"), JSON.stringify(c.models));
    await writeFile(path.join(c.dir, "auth.json"), JSON.stringify(c.auth));
    assert.equal(
      (
        await discover(
          { ...c.settings, allowedOrigins: [], providerNames: ["crs-codex"] },
          { kind: "global" },
          c.env,
        )
      ).length,
      1,
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
  const mapped = mapUsage(snapshot);
  assert.equal(mapped.status, "available");
  if (mapped.status !== "available") return;
  assert.equal(mapped.windows.length, 4);
  assert.equal(mapped.balances?.[0].used, 12.3);
  assert.equal(mapped.balances?.length, 1);
  assert.ok(
    Math.abs(
      estimate(snapshot.pools[0], snapshot.serverTime).usedPct! - (20 * 22 + 5 * 55 + 90) / 26,
    ) < 0.00001,
  );
  for (const state of ["normal", "rate_limited", "unavailable", "unknown"] as const) {
    snapshot.pools[0].accounts[0].state = state;
    assert.equal(mapUsage(snapshot).status, "available");
  }
  const account = snapshot.pools[0].accounts[0];
  account.windows[0].usedPct = null;
  account.stale = true;
  const partial = mapUsage(snapshot);
  assert.equal(estimate(snapshot.pools[0], snapshot.serverTime).included, 2);
  if (partial.status === "available") {
    assert.equal(
      partial.windows.some((window) => window.label.includes(account.alias)),
      false,
    );
    assert.equal(JSON.stringify(partial.details).includes(account.alias), false);
  }
  for (const a of snapshot.pools[1].accounts) a.tier = "unknown";
  assert.equal(estimate(snapshot.pools[1], snapshot.serverTime).usedPct, null);
  snapshot.key.daily.limit = 0;
  snapshot.key.daily.used = 3;
  const exhausted = mapUsage(snapshot);
  if (exhausted.status === "available") assert.equal(exhausted.balances?.[0].used, 3);
  for (const status of ["expired", "disabled", "inactive"] as const) {
    snapshot.key.status = status;
    assert.equal(mapUsage(snapshot).status, "error");
  }
});
test("real HTTP: single flight, 12s interval, exponential backoff, Retry-After and shared panel/native reader", async () => {
  const fake = await startFakeCrs();
  const c = await config(fake.origin);
  let now = Date.now();
  const http = new CrsClient({ now: () => now, random: () => 0 });
  const service = new UsageService(async () => c.settings, http, c.env);
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
    c.settings.providerNames = ["removed-provider"];
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
    c.env,
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
  const before = mapUsage(snapshot);
  snapshot.pools[0].accounts.reverse();
  const after = mapUsage(snapshot);
  if (before.status === "available" && after.status === "available") {
    assert.deepEqual(
      Object.fromEntries(before.windows.map((w) => [w.label, w.id])),
      Object.fromEntries(after.windows.map((w) => [w.label, w.id])),
    );
  } else assert.fail("fixture should map successfully");
  http.close();
  oversized.close();
});
test("unknown-duration windows remain in the snapshot for the full panel; native spending and inactive errors remain accurate", async () => {
  const raw = await fixture();
  raw.pools[1].accounts[0].windows[0].id = "primary";
  raw.pools[1].accounts[0].windows[1].id = "secondary";
  const snapshot = snapshotSchema.parse(raw);
  const report = mapUsage(snapshot);
  assert.equal(report.status, "available");
  assert.equal(estimate(snapshot.pools[1], snapshot.serverTime).included, 1);
  if (report.status === "available") {
    assert.equal(
      report.windows.some((w) => /primary|secondary|时长未知/.test(w.label)),
      false,
    );
    assert.equal(snapshot.pools[1].accounts[0].windows[0].id, "primary");
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

test("automatic HTTPS: same hostname on 443, cached destination, no body URL or redirects, optional override", async () => {
  const fake = await startFakeCrs();
  const c = await config(fake.origin);
  c.settings.allowedOrigins = [];
  const calls: string[] = [];
  let now = Date.now();
  let redirect = false;
  const service = new UsageService(
    async () => c.settings,
    new CrsClient({
      now: () => now,
      random: () => 0,
      fetch: async (input, options) => {
        const url = String(input);
        calls.push(url);
        assert.equal(options?.redirect, "error");
        assert.equal((options?.headers as Record<string, string>)["x-api-key"], TEST_KEY);
        if (url.startsWith("http:")) fake.setMode("management_https");
        else fake.setMode(redirect ? "redirect" : "normal");
        // Routing is injected; production uses unmodified Node TLS certificate validation.
        return fetch(`${fake.origin}/apiStats/api/usage-snapshot`, options);
      },
    }),
    c.env,
  );
  try {
    const [account] = await service.discover({ kind: "global" });
    assert.ok(account);
    assert.deepEqual(calls, [
      `${fake.origin}/apiStats/api/usage-snapshot`,
      "https://127.0.0.1/apiStats/api/usage-snapshot",
    ]);
    assert.equal((await service.fetch(account.input)).status, "available");
    const [panel] = await service.panel();
    assert.equal(panel.links.usage, "https://127.0.0.1/apiStats/");
    assert.equal(JSON.stringify([panel, account]).includes(TEST_KEY), false);
    now += 12000;
    await service.panel();
    assert.equal(calls.length, 3);
    assert.equal(calls[2], "https://127.0.0.1/apiStats/api/usage-snapshot");
    c.settings.managementOrigin = "https://management.example/";
    assert.equal((await service.fetch(account.input)).status, "available");
    assert.equal(calls[3], "https://management.example/apiStats/api/usage-snapshot");
    assert.equal((await service.panel())[0].links.usage, "https://management.example/apiStats/");
    c.settings.managementOrigin = "https://other-management.example";
    redirect = true;
    assert.equal((await service.fetch(account.input)).status, "error");
    // Fetch the panel after detection of the new endpoint: redirects are not recognized as CRS.
    assert.deepEqual(await service.panel(), []);
    assert.equal(calls.length, 5);
    assert.equal(
      calls.some((url) => url.includes("untrusted.example") || url.includes(TEST_KEY)),
      false,
    );
    for (const value of [
      "http://management.example",
      "https://user:pass@management.example",
      "https://management.example/path",
      "https://management.example/?key=secret",
      "https://management.example/#secret",
    ])
      assert.equal(settingsDefinition.schema.safeParse({ managementOrigin: value }).success, false);
    assert.equal(settingsDefinition.schema.parse({}).managementOrigin, "");
  } finally {
    service.close();
    await fake.close();
    await c.close();
  }
});

test("automatic recognition: positive 24h and negative 10m cache, JSON 200/401/403, non-CRS hidden, rotation re-probes", async () => {
  const c = await config();
  c.settings.allowedOrigins = [];
  let now = Date.now();
  let calls = 0;
  let response = () => new Response("missing", { status: 404 });
  const service = new UsageService(
    async () => c.settings,
    new CrsClient({
      now: () => now,
      random: () => 0,
      fetch: async () => {
        calls++;
        return response();
      },
    }),
    c.env,
  );
  try {
    assert.deepEqual(await service.discover({ kind: "global" }), []);
    now += 599999;
    assert.deepEqual(await service.identities(), []);
    assert.equal(calls, 1);
    now++;
    response = () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    assert.equal((await service.identities()).length, 1);
    assert.equal(calls, 2);
    now += 600000;
    assert.equal((await service.identities()).length, 1);
    assert.equal(calls, 2);
    assert.equal((await service.fetch({ id: (await service.identities())[0].id })).status, "error");
    c.auth["crs-codex"].key = "sk-test-rotated";
    c.auth["crs-claude"].key = "sk-test-rotated";
    await writeFile(path.join(c.dir, "auth.json"), JSON.stringify(c.auth));
    assert.equal((await service.identities()).length, 1);
    assert.equal(calls, 4);
    now += 86400000;
    response = () => new Response("<html>not CRS</html>");
    assert.deepEqual(await service.identities(), []);
    const afterHtml = calls;
    now += 100000;
    assert.deepEqual(await service.identities(), []);
    assert.equal(calls, afterHtml);
    // Connectivity failures and non-JSON 401/403 are hidden too.
    for (const mode of ["offline", "401", "403"] as const) {
      now += 600000;
      response = () => {
        if (mode === "offline") throw new Error(TEST_KEY);
        return new Response("no JSON", { status: Number(mode) });
      };
      assert.deepEqual(await service.identities(), []);
    }
    now += 600000;
    response = () => new Response(JSON.stringify({ key: { status: "expired" } }), { status: 403 });
    assert.equal((await service.identities()).length, 1);
  } finally {
    service.close();
    await c.close();
  }
});

test("source files: Pi + Claude Code + selected Codex custom provider merge; official domains never probed; unreadable sources skip", async () => {
  const c = await config();
  const claudeDir = path.join(c.dir, ".claude");
  const codexDir = path.join(c.dir, ".codex");
  await mkdir(claudeDir);
  await mkdir(codexDir);
  const writeClaude = (base = "https://crs.example", token = TEST_KEY) =>
    writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token } }),
    );
  await writeClaude();
  await writeFile(
    path.join(codexDir, "config.toml"),
    'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://crs.example/v1"\n[model_providers.unused]\nbase_url = "https://never-probe.example"\n',
  );
  await writeFile(path.join(codexDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: TEST_KEY }));
  c.settings.allowedOrigins = [];
  let calls = 0;
  const raw = await fixture();
  const service = new UsageService(
    async () => c.settings,
    new CrsClient({
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify(raw));
      },
    }),
    c.env,
  );
  try {
    const [account] = await service.discover({ kind: "global" });
    assert.equal(calls, 1);
    assert.equal((await service.identities())[0].providers.length, 4);
    assert.match(account.harness!, /Claude Code.*Codex/);
    const panel = await service.panel();
    assert.equal(JSON.stringify([account, panel]).includes(TEST_KEY), false);
    c.settings.providerNames = ["custom"];
    assert.deepEqual((await service.identities())[0].providers, ["custom"]);
    c.settings.providerNames = [];
    c.models.providers["crs-claude"].baseUrl = "https://api.anthropic.com/v1";
    c.models.providers["crs-codex"].baseUrl = "https://sub.api.openai.com/v1";
    await writeFile(path.join(c.dir, "models.json"), JSON.stringify(c.models));
    await writeClaude("https://sub.api.anthropic.com/v1");
    await writeFile(
      path.join(codexDir, "config.toml"),
      'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.openai.com/v1"',
    );
    assert.deepEqual(await service.identities(), []);
    assert.equal(calls, 1);
    assert.equal((await service.fetch(account.input)).status, "error");
    await writeFile(path.join(codexDir, "config.toml"), "invalid = [");
    await writeFile(path.join(claudeDir, "settings.json"), "bad");
    assert.deepEqual(await service.identities(), []);
    // API_KEY alternative and session-specific config homes are read without touching the user's files.
    await writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://crs.example", ANTHROPIC_API_KEY: TEST_KEY },
      }),
    );
    assert.equal(
      (
        await discover(
          c.settings,
          { kind: "session", provider: "claude", env: { HOME: c.dir } },
          c.env,
        )
      ).length,
      1,
    );
    await writeFile(
      path.join(codexDir, "config.toml"),
      'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://crs.example/v1"',
    );
    assert.equal(
      (
        await discover(
          c.settings,
          { kind: "session", provider: "codex", env: { CODEX_HOME: codexDir } },
          c.env,
        )
      ).length,
      1,
    );
  } finally {
    service.close();
    await c.close();
  }
});
test("integration fixture: unlimited costs, expired windows, unusable accounts and partial estimates keep their meanings", async () => {
  const snapshot = snapshotSchema.parse(await fixture("integration-snapshot"));
  const report = mapUsage(snapshot);
  assert.equal(report.status, "available");
  const claude = snapshot.pools[0];
  const summary = estimate(claude, snapshot.serverTime);
  assert.equal(summary.usedPct, 11);
  assert.equal(summary.included, 2);
  assert.equal(summary.total, 4);
  assert.equal(
    windowState(claude.accounts[1], claude.accounts[1].windows[0], snapshot.serverTime),
    "reset",
  );
  if (report.status === "available") {
    assert.equal(report.balances?.[0].limit, undefined);
    assert.equal(report.balances?.[0].used, 12.3);
    assert.equal(report.balances?.[0].remaining, undefined);
    assert.equal(report.balances![0].label, "今日费用");
    const old = report.windows.filter((window) => window.label.includes("Claude-B"));
    assert.equal(old.length, 0);
    assert.equal(/Claude-[A-D]/.test(JSON.stringify(report.details)), false);
    assert.equal(
      report.windows.some((window) => /Claude-C|Claude-D/.test(window.label)),
      false,
    );
    assert.equal(
      report.windows.some((window) => window.label.includes("时长未知")),
      false,
    );
  }
  // Details hide the old value; the pool counts the reset account as unused.
  const current = claude.accounts[0];
  current.windows[0].resetsAt = snapshot.serverTime;
  assert.equal(windowState(current, current.windows[0], snapshot.serverTime), "reset");
  assert.equal(windowState(current, current.windows[1], snapshot.serverTime), "current");
  assert.equal(estimate(claude, snapshot.serverTime).usedPct, 0);
});

test("native pool card: shared weighted estimates, stable window IDs, no details or badge", async () => {
  const snapshot = snapshotSchema.parse(await fixture());
  const pool = snapshot.pools[0];
  pool.accounts[0].windows[0].usedPct = 90;
  pool.accounts[0].windows[1].usedPct = 10;
  pool.accounts[1].windows[0].usedPct = 20;
  pool.accounts[1].windows[1].usedPct = 95;
  pool.accounts[2].windows.push({ id: "week_opus", usedPct: 100, resetsAt: null });
  const report = mapUsage(snapshot);
  assert.equal(report.status, "available");
  if (report.status !== "available") return;
  const claude = report.windows.filter((window) => window.label.startsWith("Claude"));
  // Every account keeps its tier weight in both independently estimated windows.
  assert.deepEqual(
    claude.map((window) => window.usedPct),
    [(20 * 90 + 5 * 20 + 90) / 26, (20 * 10 + 5 * 95 + 85) / 26],
  );
  assert.deepEqual(
    claude.map((window) => window.label),
    ["Claude 5小时", "Claude 本周"],
  );
  assert.equal(report.windows.length, 4);
  assert.deepEqual(
    report.details?.map((detail) => detail.id),
    ["claude-reset", "openai-reset", "accounts"],
  );
  assert.match(report.details![2].value, /^Claude 3\/3 · Codex \d\/\d$/);
  assert.equal(report.planLabel, undefined);
  // The reset rows show each window's earliest account reset to the minute, as of the snapshot time.
  const now = Date.parse(snapshot.serverTime);
  for (const [platform, accounts] of [
    ["claude", pool.accounts],
    ["openai", snapshot.pools[1].accounts],
  ] as const)
    assert.equal(
      report.details?.find((detail) => detail.id === `${platform}-reset`)?.value,
      (["5h", "week"] as const)
        .map(
          (id) =>
            `${id === "5h" ? "5小时" : "本周"} ${compactReset(estimate({ accounts }, snapshot.serverTime, id).resetsAt, now)}`,
        )
        .join(" · "),
    );
  assert.equal(JSON.stringify(report).includes("Claude-A"), false);
  const ids = claude.map((window) => window.id);
  pool.accounts[1].windows[0].usedPct = null;
  pool.accounts[1].windows[1].resetsAt = snapshot.serverTime;
  pool.accounts[2].state = "unavailable";
  const switched = mapUsage(snapshot);
  if (switched.status !== "available") return assert.fail("active snapshot");
  assert.deepEqual(
    switched.windows
      .filter((window) => window.label.startsWith("Claude"))
      .map((window) => window.id),
    ids,
  );
  assert.deepEqual(
    switched.windows
      .filter((window) => window.label.startsWith("Claude"))
      .map((window) => window.usedPct),
    [90, 8],
  );
  for (const account of pool.accounts) {
    account.windows[0].usedPct = null;
    account.windows[1].usedPct = null;
    for (const window of account.windows) window.resetsAt = null;
  }
  const missing = mapUsage(snapshot);
  if (missing.status === "available")
    assert.equal(
      missing.windows.some((window) => window.label.startsWith("Claude")),
      false,
    );
  const codex = snapshot.pools[1].accounts;
  codex[0].windows[0].usedPct = 0;
  codex[0].windows[1].usedPct = 0;
  codex[1].state = "unavailable";
  const zero = mapUsage(snapshot);
  if (zero.status === "available") assert.ok(zero.windows.every((window) => window.usedPct === 0));
  // Summaries do not mutate the full per-account snapshot used by the panel.
  assert.equal(pool.accounts.length, 3);
  assert.equal(pool.accounts[2].windows.at(-1)?.id, "week_opus");
});

test("native output: one daily amount, reset rows only while in the future, errors at most 12 characters", async () => {
  const snapshot = snapshotSchema.parse(await fixture());
  snapshot.key.weeklyOpus.used = 3;
  snapshot.key.weeklyOpus.limit = 20;
  let report = mapUsage(snapshot);
  if (report.status !== "available") return assert.fail("active snapshot");
  assert.deepEqual(report.balances, [{ id: "daily", label: "今日费用", used: 12.3, unit: "usd" }]);
  for (const minutes of [31, 30, 1, 0]) {
    for (const account of snapshot.pools[0].accounts) {
      account.windows[0].usedPct = 95;
      account.windows[0].resetsAt = new Date(
        Date.parse(snapshot.serverTime) + minutes * 60000,
      ).toISOString();
    }
    report = mapUsage(snapshot);
    if (report.status !== "available") return assert.fail("active snapshot");
    const window = report.windows.find((window) => window.id === "claude-pool-5h")!;
    assert.equal("resetsAt" in window, false);
    const row = report.details!.find((detail) => detail.id === "claude-reset")?.value ?? "";
    // A window that has already reset shows no countdown; the others keep theirs.
    assert.equal(row.startsWith(`5小时 ${minutes}分`), minutes !== 0);
    assert.equal(window.usedPct, minutes === 0 ? 0 : 95);
    assert.equal(window.tone, minutes === 0 ? "ok" : "warning");
  }
  for (const error of [
    "Key 过期",
    "Key 禁用",
    "Key 无效",
    "Key 未激活",
    "请求超时",
    "请求限流",
    "HTTPS异常",
    "配置变化",
    "快照格式不匹配或数据缺失",
    "拒绝访问",
    "连不上或响应无效",
  ])
    assert.ok(Array.from(shortUsageError(error)).length <= 12);
  assert.equal(shortUsageError("CRS 暂时连不上或响应无效"), "CRS 暂时不可用");
});
test("fresh / older / reset: preserve older values, reset estimates count as zero, null detail cells stay absent", async () => {
  const snapshot = snapshotSchema.parse(await fixture());
  snapshot.pools = [snapshot.pools[0]];
  const pool = snapshot.pools[0];
  pool.accounts = [pool.accounts[0]];
  const account = pool.accounts[0];
  account.observedAt = "2026-11-08T02:52:00Z";
  account.windows = [
    { id: "5h", usedPct: 19, resetsAt: "2026-11-08T04:00:00Z" },
    { id: "week", usedPct: null, resetsAt: "2026-11-08T04:00:00Z" },
    { id: "week_opus", usedPct: null, resetsAt: null },
  ];
  assert.equal(windowState(account, account.windows[0], snapshot.serverTime), "current");
  let report = mapUsage(snapshot);
  if (report.status !== "available") return assert.fail("active snapshot");
  assert.equal(report.windows.length, 1);
  assert.equal(report.windows[0].usedPct, 19);
  assert.equal(report.windows[0].tone, "ok");
  account.stale = true;
  assert.equal(windowState(account, account.windows[0], snapshot.serverTime), "older");
  assert.equal(windowState(account, account.windows[1], snapshot.serverTime), "missing");
  assert.equal(windowState(account, account.windows[2], snapshot.serverTime), "missing");
  assert.equal(estimate(pool, snapshot.serverTime).usedPct, 19);
  assert.equal(estimate(pool, snapshot.serverTime).older, 1);
  report = mapUsage(snapshot);
  if (report.status !== "available") return assert.fail("active snapshot");
  assert.equal(report.windows.length, 1);
  assert.equal(report.windows[0].usedPct, 19);
  assert.equal(report.windows[0].tone, "default");
  assert.deepEqual(
    report.details?.map((detail) => detail.id),
    ["claude-reset", "accounts"],
  );
  assert.equal(JSON.stringify(report).includes("数据已过期"), false);
  account.windows[0].resetsAt = null;
  assert.equal(windowState(account, account.windows[0], snapshot.serverTime), "older");
  account.windows[0].resetsAt = snapshot.serverTime;
  assert.equal(windowState(account, account.windows[0], snapshot.serverTime), "reset");
  assert.equal(estimate(pool, snapshot.serverTime).usedPct, 0);
  report = mapUsage(snapshot);
  if (report.status !== "available") return assert.fail("active snapshot");
  assert.equal(report.windows.length, 1);
  assert.equal(report.windows[0].usedPct, 0);
  assert.deepEqual(
    report.details?.map((detail) => detail.id),
    ["accounts"],
  );
  assert.equal(
    relativeCollection(account.observedAt, Date.parse(snapshot.serverTime)),
    "8 分钟前采集",
  );
  assert.equal(relativeCollection(null), "采集时间未知");
});

test("pool regression: two Pro accounts at 100% and 4%, two unavailable; panel/native agree at 52%", async () => {
  const snapshot = snapshotSchema.parse(await fixture("pool-snapshot"));
  const pool = snapshot.pools[0];
  const [full, low, unavailable] = pool.accounts;
  const untouched = JSON.stringify(snapshot);
  for (const id of ["5h", "week"]) {
    const summary = estimate(pool, snapshot.serverTime, id);
    assert.equal(summary.usedPct, 52);
    assert.equal(summary.included, 2);
    assert.equal(summary.total, 4);
    assert.deepEqual(
      summary.windows.map((window) => window.usedPct),
      [100, 4],
    );
  }
  assert.equal(estimate(pool, snapshot.serverTime).resetsAt, low.windows[0].resetsAt);
  assert.equal(estimate(pool, snapshot.serverTime, "week").resetsAt, full.windows[1].resetsAt);
  const report = mapUsage(snapshot);
  if (report.status !== "available") return assert.fail("active snapshot");
  assert.deepEqual(
    report.windows.map((window) => window.usedPct),
    [52, 52],
  );
  assert.deepEqual(
    report.windows.map((window) => window.label),
    ["Claude 5小时", "Claude 本周"],
  );
  assert.equal(report.details?.find((detail) => detail.id === "accounts")?.value, "Claude 2/4");
  assert.equal(
    report.details?.find((detail) => detail.id === "claude-reset")?.value,
    `5小时 ${compactReset(estimate(pool, snapshot.serverTime).resetsAt, Date.parse(snapshot.serverTime))} · 本周 ${compactReset(estimate(pool, snapshot.serverTime, "week").resetsAt, Date.parse(snapshot.serverTime))}`,
  );
  assert.equal(JSON.stringify(snapshot), untouched);
  // Multiple same-platform bindings use the same estimator across their accounts.
  const split = structuredClone(snapshot);
  split.pools.push({ ...split.pools[0], accounts: split.pools[0].accounts.splice(1) });
  assert.deepEqual(mapUsage(split), report);
  full.state = "rate_limited";
  assert.equal(estimate(pool, snapshot.serverTime).usedPct, 52);
  full.tier = "max5";
  assert.equal(estimate(pool, snapshot.serverTime).usedPct, 84);
  unavailable.state = "normal";
  unavailable.tier = "unknown";
  unavailable.windows = structuredClone(low.windows);
  assert.equal(estimate(pool, snapshot.serverTime).included, 2);
  full.tier = "unknown";
  assert.equal(estimate(pool, snapshot.serverTime).usedPct, 4);
  low.state = "unavailable";
  const empty = mapUsage(snapshot);
  if (empty.status === "available") assert.deepEqual(empty.windows, []);
});

test("pool windows: reset counts as zero even without a value; missing 5h inherits an unreset exhausted week", async () => {
  const snapshot = snapshotSchema.parse(await fixture("pool-snapshot"));
  const pool = snapshot.pools[0];
  const account = pool.accounts[0];
  account.stale = true;
  assert.equal(estimateWindow(account, snapshot.serverTime, "5h")?.usedPct, 100);
  account.windows[0].usedPct = 22;
  assert.equal(estimateWindow(account, snapshot.serverTime, "5h")?.usedPct, 100);
  account.windows.shift();
  assert.equal(estimateWindow(account, snapshot.serverTime, "5h")?.usedPct, 100);
  account.windows.unshift({ id: "5h", usedPct: null, resetsAt: snapshot.serverTime });
  account.windows[1].resetsAt = snapshot.serverTime;
  for (const id of ["5h", "week"]) {
    const summary = estimate(pool, snapshot.serverTime, id);
    assert.equal(summary.usedPct, 2);
    assert.equal(summary.included, 2);
    assert.equal(summary.older, 0);
    assert.equal(
      summary.resetsAt,
      pool.accounts[1].windows.find((window) => window.id === id)?.resetsAt,
    );
    assert.equal(estimateWindow(account, snapshot.serverTime, id)?.usedPct, 0);
  }
  account.windows[0].resetsAt = null;
  assert.equal(estimateWindow(account, snapshot.serverTime, "5h"), null);
  account.windows[1].usedPct = null;
  account.windows[1].resetsAt = null;
  assert.equal(estimateWindow(account, snapshot.serverTime, "week"), null);
  assert.equal(estimate(pool, snapshot.serverTime).included, 1);
  account.state = "unknown";
  account.windows[0].usedPct = 70;
  assert.equal(estimateWindow(account, snapshot.serverTime, "5h"), null);
});

test("reset countdowns: days/hours, hours/minutes, sub-minute, elapsed and absent timestamps", () => {
  const now = Date.parse("2026-11-08T03:00:00Z");
  for (const [milliseconds, expected] of [
    [5 * 86400000 + 3 * 3600000, "5 天 3 小时后重置"],
    [3 * 3600000 + 36 * 60000, "3 小时 36 分后重置"],
    [86400000, "1 天后重置"],
    [3600000, "1 小时后重置"],
    [60000, "1 分钟后重置"],
    [59999, "<1 分钟后重置"],
    [1, "<1 分钟后重置"],
    [0, "等待窗口更新"],
    [-1, "等待窗口更新"],
  ] as const)
    assert.equal(relativeReset(new Date(now + milliseconds).toISOString(), now), expected);
  assert.equal(relativeReset(null, now), "重置时间未知");
});

test("compact reset countdown: exact to the minute, days with hours, unknown and elapsed as a dash", () => {
  const now = Date.parse("2026-11-09T00:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  const min = 60000;
  assert.equal(compactReset(at(30 * 1000), now), "<1分");
  assert.equal(compactReset(at(5 * min), now), "5分");
  assert.equal(compactReset(at(60 * min), now), "1时");
  assert.equal(compactReset(at(80 * min), now), "1时20分");
  assert.equal(compactReset(at(26 * 60 * min), now), "1天2时");
  assert.equal(compactReset(at(48 * 60 * min), now), "2天");
  assert.equal(compactReset(at(0), now), "—");
  assert.equal(compactReset(at(-min), now), "—");
  assert.equal(compactReset(null, now), "—");
});
