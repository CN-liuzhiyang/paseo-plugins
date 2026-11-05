import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import * as ops from "../server/lib/ops.mjs";
import { claimFile, eventsFile } from "../server/lib/flows.mjs";
import { append, load, read } from "../server/lib/log.mjs";
import { scratch, world } from "./kit";

// `affair flow`: who may start a flow, what stops a second start, and what the started process is (its place, its
// environment, its files). The runtime and the prepare program are small stand-ins that write down what they were given.

const HOUR = 3_600_000;

const STATUS_MODULE = pathToFileURL(path.resolve(import.meta.dirname, "../../orchestration/runtime/status.mjs")).href;

/**
 * What the stand-in runtime does with the command line it is started with, and what it leaves for the test to read. `status` is
 * the real runtime's own (runtime/status.mjs), reading the claim and events files the stand-in and the tests write.
 */
const FAKE_ORCH = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "status") {
  if (process.env.FAKE_ORCH_STATUS_BROKEN) { process.stderr.write("broken"); process.exit(1); }
  const { runStatus } = await import(${JSON.stringify(STATUS_MODULE)});
  const at = argv.indexOf("--spawned-at");
  console.log(JSON.stringify(runStatus({ dir: process.env.ORCH_LOG_DIR, runId: argv[1], spawnedAt: at > 0 ? Number(argv[at + 1]) : null })));
  process.exit(0);
}
const get = (k) => argv[argv.indexOf(k) + 1];
const runId = get("--run-id");
const file = (flag) => JSON.parse(readFileSync(get(flag).slice(1), "utf8"));
const logDir = process.env.ORCH_LOG_DIR;
mkdirSync(path.join(logDir, "runs"), { recursive: true });
writeFileSync(path.join(process.env.FAKE_ORCH_OUT, runId + ".json"), JSON.stringify({
  argv, cwd: process.cwd(), input: file("--input"), affair: file("--affair"),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^PASEO_|^ORCH_LOG_DIR$/.test(k))),
}));
process.chdir(process.env.TEMP || "/tmp"); // the test removes the working directory when it ends; a process standing in it would hold it
if (process.env.FAKE_ORCH_REFUSE) {
  writeFileSync(path.join(logDir, "runs", runId + ".claim"), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), refused: process.env.FAKE_ORCH_REFUSE }));
  process.exit(2);
}
writeFileSync(path.join(logDir, "runs", runId + ".claim"), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }));
writeFileSync(path.join(logDir, "runs", runId + ".jsonl"), JSON.stringify({ v: 1, seq: 0, ts: new Date().toISOString(), runId, kind: "run.start", flow: { name: "do-it", phases: [{ id: "plan", title: "方案" }] } }) + "\\n");
setTimeout(() => process.exit(0), 3000);
`;

/** The program that makes the input. FAKE_PREPARE_DELAY_MS holds it back; FAKE_PREPARE_SLOW_SECOND holds back only the second one to be asked. */
const PREPARE = `
import { closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
const { args } = JSON.parse(readFileSync(0, "utf8"));
if (process.env.FAKE_PREPARE_FAIL) { process.stderr.write(process.env.FAKE_PREPARE_FAIL + "\\n"); process.exit(1); }
let wait = Number(process.env.FAKE_PREPARE_DELAY_MS || 0);
if (process.env.FAKE_PREPARE_SLOW_SECOND) {
  try { closeSync(openSync(path.join(process.env.FAKE_ORCH_OUT, "prepared-once"), "wx")); } catch { wait = Number(process.env.FAKE_PREPARE_SLOW_SECOND); }
}
const answer = () => process.stdout.write(JSON.stringify({ value: { itemNo: Number(args.ref), agentCwd: args.workdir }, summary: "ok" }));
if (process.env.FAKE_PREPARE_HOLD) {
  // Takes a number (hold-1, hold-2) and answers when the test puts go-<number> down.
  const { existsSync } = await import("node:fs");
  let n = 1;
  for (;; n++) { try { closeSync(openSync(path.join(process.env.FAKE_ORCH_OUT, "hold-" + n), "wx")); break; } catch {} }
  const timer = setInterval(() => { if (existsSync(path.join(process.env.FAKE_ORCH_OUT, "go-" + n))) { clearInterval(timer); answer(); } }, 20);
} else setTimeout(answer, wait);
`;

function setup({ perDay = 3 }: { perDay?: number } = {}) {
  const home = scratch("flow-home-");
  const work = path.join(home, "work");
  mkdirSync(work, { recursive: true });
  const orch = path.join(home, "fake-orch.mjs");
  const prepare = path.join(home, "prepare.mjs");
  writeFileSync(orch, FAKE_ORCH);
  writeFileSync(prepare, PREPARE);
  const out = path.join(home, "out");
  mkdirSync(out);
  const logDir = path.join(home, "orch-logs");
  Object.assign(process.env, { AFFAIR_NODE: process.execPath, ORCH_LOG_DIR: logDir, FAKE_ORCH_OUT: out });
  delete process.env.FAKE_ORCH_REFUSE;
  delete process.env.FAKE_PREPARE_FAIL;
  delete process.env.FAKE_PREPARE_DELAY_MS;
  delete process.env.FAKE_PREPARE_SLOW_SECOND;
  delete process.env.FAKE_PREPARE_HOLD;
  delete process.env.FAKE_ORCH_STATUS_BROKEN;
  const w = world({
    policy: {
      homes: { gcp: work },
      links: { gcp: "https://tickets.example/{ref}" },
      flows: { perDay, orch, "do-it": { kinds: ["gcp"], prepare, timeout: "30h", says: "读单 → 方案 → 提交" }, "other-job": { kinds: ["feishu-task"], prepare, timeout: "1h" } },
    },
  });
  w.ctx.flowWaitMs = 4000;
  return { w, work, logDir, out, ran: (runId: string) => JSON.parse(readFileSync(path.join(out, `${runId}.json`), "utf8")) };
}

async function ticket(w: ReturnType<typeof world>, number = "700", title = "某某闪退") {
  const made = await ops.create(w.ctx, { title: `#${number} ${title}`, link: `gcp:#${number}`, said: `帮我盯一下 #${number}`, noWait: true });
  assert.equal(made.ok, true, made.text);
  return made.id as string;
}

const finish = (logDir: string, runId: string, outcome = "done") => writeFileSync(eventsFile(logDir, runId), `${JSON.stringify({ kind: "run.start", runId })}\n${JSON.stringify({ kind: "run.end", runId, outcome })}\n`);
const chatOf = (w: ReturnType<typeof world>, id: string) => ({ ...w.ctx, by: "chat", chatFor: id });

test("flow with no name lists what this kind of affair can start; a look cannot start one", async () => {
  const { w } = setup();
  const id = await ticket(w);
  const list = await ops.flow(w.ctx, id);
  assert.equal(list.ok, true);
  assert.match(list.text, /do-it（读单 → 方案 → 提交）/);
  assert.doesNotMatch(list.text, /other-job/, "a flow for another kind of reference is not on the list");
  const look = await ops.flow({ ...w.ctx, by: "look" }, id, "do-it");
  assert.equal(look.ok, false);
  assert.match(look.text, /看一眼的会话，不能起流程/);
  assert.equal(load(w.root, id).flows.length, 0);
});

test("refused: a flow that is not allowed, one for another kind of reference, an affair that is over, a chat without his words", async () => {
  const { w } = setup();
  const id = await ticket(w);
  assert.match((await ops.flow(w.ctx, id, "no-such")).text, /没有叫「no-such」的流程可起。能起的有：do-it、other-job/);
  assert.match((await ops.flow(w.ctx, id, "other-job")).text, /管的是 feishu-task 的事/);
  const plain = await ops.create(w.ctx, { title: "洗牙", noWait: true });
  assert.match((await ops.flow(w.ctx, plain.id, "do-it")).text, /管的是 gcp 的事/);

  const chat = chatOf(w, id);
  assert.match((await ops.flow(chat, id, "do-it")).text, /要指给他说的那一行：--said-seq/);
  await ops.hear(w.ctx, id, "好，用 do-it 做");
  const said = load(w.root, id).said[0].seq;
  assert.match((await ops.flow(chat, id, "do-it", { saidSeq: 99 })).text, /--said-seq 99 不是他说的话/);
  const mine = (await ops.note(chat, id, { said: "我自己记的", mine: true })).seq;
  assert.match((await ops.flow(chat, id, "do-it", { saidSeq: mine })).text, /不是他说的话/, "a line the chat wrote for itself is not his");
  assert.match((await ops.flow(w.ctx, id, "do-it", { saidSeq: said })).text, /--said-seq 只有对话的会话用/);

  await ops.stop(w.ctx, id);
  assert.match((await ops.flow(w.ctx, id, "do-it")).text, /不盯了，不起流程/);
  assert.equal(load(w.root, id).flows.length, 0, "nothing was started or written by any of these");
  assert.deepEqual(existsSync(path.join(w.root, id, "flows")), false);
});

test("started from the person's side: the files, the place it runs in, and an environment that does not name the session that asked", async () => {
  const { w, work, logDir, ran } = setup();
  const id = await ticket(w);
  const saved = { ...process.env };
  Object.assign(process.env, { PASEO_AGENT_ID: "agent-that-asked", PASEO_AGENT_CWD: "/somewhere", PASEO_WORKSPACE_ID: "wks_other", PASEO_HOME: "/isolated/home", PASEO_CLI: "kept" });
  try {
    const result = await ops.flow(w.ctx, id, "do-it");
    assert.equal(result.ok, true, result.text);
    assert.equal(result.text.split("\n")[0], "起了 do-it（读单 → 方案 → 提交），要你批的时候这件事会亮。");

    const seen = ran(result.runId);
    for (const name of ["PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID"]) assert.equal(seen.env[name], undefined, `${name} is not passed on`);
    assert.equal(seen.env.PASEO_HOME, "/isolated/home", "the daemon it is for stays");
    assert.equal(seen.env.PASEO_CLI, "kept", "only the session's identity is dropped, not every PASEO_ variable");
    assert.equal(seen.env.ORCH_LOG_DIR, logDir, "the runtime writes where the command looks");
    assert.equal(path.resolve(seen.cwd).toLowerCase(), path.resolve(work).toLowerCase(), "it runs in the affair's working directory");
    assert.deepEqual(seen.argv.slice(0, 4), ["run", "do-it", "--run-id", result.runId]);
    assert.equal(seen.argv[seen.argv.indexOf("--timeout") + 1], "30h");

    const state = load(w.root, id);
    assert.deepEqual(seen.affair, { label: "#700 某某闪退", key: "affair:700", workspace: state.workspaceId, url: "https://tickets.example/700" });
    assert.deepEqual(seen.input, { itemNo: 700, agentCwd: work }, "what the prepare program printed, nothing typed");
    assert.equal(state.flows.length, 1);
    assert.deepEqual({ flow: state.flows[0].flow, runId: state.flows[0].runId, by: state.flows[0].by, failed: state.flows[0].failed }, { flow: "do-it", runId: result.runId, by: "human", failed: "" });
    assert.equal(state.flows[0].events, eventsFile(logDir, result.runId));
    assert.ok(result.pid, "it has a process of its own");
    assert.doesNotThrow(() => process.kill(result.pid, 0), "and that process is still going when the command returns");
  } finally {
    for (const name of ["PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID", "PASEO_HOME", "PASEO_CLI"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("started from the chat: his line is the evidence, it is on the row of what happened, and the row says what he said", async () => {
  const { w } = setup();
  const id = await ticket(w);
  await ops.hear(w.ctx, id, "好，用 do-it 做\n  so go。启动");
  const said = load(w.root, id).said.at(-1)!.seq;
  const result = await ops.flow(chatOf(w, id), id, "do-it", { saidSeq: said });
  assert.equal(result.ok, true, result.text);
  const state = load(w.root, id);
  assert.deepEqual([state.flows[0].by, state.flows[0].said], ["chat", said]);
  const { rowsOf } = await import("../server/lib/view.mjs");
  const rows = rowsOf({ ...state, lines: read(w.root, id) }, w.now(), w.ctx.policy);
  const row = rows.find((r: { text: string }) => /起了 do-it/.test(r.text));
  assert.ok(row, "one row for the start");
  assert.match(row.text, /起了 do-it（你说：「好，用 do-it 做 so go。启动」）/);
  assert.doesNotMatch(row.text, /叫醒|校验|记录|计划|读数|会话|agent/i);
});

test("not started twice: one still going refuses a second, and so does the same flow run before without --again", async () => {
  const { w, logDir } = setup();
  const id = await ticket(w);
  const first = await ops.flow(w.ctx, id, "do-it");
  assert.equal(first.ok, true, first.text);

  // The stand-in runtime has begun (run.start) and not ended: it is going, whatever flow is asked for.
  const going = await ops.flow(w.ctx, id, "do-it", { again: true });
  assert.equal(going.ok, false);
  assert.match(going.text, /^已经在跑：do-it（\d\d:\d\d 起）/);
  assert.match((await ops.flow(w.ctx, id, "other-job")).text, /管的是 feishu-task/, "the other checks come first and say what is wrong with the ask");
  assert.equal(load(w.root, id).flows.length, 1, "no second start was written");

  finish(logDir, first.runId);
  const again = await ops.flow(w.ctx, id, "do-it");
  assert.equal(again.ok, false);
  assert.match(again.text, /跑过一次 do-it（做完了）。要再跑一次，加 --again/);
  const second = await ops.flow(w.ctx, id, "do-it", { again: true });
  assert.equal(second.ok, true, second.text);
  assert.equal(second.text.split("\n")[1], `这件事 ${second.text.match(/(\d\d:\d\d)/)![1]} 跑过一次 do-it（做完了），这是第二次。`);
  assert.equal(load(w.root, id).flows.length, 2);
});

test("two starts at the same moment: one runs, the other is turned away before anything is written for it", async () => {
  const { w, ran } = setup();
  const id = await ticket(w);
  const [a, b] = await Promise.all([ops.flow(w.ctx, id, "do-it"), ops.flow(w.ctx, id, "do-it")]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  const loser = a.ok ? b : a;
  assert.match(loser.text, /已经在跑/);
  const state = load(w.root, id);
  assert.equal(state.flows.length, 1, "the one that was turned away left no line");
  assert.ok(ran((a.ok ? a : b).runId), "only one process was made");
  assert.equal(readdirSync(path.join(w.root, id, "flows")).length, 2, "and only one run's files are left: the input and the affair of the winner");
});

test("a run the runtime turns away at once: said in his words, written as not started, and it does not count against asking again", async () => {
  const { w } = setup();
  const id = await ticket(w);
  process.env.FAKE_ORCH_REFUSE = "input: gateTimeout is not a duration";
  const refused = await ops.flow(w.ctx, id, "do-it");
  delete process.env.FAKE_ORCH_REFUSE;
  assert.equal(refused.ok, false);
  assert.equal(refused.text, "没起成：input: gateTimeout is not a duration");
  const state = load(w.root, id);
  assert.equal(state.flows.length, 1);
  assert.match(state.flows[0].failed, /gateTimeout/);
  const { rowsOf } = await import("../server/lib/view.mjs");
  assert.ok(!rowsOf({ ...state, lines: read(w.root, id) }, w.now(), w.ctx.policy).some((r: { text: string }) => /起了/.test(r.text)), "no row says it was started");
  const next = await ops.flow(w.ctx, id, "do-it");
  assert.equal(next.ok, true, `${next.text} (no --again is asked for when nothing ever ran)`);
});

test("when the item cannot be read nothing is written and nothing is started", async () => {
  const { w, out } = setup();
  const id = await ticket(w);
  process.env.FAKE_PREPARE_FAIL = "工单系统没登录或登录过期";
  const result = await ops.flow(w.ctx, id, "do-it");
  delete process.env.FAKE_PREPARE_FAIL;
  assert.equal(result.ok, false);
  assert.equal(result.text, "没起成：读不到单子：工单系统没登录或登录过期");
  assert.equal(load(w.root, id).flows.length, 0);
  assert.equal(existsSync(path.join(w.root, id, "flows")), false);
  assert.deepEqual(existsSync(out) && (await import("node:fs")).readdirSync(out), []);
});

test("a day has a number of starts, counted over all affairs and not by those that never ran", async () => {
  const { w, logDir } = setup({ perDay: 2 });
  const ids = [await ticket(w, "700"), await ticket(w, "701"), await ticket(w, "702")];
  const first = await ops.flow(w.ctx, ids[0], "do-it");
  const second = await ops.flow(w.ctx, ids[1], "do-it");
  assert.deepEqual([first.ok, second.ok], [true, true], first.text + second.text);
  finish(logDir, first.runId);
  finish(logDir, second.runId);
  const third = await ops.flow(w.ctx, ids[2], "do-it");
  assert.equal(third.ok, false);
  assert.match(third.text, /今天已经起了 2 次流程，到一天的上限（2 次）了/);
  w.advance(24 * HOUR);
  assert.equal((await ops.flow(w.ctx, ids[2], "do-it")).ok, true, "the next day it is allowed again");
});

test("the panel's 经过 has a row for the start, with his words, and none for one that never started", async () => {
  const { w } = setup();
  const id = await ticket(w);
  await ops.hear(w.ctx, id, "好，用 do-it 做\n  so go。启动");
  const said = load(w.root, id).said.at(-1)!.seq;
  process.env.FAKE_ORCH_REFUSE = "turned away";
  assert.equal((await ops.flow(chatOf(w, id), id, "do-it", { saidSeq: said })).ok, false);
  delete process.env.FAKE_ORCH_REFUSE;
  const { eventsOf } = await import("../server/lib/events.mjs");
  const { linkContext } = await import("../server/lib/links.mjs");
  const rowsNow = () => {
    const s = { ...load(w.root, id), lines: read(w.root, id) };
    return eventsOf(s, w.now(), w.ctx.policy, linkContext(w.ctx.policy, s.link), { labelOf: (tool: string) => ({ name: tool }) }).items.filter((r: { kind: string }) => r.kind === "flow");
  };
  assert.equal(rowsNow().length, 0, "it was turned away: nothing started");
  assert.equal((await ops.flow(chatOf(w, id), id, "do-it", { saidSeq: said })).ok, true);
  const [row] = rowsNow();
  assert.equal(rowsNow().length, 1);
  assert.deepEqual([row.label, row.text], ["流程 · do-it", "在跑"]);
  assert.deepEqual(row.children.map((k: { text: string }) => k.text), ["起了（你说：「好，用 do-it 做 so go。启动」）"], "what he said is the first step under the row");
  assert.doesNotMatch(`${row.label}${row.text}${row.children[0].text}`, /叫醒|校验|记录|计划|读数|会话|agent/i);
});

test("the affair's label is what the runtime accepts: one line, nothing invisible, at most 120 characters, the number not said twice", async () => {
  const { labelOf } = await import("../server/lib/flows.mjs");
  assert.equal(labelOf("700", "#700 某某闪退"), "#700 某某闪退");
  assert.equal(labelOf("700", "某某闪退"), "#700 某某闪退");
  assert.equal(labelOf("700", "两行\n的\u200b标题\u3164"), "#700 两行 的 标题");
  const long = labelOf("700", "字".repeat(300));
  assert.equal([...long].length, 120);
  assert.ok(long.endsWith("…"));
});

// --- The boundaries of starting (the review of the first version): what was checked before the input was made is checked again ---

const heard = async (w: ReturnType<typeof world>, id: string, text: string) => {
  assert.equal((await ops.hear(w.ctx, id, text)).ok, true);
  return load(w.root, id).said.at(-1)!.seq as number;
};
const startedCount = (out: string) => readdirSync(out).filter((n) => n.endsWith(".json")).length;

test("a request that waited for its input is checked again: the first ended meanwhile, and the second still needs --again", async () => {
  const { w, logDir, out } = setup();
  const id = await ticket(w);
  process.env.FAKE_PREPARE_HOLD = "1";
  const both = [ops.flow(w.ctx, id, "do-it"), ops.flow(w.ctx, id, "do-it")];
  const until = async (what: () => boolean) => { for (let i = 0; i < 300 && !what(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(what()); };
  // Both got past the first look (nothing was going) and are making their input; the first to finish starts, and ends.
  await until(() => existsSync(path.join(out, "hold-1")) && existsSync(path.join(out, "hold-2")));
  writeFileSync(path.join(out, "go-1"), "");
  await until(() => load(w.root, id).flows.length === 1 && existsSync(eventsFile(logDir, load(w.root, id).flows[0].runId)));
  finish(logDir, load(w.root, id).flows[0].runId);
  writeFileSync(path.join(out, "go-2"), "");
  const results = await Promise.all(both);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true], results.map((r) => r.text).join(" | "));
  assert.match(results.find((r) => !r.ok)!.text, /跑过一次 do-it（做完了）。要再跑一次，加 --again/);
  assert.equal(startedCount(out), 1);
  assert.equal(load(w.root, id).flows.length, 1);
});

test("a request that waited for its input is checked again: the affair was stopped meanwhile", async () => {
  const { w, out } = setup();
  const id = await ticket(w);
  process.env.FAKE_PREPARE_DELAY_MS = "600";
  const pending = ops.flow(w.ctx, id, "do-it");
  await new Promise((r) => setTimeout(r, 200));
  await ops.stop(w.ctx, id);
  const result = await pending;
  assert.equal(result.ok, false, result.text);
  assert.match(result.text, /不盯了，不起流程/);
  assert.equal(startedCount(out), 0);
  assert.equal(load(w.root, id).flows.length, 0);
  assert.equal(existsSync(path.join(w.root, id, "flows")) ? readdirSync(path.join(w.root, id, "flows")).length : 0, 0, "the files made for it are taken away");
});

test("the day's number holds when different affairs ask at once", async () => {
  const { w, out } = setup({ perDay: 1 });
  const ids = [await ticket(w, "700"), await ticket(w, "701")];
  process.env.FAKE_PREPARE_DELAY_MS = "300";
  const results = await Promise.all(ids.map((id) => ops.flow(w.ctx, id, "do-it")));
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true], results.map((r) => r.text).join(" | "));
  assert.match(results.find((r) => !r.ok)!.text, /到一天的上限（1 次）了/);
  assert.equal(startedCount(out), 1);
  assert.equal(ids.reduce((n, id) => n + load(w.root, id).flows.length, 0), 1);
});

test("the word to go ahead is the latest thing he said, and it starts one run", async () => {
  const { w, logDir, out } = setup();
  const id = await ticket(w);
  const chat = chatOf(w, id);
  const go = await heard(w, id, "好，用 do-it 做");
  const hold = await heard(w, id, "先别跑，告诉我现在的情况");
  const old = await ops.flow(chat, id, "do-it", { saidSeq: go });
  assert.equal(old.ok, false);
  assert.match(old.text, new RegExp(`--said-seq ${go} 不是他最近的一句。他后来又说过话（#${hold}）`));
  assert.equal(startedCount(out), 0);

  const ready = await heard(w, id, "现在可以了，开始吧");
  const first = await ops.flow(chat, id, "do-it", { saidSeq: ready });
  assert.equal(first.ok, true, first.text);
  finish(logDir, first.runId);
  // The same sentence cannot start another, --again or not; a new sentence can.
  const reuse = await ops.flow(chat, id, "do-it", { saidSeq: ready, again: true });
  assert.equal(reuse.ok, false);
  assert.match(reuse.text, new RegExp(`他那句话（#${ready}）已经起过一次 do-it 了`));
  const next = await heard(w, id, "再跑一次");
  assert.equal((await ops.flow(chat, id, "do-it", { saidSeq: next, again: true })).ok, true);
  assert.equal(startedCount(out), 2);
});

test("a start the runtime turned away on the spot does not use up his sentence", async () => {
  const { w } = setup();
  const id = await ticket(w);
  const chat = chatOf(w, id);
  const said = await heard(w, id, "用 do-it 做");
  process.env.FAKE_ORCH_REFUSE = "turned away";
  assert.equal((await ops.flow(chat, id, "do-it", { saidSeq: said })).ok, false);
  delete process.env.FAKE_ORCH_REFUSE;
  assert.equal((await ops.flow(chat, id, "do-it", { saidSeq: said })).ok, true, "the same sentence, since nothing ran");
});

/** A run the stand-in did not start: a line in the log, and a claim of the given age in ms (null: none), optionally with events. */
function plant(w: ReturnType<typeof world>, id: string, logDir: string, runId: string, { claim, events = false, refused = "", pid = process.pid }: { claim: number | null; events?: boolean; refused?: string; pid?: number }) {
  mkdirSync(path.join(logDir, "runs"), { recursive: true });
  append(w.root, id, [{ kind: "flow", flow: "do-it", runId, events: eventsFile(logDir, runId), timeoutMs: 30 * HOUR, by: "human" }], { now: w.now() - 6 * 60_000 });
  if (claim !== null) {
    const file = claimFile(logDir, runId);
    writeFileSync(file, JSON.stringify({ pid, hostname: os.hostname(), startedAt: new Date(w.now() - 6 * 60_000).toISOString(), ...(refused ? { refused } : {}) }));
    const at = new Date(Date.now() - claim);
    utimesSync(file, at, at);
  }
  if (events) writeFileSync(eventsFile(logDir, runId), `${JSON.stringify({ v: 1, seq: 0, ts: new Date().toISOString(), runId, kind: "run.start", flow: { name: "do-it", phases: [] } })}\n`);
}

test("whether a run is still going is the runtime's word, not the time passed: a claim kept fresh holds, an abandoned one lets go", async () => {
  const { w, logDir, out } = setup();
  const id = await ticket(w);
  // Started six minutes ago and still loading (a claim kept fresh, no events yet): not over, whatever --again says.
  plant(w, id, logDir, "loading", { claim: 5_000 });
  const held = await ops.flow(w.ctx, id, "do-it", { again: true });
  assert.equal(held.ok, false);
  assert.match(held.text, /^已经在跑：do-it/);
  // The runtime cannot be asked: counted as going, not as gone.
  process.env.FAKE_ORCH_STATUS_BROKEN = "1";
  assert.match((await ops.flow(w.ctx, id, "do-it", { again: true })).text, /^已经在跑/);
  delete process.env.FAKE_ORCH_STATUS_BROKEN;
  assert.equal(startedCount(out), 0);
  // Its claim has gone untouched for ten minutes and its process is gone: nothing is going, and --again may start another.
  plant(w, id, logDir, "abandoned", { claim: 10 * 60_000, pid: 2_147_483_000 });
  const { rmSync } = await import("node:fs");
  rmSync(claimFile(logDir, "loading"));
  writeFileSync(eventsFile(logDir, "loading"), `${JSON.stringify({ v: 1, seq: 0, ts: new Date().toISOString(), runId: "loading", kind: "run.end", outcome: "failed" })}\n`);
  const freed = await ops.flow(w.ctx, id, "do-it", { again: true });
  assert.equal(freed.ok, true, freed.text);
});

test("a run that began and whose claim is no longer kept is lost, and one the runtime refused never began; both let --again start another", async () => {
  const { w, logDir } = setup();
  const id = await ticket(w);
  plant(w, id, logDir, "gone", { claim: 10 * 60_000, events: true });
  const lost = await ops.flow(w.ctx, id, "do-it", { again: true });
  assert.equal(lost.ok, true, lost.text);
  assert.match(lost.text, /跑过一次 do-it（没了下文）/);
  const second = setup();
  const id2 = await ticket(second.w);
  plant(second.w, id2, second.logDir, "turned", { claim: 1_000, refused: "no available provider" });
  const refused = await ops.flow(second.w.ctx, id2, "do-it", { again: true });
  assert.equal(refused.ok, true, refused.text);
  assert.match(refused.text, /跑过一次 do-it（没起来）/);
});

test("just after Paseo starts, the card provider is not ready: said at once, in plain words, before anything is made", async () => {
  const { w, out } = setup();
  const id = await ticket(w);
  for (const status of ["loading", "missing"]) {
    process.env.FAKE_PASEO_GATE = status;
    const result = await ops.flow(w.ctx, id, "do-it");
    assert.equal(result.ok, false);
    assert.equal(result.text, "Paseo 刚启动，过一两分钟再说一次。", status);
  }
  process.env.FAKE_PASEO_GATE = "unavailable";
  assert.match((await ops.flow(w.ctx, id, "do-it")).text, /批准卡用的那个插件现在不能用（unavailable）/);
  assert.equal(startedCount(out), 0);
  assert.equal(load(w.root, id).flows.length, 0);
  assert.equal(existsSync(path.join(w.root, id, "flows")), false, "nothing was made while it was not ready");
  // When the list itself cannot be had the runtime is left to say.
  delete process.env.FAKE_PASEO_GATE;
  process.env.FAKE_PASEO_FAIL = "provider ls";
  const through = await ops.flow(w.ctx, id, "do-it");
  delete process.env.FAKE_PASEO_FAIL;
  assert.equal(through.ok, true, through.text);
});
