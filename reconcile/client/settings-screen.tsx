import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { settingsDefinition, type Settings } from "../shared/settings";

// Saving restarts the controller on the daemon side (index.server.ts watches the settings).

type Draft = { [K in keyof Settings]?: string };

const TEXT_FIELDS: Array<{ key: "instanceId" | "home" | "configDir" | "dataDir"; label: string; hint: string; placeholder: string }> = [
  { key: "configDir", label: "configDir", hint: "私有配置目录：persons.json、sources.json、policy.json、calendar/、rules/。", placeholder: "D:/private/reconcile/work" },
  {
    key: "home",
    label: "home",
    hint: "这个控制器该在哪个 PASEO_HOME 下发卡。别的 daemon（开发 daemon、另一份安装）读到同一份设置时只演练，不发卡，免得一件事问两遍。",
    placeholder: "C:/Users/me/.paseo",
  },
  { key: "instanceId", label: "instanceId", hint: "这一套部署叫什么（work、family），记进日志和状态。", placeholder: "work" },
  { key: "dataDir", label: "dataDir", hint: "日志和快照放哪。留空：<PASEO_HOME>/plugin-data/reconcile。", placeholder: "" },
];

export function ReconcileSettings(_props: PluginSurfaceProps) {
  const settings = useSettings(settingsDefinition);
  const [draft, setDraft] = useState<Draft>({});

  if (settings.status === "loading") {
    return (
      <SettingsSection title="事务">
        <SettingsCard>
          <SettingsRow label="正在读取设置…" />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="事务">
        <SettingsCard>
          <SettingsRow label="设置读不出来" error={settings.error} />
          <SettingsAction label="重新读取" actionLabel="重试" onPress={() => void settings.reload()} />
          {settings.status === "invalid" ? <SettingsAction label="恢复默认设置" actionLabel="恢复" onPress={() => void settings.reset()} /> : null}
        </SettingsCard>
      </SettingsSection>
    );
  }

  const values = settings.values;
  const revision = settings.revision;
  const tickText = draft.tickSeconds ?? String(values.tickSeconds);
  const tick = Number(tickText);
  const tickError = Number.isInteger(tick) && tick >= 15 && tick <= 3600 ? null : "填 15 到 3600 之间的整数";
  const next: Settings = {
    ...values,
    instanceId: (draft.instanceId ?? values.instanceId).trim(),
    home: (draft.home ?? values.home).trim(),
    configDir: (draft.configDir ?? values.configDir).trim(),
    dataDir: (draft.dataDir ?? values.dataDir).trim(),
    tickSeconds: tickError ? values.tickSeconds : tick,
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(values);

  return (
    <>
      <SettingsSection title="发卡">
        <SettingsCard>
          <SettingsSwitch
            label="真的发问题卡"
            hint="关着是演练：照样读来源、按规则判断、算出该问谁什么，但不起卡片，只在「事务」里列出打算做的事。第一次接上一套新配置时先演练一轮。"
            value={values.mode === "live"}
            disabled={settings.saving}
            onValueChange={(live) => void settings.save({ ...values, mode: live ? "live" : "dry-run" }, revision)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="设置">
        <SettingsCard>
          {TEXT_FIELDS.map((field) => (
            <SettingsInput
              key={`${field.key}-${revision}`}
              label={field.label}
              hint={field.hint}
              initialValue={values[field.key]}
              placeholder={field.placeholder}
              onChangeText={(text) => setDraft((d) => ({ ...d, [field.key]: text }))}
            />
          ))}
          <SettingsInput
            key={`tick-${revision}`}
            label="多久对账一次（秒）"
            hint="每次对账只读到期的来源，来源自己的轮询间隔在 sources.json 里。"
            initialValue={String(values.tickSeconds)}
            onChangeText={(text) => setDraft((d) => ({ ...d, tickSeconds: text }))}
            error={tickError}
          />
          <SettingsAction
            label={settings.saveError ?? (dirty ? "改完要保存才生效；保存会重启控制器" : "没有未保存的修改")}
            actionLabel={settings.saving ? "正在保存…" : "保存"}
            disabled={!dirty || tickError !== null || settings.saving}
            onPress={() => {
              void settings.save(next, revision).then((saved) => {
                if (saved) setDraft({});
              });
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
