import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { append, listIds, load, logFile, read } from "../server/lib/log.mjs";
import * as ops from "../server/lib/ops.mjs";
import { refreshWork } from "../server/lib/workdir-git.mjs";
import { world } from "./kit";

const bin = path.resolve(import.meta.dirname, "../bin/affair.mjs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
type W = ReturnType<typeof world>;
function cli(w: W, args: string[], env: Record<string, string> = {}, input = "") {
  return spawnSync(process.execPath, [bin, "--root", w.root, "--json", ...args], { encoding: "utf8", input, env: { ...process.env, PASEO_AGENT_ID: "", FAKE_PASEO_LABELS: "{}", ...env } });
}
const seed = (w: W, id = "source-job") => append(w.root, id, [{ kind: "created", id, title: id }, { kind: "chat", agentId: `main-${id}` }], { now: w.now() });
function stored() {
  const w = world();
  const docs = path.join(w.dir, "docs"); mkdirSync(docs);
  const bare = path.join(w.dir, "remote.git"); git(w.dir, "init", "--bare", bare);
  git(docs, "init"); git(docs, "config", "core.autocrlf", "false"); git(docs, "config", "user.name", "Test"); git(docs, "config", "user.email", "test@example.com");
  writeFileSync(path.join(docs, "seed"), "seed\n"); git(docs, "add", "."); git(docs, "commit", "-m", "seed");
  git(docs, "remote", "add", "origin", bare); git(docs, "push", "-u", "origin", "HEAD");
  const workDir = path.join(docs, "work"); w.ctx.policy.workDir = workDir;
  mkdirSync(w.root); writeFileSync(path.join(w.root, "policy.json"), JSON.stringify({ workDir }));
  return { ...w, docs, bare, workDir };
}

test("CLI: the current main chat changes its own links/projects; scope, uniqueness, kind and restricted callers hold", () => {
  const w = world(); seed(w); seed(w, "other-job");
  append(w.root, "source-job", [{ kind: "schedule", scheduleId: "source-plan" }, { kind: "attached", agentId: "attached" }, { kind: "dispatched", agentId: "recorded-worker" }]);
  append(w.root, "other-job", [{ kind: "link", action: "add", link: "task:occupied" }]);
  const main = { PASEO_AGENT_ID: "main-source-job" };
  for (const [command, value] of [["link", "task:own"], ["project", "remote:github.com/team/repo"]]) {
    for (const action of ["add", "rm"]) {
      const result = cli(w, [command, "source-job", action, value], main);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const s = load(w.root, "source-job");
      assert.equal((command === "link" ? s.links : s.projects).includes(value), action === "add");
      const cross = cli(w, [command, "other-job", action, value], main);
      assert.equal(cross.status, 1); assert.match(cross.stdout, /只管 source-job/);
    }
  }
  assert.match(cli(w, ["link", "source-job", "add", "task:occupied"], main).stdout, /关联已经挂在 other-job/);
  assert.equal(cli(w, ["link", "source-job", "add", "svn:invalid"], main).status, 1);
  assert.equal(cli(w, ["project", "source-job", "add", "invalid"], main).status, 1);
  append(w.root, "source-job", [{ kind: "chat", agentId: "replacement" }]);
  const before = readFileSync(logFile(w.root, "source-job"), "utf8");
  for (const env of [
    { PASEO_AGENT_ID: "look", FAKE_PASEO_LABELS: JSON.stringify({ "paseo.schedule-id": "source-plan" }) },
    { PASEO_AGENT_ID: "attached" },
    { PASEO_AGENT_ID: "recorded-worker" },
    { PASEO_AGENT_ID: "labelled-worker", FAKE_PASEO_LABELS: JSON.stringify({ "affairs.role": "dispatched" }) },
    main,
  ]) {
    for (const args of [["link", "source-job", "add", "task:denied"], ["project", "source-job", "add", "remote:github.com/denied/repo"], ["new", "--id", "denied-job", "--title", "Denied", "--no-wait"]]) {
      const result = cli(w, args, env);
      assert.equal(result.status, 1, result.stdout + result.stderr);
    }
  }
  assert.equal(readFileSync(logFile(w.root, "source-job"), "utf8"), before);
  assert.equal(listIds(w.root).includes("denied-job"), false);
  assert.equal(cli(w, ["link", "source-job", "add", "task:entry"]).status, 0, "entry sessions retain access");
});

test("CLI: a main chat creates a child with verified origin and said seq, leaves its source unchanged; entry cannot forge origin", async () => {
  const w = stored(); seed(w);
  append(w.root, "source-job", [{ kind: "said", text: "请跟进后续", via: "chat-session", by: "user" }], { now: w.now() });
  refreshWork(w.ctx, load(w.root, "source-job"));
  const source = readFileSync(logFile(w.root, "source-job"), "utf8");
  const sourceReadme = readFileSync(path.join(w.workDir, "source-job/README.md"), "utf8");
  const made = cli(w, ["new", "--id", "child-job", "--title", "Child", "--no-wait", "--origin", "forged"], { PASEO_AGENT_ID: "main-source-job" });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const origin = { affairId: "source-job", agentId: "main-source-job", saidSeq: 3 };
  assert.deepEqual(read(w.root, "child-job")[0].origin, origin);
  assert.deepEqual(load(w.root, "child-job").origin, origin);
  assert.deepEqual(load(w.root, "child-job").links, []);
  assert.equal(readFileSync(logFile(w.root, "source-job"), "utf8"), source);
  assert.equal(readFileSync(path.join(w.workDir, "source-job/README.md"), "utf8"), sourceReadme);
  assert.match(cli(w, ["show", "child-job", "--log"]).stdout, /origin.*source-job.*main-source-job/);
  assert.match(readFileSync(path.join(w.workDir, "child-job/status.md"), "utf8"), /来源：事项 source-job（对话 main-source-job）/);
  const entry = await ops.create(w.ctx, { id: "entry-job", title: "Entry", origin, createdFrom: origin, noWait: true });
  assert.equal(entry.ok, true, entry.text);
  assert.equal(Object.hasOwn(read(w.root, "entry-job")[0], "origin"), false);
  assert.equal(Object.hasOwn(read(w.root, "entry-job")[0], "createdFrom"), false);
  assert.match(readFileSync(path.join(w.workDir, "entry-job/README.md"), "utf8"), /# Entry[\s\S]*## 步骤/);
  const entryBefore = read(w.root, "entry-job").length;
  assert.equal((await ops.create(w.ctx, { id: "entry-job", title: "Duplicate", noWait: true })).ok, true);
  assert.equal(read(w.root, "entry-job").length, entryBefore, "new without initial README remains idempotent");
  const noSaid = cli(w, ["new", "--id", "next-child", "--title", "Next", "--no-wait"], { PASEO_AGENT_ID: "main-child-job", FAKE_PASEO_LABELS: JSON.stringify({ "affairs.chat": "child-job" }) });
  assert.equal(noSaid.status, 1, "a label alone cannot claim the current main chat");
  append(w.root, "child-job", [{ kind: "chat", agentId: "main-child-job" }]);
  const next = cli(w, ["new", "--id", "next-child", "--title", "Next", "--no-wait"], { PASEO_AGENT_ID: "main-child-job" });
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.deepEqual(read(w.root, "next-child")[0].origin, { affairId: "child-job", agentId: "main-child-job" });
});

test("a main chat cannot use new to write into and resume a different closed affair", async () => {
  const w = world(); seed(w); seed(w, "closed-job");
  append(w.root, "closed-job", [{ kind: "status", status: "stopped" }]);
  const before = readFileSync(logFile(w.root, "closed-job"), "utf8");
  const result = cli(w, ["new", "--id", "closed-job", "--title", "Closed", "--said", "altered", "--no-wait"], { PASEO_AGENT_ID: "main-source-job" });
  assert.equal(result.status, 1); assert.match(result.stdout, /不能重新打开/);
  assert.equal(readFileSync(logFile(w.root, "closed-job"), "utf8"), before);
});

test("CLI new --readme-file preserves exact README, keeps file/stdin words separate, saves only the new affair and INDEX", () => {
  const w = stored(); seed(w); refreshWork(w.ctx, load(w.root, "source-job"));
  const readme = "# 初始设计\r\n\r\n## 步骤\r\n- [ ] 核对消费方\r\n";
  const file = path.join(w.dir, "initial.md"); writeFileSync(file, readme);
  const words = path.join(w.dir, "words.txt"); writeFileSync(words, "文件里的原话\n");
  writeFileSync(path.join(w.docs, "staged"), "unrelated\n"); git(w.docs, "add", "staged");
  writeFileSync(path.join(w.docs, "seed"), "unstaged\n");
  for (const [id, saidArgs, input, expected] of [
    ["file-child", ["--file", words], "", "文件里的原话"],
    ["stdin-child", ["--said", "-"], "标准输入的原话\n", "标准输入的原话"],
  ] as const) {
    const made = cli(w, ["new", "--id", id, "--title", "Initial", "--readme-file", file, ...saidArgs, "--no-wait"], { PASEO_AGENT_ID: "main-source-job" }, input);
    assert.equal(made.status, 0, made.stdout + made.stderr);
    assert.equal(JSON.parse(made.stdout).saved, true);
    assert.equal(readFileSync(path.join(w.workDir, id, "README.md"), "utf8"), readme);
    assert.equal(load(w.root, id).said[0].text, expected);
    assert.equal(git(w.bare, "show", `HEAD:work/${id}/README.md`), readme.trim());
    assert.deepEqual(git(w.docs, "show", "--format=", "--name-only", "HEAD").split("\n").sort(), ["work/INDEX.md", `work/${id}/README.md`, `work/${id}/status.md`].sort());
    assert.equal(git(w.docs, "diff", "--cached", "--name-only"), "staged");
    assert.equal(git(w.docs, "diff", "--name-only"), "seed");
  }
  const previous = readFileSync(path.join(w.workDir, "file-child/README.md"), "utf8");
  const duplicate = cli(w, ["new", "--id", "file-child", "--title", "Duplicate", "--readme-file", file, "--no-wait"]);
  assert.equal(duplicate.status, 1); assert.match(duplicate.stdout, /已存在/);
  assert.equal(readFileSync(path.join(w.workDir, "file-child/README.md"), "utf8"), previous);
});

test("initial README validation refuses missing, empty and credential files before any side effect", async () => {
  const w = stored();
  const readme = path.join(w.dir, "initial.md");
  for (const content of [null, " \r\n", "api_key: abcdef1234567890"]) {
    if (content !== null) writeFileSync(readme, content);
    const made = cli(w, ["new", "--id", "invalid-job", "--title", "Invalid", "--readme-file", readme, "--no-wait"]);
    assert.equal(made.status, 1, made.stdout + made.stderr);
    assert.equal(existsSync(path.join(w.root, "invalid-job")), false);
    assert.equal(existsSync(w.workDir), false);
    assert.deepEqual(w.calls(), []);
  }
  writeFileSync(readme, "# Valid\n");
  const invalidDeadline = cli(w, ["new", "--id", "invalid-job", "--title", "Invalid", "--readme-file", readme, "--said", "words", "--deadline", "invalid", "--no-wait"]);
  assert.equal(invalidDeadline.status, 1); assert.match(invalidDeadline.stdout, /deadline/);
  assert.equal(existsSync(path.join(w.root, "invalid-job")), false); assert.deepEqual(w.calls(), []);
  const unconfigured = world();
  const result = await ops.create(unconfigured.ctx, { id: "missing-dir", title: "Missing", readmeFile: readme });
  assert.equal(result.ok, false); assert.match(result.text, /workDir/);
  assert.equal(existsSync(unconfigured.root), false); assert.deepEqual(unconfigured.calls(), []);
  const missingFlag = cli(w, ["new", "--id", "invalid-job", "--title", "Invalid", "--readme-file"]);
  assert.equal(missingFlag.status, 2); assert.match(missingFlag.stderr, /readme-file FILE/);
  const existingFolder = path.join(w.workDir, "existing-job"); mkdirSync(existingFolder, { recursive: true });
  writeFileSync(path.join(existingFolder, "README.md"), "keep this\n");
  const existing = cli(w, ["new", "--id", "existing-job", "--title", "Existing", "--readme-file", readme, "--no-wait"]);
  assert.equal(existing.status, 1); assert.match(existing.stdout, /目录.*已存在/);
  assert.equal(readFileSync(path.join(existingFolder, "README.md"), "utf8"), "keep this\n");
  assert.equal(existsSync(path.join(w.root, "existing-job")), false); assert.deepEqual(w.calls(), []);
});

test("initial README setup failure rolls back the workspace, plan and active document listing", () => {
  const w = stored(); const file = path.join(w.dir, "initial.md"); writeFileSync(file, "# Initial\n");
  const made = cli(w, ["new", "--id", "failed-job", "--title", "Failed", "--link", "gcp:failed", "--readme-file", file, "--no-wait"], { FAKE_PASEO_FAIL: "schedule create" });
  assert.equal(made.status, 1, made.stdout + made.stderr);
  assert.match(made.stdout, /没建成/);
  assert.equal(load(w.root, "failed-job").status, "stopped");
  assert.equal(existsSync(path.join(w.workDir, "failed-job")), false);
  assert.doesNotMatch(readFileSync(path.join(w.workDir, "INDEX.md"), "utf8"), /failed-job/);
  assert.equal(w.paseo().workspaces[0].archived, true);
  assert.deepEqual(w.paseo().schedules, []);
});

test("CLI initial README commit and push failures report partial success with recoverable files and id", () => {
  for (const failure of ["commit", "push"]) {
    const w = stored(); const file = path.join(w.dir, "initial.md"); writeFileSync(file, "# Recoverable\n");
    const head = git(w.docs, "rev-parse", "HEAD");
    if (failure === "commit") writeFileSync(path.join(w.docs, ".git/hooks/pre-commit"), "#!/bin/sh\necho commit-denied >&2\nexit 1\n", { mode: 0o755 });
    else git(w.docs, "remote", "set-url", "origin", path.join(w.dir, "unavailable.git"));
    const made = cli(w, ["new", "--id", "partial-job", "--title", "Partial", "--readme-file", file, "--no-wait"]);
    assert.equal(made.status, 1, made.stdout + made.stderr);
    const result = JSON.parse(made.stdout);
    assert.deepEqual([result.ok, result.partial, result.created, result.saved, result.id], [false, true, true, false, "partial-job"]);
    assert.match(result.text, /已创建.*保存或推送未完成/);
    assert.match(result.text, failure === "commit" ? /commit-denied/ : /没推上去/);
    assert.equal(load(w.root, "partial-job").status, "watching");
    assert.equal(w.paseo().workspaces.length, 1);
    assert.equal(readFileSync(path.join(w.workDir, "partial-job/README.md"), "utf8"), "# Recoverable\n");
    assert.equal(git(w.docs, "rev-parse", "HEAD") === head, failure === "commit");
    assert.equal(git(w.bare, "rev-parse", "HEAD"), head);
  }
});
