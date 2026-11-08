import { openExternalUrl, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { panelRpc, type PanelEntry } from "../shared/rpc";
import type { TokenRange } from "../shared/tokens";
import { costView, totalQuotaTime } from "../shared/cost";
import { TokenUsage } from "./token-usage";
import { AccountTitle } from "./account-title";
import {
  estimate,
  relativeCollection,
  relativeReset,
  TIER_WEIGHTS,
  windowLabel,
  windowState,
  type Pool,
} from "../shared/snapshot";

type Theme = PluginScreenProps["theme"];
type Mode = "used" | "remaining";
const stamp = (value: string | null) => (value ? new Date(value).toLocaleString() : "未知");
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
  muted = false,
  thin = false,
}: {
  pct: number | null;
  used: number | null;
  theme: Theme;
  tall?: boolean;
  muted?: boolean;
  thin?: boolean;
}) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={pct === null ? "数据缺失" : `${pct.toFixed(1)}%`}
      style={{
        height: tall ? 22 : thin ? 4 : 7,
        borderRadius: 4,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
        opacity: muted ? 0.5 : 1,
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
      aria-selected={selected}
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
  const [expanded, setExpanded] = useState(false);
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
          {summary.included}/{summary.total} 可用
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>
          {shown === null
            ? "无法估算"
            : `约${mode === "used" ? "已用" : "剩余"} ${shown.toFixed(1)}%`}
        </Text>
        <Text
          accessibilityLabel={`估算，纳入 ${summary.included}/${summary.total} 个账号${summary.older ? `，含 ${summary.older} 个较旧数据` : ""}`}
          style={{
            color: c.statusWarning,
            fontSize: 11,
            borderWidth: 1,
            borderColor: c.statusWarning,
            borderRadius: 9,
            paddingHorizontal: 7,
          }}
        >
          估算
        </Text>
        {!!summary.older && (
          <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
            含 {summary.older} 个较旧数据
          </Text>
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 4 }}>
        {summary.windows.map(({ account, usedPct: pct, older }, index) => {
          const value = mode === "used" ? pct : 100 - pct;
          return (
            <View
              key={`${account.alias}-${index}`}
              style={{ flex: TIER_WEIGHTS[account.tier] ?? 1, minWidth: 9 }}
            >
              <Bar pct={value} used={pct} theme={theme} tall muted={older} />
            </View>
          );
        })}
      </View>
      {summary.resetsAt && (
        <Text
          accessibilityLabel={`最早重置于 ${stamp(summary.resetsAt)}`}
          style={{ color: c.foregroundMuted, fontSize: 10 }}
        >
          {relativeReset(summary.resetsAt)}
        </Text>
      )}
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
              style={{
                paddingVertical: 12,
                borderTopWidth: 1,
                borderColor: c.border,
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
              }}
            >
              <AccountTitle account={account} theme={theme} muted />
              <Text
                numberOfLines={1}
                style={{ color: c.foregroundMuted, fontSize: 12, flexShrink: 0 }}
              >
                · 不可用 · 未参与折合
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
              <View style={{ width: compact ? undefined : 180, minWidth: 0, gap: 4 }}>
                <View
                  style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}
                >
                  <AccountTitle account={account} theme={theme} />
                  <Text
                    accessibilityLabel={`采集于 ${stamp(account.observedAt)}`}
                    style={{ color: c.foregroundMuted, fontSize: 10 }}
                  >
                    {account.windows.some(
                      (window) => windowState(account, window, serverTime) === "older",
                    )
                      ? "较旧 · "
                      : ""}
                    {relativeCollection(account.observedAt)}
                  </Text>
                </View>
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
              </View>
              <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 18 }}>
                {account.windows
                  .filter((window) => window.usedPct !== null)
                  .map((window) => {
                    const state = windowState(account, window, serverTime);
                    const pct = state === "current" || state === "older" ? window.usedPct : null;
                    const value = pct === null ? null : mode === "used" ? pct : 100 - pct;
                    return (
                      <View
                        key={window.id}
                        style={{ flex: 1, minWidth: compact ? 125 : 120, gap: 6 }}
                      >
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
                          <Text
                            style={{
                              color: state === "older" ? c.foregroundMuted : c.foreground,
                              fontSize: 12,
                              fontWeight: "600",
                            }}
                          >
                            {state === "reset"
                              ? "窗口已重置，等待新数据"
                              : value === null
                                ? "数据缺失"
                                : `${value.toFixed(0)}%`}
                          </Text>
                        </View>
                        {value !== null && (
                          <Bar pct={value} used={pct} theme={theme} muted={state === "older"} />
                        )}
                        {(state === "current" || state === "older") && (
                          <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
                            {relativeReset(window.resetsAt)}
                          </Text>
                        )}
                      </View>
                    );
                  })}
              </View>
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
  refresh,
  refreshing,
  range,
}: {
  entry: PanelEntry;
  mode: Mode;
  theme: Theme;
  compact: boolean;
  refresh: () => void;
  refreshing: boolean;
  range: TokenRange;
}) {
  const c = theme.colors;
  const [linkError, setLinkError] = useState(false);
  const snapshot = entry.snapshot;
  const cost = snapshot ? costView(snapshot, range, mode) : null;
  const totalTime = snapshot
    ? totalQuotaTime(snapshot.key.total.resetsAt, snapshot.key.expiresAt)
    : null;
  const untilExpiry = snapshot?.key.expiresAt
    ? Date.parse(snapshot.key.expiresAt) - Date.now()
    : null;
  const expiresSoon = untilExpiry !== null && untilExpiry > 0 && untilExpiry <= 7 * 86400000;
  const open = (url: string) => {
    setLinkError(false);
    void openExternalUrl(url).catch(() => setLinkError(true));
  };
  const limited = snapshot?.pools.some((p) => p.accounts.some((a) => a.state === "rate_limited"));
  const older = snapshot?.pools.some((pool) =>
    pool.accounts.some((account) =>
      account.windows.some(
        (window) => windowState(account, window, snapshot.serverTime) === "older",
      ),
    ),
  );
  const missing =
    snapshot?.errors.length ||
    snapshot?.pools.some(
      (p) =>
        !p.accounts.length ||
        p.accounts.some(
          (a) =>
            a.state === "unknown" ||
            a.state === "unavailable" ||
            !a.windows.some((window) => window.usedPct !== null) ||
            a.windows.some((w) => windowState(a, w, snapshot!.serverTime) === "reset"),
        ),
    );
  const state = entry.error
    ? "连接或 Key 异常"
    : limited
      ? "部分账号限流"
      : missing
        ? "部分数据缺失"
        : older
          ? "部分数据较旧"
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
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Text style={{ color: c.accent, fontSize: 20 }}>◈</Text>
        <Text style={{ color: c.foreground, flex: 1, fontSize: 17, fontWeight: "600" }}>
          CRS 中转
        </Text>
        {expiresSoon && (
          <Text
            style={{
              color: c.statusWarning,
              fontSize: 10,
              borderWidth: 1,
              borderColor: c.statusWarning,
              borderRadius: 8,
              paddingHorizontal: 6,
              paddingVertical: 2,
            }}
          >
            {Math.ceil(untilExpiry! / 86400000)} 天后到期
          </Text>
        )}
        <Text
          accessibilityLabel={state}
          style={{
            color: entry.error
              ? c.statusDanger
              : limited || missing || older
                ? c.statusWarning
                : c.statusSuccess,
            fontSize: 12,
          }}
        >
          ●
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`刷新 CRS 用量，${state}，上次成功获取 ${stamp(entry.successfulAt)}`}
          disabled={refreshing}
          onPress={refresh}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            minHeight: 40,
            paddingHorizontal: 4,
            opacity: refreshing ? 0.5 : 1,
          }}
        >
          <Text style={{ color: c.foregroundMuted, fontSize: 19 }}>↻</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
            {entry.successfulAt
              ? relativeCollection(entry.successfulAt).replace(/采集$/, "")
              : "尚未获取"}
          </Text>
        </Pressable>
      </View>
      {entry.error && (
        <View style={{ borderLeftWidth: 3, borderColor: c.statusDanger, paddingLeft: 12, gap: 5 }}>
          <Text style={{ color: c.statusDanger }}>{entry.error}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {snapshot ? `显示上次成功数据：${stamp(entry.successfulAt)}` : "尚无成功快照"} · 可重试{" "}
            {stamp(entry.retryAt)}
          </Text>
        </View>
      )}
      {snapshot && cost && (
        <>
          <View testID="range-cost" style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text testID="range-cost-label" style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {cost.label} · {cost.remaining ? "剩余" : "已用"}
              </Text>
              {cost.daily && (
                <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
                  上限 ${cost.daily.limit.toFixed(2)}
                </Text>
              )}
            </View>
            <Text
              testID="range-cost-value"
              style={{ color: c.foreground, fontSize: compact ? 32 : 36, fontWeight: "600" }}
            >
              {cost.value === null ? "—" : `$${cost.value.toFixed(2)}`}
            </Text>
            {cost.daily && (
              <View testID="daily-cost-limit" style={{ gap: 6 }}>
                <Bar
                  pct={
                    cost.daily.usedPct === null
                      ? null
                      : mode === "used"
                        ? cost.daily.usedPct
                        : Math.max(0, 100 - cost.daily.usedPct)
                  }
                  used={cost.daily.usedPct}
                  theme={theme}
                />
                {snapshot.key.daily.resetsAt && (
                  <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
                    {relativeReset(snapshot.key.daily.resetsAt)}
                  </Text>
                )}
              </View>
            )}
            {cost.total && (
              <View testID="total-cost-limit" style={{ gap: 6, marginTop: 4 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>总额度</Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
                    {mode === "used" ? "已用" : "剩余"}{" "}
                    {cost.total.value === null ? "—" : `$${cost.total.value.toFixed(2)}`} / $
                    {cost.total.limit.toFixed(2)}
                  </Text>
                </View>
                <Bar
                  thin
                  pct={
                    cost.total.usedPct === null
                      ? null
                      : mode === "used"
                        ? cost.total.usedPct
                        : Math.max(0, 100 - cost.total.usedPct)
                  }
                  used={cost.total.usedPct}
                  theme={theme}
                />
                {totalTime && (
                  <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{totalTime}</Text>
                )}
              </View>
            )}
          </View>
          <TokenUsage data={snapshot.tokenDays} range={range} theme={theme} />
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
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 9 }}>
          <Button
            label="网页管理 ↗"
            theme={theme}
            onPress={() => open(entry.links.keys ?? entry.links.usage)}
          />
        </View>
        {linkError && <Text style={{ color: c.statusDanger }}>浏览器打开失败，请重试</Text>}
      </View>
    </View>
  );
}
export function UsageScreen({ theme, layout }: PluginScreenProps) {
  const [mode, setMode] = useState<Mode>("used");
  const [range, setRange] = useState<TokenRange>(1);
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: c.foreground, flex: 1, fontSize: 24, fontWeight: "600" }}>
            CRS 用量与管理
          </Text>
          {!query.data?.length && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="刷新 CRS 用量"
              disabled={query.isFetching}
              onPress={() => {
                void query.refetch();
              }}
              style={{ padding: 10, opacity: query.isFetching ? 0.5 : 1 }}
            >
              <Text style={{ color: c.foregroundMuted, fontSize: 19 }}>↻</Text>
            </Pressable>
          )}
        </View>
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
          {query.data?.some((entry) => entry.snapshot) && (
            <View style={{ flexDirection: "row", gap: 4, marginLeft: "auto" }}>
              {([1, 7, 30] as const).map((days) => (
                <Button
                  key={days}
                  label={days === 1 ? "今天" : `${days}天`}
                  theme={theme}
                  selected={range === days}
                  onPress={() => setRange(days)}
                />
              ))}
            </View>
          )}
        </View>
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
          <Entry
            key={entry.id}
            entry={entry}
            mode={mode}
            theme={theme}
            compact={layout.compact}
            range={range}
            refreshing={query.isFetching}
            refresh={() => {
              void query.refetch();
            }}
          />
        ))}
      </View>
    </ScrollView>
  );
}
