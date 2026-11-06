import { createWatch } from "./kit";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createEngine } from "../server/engine";
import { load, read } from "../server/lib/log.mjs";
import * as ops from "../server/lib/ops.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { findReader, hashOf, listReaders, readOnce } from "../server/lib/readers.mjs";
import { scratch, world } from "./kit";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "readers");
const PUBLIC = path.join(HERE, "..", "readers");
const MIN = 60_000;

const policy = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_POLICY, readers: { ...DEFAULT_POLICY.readers, dirs: [FIXTURES], ...over } });

/** A value the fixture reader returns, in a file the test can change between reads. */
function source(w: ReturnType<typeof world>, spec: Record<string, unknown>) {
  const file = path.join(w.dir, "source.json");
  const set = (next: Record<string, unknown>) => writeFileSync(file, JSON.stringify(next));
  set(spec);
  return { file, set, reads: () => (existsSync(`${file}.count`) ? readFileSync(`${file}.count`, "utf8").length : 0) };
}

test("a tool is a file that prints {value, summary}; what is not that is a read that failed, with the reason", async () => {
  const p = policy({ timeoutSeconds: 0.4 });
  const w = world({ policy: p });
  const src = source(w, { mode: "ok", value: { version: "1.2" }, summary: "版本 1.2" });
  assert.deepEqual(await readOnce(p, "fake", { file: src.file }), { ok: true, value: { version: "1.2" }, summary: "版本 1.2" });
  src.set({ mode: "down" });
  const down = await readOnce(p, "fake", { file: src.file });
  assert.equal(down.ok, false);
  assert.match((down as { reason: string }).reason, /VPN/, "the one line the tool wrote");
  assert.match(((await readOnce(p, "junk", {})) as { reason: string }).reason, /不是 JSON/);
  assert.match(((await readOnce(p, "nosummary", {})) as { reason: string }).reason, /summary/);
  assert.match(((await readOnce(p, "big", {})) as { reason: string }).reason, /1024/);
  assert.match(((await readOnce(p, "slow", {})) as { reason: string }).reason, /没读完/);
  const none = await readOnce(p, "nope", {});
  assert.equal(none.ok, false);
  assert.equal((none as { missing?: boolean }).missing, true);
  assert.equal(findReader(p, "../fake"), null, "a name is a name, not a path");
});

test("private directories are searched first; the list says what each tool reads from its first line", () => {
  const priv = scratch("affairs-priv-");
  writeFileSync(path.join(priv, "feishu-task.mjs"), "// 私有的同名工具\nprocess.stdout.write('{}');\n");
  const p = policy({ dirs: [priv] });
  assert.equal(findReader(p, "feishu-task"), path.join(priv, "feishu-task.mjs"));
  const names = listReaders(p).map((r: { name: string }) => r.name);
  assert.ok(names.includes("feishu-task") && names.includes("http-json"), "the public ones are there too");
  assert.equal(names.filter((n: string) => n === "feishu-task").length, 1);
  assert.equal(listReaders(p).find((r: { name: string }) => r.name === "feishu-task")!.what, "私有的同名工具");
  for (const r of listReaders(policy({ dirs: [] }))) assert.ok(r.what, `${r.name} says what it reads in its first line`);
});

test("what counts as a change is the value: the order of its keys does not matter, and nothing about when it was read", () => {
  assert.equal(hashOf({ a: 1, b: { c: 2, d: [1, 2] } }), hashOf({ b: { d: [1, 2], c: 2 }, a: 1 }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
  assert.equal(hashOf(undefined), hashOf(null));
});

test("affair read: prints what it read; with --for it is written down and its reference is evidence a report accepts", async () => {
  const w = world({ policy: policy() });
  const src = source(w, { mode: "ok", value: { 提现状态: "审核中" }, summary: "提现审核中" });
  const made = await createWatch(w.ctx, { id: "dental", title: "提现", said: "帮我盯一下提现", noWait: true });
  const plain = await ops.readTool(w.ctx, "fake", { file: src.file });
  assert.equal(plain.ok, true);
  assert.equal(read(w.root, made.id).filter((l: { kind: string }) => l.kind === "read").length, 0, "without --for nothing is written");
  const got = await ops.readTool(w.ctx, "fake", { file: src.file }, { forId: made.id });
  const ref = /reader:r\d+/.exec(got.text)![0];
  assert.ok(ref);
  await ops.brief(w.ctx, made.id);
  const r = await ops.report(w.ctx, made.id, {
    status: "提现审核中", entry: "提现还在审核。", facts: [],
    next: { at: "2026-11-30 09:00", waitingFor: "等提现审核", why: "审核要几天", earlyIf: [], evidence: [{ from: ref, quote: "提现状态审核中" }] },
  });
  assert.equal(r.ok, true, r.text);
  const bad = await ops.report(w.ctx, made.id, { entry: "还没进外网", status: "x", facts: [], next: { at: "2026-11-30 09:00", waitingFor: "等引擎进外网", why: "还没进外网", earlyIf: [], evidence: [{ from: "reader:r999", quote: "提现状态审核中" }] } }).catch((e: Error) => ({ ok: false, text: e.message }));
  assert.equal(bad.ok, false, "a reference that was never read is not evidence");
});

test("a read that failed is written down with its reason when it is for an affair; a value with a token in it is not written at all", async () => {
  const w = world({ policy: policy() });
  const src = source(w, { mode: "down" });
  const made = await createWatch(w.ctx, { id: "other-2", title: "洗牙", noWait: true });
  const failed = await ops.readTool(w.ctx, "fake", { file: src.file }, { forId: made.id });
  assert.equal(failed.ok, false);
  assert.match(failed.text, /VPN/);
  const line = read(w.root, made.id).find((l: { kind: string }) => l.kind === "read");
  assert.equal(line.ok, false);
  src.set({ mode: "ok", value: { key: "sk-abcdefghijklmnopqrstuvwxyz0123" }, summary: "有个钥匙" });
  const secret = await ops.readTool(w.ctx, "fake", { file: src.file }, { forId: made.id });
  assert.equal(secret.ok, false);
  assert.equal(read(w.root, made.id).filter((l: { kind: string; ok?: boolean }) => l.kind === "read" && l.ok).length, 0);
});

test("the brief lists the tools and what is watched; a watch needs a tool that exists", async () => {
  const w = world({ policy: policy() });
  const src = source(w, { mode: "ok", value: { n: 1 }, summary: "一" });
  const made = await createWatch(w.ctx, { id: "other-3", title: "洗牙", noWait: true });
  await ops.brief(w.ctx, made.id);
  const bad = await ops.report(w.ctx, made.id, { status: "等", entry: "等。", facts: [], next: { at: "2026-11-03 09:30", waitingFor: "等引擎进外网", why: "还没进外网", earlyIf: [] }, watches: [{ id: "w1", tool: "no-such-tool", args: {} }] });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /no-such-tool/);
  const good = await ops.report(w.ctx, made.id, { status: "等", entry: "等。", facts: [], next: { at: "2026-11-03 09:30", waitingFor: "等引擎进外网", why: "还没进外网", earlyIf: ["watch:w1"] }, watches: [{ id: "w1", tool: "fake", args: { file: src.file }, value: { n: 1 }, summary: "一", label: "数", every: 1 }] });
  assert.equal(good.ok, true, good.text);
  const w1 = load(w.root, made.id).watches.w1;
  assert.equal(w1.hash, hashOf({ n: 1 }), "the look's own reading is the baseline");
  assert.equal(w1.every, DEFAULT_POLICY.readers.minEveryMinutes, "never more often than the floor");
  const text = (await ops.brief(w.ctx, made.id)).text;
  assert.match(text, /- fake：/);
  assert.match(text, /- http-json：/);
  assert.match(text, /w1（数，每 5 分钟读一次）/);
});

// ---- the loop

async function watching(over: Record<string, unknown> = {}) {
  const w = world({ policy: policy(over) });
  const src = source(w, { mode: "ok", value: { 版本: "1.0" }, summary: "版本 1.0" });
  const calls = { looks: () => w.calls().filter((c) => c[1] === "run-once").length, asked: [] as string[], pushed: 0 };
  const engine = createEngine({
    ctx: w.ctx, paseo: null, deliver: null, log: () => {},
  });
  const made = await createWatch(w.ctx, { id: "other-4", title: "引擎上车", said: "帮我盯一下引擎", noWait: true });
  const id = made.id as string;
  await ops.brief(w.ctx, id);
  const r = await ops.report(w.ctx, id, {
    status: "等引擎", entry: "等引擎。", facts: [],
    next: { at: "2026-11-09 09:30", waitingFor: "等引擎进外网", why: "还没进", earlyIf: ["watch:w1"], waitingOn: "others" },
    watches: [{ id: "w1", tool: "fake", args: { file: src.file }, value: { 版本: "1.0" }, summary: "版本 1.0", label: "外网版本", every: 10 }],
  });
  assert.equal(r.ok, true, r.text);
  append(w, id, { kind: "wake.end", state: "ok", usd: 0 });
  return { w, src, engine, id, calls };
}

function append(w: ReturnType<typeof world>, id: string, line: Record<string, unknown>) {
  const file = path.join(w.root, id, "log.jsonl");
  const seq = read(w.root, id).at(-1).seq + 1;
  writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ ...line, seq, at: new Date(w.now()).toISOString() })}\n`);
}

test("the loop reads when the interval has passed, and only a different value counts: a new reading time or summary does not", async () => {
  const t = await watching();
  await t.engine.readPass();
  assert.equal(t.src.reads(), 1, "the first pass reads once");
  await t.engine.readPass();
  assert.equal(t.src.reads(), 1, "not again before its interval");
  const quiet = t.calls.looks();
  t.w.advance(11 * MIN);
  t.src.set({ mode: "ok", value: { 版本: "1.0" }, summary: "版本 1.0（11:05 读的）" });
  await t.engine.readPass();
  assert.equal(t.src.reads(), 2);
  assert.equal(read(t.w.root, t.id).filter((l: { kind: string }) => l.kind === "watch.read").length, 0, "same value: nothing is written, nothing looks");
  assert.equal(t.calls.looks(), quiet, "no look from this");
  const before = t.calls.looks();
  t.w.advance(11 * MIN);
  t.src.set({ mode: "ok", value: { 版本: "1.1" }, summary: "版本 1.1" });
  await t.engine.readPass();
  const lines = read(t.w.root, t.id).filter((l: { kind: string }) => l.kind === "watch.read");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].changed, true);
  assert.equal(t.calls.looks(), before + 1, "a change looks at the affair");
  const w1 = load(t.w.root, t.id).watches.w1;
  assert.deepEqual([w1.value, w1.prev.value], [{ 版本: "1.1" }, { 版本: "1.0" }]);
  assert.match((await ops.brief(t.w.ctx, t.id)).text, /变了：原来 \{"版本":"1.0"\}.*现在 \{"版本":"1.1"\}/);
});

test("a change that comes while the affair was looked at a moment ago waits for the gap, and is not lost", async () => {
  const t = await watching();
  await t.engine.readPass();
  await ops.brief(t.w.ctx, t.id);
  append(t.w, t.id, { kind: "wake.end", state: "ok", usd: 0 });
  const before = t.calls.looks();
  t.w.advance(11 * MIN);
  t.src.set({ mode: "ok", value: { 版本: "2.0" }, summary: "2.0" });
  await t.engine.readPass();
  assert.equal(t.calls.looks(), before, "looked at 11 minutes ago: not yet");
  assert.ok(load(t.w.root, t.id).pending.some((p: string) => p === "watch:w1"), "the change is remembered");
  t.w.advance(5 * MIN);
  await t.engine.readPass();
  assert.equal(t.calls.looks(), before + 1, "after fifteen minutes it is looked at");
});

test("a read that fails does not look; it is written down a few times, then the person is told once, and told again only after they say it is fixed and it still fails", async () => {
  const t = await watching({ failuresBeforeAsk: 3 });
  t.src.set({ mode: "down" });
  const looks = t.calls.looks();
  for (let i = 0; i < 6; i++) {
    t.w.advance(11 * MIN);
    await t.engine.readPass();
  }
  assert.equal(t.calls.looks(), looks, "nothing to look at");
  const log = read(t.w.root, t.id);
  assert.equal(log.filter((l: { kind: string; ok?: boolean }) => l.kind === "watch.read" && l.ok === false).length, 3, "written three times, not every time");
  const asks = log.filter((l: { kind: string }) => l.kind === "asked");
  assert.equal(asks.length, 1, "told once");
  assert.match(asks[0].title, /外网版本读不到/);
  assert.match(asks[0].line, /VPN.*处理好了点一下/);
  assert.ok(!/叫醒|校验|记录|计划|读数|会话|agent/i.test(`${asks[0].title}${asks[0].line}`), "what the person reads has none of the inner words");
  assert.deepEqual(asks[0].options, ["好了", "不用盯了"]);
  await ops.answer(t.w.ctx, t.id, asks[0].id, "好了");
  assert.equal(load(t.w.root, t.id).watches.w1.failures, 0);
  for (let i = 0; i < 4; i++) {
    t.w.advance(11 * MIN);
    await t.engine.readPass();
  }
  assert.equal(read(t.w.root, t.id).filter((l: { kind: string }) => l.kind === "asked").length, 2, "asked again after another run of failures");
  t.src.set({ mode: "ok", value: { 版本: "1.0" }, summary: "版本 1.0" });
  t.w.advance(11 * MIN);
  await t.engine.readPass();
  const w1 = load(t.w.root, t.id).watches.w1;
  assert.deepEqual([w1.failures, w1.downAsked, w1.lastError], [0, false, ""], "a read that works again clears it, without looking (same value)");
});

test("a watch with an end time ends then, and the affair is looked at once more", async () => {
  const t = await watching();
  await ops.brief(t.w.ctx, t.id);
  await ops.report(t.w.ctx, t.id, {
    status: "盯着", entry: "盯半小时。", facts: [],
    next: { at: "2026-11-09 09:30", waitingFor: "盯半小时", why: "他说盯半小时", earlyIf: ["watch:w1"] },
    watches: [{ id: "w1", tool: "fake", args: { file: t.src.file }, value: { 版本: "1.0" }, summary: "x", every: 10, until: "2026-11-02 10:30" }],
  });
  append(t.w, t.id, { kind: "wake.end", state: "ok", usd: 0 });
  t.w.advance(31 * MIN);
  const before = t.calls.looks();
  await t.engine.readPass();
  assert.deepEqual(Object.keys(load(t.w.root, t.id).watches), []);
  assert.equal(t.calls.looks(), before + 1);
});

test("one pass reads only so many; the loop sweeps lost runs through the hook it was given", async () => {
  const w = world({ policy: policy({ perPass: 2 }) });
  const src = source(w, { mode: "ok", value: { n: 1 }, summary: "一" });
  let swept = 0;
  const engine = createEngine({ ctx: w.ctx, paseo: null, deliver: null, log: () => {}, wakeLost: async () => void (swept += 1) });
  const made = await createWatch(w.ctx, { id: "other-5", title: "多", noWait: true });
  await ops.brief(w.ctx, made.id);
  const r = await ops.report(w.ctx, made.id, {
    status: "等", entry: "等。", facts: [], next: { at: "2026-11-09 09:30", waitingFor: "等引擎进外网", why: "还没进外网", earlyIf: [] },
    watches: ["w1", "w2", "w3"].map((id) => ({ id, tool: "fake", args: { file: src.file }, value: { n: 1 }, summary: "一", every: 10 })),
  });
  assert.equal(r.ok, true, r.text);
  await engine.readPass();
  assert.equal(src.reads(), 2);
  await engine.readPass();
  assert.equal(src.reads(), 3, "the third on the next pass");
  assert.equal(swept, 2);
});

// ---- the public tools, against a local server and a fake command line

test("http-json takes the keys asked for from a JSON file, null for a key that is not there; a bad answer is a failed read", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/ok") res.end(`﻿${JSON.stringify({ greys: { a_flag: 10, b_flag: { p: 1 } }, version: "3.4", stamp: 1 })}`);
    else res.writeHead(req.url === "/html" ? 200 : 503).end("<html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Asynchronous: the server that answers is in this process.
  const run = (args: Record<string, unknown>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(PUBLIC, "http-json.mjs")]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify({ args }));
    });
  try {
    const ok = await run({ url: `${base}/ok`, sections: ["greys", ""], keys: ["a_flag", "version", "missing"] });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout).value, { a_flag: 10, version: "3.4", missing: null });
    const all = JSON.parse((await run({ url: `${base}/ok`, sections: ["greys"] })).stdout);
    assert.deepEqual(Object.keys(all.value), ["greys.a_flag", "greys.b_flag"]);
    const down = await run({ url: `${base}/503` });
    assert.equal(down.status, 1);
    assert.match(down.stderr, /HTTP 503/);
    assert.equal((await run({ url: `${base}/html` })).status, 1);
    assert.equal((await run({})).status, 1);
    assert.equal((await run({ url: "file:///etc/passwd" })).status, 1, "only http and https");
  } finally {
    server.close();
  }
});

test("feishu-task reads one task or finds by a word; without a command line it is a failed read with a reason", () => {
  const cli = path.join(scratch("affairs-cli-"), "lark.mjs");
  writeFileSync(cli, `const a = process.argv.slice(2).join(" ");
if (a.startsWith("task tasks get")) console.log(JSON.stringify({ ok: true, data: { task: { summary: "右下牙冠取模", completed_at: "0", due: { timestamp: "1794036600000" }, description: "已约好", created_at: "1" } } }));
else if (a.includes("--query")) console.log(JSON.stringify({ ok: true, data: { items: [{ summary: "定期洗牙", completed: false, due_at: "2027-04-05T09:00:00+08:00", guid: "g1" }] } }));
else { console.log(JSON.stringify({ ok: false, error: { message: "没登录" } })); }`);
  const run = (args: Record<string, unknown>, env: Record<string, string> = { AFFAIR_LARK_CLI: cli }) => spawnSync(process.execPath, [path.join(PUBLIC, "feishu-task.mjs")], { input: JSON.stringify({ args }), encoding: "utf8", env: { ...process.env, ...env } });
  const one = run({ guid: "67ca625e-a8d2-4aed-b32e-a41617377e76" });
  assert.equal(one.status, 0, one.stderr);
  const value = JSON.parse(one.stdout).value;
  assert.deepEqual(value, { summary: "右下牙冠取模", completed: false, due: "2026-11-07", note: "已约好" });
  assert.ok(!JSON.stringify(value).includes("created"), "no creation or update time in the value");
  assert.match(JSON.parse(run({ query: "洗牙" }).stdout).summary, /定期洗牙/);
  const refused = run({ guid: "bad guid!" });
  assert.equal(refused.status, 1);
  const noCli = run({ guid: "67ca625e-a8d2-4aed-b32e-a41617377e76" }, { AFFAIR_LARK_CLI: path.join(os.tmpdir(), "no-such-cli.exe") });
  assert.equal(noCli.status, 1);
  assert.match(noCli.stderr, /lark-cli/);
});

test("a value that looks like a secret is never written by the loop; it counts as a read that failed", async () => {
  const t = await watching();
  t.src.set({ mode: "ok", value: { 钥匙: "sk-abcdefghijklmnopqrstuvwxyz0123" }, summary: "有个钥匙" });
  t.w.advance(11 * MIN);
  await t.engine.readPass();
  const text = readFileSync(path.join(t.w.root, t.id, "log.jsonl"), "utf8");
  assert.ok(!text.includes("sk-abcdefghijklmnop"), "not in the log");
  assert.equal(load(t.w.root, t.id).watches.w1.failures, 1);
});

test("an affair that ended is not read any more", async () => {
  const t = await watching();
  await ops.stop(t.w.ctx, t.id);
  t.w.advance(11 * MIN);
  await t.engine.readPass();
  assert.equal(t.src.reads(), 0);
});

test("the command: affair read finds the tool in the directories of policy.json, prints what it read, and says why when it cannot", () => {
  const w = world();
  const src = source(w, { mode: "ok", value: { n: 1 }, summary: "一" });
  mkdirSync(w.root, { recursive: true });
  writeFileSync(path.join(w.root, "policy.json"), JSON.stringify({ readers: { dirs: [FIXTURES] } }));
  const bin = path.join(HERE, "..", "bin", "affair.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, "--root", w.root, ...args], { encoding: "utf8" });
  const ok = run("read", "fake", "--args", JSON.stringify({ file: src.file }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim().split(/\r?\n/).join("|"), `一|${JSON.stringify({ n: 1 })}`);
  src.set({ mode: "down" });
  const down = run("read", "fake", "--args", JSON.stringify({ file: src.file }));
  assert.equal(down.status, 1);
  assert.match(down.stdout, /读不到：.*VPN/);
  const none = run("read", "no-such");
  assert.equal(none.status, 1);
  assert.match(none.stdout, /fake/, "it lists the tools there are");
  assert.equal(run("read", "fake", "--args", "{oops").status, 2);
});
