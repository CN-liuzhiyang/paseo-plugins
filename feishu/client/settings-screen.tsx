import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { choicesRpc, statusRpc } from "../shared/rpc";
import { settingsDefinition, type Route, type Settings } from "../shared/settings";
import { RouteEditor, blankRoute, describeRoute } from "./route-editor";

type Ready = Extract<SettingsState<typeof settingsDefinition.schema>, { status: "ready" }>;
type Status = RpcOutput<typeof statusRpc>;
export type Choices = RpcOutput<typeof choicesRpc>["providers"];

const STATUS_POLL_MS = 5_000;

export function FeishuSettings(_props: PluginSurfaceProps) {
  const settings = useSettings(settingsDefinition);
  if (settings.status === "loading") {
    return (
      <SettingsSection title="飞书">
        <SettingsCard>
          <SettingsRow label="正在读取设置…" />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="飞书">
        <SettingsCard>
          <SettingsRow label="设置读不出来" error={settings.error} />
          <SettingsAction label="重新读取" actionLabel="重试" onPress={settings.reload} />
          {settings.status === "invalid" ? (
            <SettingsAction
              label="恢复默认设置（会清空白名单和路由）"
              actionLabel="恢复"
              onPress={() => void settings.reset()}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <Editor settings={settings} />;
}

/** Everything on this screen edits one draft; nothing takes effect until it is saved. */
function Editor({ settings }: { settings: Ready }) {
  const [draft, setDraft] = useState(() => ({ values: settings.values, revision: settings.revision }));
  // Bumped to remount the inputs when the draft is replaced, since they hold their own text.
  const [generation, setGeneration] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const dirty = canonical(draft.values) !== canonical(settings.values);
  const stale = dirty && draft.revision !== settings.revision;

  // Saved from another client while nothing is being changed here: show that, inputs included.
  useEffect(() => {
    if (dirty) return;
    setDraft({ values: settings.values, revision: settings.revision });
    setGeneration((value) => value + 1);
  }, [settings.revision]);

  const change = useCallback((update: (values: Settings) => Settings) => {
    setDraft((current) => ({ ...current, values: update(current.values) }));
  }, []);
  const discard = useCallback(() => {
    setDraft({ values: settings.values, revision: settings.revision });
    setEditing(null);
    setGeneration((value) => value + 1);
  }, [settings]);
  const problems = useMemo(() => problemsOf(draft.values), [draft.values]);
  const save = useCallback(async () => {
    if (problems.length > 0) return;
    if (await settings.save(draft.values, draft.revision)) setEditing(null);
  }, [settings, draft, problems]);

  const status = useStatus();
  const choices = useChoices();

  return (
    <>
      {dirty ? (
        <SettingsSection title="未保存的修改">
          <SettingsCard>
            {problems.map((problem) => (
              <SettingsRow key={problem} label="还不能保存" error={problem} />
            ))}
            {stale ? (
              <SettingsRow label="设置在别处被改过" error="保存会失败：先放弃这里的修改，再重新改。" />
            ) : null}
            <SettingsAction
              label={settings.saveError ?? "改完要保存才生效"}
              actionLabel={settings.saving ? "正在保存…" : "保存"}
              disabled={settings.saving || problems.length > 0 || stale}
              onPress={() => void save()}
            />
            <SettingsAction label="放弃这些修改" actionLabel="放弃" disabled={settings.saving} onPress={discard} />
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <StatusSection
        status={status}
        values={draft.values}
        onAllow={(senderId) =>
          change((values) => ({ ...values, senders: unique([...values.senders, senderId]) }))
        }
        onRoute={(chatId) => {
          change((values) => ({ ...values, routes: [...values.routes, { ...blankRoute(choices), chatId }] }));
          setEditing(draft.values.routes.length);
        }}
      />

      <SettingsSection title="连接" key={`connection-${generation}`}>
        <SettingsCard>
          <SettingsInput
            label="lark-cli 路径"
            hint="Windows 上指向 npm 包里的 bin/lark-cli.exe，不是 .cmd"
            initialValue={draft.values.larkCli}
            placeholder=".../@larksuite/cli/bin/lark-cli.exe"
            onChangeText={(larkCli) => change((values) => ({ ...values, larkCli: larkCli.trim() }))}
          />
          <SettingsInput
            label="lark-cli profile"
            hint="机器人的凭据留在这个 profile 里，不经过插件"
            initialValue={draft.values.profile}
            onChangeText={(profile) => change((values) => ({ ...values, profile: profile.trim() }))}
          />
        </SettingsCard>
      </SettingsSection>

      <Senders
        key={`senders-${generation}`}
        senders={draft.values.senders}
        onChange={(senders) => change((values) => ({ ...values, senders }))}
      />

      <SettingsSection title="会话路由">
        <SettingsCard>
          <SettingsRow
            label="一个飞书会话对应一个 agent"
            hint="路由决定这个会话的 agent 在哪个目录、用哪个模型和执行档；改了只影响之后 /new 开的会话"
          />
        </SettingsCard>
        {draft.values.routes.map((route, index) =>
          editing === index ? (
            <RouteEditor
              key={`route-${generation}-${index}`}
              route={route}
              choices={choices}
              onChange={(next: Route) =>
                change((values) => ({
                  ...values,
                  routes: values.routes.map((existing, at) => (at === index ? next : existing)),
                }))
              }
              onRemove={() => {
                change((values) => ({ ...values, routes: values.routes.filter((_, at) => at !== index) }));
                setEditing(null);
                setGeneration((value) => value + 1);
              }}
              onDone={() => setEditing(null)}
            />
          ) : (
            <SettingsCard key={`route-${generation}-${index}`}>
              <SettingsAction
                label={route.name || route.chatId || "（新路由）"}
                hint={describeRoute(route, choices)}
                actionLabel="编辑"
                onPress={() => setEditing(index)}
              />
            </SettingsCard>
          ),
        )}
        <SettingsCard>
          <SettingsAction
            label="给一个会话加路由"
            hint="chat_id 从未路由会话收到的卡片上抄，或者在上面「最近被挡下的消息」里点"
            actionLabel="添加"
            onPress={() => {
              change((values) => ({ ...values, routes: [...values.routes, blankRoute(choices)] }));
              setEditing(draft.values.routes.length);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="审计" key={`audit-${generation}`}>
        <SettingsCard>
          <SettingsInput
            label="审批记录目录"
            hint="每天一个 JSONL 文件；留空是 <PASEO_HOME>/plugin-data/feishu/audit"
            initialValue={draft.values.auditDir}
            onChangeText={(auditDir) => change((values) => ({ ...values, auditDir: auditDir.trim() }))}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

function StatusSection({
  status,
  values,
  onAllow,
  onRoute,
}: {
  status: Status | null;
  values: Settings;
  onAllow(senderId: string): void;
  onRoute(chatId: string): void;
}) {
  const label = status === null ? "正在查询…" : STATE_LABELS[status.state];
  const strangers = (status?.strangers ?? []).filter((stranger) =>
    stranger.why === "sender"
      ? !values.senders.includes(stranger.senderId)
      : !values.routes.some((route) => route.chatId === stranger.chatId),
  );
  return (
    <SettingsSection title="状态">
      <SettingsCard>
        <SettingsRow
          label={label}
          hint={status?.detail}
          error={status?.state === "invalid" || status?.state === "unsupported" ? status.detail : null}
        />
      </SettingsCard>
      {strangers.length > 0 ? (
        <SettingsCard>
          <SettingsRow label="最近被挡下的消息" hint="白名单外的人发的，或者没有路由的会话里发的" />
          {strangers.map((stranger) =>
            stranger.why === "sender" ? (
              <SettingsAction
                key={`${stranger.senderId}-${stranger.chatId}`}
                label={stranger.senderId}
                hint={`不在白名单 · ${stranger.chatType === "group" ? "群聊" : "单聊"} · ${ago(stranger.at)}`}
                actionLabel="允许此人"
                onPress={() => onAllow(stranger.senderId)}
              />
            ) : (
              <SettingsAction
                key={`${stranger.senderId}-${stranger.chatId}`}
                label={stranger.chatId}
                hint={`没有路由 · ${stranger.chatType === "group" ? "群聊" : "单聊"} · ${ago(stranger.at)}`}
                actionLabel="加路由"
                onPress={() => onRoute(stranger.chatId)}
              />
            ),
          )}
        </SettingsCard>
      ) : null}
    </SettingsSection>
  );
}

function Senders({ senders, onChange }: { senders: string[]; onChange(senders: string[]): void }) {
  const [adding, setAdding] = useState("");
  const input = useRef<SettingsInputHandle>(null);
  const add = () => {
    const id = adding.trim();
    if (id === "") return;
    onChange(unique([...senders, id]));
    setAdding("");
    input.current?.replaceText("");
  };
  return (
    <SettingsSection title="白名单">
      <SettingsCard>
        <SettingsRow
          label={senders.length === 0 ? "还没有人：谁发消息都不理" : `${senders.length} 个人`}
          hint="只有这些人能给 agent 派活，也只有他们能在卡片上审批"
        />
        {senders.map((sender) => (
          <SettingsAction
            key={sender}
            label={sender}
            actionLabel="移除"
            onPress={() => onChange(senders.filter((existing) => existing !== sender))}
          />
        ))}
        <SettingsInput
          ref={input}
          label="加一个人"
          hint="open_id，以 ou_ 开头；它按应用分配，要用这个机器人收到的那个"
          placeholder="ou_..."
          onChangeText={setAdding}
        />
        <SettingsAction label="加进白名单" actionLabel="添加" disabled={adding.trim() === ""} onPress={add} />
      </SettingsCard>
    </SettingsSection>
  );
}

const STATE_LABELS: Record<Status["state"], string> = {
  unsupported: "这个 Paseo 不支持",
  unconfigured: "还没配置",
  invalid: "设置有误",
  connecting: "正在连接",
  listening: "正在收消息",
};

function useStatus(): Status | null {
  const call = useRpc(statusRpc);
  const callRef = useRef(call);
  callRef.current = call;
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      callRef
        .current({})
        .then((next) => live && setStatus(next))
        .catch((error: unknown) =>
          live && setStatus({ state: "invalid", detail: `查不到插件状态：${String(error)}`, strangers: [] }),
        );
    void load();
    const timer = setInterval(() => void load(), STATUS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return status;
}

function useChoices(): Choices {
  const call = useRpc(choicesRpc);
  const callRef = useRef(call);
  callRef.current = call;
  const [choices, setChoices] = useState<Choices>([]);
  useEffect(() => {
    let live = true;
    callRef
      .current({})
      .then((result) => live && setChoices(result.providers))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return choices;
}

/** Why the draft cannot be saved yet, in words; empty when it can. */
function problemsOf(values: Settings): string[] {
  const problems: string[] = [];
  for (const sender of values.senders) {
    if (!sender.startsWith("ou_")) problems.push(`白名单里的「${sender}」不是 open_id（要以 ou_ 开头）`);
  }
  values.routes.forEach((route, index) => {
    const name = route.name || route.chatId || `第 ${index + 1} 条路由`;
    if (!route.chatId.startsWith("oc_")) problems.push(`${name}：chat_id 要以 oc_ 开头`);
    if (route.cwd.trim() === "") problems.push(`${name}：要填工作目录`);
    if (!route.provider.includes("/")) problems.push(`${name}：要选模型`);
    if (route.modeId.trim() === "") problems.push(`${name}：要选执行档`);
  });
  const chats = values.routes.map((route) => route.chatId);
  const repeated = chats.find((chatId, index) => chatId !== "" && chats.indexOf(chatId) !== index);
  if (repeated) problems.push(`${repeated} 有两条路由，只有第一条会生效`);
  return problems;
}

/** JSON with keys sorted, so a key added in a different place is not a change. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => left.localeCompare(right)))
      : inner,
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}
