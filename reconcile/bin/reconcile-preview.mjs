#!/usr/bin/env node
// reconcile-preview: shows what a change to 事项追踪's rules, policy.json or persons.json would do
// before it is in force, and copies it in once a person agreed (server/preview.ts does the work).
// The controller loads its rules directory again as soon as a file in it changes, so a change is
// made in a copy outside it: copy, change, diff, show, apply. Reads the controller's data without
// taking it; writes only on apply, into the config directory. Runs the plugin's TypeScript through
// tsx (the plugin's dev dependency: npm install in the plugin directory).

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HELP = `用法：
  reconcile-preview copy --to <目录>
      把在用的判断方法和配置（rules/、policy.json、persons.json、calendar/）复制一份出来，在那里改
  reconcile-preview diff --candidate <目录>
      预览候选和在用的差异：现在，和往后几个工作日（不改任何在用的东西）
  reconcile-preview apply --candidate <目录> --expect <编号>
      把候选读一份再预览一次，差异还是 diff 给的那个编号、预览期间候选和在用的都没变，
      才把这份里改了的文件拷回在用的配置目录（要么全拷上，要么一个不动）

  reconcile-preview cases backfill [--to <目录>]
      从日志补录一批存档（拿在用的判断方法，在日志里每个值得留的时刻重判一遍）；缺省放进 <配置目录>/cases/backfill

选项：
  --config  在用的配置目录（缺省读插件设置里的 configDir）
  --data    插件的数据目录（缺省读插件设置里的 dataDir，或 $PASEO_HOME/plugin-data/reconcile）
  --days    往后推演几个工作日，0 到 30（缺省 7；apply 至少 7，要和 diff 用的一样）
  --now     从哪个时刻算起（ISO 时间，缺省现在）
  --to      copy 复制到哪、cases backfill 存档写到哪
  --json    输出 JSON（给 agent 读）`;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
const KNOWN = {
  copy: ["to", "config"],
  diff: ["candidate", "config", "data", "days", "now", "json"],
  apply: ["candidate", "expect", "config", "data", "days", "now", "json"],
  "cases backfill": ["to", "config", "data", "json"],
};
// `cases` has a subcommand of its own.
const sub = cmd === "cases" ? `cases ${args[0] ?? ""}`.trim() : cmd;
const rest = cmd === "cases" ? args.slice(1) : args;
if (!KNOWN[sub]) fail(`没有 ${sub} 这个子命令\n\n${HELP}`);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (!arg.startsWith("--")) fail(`看不懂的参数：${arg}\n\n${HELP}`);
  const name = arg.slice(2);
  if (!KNOWN[sub].includes(name)) fail(`${sub} 不认识 --${name}`);
  if (name === "json") {
    flags.json = true;
    continue;
  }
  const value = rest[++i];
  if (value === undefined) fail(`--${name} 后面要有值`);
  flags[name] = value;
}

// The plugin's settings, for where its config and data are.
const home = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
const settingsFile = path.join(home, "plugin-settings", "reconcile", "reconcile.json");
// Read only for what was not given: with --config (and --data, but for copy) it is not needed.
let settings = {};
if (!flags.config || (cmd !== "copy" && !flags.data)) {
  try {
    settings = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")).values ?? {}) : {};
  } catch (error) {
    fail(`插件设置读不懂（${settingsFile}）：${error.message}；用 --config、--data 直接给出目录`);
  }
}
const configDir = flags.config || settings.configDir;
if (!configDir) fail(`不知道在用的配置目录：用 --config 给出（${settingsFile} 里也没有 configDir）`);
const dataDir = flags.data || settings.dataDir || path.join(home, "plugin-data", "reconcile");

// What `node --import tsx` does: TypeScript for the modules imported after it.
await import("tsx");
// The plugin is not a module package: its TypeScript loads as CommonJS, its exports on default.
const load = async (file) => {
  const m = await import(file);
  return m.default ?? m;
};
const { applyCandidate, copyConfig, preview, previewText, PreviewError } = await load("../server/preview.ts");
const { ConfigError } = await load("../server/config.ts");
const { backfill, BackfillError } = await load("../server/backfill.ts");

try {
  if (cmd === "copy") {
    if (!flags.to) fail("要用 --to 给出复制到哪个目录（在配置目录外面）");
    const files = copyConfig(configDir, flags.to);
    process.stdout.write(`复制了 ${files.length} 个文件到 ${flags.to}：${files.join("、")}\n在那里改，然后 reconcile-preview diff --candidate ${flags.to}\n`);
    process.exit(0);
  }
  if (sub === "cases backfill") {
    const to = flags.to || path.join(configDir, "cases", "backfill");
    const result = await backfill({ configDir, dataDir, to });
    if (flags.json) {
      const made = result.made.map((m) => ({ file: m.file, id: m.capsule.id, case: m.capsule.case, at: m.capsule.at, trigger: m.capsule.trigger }));
      process.stdout.write(`${JSON.stringify({ to, points: result.points, made, skipped: result.skipped }, null, 2)}\n`);
      process.exit(0);
    }
    const lines = [`日志里值得留的时刻 ${result.points} 个，补录了 ${result.made.length} 份存档到 ${to}（用的是在用的判断方法，不是当时那一版；配置是现在的）：`];
    for (const m of result.made) lines.push(`- ${m.capsule.case} ${m.capsule.at.slice(0, 16).replace("T", " ")} ${m.capsule.trigger.join("+")}  ${path.relative(to, m.file)}`);
    for (const s of result.skipped) lines.push(`- 没补：${s.caseId} ${s.at.slice(0, 16).replace("T", " ")} ${s.why.join("+")}（在用的判断方法这一刻不判断它：冷的、不再追踪的，或没有判断方法管它）`);
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exit(0);
  }
  if (!flags.candidate) fail("要用 --candidate 给出候选目录");
  const workdays = flags.days === undefined ? 7 : Number(flags.days);
  if (!Number.isInteger(workdays) || workdays < 0 || workdays > 30) fail("--days 要是 0 到 30 的整数");
  const nowMs = flags.now === undefined ? Date.now() : Date.parse(flags.now);
  if (!Number.isFinite(nowMs)) fail("--now 要是 ISO 时间，比如 2026-10-26T10:00:00+08:00");
  const options = { configDir, candidateDir: flags.candidate, dataDir, nowMs, workdays };
  if (cmd === "diff") {
    const p = await preview(options);
    // Everything that went into the id, so that the line copied gives the same one.
    const where = ["config", "data", "days", "now"].filter((f) => flags[f] !== undefined).map((f) => `--${f} ${flags[f]} `).join("");
    process.stdout.write(flags.json ? `${JSON.stringify(p, null, 2)}\n` : `${previewText(p)}\n要拷回去：reconcile-preview apply ${where}--candidate ${flags.candidate} --expect ${p.id}\n`);
    process.exit(0);
  }
  if (!flags.expect) fail("要用 --expect 给出 diff 给的编号（p_…）");
  const { applied, preview: p } = await applyCandidate({ ...options, expect: flags.expect });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ applied, same: p.id === flags.expect, preview: p }, null, 2)}\n`);
    process.exit(p.id === flags.expect ? 0 : 1);
  }
  if (p.id !== flags.expect) {
    process.stdout.write(
      `差异变了（现在是 ${p.id}，不是 ${flags.expect}），没拷。可能是：数据、在用的配置或者候选变了；--days、--now 和 diff 时不一样；中间过了一个要问、追问的时刻，或者过了一天。新的预览：\n\n${previewText(p)}`,
    );
    process.exit(1);
  }
  if (applied.length === 0) {
    process.stdout.write("候选和在用的一样，没有要拷的。\n");
    process.exit(0);
  }
  const later = applied.some((f) => !f.startsWith("rules/")) ? "policy.json、persons.json、calendar/ 要在 Paseo 里 reload 这个插件才生效；" : "";
  process.stdout.write(`已拷到 ${configDir}：${applied.join("、")}。\n${applied.some((f) => f.startsWith("rules/")) ? "判断方法 daemon 下一次检查就用上（一下子改动太多会先停着，等页面上放行）；" : ""}${later}配置目录在 git 里的话，记得提交。\n`);
} catch (error) {
  if (error instanceof PreviewError || error instanceof ConfigError || error instanceof BackfillError) fail(error.message);
  throw error;
}
