import assert from "node:assert/strict";
import { test } from "node:test";
import type { GcpSourceConfig } from "../server/config";
import { exec, type Exec } from "../server/exec";
import { createGcpSource } from "../server/sources/gcp";
import { createSvnReader, netAdded, SvnBudgetError } from "../server/sources/svn";
import { addDays } from "../server/time";
import { issue, makeWorld } from "./helpers";

// What the sources hand the engine when part of a read fails, and how much a read may cost.
// Commits that cannot be read, files that keep failing, paging, and ceilings on svn and output.

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", ms: 1, timedOut: false });
const envelope = (data: unknown) => JSON.stringify({ ok: true, data: { data: { data: [{ type: "text", text: JSON.stringify({ res_code: 1, data }) }] } } });
const xmlEntry = (rev: number, p: string) => `<?xml version="1.0"?><log><logentry revision="${rev}"><author>a</author><date>2026-10-20T03:00:00.000000Z</date><paths><path action="M" kind="file">${p}</path></paths><msg>m</msg></logentry></log>`;
const gcpConfig = (patch: Partial<GcpSourceConfig> = {}) =>
  ({ id: "g", kind: "gcp", command: ["tracker"], gateway: { path: "/api/tracker/call", tool: "tool_call", target: "tracker" }, gcpHost: "t.example", projectId: 1, lookbackDays: 14, watch: [], activeHours: "daily 00:00-23:59", everyMinutes: 20, offHoursEveryMinutes: 20, maxCallsPerHour: 60, timeoutSeconds: 10, domain: "work", columns: {}, watchEveryMinutes: 60, refreshHotMinutes: 0, ...patch }) as GcpSourceConfig;
const poll = (src: ReturnType<typeof createGcpSource>, cursor: unknown, at: string) => src.poll({ cursor, watch: [], now: at, nowMs: Date.parse(at), callsLeft: 60 });

test("an issue whose linked commit cannot be read is not kept half-read: read again at the next poll, not counted as read", async () => {
  let svnBroken = true;
  const fakeExec: Exec = async (command, args) => {
    if (command[0] === "tracker") {
      const tool = JSON.parse(args[args.indexOf("--body") + 1]!).params.toolName;
      if (tool === "list_issues") return ok(envelope({ list: [{ id: 1, subject: "s", status: { name: "关闭" }, updated_on: "2026-10-22 10:00" }], total_page: 1 }));
      if (tool === "get_issue_base") return ok(envelope({ base: { id: 1, subject: "s", status: { name: "关闭" }, is_closed: true, updated_on: "2026-10-22 10:00" }, core_fields: [], cf_fields: [] }));
      return ok(envelope({ list: [{ revision: "R-100", committed_on: "2026-10-20 10:00", comments: "a" }, { revision: "R-101", committed_on: "2026-10-20 11:00", comments: "b" }] }));
    }
    const c = args[args.indexOf("-c") + 1];
    if (c === "101" && svnBroken) return { code: 1, stdout: "", stderr: "svn: E170013: Unable to connect to a repository", ms: 1, timedOut: false };
    if (args[0] === "diff") return ok("+++ x\n+  local flag_new_thing = 1\n");
    return ok(xmlEntry(Number(c), "/trunk/code/a.lua"));
  };
  const svn = createSvnReader({ command: ["svn"], timeoutSeconds: 10, maxRevisions: 20, repos: [{ name: "demo", pattern: "^R-(\\d+)$", branches: [{ name: "trunk", url: "https://svn.example/trunk" }] }] }, fakeExec);
  const src = createGcpSource(gcpConfig({ changes: { command: ["svn"], timeoutSeconds: 10, maxRevisions: 20, recheckMinutes: 60, maxCallsPerPoll: 300, repos: [] } }), { exec: fakeExec, localDate: () => "2026-10-22", addDays, svn });
  const p1 = await poll(src, null, "2026-10-22T12:00:00+08:00");
  assert.equal(p1.snapshots.length, 0, "not kept without R-101");
  assert.match(p1.errors.join(), /没读全/);
  assert.equal((p1.cursor as { seen: Record<string, string> }).seen["1"], undefined);
  assert.equal(p1.more, false, "not tried again within the minute: at the next regular poll");
  svnBroken = false;
  const p2 = await poll(src, p1.cursor, "2026-10-22T12:20:00+08:00");
  assert.deepEqual(p2.snapshots[0]!.revisions!.map((r) => r.id), ["R-100", "R-101"]);
});

test("a branch that could not answer (network) is not remembered as not having the commit", async () => {
  let blip = true;
  const fakeExec: Exec = async (_c, args) => {
    const url = args.find((a) => a.startsWith("https://"))!;
    if (args[0] === "log" && url.endsWith("/trunk") && blip) return { code: 1, stdout: "", stderr: "svn: E170013: connection reset", ms: 1, timedOut: false };
    if (args[0] === "log" && url.endsWith("/trunk")) return ok(xmlEntry(100, "/trunk/a.lua"));
    // A branch made after the revision: svn says the path was not there.
    if (args[0] === "log") return { code: 1, stdout: "", stderr: "svn: E195012: Unable to find repository location for 'https://svn.example/rel' in revision 100", ms: 1, timedOut: false };
    return ok("+ x_flag_1\n");
  };
  const svn = createSvnReader({ command: ["svn"], timeoutSeconds: 10, maxRevisions: 5, repos: [{ name: "demo", pattern: "^R-(\\d+)$", branches: [{ name: "rel", url: "https://svn.example/rel" }, { name: "trunk", url: "https://svn.example/trunk" }] }] }, fakeExec);
  await assert.rejects(svn.read("R-100", { at: "", author: "", summary: "" }), /E170013/);
  blip = false;
  const b = await svn.read("R-100", { at: "", author: "", summary: "" });
  assert.equal(b!.branch, "trunk", "a branch that was not there yet is no failure");
});

test("svn calls of one poll have a ceiling, and a command's output is cut off past maxBytes", async () => {
  const svn = createSvnReader({ command: ["svn"], timeoutSeconds: 10, maxRevisions: 5, maxCallsPerPoll: 2, repos: [{ name: "demo", pattern: "^R-(\\d+)$", branches: [{ name: "a", url: "https://svn.example/a" }, { name: "b", url: "https://svn.example/b" }, { name: "c", url: "https://svn.example/c" }] }] }, async () => ok("<log></log>"));
  svn.beginPoll();
  await assert.rejects(svn.read("R-1", { at: "", author: "", summary: "" }), SvnBudgetError);
  svn.beginPoll();
  await assert.rejects(svn.read("R-2", { at: "", author: "", summary: "" }), SvnBudgetError, "each poll counts afresh, and three branches need three calls");
  const big = await exec([process.execPath, "-e", "process.stdout.write('x'.repeat(200000))"], [], { timeoutMs: 10_000, maxBytes: 1000 });
  assert.equal(big.truncated, true);
  assert.equal(big.stdout.length, 1000);
});

test("the list is read page by page; more pages than one poll reads keep the window open", async () => {
  const pagesAsked: number[] = [];
  // The paging fields as the real list answers them (2026-10-23): page, per_page, total_count,
  // total_page, and "pages", which is the choice of page sizes and not a count.
  const fakeExec = (totalPages: number): Exec => async (_command, args) => {
    const body = JSON.parse(args[args.indexOf("--body") + 1]!).params;
    if (body.toolName === "list_issues") {
      const page = body.arguments.page;
      pagesAsked.push(page);
      return ok(envelope({ list: [{ id: 100 + page, subject: "s", status: { name: "新建" }, updated_on: "2026-10-22 10:00" }], page, per_page: 100, total_count: totalPages, total_page: totalPages, pages: [100, 150, 200] }));
    }
    return ok(envelope({ base: { id: 1 }, core_fields: [], cf_fields: [] }));
  };
  const two = createGcpSource(gcpConfig(), { exec: fakeExec(2), localDate: () => "2026-10-22", addDays });
  const p = await two.poll({ cursor: null, watch: [], now: "2026-10-22T12:00:00+08:00", nowMs: Date.parse("2026-10-22T12:00:00+08:00"), callsLeft: 60, decide: () => "skip" });
  assert.deepEqual(pagesAsked, [1, 2]);
  assert.deepEqual(Object.keys((p.cursor as { seen: object }).seen).sort(), ["101", "102"]);
  assert.equal((p.cursor as { since: string }).since, "2026-10-21");
  pagesAsked.length = 0;
  const many = createGcpSource(gcpConfig(), { exec: fakeExec(30), localDate: () => "2026-10-22", addDays });
  const q = await many.poll({ cursor: null, watch: [], now: "2026-10-22T12:00:00+08:00", nowMs: Date.parse("2026-10-22T12:00:00+08:00"), callsLeft: 60, decide: () => "skip" });
  assert.equal(pagesAsked.length, 10);
  assert.match(q.errors.join(), /列表有 30 页，这次只读了 10 页/);
  assert.equal((q.cursor as { since: string }).since, "2026-10-08", "the window stays where it was, to list the rest again");
  assert.equal(q.more, true);
});

test("a full page is followed by the next even when the list gives no page count; a count that does not add up is said", async () => {
  const pagesAsked: number[] = [];
  const rowsOf = (page: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: page * 1000 + i, subject: "s", status: { name: "新建" }, updated_on: "2026-10-22 10:00" }));
  const fakeExec = (answer: (page: number) => Record<string, unknown>): Exec => async (_command, args) => {
    const body = JSON.parse(args[args.indexOf("--body") + 1]!).params;
    if (body.toolName === "list_issues") {
      pagesAsked.push(body.arguments.page);
      return ok(envelope(answer(body.arguments.page)));
    }
    return ok(envelope({ base: { id: 1 }, core_fields: [], cf_fields: [] }));
  };
  const input = { cursor: null, watch: [], now: "2026-10-22T12:00:00+08:00", nowMs: Date.parse("2026-10-22T12:00:00+08:00"), callsLeft: 60, decide: () => "skip" as const };
  // No paging fields at all: 100 rows, then 30.
  const bare = createGcpSource(gcpConfig(), { exec: fakeExec((page) => ({ list: rowsOf(page, page === 1 ? 100 : 30) })), localDate: () => "2026-10-22", addDays });
  const p = await bare.poll(input);
  assert.deepEqual(pagesAsked, [1, 2]);
  assert.equal(Object.keys((p.cursor as { seen: object }).seen).length, 130);
  assert.deepEqual(p.errors, []);
  // A page count of 1 but a total of 140: one page read, and the difference is said.
  pagesAsked.length = 0;
  const short = createGcpSource(gcpConfig(), { exec: fakeExec(() => ({ list: rowsOf(1, 40), total_page: 1, total_count: 140 })), localDate: () => "2026-10-22", addDays });
  const q = await short.poll(input);
  assert.deepEqual(pagesAsked, [1]);
  assert.match(q.errors.join(), /列表说有 140 条，读到 40 条/);
});

test("a key that is a plain word ('test') is not taken from an issue's prose", async () => {
  const w = await makeWorld({ start: "2026-10-15 10:00" });
  try {
    w.flags.set("test", 100);
    w.flags.set("feature_x", 30);
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-14", closed: true, status: "关闭", text: "示例单 1 补一个 A/B test 说明，和灰度无关", revisions: [] }));
    await w.run("2026-10-15 10:30");
    assert.equal(w.store.state.notes["gcp-demo:1"]?.flagKey, undefined);
    assert.notEqual(w.store.state.assessments["gcp-demo:1"]!.stage, "finished");
  } finally {
    w.close();
  }
});

test("while one switch file keeps failing (the source as a whole still 'ok'), what a rule asks waits, and goes once it is read again", async () => {
  const w = await makeWorld({ start: "2026-10-22 15:00" });
  try {
    w.items.set("gcp-demo:1", issue(1, { release: "2026-10-23", status: "关闭", closed: true }));
    await w.run("2026-10-23 12:00");
    w.fail.files.add("outer");
    await w.run("2026-10-23 18:30");
    // Only the controller's own word goes: the file has not been read for sourceDownHours.
    assert.equal(w.cards.length, 1);
    assert.match(w.cards[0]!.card.title, /^flags-demo:outer 从 10-23 12:\d\d 起读不到/);
    assert.equal(w.store.state.sources["flags-demo"]!.health.state, "ok");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.stale, true);
    const plans = (w.statuses as Array<{ plan: Array<{ kind: string; summary: string }> }>).flatMap((s) => s.plan);
    assert.ok(plans.some((e) => e.kind === "deferred" && /数据可能过时（flags-demo:outer）/.test(e.summary)));
    w.fail.files.clear();
    await w.run("2026-10-23 19:00");
    assert.equal(w.cards.length, 2);
    assert.equal(Object.values(w.store.state.commitments).find((c) => c.key.startsWith("source-down:"))!.status, "cancelled", "read again: the outage card goes");
    assert.equal(w.store.state.assessments["gcp-demo:1"]!.stale, false);
  } finally {
    w.close();
  }
});

test("a linked commit that never reads (a branch the account may not read): after three reads in a row the issue is kept with what was read, marked incomplete, and the window moves on", async () => {
  const fakeExec: Exec = async (command, args) => {
    if (command[0] === "tracker") {
      const tool = JSON.parse(args[args.indexOf("--body") + 1]!).params.toolName;
      if (tool === "list_issues") return ok(envelope({ list: [{ id: 1, subject: "s", status: { name: "关闭" }, updated_on: "2026-10-22 10:00" }], total_page: 1, total_count: 1 }));
      if (tool === "get_issue_base") return ok(envelope({ base: { id: 1, subject: "s", status: { name: "关闭" }, is_closed: true, updated_on: "2026-10-22 10:00" }, core_fields: [], cf_fields: [] }));
      return ok(envelope({ list: [{ revision: "R-100", committed_on: "2026-10-20 10:00", comments: "a" }, { revision: "R-101", committed_on: "2026-10-20 11:00", comments: "b" }] }));
    }
    const c = args[args.indexOf("-c") + 1];
    if (c === "101") return { code: 1, stdout: "", stderr: "svn: E170001: Authorization failed", ms: 1, timedOut: false };
    if (args[0] === "diff") return ok("+++ x\n+  local flag_new_thing = 1\n");
    return ok(xmlEntry(Number(c), "/trunk/code/a.lua"));
  };
  const svn = createSvnReader({ command: ["svn"], timeoutSeconds: 10, maxRevisions: 20, repos: [{ name: "demo", pattern: "^R-(\\d+)$", branches: [{ name: "trunk", url: "https://svn.example/trunk" }] }] }, fakeExec);
  const src = createGcpSource(gcpConfig({ changes: { command: ["svn"], timeoutSeconds: 10, maxRevisions: 20, recheckMinutes: 60, maxCallsPerPoll: 300, repos: [] } }), { exec: fakeExec, localDate: () => "2026-10-22", addDays, svn });
  let cursor: unknown = null;
  for (const at of ["12:00", "12:20"]) {
    const p = await poll(src, cursor, `2026-10-22T${at}:00+08:00`);
    assert.equal(p.snapshots.length, 0);
    cursor = p.cursor;
  }
  const third = await poll(src, cursor, "2026-10-22T12:40:00+08:00");
  assert.equal(third.snapshots.length, 1);
  assert.deepEqual(third.snapshots[0]!.revisions!.map((r) => r.id), ["R-100"]);
  assert.match(third.snapshots[0]!.incomplete!.join(), /^R-101: .*E170001/);
  assert.match(third.errors.join(), /#1 连续 3 次有提交读不到，先按读到的算/);
  assert.equal((third.cursor as { since: string }).since, "2026-10-21", "the window moves on");
});

test("a commit keeps only name-like tokens, so a key that is a plain word is found neither in prose nor in commits", () => {
  assert.deepEqual(netAdded("+  if test then\n").map(([token]) => token), []);
  assert.deepEqual(netAdded("+  if enable_new_test then\n").map(([token]) => token), ["enable_new_test"]);
});
