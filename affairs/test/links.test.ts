import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createChats } from "../server/chat";
import { panelOf } from "../server/lib/panel.mjs";
import { createEngine, type Deliver } from "../server/engine";
import { hasLinks, hrefOf, linkContext, linkProblems, linkify, parseLink, partsOf, withUrls } from "../server/lib/links.mjs";
import { load, read } from "../server/lib/log.mjs";
import * as ops from "../server/lib/ops.mjs";
import { DEFAULT_POLICY, policyProblems } from "../server/lib/policy.mjs";
import { whyOf } from "../server/lib/paseo.mjs";
import { rowsOf } from "../server/lib/view.mjs";
import { world } from "./kit";

const GCP = "https://pm.example.invalid/issues/{ref}";
const FEISHU = "https://tasks.example.invalid/detail?guid={ref}";
const policy = { links: { gcp: GCP, "feishu-task": FEISHU }, linkHash: "gcp" };
const ctxOf = (link: string | null = null, over: Record<string, unknown> = {}) => linkContext({ ...policy, ...over }, link);
const hrefs = (text: string, ctx = ctxOf()) => linkify(text, ctx).filter((s: { href?: string }) => s.href).map((s: { text: string; href?: string }) => [s.text, s.href]);
const gcp = (n: string) => `https://pm.example.invalid/issues/${n}`;
const MECHANISM = /叫醒|校验|记录|计划|读数|会话|agent/i;

// ---- the one function ----

test("a number with # and five or more digits is a ticket; the segments put back together are the text", () => {
  const text = "单子 #555001 已经关了，#12345 也是。";
  const segments = linkify(text, ctxOf());
  assert.equal(segments.map((s: { text: string }) => s.text).join(""), text);
  assert.deepEqual(hrefs(text), [["#555001", gcp("555001")], ["#12345", gcp("12345")]]);
});

test("the affair's own link: bare number, # with any length, the kind:ref form", () => {
  const own = ctxOf("gcp:555001");
  assert.deepEqual(hrefs("555001 的状态", own), [["555001", gcp("555001")]]);
  assert.deepEqual(hrefs("（555001）", own), [["555001", gcp("555001")]]);
  assert.deepEqual(hrefs("见 gcp:555001 和 gcp:#555001。", own), [["gcp:555001", gcp("555001")], ["gcp:#555001", gcp("555001")]]);
  // A short ticket is its own number only with the #; bare, it is just a number.
  const short = ctxOf("gcp:#700/字段");
  assert.deepEqual(hrefs("#700 说要改，700 个人来了", short), [["#700", gcp("700")]]);
  assert.deepEqual(hrefs("#700 说要改", ctxOf()), [], "unregistered and short: left alone");
});

test("a task of another kind is opened by its own template", () => {
  const guid = "5e7b0460-cd85-4b52-b35c-047b8ada8921";
  const own = ctxOf(`feishu-task:${guid}`);
  assert.deepEqual(hrefs(`任务 ${guid} 没勾`, own), [[guid, `https://tasks.example.invalid/detail?guid=${guid}`]]);
  assert.deepEqual(hrefs(`见 feishu-task:${guid}`, ctxOf()), [[`feishu-task:${guid}`, `https://tasks.example.invalid/detail?guid=${guid}`]]);
  assert.deepEqual(hrefs(`别的 ${guid}`, ctxOf()), [], "a guid nobody registered is not taken for a task");
});

test("what is not a ticket is left alone: dates, plates, revisions, versions, counts, other kinds, words with digits, an address that already has the number", () => {
  const own = ctxOf("gcp:555001");
  for (const text of [
    "2026-11-03 14:00", "20261103", "11月11日 14:00", "京A12345", "r6493425", "H72-6493425", "版本 1.2.34567", "共 123456 条", "颜色 123456", "id 12345", "abc12345", "12345abc", "&#12345;",
    "jira:12345", "https://pm.example.invalid/issues/555001", "100555001", "555001-12", "2026-555001", "a/555001", "#1234", "#ab12345", "##12345x", "555001.5",
  ]) assert.deepEqual(hrefs(text, own), [], text);
});

test("only # is trusted without registration; five or more digits behind a # that is not a hex colour word are linked as the policy says", () => {
  // The honest limit: "#123456" (a colour code written with a #) is five or more digits and is taken for a ticket.
  assert.deepEqual(hrefs("颜色 #123456"), [["#123456", gcp("123456")]]);
  assert.deepEqual(hrefs("共 123456 条"), []);
  assert.deepEqual(hrefs("#1234"), []);
});

test("a kind with no template is shown as it is, without an error; so is a policy with no links at all", () => {
  assert.deepEqual(hrefs("jira:12345 和 #98765", ctxOf(null, { links: {}, linkHash: "gcp" })), []);
  assert.deepEqual(linkify("单 #555001", ctxOf(null, { links: {} })), [{ text: "单 #555001" }]);
  assert.deepEqual(linkify("单 gcp:555001", ctxOf("gcp:555001", { links: { "feishu-task": FEISHU } })), [{ text: "单 gcp:555001" }]);
  assert.deepEqual(linkify("单 #555001", linkContext({}, null)), [{ text: "单 #555001" }]);
  assert.deepEqual(linkify("", ctxOf()), [{ text: "" }]);
  assert.equal(partsOf("没有单号", ctxOf()), undefined);
});

test("a template that cannot be used is dropped: no {ref}, not http(s), a space in it; and doctor can say so", () => {
  for (const bad of ["https://pm.example.invalid/issues/", "ftp://pm.example.invalid/{ref}", "javascript:alert({ref})", "https://pm.example.invalid/ {ref}", ""]) {
    assert.deepEqual(hrefs("#555001", ctxOf(null, { links: { gcp: bad } })), [], bad);
  }
  assert.equal(hrefOf({}, "gcp", "1"), null);
  assert.deepEqual(linkProblems({ links: { gcp: "nope" }, linkHash: "gcp" }).map((p: { key: string }) => p.key), ["links.gcp", "linkHash"]);
  assert.deepEqual(linkProblems({ links: { gcp: GCP }, linkHash: "gcp" }), []);
  assert.deepEqual(linkProblems({}), []);
  assert.ok(policyProblems({ ...DEFAULT_POLICY, links: { gcp: "nope" } }).some((p: { key: string }) => p.key === "links.gcp"));
});

test("an address is built from the ref only, encoded: a ref cannot change where the address goes", () => {
  assert.equal(hrefOf({ gcp: GCP }, "gcp", "1/../2?x=#"), "https://pm.example.invalid/issues/1%2F..%2F2%3Fx%3D%23");
});

test("for text only: the address after the reference, spaced so the punctuation after it is not taken into it", () => {
  const ctx = ctxOf();
  assert.equal(withUrls("单 #555001，已关", ctx), `单 #555001 ${gcp("555001")} ，已关`);
  assert.equal(withUrls("单 #555001", ctx), `单 #555001 ${gcp("555001")}`);
  assert.equal(withUrls("单 #555001\n再说", ctx), `单 #555001 ${gcp("555001")}\n再说`);
  assert.equal(withUrls("没有单号", ctx), "没有单号");
  assert.equal(withUrls("单 #555001", ctxOf(null, { links: {} })), "单 #555001");
  assert.ok(hasLinks(linkify("#12345", ctx)));
});

test("parseLink reads what a link says", () => {
  assert.deepEqual(parseLink("gcp:555001"), { kind: "gcp", ref: "555001" });
  assert.deepEqual(parseLink("gcp:#700/字段"), { kind: "gcp", ref: "700" });
  assert.deepEqual(parseLink("feishu-task:abc-123"), { kind: "feishu-task", ref: "abc-123" });
  assert.equal(parseLink(null), null);
  assert.equal(parseLink("no-colon"), null);
});

test("what he reads has none of the inner words", () => {
  assert.doesNotMatch(withUrls("单 #555001，已关", ctxOf()), MECHANISM);
});

// ---- every place a person reads ----

const link = "gcp:555001";
const started = async (w: ReturnType<typeof world>) => (await ops.create(w.ctx, { title: "引擎外放 #555001", goal: "盯 #555001", said: "盯一下 #555001 这张单", link, noWait: true })).id as string;

test("the panel: the sentences carry pieces where a ticket is; a panel with none is as it was", async () => {
  const w = world({ policy });
  const id = await started(w);
  assert.equal(id, "555001");
  const s = { ...load(w.root, id), lines: read(w.root, id) };
  const p = panelOf(w.root, s, w.now(), w.ctx.policy, linkContext(w.ctx.policy, s.link));
  assert.equal(p.title, "引擎外放 #555001");
  assert.deepEqual(p.now.parts, [{ text: "盯 " }, { text: "#555001", href: gcp("555001") }]);
  assert.equal(p.waiting.parts, undefined, "a sentence with no ticket has no pieces");
  assert.equal(p.now.text, "盯 #555001", "the plain text stays for a client that does not know pieces");
  const plain = world({ policy: { links: {}, linkHash: "" } });
  const pid = await started(plain);
  const ps = { ...load(plain.root, pid), lines: read(plain.root, pid) };
  assert.equal(panelOf(plain.root, ps, plain.now(), plain.ctx.policy, linkContext(plain.ctx.policy, ps.link)).now.parts, undefined);
});

test("the lines: a line with a ticket in it has pieces, his own too (drawn as a line so it can be opened); a line without is as it was", async () => {
  const w = world({ policy });
  const id = await started(w);
  const engine = createEngine({ ctx: w.ctx, paseo: null, deliver: null, log: () => {} });
  await ops.note(w.ctx, id, { said: "#555001 的备注我看过了", via: "chat" });
  await ops.note(w.ctx, id, { said: "洗好牙了", via: "chat" });
  const rows = engine.view(id)!.rows;
  const mine = rows.filter((r) => r.own);
  assert.equal(mine.length, 3);
  assert.ok(mine[0]!.parts?.some((p) => p.href === gcp("555001")), "the first thing he said");
  assert.ok(mine[1]!.parts?.some((p) => p.href === gcp("555001")));
  assert.equal(mine[2]!.parts, undefined);
  assert.equal(rowsOf({ ...load(w.root, id), lines: read(w.root, id) }, w.now(), w.ctx.policy).length, rows.length);
});

test("in the chat: a line with a ticket is drawn with pieces the client can open; the others as before", async () => {
  const appended: Array<{ id: string; kind: string; data: { parts?: unknown } }> = [];
  const parts = [{ text: "11:00  我看了一眼：" }, { text: "#555001", href: gcp("555001") }, { text: " 还开着。" }];
  const view = {
    rows: [
      { key: "r1", text: "11:00  我看了一眼：#555001 还开着。", own: false, tone: "normal", detail: "", parts },
      { key: "s3", text: "11:02  你：好", own: true, tone: "normal", detail: "" },
    ],
    asks: [],
  };
  const w = world({ policy: { ...policy, chat: { ...DEFAULT_POLICY.chat, redraw: 5 } } });
  const id = await started(w);
  const chats = createChats({
    ctx: w.ctx,
    paseo: {
      agents: { ref: () => ({ send: async () => {}, refresh: async () => null, archive: async () => undefined, timeline: { append: async (i: any) => void appended.push(i), subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }), refetch: async () => ({ entries: [] }) } }) },
      workspaces: { ref: () => ({ agents: { create: async () => ({ id: "c1" }) } }) },
    },
    state: (i: string) => ({ ...load(w.root, i), chatId: "c1", workspaceId: "w1", lines: read(w.root, i) }),
    write: () => {},
    view: () => view,
    log: () => {},
  });
  await chats.draw(id);
  const byId = (i: string) => appended.find((a) => a.id === i)!;
  assert.deepEqual(byId("row-r1").data.parts, parts);
  assert.equal(byId("row-s3").data.parts, undefined);
});

test("a question he is asked, in the chat and the panel, is plain words: the address is for places that can only show text (a push)", async () => {
  const w = world({ policy });
  const id = await started(w);
  await ops.brief(w.ctx, id);
  const r = await ops.report(w.ctx, id, {
    status: "单子还开着", entry: "单子还开着。", facts: [],
    next: { at: "2026-11-03 09:30", waitingFor: "等你回话", why: "他说明早再看", earlyIf: [] },
    ask: { title: "#555001 要关掉吗？", line: "关了我就不盯了", options: ["关", "不关"] },
  });
  assert.equal(r.ok, true, r.text);
  const engine = createEngine({ ctx: w.ctx, paseo: null, deliver: null, log: () => {} });
  const [ask] = engine.view(id)!.asks;
  assert.equal(ask!.title, "#555001 要关掉吗？");
  assert.equal(ask!.line, "关了我就不盯了");
  assert.equal(load(w.root, id).asks[0].title, "#555001 要关掉吗？", "the log keeps what was asked");
});

test("the push to POPO: plain address after the ticket, and only for a ticket; none without a template", async () => {
  for (const [links, expectUrl] of [[policy.links, true], [{}, false]] as const) {
    const w = world({ policy: { ...policy, links, push: { ...DEFAULT_POLICY.push, to: "p2p:me" } } });
    const pushed: string[] = [];
    const deliver: Deliver = async (_c, m) => void pushed.push(m.text);
    const engine = createEngine({ ctx: w.ctx, paseo: null, deliver, log: () => {} });
    const id = await started(w);
    await ops.brief(w.ctx, id);
    await ops.report(w.ctx, id, {
      status: "单子还开着", entry: "单子还开着。", facts: [],
      next: { at: "2026-11-03 09:30", waitingFor: "等你回话", why: "他说明早再看", earlyIf: [] },
      ask: { title: "#555001 要关掉吗？", options: ["关", "不关"] },
    });
    await engine.runEnded({ to: id, status: "succeeded", text: "ok", agentId: "a1" });
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0]!.includes(gcp("555001")), expectUrl, pushed[0]);
    assert.match(pushed[0]!, /#555001/);
    assert.doesNotMatch(pushed[0]!.split(gcp("555001")).join(""), MECHANISM);
  }
});

test("the public repo names no internal address: the code, the tests, the handbooks", () => {
  const root = path.join(import.meta.dirname, "..");
  // (written in pieces so this file does not contain what it looks for)
  const hosts = new RegExp([["net", "ease"].join(""), String.raw`\.` + "nie" + String.raw`\.`, "h72" + String.raw`\.pm`, "corp" + String.raw`\.`].join("|"), "i");
  const seen: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(ts|tsx|mjs|md|json)$/.test(name) && name !== "package-lock.json" && name !== "links.test.ts") seen.push(file);
    }
  };
  walk(root);
  for (const file of seen) assert.doesNotMatch(readFileSync(file, "utf8"), hosts, file);
});

// ---- the look that is asked for as the last one ends ----

const runs = (w: ReturnType<typeof world>) => w.calls().filter((c) => c[1] === "run-once").length;
const cleared = (w: ReturnType<typeof world>, id: string) => read(w.root, id).filter((l) => l.kind === "flag" && l.what === "look");

test("the CLI's reason is the whole of what it said: a JSON error read as its message, not as its first line", () => {
  assert.equal(whyOf(JSON.stringify({ error: { code: "x", message: "Schedule 1 is already running" } }, null, 2), ""), "Schedule 1 is already running");
  assert.equal(whyOf("", JSON.stringify({ error: "Schedule 1 is already running" }, null, 2)), "Schedule 1 is already running");
  assert.match(whyOf('{\n  "code": "conflict",\n  "detail": "Schedule 1 is already running"\n}', ""), /already running/);
  assert.equal(whyOf("Error: fake failure\n", ""), "Error: fake failure");
});

test("Paseo still counts the last look as running for a moment: the look is asked again and happens, with nothing written about it", async () => {
  const w = world();
  const made = await ops.create(w.ctx, { title: "洗牙", noWait: true });
  w.advance(10 * 60_000);
  process.env.FAKE_PASEO_BUSY = "2";
  const before = runs(w);
  const r = await ops.note(w.ctx, made.id, { said: "约好了，下周三下午", via: "workspace" });
  assert.equal(r.ok, true, r.text);
  assert.equal(runs(w) - before, 3, "two refused, the third went");
  assert.deepEqual(cleared(w, made.id), []);
  assert.equal(load(w.root, made.id).cleared?.void, undefined);
});

test("still running after the tries: left for the look that is on, and one line says it was tried", async () => {
  const w = world();
  const made = await ops.create(w.ctx, { title: "洗牙", noWait: true });
  w.advance(10 * 60_000);
  process.env.FAKE_PASEO_BUSY = "99";
  const before = runs(w);
  const r = await ops.note(w.ctx, made.id, { said: "约好了，下周三下午", via: "workspace" });
  assert.equal(r.ok, true, r.text);
  assert.equal(runs(w) - before, 5, "the first and four more");
  const lines = read(w.root, made.id);
  assert.equal(lines.filter((l) => l.kind === "ring").length, 1, "what he said waits for the look that is on");
  const [flag] = cleared(w, made.id);
  assert.match(flag.detail, /already running.*试了 5 次/);
  assert.equal(cleared(w, made.id).length, 1, "one line, not one per try");
});

test("another failure is not retried: one try, written down as it was", async () => {
  const w = world();
  const made = await ops.create(w.ctx, { title: "洗牙", noWait: true });
  w.advance(10 * 60_000);
  process.env.FAKE_PASEO_FAIL = "run-once";
  const before = runs(w);
  const r = await ops.note(w.ctx, made.id, { said: "约好了，下周三下午", via: "workspace" });
  assert.equal(r.ok, true);
  assert.equal(runs(w) - before, 1);
  assert.match(cleared(w, made.id)[0]!.detail, /fake failure/);
});
