import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import type { Route } from "../shared/settings";
import type { Choices } from "./settings-screen";

// Modes that run tools without asking. Prompts from Feishu come from outside, so say so.
const UNGUARDED_MODES = ["bypassPermissions", "full-access", "yolo"];

export function blankRoute(choices: Choices): Route {
  const provider = choices.find((entry) => entry.id === "claude") ?? choices[0];
  const model = provider?.models[0];
  return {
    chatId: "",
    name: "",
    cwd: "",
    provider: provider && model ? `${provider.id}/${model.id}` : "",
    modeId: provider ? defaultMode(provider) : "",
    instructions: "",
    claudeMd: false,
  };
}

function defaultMode(provider: Choices[number]): string {
  return provider.modes.find((mode) => mode.id === "default")?.id ?? provider.modes[0]?.id ?? "";
}

function split(route: Route): { providerId: string; modelId: string } {
  const slash = route.provider.indexOf("/");
  return slash === -1
    ? { providerId: route.provider, modelId: "" }
    : { providerId: route.provider.slice(0, slash), modelId: route.provider.slice(slash + 1) };
}

/** One line under a route's name: model, mode, and whether it reads CLAUDE.md. */
export function describeRoute(route: Route, choices: Choices): string {
  const { providerId, modelId } = split(route);
  const provider = choices.find((entry) => entry.id === providerId);
  const model = provider?.models.find((entry) => entry.id === modelId)?.label ?? (modelId || "未选模型");
  const mode = provider?.modes.find((entry) => entry.id === route.modeId)?.label ?? (route.modeId || "未选执行档");
  return [
    route.chatId,
    `${provider?.label ?? providerId} ${model}`,
    mode,
    route.claudeMd ? "读取 CLAUDE.md" : "不读 CLAUDE.md",
  ].join(" · ");
}

/** Always includes the current value, so a model the daemon no longer lists stays visible. */
function withCurrent(options: Array<{ label: string; value: string }>, value: string, placeholder: string) {
  if (value === "") return [{ label: placeholder, value: "" }, ...options];
  return options.some((option) => option.value === value) ? options : [{ label: value, value }, ...options];
}

export function RouteEditor({
  route,
  choices,
  onChange,
  onRemove,
  onDone,
}: {
  route: Route;
  choices: Choices;
  onChange(route: Route): void;
  onRemove(): void;
  onDone(): void;
}) {
  const { providerId, modelId } = split(route);
  const provider = choices.find((entry) => entry.id === providerId);
  const model = provider?.models.find((entry) => entry.id === modelId);
  const isClaude = providerId === "claude";
  // No key may hold undefined: the host saves through z.json(), which refuses it.
  const set = (patch: Partial<Route>) => {
    const next: Route = { ...route, ...patch };
    if (next.thinkingOptionId === undefined) delete next.thinkingOptionId;
    onChange(next);
  };

  return (
    <SettingsCard>
      <SettingsInput
        label="名称"
        hint="给人看的，也会告诉 agent，比如「我的单聊」「家庭群」"
        initialValue={route.name}
        onChangeText={(name) => set({ name })}
      />
      <SettingsInput
        label="chat_id"
        hint="以 oc_ 开头"
        initialValue={route.chatId}
        placeholder="oc_..."
        onChangeText={(chatId) => set({ chatId: chatId.trim() })}
      />
      <SettingsInput
        label="工作目录"
        hint="agent 在这个目录里干活"
        initialValue={route.cwd}
        onChangeText={(cwd) => set({ cwd: cwd.trim() })}
      />
      <SettingsSelect
        label="提供方"
        value={providerId}
        options={withCurrent(
          choices.map((entry) => ({ label: entry.label, value: entry.id })),
          providerId,
          "选择提供方",
        )}
        onValueChange={(next) => {
          const chosen = choices.find((entry) => entry.id === next);
          const first = chosen?.models[0];
          set({
            provider: first ? `${next}/${first.id}` : next,
            modeId: chosen ? defaultMode(chosen) : "",
            thinkingOptionId: undefined,
          });
        }}
      />
      <SettingsSelect
        label="模型"
        value={modelId}
        options={withCurrent(
          (provider?.models ?? []).map((entry) => ({ label: entry.label, value: entry.id })),
          modelId,
          "选择模型",
        )}
        onValueChange={(next) => set({ provider: `${providerId}/${next}`, thinkingOptionId: undefined })}
      />
      <SettingsSelect
        label="执行档"
        hint={
          UNGUARDED_MODES.includes(route.modeId)
            ? "这个执行档不逐条询问：飞书里来的消息会直接跑命令、改文件"
            : "Claude 的 default（Always Ask）会把每个要权限的操作发到卡片上批"
        }
        value={route.modeId}
        options={withCurrent(
          (provider?.modes ?? []).map((entry) => ({ label: entry.label, value: entry.id })),
          route.modeId,
          "选择执行档",
        )}
        onValueChange={(modeId) => set({ modeId })}
      />
      {model && model.thinking.length > 0 ? (
        <SettingsSelect
          label="思考档"
          value={route.thinkingOptionId ?? ""}
          options={[
            { label: "模型默认", value: "" },
            ...model.thinking.map((entry) => ({ label: entry.label, value: entry.id })),
          ]}
          onValueChange={(next) => set({ thinkingOptionId: next === "" ? undefined : next })}
        />
      ) : null}
      <SettingsSwitch
        label="读取 CLAUDE.md"
        hint={
          isClaude
            ? "关着时 agent 不读任何 CLAUDE.md：既不读 daemon 用户的全局配置（里面的私人信息会被写进回复），也不读工作目录里的。只在自己的单聊里打开"
            : "只对 Claude 生效；其他提供方照常读它们自己的全局指令"
        }
        value={route.claudeMd}
        onValueChange={(claudeMd) => set({ claudeMd })}
      />
      <SettingsInput
        label="常驻指令"
        hint="加在这个会话的 agent 的系统提示后面，比如它是谁、该怎么说话"
        initialValue={route.instructions}
        onChangeText={(instructions) => set({ instructions })}
      />
      <SettingsRow label="改了路由只影响之后开的会话" hint="已有会话发 /new 才换成新配置" />
      <SettingsAction label="收起" actionLabel="完成" onPress={onDone} />
      <SettingsAction label="删除这条路由" actionLabel="删除" onPress={onRemove} />
    </SettingsCard>
  );
}
