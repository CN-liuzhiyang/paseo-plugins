import type { UsageReport } from "@getpaseo/plugin/server";
import { compactReset, estimate, type Snapshot } from "../shared/snapshot";

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
  const names = { claude: "Claude", openai: "Codex" } as const;
  const now = Date.parse(snapshot.serverTime);
  const reports = (["claude", "openai"] as const).map((platform) => {
    const accounts = snapshot.pools
      .filter((pool) => pool.platform === platform)
      .flatMap((pool) => pool.accounts);
    const summaries = (["5h", "week"] as const).flatMap((id) => {
      const summary = estimate({ accounts }, snapshot.serverTime, id);
      return summary.usedPct === null ? [] : [{ id, summary }];
    });
    return { platform, summaries };
  });
  const windows = reports.flatMap(({ platform, summaries }) =>
    summaries.map(({ id, summary }) => ({
      id: `${platform}-pool-${id}`,
      // The pool's earliest account reset, to the minute, as of the snapshot time.
      label: `${names[platform]} ${id === "5h" ? "5小时" : "本周"}${summary.resetsAt ? ` (${compactReset(summary.resetsAt, now)}后重置)` : ""}`,
      usedPct: summary.usedPct!,
      remainingPct: Math.max(0, 100 - summary.usedPct!),
      tone:
        summary.usedPct! >= 90
          ? ("warning" as const)
          : summary.older
            ? ("default" as const)
            : ("ok" as const),
    })),
  );
  // One detail row says how many accounts each platform's estimate counts (its first window's count).
  const details = [
    ...(windows.length
      ? [
          {
            id: "accounts",
            label: "可用账号",
            value: reports
              .filter(({ summaries }) => summaries.length)
              .map(
                ({ platform, summaries }) =>
                  `${names[platform]} ${summaries[0].summary.included}/${summaries[0].summary.total}`,
              )
              .join(" · "),
          },
        ]
      : []),
  ];
  return {
    status: "available",
    windows,
    balances: [{ id: "daily", label: "今日费用", used: snapshot.key.daily.used, unit: "usd" }],
    details,
  };
}
