import type { UsageReport } from "@getpaseo/plugin/server";
import { windowState, type Snapshot } from "../shared/snapshot";

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
    const selected = snapshot.pools
      .filter((pool) => pool.platform === platform)
      .flatMap((pool) => pool.accounts)
      .filter((account) => account.state !== "unknown")
      .map((account) => ({
        account,
        windows: (["5h", "week"] as const).flatMap((id) => {
          const window = account.windows.find(
            (window) =>
              window.id === id &&
              ["current", "older"].includes(windowState(account, window, snapshot.serverTime)),
          );
          return window ? [window] : [];
        }),
      }))
      .filter((entry) => entry.windows.length > 0)
      // Select one account across both windows; never combine independent maxima.
      .sort(
        (a, b) =>
          Math.max(...b.windows.map((window) => window.usedPct!)) -
            Math.max(...a.windows.map((window) => window.usedPct!)) ||
          a.account.alias.localeCompare(b.account.alias),
      )[0];
    return (selected?.windows ?? []).map((window) => {
      const untilReset = window.resetsAt
        ? Date.parse(window.resetsAt) - Date.parse(snapshot.serverTime)
        : null;
      const warning =
        window.usedPct! >= 90 && untilReset !== null && untilReset > 0 && untilReset <= 30 * 60000;
      return {
        id: `${platform}-tightest-${window.id}`,
        label: `${platform === "claude" ? "Claude" : "Codex"} ${window.id === "5h" ? "5小时" : "本周"}`,
        usedPct: window.usedPct,
        remainingPct: Math.max(0, 100 - window.usedPct!),
        ...(warning ? { resetsAt: window.resetsAt } : {}),
        tone: warning
          ? ("warning" as const)
          : selected!.account.stale
            ? ("default" as const)
            : ("ok" as const),
      };
    });
  });
  return {
    status: "available",
    windows,
    balances: [{ id: "daily", label: "今日费用", used: snapshot.key.daily.used, unit: "usd" }],
    details: [],
  };
}
