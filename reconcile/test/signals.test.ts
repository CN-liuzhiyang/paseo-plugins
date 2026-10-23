import assert from "node:assert/strict";
import { test } from "node:test";
import type { Exec } from "../server/exec";
import { heatOf, listedAt } from "../server/heat";
import { linksOf, vocabularyOf } from "../server/links";
import { createFlagsSource, flatten } from "../server/sources/flags";
import { createSvnReader, netAdded } from "../server/sources/svn";
import type { Item, Observation } from "../shared/model";
import { issue, TZ } from "./helpers";

// The readers behind "read before asking": switch files over HTTP, commits from version control,
// and the linking of the two to an item. All hand-made; names are made up.

const DIFF = [
  "Index: config/switches.lua",
  "===================================================================",
  "--- config/switches.lua\t(revision 99)",
  "+++ config/switches.lua\t(revision 100)",
  "@@ -1,4 +1,6 @@",
  "-\t\told_switch = dict(grey = 10),",
  "+\t\told_switch = dict(grey = 20),",
  "+\t\tnew_switch_x = dict(enabled = true),",
  "+    return manager:check(\"new_switch_x\")",
  "+    local plain = word",
].join("\n");

test("netAdded keeps names brought in, not names merely touched, each with its first line", () => {
  assert.deepEqual(netAdded(DIFF), [["new_switch_x", "new_switch_x = dict(enabled = true),"]]);
});

test("the svn reader finds the branch a revision is on, reads its diff once, and refuses to guess when svn fails", async () => {
  const calls: string[] = [];
  const exec: Exec = async (_command, args) => {
    calls.push(args.slice(0, 4).join(" "));
    const verb = args[0];
    const url = args.find((a) => a.startsWith("https://"));
    if (verb === "log" && url === "https://svn.example/repo/branches/trunk")
      return { code: 0, stdout: '<?xml version="1.0"?><log><logentry revision="100"><author>甲</author><date>2026-10-12T02:00:00.000Z</date><msg>add new_switch_x &amp; more\nsecond line</msg></logentry></log>', stderr: "", ms: 1, timedOut: false };
    if (verb === "log") return { code: 0, stdout: "<log>\n</log>", stderr: "", ms: 1, timedOut: false };
    return { code: 0, stdout: DIFF, stderr: "", ms: 1, timedOut: false };
  };
  const reader = createSvnReader(
    {
      command: ["svn"],
      timeoutSeconds: 10,
      maxRevisions: 10,
      repos: [{ name: "demo", pattern: "^R-(\\d+)$", branches: [{ name: "release", url: "https://svn.example/repo/branches/release" }, { name: "trunk", url: "https://svn.example/repo/branches/trunk" }] }],
    },
    exec,
  );
  const known = { at: "2026-10-12T10:00:00+08:00", author: "甲", summary: "" };
  const revision = await reader.read("R-100", known);
  assert.deepEqual(revision, {
    id: "R-100",
    repo: "demo",
    branch: "trunk",
    at: "2026-10-12T02:00:00.000Z",
    author: "甲",
    summary: "add new_switch_x & more",
    added: [["new_switch_x", "new_switch_x = dict(enabled = true),"]],
    in: { trunk: { rev: 100, at: "2026-10-12T02:00:00.000Z" } },
  });
  assert.deepEqual(calls, ["log --xml -v -c", "log --xml -v -c", "diff -c 100 https://svn.example/repo/branches/trunk"]);
  await reader.read("R-100", known);
  assert.equal(calls.length, 3, "remembered");
  assert.equal(await reader.read("X-1", known), null, "no repository names it");

  const broken = createSvnReader(
    { command: ["svn"], timeoutSeconds: 10, maxRevisions: 10, repos: [{ name: "demo", pattern: "^R-(\\d+)$", branches: [{ name: "trunk", url: "https://svn.example/t" }] }] },
    async () => ({ code: 1, stdout: "", stderr: "svn: E170013: Unable to connect", ms: 1, timedOut: false }),
  );
  await assert.rejects(broken.read("R-1", known), /Unable to connect/);
});

test("a branch made by copying directories gets a revision with the next copy; asked again later, and the copy that brought it is when it got there", async () => {
  // Commit 100 is on stable under code/. The release branch's code/ is replaced by copies of
  // stable's: at first one from 90 (revision 91), later more.
  const copies = [{ rev: 91, from: 90, at: "2026-10-10T13:00:00Z" }];
  let clock = 0;
  const calls: string[] = [];
  const xml = (rev: number, date: string, paths: string) => `<log><logentry revision="${rev}"><author>甲</author><date>${date}</date><paths>${paths}</paths><msg>m</msg></logentry></log>`;
  const commit = xml(100, "2026-10-12T02:00:00Z", '<path action="M">/branches/stable/code/a.lua</path>');
  const exec: Exec = async (_command, args) => {
    const arg = args.find((a) => a.startsWith("https://"))!;
    calls.push(`${args.includes("--stop-on-copy") ? "copy" : args[0]} ${arg.replace("https://svn.example/repo/branches/", "")}`);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", ms: 1, timedOut: false });
    if (args[0] === "diff") return ok("+ x");
    if (arg.endsWith("/stable")) return ok(commit);
    if (arg.endsWith("/release")) return ok("<log></log>");
    // release/code as it was at a revision: the history of the last copy made by then.
    const peg = arg.includes("@") ? Number(arg.split("@")[1]) : Infinity;
    const copy = copies.filter((c) => c.rev <= peg).pop();
    if (args.includes("--stop-on-copy")) return ok(copy ? xml(copy.rev, copy.at, `<path copyfrom-path="/branches/stable/code" copyfrom-rev="${copy.from}" action="R">/branches/release/code</path>`) : "<log></log>");
    return ok(copy && copy.from >= 100 ? commit : "<log></log>");
  };
  const config = {
    command: ["svn"],
    timeoutSeconds: 10,
    maxRevisions: 10,
    recheckMinutes: 60,
    repos: [{ name: "demo", pattern: "^R-(\\d+)$", branches: [{ name: "stable", url: "https://svn.example/repo/branches/stable" }, { name: "release", url: "https://svn.example/repo/branches/release", copied: ["code"] }] }],
  };
  const reader = createSvnReader(config, exec, () => clock);
  const known = { at: "", author: "", summary: "" };
  const first = (await reader.read("R-100", known))!;
  assert.deepEqual(first.in, { stable: { rev: 100, at: "2026-10-12T02:00:00Z" } });
  assert.deepEqual(first.copied, { release: { rev: 91, at: "2026-10-10T13:00:00Z", from: 90, seen: "1970-01-01T00:00:00.000Z" } }, "the latest copy (a freeze) did not bring it");
  assert.deepEqual(calls, ["log stable", "diff stable", "log release/code", "copy release/code"]);
  copies.push({ rev: 121, from: 120, at: "2026-10-21T13:12:00Z" });
  clock = 30 * 60_000;
  await reader.read("R-100", known);
  assert.equal(calls.length, 4, "not asked again within recheckMinutes");
  clock = 61 * 60_000;
  const later = (await reader.read("R-100", known))!;
  assert.deepEqual(later.in!.release, { rev: 121, at: "2026-10-21T13:12:00Z" }, "it got there with the copy");
  assert.deepEqual(later.copied!.release, { rev: 121, at: "2026-10-21T13:12:00Z", from: 120, seen: "1970-01-01T01:01:00.000Z" });
  assert.deepEqual(calls.slice(4), ["log release/code", "copy release/code", "log release/code@120"]);
  await reader.read("R-100", known);
  assert.equal(calls.length, 7, "found: not asked again");
  // Copied again later: the copy that first brought it is still when it got there, not the latest.
  copies.push({ rev: 131, from: 130, at: "2026-10-22T11:05:00Z" });
  const fresh = createSvnReader(config, exec, () => clock);
  const again = (await fresh.read("R-100", known))!;
  assert.deepEqual(again.in!.release, { rev: 121, at: "2026-10-21T13:12:00Z" });
  assert.deepEqual(again.copied!.release, { rev: 131, at: "2026-10-22T11:05:00Z", from: 130, seen: "1970-01-01T01:01:00.000Z" });
});

test("a switch file is one item: sections flattened, a byte-order mark tolerated, a failing file reported", async () => {
  assert.deepEqual(flatten({ switches: { a_b: 50, c_d: { enabled: false } }, other: { x: 1 } }, ["switches", "missing"]), {
    "switches.a_b": "50",
    "switches.c_d": '{"enabled":false}',
  });
  const source = createFlagsSource(
    {
      id: "flags-demo",
      kind: "flags",
      files: [
        { id: "outer", url: "https://flags.example/outer.json", labels: { env: "outer" } },
        { id: "inner", url: "https://flags.example/inner.json", labels: { env: "inner" } },
      ],
      sections: ["switches"],
      itemKind: "flags",
      activeHours: "daily 00:00-23:59",
      everyMinutes: 15,
      offHoursEveryMinutes: 15,
      maxCallsPerHour: 60,
      timeoutSeconds: 5,
      domain: "work",
    },
    {
      fetchText: async (url) =>
        url.endsWith("outer.json")
          ? { status: 200, text: '﻿{"switches":{"new_switch_x":20}}', lastModified: "Wed, 21 Oct 2026 08:15:24 GMT" }
          : { status: 404, text: "", lastModified: null },
    },
  );
  const poll = await source.poll({ cursor: null, watch: [], now: "2026-10-21T17:00:00+08:00", nowMs: 0, callsLeft: 10 });
  assert.equal(poll.snapshots.length, 1);
  const [outer] = poll.snapshots;
  assert.equal(outer!.key, "flags-demo:outer");
  assert.equal(outer!.kind, "flags");
  assert.deepEqual(outer!.fields, { "switches.new_switch_x": "20" });
  assert.deepEqual(outer!.labels, { env: "outer" });
  assert.equal(outer!.sourceUpdatedAt, "2026-10-21T08:15:24.000Z");
  assert.deepEqual(poll.errors, ["inner: HTTP 404"]);
});

const flagFile = (fields: Record<string, string>): Item => ({
  key: "flags-demo:outer",
  source: "flags-demo",
  kind: "flags",
  title: "outer",
  url: null,
  status: "ok",
  closed: false,
  fields,
  people: {},
  parent: null,
  sourceUpdatedAt: null,
  observedAt: "2026-10-21T09:00:00.000Z",
  labels: { env: "outer" },
});

test("links: a key in the text and in a commit, with evidence; values and when they last changed", () => {
  const change: Observation = {
    id: "o1",
    at: "2026-10-20T09:00:00.000Z",
    seenAt: "2026-10-20T09:05:00.000Z",
    source: "flags-demo",
    key: "flags-demo:outer",
    kind: "changed",
    trust: "source",
    actor: null,
    changes: [{ field: "fields.switches.new_switch_x", from: "10", to: '{"enabled":true,"grey":20}' }],
    text: null,
  };
  const vocabulary = vocabularyOf({ "flags-demo:outer": flagFile({ "switches.new_switch_x": '{"enabled":true,"grey":20}', "switches.other_one": "1" }) }, { "flags-demo:outer": [change] });
  const item = issue(1, {
    text: "开关 new_switch_x 灰度；无关的 other_one_more",
    revisions: [{ id: "R-100", repo: "demo", branch: "trunk", at: "", author: "", summary: "", added: [["new_switch_x", 'return manager:check("new_switch_x")']] }],
  });
  const links = linksOf(item, vocabulary);
  assert.equal(links.length, 1, "whole identifiers only: other_one_more is not other_one");
  const [link] = links;
  assert.equal(link!.key, "new_switch_x");
  assert.equal(link!.inText && link!.inDiff, true);
  assert.deepEqual(link!.evidence, ["单子文本：…开关 new_switch_x 灰度；无关的 other_one_more…", 'R-100（trunk）：+ return manager:check("new_switch_x")']);
  assert.deepEqual(link!.files, [{ file: "flags-demo:outer", labels: { env: "outer" }, present: true, section: "switches", value: { enabled: true, grey: 20 } }]);
  assert.equal(link!.changedAt, "2026-10-20T09:05:00.000Z");
});

test("heat: each reason, and nothing for an old item nobody touches", () => {
  const nowMs = Date.parse("2026-10-21T10:00:00+08:00");
  const policy = { recentDays: 14, dateWindowDays: 14, dateFields: ["Release"] };
  const base = { nowMs, tz: TZ, policy, open: false, watched: false, flagChangedAt: null };
  assert.deepEqual(heatOf({ fields: { Release: "2026-07-10" }, lastHumanAt: "2026-09-01T10:00:00+08:00" }, base), []);
  assert.deepEqual(heatOf({ fields: { Release: "2026-11-04外放" }, lastHumanAt: null }, base), ["Release 11-04 在前后 14 天内"]);
  assert.deepEqual(heatOf({ fields: {}, lastHumanAt: "2026-10-15T10:00:00+08:00" }, base), ["10-15 有人改过"]);
  assert.deepEqual(heatOf({ fields: {}, lastHumanAt: null }, { ...base, open: true, watched: true, flagChangedAt: "2026-10-20T01:00:00.000Z" }), ["有没问完的问题", "在关注列表里", "关联的开关 10-20 变过"]);
  assert.equal(listedAt("2026-10-21 14:38", TZ), Date.parse("2026-10-21T14:38:00+08:00"));
  assert.equal(listedAt("not a date", TZ), null);
});
