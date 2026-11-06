import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { test, type TestContext } from "node:test";
import { append, load } from "../server/lib/log.mjs";
import { env } from "../server/lib/env.mjs";
import { world } from "./kit";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
function setup(t: TestContext) {
  const w = world();
  const main = path.join(w.dir, "repo");mkdirSync(main);
  git(main, "init", "-b", "main");git(main, "config", "user.name", "Test");git(main, "config", "user.email", "test@example.com");
  writeFileSync(path.join(main, "seed"), "seed");mkdirSync(path.join(main, "pkg"));writeFileSync(path.join(main, "pkg", "seed"), "seed");
  git(main, "add", ".");git(main, "commit", "-m", "seed");
  for (const rel of ["node_modules", "pkg/node_modules"]) { mkdirSync(path.join(main, rel), { recursive: true });writeFileSync(path.join(main, rel, "keep"), "dependency"); }
  const project = `path:${os.hostname()}:${main.replaceAll("\\", "/")}`;
  append(w.root, "sample-env", [{ kind: "created", id: "sample-env", title: "环境探针", projects: [project, "svn:example.com/repository"] }]);
  const target = path.join(w.dir, "repo-affair-sample-env");
  t.after(() => { for (const relative of ["node_modules", "pkg/node_modules"]) { const link = path.join(target, relative);if (existsSync(link) && lstatSync(link).isSymbolicLink()) rmdirSync(link); } });
  return { w, main, target, project };
}

test("env creates sibling worktree from default branch, links root and one-level dependencies, records local paths only in log and skips existing", async (t) => {
  const f = setup(t);
  const result = await env(f.w.ctx, "sample-env");assert.ok(result.ok, result.text);assert.match(result.text || "", /svn 用哪个副本要问他/);
  try {
    assert.equal(git(f.target, "branch", "--show-current"), "affair/sample-env");
    assert.equal(git(f.target, "rev-parse", "HEAD"), git(f.main, "rev-parse", "main"));
    for (const rel of ["node_modules", "pkg/node_modules"]) {
      assert.ok(lstatSync(path.join(f.target, rel)).isSymbolicLink());
      assert.equal(realpathSync.native(path.join(f.target, rel)), realpathSync.native(path.join(f.main, rel)));
    }
    assert.equal(realpathSync.native(load(f.w.root, "sample-env").envs[0].path), realpathSync.native(f.target));
    assert.match((await env(f.w.ctx, "sample-env")).text || "", /已建，跳过/);
  } finally { assert.ok((await env(f.w.ctx, "sample-env", { remove: true })).ok); }
});

test("env remove must detach untracked dependency junctions before worktree removal; targets survive and merged branch is deleted", async (t) => {
  const f = setup(t);assert.ok((await env(f.w.ctx, "sample-env")).ok);
  const removed = await env(f.w.ctx, "sample-env", { remove: true });
  assert.ok(removed.ok, removed.text);
  assert.equal(existsSync(f.target), false);
  for (const rel of ["node_modules", "pkg/node_modules"]) assert.equal(readFileSync(path.join(f.main, rel, "keep"), "utf8"), "dependency");
  assert.equal(git(f.main, "branch", "--list", "affair/sample-env"), "");
});

test("env remove keeps an unmerged branch and refuses a dirty worktree without deleting its changes", async (t) => {
  const f = setup(t);assert.ok((await env(f.w.ctx, "sample-env")).ok);
  writeFileSync(path.join(f.target, "seed"), "changed");
  const dirty = await env(f.w.ctx, "sample-env", { remove: true });assert.equal(dirty.ok, false);assert.equal(readFileSync(path.join(f.target, "seed"), "utf8"), "changed");
  git(f.target, "add", "seed");git(f.target, "commit", "-m", "unmerged change");
  const removed = await env(f.w.ctx, "sample-env", { remove: true });assert.ok(removed.ok, removed.text);assert.match(removed.text || "", /未合并，已保留/);
  assert.equal(git(f.main, "branch", "--list", "affair/sample-env").trim(), "affair/sample-env");
});

test("env refuses an existing sibling directory and never installs dependencies", async (t) => {
  const f = setup(t);mkdirSync(f.target);writeFileSync(path.join(f.target, "keep"), "not ours");
  const result = await env(f.w.ctx, "sample-env");assert.equal(result.ok, false);assert.match(result.text || "", /同名目录已存在/);
  assert.equal(readFileSync(path.join(f.target, "keep"), "utf8"), "not ours");
  assert.equal(existsSync(path.join(f.main, "package-lock.json")), false);
});
