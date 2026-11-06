import { modeOf } from "./mode.mjs";
import { localParts } from "./time.mjs";

export function spendOf(s, flowNow = new Map()) {
  const lines = s.lines ?? [];
  const chat = lines.filter((l) => l.kind === "chat.turn");
  const dispatched = lines.filter((l) => l.kind === "dispatch.cost");
  const flows = s.flows.filter((f) => !f.failed);
  const flowCost = (f) => f.costUsd ?? flowNow.get(f.runId)?.st?.costUsd;
  const unknown = new Set();
  for (const l of new Map(chat.map((l) => [l.agentId, l])).values()) {
    if (l.unknown === true || !Number.isFinite(l.usd)) unknown.add(l.agentId);
  }
  for (const d of s.dispatched ?? []) if (d.unknown) unknown.add(d.agentId);
  for (const f of flows) if (!Number.isFinite(flowCost(f))) unknown.add(`flow:${f.runId}`);
  return { usd: [...chat, ...dispatched].reduce((n, l) => n + (Number.isFinite(l.usd) ? l.usd : 0), 0) + flows.reduce((n, f) => n + (Number.isFinite(flowCost(f)) ? flowCost(f) : 0), 0), unknown: unknown.size };
}

export function budgetGate(ctx, s) {
  if (modeOf(s, ctx.policy) !== "drive") return "";
  if (s.held) return "这件事先停着了，先请他同意接着推。";
  if (!s.budget) return `要先请他批额度：affair ask ${s.id} --file <问题文件>。`;
  const spent = spendOf(s, ctx.flowNow);
  if (spent.usd >= s.budget.usd || (s.budget.until && localParts(ctx.now(), ctx.policy.tz).date > s.budget.until)) return `额度已用完或过期，要先请他加额度：affair ask ${s.id} --file <问题文件>。`;
  return "";
}

export function budgetText(ctx, s) {
  const spent = spendOf(s, ctx.flowNow);
  return `已花 $${spent.usd.toFixed(4)}${s.budget ? ` / 已批 $${s.budget.usd}${s.budget.until ? `（到 ${s.budget.until}）` : ""}` : "；尚未批准额度"}${spent.unknown ? `；另有 ${spent.unknown} 个会话花费不明` : ""}`;
}

export function budgetQuestion(ctx, s) {
  if (modeOf(s, ctx.policy) !== "drive" || !s.budget || spendOf(s, ctx.flowNow).usd < s.budget.usd * 0.8 || s.lines.some((l) => l.kind === "asked" && l.for === `budget:${s.budget.seq}`)) return null;
  const amount = Math.max(s.budget.usd * 2, 1);
  return { kind: "asked", id: `${s.id}-${s.asks.length + 1}`, for: `budget:${s.budget.seq}`, title: "这件事的额度快用完了", line: `${budgetText(ctx, s)}。推荐先停：请先核对剩余步骤和估算，再决定是否加额度。`, options: [`加到 $${amount}`, "先停"], recommend: "先停", why: "先核对剩余步骤和估算", push: true };
}

export function costIncrement(usage, before) {
  const total = usage?.totalCostUsd;
  const unknown = !Number.isFinite(total) || usage?.hasUnknownModelCost === true;
  return { usd: Number.isFinite(total) ? (total >= (before ?? 0) ? total - (before ?? 0) : total) : 0, usdTotal: Number.isFinite(total) ? total : before ?? null, unknown };
}
