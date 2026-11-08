import type { UsageReport } from "@getpaseo/plugin/server";
import { estimate, type Snapshot } from "../shared/snapshot";

export function shortUsageError(error: string): string {
  if (error.includes("过期")) return "Key 已过期";
  if (error.includes("禁用")) return "Key 已禁用";
  if (error.includes("Key 无效")) return "Key 无效";
  if (error.includes("激活")) return "Key 未激活";
  if (error.includes("超时")) return "CRS 请求超时";
  if (error.includes("限流")) return "CRS 请求限流";
  if (error.includes("HTTPS")) return "CRS HTTPS异常";
  if (error.includes("配置") || error.includes("凭据")) return "CRS 配置已变更";
  if (error.includes("格式") || error.includes("数据缺失")) return "CRS 数据异常";
  if (error.includes("拒绝")) return "CRS 拒绝访问";
  return "CRS 暂时不可用";
}

export function mapUsage(snapshot: Snapshot): UsageReport {
  if (snapshot.key.status !== "active")
    return {
      status: "error",
      error: shortUsageError(
        { expired: "Key 过期", disabled: "Key 禁用", inactive: "Key 未激活" }[snapshot.key.status],
      ),
    };
  const windows = (["claude", "openai"] as const).flatMap((platform) => {
    const accounts = snapshot.pools
      .filter((pool) => pool.platform === platform)
      .flatMap((pool) => pool.accounts);
    return (["5h", "week"] as const).flatMap((id) => {
      const summary = estimate({ accounts }, snapshot.serverTime, id);
      if (summary.usedPct === null) return [];
      return [
        {
          id: `${platform}-pool-${id}`,
          label: `${platform === "claude" ? "Claude" : "Codex"} ${id === "5h" ? "5小时" : "本周"} · ${summary.included}/${summary.total} 可用`,
          usedPct: summary.usedPct,
          remainingPct: Math.max(0, 100 - summary.usedPct),
          tone:
            summary.usedPct >= 90
              ? ("warning" as const)
              : summary.older
                ? ("default" as const)
                : ("ok" as const),
        },
      ];
    });
  });
  return {
    status: "available",
    windows,
    balances: [{ id: "daily", label: "今日费用", used: snapshot.key.daily.used, unit: "usd" }],
    details: [],
  };
}
