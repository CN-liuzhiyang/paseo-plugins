import assert from "node:assert/strict";
import { test } from "node:test";
import { CrsClient } from "../server/crs-client";
import { mapUsage } from "../server/usage";
import { snapshotSchema } from "../shared/snapshot";
import {
  formatTokens,
  summarizeTokens,
  TOKEN_FIELDS,
  tokenDaysSchema,
  tokenTotal,
  type TokenDays,
} from "../shared/tokens";
import { fixture, TEST_KEY } from "./fake-crs";

const counts = (value: number | null) => ({
  input: value,
  output: value,
  cacheCreate: value,
  cacheRead: value,
  requests: value,
});

test("token ranges use CRS calendar dates, merge model names and other, and preserve the input/cache distinction", () => {
  const data: TokenDays = {
    timezoneOffset: 8,
    days: [
      { date: "2026-10-11", ...counts(100), models: [{ model: "other", ...counts(100) }] },
      {
        date: "2026-11-02",
        ...counts(10),
        models: [
          { model: "sonnet", ...counts(8) },
          { model: "other", ...counts(2) },
        ],
      },
      {
        date: "2026-11-08",
        input: 4,
        output: 99,
        cacheCreate: 6,
        cacheRead: 30,
        requests: 2,
        models: [
          { model: "sonnet", input: 4, output: 99, cacheCreate: 6, cacheRead: 20, requests: 1 },
          { model: "other", input: 0, output: 0, cacheCreate: 0, cacheRead: 10, requests: 1 },
        ],
      },
    ],
  };
  const before = JSON.stringify(data);
  const today = summarizeTokens(data, 1)!;
  assert.equal(today.requests, 2);
  assert.equal(today.total, 139);
  assert.equal(today.hitRate, 75); // Output is excluded; input is not reduced by cache tokens again.
  const week = summarizeTokens(data, 7)!;
  assert.equal(week.requests, 12);
  assert.equal(week.cacheRead, 40);
  assert.equal(week.models.length, 2);
  assert.equal(week.models.find((model) => model.model === "other")?.cacheRead, 12);
  assert.equal(week.models.find((model) => model.model === "sonnet")?.requests, 9);
  assert.deepEqual(
    week.models.map((model) => model.model),
    ["sonnet", "other"],
  );
  assert.equal(summarizeTokens(data, 30)!.requests, 112); // Inclusive 30th day.
  data.days.push({ date: "2026-11-09", ...counts(1), models: [] });
  assert.equal(summarizeTokens(data, 1)!.requests, 1); // Server's last day, not the client's local date.
  data.days.pop();
  assert.equal(JSON.stringify(data), before);
});

test("unknown token fields poison only their own sums; zero records and unknown records stay distinct", () => {
  const data: TokenDays = {
    timezoneOffset: -5,
    days: [
      { date: "2026-11-07", ...counts(10), models: [{ model: "sonnet", ...counts(10) }] },
      { date: "2026-11-08", ...counts(0), models: [] },
    ],
  };
  const today = summarizeTokens(data, 1)!;
  assert.equal(today.hitRate, null);
  assert.equal(today.requests, 0);
  assert.equal(today.total, 0);
  assert.ok(Math.abs(summarizeTokens(data, 7)!.hitRate! - 100 / 3) < 1e-12);
  data.days[1].output = null;
  let summary = summarizeTokens(data, 7)!;
  assert.equal(summary.output, null);
  assert.equal(summary.input, 10);
  assert.equal(summary.total, null);
  assert.ok(Math.abs(summary.hitRate! - 100 / 3) < 1e-12);
  data.days[1].input = null;
  summary = summarizeTokens(data, 7)!;
  assert.equal(summary.hitRate, null);
  data.days[1].requests = null;
  assert.equal(summarizeTokens(data, 7)!.requests, null);
  data.days[1].models = null;
  assert.equal(summarizeTokens(data, 7)!.models[0].cacheRead, null);
  data.days[1] = { date: "2026-11-08", ...counts(null), models: null };
  assert.equal(summarizeTokens(data, 1), null);
  assert.ok(summarizeTokens(data, 7));
  data.days[0] = { date: "2026-11-07", ...counts(null), models: null };
  assert.equal(summarizeTokens(data, 30), null);
});

test("token extension is optional and isolated from the native quota report and old-server snapshots", async () => {
  const raw = await fixture();
  const legacy = snapshotSchema.parse(raw);
  assert.equal(legacy.tokenDays, undefined);
  assert.equal(summarizeTokens(legacy.tokenDays, 1), null);
  assert.equal(summarizeTokens(null, 7), null);
  assert.equal(summarizeTokens({ timezoneOffset: 8, days: [] }, 30), null);
  const tokenDays = tokenDaysSchema.parse(await fixture("token-days"));
  const extended = snapshotSchema.parse({ ...raw, tokenDays });
  assert.deepEqual(extended.tokenDays, tokenDays);
  assert.deepEqual(mapUsage(extended), mapUsage(legacy));
  assert.deepEqual(mapUsage(snapshotSchema.parse({ ...raw, tokenDays: null })), mapUsage(legacy));
  const malformed = snapshotSchema.parse({ ...raw, tokenDays: { days: "invalid" } });
  assert.equal(malformed.tokenDays, undefined);
  assert.deepEqual(mapUsage(malformed), mapUsage(legacy));
});

test("30-day fixture: each daily model breakdown sums exactly; range totals and units remain finite", async () => {
  const data = tokenDaysSchema.parse(await fixture("token-days"));
  assert.equal(data.days.length, 30);
  for (const day of data.days)
    for (const field of TOKEN_FIELDS)
      assert.equal(
        day.models!.reduce((sum, model) => sum + model[field]!, 0),
        day[field],
      );
  assert.equal(summarizeTokens(data, 1)!.requests, 747);
  assert.equal(summarizeTokens(data, 1)!.cacheRead, 30000000);
  assert.equal(summarizeTokens(data, 7)!.cacheRead, 189000000);
  assert.equal(summarizeTokens(data, 30)!.cacheRead, 465000000);
  for (const range of [1, 7, 30] as const) {
    const summary = summarizeTokens(data, range)!;
    assert.equal(summary.models.length, 4);
    assert.equal(tokenTotal(summary), summary.total);
    for (const field of TOKEN_FIELDS)
      assert.equal(
        summary.models.reduce((sum, model) => sum + model[field]!, 0),
        summary[field],
      );
  }
});

test("tokens use M everywhere: sub-0.01M, two/one decimals, integer millions and grouping", () => {
  for (const [value, expected] of [
    [null, "—"],
    [0, "<0.01M"],
    [12, "<0.01M"],
    [9999, "<0.01M"],
    [10000, "0.01M"],
    [12345, "0.01M"],
    [1234567, "1.23M"],
    [9999000, "10.0M"],
    [10000000, "10.0M"],
    [63200000, "63.2M"],
    [99999999, "100M"],
    [100000000, "100M"],
    [22986000000, "22,986M"],
    [1000000000, "1,000M"],
  ] as const)
    assert.equal(formatTokens(value), expected);
});

test("HTTP boundary retains additive token data, redacts echoed keys in model names and keeps it off native output", async () => {
  const raw = await fixture();
  raw.tokenDays = await fixture("token-days");
  raw.tokenDays.days[29].models[0].model = TEST_KEY;
  const http = new CrsClient({ fetch: async () => new Response(JSON.stringify(raw)) });
  try {
    const result = await http.read("tokens", "https://synthetic.example", TEST_KEY);
    assert.equal(result.error, null);
    assert.equal(result.snapshot!.tokenDays!.days[29].models![0].model, "[redacted]");
    assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
    assert.equal(JSON.stringify(mapUsage(result.snapshot!)).includes("tokenDays"), false);
  } finally {
    http.close();
  }
});
