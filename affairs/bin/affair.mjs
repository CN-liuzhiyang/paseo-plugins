#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { makeCtx } from "../server/lib/ops.mjs";
import * as ops from "../server/lib/ops.mjs";
import { doctor } from "../server/lib/doctor.mjs";
import { defaultRoot, loadPolicy } from "../server/lib/policy.mjs";

// The command for agents and for tracing a fault; a person never types it. Exit 0: done. 1: refused or sent back, the
// reason on stdout (what to fix, in words). 2: used wrongly.

const USAGE = `affair <命令> ...
  new --title T [--goal G] [--said S] [--link kind:ref] [--domain personal|family] [--deadline "YYYY-MM-DD HH:mm"] [--no-wait]
  find <词>                    note <编号|名字> --said S [--deadline T]    answer <问题编号> --said S（对话的会话用 --said-seq N）
  （对话的会话）note <编号> --mine --said S [--said-seq N]   report <编号> --from chat --file F.json   brief <编号> --chat   history <编号> [--q 词] [--pick N] [--max 字数]
  flow <编号> [<流程>] [--said-seq N] [--again]   起一个流程（不写流程名：列出这件事能起哪些）
  stop <编号|名字>             pause <编号|名字> --until "YYYY-MM-DD HH:mm" [--said-seq N]  resume <编号|名字>   undo <编号|名字>
  show <编号|名字> [--log]     ls    stats    doctor（逐项自检）
  pause-all（回退用：停掉全部计划并记下）   resume-all（放开）
  brief <编号>                 report <编号> --file F.json | --stdin
  read <工具> [--args '<json>' | --args -] [--for <编号>]   现读一次；加 --for 会登记，打印的 reader:r编号 能当证据
全局：--root <事项根目录>  --paseo-home <daemon 的 home>  --policy <policy.json 的路径，不写就用根目录里那份>  --json`;

function parse(argv) {
  const flags = {};
  const rest = [];
  const bool = new Set(["log", "json", "stdin", "no-wait", "force", "mine", "chat", "again"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      flags[key] = bool.has(key) ? true : argv[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

const readStdin = () => readFileSync(0, "utf8");

async function main() {
  const { flags, rest } = parse(process.argv.slice(2));
  const [cmd, arg] = rest;
  const root = flags.root ?? defaultRoot();
  const ctx = makeCtx({ root: flags.root, paseoHome: flags["paseo-home"], policy: loadPolicy(root, flags.policy) });
  // Whose command this is comes from the session it runs in, never from what the caller says.
  Object.assign(ctx, await ops.callerInfo(ctx));
  const need = (value, what) => {
    if (!value) throw Object.assign(new Error(`缺 ${what}\n${USAGE}`), { usage: true });
    return value;
  };
  // --said - : the words are on stdin, so Chinese never passes through a shell's quoting.
  const said = () => (flags.said === "-" ? readStdin().trim() : need(flags.said, "--said"));
  const saidIfAny = () => (flags.said === "-" ? readStdin().trim() : flags.said ?? "");
  let result;
  switch (cmd) {
    case "new":
      result = await ops.create(ctx, { title: need(flags.title, "--title"), goal: flags.goal, said: flags.said === "-" ? readStdin().trim() : flags.said, link: flags.link, domain: flags.domain, deadline: flags.deadline, role: flags.role, noWait: flags["no-wait"] });
      break;
    case "find": {
      const { hits, names } = ops.find(ctx, need(arg, "要找的词"));
      result = { ok: hits.length > 0, text: hits.length ? hits.map((s) => `${s.id}\t${s.title}`).join("\n") : `没找到「${arg}」。在盯的有：${names.join("、") || "（没有）"}` };
      break;
    }
    case "note":
      result = await ops.note(ctx, need(arg, "编号"), { said: said(), deadline: flags.deadline, via: flags.via, mine: flags.mine, saidSeq: flags["said-seq"] });
      break;
    case "answer":
      result = await ops.answer(ctx, need(arg, "问题编号").replace(/-\d+$/, ""), arg, saidIfAny(), flags.via, { saidSeq: flags["said-seq"] ?? "" });
      break;
    case "stop":
      result = await ops.stop(ctx, ops.resolve(ctx, need(arg, "编号")).s?.id ?? need(null, "存在的编号"), { evidence: saidIfAny() });
      break;
    case "pause":
      result = await ops.pause(ctx, need(arg, "编号"), need(flags.until, "--until"), saidIfAny(), { saidSeq: flags["said-seq"] ?? "" });
      break;
    case "resume":
      result = await ops.resume(ctx, need(arg, "编号"));
      break;
    case "undo":
      result = ops.undo(ctx, need(arg, "编号"));
      break;
    case "flow":
      result = await ops.flow(ctx, need(arg, "编号"), rest[2] ?? "", { saidSeq: flags["said-seq"] ?? "", again: flags.again === true });
      break;
    case "show":
      result = ops.show(ctx, need(arg, "编号"), { log: flags.log });
      break;
    case "ls":
      result = ops.ls(ctx);
      break;
    case "stats":
      result = ops.stats(ctx);
      break;
    case "doctor":
      result = await doctor(ctx);
      break;
    case "pause-all":
      result = await ops.pauseAll(ctx);
      break;
    case "resume-all":
      result = await ops.resumeAll(ctx);
      break;
    case "brief":
      result = await ops.brief(ctx, need(arg, "编号"), { chat: flags.chat });
      break;
    case "report": {
      let data;
      try {
        data = JSON.parse(flags.stdin ? readStdin() : readFileSync(need(flags.file, "--file"), "utf8"));
      } catch (error) {
        throw Object.assign(new Error(`交回的不是 JSON：${error.message}`), { usage: true });
      }
      result = await ops.report(ctx, need(arg, "编号"), data, { from: flags.from });
      break;
    }
    case "history":
      result = await ops.history(ctx, need(arg, "编号"), { q: flags.q, pick: flags.pick, max: flags.max });
      break;
    case "read": {
      let args = {};
      try {
        if (flags.args) args = JSON.parse(flags.args === "-" ? readStdin() : flags.args);
      } catch (error) {
        throw Object.assign(new Error(`--args 要写成 JSON：${error.message}`), { usage: true });
      }
      result = await ops.readTool(ctx, need(arg, "读取工具的名字"), args, { forId: flags.for });
      break;
    }
    default:
      throw Object.assign(new Error(USAGE), { usage: true });
  }
  process.stdout.write(`${flags.json ? JSON.stringify(result) : result.text}\n`);
  process.exitCode = result.ok ? 0 : result.code ?? 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.usage ? 2 : 1;
});
