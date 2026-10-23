#!/usr/bin/env node
// reconcile-say: hands what a person just said about an item to 事项追踪 (the reconcile plugin).
// It writes one request file into the plugin's data directory and waits for the receipt; the
// plugin checks the words against the conversation it was run from (PASEO_AGENT_ID) and does the
// rest. No dependencies: any session with Node can run it.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HELP = `用法：
  reconcile-say say --item <单号> --kind <drop|hold|wrong> --said "<人说的原话>" [选项]
  reconcile-say undo (--id <a_…> | --last) --said "<人说的原话>"

把人刚在对话里说的一句话交给「事项追踪」。只在人明确这么说了的时候用，原话照抄，不要改写。

  say --kind drop    不再追踪这个事项（它要问你的问题都收回）
  say --kind hold    先别问，到 --until <YYYY-MM-DD> 那天起照常问；--person <id> 只对这个人
  say --kind wrong   这个判断错了，记成评测候选；可加 --what "<错在哪>" --expected "<应该是什么>"
  undo               撤掉之前的一条（--id 给出它的 a_… 编号，--last 是这个对话里最新的一条）

  --item    单号，比如 #123（或者完整的 gcp-xxx:123）
  --said    人的原话，要和人这一轮说的那条消息一致（不是转述、不是贴进来的别人的话）
  --data    插件的数据目录（缺省 $RECONCILE_DATA_DIR，或者 $PASEO_HOME/plugin-data/reconcile）
  --wait    等回执的秒数（缺省 90，0 是不等）

回执原样告诉人。要在人说这句话的那一轮里跑。不是本人这一轮刚说的（找不到原话、像是贴进来的、这一轮不是人发消息
开始的、在聊天软件的对话里），不会马上生效，会先发一张确认卡给 admin。在追踪的事项和编号在数据目录的
status.json、plan.md 里。`;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parse(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) fail(`看不懂的参数：${arg}\n\n${HELP}`);
    const name = arg.slice(2);
    if (name === "last" || name === "help") {
      flags[name] = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined) fail(`--${name} 后面要有值`);
    flags[name] = value;
  }
  return { cmd, flags };
}

const { cmd, flags } = parse(process.argv.slice(2));
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if (cmd !== "say" && cmd !== "undo") fail(`没有 ${cmd} 这个子命令\n\n${HELP}`);
if (!flags.said) fail("要用 --said 给出人的原话");

const known = cmd === "say" ? ["item", "kind", "said", "until", "person", "what", "expected", "data", "wait"] : ["id", "last", "said", "data", "wait"];
for (const name of Object.keys(flags)) if (!known.includes(name)) fail(`${cmd} 不认识 --${name}`);
const waitSeconds = flags.wait === undefined ? 90 : Number(flags.wait);
if (!Number.isFinite(waitSeconds) || waitSeconds < 0) fail("--wait 要是秒数");

const id = `r_${randomBytes(6).toString("hex")}`;
const base = { v: 1, id, at: new Date().toISOString(), via: process.env.PASEO_AGENT_ID, said: flags.said };
let request;
if (cmd === "say") {
  if (!flags.item) fail("要用 --item 给出单号");
  if (!["drop", "hold", "wrong"].includes(flags.kind)) fail("--kind 只能是 drop、hold、wrong");
  if (flags.kind === "hold" && !/^\d{4}-\d{2}-\d{2}$/.test(flags.until ?? "")) fail("hold 要用 --until YYYY-MM-DD 说到哪天");
  request = { ...base, cmd, kind: flags.kind, item: flags.item };
  for (const name of ["until", "person", "what", "expected"]) if (flags[name] !== undefined) request[name] = flags[name];
} else {
  if (!flags.id === !flags.last) fail("undo 要 --id <a_…> 或者 --last，二选一");
  if (flags.id && !/^a_[0-9a-f]{12}$/.test(flags.id)) fail(`${flags.id} 不是一条的编号（像 a_0123456789ab）`);
  request = { ...base, cmd, target: flags.id ?? "last" };
}

// The plugin checks the words against the conversation that ran this; outside one there is none.
if (!request.via) fail("要在 Paseo 的对话里跑（没有 PASEO_AGENT_ID），插件才知道是谁说的");

const home = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
const data = flags.data || process.env.RECONCILE_DATA_DIR || path.join(home, "plugin-data", "reconcile");
if (!existsSync(data)) fail(`数据目录不存在：${data}（用 --data 指定）`);
const dir = path.join(data, "requests");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${id}.json`);
writeFileSync(`${file}.tmp`, JSON.stringify(request, null, 2));
renameSync(`${file}.tmp`, file);

if (waitSeconds === 0) {
  process.stdout.write(`已交给「事项追踪」（${id}），没等回执；回执会写到 ${path.join(dir, "done", `${id}.json`)}。\n`);
  process.exit(0);
}
const receiptFile = path.join(dir, "done", `${id}.json`);
const deadline = Date.now() + waitSeconds * 1000;
for (;;) {
  if (existsSync(receiptFile)) {
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    process.stdout.write(`${receipt.text}\n`);
    process.exit(receipt.outcome === "rejected" ? 1 : 0);
  }
  if (Date.now() >= deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
process.stdout.write(`已交给「事项追踪」（${id}），还没等到回执：插件可能没在运行，或者正在做上一轮检查。结果会出现在「事项追踪」页面和 ${path.join(data, "plan.md")} 里。\n`);
