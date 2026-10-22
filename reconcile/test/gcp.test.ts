import assert from "node:assert/strict";
import { test } from "node:test";
import type { GcpSourceConfig } from "../server/config";
import type { Exec } from "../server/exec";
import { createGcpSource, GcpError, lastHuman, normalizeIssue, unwrap } from "../server/sources/gcp";
import { addDays } from "../server/time";

// The gateway's envelope and the tracker's record, rebuilt by hand in the shape seen on the
// real service (2026-10-21); names and ids are made up.

const envelope = (inner: unknown) =>
  "[cli] using profile default\n" +
  JSON.stringify({ ok: true, code: "OK", data: { code: "OK", data: { code: "OK", message: "操作成功", data: [{ type: "text", text: JSON.stringify(inner) }] } } });

const base = (id: number, patch: Record<string, unknown> = {}) => ({
  res_code: 1,
  res_msg: "请求成功",
  data: {
    base: { id, subject: `示例单 ${id}`, status: "关闭", is_closed: true, parent_id: 100000, updated_on: "2026-10-21T16:34:24+08:00", ...patch },
    core_fields: [
      [
        { name: "主题", key: "subject", value: `示例单 ${id}` },
        { name: "状态", key: "status_id", value: "关闭" },
        { name: "指派给", key: "assigned_to_id", value: "甲", field_format: "user" },
        { name: "协作人", key: "cf_911", value: [{ name: "乙" }, { name: "丙" }], field_format: "user" },
      ],
      [{ name: "描述", key: "description", value: "<p>很长的描述</p>" }],
    ],
    cf_fields: [
      { name: "计划版本", key: "cf_901", value: "2026-10-23外放（例行）", field_format: "list" },
      { name: "适用范围", key: "cf_912", value: "<p>仅 <b>iOS</b>&nbsp;端</p>", field_format: "editor" },
      { name: "负责人", key: "cf_913", value: [{ name: "丁" }], field_format: "user" },
    ],
  },
});

test("unwrap reads through the envelope and reports the tracker's refusals", () => {
  assert.deepEqual(unwrap(envelope({ res_code: 1, data: { list: [] } })), { list: [] });
  assert.throws(() => unwrap(envelope({ res_code: 0, res_msg: "没有权限" })), /没有权限/);
  assert.throws(() => unwrap(JSON.stringify({ ok: false, message: "token expired" })), (e: unknown) => e instanceof GcpError && e.auth);
  assert.throws(() => unwrap("[cli] banner only\n"), /printed nothing/);
});

test("an issue record becomes an item: fields by name, people by role, html flattened", () => {
  const item = normalizeIssue("gcp-demo", "tracker.example", (unwrap(envelope(base(100001))) as object), "2026-10-21T17:00:00+08:00");
  assert.equal(item.key, "gcp-demo:100001");
  assert.equal(item.url, "https://tracker.example/issues/100001");
  assert.equal(item.closed, true);
  assert.equal(item.parent, "gcp-demo:100000");
  assert.equal(item.fields["计划版本"], "2026-10-23外放（例行）");
  assert.equal(item.fields["适用范围"], "仅 iOS 端");
  assert.equal(item.fields["描述"], undefined);
  assert.deepEqual(item.people, { 指派给: ["甲"], 协作人: ["乙", "丙"], 负责人: ["丁"] });
});

const config: GcpSourceConfig = {
  id: "gcp-demo",
  kind: "gcp",
  command: ["node", "cli.js"],
  gateway: { path: "/api/tracker/call", tool: "tool_call", target: "tracker" },
  gcpHost: "tracker.example",
  projectId: 1,
  lookbackDays: 14,
  watch: [100009],
  activeHours: "workdays 09:00-21:00",
  everyMinutes: 20,
  offHoursEveryMinutes: 120,
  maxCallsPerHour: 60,
  timeoutSeconds: 60,
  domain: "work",
  columns: {},
  watchEveryMinutes: 60,
  refreshHotMinutes: 0,
};

function fakeExec(rows: Array<{ id: number; updated_on: string }>, calls: string[]): Exec {
  return async (command, args) => {
    assert.deepEqual(command, ["node", "cli.js"]);
    assert.equal(args[2], "/api/tracker/call");
    assert.deepEqual(JSON.parse(args[args.indexOf("--body") + 1]!).tool, "tool_call");
    const body = JSON.parse(args[args.indexOf("--body") + 1]!);
    calls.push(`${body.params.toolName} ${JSON.stringify(body.params.arguments.id ?? body.params.arguments.filters?.updated_on?.values)}`);
    if (body.params.toolName === "list_issues") return { code: 0, stdout: envelope({ res_code: 1, data: { list: rows } }), stderr: "", ms: 1, timedOut: false };
    return { code: 0, stdout: envelope(base(body.params.arguments.id)), stderr: "", ms: 1, timedOut: false };
  };
}

test("a poll lists changes since the cursor, reads each changed and watched issue, and stops at the budget", async () => {
  const calls: string[] = [];
  const rows = [
    { id: 100001, updated_on: "2026-10-21 16:34" },
    { id: 100002, updated_on: "2026-10-21 14:38" },
  ];
  const source = createGcpSource(config, { exec: fakeExec(rows, calls), localDate: () => "2026-10-21", addDays });
  const t0 = Date.parse("2026-10-21T17:00:00+08:00");
  const first = await source.poll({ cursor: null, watch: [], now: "2026-10-21T17:00:00+08:00", nowMs: t0, callsLeft: 3 });
  assert.deepEqual(calls, ['list_issues ["2026-10-07"]', "get_issue_base 100001", "get_issue_base 100002"]);
  assert.equal(first.snapshots.length, 2);
  assert.equal(first.more, false); // the watched issue missed this poll's budget, but watched issues never wait in pending
  calls.length = 0;
  const second = await source.poll({ cursor: first.cursor, watch: ["100003"], now: "2026-10-21T17:20:00+08:00", nowMs: t0 + 20 * 60_000, callsLeft: 60 });
  // Unchanged rows are not read again; watched ones the list does not show are, at most hourly.
  assert.deepEqual(calls, ['list_issues ["2026-10-07"]', "get_issue_base 100009", "get_issue_base 100003"]);
  assert.deepEqual((second.cursor as { since: string }).since, "2026-10-20");
  calls.length = 0;
  await source.poll({ cursor: second.cursor, watch: ["100003"], now: "2026-10-21T17:40:00+08:00", nowMs: t0 + 40 * 60_000, callsLeft: 60 });
  assert.deepEqual(calls, ['list_issues ["2026-10-20"]']);
});

test("an auth failure fails the whole poll; a single bad issue does not", async () => {
  const auth = createGcpSource(config, {
    exec: async () => ({ code: 1, stdout: "", stderr: "请先登录", ms: 1, timedOut: false }),
    localDate: () => "2026-10-21",
    addDays,
  });
  await assert.rejects(auth.poll({ cursor: null, watch: [], now: "", nowMs: 0, callsLeft: 10 }), (e: unknown) => e instanceof GcpError && e.auth);

  const flaky = createGcpSource({ ...config, watch: [] }, {
    exec: async (_c, args) => {
      const body = JSON.parse(args[args.indexOf("--body") + 1]!);
      if (body.params.toolName === "list_issues") return { code: 0, stdout: envelope({ res_code: 1, data: { list: [{ id: 1, updated_on: "x" }, { id: 2, updated_on: "y" }] } }), stderr: "", ms: 1, timedOut: false };
      if (body.params.arguments.id === 1) return { code: 0, stdout: envelope({ res_code: 0, res_msg: "单子不存在" }), stderr: "", ms: 1, timedOut: false };
      return { code: 0, stdout: envelope(base(2)), stderr: "", ms: 1, timedOut: false };
    },
    localDate: () => "2026-10-21",
    addDays,
  });
  const poll = await flaky.poll({ cursor: null, watch: [], now: "", nowMs: 0, callsLeft: 10 });
  assert.equal(poll.snapshots.length, 1);
  assert.match(poll.errors[0]!, /#1: .*单子不存在/);
  assert.deepEqual((poll.cursor as { pending: number[] }).pending, [1]);
});

test("lastHuman skips the API user, automatic flows and rule notes", () => {
  const journals = {
    list: [
      { created_on: "2026-10-15T01:22:15+08:00", author: { type: "APIUser", name: "API系统用户" }, notes: "来源于 关联规则：版本结束自动移单" },
      { created_on: "2026-10-14T10:00:00+08:00", author: { type: "User", name: "乙" }, notes: "来源于 自动化规则：填写完成时间" },
      { created_on: "2026-10-13T10:00:00+08:00", author: { type: "User", name: "乙" }, is_auto_flow: true },
      { created_on: "2026-10-12T10:00:00+08:00", author: { type: "User", name: "甲" }, notes: "" },
    ],
  };
  assert.equal(lastHuman(journals, ["来源于"]), "2026-10-12T10:00:00+08:00");
  assert.equal(lastHuman({ list: [] }, []), null);
});

test("per row: skip, look at the history, or read in full with commits and history", async () => {
  const calls: string[] = [];
  const rows = [
    { id: 1, updated_on: "2026-10-15 01:22", status: "关闭", cf_9: "2026-07-10" },
    { id: 2, updated_on: "2026-10-20 10:00", status: "关闭", cf_9: "2026-07-10" },
    { id: 3, updated_on: "2026-10-20 11:00", status: "开发中", cf_9: "2026-10-23" },
  ];
  const journals: Record<number, unknown> = {
    1: { list: [{ created_on: "2026-10-15T01:22:15+08:00", author: { type: "APIUser" }, notes: "" }] },
    2: { list: [{ created_on: "2026-10-20T10:00:00+08:00", author: { type: "User" }, notes: "" }] },
    3: { list: [] },
  };
  const exec: Exec = async (_command, args) => {
    const body = JSON.parse(args[args.indexOf("--body") + 1]!);
    const tool = body.params.toolName as string;
    const id = body.params.arguments.id as number;
    calls.push(`${tool}${id ? ` ${id}` : ""}`);
    if (tool === "list_issues") {
      assert.deepEqual(body.params.arguments.c, ["subject", "status", "updated_on", "cf_9"]);
      return { code: 0, stdout: envelope({ res_code: 1, data: { list: rows } }), stderr: "", ms: 1, timedOut: false };
    }
    if (tool === "get_issue_journals") return { code: 0, stdout: envelope({ res_code: 1, data: journals[id] }), stderr: "", ms: 1, timedOut: false };
    if (tool === "get_issue_changesets") return { code: 0, stdout: envelope({ res_code: 1, data: { list: [{ revision: "R-5", committed_on: "2026-10-12T10:00:00+08:00", committer: { name: "甲" }, comments: "refs #3 add\nmore" }] } }), stderr: "", ms: 1, timedOut: false };
    return { code: 0, stdout: envelope(base(id)), stderr: "", ms: 1, timedOut: false };
  };
  const svnRead: string[] = [];
  const svn = { beginPoll: () => {}, read: async (rid: string) => (svnRead.push(rid), { id: rid, repo: "demo", branch: "trunk", at: "", author: "甲", summary: "add", added: [["switch_a", "+x"]] as Array<[string, string]> }) };
  const source = createGcpSource(
    { ...config, watch: [], columns: { cf_9: "计划版本" }, journals: { automationNotePrefixes: [] }, changes: { command: ["svn"], timeoutSeconds: 10, maxRevisions: 5, recheckMinutes: 60, maxCallsPerPoll: 300, repos: [] } },
    { exec, localDate: () => "2026-10-21", addDays, svn },
  );
  const seenRows: Array<{ key: string; columns: Record<string, string> }> = [];
  const poll = await source.poll({
    cursor: null,
    watch: [],
    now: "2026-10-21T17:00:00+08:00",
    nowMs: Date.parse("2026-10-21T17:00:00+08:00"),
    callsLeft: 60,
    humanSince: "2026-10-07T17:00:00+08:00",
    decide: (row) => {
      seenRows.push({ key: row.key, columns: row.columns });
      return row.key.endsWith(":3") ? "full" : "people";
    },
  });
  assert.deepEqual(seenRows[2], { key: "gcp-demo:3", columns: { 计划版本: "2026-10-23" } });
  assert.deepEqual(calls, [
    "list_issues",
    // Row 3, hot: the record, its commits, its history.
    "get_issue_base 3",
    "get_issue_changesets 3",
    "get_issue_journals 3",
    // Row 1: only an automation touched it. Row 2: a person did, so it is read in full.
    "get_issue_journals 1",
    "get_issue_journals 2",
    "get_issue_base 2",
    "get_issue_changesets 2",
    "get_issue_journals 2",
  ]);
  assert.deepEqual(poll.snapshots.map((s) => s.key), ["gcp-demo:3", "gcp-demo:2"]);
  const three = poll.snapshots[0]!;
  assert.deepEqual(three.revisions!.map((r) => r.id), ["R-5"]);
  assert.equal(three.lastHumanAt, null);
  assert.equal(poll.snapshots[1]!.lastHumanAt, "2026-10-20T10:00:00+08:00");
  assert.match(three.text!, /^示例单 3\n很长的描述\n/);
  assert.deepEqual(svnRead, ["R-5", "R-5"]);
  assert.deepEqual(Object.keys((poll.cursor as { seen: object }).seen).sort(), ["1", "2", "3"]);
});
