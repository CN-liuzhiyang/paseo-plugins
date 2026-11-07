import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { append } from "./log.mjs";
import { callerInfo, resolve } from "./ops.mjs";
import { localPathOf } from "./projects.mjs";
import { samePath } from "./workspace.mjs";

const exec = promisify(execFile);
const git = async (cwd, args) => (await exec("git", args, { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim();

async function defaultBranch(cwd) {
  const refs = (await git(cwd, ["for-each-ref", "--format=%(refname) %(symref)", "refs/heads", "refs/remotes/origin/HEAD"])).split("\n");
  const remote = refs.find((r) => r.startsWith("refs/remotes/origin/HEAD "))?.split(" ")[1];
  if (remote) return remote;
  for (const name of ["main", "master"]) if (refs.some((r) => r.trim() === `refs/heads/${name}`)) return `refs/heads/${name}`;
  throw new Error("默认分支不明确，先确认远端 HEAD");
}

function dependencies(cwd) {
  return ["node_modules", ...readdirSync(cwd, { withFileTypes: true }).filter((d) => d.isDirectory() && ![".git", "node_modules"].includes(d.name)).map((d) => path.join(d.name, "node_modules"))].filter((p) => existsSync(path.join(cwd, p)));
}

export async function env(ctx, ref, { remove = false } = {}) {
  const r = resolve(ctx, ref);
  if (!r.s) return { ok: false, text: r.text };
  const s = r.s;
  const caller = await callerInfo(ctx);
  if (caller.by === "look" || caller.by === "attached" || (caller.by === "chat" && (caller.chatFor !== s.id || process.env.PASEO_AGENT_ID !== s.chatId))) return { ok: false, text: "只有本人或这件事当前的主对话能搭建或拆掉环境。" };
  const results = [];
  for (const project of s.projects) {
    if (project.startsWith("svn:")) { results.push("svn 用哪个副本要问他。"); continue; }
    if (!project.startsWith("remote:") && !project.startsWith("path:")) continue;
    try {
      const local = await localPathOf(project, ctx.policy);
      if (!local) throw new Error(`这台机器上没检出 ${project}`);
      const checkouts = await git(local, ["worktree", "list", "--porcelain"]);
      const main = /^worktree (.+)$/m.exec(checkouts)?.[1];
      if (!main) throw new Error("找不到 git 主检出");
      const target = path.join(path.dirname(main), `${path.basename(main)}-affair-${s.id}`);
      const branch = `affair/${s.id}`;
      const trees = checkouts.split(/\r?\n\r?\n/);
      const tree = trees.find((t) => samePath(/^worktree (.+)$/m.exec(t)?.[1] || main, target));
      const saved = s.envs.find((e) => e.project === project);
      if (remove) {
        if (!tree) { results.push(`${project}：环境已不在。`); continue; }
        if (!saved || !samePath(saved.path, target) || !tree.includes(`branch refs/heads/${branch}`)) throw new Error("这个工作树没有对应的搭建记录，不拆");
        // Never let worktree removal traverse a dependency junction, including one left by an interrupted setup.
        for (const relative of [...new Set([...(saved.junctions ?? []), ...dependencies(main), ...dependencies(target)])]) {
          const link = path.join(target, relative);
          const stat = lstatSync(link, { throwIfNoEntry: false });
          if (!stat) continue;
          if (!stat.isSymbolicLink() || !samePath(readlinkSync(link), path.join(main, relative))) throw new Error(`依赖位置不是预期的目录联接，不拆：${link}`);
          rmdirSync(link);
        }
        await git(main, ["worktree", "remove", target]);
        const base = await defaultBranch(main);
        const merged = (await git(main, ["branch", "--merged", base, "--format=%(refname:short)"])).split("\n").includes(branch);
        if (merged) await git(main, ["branch", "-D", branch]);
        append(ctx.root, s.id, [{ kind: "env", project, path: target, branch, removed: true }], { now: ctx.now(), tz: ctx.policy.tz });
        results.push(`${project}：环境已拆${merged ? "，已合并分支已删" : "；分支未合并，已保留"}。`);
      } else {
        if (tree) {
          if (!tree.includes(`branch refs/heads/${branch}`)) throw new Error("同名目录是别的分支，不接管");
          if (saved) { results.push(`${project}：已建，跳过。`); continue; }
        } else {
          if (existsSync(target)) throw new Error(`同名目录已存在，不覆盖：${target}`);
          const base = await defaultBranch(main);
          const branches = (await git(main, ["branch", "--format=%(refname:short)"])).split("\n");
          await git(main, ["worktree", "add", ...(branches.includes(branch) ? [] : ["-b", branch]), target, branches.includes(branch) ? branch : base]);
        }
        const junctions = dependencies(main);
        for (const relative of junctions) {
          const link = path.join(target, relative);
          if (!existsSync(link)) { mkdirSync(path.dirname(link), { recursive: true }); symlinkSync(path.join(main, relative), link, "junction"); }
        }
        append(ctx.root, s.id, [{ kind: "env", project, path: target, branch, junctions }], { now: ctx.now(), tz: ctx.policy.tz });
        results.push(`${project}：${target}（${branch}），已复用依赖。`);
      }
    } catch (error) { return { ok: false, text: [...results, `没${remove ? "拆" : "搭"}成：${String(error.stderr || error.message).trim()}`].join("\n") }; }
  }
  return { ok: true, text: results.join("\n") || "没有需要搭建的 git 项目。" };
}
