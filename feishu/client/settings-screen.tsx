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
import { addMemberRpc, choicesRpc, removeMemberRpc, statusRpc } from "../shared/rpc";
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
              label="恢复默认设置（会清空管理员和路由）"
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

  const [status, refreshStatus] = useStatus();
  const choices = useChoices();

  // Members are the plugin's own record, not settings: changing them takes effect at once.
  const addMember = useRpc(addMemberRpc);
  const removeMemberCall = useRpc(removeMemberRpc);
  const [busy, setBusy] = useState<string | null>(null);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const members = useCallback(
    async (openId: string, work: () => Promise<unknown>) => {
      setBusy(openId);
      setPeopleError(null);
      try {
        await work();
        refreshStatus();
      } catch (error) {
        setPeopleError(String(error));
      } finally {
        setBusy(null);
      }
    },
    [refreshStatus],
  );
  const letIn = useCallback(
    (person: { openId: string; name: string; chatId: string }) =>
      void members(person.openId, () => addMember(person)),
    [members, addMember],
  );
  const removeMember = useCallback(
    (openId: string) => void members(openId, () => removeMemberCall({ openId })),
    [members, removeMemberCall],
  );

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
        onLetIn={letIn}
        onAdmin={(openId) => change((values) => ({ ...values, senders: unique([...values.senders, openId]) }))}
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

      <People
        key={`people-${generation}`}
        senders={draft.values.senders}
        routes={draft.values.routes}
        status={status}
        onChange={(senders) => change((values) => ({ ...values, senders }))}
        onLetIn={letIn}
        onRemove={removeMember}
        busy={busy}
        error={peopleError}
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
  onLetIn,
  onAdmin,
  onRoute,
}: {
  status: Status | null;
  values: Settings;
  onLetIn(person: { openId: string; name: string; chatId: string }): void;
  onAdmin(openId: string): void;
  onRoute(chatId: string): void;
}) {
  // Before there is an admin, the first person to write is almost always the one setting the
  // bot up: one press makes them admin, instead of member first and admin after a search.
  const firstRun = values.senders.length === 0;
  const label = status === null ? "正在查询…" : STATE_LABELS[status.state];
  const members = new Set((status?.members ?? []).map((member) => member.openId));
  const strangers = (status?.strangers ?? []).filter((stranger) =>
    stranger.why === "sender"
      ? !values.senders.includes(stranger.senderId) && !members.has(stranger.senderId)
      : !values.routes.some((route) => route.chatId === stranger.chatId),
  );
  const chatKind = (chatType: "p2p" | "group") => (chatType === "group" ? "群聊" : "单聊");
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
          <SettingsRow
            label="最近被挡下的消息"
            hint={
              firstRun
                ? "还没有管理员：给机器人发过消息的你就在下面，设为管理员再保存"
                : "名单外的人发的，或者还没接入的会话里发的"
            }
          />
          {strangers.map((stranger) =>
            stranger.why === "sender" && firstRun ? (
              <SettingsAction
                key={`${stranger.senderId}-${stranger.chatId}`}
                label={stranger.name ?? stranger.senderId}
                hint={`${chatKind(stranger.chatType)} · ${ago(stranger.at)} · 设为管理员后要保存`}
                actionLabel="设为管理员"
                onPress={() => onAdmin(stranger.senderId)}
              />
            ) : stranger.why === "sender" ? (
              <SettingsAction
                key={`${stranger.senderId}-${stranger.chatId}`}
                label={stranger.name ?? stranger.senderId}
                hint={`不在名单里 · ${chatKind(stranger.chatType)} · ${ago(stranger.at)}`}
                actionLabel="放行"
                onPress={() =>
                  onLetIn({ openId: stranger.senderId, name: stranger.name ?? "", chatId: stranger.chatId })
                }
              />
            ) : (
              <SettingsAction
                key={`${stranger.senderId}-${stranger.chatId}`}
                label={stranger.chatId}
                hint={`还没接入 · ${chatKind(stranger.chatType)}${stranger.name ? ` · ${stranger.name} 发的` : ""} · ${ago(stranger.at)}`}
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

const MAX_FOUND = 20;

/**
 * Who may use the bot, by name. Admins are settings (saved with the rest of the page);
 * members are the plugin's own record and change at once. Nobody has to know an open_id: people
 * in the routed chats can be found by name, and strangers show up with theirs.
 */
function People({
  senders,
  routes,
  status,
  onChange,
  onLetIn,
  onRemove,
  busy,
  error,
}: {
  senders: string[];
  routes: Route[];
  status: Status | null;
  onChange(senders: string[]): void;
  onLetIn(person: { openId: string; name: string; chatId: string }): void;
  onRemove(openId: string): void;
  busy: string | null;
  error: string | null;
}) {
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState("");
  const input = useRef<SettingsInputHandle>(null);
  const names = status?.names ?? {};
  const members = (status?.members ?? []).filter((member) => !senders.includes(member.openId));
  const chatName = (chatId: string) => routes.find((route) => route.chatId === chatId)?.name || chatId;
  const wanted = search.trim();
  const found =
    wanted === ""
      ? []
      : [
          ...members.map((member) => ({ ...member, member: true })),
          ...(status?.candidates ?? [])
            .filter((person) => !senders.includes(person.openId))
            .map((person) => ({ ...person, member: false })),
        ]
          .filter((person) => person.name.includes(wanted))
          .slice(0, MAX_FOUND);
  const addById = () => {
    const id = adding.trim();
    if (id === "") return;
    onChange(unique([...senders, id]));
    setAdding("");
    input.current?.replaceText("");
  };
  return (
    <SettingsSection title="谁能用">
      <SettingsCard>
        <SettingsRow
          label={senders.length === 0 ? "管理员：还没有，谁发消息都不理" : `管理员 · ${senders.length} 人`}
          hint="能派活、在卡片上批准 agent 要做的事、放行别人。改了要保存。"
        />
        {senders.map((sender) => (
          <SettingsAction
            key={sender}
            label={names[sender] ?? sender}
            hint={names[sender] ? undefined : "还不知道名字：在已接入的会话里说过话就会显示"}
            actionLabel="移除"
            onPress={() => onChange(senders.filter((existing) => existing !== sender))}
          />
        ))}
      </SettingsCard>
      <SettingsCard>
        <SettingsRow
          label={members.length === 0 ? "成员：还没有" : `成员 · ${members.length} 人`}
          hint="能 @ 机器人派活；agent 要批准的事仍由管理员批。名单外的人在群里 @ 机器人，卡片上会有「放行」按钮。移除立即生效。"
          error={error}
        />
        {members.map((member) => (
          <SettingsAction
            key={member.openId}
            label={member.name || member.openId}
            hint={`由 ${member.byName || "管理员"} 放行 · ${chatName(member.chatId)} · ${ago(member.at)}`}
            actionLabel={busy === member.openId ? "正在移除…" : "移除"}
            disabled={busy !== null}
            onPress={() => onRemove(member.openId)}
          />
        ))}
      </SettingsCard>
      <SettingsCard>
        <SettingsInput
          label="按名字找人"
          hint="从已接入的会话的成员里找：放行为成员立即生效；成员可以再设为管理员（要保存）"
          placeholder="名字"
          onChangeText={setSearch}
        />
        {wanted !== "" && found.length === 0 ? (
          <SettingsRow label="没找到" hint="只列已接入的会话里的人；不在这些会话里的人，让他先在里面 @ 一次机器人" />
        ) : null}
        {found.map((person) =>
          person.member ? (
            <SettingsAction
              key={person.openId}
              label={person.name}
              hint={`成员 · ${chatName(person.chatId)}`}
              actionLabel="设为管理员"
              onPress={() => onChange(unique([...senders, person.openId]))}
            />
          ) : (
            <SettingsAction
              key={person.openId}
              label={person.name}
              hint={chatName(person.chatId)}
              actionLabel={busy === person.openId ? "正在放行…" : "放行"}
              disabled={busy !== null}
              onPress={() => onLetIn({ openId: person.openId, name: person.name, chatId: person.chatId })}
            />
          ),
        )}
      </SettingsCard>
      <SettingsCard>
        <SettingsInput
          ref={input}
          label="按 open_id 加管理员"
          hint="找不到名字时用：以 ou_ 开头，按应用分配，要用这个机器人收到的那个"
          placeholder="ou_..."
          onChangeText={setAdding}
        />
        <SettingsAction label="设为管理员" actionLabel="添加" disabled={adding.trim() === ""} onPress={addById} />
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

/** The plugin's status, polled; the second value asks again now, after a change. */
function useStatus(): [Status | null, () => void] {
  const call = useRpc(statusRpc);
  const callRef = useRef(call);
  callRef.current = call;
  const [status, setStatus] = useState<Status | null>(null);
  const loadRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    let live = true;
    const load = () =>
      void callRef
        .current({})
        .then((next) => live && setStatus(next))
        .catch(
          (error: unknown) =>
            live &&
            setStatus({
              state: "invalid",
              detail: `查不到插件状态：${String(error)}`,
              strangers: [],
              members: [],
              names: {},
              candidates: [],
            }),
        );
    loadRef.current = load;
    load();
    const timer = setInterval(load, STATUS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const refresh = useCallback(() => loadRef.current(), []);
  return [status, refresh];
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
    if (!sender.startsWith("ou_")) problems.push(`管理员里的「${sender}」不是 open_id（要以 ou_ 开头）`);
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
