import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  formatTokens,
  summarizeTokens,
  TOKEN_PARTS,
  tokenTotal,
  type TokenCounts,
  type TokenDays,
  type TokenRange,
} from "../shared/tokens";

type Theme = PluginScreenProps["theme"];
const names = { input: "新输入", output: "输出", cacheCreate: "缓存写入", cacheRead: "缓存读取" };

function TokenBar({
  values,
  theme,
  small = false,
}: {
  values: TokenCounts;
  theme: Theme;
  small?: boolean;
}) {
  const [hint, setHint] = useState<(typeof TOKEN_PARTS)[number] | null>(null);
  const total = tokenTotal(values);
  // Category colors are separate from quota/status colors; lightness follows the current surface.
  const light = Number.parseInt(theme.colors.surface0.slice(1, 3), 16) > 128;
  const colors = light
    ? ["#2563eb", "#7c3aed", "#c026a3", "#0891b2"]
    : ["#60a5fa", "#a78bfa", "#f472d0", "#22d3ee"];
  return (
    <View style={{ gap: 4 }}>
      <View
        accessibilityLabel={TOKEN_PARTS.map(
          (field) => `${names[field]} ${formatTokens(values[field])}`,
        ).join("，")}
        style={{
          height: small ? 8 : 18,
          flexDirection: "row",
          borderRadius: 4,
          backgroundColor: theme.colors.surface2,
          overflow: "hidden",
        }}
      >
        {total !== null &&
          total > 0 &&
          TOKEN_PARTS.map(
            (field, index) =>
              values[field]! > 0 && (
                <Pressable
                  key={field}
                  accessibilityRole="button"
                  accessibilityLabel={`${names[field]} ${formatTokens(values[field])}`}
                  onHoverIn={() => setHint(field)}
                  onHoverOut={() => setHint(null)}
                  onPress={() => setHint(hint === field ? null : field)}
                  style={{
                    width: `${(values[field]! / total) * 100}%`,
                    backgroundColor: colors[index],
                  }}
                />
              ),
          )}
      </View>
      {hint && (
        <View
          style={{
            position: "absolute",
            bottom: small ? 12 : 22,
            right: 0,
            paddingHorizontal: 8,
            paddingVertical: 5,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface0,
            zIndex: 1,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>
            {names[hint]} {formatTokens(values[hint])}
          </Text>
        </View>
      )}
    </View>
  );
}

export function TokenUsage({
  data,
  range,
  theme,
}: {
  data: TokenDays | null | undefined;
  range: TokenRange;
  theme: Theme;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeTokens(data, range);
  if (!summary) return null;
  const c = theme.colors;
  return (
    <View
      testID="token-usage"
      style={{ gap: 12, borderTopWidth: 1, borderColor: c.border, paddingTop: 18 }}
    >
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>用量</Text>
      <TokenBar key={range} values={summary} theme={theme} />
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <Text
          testID="token-hit-rate"
          style={{ color: c.foreground, fontSize: 30, fontWeight: "600" }}
        >
          {summary.hitRate === null ? "—" : `${Number(summary.hitRate.toPrecision(3))}%`}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>缓存命中率</Text>
        <Text
          testID="token-requests"
          style={{ color: c.foregroundMuted, fontSize: 11, marginLeft: "auto" }}
        >
          {formatTokens(summary.requests)} 次请求
        </Text>
      </View>
      {!!summary.models.length && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="展开或收起按模型用量"
          onPress={() => setExpanded(!expanded)}
        >
          <Text style={{ color: c.accent, fontSize: 12 }}>{expanded ? "▾" : "▸"} 按模型</Text>
        </Pressable>
      )}
      {expanded &&
        summary.models.map((model) => (
          <View key={model.model} style={{ gap: 5 }}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 11, flex: 1 }}>
                {model.model}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>
                {formatTokens(tokenTotal(model))}
              </Text>
            </View>
            <TokenBar key={`${range}-${model.model}`} values={model} theme={theme} small />
          </View>
        ))}
    </View>
  );
}
