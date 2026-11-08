import { z } from "zod";
const time = z.iso.datetime({ offset: true }).nullable();
const number = z.number().finite().nonnegative().nullable();
const quota = z.object({ used: number, limit: number, resetsAt: time });
const pair = z.object({ used: number, limit: number });
export const keyStatus = z.enum(["active", "expired", "disabled", "inactive"]);
export const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  serverTime: z.iso.datetime({ offset: true }),
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
// Team/free vary; unknown tiers and stale/missing windows prevent a pool estimate.
export const TIER_WEIGHTS = {
  max20: 20,
  max5: 5,
  pro: 1,
  plus: 1,
  team: 1,
  free: 0.2,
  unknown: null,
} as const;
export function estimate(pool: Pool, windowId = "5h"): number | null {
  if (!pool.accounts.length) return null;
  let used = 0;
  let total = 0;
  for (const account of pool.accounts) {
    const weight = TIER_WEIGHTS[account.tier];
    const pct = account.windows.find((window) => window.id === windowId)?.usedPct;
    if (
      weight === null ||
      pct == null ||
      account.stale ||
      account.state === "unknown" ||
      account.state === "unavailable"
    )
      return null;
    used += weight * pct;
    total += weight;
  }
  return used / total;
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
