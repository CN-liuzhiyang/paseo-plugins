import type { UsageReport } from "@getpaseo/plugin/server";
import { hashAccountKey } from "@getpaseo/plugin/server/usage";
import { estimate, windowLabel, windowState, type Snapshot } from "../shared/snapshot";
export function mapUsage(snapshot: Snapshot, providers: string[]): UsageReport {
  if (snapshot.key.status !== "active")
    return { status: "error", error: `API Key 状态：${snapshot.key.status}` };
  const windows = snapshot.pools.flatMap((pool) =>
    pool.accounts
      .filter((account) => account.state !== "unavailable")
      .flatMap((account) =>
        account.windows
          .filter((window) => windowState(account, window, snapshot.serverTime) !== "expired")
          .map((window) => {
            const state = windowState(account, window, snapshot.serverTime);
            const usedPct = state === "current" ? window.usedPct : null;
            return {
              id: `${pool.platform}-${hashAccountKey(account.alias).slice(0, 16)}-${window.id}`,
              label: `${pool.platform === "claude" ? "Claude" : "Codex"} · ${account.alias} · ${windowLabel(window.id)}`,
              usedPct,
              remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
              resetsAt: window.resetsAt,
              tone:
                account.state === "rate_limited" || account.state === "unavailable"
                  ? ("danger" as const)
                  : account.stale
                    ? ("warning" as const)
                    : ("default" as const),
            };
          }),
      ),
  );
  const balances = (["daily", "total", "weeklyOpus"] as const).map((id) => ({
    id,
    label: `${id === "daily" ? "Key 今日费用" : id === "total" ? "Key 总费用" : "Key 本周 Opus 费用"}${snapshot.key[id].limit === null ? " · 无上限" : ""}`,
    ...snapshot.key[id],
    unit: "usd" as const,
    remaining:
      snapshot.key[id].limit === null || snapshot.key[id].used === null
        ? null
        : Math.max(0, snapshot.key[id].limit - snapshot.key[id].used),
  }));
  const details = [
    { id: "providers", label: "覆盖配置", value: providers.join(" · ") },
    { id: "expires", label: "Key 到期", value: snapshot.key.expiresAt ?? "未提供到期时间" },
    { id: "sharing", label: "共享提示", value: "账号窗口包含其他使用者消耗；当前会话账号未知" },
    ...snapshot.pools.flatMap((pool, p) => {
      const summary = estimate(pool, snapshot.serverTime);
      return [
        {
          id: `estimate-${p}`,
          label: `${pool.platform} · 5 小时粗略折合`,
          value:
            summary.usedPct === null
              ? `无法估算（纳入 0/${pool.accounts.length} 个账号）`
              : `约已用 ${summary.usedPct.toFixed(1)}%（估算，纳入 ${summary.included}/${pool.accounts.length} 个账号，非官方总额度）`,
        },
        ...pool.accounts.map((account, a) => ({
          id: `account-${p}-${a}`,
          label: account.alias,
          value: `${account.state === "rate_limited" ? "限流" : account.state === "unavailable" ? "不可用" : account.state === "unknown" ? "状态未知" : "正常"}${account.limitedUntil ? ` · 恢复 ${account.limitedUntil}` : ""}${account.windows.some((window) => windowState(account, window, snapshot.serverTime) === "expired") ? " · 数据已过期" : ""}（采集于 ${account.observedAt ?? "未知"}）`,
        })),
      ];
    }),
    ...(snapshot.errors.length
      ? [{ id: "partial", label: "数据缺失", value: `${snapshot.errors.length} 项数据未能取得` }]
      : []),
  ];
  return { status: "available", planLabel: "CRS Key · 共享账号快照", windows, balances, details };
}
