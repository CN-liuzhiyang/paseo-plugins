import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listIds, load } from "./log.mjs";
import { json, whyOf } from "./paseo.mjs";
import { policyProblems } from "./policy.mjs";
import { listReaders } from "./readers.mjs";
import { chatHandbooks } from "./chat.mjs";
import { sizeWarnings } from "./workdir-git.mjs";
import { read } from "./log.mjs";

// `affair doctor`: everything the plugin and the commands need from the machine, one line each, ✓ or ✗ with what to do.
// Nothing here changes anything.

const HERE = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return "";
  }
})();

/** Whether `name --version` runs from this PATH (a Windows .cmd shim needs a shell to run). */
function runs(name, args = ["--version"]) {
  const r = spawnSync(name, args, { encoding: "utf8", timeout: 15_000, shell: process.platform === "win32" && name !== "node" });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || r.stderr).trim().split("\n")[0].slice(0, 60);
}

/** @returns {Promise<{ ok: boolean, items: Array<{ ok: boolean, label: string, detail: string }>, text: string }>} */
export async function doctor(ctx) {
  const policy = ctx.policy;
  const items = [];
  const add = (ok, label, detail) => items.push({ ok, label, detail });
  add(true, "实际 policy", policy.sourcePath || "默认配置");
  for (const id of listIds(ctx.root)) {
    const s = load(ctx.root, id);
    for (const warning of sizeWarnings(ctx, s, chatHandbooks(ctx, s))) add(false, id, warning);
    const lines = read(ctx.root, id);
    const synced = lines.filter((l) => l.kind === "work.synced").at(-1)?.seq || 0;
    for (const flag of s.flags.filter((f) => f.what === "work-git" && f.seq > synced)) add(false, `${id} 文档推送`, flag.detail);
  }

  const problems = policyProblems(policy);
  if (problems.length === 0) add(true, "policy.json", "必填的都有，路径都在");
  for (const p of problems) add(false, `policy.json：${p.key}`, p.text);

  const node = runs("node");
  add(Boolean(node), "node 在 PATH 上", node ?? "找不到 node：插件进程和看一眼的会话都要用它跑 affair 命令");
  const python = runs("python") ?? runs("python3");
  add(Boolean(python), "python 在 PATH 上", python ?? "找不到 python：release、crash-watch 两个读取工具要用");
  const lark = runs("lark-cli");
  add(Boolean(lark), "lark-cli 在 PATH 上", lark ?? "找不到 lark-cli：feishu-task 读取工具和飞书任务要用");

  const dirs = [...(policy.readers.dirs ?? []), policy.readers.publicDir || (HERE ? path.join(HERE, "..", "..", "readers") : "")].filter(Boolean);
  const missing = dirs.filter((d) => !existsSync(d));
  const found = listReaders(policy);
  add(missing.length === 0 && found.length > 0, "读取工具目录", missing.length ? `这些目录找不到：${missing.join("、")}` : `${dirs.length} 个目录，找到 ${found.length} 个工具：${found.map((t) => t.name).join("、")}`);

  const books = [policy.handbookPath || (HERE ? path.join(HERE, "..", "..", "handbook.md") : "")];
  if (policy.handbooksDir) books.push(path.join(policy.handbooksDir, "affair.md"), path.join(policy.handbooksDir, "asked.md"), ...Object.values(policy.handbookByKind ?? {}).map((f) => path.join(policy.handbooksDir, f)));
  const noBook = books.filter((b) => !b || !existsSync(b));
  add(noBook.length === 0, "手册", noBook.length ? `找不到：${noBook.join("、")}` : `${books.length} 份手册都在`);

  try {
    const projects = await json(ctx.run, ["project", "ls"]);
    add(true, "paseo 连得上", `${Array.isArray(projects) ? projects.length : "?"} 个项目`);
  } catch (error) {
    add(false, "paseo 连得上", `连不上：${String(error.message).slice(0, 120)}（daemon 起着吗？--paseo-home 对吗？）`);
  }

  try {
    const result = await ctx.run(["workspace", "--help"]);
    if (result.exitCode !== 0) throw new Error(whyOf(result.stderr, result.stdout));
    // Older CLIs return success and the parent help even for `workspace label --help`.
    const commands = result.stdout.split(/^Commands:[ \t]*\r?$/m)[1] ?? "";
    const supported = /^[ \t]+label(?:[ \t]|$)/m.test(commands);
    add(supported, "工作区标签", supported ? "workspace label 可用" : "要新版 Paseo（workspace label）");
  } catch (error) {
    add(false, "工作区标签", `检查失败：${String(error.message).slice(0, 120)}`);
  }

  if (!policy.push?.to) add(false, "推送", "push.to 没写：推送发给谁不知道，一条也发不出");
  else {
    try {
      const channels = await json(ctx.run, ["schedule", "channels"]);
      const list = Array.isArray(channels) ? channels : [];
      const mine = list.find((c) => c?.channel === "popo" && c?.to === policy.push.to);
      add(Boolean(mine), "推送", mine ? `发给 ${policy.push.to}（${mine.destination ?? "popo"}），渠道在` : `popo 渠道里没有 ${policy.push.to}（现有：${list.map((c) => `${c.channel}:${c.to}`).join("、") || "没有渠道"}）`);
    } catch (error) {
      add(false, "推送", `看不到推送渠道：${String(error.message).slice(0, 100)}`);
    }
  }

  const broken = [];
  for (const id of listIds(ctx.root)) if (load(ctx.root, id).chainBroken) broken.push(id);
  add(broken.length === 0, "事项记录没被手动改过", broken.length ? `这些事项的记录对不上（有人绕过命令写过）：${broken.join("、")}` : `${listIds(ctx.root).length} 件事项的记录都连得上`);

  const ok = items.every((i) => i.ok);
  const text = [...items.map((i) => `${i.ok ? "✓" : "✗"} ${i.label}：${i.detail}`), "", ok ? "全绿。" : `有 ${items.filter((i) => !i.ok).length} 项要处理。`].join("\n");
  return { ok, items, text };
}
