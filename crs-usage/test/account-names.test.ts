import assert from "node:assert/strict";
import { test } from "node:test";
import { CrsClient } from "../server/crs-client";
import { mapUsage } from "../server/usage";
import { snapshotSchema } from "../shared/snapshot";
import { fixture, TEST_KEY } from "./fake-crs";

test("account names are optional plain strings; alias order and field projection stay unchanged", async () => {
  const original = await fixture();
  const legacy = snapshotSchema.parse(original);
  assert.ok(legacy.pools.every((pool) => pool.accounts.every((a) => !("name" in a))));
  const names = [
    "工作账号 · 研发一组",
    '<img src=x onerror="alert(1)"> & "长名称" '.repeat(40),
    "",
  ];
  original.pools[0].accounts.forEach((account: Record<string, unknown>, index: number) => {
    account.name = names[index];
    account.email = "synthetic@example.test";
    account.id = "synthetic-account-id";
    account.token = TEST_KEY;
  });
  const parsed = snapshotSchema.parse(original);
  assert.deepEqual(
    parsed.pools[0].accounts.map((a) => a.name),
    names,
  );
  assert.deepEqual(
    parsed.pools[0].accounts.map((a) => a.alias),
    legacy.pools[0].accounts.map((a) => a.alias),
  );
  for (const account of parsed.pools[0].accounts) {
    assert.ok(!("email" in account));
    assert.ok(!("id" in account));
    assert.ok(!("token" in account));
  }
  assert.deepEqual(mapUsage(parsed), mapUsage(legacy));
});

test("HTTP retains authorized names, redacts an echoed key in names and keeps native output unchanged", async () => {
  const original = await fixture();
  const legacy = snapshotSchema.parse(original);
  original.pools[0].accounts[0].name = `工作账号 ${TEST_KEY}`;
  original.pools[0].accounts[1].name = '<script>alert("synthetic")</script> & 研发';
  const client = new CrsClient({ fetch: async () => new Response(JSON.stringify(original)) });
  try {
    const result = await client.read("names", "https://synthetic.example", TEST_KEY);
    assert.equal(result.error, null);
    assert.ok(result.snapshot!.pools[0].accounts[0].name!.startsWith("工作账号 "));
    assert.ok(!JSON.stringify(result).includes(TEST_KEY));
    assert.equal(result.snapshot!.pools[0].accounts[1].name, original.pools[0].accounts[1].name);
    assert.deepEqual(mapUsage(result.snapshot!), mapUsage(legacy));
  } finally {
    client.close();
  }
});
