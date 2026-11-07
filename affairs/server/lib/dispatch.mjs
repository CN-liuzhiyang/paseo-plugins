import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { append, ID, isOpen, load, read } from "./log.mjs";
import { budgetGate, costIncrement } from "./drive.mjs";
import { modeOf } from "./mode.mjs";
import { callerInfo, resolve } from "./ops.mjs";
import { directoryWorkspace, samePath } from "./workspace.mjs";
import { roleOf } from "./schedule.mjs";

export async function dispatch(ctx, ref, { contract, provider, thinking, mode, title, cwd } = {}) {
  const r = resolve(ctx, ref);
  if (!r.s) return { ok: false, text: r.text };
  const s = r.s;
  const caller = await callerInfo(ctx);
  if (caller.by !== "chat" || caller.chatFor !== s.id || process.env.PASEO_AGENT_ID !== s.chatId) return { ok: false, text: "只有这件事当前的主对话能派活。" };
  if (s.status !== "watching" || s.held) return { ok: false, text: "这件事已停下，不能派活。" };
  if (modeOf(s, ctx.policy) !== "drive") return { ok: false, text: "只有我来推的事才能派活。" };
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
    if (cwd && (!s.workdir || !samePath(cwd, s.workdir))) workspaceId = await directoryWorkspace(ctx.run, path.resolve(cwd), title || s.title);
    const createAgent = { workspaceId, title: `${s.title}：${title || "执行"}`, provider, settings: { ...(thinking ? { thinkingOptionId: thinking } : {}), ...(mode ? { modeId: mode } : {}) }, labels: { "affairs.affair": s.id, "affairs.role": "dispatched" }, initialPrompt: `先完整读派活说明 ${file}，再读这件事的 README ${readme}，照说明做。`, notifyOnFinish: true };
    append(ctx.root, s.id, [{ kind: "dispatch.approved", contract: file, model: provider, workspaceId }], { now: ctx.now(), tz: ctx.policy.tz });
    return { ok: true, createAgent, text: `已核对额度。请在当前主对话调用 Paseo MCP 的 create_agent，参数如下：\n${JSON.stringify(createAgent, null, 2)}` };
  } catch (error) {
    return { ok: false, text: `没派成：${error.message}` };
  }
}

/** Only creation is gated: an existing worker must be able to resume and hand in after its budget runs out. */
export function dispatchOpen(ctx, request) {
  const id = request.labels["affairs.affair"];
  if (request.reason !== "create" || !id) return request;
  if (!ctx) throw new Error("事项还没准备好，请稍后再派活。");
  if (!ID.test(id)) throw new Error("派活的事项编号不对，请核对。");
  const s = { ...load(ctx.root, id, ctx.policy), lines: read(ctx.root, id) };
  if (!s.id || modeOf(s, ctx.policy) !== "drive") throw new Error("只有我来推的事才能创建派出的会话。");
  if (!isOpen(s) || s.held) throw new Error("这件事已停下，先请他同意接着推。");
  const blocked = budgetGate(ctx, s);
  if (blocked) throw new Error(blocked);
  return request;
}

/** Read cumulative usage, including changes missed while the plugin was stopped. An idle status is never a hand-in. */
export async function dispatchCosts(ctx, id, paseo, { charge = true } = {}) {
  const s = load(ctx.root, id, ctx.policy);
  const sessions = new Map();
  let cursor;
  do {
    const listed = await paseo.agents.list({ filter: { labels: { "affairs.affair": id }, includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const listedEntry of listed.entries) {
      const { agent } = listedEntry;
      if (agent.labels?.["affairs.affair"] !== id) continue;
      sessions.set(agent.id, listedEntry);
      if (!charge || agent.id === s.chatId || agent.labels["affairs.chat"] || s.dispatched.some((d) => d.agentId === agent.id)) continue;
      const model = agent.model ? `${agent.provider}/${agent.model}` : agent.provider;
      const approved = read(ctx.root, id).findLast((l) => l.kind === "dispatch.approved" && l.workspaceId === agent.workspaceId && l.model === model);
      const entry = { kind: "dispatched", agentId: agent.id, model, workspaceId: agent.workspaceId, ...(approved ? { contract: approved.contract } : {}) };
      append(ctx.root, id, [entry], { now: ctx.now(), tz: ctx.policy.tz });
      s.dispatched.push({ ...entry, usdTotal: null, unknown: true });
    }
    cursor = listed.pageInfo?.nextCursor;
  } while (cursor);
  for (const agentId of new Set([...sessions.keys(), ...(charge ? s.dispatched.map((d) => d.agentId) : []), ...(s.chatId ? [s.chatId] : [])])) {
    const snapshot = await paseo.agents.ref(agentId).refresh();
    const seen = snapshot?.agent;
    const d = charge && s.dispatched.find((d) => d.agentId === agentId);
    if (seen) sessions.set(agentId, { ...sessions.get(agentId), ...snapshot, agent: { ...seen, id: agentId } });
    if (!d) continue;
    if (!seen) throw new Error(`派出的会话读不到：${d.agentId}`);
    const cost = costIncrement(seen.lastUsage, d.usdTotal);
    if (cost.usdTotal !== d.usdTotal || cost.unknown !== d.unknown) append(ctx.root, id, [{ kind: "dispatch.cost", agentId: d.agentId, ...cost }], { now: ctx.now(), tz: ctx.policy.tz });
  }
  return [...sessions.values()];
}
