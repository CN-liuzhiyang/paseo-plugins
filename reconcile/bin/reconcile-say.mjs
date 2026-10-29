#!/usr/bin/env node
// reconcile-say: hands what a person just said about an item to 事项追踪 (the reconcile plugin).
// It writes one request file into the plugin's data directory and waits for the receipt; the
// plugin checks the words against the conversation it was run from (PASEO_AGENT_ID) and does the
// rest. No dependencies: any session with Node can run it (its arguments are read by
// server/say-args.mjs, the same reading the plugin applies to the command lines it checks).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSayArgs } from "../server/say-args.mjs";

const HELP = `用法：
  reconcile-say say --item <单号> --kind <drop|hold|wrong> --said "<人说的原话>" [选项]
  reconcile-say undo (--id <a_…> | --last) --said "<人说的原话>"
  reconcile-say track --title "<不超过 20 字的短名字>" --said "<人说的原话>" [--domain <work|personal|family>]
  reconcile-say note --item <D 开头的编号> --said "<人说的原话>"
  reconcile-say answer --ask <问题编号> --said -

把人刚在对话里说的一句话交给「事项追踪」。只在人明确这么说了的时候用。原话优先写 --said -（一个减号）：
意思是「原话就是人这一轮发的那条消息」，插件自己去对话里取，你不用转抄，也就不会抄错；人这一轮发的消息不像
一句话（太长、好几行、带代码块）时取不到，这时才把原话照抄进 --said "…"，不要改写。

  say --kind drop    不再追踪这个事项（它要问你的问题都收回）
  say --kind hold    先别问，到 --until <YYYY-MM-DD> 那天起照常问；--person <id> 只对这个人
  say --kind wrong   这个判断错了，记成评测候选；可加 --what "<错在哪>" --expected "<应该是什么>"
  undo               撤掉之前的一条（--id 给出它的 a_… 编号，--last 是这个对话里最新的一条）
                     在聊天软件里，撤掉刚交代、刚补的（10 分钟内）不用确认；更早的会先发确认卡，卡上写明是哪件事
  track              人要你盯一件没有单子的事（"帮我盯一下体检，月底前要约上"）：交给「事项追踪」记下，它自己到点去看、
                     只在要人定的时候找人。--title 是你给它起的短名字（不是人的原话）；--domain 缺省 work，个人的事写 personal
  note               给交代过的事补一句（"约在下周三了"）：--item 是交代时回执里的编号（D12），原话是补的那一句；补完它马上再看一眼
  answer             人在聊天里回了「事项追踪」推给他的一个问题：推送的最后一行是「（问题 D1-1）」这样的编号，人引用推送回复时它跟着回来。
                     --ask 是这个编号，--said 只能是 -（回答是人写的那一段，插件自己取；选项由插件按他写的字对上）。
                     人的回复里没有编号、也没提哪件事，而你不知道是哪个问题，就先问人，不要猜

  --item    单号，比如 #123（或者完整的 gcp-xxx:123）
  --said    人的原话，要和人这一轮说的那条消息一致（不是转述、不是贴进来的别人的话）；写 - 就是「那条消息本身」
  --data    插件的数据目录（缺省 $RECONCILE_DATA_DIR，或者 $PASEO_HOME/plugin-data/reconcile）
  --wait    等回执的秒数（缺省 90，0 是不等）

回执原样告诉人。要在人说这句话的那一轮里跑。不是本人这一轮刚说的（找不到原话、像是贴进来的、这一轮不是人发消息
开始的、在聊天软件的对话里），不会马上生效，会先发一张确认卡给 admin（用了 --said - 取不到原话的，不发卡，回执里
说了怎么办）。answer 不发卡：核对不上就是没记下，让人在 Paseo「事项追踪」里答。在追踪的事项和编号、没答的问题
和它们的编号在数据目录的 status.json、plan.md 里。`;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// The same reading of the arguments the plugin applies to the command lines it checks.
const args = parseSayArgs(process.argv.slice(2));
if ("help" in args) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if ("error" in args) fail(args.usage ? `${args.error}\n\n${HELP}` : args.error);
const waitSeconds = args.wait;
const id = `r_${randomBytes(6).toString("hex")}`;
const request = { v: 1, id, at: new Date().toISOString(), via: process.env.PASEO_AGENT_ID, ...args.request };

// The plugin checks the words against the conversation that ran this; outside one there is none.
if (!request.via) fail("要在 Paseo 的对话里跑（没有 PASEO_AGENT_ID），插件才知道是谁说的");

const home = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
const data = args.data || process.env.RECONCILE_DATA_DIR || path.join(home, "plugin-data", "reconcile");
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
