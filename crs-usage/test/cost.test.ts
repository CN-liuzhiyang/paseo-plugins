import assert from "node:assert/strict";
import { test } from "node:test";
import { costView, rangeCost, totalQuotaTime } from "../shared/cost";
import { snapshotSchema } from "../shared/snapshot";
import { summarizeTokens } from "../shared/tokens";
import { mapUsage } from "../server/usage";
import { CrsClient } from "../server/crs-client";
import { fixture, TEST_KEY } from "./fake-crs";

async function sample() {
  return snapshotSchema.parse({ ...(await fixture()), tokenDays: await fixture("token-days") });
}

test("cost follows the same CRS calendar ranges as tokens; daily spending matches today's cost", async () => {
  const snapshot = await sample();
  const before = JSON.stringify(snapshot);
  assert.equal(snapshot.tokenDays!.days.at(-1)!.cost, snapshot.key.daily.used);
  assert.equal(rangeCost(snapshot, 1), 12.3);
  assert.equal(rangeCost(snapshot, 7)?.toFixed(2), "77.49");
  assert.equal(rangeCost(snapshot, 30)?.toFixed(2), "190.65");
  assert.equal(costView(snapshot, 7, "used").label, "7 天费用");
  assert.equal(costView(snapshot, 30, "used").label, "30 天费用");
  assert.equal(summarizeTokens(snapshot.tokenDays, 7)!.cacheRead, 189000000);
  assert.equal(JSON.stringify(snapshot), before);
  // Exclude the inclusive-range boundary's preceding day, irrespective of local timezone.
  snapshot.tokenDays!.days[22].cost = 10000;
  assert.equal(rangeCost(snapshot, 7)?.toFixed(2), "77.49");
  snapshot.tokenDays!.days[23].cost = 0;
  assert.equal(rangeCost(snapshot, 7)?.toFixed(2), "67.65");
});

test("cost limits: daily only today; total is independent and optional; remaining uses only applicable limits", async () => {
  const snapshot = await sample();
  const today = costView(snapshot, 1, "used");
  assert.equal(today.label, "今日费用");
  assert.equal(today.value, 12.3);
  assert.equal(today.daily?.usedPct, 41);
  assert.equal(today.total?.usedPct, 81);
  assert.equal(costView(snapshot, 1, "remaining").value, 17.7);
  assert.equal(costView(snapshot, 1, "remaining").total?.value, 19);
  for (const range of [7, 30] as const) {
    const used = costView(snapshot, range, "used");
    const remaining = costView(snapshot, range, "remaining");
    assert.equal(used.daily, null);
    assert.equal(remaining.daily, null);
    assert.equal(remaining.remaining, false);
    assert.equal(remaining.value, used.value);
    assert.equal(remaining.total?.value, 19);
  }
  snapshot.key.daily.limit = null;
  snapshot.key.total.limit = null;
  for (const range of [1, 7, 30] as const) {
    const remaining = costView(snapshot, range, "remaining");
    assert.equal(remaining.remaining, false);
    assert.equal(remaining.daily, null);
    assert.equal(remaining.total, null);
    assert.equal(remaining.value, rangeCost(snapshot, range));
  }
  snapshot.key.daily.limit = 0;
  snapshot.key.total.limit = 0;
  assert.equal(costView(snapshot, 1, "remaining").value, 0);
  assert.equal(costView(snapshot, 1, "used").daily?.usedPct, 100);
  assert.equal(costView(snapshot, 1, "used").total?.usedPct, 100);
  snapshot.key.total.used = null;
  assert.equal(costView(snapshot, 1, "used").total?.usedPct, null);
  assert.equal(costView(snapshot, 1, "remaining").total?.value, null);
});

test("legacy cost fields fall back to today's key spending only; never substitute lifetime spending", async () => {
  const snapshot = await sample();
  for (const day of snapshot.tokenDays!.days) delete day.cost;
  assert.ok(summarizeTokens(snapshot.tokenDays, 30));
  assert.equal(rangeCost(snapshot, 1), 12.3);
  assert.equal(rangeCost(snapshot, 7), null);
  assert.equal(rangeCost(snapshot, 30), null);
  snapshot.key.total.used = 99999;
  assert.equal(costView(snapshot, 7, "remaining").value, null);
  snapshot.tokenDays = undefined;
  assert.equal(rangeCost(snapshot, 1), 12.3);
  assert.equal(rangeCost(snapshot, 30), null);
  snapshot.key.daily.used = null;
  assert.equal(rangeCost(snapshot, 1), null);
});

test("cost null propagates within the selected range; zero stays zero and missing old fields stay distinct", async () => {
  const snapshot = await sample();
  snapshot.tokenDays!.days[23].cost = null;
  assert.equal(rangeCost(snapshot, 1), 12.3);
  assert.equal(rangeCost(snapshot, 7), null);
  snapshot.tokenDays!.days[29].cost = null;
  assert.equal(rangeCost(snapshot, 1), null); // Read failure does not use the legacy fallback.
  assert.equal(costView(snapshot, 1, "remaining").value, null);
  assert.equal(costView(snapshot, 1, "used").daily?.usedPct, null);
  for (const day of snapshot.tokenDays!.days) day.cost = 0;
  assert.equal(rangeCost(snapshot, 30), 0);
  assert.equal(costView(snapshot, 1, "remaining").value, 30);
  delete snapshot.tokenDays!.days[0].cost;
  assert.equal(rangeCost(snapshot, 7), 0);
  assert.equal(rangeCost(snapshot, 30), null);
});

test("total quota countdown uses the earliest reset or expiry, with no unknown-time placeholder", () => {
  const now = Date.parse("2026-11-08T03:00:00Z");
  const reset = "2026-11-08T06:36:00Z";
  const expiry = "2026-11-13T06:00:00Z";
  assert.equal(totalQuotaTime(reset, expiry, now), "3 小时 36 分后重置");
  assert.equal(totalQuotaTime(null, expiry, now), "5 天 3 小时后到期");
  assert.equal(totalQuotaTime(expiry, reset, now), "3 小时 36 分后到期");
  assert.equal(totalQuotaTime(null, new Date(now - 1).toISOString(), now), "已到期");
  assert.equal(totalQuotaTime(null, null, now), null);
});

test("cost extension survives HTTP projection and has no effect on native daily spending", async () => {
  const snapshot = await sample();
  const legacy = snapshotSchema.parse(await fixture());
  const http = new CrsClient({ fetch: async () => new Response(JSON.stringify(snapshot)) });
  try {
    const result = await http.read("cost", "https://synthetic.example", TEST_KEY);
    assert.equal(result.error, null);
    assert.equal(rangeCost(result.snapshot!, 7)?.toFixed(2), "77.49");
    assert.deepEqual(mapUsage(result.snapshot!), mapUsage(legacy));
  } finally {
    http.close();
  }
});
