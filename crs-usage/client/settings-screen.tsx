import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { settingsDefinition, type Settings } from "../shared/settings";
function Editor({
  theme,
  initial,
  revision,
  save,
}: {
  theme: PluginSurfaceProps["theme"];
  initial: Settings;
  revision: string;
  save: (values: Settings, revision: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState("");
  const c = theme.colors;
  return (
    <View style={{ gap: 18 }}>
      <Text style={{ color: c.foregroundMuted }}>
        一般不用填。自动读取主机 Pi、Claude Code 和 Codex 的配置并识别 CRS；Key
        留在服务端，不要在这里粘贴凭据。
      </Text>
      {(
        [
          ["allowedOrigins", "可选：只探测这些来源地址（每行一个 origin；留空自动）"],
          ["providerNames", "可选：只探测这些 provider（每行一个；留空自动）"],
          ["managementOrigin", "可选：覆盖 CRS 管理地址（HTTPS origin；留空自动）"],
          ["piConfigDir", "Pi 配置目录（留空遵从主机环境 / 默认目录）"],
          ["spaPrefix", "管理网页 SPA 前缀（例如 /admin-next；空则只显示用量入口）"],
        ] as const
      ).map(([field, label]) => (
        <View key={field} style={{ gap: 6 }}>
          <Text style={{ color: c.foreground, fontSize: 13 }}>{label}</Text>
          <TextInput
            accessibilityLabel={label}
            multiline={field === "allowedOrigins" || field === "providerNames"}
            value={
              Array.isArray(draft[field])
                ? (draft[field] as string[]).join("\n")
                : (draft[field] as string)
            }
            onChangeText={(text) =>
              setDraft({
                ...draft,
                [field]:
                  field === "allowedOrigins" || field === "providerNames" ? text.split("\n") : text,
              })
            }
            style={{
              color: c.foreground,
              borderColor: c.border,
              borderWidth: 1,
              backgroundColor: c.surface1,
              padding: 12,
              borderRadius: 8,
            }}
          />
        </View>
      ))}
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          const parsed = settingsDefinition.schema.safeParse({
            ...draft,
            allowedOrigins: draft.allowedOrigins.map((v) => v.trim()).filter(Boolean),
            providerNames: draft.providerNames.map((v) => v.trim()).filter(Boolean),
          });
          if (!parsed.success) {
            setState("设置格式有误，请检查 HTTPS 管理地址和 SPA 前缀");
            return;
          }
          setState("保存中…");
          void save(parsed.data, revision)
            .then((saved) => setState(saved ? "已保存" : "保存失败，请重新读取设置后重试"))
            .catch(() => setState("保存失败，请重新读取设置后重试"));
        }}
        style={{ backgroundColor: c.accent, padding: 12, borderRadius: 8 }}
      >
        <Text style={{ color: c.accentForeground }}>保存设置</Text>
      </Pressable>
      <Text style={{ color: c.foregroundMuted }}>{state}</Text>
    </View>
  );
}
export function SettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(settingsDefinition);
  const queries = useQueryClient();
  const [notice, setNotice] = useState("");
  return (
    <ScrollView
      style={{ backgroundColor: theme.colors.surface0, flex: 1 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 28, gap: 20 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 22 }}>CRS 用量设置</Text>
      {settings.status === "ready" ? (
        <Editor
          key={settings.revision}
          theme={theme}
          initial={settings.values}
          revision={settings.revision}
          save={async (values, revision) => {
            const saved = await settings.save(values, revision);
            setNotice(
              saved ? "已保存" : "保存失败，设置可能已被另一客户端修改。请重新读取后重试。",
            );
            if (saved)
              await Promise.all([
                queries.invalidateQueries({ queryKey: ["crs-discover"] }),
                queries.invalidateQueries({ queryKey: ["crs-panel"] }),
              ]);
            return saved;
          }}
        />
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          正在读取设置；若格式无效，请修正主机设置文件后重新打开。
        </Text>
      )}
      <Text style={{ color: theme.colors.foregroundMuted }}>{notice}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setNotice("");
          void settings.reload();
        }}
      >
        <Text style={{ color: theme.colors.accent }}>重新读取设置</Text>
      </Pressable>
    </ScrollView>
  );
}
