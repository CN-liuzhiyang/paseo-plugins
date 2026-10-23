import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { statusRpc } from "../shared/rpc";
import { settingsDefinition } from "../shared/settings";
import { LOG_DIR_SOURCE } from "./looks";

type Status = RpcOutput<typeof statusRpc>;

export function OrchestrationSettings(_props: PluginSurfaceProps) {
  const settings = useSettings(settingsDefinition);
  const status = useRpc(statusRpc);
  const [where, setWhere] = useState<Status | null>(null);
  const [logDir, setLogDir] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const revision = settings.status === "ready" ? settings.revision : null;

  useEffect(() => {
    let cancelled = false;
    status({}).then(
      (value) => !cancelled && setWhere(value),
      (error: unknown) => !cancelled && setWhere({ logDir: null, detail: String(error), cards: { state: "unavailable", detail: String(error) } }),
    );
    return () => {
      cancelled = true;
    };
  }, [status, revision]);

  if (settings.status === "loading") {
    return (
      <SettingsSection title="流程">
        <SettingsCard>
          <SettingsRow label="正在读取设置…" />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="流程">
        <SettingsCard>
          <SettingsRow label="设置读不出来" error={settings.error} />
          <SettingsAction label="重新读取" actionLabel="重试" onPress={() => void settings.reload()} />
          {settings.status === "invalid" ? (
            <SettingsAction label="恢复默认设置" actionLabel="恢复" onPress={() => void settings.reset()} />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }

  const draftLogDir = logDir ?? settings.values.logDir;
  const draftStale = stale ?? String(settings.values.staleMinutes);
  const minutes = Number(draftStale);
  const staleError = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? null : "填 1 到 1440 之间的整数";
  const dirty = draftLogDir !== settings.values.logDir || draftStale !== String(settings.values.staleMinutes);

  return (
    <>
      <SettingsSection title="现在读的位置">
        <SettingsCard>
          {where?.logDir ? (
            <SettingsRow label={where.logDir.runsDir} hint={`来自${LOG_DIR_SOURCE[where.logDir.source]}`} />
          ) : (
            <SettingsRow label="不知道流程记录在哪" error={where?.detail ?? null} />
          )}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="发起对话里的流程卡片">
        <SettingsCard>
          <SettingsSwitch
            label="在发起对话里显示流程卡片"
            hint="从 Paseo agent 里跑的流程，会在那个 agent 的对话里放一张卡片：在做什么、到哪一步、花了多少、要不要你处理，跟着运行原地更新。"
            value={settings.values.cards}
            disabled={settings.saving}
            onValueChange={(cards) => void settings.save({ ...settings.values, cards }, settings.revision)}
          />
          {where && where.cards.state === "unavailable" ? <SettingsRow label="这里贴不了卡片" error={where.cards.detail} /> : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="设置">
        <SettingsCard>
          <SettingsInput
            key={`logDir-${revision}`}
            label="logDir"
            hint="留空就和运行时一样找：ORCH_LOG_DIR → ~/.paseo-orchestration/config.json 的 logDir → ~/.paseo-orchestration/logs。流程记录在它下面的 runs 目录。"
            initialValue={settings.values.logDir}
            placeholder="D:/private/logs"
            onChangeText={setLogDir}
          />
          <SettingsInput
            key={`stale-${revision}`}
            label="多久没有新事件算失联（分钟）"
            hint="没有 run.end 的流程安静超过这么久就显示「失联」；正在等的调用自己的时限更长时，按那个时限算。"
            initialValue={String(settings.values.staleMinutes)}
            onChangeText={setStale}
            error={staleError}
          />
          <SettingsAction
            label={settings.saveError ?? (dirty ? "改完要保存才生效" : "没有未保存的修改")}
            actionLabel={settings.saving ? "正在保存…" : "保存"}
            disabled={!dirty || staleError !== null || settings.saving}
            onPress={() => {
              void settings
                .save({ ...settings.values, logDir: draftLogDir.trim(), staleMinutes: minutes }, settings.revision)
                .then((saved) => {
                  if (!saved) return;
                  setLogDir(null);
                  setStale(null);
                });
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
