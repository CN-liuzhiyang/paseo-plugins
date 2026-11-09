import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { dispatch } from "../server/lib/dispatch.mjs";
import { append } from "../server/lib/log.mjs";
import { world } from "./kit";

afterEach(() => { delete process.env.PASEO_AGENT_ID; });
test("dispatch keeps the affair directory, reuses external workspaces and lets Paseo place new directories", async () => {
  const w = world({ policy: { workDir: undefined } });
  w.ctx.policy.workDir = path.join(w.dir, "docs");
  const id = "placement", workdir = path.join(w.dir, "A"), cwd = path.join(w.dir, "B");
  mkdirSync(path.join(w.ctx.policy.workDir, id), { recursive: true });
  writeFileSync(path.join(w.ctx.policy.workDir, id, "README.md"), "Steps");
  const contract = path.join(w.dir, "card-reset-shot.md");writeFileSync(contract, "Task");
  append(w.root, id, [{ kind: "created", id, title: "改进工具", workdir }, { kind: "workspace", workspaceId: "headquarters", projectId: "affairs" }, { kind: "chat", agentId: "main" }, { kind: "budget", usd: 1 }]);
  process.env.PASEO_AGENT_ID = "main";
  const calls: string[][] = [];let existing = false;
  w.ctx.by = "chat";w.ctx.chatFor = id;
  w.ctx.run = async (args: string[]) => {
    calls.push(args);
    const value = args[1] === "ls" ? (existing ? [{ workspaceId: "external", cwd }] : []) : { workspaceId: "external" };
    return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
  };
  for (const dir of [undefined, workdir, path.join(workdir, ".")]) {
    const r = await dispatch(w.ctx, id, { contract, provider: "claude/example", title: "执行", cwd: dir });
    assert.ok(r.ok, r.text);assert.equal(r.createAgent!.workspaceId, "headquarters");
    assert.equal(r.createAgent!.title, "改进工具：执行");
  }
  assert.equal(calls.length, 0);
  const made = await dispatch(w.ctx, id, { contract, provider: "claude/example", cwd });
  assert.ok(made.ok, made.text);assert.equal(made.createAgent!.workspaceId, "external");assert.equal(made.createAgent!.title, "改进工具：card-reset-shot");
  const create = calls.find((a) => a[1] === "create")!;
  assert.ok(create);assert.ok(!create.includes("--project"));assert.equal(create[create.indexOf("--path") + 1], cwd);
  assert.equal(create[create.indexOf("--isolation") + 1], "local");
  existing = true;calls.length = 0;
  const reused = await dispatch(w.ctx, id, { contract, provider: "claude/example", title: "检查", cwd });
  assert.equal(reused.createAgent!.workspaceId, "external");assert.equal(reused.createAgent!.title, "改进工具：检查");
  assert.deepEqual(calls.map((a) => a.slice(0, 2)), [["workspace", "ls"]]);
  assert.deepEqual(JSON.parse(reused.text!.slice(reused.text!.indexOf("{"))), reused.createAgent);
  assert.deepEqual(reused.createAgent!.labels, { "affairs.affair": id, "affairs.role": "dispatched" });
});
