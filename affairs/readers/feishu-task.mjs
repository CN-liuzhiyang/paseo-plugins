// 飞书任务：标题、有没有勾掉、截止日（只读，用 lark-cli，要 user 身份已登录）
//
// 输入  {"args": {"guid": "<任务 guid>"}}  或  {"args": {"query": "<标题里的词>"}}（在我的未完成任务里找，最多 5 条）
// 输出  {"value": {"summary", "completed", "due", "note"}, "summary": "一句话"}；query 时 value 是这样的数组
// 读不到  退出码 1，stderr 一行原因（没登录、没有这个任务、lark-cli 找不到）
// value 里没有创建 / 更新时间：只放改了才有意义的东西。lark-cli 的位置：环境变量 AFFAIR_LARK_CLI，或 PATH 里的 lark-cli，
// 或 Windows 下 npm 全局装的那个；是 .js / .mjs 文件时用 node 跑它。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const fail = (why) => {
  process.stderr.write(`${why}\n`);
  process.exit(1);
};

const cli = () => {
  if (process.env.AFFAIR_LARK_CLI) return process.env.AFFAIR_LARK_CLI;
  const global = process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe");
  return global && existsSync(global) ? global : "lark-cli";
};

const run = (args) => {
  const bin = cli();
  const script = /\.m?js$/.test(bin);
  const r = spawnSync(script ? process.execPath : bin, [...(script ? [bin] : []), ...args, "--as", "user"], { encoding: "utf8", timeout: 45_000, windowsHide: true });
  if (r.error) fail(`lark-cli 起不来：${r.error.message}`);
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    fail(`lark-cli 的输出不是 JSON：${(r.stdout || r.stderr).trim().slice(0, 100)}`);
  }
  if (out.ok === false) fail(`飞书：${out.error?.message ?? "读不到"}`.slice(0, 200));
  return out.data ?? {};
};

const day = (ms) => (ms ? new Date(Number(ms) + 8 * 3_600_000).toISOString().slice(0, 10) : null);
const short = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);

const { args = {} } = JSON.parse(await new Promise((resolve) => { let t = ""; process.stdin.on("data", (d) => (t += d)); process.stdin.on("end", () => resolve(t || "{}")); }));

if (typeof args.guid === "string" && /^[\w-]{8,64}$/.test(args.guid)) {
  const task = run(["task", "tasks", "get", "--task-guid", args.guid]).task;
  if (!task) fail("没有这个任务");
  const value = { summary: short(task.summary), completed: Boolean(task.completed_at && task.completed_at !== "0"), due: day(task.due?.timestamp), note: short(task.description) };
  process.stdout.write(JSON.stringify({ value, summary: `${value.summary}：${value.completed ? "已勾掉" : "还没勾"}${value.due ? `，截止 ${value.due}` : ""}` }));
} else if (typeof args.query === "string" && args.query.trim()) {
  const items = (run(["task", "+get-my-tasks", "--query", args.query, "--complete=false", "--page-limit", "1"]).items ?? []).slice(0, 5);
  const value = items.map((t) => ({ summary: short(t.summary), completed: Boolean(t.completed), due: t.due_at ? String(t.due_at).slice(0, 10) : null, guid: t.guid }));
  process.stdout.write(JSON.stringify({ value, summary: value.length ? `找到 ${value.length} 个没勾的任务：${value.map((v) => v.summary).join("；").slice(0, 150)}` : `没找到标题里有「${args.query}」的未完成任务` }));
} else fail("要给 guid（一个任务）或 query（标题里的词）");
