import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { append, load } from "./log.mjs";
import { budgetGate, costIncrement } from "./drive.mjs";
import { callerInfo, resolve } from "./ops.mjs";
import { json } from "./paseo.mjs";
import { createWorkspace } from "./workspace.mjs";
import { roleOf } from "./schedule.mjs";

export async function dispatch(ctx, ref, { contract, provider, thinking, mode, title, cwd } = {}) {
  const r = resolve(ctx, ref);
  if (!r.s) return { ok: false, text: r.text };
  const s = r.s;
  const caller = await callerInfo(ctx);
  if (caller.by !== "chat" || caller.chatFor !== s.id || process.env.PASEO_AGENT_ID !== s.chatId) return { ok: false, text: "只有这件事当前的主对话能派活。" };
  if (s.status !== "watching" || s.held) return { ok: false, text: "这件事已停下，不能派活。" };
  const blocked = budgetGate(ctx, s);
  if (blocked) return { ok: false, text: blocked };
  const file = contract && path.resolve(contract);
  if (!file || !existsSync(file) || !statSync(file).isFile()) return { ok: false, text: "先写好派活说明，再用 --contract 指向那个文件。" };
  const readme = ctx.policy.workDir && path.join(ctx.policy.workDir, s.id, "README.md");
  if (!readme || !existsSync(readme)) return { ok: false, text: "先配置事项文档目录并写好这件事的 README。" };
  if (!provider) {
    const role = roleOf(ctx.policy, ctx.policy.drive?.role || s.roleName || undefined);
    provider = role.provider;
    thinking ??= role.thinking;
    mode ??= role.mode;
  }
  let workspaceId = s.workspaceId;
  try {
    if (cwd) workspaceId = await createWorkspace(ctx.run, { projectId: s.projectId, workdir: path.resolve(cwd), title: title || s.title });
    // Placement is explicit: an agent-scoped CLI otherwise inherits its caller's workspace and ignores cwd.
    const made = await json(ctx.run, ["run", "--workspace", workspaceId, "--no-wait", "--provider", provider, ...(thinking ? ["--thinking", thinking] : []), ...(mode ? ["--mode", mode] : []), "--title", title || `${s.title}：执行`, "--label", `affairs.affair=${s.id}`, "--label", "affairs.role=dispatched", `先完整读派活说明 ${file}，再读这件事的 README ${readme}，照说明做。`]);
    const agentId = made.agentId;
    if (!agentId) throw new Error("Paseo 没有返回会话编号");
    append(ctx.root, s.id, [{ kind: "dispatched", agentId, contract: file, model: provider, workspaceId }], { now: ctx.now(), tz: ctx.policy.tz });
    return { ok: true, agentId, text: `${agentId}\n已派出，按派活说明执行。` };
  } catch (error) {
    return { ok: false, text: `没派成：${error.message}` };
  }
}

/** Read cumulative usage, including changes missed while the plugin was stopped. An idle status is never a hand-in. */
export async function dispatchCosts(ctx, id, paseo) {
  const s = load(ctx.root, id, ctx.policy);
  for (const d of s.dispatched) {
    const seen = (await paseo.agents.ref(d.agentId).refresh())?.agent;
    if (!seen) throw new Error(`派出的会话读不到：${d.agentId}`);
    const cost = costIncrement(seen.lastUsage, d.usdTotal);
    if (cost.usdTotal !== d.usdTotal || cost.unknown !== d.unknown) append(ctx.root, id, [{ kind: "dispatch.cost", agentId: d.agentId, ...cost }], { now: ctx.now(), tz: ctx.policy.tz });
  }
}
