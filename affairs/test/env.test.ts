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
  // Where Paseo put the worktree is only known once it has been made.
  const where = () => load(w.root, "sample-env").envs[0]?.path as string;
  t.after(() => { const target = where();if (!target) return;for (const relative of ["node_modules", "pkg/node_modules"]) { const link = path.join(target, relative);if (existsSync(link) && lstatSync(link).isSymbolicLink()) rmdirSync(link); } });
  return { w, main, where, project };
}

test("env has Paseo create the worktree from the default branch under the original project, not beside it, links root and one-level dependencies, records local paths only in log and skips existing", async (t) => {
  const f = setup(t);
  const result = await env(f.w.ctx, "sample-env");assert.ok(result.ok, result.text);assert.match(result.text || "", /svn 用哪个副本要问他/);
  const target = f.where();
  try {
    const create = f.w.calls().find((c) => c[0] === "workspace" && c[1] === "create")!;
    assert.ok(create.includes("worktree"), "asks Paseo for a worktree");
    assert.equal(realpathSync.native(create[create.indexOf("--path") + 1]), realpathSync.native(f.main), "of the source checkout");
    assert.notEqual(path.resolve(path.dirname(target)).toLowerCase(), path.resolve(path.dirname(f.main)).toLowerCase(), "never a sibling of the checkout");
    assert.equal(f.w.calls().filter((c) => c[0] === "project" && c[1] === "create").length, 0, "no project of its own");
    assert.equal(git(target, "branch", "--show-current"), "affair/sample-env");
    assert.equal(git(target, "rev-parse", "HEAD"), git(f.main, "rev-parse", "main"));
    for (const rel of ["node_modules", "pkg/node_modules"]) {
      assert.ok(lstatSync(path.join(target, rel)).isSymbolicLink());
      assert.equal(realpathSync.native(path.join(target, rel)), realpathSync.native(path.join(f.main, rel)));
    }
    assert.equal(realpathSync.native(load(f.w.root, "sample-env").envs[0].path), realpathSync.native(target));
    assert.match((await env(f.w.ctx, "sample-env")).text || "", /已建，跳过/);
  } finally { assert.ok((await env(f.w.ctx, "sample-env", { remove: true })).ok); }
});

test("env remove must detach untracked dependency junctions before worktree removal; targets survive and merged branch is deleted", async (t) => {
  const f = setup(t);assert.ok((await env(f.w.ctx, "sample-env")).ok);
  const target = f.where();
  const removed = await env(f.w.ctx, "sample-env", { remove: true });
  assert.ok(removed.ok, removed.text);
  assert.ok(f.w.calls().some((c) => c[0] === "workspace" && c[1] === "archive"), "Paseo removes the workspace it made");
  assert.equal(existsSync(target), false);
  for (const rel of ["node_modules", "pkg/node_modules"]) assert.equal(readFileSync(path.join(f.main, rel, "keep"), "utf8"), "dependency");
  assert.equal(git(f.main, "branch", "--list", "affair/sample-env"), "");
});

test("env remove keeps an unmerged branch and refuses a dirty worktree without deleting its changes", async (t) => {
  const f = setup(t);assert.ok((await env(f.w.ctx, "sample-env")).ok);
  const target = f.where();
  writeFileSync(path.join(target, "seed"), "changed");
  const dirty = await env(f.w.ctx, "sample-env", { remove: true });assert.equal(dirty.ok, false);assert.equal(readFileSync(path.join(target, "seed"), "utf8"), "changed");
  git(target, "add", "seed");git(target, "commit", "-m", "unmerged change");
  const removed = await env(f.w.ctx, "sample-env", { remove: true });assert.ok(removed.ok, removed.text);assert.match(removed.text || "", /未合并，已保留/);
  assert.equal(git(f.main, "branch", "--list", "affair/sample-env").trim(), "affair/sample-env");
});

test("env that Paseo cannot make leaves no worktree, no record and installs nothing", async (t) => {
  const f = setup(t);process.env.FAKE_PASEO_FAIL = "workspace create";
  const result = await env(f.w.ctx, "sample-env");assert.equal(result.ok, false);
  assert.equal(load(f.w.root, "sample-env").envs.length, 0);
  assert.equal((git(f.main, "worktree", "list", "--porcelain").match(/^worktree /gm) ?? []).length, 1);
  assert.equal(existsSync(path.join(f.main, "package-lock.json")), false);
});

test("env remove still takes down a sibling worktree an earlier version made (no workspace id in the record)", async (t) => {
  const f = setup(t);
  const old = path.join(realpathSync.native(f.w.dir), "repo-affair-sample-env");
  git(f.main, "worktree", "add", "-b", "affair/sample-env", old, "main");
  append(f.w.root, "sample-env", [{ kind: "env", project: f.project, path: old, branch: "affair/sample-env", junctions: [] }]);
  assert.match((await env(f.w.ctx, "sample-env")).text || "", /已建，跳过/);
  const removed = await env(f.w.ctx, "sample-env", { remove: true });assert.ok(removed.ok, removed.text);
  assert.equal(existsSync(old), false);
  assert.equal(f.w.calls().some((c) => c[0] === "workspace" && c[1] === "archive"), false);
});
