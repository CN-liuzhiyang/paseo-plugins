import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Account } from "../shared/snapshot";

export function AccountTitle({
  account,
  theme,
  muted = false,
}: {
  account: Account;
  theme: PluginScreenProps["theme"];
  muted?: boolean;
}) {
  const [hint, setHint] = useState(false);
  const c = theme.colors;
  const title = (
    <Text
      testID="account-title"
      numberOfLines={1}
      style={{
        color: muted ? c.foregroundMuted : c.foreground,
        fontSize: muted ? 12 : 13,
        fontWeight: muted ? "400" : "600",
        flexShrink: 1,
        minWidth: 0,
      }}
    >
      {account.name || account.alias}
    </Text>
  );
  if (!account.name) return title;
  return (
    <View style={{ maxWidth: "100%", minWidth: 0, flexShrink: 1, zIndex: hint ? 1 : 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={account.name}
        onHoverIn={() => setHint(true)}
        onHoverOut={() => setHint(false)}
        onFocus={() => setHint(true)}
        onBlur={() => setHint(false)}
        onPress={() => setHint(true)}
      >
        {title}
      </Pressable>
      {hint && (
        <View
          testID="account-alias-hint"
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            maxWidth: "100%",
            paddingHorizontal: 8,
            paddingVertical: 5,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.surface0,
          }}
        >
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{account.alias}</Text>
        </View>
      )}
    </View>
  );
}
