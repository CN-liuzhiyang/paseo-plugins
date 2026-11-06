import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as ops from "../server/lib/ops.mjs";
import { append, fold, load, read } from "../server/lib/log.mjs";
import { primaryLink, parseLink, hrefOf } from "../server/lib/links.mjs";
import { keyOfDir, keyOfRemote, keyOfSvn, localPathOf, matchesProject } from "../server/lib/projects.mjs";
import { finishWork, flushWork, refreshWork, restoreWork, saveWork, sizeWarnings, workTexts } from "../server/lib/workdir-git.mjs";
import { injectProject, projectContext } from "../server/lib/project-context.mjs";
import { chatPrompt, chatHandbooks } from "../server/lib/chat.mjs";
import { loadPolicy } from "../server/lib/policy.mjs";
import { help } from "../server/lib/commands.mjs";
import { scratch, world } from "./kit";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init"); git(dir, "config", "core.autocrlf", "false"); git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.com");
  writeFileSync(path.join(dir, "seed"), "seed\n"); git(dir, "add", "."); git(dir, "commit", "-m", "seed");
  return dir;
}
function stored() {
  const w = world();
  const bare = path.join(w.dir, "remote.git"); git(w.dir, "init", "--bare", bare);
  const docs = repo(path.join(w.dir, "docs")); git(docs, "remote", "add", "origin", bare); git(docs, "push", "-u", "origin", "HEAD");
  w.ctx.policy = { ...w.ctx.policy, workDir: path.join(docs, "work"), areaByKind: { ticket: "产品" } };
  append(w.root, "build-tool", [{ kind: "created", id: "build-tool", title: "构建工具", links: ["ticket:800001"], projects: [], workdir: docs }], { now: w.now() });
  refreshWork(w.ctx, load(w.root, "build-tool"));
  return { ...w, docs, bare, folder: path.join(docs, "work/build-tool") };
}

test("links: old logs, multiple links, changing primary, duplicate rejection and exact find", async () => {
  const w = world();
  const legacy = fold([{ kind: "created", seq: 1, id: "D1", title: "old", link: "ticket:#800001" }]);
  assert.deepEqual(legacy.links, ["ticket:800001"]);
  const one = await ops.create(w.ctx, { id: "one-job", title: "第一件", link: ["ticket:800001", "feishu-task:abc"], noWait: true });
  assert.equal(one.ok, true, one.text);
  assert.deepEqual(load(w.root, one.id).links, ["ticket:800001", "feishu-task:abc"]);
  assert.equal(ops.find(w.ctx, "feishu-task:abc").hits[0].id, one.id);
  const two = await ops.create(w.ctx, { id: "two-job", title: "第二件", noWait: true });
  const add = await ops.link(w.ctx, two.id, "add", "feishu-task:abc");
  assert.equal(add.ok, false); assert.match(add.text, /800001/);
  const duplicate = await ops.create(w.ctx, { id: "third-job", title: "第三件", link: "feishu-task:abc", noWait: true });
  assert.equal(duplicate.ok, false); assert.match(duplicate.text, /800001/);
  await ops.link(w.ctx, one.id, "rm", "ticket:800001");
  assert.equal(primaryLink(load(w.root, one.id)), "feishu-task:abc");
  assert.deepEqual(parseLink("github:Team/Repo#42"), { kind: "github", ref: "team/repo#42" });
  assert.equal(hrefOf({ github: "https://github.com/{ref}" }, "github", "team/repo#42"), "https://github.com/team/repo/issues/42");
});

test("new: short names required, invalid names refused, ticket numbers preserved", async () => {
  const w = world();
  for (const id of [undefined, "A", "a", "../escape", "with space", "a".repeat(41)]) {
    const got = await ops.create(w.ctx, { id, title: "工具", noWait: true });
    assert.equal(got.ok, false, String(id)); assert.match(got.text, /--id/);
  }
  const made = await ops.create(w.ctx, { id: "valid-name2", title: "工具", noWait: true });
  assert.equal(made.id, "valid-name2");
  assert.equal((await ops.create(w.ctx, { title: "单子", link: "ticket:800002", noWait: true })).id, "800002");
});

test("primary link chooses the default role, while explicit and legacy roles stay chosen", async () => {
  const w = world({ policy: { watchKinds: ["ticket", "task"], roleByKind: { ticket: "glance", task: "other" } } });
  w.ctx.policy.roles = { ...w.ctx.policy.roles, other: { ...w.ctx.policy.roles.glance, provider: "claude/claude-sonnet-5-5" } };
  const made = await ops.create(w.ctx, { title: "默认档位", link: ["ticket:800005", "task:abc"], noWait: true });
  await ops.link(w.ctx, made.id, "rm", "ticket:800005");
  assert.equal(load(w.root, made.id).roleName, "other");
  assert.ok(w.calls().some((a) => a[0] === "schedule" && a[1] === "update" && a.includes("claude/claude-sonnet-5-5")));
  const explicit = await ops.create(w.ctx, { title: "指定档位", link: ["ticket:800006", "task:def"], role: "glance", noWait: true });
  await ops.link(w.ctx, explicit.id, "rm", "ticket:800006");
  assert.equal(load(w.root, explicit.id).roleName, "glance");
  append(w.root, "old-job", [{ kind: "created", id: "old-job", title: "旧事项", link: "task:old", role: "glance" }]);
  await ops.link(w.ctx, "old-job", "rm", "task:old");
  assert.equal(load(w.root, "old-job").roleName, "glance");
});

test("failed setup leaves no active work folder or project listing", async () => {
  const w = stored();
  process.env.FAKE_PASEO_FAIL = "workspace create";
  let made;
  try { made = await ops.create(w.ctx, { id: "failed-job", title: "失败建项", noWait: true }); }
  finally { delete process.env.FAKE_PASEO_FAIL; }
  assert.equal(made.ok, false);
  assert.equal(existsSync(path.join(w.docs, "work/failed-job")), false);
  assert.doesNotMatch(readFileSync(path.join(w.docs, "work/INDEX.md"), "utf8"), /failed-job/);
  assert.equal((await ops.save(w.ctx, "failed-job")).ok, false);
});

test("projects: Paseo remote rules, default ports, SVN prefix boundaries, path and worktrees", async () => {
  for (const remote of ["https://User@GitHub.com/Team/Repo.git", "git@GITHUB.COM:Team/Repo.git", "ssh://git@github.com:22/Team/Repo.git"]) assert.equal(keyOfRemote(remote), "remote:github.com/team/repo");
  assert.equal(keyOfRemote("ssh://git@Git.Example.com:2200/Team/Repo.git"), "remote:git.example.com:2200/Team/Repo");
  assert.equal(keyOfRemote("https://git.example.com:443/Team/Repo.git"), "remote:git.example.com/Team/Repo");
  assert.equal(keyOfSvn("https://user@svn.example.com/svn/Product/Trunk"), "svn:svn.example.com/svn/Product/Trunk");
  assert.equal(matchesProject("svn:svn.example.com/repo/Trunk/Client", "svn:svn.example.com/repo/Trunk"), true);
  assert.equal(matchesProject("svn:svn.example.com/repo/Trunk2", "svn:svn.example.com/repo/Trunk"), false);
  const base = scratch("affair-project-"); const main = repo(path.join(base, "main")); const wt = path.join(base, "wt");
  git(main, "remote", "add", "origin", "https://github.com/team/repo.git"); git(main, "worktree", "add", wt, "-b", "topic");
  const registry = path.join(base, "projects.json"); const key = "remote:github.com/team/repo";
  writeFileSync(registry, JSON.stringify([{ kind: "git", projectKey: key, rootPath: wt }, { kind: "git", projectKey: key, rootPath: main }]));
  const policy = { projects: { registry, searchDirs: [base] } };
  assert.equal(await keyOfDir(wt, policy), key); assert.equal(await localPathOf(key, policy), main);
  writeFileSync(registry, "[]");
  assert.equal(await keyOfDir(wt, policy), key); assert.equal(await localPathOf(key, policy), main);
  const local = path.join(base, "local"); mkdirSync(local);
  const localKey = await keyOfDir(local, policy);
  assert.equal(localKey, `path:${os.hostname()}:${local.replaceAll("\\", "/")}`);
  assert.equal(await localPathOf(localKey, policy), local.replaceAll("\\", "/"));
  assert.equal(await localPathOf("remote:github.com/no/such", policy), "");
});

test("projectsByKind decides workdir, missing checkout refuses before creating", async () => {
  const w = world(); const dir = repo(path.join(w.dir, "project"));
  const key = `path:${os.hostname()}:${dir}`;
  w.ctx.policy.projectsByKind = { ticket: [key] };
  const made = await ops.create(w.ctx, { title: "工作", link: "ticket:800003", noWait: true });
  assert.equal(made.ok, true); assert.equal(load(w.root, made.id).workdir, dir);
  assert.deepEqual(load(w.root, made.id).projects, [key]);
  w.ctx.policy.projectsByKind.ticket = ["remote:github.com/missing/project"];
  w.ctx.policy.projects = { registry: path.join(w.dir, "none"), searchDirs: [] };
  const bad = await ops.create(w.ctx, { title: "没检出", link: "ticket:800004", noWait: true });
  assert.equal(bad.ok, false); assert.match(bad.text, /这台机器上没检出 remote:github.com\/missing\/project/);
  assert.equal(existsSync(path.join(w.root, "800004")), false);
  await ops.project(w.ctx, made.id, "add", "svn:svn.example.com/repo/Trunk");
  assert.equal(load(w.root, made.id).projects.length, 2);
  await ops.project(w.ctx, made.id, "rm", key); assert.equal(load(w.root, made.id).projects.length, 1);
});

test("work: stable generation, INDEX, debounce, save only this folder with unrelated staged and unstaged files", async () => {
  const w = stored(); const status = path.join(w.folder, "status.md"); const before = statSync(status).mtimeMs;
  const index = readFileSync(path.join(w.docs, "work/INDEX.md"), "utf8"); assert.match(index, /产品 \| build-tool/);
  assert.doesNotMatch(readFileSync(status, "utf8"), /下次/);
  writeFileSync(path.join(w.folder, "README.md"), "# 决定\n用临时仓库验证。\n");
  refreshWork(w.ctx, load(w.root, "build-tool")); assert.equal(statSync(status).mtimeMs, before);
  assert.match(readFileSync(path.join(w.folder, "README.md"), "utf8"), /临时仓库/);
  writeFileSync(path.join(w.docs, "staged"), "leave staged\n"); git(w.docs, "add", "staged");
  writeFileSync(path.join(w.docs, "seed"), "leave unstaged\n");
  await flushWork(w.ctx); assert.equal(git(w.docs, "log", "-1", "--format=%s"), "seed");
  w.advance(600_000); await flushWork(w.ctx);
  assert.deepEqual(git(w.docs, "show", "--format=", "--name-only", "HEAD").split("\n").sort(), ["work/INDEX.md", "work/build-tool/README.md", "work/build-tool/status.md"]);
  assert.equal(git(w.docs, "diff", "--cached", "--name-only"), "staged"); assert.equal(git(w.docs, "diff", "--name-only"), "seed");
  assert.equal(git(w.bare, "show", "HEAD:work/build-tool/README.md"), "# 决定\n用临时仓库验证。");
  const saved = await saveWork(w.ctx, "build-tool"); assert.equal(saved.ok, true, saved.text);
});

test("work: rejected push rebases and retries, conflicting rebase aborts and flags", async () => {
  const w = stored(); assert.equal((await saveWork(w.ctx, "build-tool")).ok, true);
  const other = path.join(w.dir, "other"); git(w.dir, "clone", w.bare, other); git(other, "config", "user.name", "Other"); git(other, "config", "user.email", "other@example.com");
  writeFileSync(path.join(other, "remote-only"), "remote\n"); git(other, "add", "."); git(other, "commit", "-m", "remote change"); git(other, "push");
  writeFileSync(path.join(w.folder, "README.md"), "local decision\n");
  assert.equal((await saveWork(w.ctx, "build-tool")).ok, true); assert.equal(readFileSync(path.join(w.docs, "remote-only"), "utf8"), "remote\n");
  git(other, "pull", "--rebase"); writeFileSync(path.join(other, "work/build-tool/README.md"), "remote conflict\n"); git(other, "add", "."); git(other, "commit", "-m", "conflict"); git(other, "push");
  writeFileSync(path.join(w.folder, "README.md"), "local conflict\n");
  const failed = await saveWork(w.ctx, "build-tool"); assert.equal(failed.ok, false); assert.match(failed.text, /没推上去/);
  assert.equal(existsSync(path.join(w.docs, ".git/rebase-merge")), false); assert.equal(readFileSync(path.join(w.folder, "README.md"), "utf8"), "local conflict\n");
  assert.ok(load(w.root, "build-tool").flags.some((f: any) => f.what === "work-git"));
});

test("work: finish deletes, archive hash recovers latest README, resume restores and removes the archive line", async () => {
  const w = stored(); writeFileSync(path.join(w.folder, "README.md"), "latest decision\n");
  append(w.root, "build-tool", [{ kind: "report", status: "构建通过" }, { kind: "status", status: "done" }], { now: w.now() });
  await finishWork(w.ctx, load(w.root, "build-tool")); assert.equal(existsSync(w.folder), false);
  const done = path.join(w.docs, "work/done/2026-11.md"); const line = readFileSync(done, "utf8");
  assert.match(line, /办完：构建通过/); const hash = /del ([a-f0-9]+)/.exec(line)![1];
  assert.equal(git(w.docs, "show", `${hash}:work/build-tool/README.md`), "latest decision");
  append(w.root, "build-tool", [{ kind: "status", status: "watching" }], { now: w.now() });
  await restoreWork(w.ctx, load(w.root, "build-tool"));
  assert.equal(readFileSync(path.join(w.folder, "README.md"), "utf8"), "latest decision\n"); assert.equal(readFileSync(done, "utf8"), "");
  assert.match(readFileSync(path.join(w.folder, "status.md"), "utf8"), /state: "open"/);
});

test("chat: embeds originals, short handbooks, size warnings and no repeated brief sections", async () => {
  const w = stored(); const books = path.join(w.dir, "books"); mkdirSync(books);
  append(w.root, "build-tool", [{ kind: "mode", mode: "watch" }], { now: w.now() });
  writeFileSync(path.join(books, "handbook.chat.md"), "PUBLIC CHAT"); writeFileSync(path.join(books, "affair.chat.md"), "PRIVATE CHAT"); writeFileSync(path.join(books, "ticket.chat.md"), "KIND CHAT");
  w.ctx.policy.handbookPath = path.join(books, "handbook.md"); w.ctx.policy.handbooksDir = books; w.ctx.policy.chatHandbookByKind = { ticket: "ticket.chat.md" };
  const s = load(w.root, "build-tool"); const texts = workTexts(w.ctx, s); const prompt = chatPrompt(w.ctx, s);
  for (const text of [texts.status, texts.readme, "PUBLIC CHAT", "PRIVATE CHAT", "KIND CHAT"]) assert.ok(prompt.includes(text));
  assert.doesNotMatch(prompt, /去读|只看里面|某一节/);
  const brief = await ops.brief({ ...w.ctx, by: "chat", chatFor: s.id }, s.id, { chat: true }); assert.equal(brief.text, "没有新的。");
  writeFileSync(path.join(w.folder, "README.md"), "大".repeat(1500));
  assert.match(sizeWarnings(w.ctx, s, chatHandbooks(w.ctx, s)).join("\n"), /README 超了/);
  const saved = await ops.save(w.ctx, s.id); assert.match(saved.text, /README 超了/);
  assert.equal(help("flow").ok, true); assert.match(help().text, /中文一律 --said - 或 --file/);
});

test("policy: follows one absolute use pointer and reports its actual source", () => {
  const dir = scratch("affair-policy-"); const actual = path.join(dir, "actual.json"); const root = path.join(dir, "root"); mkdirSync(root);
  writeFileSync(actual, JSON.stringify({ workDir: "custom", homes: { ticket: "obsolete" } })); writeFileSync(path.join(root, "policy.json"), JSON.stringify({ use: actual }));
  const policy = loadPolicy(root); assert.equal(policy.workDir, "custom"); assert.equal(policy.sourcePath, actual); assert.equal(policy.homes, undefined);
  writeFileSync(actual, JSON.stringify({ use: actual })); assert.throws(() => loadPolicy(root), /只能跟一次/);
});

test("M2: matched project injects, unrelated stays byte-identical, own chat skips, here and attached note use verified caller", async () => {
  const w = stored(); const project = repo(path.join(w.dir, "project")); git(project, "remote", "add", "origin", "https://github.com/team/tool.git");
  await ops.project(w.ctx, "build-tool", "add", "remote:github.com/team/tool");
  const request = { config: { cwd: project, systemPrompt: "BASE" }, env: {} };
  assert.match((await injectProject(w.ctx.policy, request)).config.systemPrompt, /BASE\n\n本项目上在进行的事：[\s\S]*build-tool/);
  assert.equal(await injectProject(w.ctx.policy, { ...request, env: { AFFAIR_ID: "build-tool" } }), undefined);
  const unrelated = path.join(w.dir, "unrelated"); mkdirSync(unrelated);
  assert.equal(await injectProject(w.ctx.policy, { ...request, config: { cwd: unrelated, systemPrompt: "BASE" } }), undefined);
  assert.match((await ops.here(w.ctx, project)).text, /build-tool/);
  assert.equal(await injectProject(w.ctx.policy, { ...request, labels: { "paseo.schedule-id": "plan" } }), undefined);
  for (let i = 0; i < 6; i++) {
    const id = `job-${i}`;
    append(w.root, id, [{ kind: "created", id, title: id, projects: ["remote:github.com/team/tool"] }]);
    refreshWork(w.ctx, load(w.root, id));
  }
  assert.match((await injectProject(w.ctx.policy, request)).config.systemPrompt, /还有 2 件/);
  assert.equal((await ops.here(w.ctx, project)).text.split("\n").filter((l) => l.startsWith("job-")).length, 6);
  writeFileSync(path.join(w.folder, "status.md"), '---\nprojects: invalid\n---\n');
  const errors: string[] = [];
  assert.equal(await projectContext(w.ctx.policy, request, (text: string) => errors.push(text)), undefined);
  assert.match(errors[0], /left unchanged/);
  refreshWork(w.ctx, load(w.root, "build-tool"));
  process.env.PASEO_AGENT_ID = "verified-agent";
  try {
    const attached = await ops.attach(w.ctx, "build-tool"); assert.equal(attached.ok, true, attached.text); assert.match(attached.text, /构建工具/);
    const info = await ops.callerInfo(w.ctx); assert.equal(info.by, "attached");
    const ctx = { ...w.ctx, ...info };
    assert.equal((await ops.note(ctx, "build-tool", { mine: true, said: "构建验证通过" })).ok, true);
    assert.equal((await ops.stop(ctx, "build-tool")).ok, false);
    assert.equal((await ops.attach({ ...w.ctx, by: "look" }, "build-tool")).ok, false);
    assert.equal(read(w.root, "build-tool").filter((l) => l.kind === "attached")[0].agentId, "verified-agent");
  } finally { delete process.env.PASEO_AGENT_ID; }
});

test("current words: newest in this chat turn, no prior turn or other channel, including equal timestamps", () => {
  const s = fold([
    { kind: "created", seq: 1, id: "tool-job", title: "tool" },
    { kind: "chat", seq: 2, agentId: "chat" },
    { kind: "said", seq: 3, at: "2026-11-02T10:00:00Z", text: "go", via: "chat-session", by: "user" },
    { kind: "chat.turn", seq: 4, at: "2026-11-02T10:00:00Z", agentId: "chat" },
  ]);
  s.lines = [{ kind: "chat.turn", seq: 4, agentId: "chat" }];
  assert.equal(ops.currentSaid(s), undefined);
  s.said.push({ seq: 5, at: "2026-11-02T10:00:00Z", text: "again", via: "chat-session", by: "user" }, { seq: 6, text: "elsewhere", via: "chat", by: "user" });
  assert.equal(ops.currentSaid(s).seq, 5);
});

test("CLI Chinese file input: new, note and answer never need shell-quoted text", () => {
  const w = world(); const file = path.join(w.dir, "words.txt"); writeFileSync(file, "原话在文件里");
  const bin = path.resolve(import.meta.dirname, "../bin/affair.mjs");
  const cli = (...args: string[]) => spawnSync(process.execPath, [bin, ...args, "--root", w.root, "--json"], { encoding: "utf8", env: process.env });
  const made = cli("new", "--id", "file-job", "--title", "File", "--file", file, "--no-wait"); assert.equal(made.status, 0, made.stderr);
  assert.equal(load(w.root, "file-job").said[0].text, "原话在文件里");
  assert.equal(cli("note", "file-job", "--file", file).status, 0);
  append(w.root, "file-job", [{ kind: "asked", id: "file-job-1", title: "问题", options: ["原话在文件里"] }]);
  assert.equal(cli("answer", "file-job-1", "--file", file).status, 0);
  assert.equal(load(w.root, "file-job").answers["file-job-1"], "原话在文件里");
});
