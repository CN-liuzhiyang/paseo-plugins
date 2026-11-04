import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFacts, checkReport } from "../server/lib/check.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { fold } from "../server/lib/log.mjs";

// What a look's one sentence may be: 40 characters go through (the prompt says 32), more or a lead of "我看了一眼" is sent back.

const policy = { ...DEFAULT_POLICY, tz: "Asia/Shanghai" };
const now = Date.parse("2026-11-02T10:00:00+08:00");
const lines = [{ kind: "created", id: "D1", title: "洗牙", seq: 1, at: "2026-11-02T09:00:00+08:00" }, { kind: "said", text: "盯一下", via: "chat", by: "user", seq: 2, at: "2026-11-02T09:00:00+08:00" }];
const state = fold(lines as never);
const facts = buildFacts({ ...state, lines } as never, now, policy as never);
const base = { status: "还没约", entry: "还没约", next: { at: "2026-11-03 09:30", waitingFor: "等你去约", why: "他说今天最好搞定", earlyIf: [] as string[] } };
const run = (entry: string) => checkReport({ report: { ...base, entry }, state: state as never, facts, policy: policy as never, now, attempt: 1 }) as { verdict: string; problems: Array<{ field: string; text: string }> };

test("entry: 40 characters go through, one more or a lead of \"我看了一眼\" is sent back and told what to write", () => {
  assert.equal(run("字".repeat(40)).verdict, "pass");
  const long = run("字".repeat(41));
  assert.equal(long.verdict, "rejected");
  assert.match(long.problems.find((p) => p.field === "entry")!.text, /32/);
  const lead = run("我看了一眼：还没约。");
  assert.equal(lead.verdict, "rejected");
  assert.match(lead.problems.find((p) => p.field === "entry")!.text, /不用「我看了一眼」开头/);
  assert.equal(run("洗牙还没约。").verdict, "pass");
});
