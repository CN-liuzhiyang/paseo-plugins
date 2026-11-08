import http from "node:http";
import { readFile } from "node:fs/promises";
export const TEST_KEY = "sk-test-xxxx";
export type Mode =
  | "normal"
  | "limited"
  | "missing"
  | "expired"
  | "disabled"
  | "down"
  | "slow"
  | "body_slow"
  | "redirect"
  | "management_https"
  | "integration"
  | "pool"
  | "tokens"
  | "tokens_null"
  | "cost"
  | "cost_unlimited"
  | "cost_legacy"
  | "cost_null"
  | "account_names"
  | "fresh"
  | "older"
  | "reset"
  | "echo";
export async function fixture(name = "snapshot") {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}
export async function startFakeCrs() {
  let mode: Mode = "normal";
  let requests = 0;
  let aborted = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/apiStats/api/usage-snapshot") {
      res.writeHead(404).end();
      return;
    }
    requests++;
    req.on("close", () => {
      if (!res.writableEnded) aborted++;
    });
    if (req.headers["x-api-key"] !== TEST_KEY) {
      res.writeHead(401).end();
      return;
    }
    if (mode === "slow") return;
    if (mode === "management_https") {
      res.writeHead(403, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error: "Management HTTPS required",
          managementUrl: `https://untrusted.example/${TEST_KEY}`,
        }),
      );
      return;
    }
    if (mode === "body_slow") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
      return;
    }
    if (mode === "down") {
      res.writeHead(503, { "Retry-After": "60" }).end("unavailable");
      return;
    }
    if (mode === "redirect") {
      res.writeHead(302, { Location: "/never-follow" }).end();
      return;
    }
    if (mode === "expired" || mode === "disabled") {
      res
        .writeHead(403, { "Content-Type": "application/json" })
        .end(JSON.stringify({ key: { status: mode } }));
      return;
    }
    const data = await fixture(
      mode === "integration"
        ? "integration-snapshot"
        : mode === "pool"
          ? "pool-snapshot"
          : "snapshot",
    );
    if (mode === "tokens" || mode === "tokens_null" || mode.startsWith("cost")) {
      data.tokenDays = await fixture("token-days");
      if (mode === "cost_unlimited") {
        data.key.daily.limit = null;
        data.key.total.limit = null;
      }
      if (mode === "cost_legacy") for (const day of data.tokenDays.days) delete day.cost;
      if (mode === "cost_null") data.tokenDays.days[29].cost = null;
      if (mode === "tokens_null")
        for (const day of data.tokenDays.days) {
          for (const field of ["input", "output", "cacheCreate", "cacheRead", "requests"])
            day[field] = null;
          day.models = null;
        }
    }
    if (mode === "account_names") {
      data.pools[0].accounts[0].name = "工作账号 · 研发一组";
      data.pools[0].accounts[1].name =
        '<img src=x onerror="globalThis.accountNameExecuted=true"> & 长名称验证 '.repeat(8);
      data.pools[1].accounts[0].name = '测试 "Codex" <团队> & 研发';
      data.pools[1].accounts[1].name = "不可用测试账号 · 长名称".repeat(15);
      data.pools[1].accounts[1].state = "unavailable";
    }
    if (mode === "pool") {
      const shift = Date.now() - Date.parse(data.serverTime);
      data.serverTime = new Date(Date.now()).toISOString();
      for (const pool of data.pools)
        for (const account of pool.accounts) {
          account.observedAt = new Date(Date.parse(account.observedAt) + shift).toISOString();
          for (const window of account.windows)
            if (window.resetsAt)
              window.resetsAt = new Date(Date.parse(window.resetsAt) + shift).toISOString();
        }
    }
    if (["fresh", "older", "reset"].includes(mode)) {
      const now = Date.now();
      data.serverTime = new Date(now).toISOString();
      data.pools = [data.pools[0]];
      data.pools[0].accounts = [data.pools[0].accounts[0]];
      const account = data.pools[0].accounts[0];
      account.stale = mode !== "fresh";
      account.observedAt = new Date(now - (mode === "fresh" ? 6 : 8) * 60000).toISOString();
      account.windows[0].usedPct = 19;
      for (const window of account.windows)
        window.resetsAt = new Date(
          now + (mode === "reset" ? -60000 : window.id === "5h" ? 3600000 : 86400000),
        ).toISOString();
      account.windows.push({ id: "week_opus", usedPct: null, resetsAt: null });
    }
    if (mode === "limited") {
      data.pools[0].accounts[1].state = "rate_limited";
      data.pools[0].accounts[1].limitedUntil = "2026-11-08T09:00:00Z";
      data.pools[0].accounts[1].windows[0].usedPct = 96;
    }
    if (mode === "missing") {
      for (const pool of data.pools)
        for (const account of pool.accounts) {
          account.windows.forEach((w: { usedPct: number | null }) => {
            w.usedPct = null;
          });
          account.observedAt = null;
          account.stale = true;
          account.state = "unknown";
          account.unavailableReason = "snapshot_missing";
        }
      data.errors.push({ scope: "pool:claude", code: "snapshot_missing" });
    }
    if (mode === "echo") {
      data.key.name = TEST_KEY;
      data.pools[0].accounts[0].alias = TEST_KEY;
      data.unexpected = { apiKey: TEST_KEY, email: "private@example.test" };
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setMode(value: Mode) {
      mode = value;
    },
    get requests() {
      return requests;
    },
    get aborted() {
      return aborted;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
