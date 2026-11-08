import { openExternalUrl, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { panelRpc, type PanelEntry } from "../shared/rpc";
import { estimate, TIER_WEIGHTS, windowLabel, windowState, type Pool } from "../shared/snapshot";

type Theme = PluginScreenProps["theme"];
type Mode = "used" | "remaining";
const stamp = (value: string | null) => (value ? new Date(value).toLocaleString() : "未知");
function reset(value: string | null) {
  if (!value) return "重置时间未知";
  const mins = Math.ceil((Date.parse(value) - Date.now()) / 60000);
  if (mins <= 0) return "等待窗口更新";
  if (mins < 1440) return `${Math.floor(mins / 60)} 小时 ${mins % 60} 分后重置`;
  return `${stamp(value)} 重置`;
}
function color(pct: number | null, theme: Theme) {
  return pct === null
    ? theme.colors.foregroundMuted
    : pct >= 90
      ? theme.colors.statusDanger
      : pct >= 70
        ? theme.colors.statusWarning
        : theme.colors.accent;
}
function Bar({
  pct,
  used,
  theme,
  tall = false,
}: {
  pct: number | null;
  used: number | null;
  theme: Theme;
  tall?: boolean;
}) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={pct === null ? "数据缺失" : `${pct.toFixed(1)}%`}
      style={{
        height: tall ? 22 : 7,
        borderRadius: 4,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      {pct !== null && (
        <View
          style={{
            width: `${Math.min(100, Math.max(0, pct))}%`,
            height: "100%",
            backgroundColor: color(used, theme),
            borderRadius: 4,
          }}
        />
      )}
    </View>
  );
}
function Button({
  label,
  onPress,
  theme,
  selected = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  theme: Theme;
  selected?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 13,
        paddingVertical: 9,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: selected ? theme.colors.accentForeground : theme.colors.foreground,
          fontSize: 12,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
function PoolView({
  pool,
  mode,
  theme,
  compact,
  serverTime,
}: {
  pool: Pool;
  mode: Mode;
  theme: Theme;
  compact: boolean;
  serverTime: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const c = theme.colors;
  const summary = estimate(pool, serverTime);
  const used = summary.usedPct;
  const shown = used === null ? null : mode === "used" ? used : 100 - used;
  const binding = { fixed: "固定绑定", group: "分组", pool: "共享池", none: "未绑定" }[
    pool.bindingKind
  ];
  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderColor: c.border, paddingTop: 18 }}>
      <View
        style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 5 }}
      >
        <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
          {pool.platform === "claude" ? "Claude" : "Codex"} · {binding} · 5 小时
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {pool.accounts.length} 个账号
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>
          {shown === null
            ? "无法估算"
            : `约${mode === "used" ? "已用" : "剩余"} ${shown.toFixed(1)}%`}
        </Text>
        <Text
          style={{
            color: c.statusWarning,
            fontSize: 11,
            borderWidth: 1,
            borderColor: c.statusWarning,
            borderRadius: 9,
            paddingHorizontal: 7,
          }}
        >
          粗略折合 · 估算 · 纳入 {summary.included}/{summary.total} 个账号
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: 4 }}>
        {summary.accounts.map((account, index) => {
          const pct = account.windows.find((w) => w.id === "5h")?.usedPct ?? null;
          const value = pct === null ? null : mode === "used" ? pct : 100 - pct;
          return (
            <View
              key={`${account.alias}-${index}`}
              style={{ flex: TIER_WEIGHTS[account.tier] ?? 1, minWidth: 9 }}
            >
              <Bar pct={value} used={pct} theme={theme} tall />
            </View>
          );
        })}
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
        格宽 ≈ 纳入账号档位；过期、不可用、未知档位和缺失窗口不参与。估算不代表官方总额度。
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="展开或收起逐账号明细"
        onPress={() => setExpanded(!expanded)}
      >
        <Text style={{ color: c.accent, fontSize: 12 }}>{expanded ? "▾" : "▸"} 逐账号明细</Text>
      </Pressable>
      {expanded &&
        pool.accounts.map((account, index) =>
          account.state === "unavailable" ? (
            <View
              key={`${account.alias}-${index}`}
              style={{ paddingVertical: 12, borderTopWidth: 1, borderColor: c.border }}
            >
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {account.alias} · 不可用 · 未参与折合
              </Text>
            </View>
          ) : (
            <View
              key={`${account.alias}-${index}`}
              style={{
                flexDirection: compact ? "column" : "row",
                gap: 18,
                paddingVertical: 12,
                borderTopWidth: 1,
                borderColor: c.border,
              }}
            >
              <View style={{ width: compact ? undefined : 136, gap: 4 }}>
                <Text style={{ color: c.foreground, fontWeight: "600", fontSize: 13 }}>
                  {account.alias}
                </Text>
                <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
                  {account.tier} ·{" "}
                  {
                    {
                      normal: "正常",
                      rate_limited: "限流",
                      unavailable: "不可用",
                      unknown: "状态未知",
                    }[account.state]
                  }
                </Text>
                {account.limitedUntil && (
                  <Text style={{ color: c.statusWarning, fontSize: 11 }}>
                    恢复 {stamp(account.limitedUntil)}
                  </Text>
                )}
                {account.windows.some(
                  (window) => windowState(account, window, serverTime) === "expired",
                ) && (
                  <Text style={{ color: c.statusWarning, fontSize: 11 }}>
                    数据已过期（采集于 {stamp(account.observedAt)}）
                  </Text>
                )}
              </View>
              <View style={{ flex: 1, flexDirection: "row", gap: 18 }}>
                {(account.windows.length
                  ? account.windows
                  : [
                      { id: "5h", usedPct: null, resetsAt: null },
                      { id: "week", usedPct: null, resetsAt: null },
                    ]
                ).map((window) => {
                  const state = windowState(account, window, serverTime);
                  const pct = state === "current" ? window.usedPct : null;
                  const value = pct === null ? null : mode === "used" ? pct : 100 - pct;
                  return (
                    <View key={window.id} style={{ flex: 1, gap: 6 }}>
                      <View
                        style={{
                          flexDirection: "row",
                          justifyContent: "space-between",
                          flexWrap: "wrap",
                        }}
                      >
                        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                          {windowLabel(window.id)}
                        </Text>
                        <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>
                          {state === "expired"
                            ? "数据已过期"
                            : value === null
                              ? "数据缺失"
                              : `${value.toFixed(0)}%`}
                        </Text>
                      </View>
                      {value !== null && <Bar pct={value} used={pct} theme={theme} />}
                      {state === "current" && (
                        <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
                          {reset(window.resetsAt)}
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
              <Text
                style={{ color: c.foregroundMuted, fontSize: 10, width: compact ? undefined : 114 }}
              >
                采集 {stamp(account.observedAt)}
              </Text>
            </View>
          ),
        )}
      {!pool.accounts.length && (
        <Text style={{ color: c.foregroundMuted }}>账号数据缺失，暂不显示百分比</Text>
      )}
    </View>
  );
}
function Entry({
  entry,
  mode,
  theme,
  compact,
}: {
  entry: PanelEntry;
  mode: Mode;
  theme: Theme;
  compact: boolean;
}) {
  const c = theme.colors;
  const [linkError, setLinkError] = useState(false);
  const snapshot = entry.snapshot;
  const open = (url: string) => {
    setLinkError(false);
    void openExternalUrl(url).catch(() => setLinkError(true));
  };
  const limited = snapshot?.pools.some((p) => p.accounts.some((a) => a.state === "rate_limited"));
  const missing =
    snapshot?.errors.length ||
    snapshot?.pools.some(
      (p) =>
        !p.accounts.length ||
        p.accounts.some(
          (a) =>
            a.stale ||
            a.state === "unknown" ||
            a.state === "unavailable" ||
            a.windows.some((w) => windowState(a, w, snapshot!.serverTime) !== "current"),
        ),
    );
  const state = entry.error
    ? "连接或 Key 异常"
    : limited
      ? "部分账号限流"
      : missing
        ? "部分数据缺失"
        : "正常";
  return (
    <View
      style={{
        padding: compact ? 16 : 24,
        gap: 18,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: c.accent, fontSize: 20 }}>◈</Text>
        <Text style={{ color: c.foreground, flex: 1, fontSize: 17, fontWeight: "600" }}>
          CRS 中转
        </Text>
        <Text
          style={{
            color: entry.error
              ? c.statusDanger
              : limited || missing
                ? c.statusWarning
                : c.statusSuccess,
            fontSize: 12,
          }}
        >
          ● {state}
        </Text>
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {entry.providers.join(" · ")} 共用一把 Key
      </Text>
      {entry.error && (
        <View style={{ borderLeftWidth: 3, borderColor: c.statusDanger, paddingLeft: 12, gap: 5 }}>
          <Text style={{ color: c.statusDanger }}>{entry.error}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {snapshot ? `显示上次成功数据：${stamp(entry.successfulAt)}` : "尚无成功快照"} · 可重试{" "}
            {stamp(entry.retryAt)}
          </Text>
        </View>
      )}
      {snapshot && (
        <>
          <View style={{ flexDirection: "row", gap: 24 }}>
            {(["daily", "total"] as const).map((id) => {
              const quota = snapshot.key[id];
              const value =
                mode === "used" || quota.limit === null
                  ? quota.used
                  : quota.used === null || quota.limit === null
                    ? null
                    : Math.max(0, quota.limit - quota.used);
              const used =
                quota.used === null || quota.limit === null || quota.limit <= 0
                  ? null
                  : (quota.used / quota.limit) * 100;
              return (
                <View key={id} style={{ flex: 1, gap: 7 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    {id === "daily" ? "今日费用" : "总费用"} ·{" "}
                    {mode === "used" || quota.limit === null ? "已用" : "剩余"}
                  </Text>
                  <Text
                    style={{ color: c.foreground, fontSize: compact ? 23 : 29, fontWeight: "600" }}
                  >
                    {value === null ? "未知" : `$${value.toFixed(2)}`}
                  </Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
                    {quota.limit === null ? "无上限" : `上限 $${quota.limit.toFixed(2)}`} · USD
                  </Text>
                  {used !== null && (
                    <Bar
                      pct={used === null ? null : mode === "used" ? used : 100 - used}
                      used={used}
                      theme={theme}
                    />
                  )}
                  <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
                    {reset(quota.resetsAt)}
                  </Text>
                  {quota.limit !== null && quota.used !== null && quota.used >= quota.limit && (
                    <Text style={{ color: c.statusDanger, fontSize: 12 }}>Key 此项额度已耗尽</Text>
                  )}
                </View>
              );
            })}
          </View>
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
            Key 到期：{stamp(snapshot.key.expiresAt)} · CRS 倍率后费用
          </Text>
          {snapshot.pools.map((pool, index) => (
            <PoolView
              key={`${pool.platform}-${index}`}
              pool={pool}
              mode={mode}
              theme={theme}
              compact={compact}
              serverTime={snapshot.serverTime}
            />
          ))}
          {!snapshot.pools.length && (
            <Text style={{ color: c.foregroundMuted }}>共享账号窗口缺失，Key 用量不受影响。</Text>
          )}
          {!!snapshot.errors.length && (
            <Text style={{ color: c.statusWarning, fontSize: 12 }}>
              {snapshot.errors.length} 项数据未能取得，缺失数据不按 0 计算。
            </Text>
          )}
        </>
      )}
      <View style={{ borderTopWidth: 1, borderColor: c.border, paddingTop: 16, gap: 10 }}>
        <Text style={{ color: c.foreground, fontWeight: "600" }}>CRS 网页管理</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 9 }}>
          <Button
            label="查看用量 / 兑换续费卡 ↗"
            theme={theme}
            onPress={() => open(entry.links.usage)}
          />
          {entry.links.keys && (
            <Button
              label="管理 Key 限额与到期 ↗"
              theme={theme}
              onPress={() => open(entry.links.keys!)}
            />
          )}
          {entry.links.accounts && (
            <Button
              label="管理共享账号 ↗"
              theme={theme}
              onPress={() => open(entry.links.accounts!)}
            />
          )}
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
          网页按自身登录权限操作。{!entry.links.keys ? "管理入口需在插件设置中填写 SPA 前缀。" : ""}
        </Text>
        {linkError && <Text style={{ color: c.statusDanger }}>浏览器打开失败，请重试</Text>}
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
        成功获取 {stamp(entry.successfulAt)} · 账号窗口由共享使用者共同消耗，当前会话账号未知。
      </Text>
    </View>
  );
}
export function UsageScreen({ theme, layout }: PluginScreenProps) {
  const [mode, setMode] = useState<Mode>("used");
  const load = useRpc(panelRpc);
  const query = useQuery({
    queryKey: ["crs-panel"],
    queryFn: () => load({}),
    retry: false,
  });
  const c = theme.colors;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 28, gap: 20 }}
    >
      <View style={{ width: "100%", maxWidth: 1060, alignSelf: "center", gap: 18 }}>
        <Text style={{ color: c.foreground, fontSize: 24, fontWeight: "600" }}>CRS 用量与管理</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          Key 费用与共享账号窗口 · 已用视图默认 · 按需读取与手动刷新
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button
            label="已用"
            theme={theme}
            selected={mode === "used"}
            onPress={() => setMode("used")}
          />
          <Button
            label="剩余"
            theme={theme}
            selected={mode === "remaining"}
            onPress={() => setMode("remaining")}
          />
          <Button
            label={query.isFetching ? "刷新中…" : "刷新"}
            theme={theme}
            disabled={query.isFetching}
            onPress={() => {
              void query.refetch();
            }}
          />
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
          手动刷新遵守 12 秒最短间隔；失败时退避，服务恢复后可重试。
        </Text>
        {query.isError && (
          <Text style={{ color: c.statusDanger }}>无法读取 CRS 面板，请检查插件或主机连接。</Text>
        )}
        {query.isPending && <Text style={{ color: c.foregroundMuted }}>正在读取 CRS 快照…</Text>}
        {query.data?.length === 0 && (
          <Text style={{ color: c.foregroundMuted }}>
            未发现 CRS。自动检查主机 Pi、Claude Code 和 Codex 配置；非 CRS 服务不会显示。
          </Text>
        )}
        {query.data?.map((entry) => (
          <Entry key={entry.id} entry={entry} mode={mode} theme={theme} compact={layout.compact} />
        ))}
      </View>
    </ScrollView>
  );
}
