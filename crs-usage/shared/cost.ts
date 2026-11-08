import { relativeReset, type Snapshot } from "./snapshot";
import { selectTokenDays, type TokenRange } from "./tokens";

export function rangeCost(snapshot: Snapshot, range: TokenRange) {
  const days = selectTokenDays(snapshot.tokenDays, range);
  if (!days.length || days.some((day) => day.cost === undefined))
    return range === 1 ? snapshot.key.daily.used : null;
  if (days.some((day) => day.cost === null)) return null;
  return days.reduce((sum, day) => sum + day.cost!, 0);
}
function percent(used: number | null, limit: number) {
  if (used === null) return null;
  return limit === 0 ? 100 : (used / limit) * 100;
}
export function costView(snapshot: Snapshot, range: TokenRange, mode: "used" | "remaining") {
  const used = rangeCost(snapshot, range);
  const dailyLimit = range === 1 ? snapshot.key.daily.limit : null;
  const remaining = mode === "remaining" && dailyLimit !== null;
  const total = snapshot.key.total;
  return {
    label: range === 1 ? "今日费用" : `${range} 天费用`,
    used,
    remaining,
    value: used === null ? null : remaining ? Math.max(0, dailyLimit! - used) : used,
    daily: dailyLimit === null ? null : { limit: dailyLimit, usedPct: percent(used, dailyLimit) },
    total:
      total.limit === null
        ? null
        : {
            limit: total.limit,
            usedPct: percent(total.used, total.limit),
            value:
              total.used === null
                ? null
                : mode === "remaining"
                  ? Math.max(0, total.limit - total.used)
                  : total.used,
          },
  };
}
export function totalQuotaTime(
  resetsAt: string | null,
  expiresAt: string | null,
  now = Date.now(),
) {
  if (expiresAt && (!resetsAt || Date.parse(expiresAt) <= Date.parse(resetsAt)))
    return relativeReset(expiresAt, now)
      .replace("后重置", "后到期")
      .replace("等待窗口更新", "已到期");
  return resetsAt ? relativeReset(resetsAt, now) : null;
}
