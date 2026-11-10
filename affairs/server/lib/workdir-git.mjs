import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { append, listIds, load } from "./log.mjs";
import { primaryLink } from "./links.mjs";
import { modeOf, modeText } from "./mode.mjs";

const exec = promisify(execFile);
const readText = (file) => existsSync(file) ? readFileSync(file, "utf8") : "";
const writeChanged = (file, text) => {
  if (readText(file) === text) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return true;
};
const pendingDir = (ctx) => path.join(ctx.root, ".work-pending");
export const workFolder = (ctx, id) => ctx.policy.workDir ? path.join(ctx.policy.workDir, id) : "";
export const workTexts = (ctx, s) => {
  const dir = workFolder(ctx, s.id);
  return { status: dir ? readText(path.join(dir, "status.md")) : statusText(s, ctx.policy), readme: dir ? readText(path.join(dir, "README.md")) : "" };
};

export function statusText(s, policy = { watchKinds: ["gcp"] }) {
  const head = { id: s.id, title: s.title, state: s.status === "watching" ? "open" : s.status, mode: modeOf(s, policy), links: s.links, projects: s.projects };
  return ["---", ...Object.entries(head).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---",
    `方式：${modeText(s, policy)}`, `现在：${s.nowText || "还没看过"}${s.nowAt ? `（${s.nowAt.slice(5, 16).replace("T", " ")}）` : ""}`,
    `在等：${s.next?.waitingFor || "还没定"}`, "记住的：", ...s.facts.map((f) => `- ${f}`), ...s.notes.slice(-5).map((n) => `- ${n.text}（${n.at.slice(5, 16).replace("T", " ")}）`),
    "没答的问题：", ...s.asks.filter((q) => q.state === "open").map((q) => `- ${q.id} ${q.title}：${q.line}（${q.options.join("、")}）`), ""].join("\n");
}

export function refreshWork(ctx, s) {
  if (!ctx.policy.workDir || s.status !== "watching" || s.system) return;
  const dir = workFolder(ctx, s.id);
  const changed = writeChanged(path.join(dir, "status.md"), statusText(s, ctx.policy));
  const readme = path.join(dir, "README.md");
  const made = !existsSync(readme);
  if (made) writeChanged(readme, `# ${s.title}\n\n## 是什么\n\n${modeOf(s, ctx.policy) === "drive" ? "## 步骤\n\n- [ ] 写步骤和估算 → 他批（谁：他；验收：步骤和额度已批准）\n\n" : ""}## 决定\n\n## 入口\n`);
  const index = refreshIndex(ctx);
  if (changed || made || index) markPending(ctx, s.id);
}

function markPending(ctx, id) {
  mkdirSync(pendingDir(ctx), { recursive: true });
  const file = path.join(pendingDir(ctx), id);
  if (!existsSync(file)) writeFileSync(file, String(ctx.now()));
}

export function refreshIndex(ctx) {
  const states = listIds(ctx.root).map((id) => load(ctx.root, id)).filter((s) => s.status === "watching" && !s.system);
  const cell = (v) => String(v).replaceAll("|", "\\|").replace(/\r?\n/g, " ");
  const area = (s) => ["personal", "family"].includes(s.domain) ? "私事" : ctx.policy.areaByKind?.[primaryLink(s)?.split(":")[0]] || "工具";
  states.sort((a, b) => area(a).localeCompare(area(b)) || a.id.localeCompare(b.id));
  return writeChanged(path.join(ctx.policy.workDir, "INDEX.md"), ["# 在进行的事", "", "| 领域 | 编号 | 标题 | 方式 | 现在 |", "| --- | --- | --- | --- | --- |", ...states.map((s) => `| ${[area(s), s.id, s.title, modeText(s, ctx.policy), s.nowText].map(cell).join(" | ")} |`), ""].join("\n"));
}

export async function gitWork(ctx, args) {
  return (await exec("git", args, { cwd: ctx.policy.workDir, encoding: "utf8", windowsHide: true, timeout: 60_000 })).stdout.trim();
}

async function withGitLock(ctx, fn) {
  const lock = path.join(ctx.root, ".work-git-lock");
  const until = Date.now() + 30_000;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= until) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { rmSync(lock, { recursive: true }); }
}

async function commitPaths(ctx, ids, extra, message, push = true) {
  const root = await gitWork(ctx, ["rev-parse", "--show-toplevel"]);
  const git = (args) => gitWork(ctx, ["-C", root, ...args]);
  // Git expands Windows 8.3 paths; use the same real directory before calculating pathspecs.
  const work = realpathSync.native(ctx.policy.workDir);
  const relative = (file) => path.relative(root, path.resolve(work, path.relative(ctx.policy.workDir, file))).replaceAll("\\", "/");
  const paths = [...ids.map((id) => relative(workFolder(ctx, id))), relative(path.join(ctx.policy.workDir, "INDEX.md")), ...extra.map(relative)];
  // --only is essential: the shared checkout can already contain another session's staged changes.
  await git(["add", "-A", "--", ...paths]);
  const changed = await git(["diff", "HEAD", "--name-only", "--", ...paths]);
  if (changed) await git(["commit", "--only", "-m", message, "--", ...paths]);
  if (!push) return "";
  try {
    try { await gitWork(ctx, ["push"]); }
    catch (error) {
      if (!/rejected|fetch first|non-fast-forward/i.test(error.stderr || error.message)) throw error;
      const branch = await gitWork(ctx, ["branch", "--show-current"]);
      await gitWork(ctx, ["fetch", "origin"]);
      try { await gitWork(ctx, ["rebase", "--autostash", `origin/${branch}`]); }
      catch (rebaseError) {
        await gitWork(ctx, ["rebase", "--abort"]);
        throw rebaseError;
      }
      await gitWork(ctx, ["push"]);
    }
    for (const id of ids) append(ctx.root, id, [{ kind: "work.synced" }], { now: ctx.now(), tz: ctx.policy.tz });
    return "";
  } catch (error) {
    const detail = `文件已提交在本地，没推上去：${String(error.stderr || error.message).trim()}`;
    for (const id of ids) append(ctx.root, id, [{ kind: "flag", what: "work-git", detail }], { now: ctx.now(), tz: ctx.policy.tz });
    return detail;
  }
}

export async function saveWork(ctx, id, message = "") {
  if (!ctx.policy.workDir) return { ok: true, text: "没有配置 workDir。" };
  return withGitLock(ctx, async () => {
    const warning = await commitPaths(ctx, [id], [], message || `保存事项 ${id} 的进展和决定`);
    rmSync(path.join(pendingDir(ctx), id), { force: true });
    const sizes = sizeWarnings(ctx, load(ctx.root, id));
    return { ok: !warning, text: [warning || "已保存并推送。", ...sizes].join("\n") };
  });
}

export async function flushWork(ctx) {
  if (!ctx.policy.workDir || !existsSync(pendingDir(ctx))) return;
  const ids = readdirSync(pendingDir(ctx));
  if (!ids.length || !ids.some((id) => ctx.now() - Number(readText(path.join(pendingDir(ctx), id))) >= 600_000)) return;
  await withGitLock(ctx, async () => {
    await commitPaths(ctx, ids, [], `保存 ${ids.join("、")} 的进展`);
    for (const id of ids) rmSync(path.join(pendingDir(ctx), id), { force: true });
  });
}

export async function finishWork(ctx, s) {
  if (!ctx.policy.workDir || !existsSync(workFolder(ctx, s.id))) return;
  await withGitLock(ctx, async () => {
    // Keep the latest README recoverable, including edits made just before finishing.
    await commitPaths(ctx, [s.id], [], `保存 ${s.id} 办完前的决定`, false);
    const hash = await gitWork(ctx, ["rev-parse", "HEAD"]);
    rmSync(workFolder(ctx, s.id), { recursive: true });
    const month = new Date(ctx.now()).toLocaleDateString("sv-SE", { timeZone: ctx.policy.tz }).slice(0, 7);
    const file = path.join(ctx.policy.workDir, "done", `${month}.md`);
    const day = new Date(ctx.now()).toLocaleDateString("sv-SE", { timeZone: ctx.policy.tz }).slice(5);
    writeChanged(file, `${readText(file)}- ${s.id} ${s.title} [${s.links.join(", ")}] ${day} 办完：${s.nowText || s.doneEvidence}（del ${hash}）\n`);
    refreshIndex(ctx);
    await commitPaths(ctx, [s.id], [file], `办完 ${s.id} ${s.title} ${s.links.join(", ")}`);
    rmSync(path.join(pendingDir(ctx), s.id), { force: true });
  });
}

export async function restoreWork(ctx, s) {
  if (!ctx.policy.workDir) return;
  const done = path.join(ctx.policy.workDir, "done");
  if (!existsSync(done)) return;
  for (const name of readdirSync(done)) {
    const file = path.join(done, name);
    const lines = readText(file).split("\n");
    const line = lines.find((l) => l.startsWith(`- ${s.id} `));
    const hash = line && /（del ([a-f0-9]+)）$/.exec(line)?.[1];
    if (!hash) continue;
    await withGitLock(ctx, async () => {
      const root = await gitWork(ctx, ["rev-parse", "--show-toplevel"]);
      await gitWork(ctx, ["-C", root, "restore", `--source=${hash}`, "--worktree", "--", path.relative(root, path.join(realpathSync.native(ctx.policy.workDir), s.id)).replaceAll("\\", "/")]);
      writeChanged(file, lines.filter((l) => l !== line).join("\n"));
      refreshWork(ctx, s);
      await commitPaths(ctx, [s.id], [file], `重新盯 ${s.id}，取回此前的决定`);
    });
    break;
  }
}

export function sizeWarnings(ctx, s, handbooks = "") {
  const { status, readme } = workTexts(ctx, s);
  return [["README", readme, 4], ["status", status, 2], ["对话手册", handbooks, 5]].flatMap(([name, text, limit]) => {
    const kb = Buffer.byteLength(text) / 1024;
    return kb > limit ? [`${name} 超了 ${(kb - limit).toFixed(1)} KB，把细节挪到同文件夹别的文件。`] : [];
  });
}
