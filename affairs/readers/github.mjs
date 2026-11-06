// GitHub issue 或 PR：标题、开着还是关了（PR 是否合并、评审结论）、评论数和最后一条评论（只读，用 gh，要已登录）
//
// 输入  {"args": {"ref": "owner/repo#123"}}（和事项关联 github:owner/repo#123 的写法一样）
// 输出  {"value": {"kind", "title", "state", "merged", "review", "comments", "last"}, "summary": "一句话"}
// 读不到  退出码 1，stderr 一行原因（gh 找不到、没登录、没有这个编号）
// value 里不放更新时间：只放改了才有意义的东西；最后一条评论只留作者和前 120 个字。gh 的位置：环境变量 AFFAIR_GH，或 PATH 里的 gh。
import { spawnSync } from "node:child_process";

const fail = (why) => {
  process.stderr.write(`${why}\n`);
  process.exit(1);
};

const api = (route) => {
  const r = spawnSync(process.env.AFFAIR_GH || "gh", ["api", route], { encoding: "utf8", timeout: 45_000, windowsHide: true });
  if (r.error) fail(`gh 起不来：${r.error.message}`);
  if (r.status !== 0) fail(`GitHub：${(r.stderr || r.stdout).trim().split(/\r?\n/).at(-1)}`.slice(0, 200));
  try {
    return JSON.parse(r.stdout);
  } catch {
    fail(`gh 的输出不是 JSON：${r.stdout.trim().slice(0, 100)}`);
  }
};

const short = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
const { args = {} } = JSON.parse(await new Promise((resolve) => { let t = ""; process.stdin.on("data", (d) => (t += d)); process.stdin.on("end", () => resolve(t || "{}")); }));
const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(String(args.ref ?? "").trim());
if (!m) fail("要给 ref，写成 owner/repo#编号");
const [, owner, repo, number] = m;
const base = `repos/${owner}/${repo}`;

const issue = api(`${base}/issues/${number}`);
const pr = issue.pull_request ? api(`${base}/pulls/${number}`) : null;
// The review verdict is the latest non-comment review of each reviewer; any "changes requested" wins over approvals.
let review = null;
if (pr) {
  const latest = new Map();
  for (const r of api(`${base}/pulls/${number}/reviews?per_page=100`)) if (r.state !== "COMMENTED") latest.set(r.user?.login, r.state);
  const states = [...latest.values()];
  review = states.includes("CHANGES_REQUESTED") ? "要改" : states.includes("APPROVED") ? "批准" : null;
}
const lastComment = issue.comments ? api(`${base}/issues/${number}/comments?per_page=100`).at(-1) : null;
const value = {
  kind: pr ? "pr" : "issue",
  title: short(issue.title),
  state: issue.state === "open" ? "开着" : "关了",
  merged: pr ? Boolean(pr.merged) : null,
  review,
  comments: issue.comments ?? 0,
  last: lastComment ? `${lastComment.user?.login ?? "?"}：${short(lastComment.body)}` : null,
};
const status = pr ? (value.merged ? "已合并" : value.state === "开着" ? `开着${pr.draft ? "（草稿）" : ""}` : "关了没合") : value.state;
process.stdout.write(JSON.stringify({ value, summary: `${value.kind === "pr" ? "PR" : "issue"} ${status}${review ? `，评审${review}` : ""}，${value.comments} 条评论` }));
