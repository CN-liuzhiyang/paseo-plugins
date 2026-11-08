import { z } from "zod";
import { tokenDaysSchema } from "./tokens";
const time = z.iso.datetime({ offset: true }).nullable();
const number = z.number().finite().nonnegative().nullable();
const quota = z.object({ used: number, limit: number, resetsAt: time });
const pair = z.object({ used: number, limit: number });
export const keyStatus = z.enum(["active", "expired", "disabled", "inactive"]);
export const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  serverTime: z.iso.datetime({ offset: true }),
  // Optional telemetry must never break the existing quota card on older or partial servers.
  tokenDays: tokenDaysSchema.nullish().catch(undefined),
  key: z.object({
    status: keyStatus,
    expiresAt: time,
    // The key name is unnecessary for identifying a local configuration.
    daily: quota,
    total: quota,
    weeklyOpus: quota,
    rateWindow: z.object({ requests: pair, cost: pair, tokens: pair, resetsAt: time }),
    usage: z.object({
      totalTokens: number,
      totalRequests: number,
      dailyTokens: number,
      dailyRequests: number,
    }),
  }),
  pools: z.array(
    z.object({
      platform: z.enum(["claude", "openai"]),
      bindingKind: z.enum(["fixed", "group", "pool", "none"]),
      accounts: z.array(
        z.object({
          alias: z.string().max(120),
          tier: z.enum(["max20", "max5", "pro", "plus", "team", "free", "unknown"]),
          state: z.enum(["normal", "rate_limited", "unavailable", "unknown"]),
          limitedUntil: time,
          windows: z.array(
            z.object({
              id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
              usedPct: number,
              resetsAt: time,
            }),
          ),
          observedAt: time,
          stale: z.boolean(),
          unavailableReason: z.string().max(240).nullable(),
        }),
      ),
    }),
  ),
  errors: z.array(z.object({ scope: z.string().max(120), code: z.string().max(120) })),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Pool = Snapshot["pools"][number];
export type Account = Pool["accounts"][number];
// Relative tier weights are estimates, not official token capacities.
// Team/free vary; reset windows count as unused, and exhausted windows keep their full weight.
export const TIER_WEIGHTS = {
  max20: 20,
  max5: 5,
  pro: 1,
  plus: 1,
  team: 1,
  free: 0.2,
  unknown: null,
} as const;
export type Window = Account["windows"][number];
export function windowState(account: Account, window: Window | undefined, serverTime: string) {
  if (account.state === "unavailable") return "unavailable";
  if (window?.usedPct == null) return "missing";
  if (window.resetsAt != null && Date.parse(window.resetsAt) <= Date.parse(serverTime))
    return "reset";
  return account.stale ? "older" : "current";
}
export function relativeCollection(value: string | null, now = Date.now()) {
  if (!value) return "采集时间未知";
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  if (minutes < 1) return "刚刚采集";
  if (minutes < 60) return `${minutes} 分钟前采集`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前采集`;
  return `${Math.floor(minutes / 1440)} 天前采集`;
}
export function relativeReset(value: string | null, now = Date.now()) {
  if (!value) return "重置时间未知";
  const remaining = Date.parse(value) - now;
  if (remaining <= 0) return "等待窗口更新";
  if (remaining < 60000) return "<1 分钟后重置";
  const minutes = Math.floor(remaining / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}后重置`;
  if (hours) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}后重置`;
  return `${minutes} 分钟后重置`;
}
export function estimateWindow(account: Account, serverTime: string, windowId: string) {
  if (account.state === "unavailable" || account.state === "unknown") return null;
  const window = account.windows.find((window) => window.id === windowId);
  const now = Date.parse(serverTime);
  if (window?.resetsAt && Date.parse(window.resetsAt) <= now)
    return { usedPct: 0, resetsAt: null, older: false };
  // Anthropic may omit 5h data once the weekly quota is exhausted.
  const week = account.windows.find((window) => window.id === "week");
  if (
    windowId === "5h" &&
    !window?.resetsAt &&
    week?.usedPct != null &&
    week.usedPct >= 100 &&
    (!week.resetsAt || Date.parse(week.resetsAt) > now)
  )
    return { usedPct: 100, resetsAt: week.resetsAt, older: account.stale };
  if (window?.usedPct == null) return null;
  return { usedPct: window.usedPct, resetsAt: window.resetsAt, older: account.stale };
}
export function estimate(pool: Pick<Pool, "accounts">, serverTime: string, windowId = "5h") {
  let used = 0;
  let total = 0;
  const windows: Array<NonNullable<ReturnType<typeof estimateWindow>> & { account: Account }> = [];
  for (const account of pool.accounts) {
    const weight = TIER_WEIGHTS[account.tier];
    const window = estimateWindow(account, serverTime, windowId);
    if (weight === null || window === null) continue;
    windows.push({ account, ...window });
    used += weight * window.usedPct;
    total += weight;
  }
  const resets = windows.flatMap((window) => (window.resetsAt ? [window.resetsAt] : []));
  return {
    usedPct: total ? used / total : null,
    included: windows.length,
    total: pool.accounts.length,
    older: windows.filter((window) => window.older).length,
    resetsAt: resets.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
    accounts: windows.map((window) => window.account),
    windows,
  };
}
export const WINDOW_LABELS = { "5h": "5 小时", week: "本周", week_opus: "本周 Opus" } as const;
export function windowLabel(id: string): string {
  return (
    WINDOW_LABELS[id as keyof typeof WINDOW_LABELS] ??
    (id === "primary"
      ? "主窗口（时长未知）"
      : id === "secondary"
        ? "次窗口（时长未知）"
        : "窗口（时长未知）")
  );
}
