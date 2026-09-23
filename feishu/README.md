# feishu

飞书入口：挂在 Paseo 插件 server 侧的一层薄 dispatcher。它不是 agent——收事件、鉴权、按表路由，
判断交给它起的 agent 或它调的脚本；结果、进度和审批请求以一张原地更新的卡片发回飞书。

**状态：M2。** 收消息 → 白名单 → 按 chat_id 路由 → 交给这个会话的 agent → 每条消息一张卡片
原地更新（已接收 / 排队中 / 进行中 / 等待审批 / 完成 / 失败 / 已取消）；agent 要权限时直接在
卡片上批准或拒绝，每次审批都记审计。还没有的：设置界面（M3，现在配置写文件，见下文）。

## 会话

一个飞书会话就是和一个 agent 的一段对话，上下文连续：

- 会话里第一条消息起 agent，之后的消息都发给它。agent 还在处理上一条时，新消息排队（卡片显示
  「排队中」），上一轮结束再发，不打断正在跑的那一轮；在 Paseo 里直接跟它对话造成的忙也算。
- `/new` 开新会话；`/new <内容>` 开新会话并直接问这句。旧会话留在 Paseo 里。
- 在 Paseo 里把 agent 归档，下一条消息自动开新会话。
- 会话和 agent 的对应关系是 agent 上的标签 `feishu-chat=<chat_id>`，存在 Paseo 自己的注册表里，
  插件或 daemon 重启后照样接得上。改了路由的 `cwd` 或 `provider` 不影响已有会话，`/new` 之后才生效。
- 排队只在内存里：插件重启时还在排队的消息不会补发，卡片停在「排队中」。

## 已知问题：agent 读得到 daemon 用户的全局配置

飞书触发的 agent 以 daemon 用户的身份运行。Paseo 启动 Claude 时固定加载 user、project、local
三层配置，与工作目录无关，所以它会读到这个用户的 `~/.claude/CLAUDE.md` 和其中 import 的一切，
并可能把内容写进回复——实测问一句"你知道刚说了啥吗"，它就把全局指令和机器画像概括进了卡片。
白名单里的每个人、路由到的群里的每个人都看得到这些回复。

上下文怎么配置还没定。在那之前，只路由给自己的单聊。

## 审批

agent 要权限时，这条消息的卡片变成「等待审批」，每个未决请求一个表单：要做什么（命令、文件和
改动、计划），一排按钮，有拒绝选项时再加一个拒绝理由输入框。

- **按钮和 Paseo 自己的权限卡片一致**：请求带了选项就用它的选项，否则是「拒绝 / 允许」；发出去的
  回应也和 Paseo 卡片发的一样。拒绝理由会原样转告 agent（`Denied by user: <理由>`）。
- **谁能批**：`senders` 里的人。白名单外的人点了没有任何反应，只记一条审计。
- **每次点击都向 Paseo 核对**，不信插件自己的记忆：agent 还在、卡片在这个 agent 的会话里、请求
  此刻确实还开着，才提交。所以已在 Paseo 里处理过的请求点了不会再批一次；插件重启过，旧卡片照样
  能批（批完卡片换成一行审批记录，这条消息之后的进度去 Paseo 里看）。
- **以 Paseo 的确认为准**：点完卡片先显示「正在提交」，收到 `agent.permission_resolved` 才算数；
  15 秒没确认就在卡片上说明，可以再点一次。
- **卡片上记着谁批的**：审批记录一行一条，写明允许还是拒绝、批的是什么、谁（飞书里点的显示人名，
  在 Paseo 里批的写「在 Paseo 里」，Paseo 不记录是谁）、等了多久。
- **提问（`question`）不在卡片上答**，卡片提示去 Paseo 里回答。
- **没有「总是允许」**：放宽权限规则是 Paseo 里的事，卡片只对这一次请求表态。

卡片上凡是 agent 写的文字，都用纯文本组件或转义后显示：否则 agent 输出里的 `<at id=all>`
能在群里 @所有人，`[文字](链接)` 能伪装成链接。

### 审计

审计按天写成 JSONL，默认目录是 `<PASEO_HOME>/plugin-data/feishu/audit/`，用设置里的 `auditDir`
可以改。格式和编排运行时的审计一致（每行都有 `id` / `ts` / `kind`），可以放进同一个目录一起统计：

| kind | 何时 | 要点字段 |
|---|---|---|
| `feishu.approval.ask` | 请求出现在卡片上 | 工具、完整 input、`askedAt` |
| `feishu.approval.answer` | 有人在卡片上作了选择并已提交 | `operator`、`actionId`、`reason` |
| `feishu.approval.refused` | 点击被拒绝 | `operator`、`why`（不在白名单、不在这个会话、请求已关闭……） |
| `feishu.approval.error` | 提交了但 Paseo 没接 | `why` |
| `feishu.approval.decision` | 请求了结 | `outcome`（allowed / denied / abandoned）、`by`、`waitedMs`、拒绝理由 |

`by` 是 `feishu:<open_id>`，或者在 Paseo 里批的 `paseo (unattributed ...)`。拒绝率和审查耗时从
`decision` 行直接算。这些记录里有人名 ID 和完整的工具输入，不能进任何仓库。

## 宿主要求

飞书消息从 Paseo 外面进来，没有哪个 hook 或 RPC handler 会把 Paseo API 递给插件，所以插件入口
要用 `server.paseo`。这是 fork（`CN-liuzhiyang/paseo` 的 `next`）加的扩展点，上游还没有；
宿主不提供时插件只打一行日志，什么也不做。

## 安装

```bash
paseo plugin add CN-liuzhiyang/paseo-plugins:feishu
paseo plugin logs feishu
```

飞书侧的能力全部经飞书官方的 `lark-cli` 调用，daemon 所在机器上要先装好它，
并给机器人配一个单独的 profile。凭据留在 lark-cli 自己的存储里，不经过本插件。

## 数据不在这里

仓库里只有代码和配置的 schema。谁能给机器人发消息、哪个会话路由到哪个 workspace，都存在
daemon 本机的插件 settings 里（`defineSettings`，scope 为 host，不跨机同步），**默认为空、
fail-closed**：没配发送者就谁都进不来，没配路由就收到消息也不起 agent。

## 配置

设置界面做出来之前，直接写 `$PASEO_HOME/plugin-settings/<安装 id>/feishu.json`：

```json
{
  "version": 1,
  "values": {
    "larkCli": "<lark-cli 可执行文件的绝对路径>",
    "profile": "<机器人的 lark-cli profile>",
    "senders": ["ou_..."],
    "routes": [
      { "chatId": "oc_...", "cwd": "<agent 的工作目录>", "provider": "claude/claude-sonnet-5", "modeId": "default" }
    ],
    "auditDir": ""
  }
}
```

- `larkCli` 在 Windows 上要指向 npm 包里的原生 `bin/lark-cli.exe`，不是 `.cmd` 包装：spawn 包装
  需要 shell，而 shell 会打乱参数转义，也让关停信号到不了真正的进程。
- `modeId` 必填。provider 的默认执行档可能是不逐条询问就跑工具的，而这些 prompt 来自外部，
  执行档要有意选。Claude 的 `default` 是 Always Ask。
- `senders` 同时决定谁能在卡片上审批。
- `senders`、`routes` 和 `auditDir` 每次用到都重新读，改完立即生效；`larkCli` 和 `profile` 改完要
  `paseo plugin reload feishu`。
- open_id 和 chat_id 都是按应用分配的，别的应用里查到的不能用。拿法：`senders` 留空，给机器人
  发一条消息，插件日志里会有 `dropped <message> from ou_... in oc_...`；把 open_id 加进
  `senders` 后再发一条，没配路由的会话会收到一张写着 chat_id 的卡片。

## 分层

| 层 | 职责 | 实现 |
|---|---|---|
| 事件接入 | 收消息与卡片回调，去重，识别发送者 | spawn 两个 `lark-cli event consume` 子进程，逐行读 NDJSON |
| 鉴权 | 发送者是否被允许 | open_id 白名单。不在表里的消息直接丢弃，不进 agent |
| 路由 | 直接回答 / 起一个 agent / 跑一个已知脚本 | 按 chat_id 查表。是查表不是判断；确需分类时另起廉价 agent，只许输出有限枚举 |
| 执行 | 起 agent 或跑编排脚本 | Paseo agent，或本仓库 `orchestration/` 的脚本 |
| 回消息 | 结果、进度、审批请求 | 一张卡片原地 patch，不发多条消息 |

为什么是插件 server 侧：它本身就是 daemon 的常驻子进程；`contribute()` 返回的清理函数管子进程的
生命周期；而且插件 hook 在没有 app 连着的时候也照样跑——手机没开 Paseo，飞书消息照样处理。

agent 的上下文里一个飞书工具都不需要：回信由 dispatcher 自己做，agent 不必知道自己是被飞书触发的。

## 卡片

一张卡片、三个状态：已接收 → 进行中（定时刷新耗时）→ 完成（结果正文）。两类事件必须当场推：

- **权限请求与 agent 提问**（`agent.permission_requested`）：卡片变成「等待审批」，见上文「审批」。
- **失败**（`turn_ended` 的 outcome 为 `failed`），带错误原文，否则人会空等。

飞书把表单里的按钮点击交回来时只带按钮的 `name`（表单内按钮不能带 `value`），所以按钮名里写着
它回答的是哪个 agent 的哪个请求、哪个选项；它只是个地址，点击时照样向 Paseo 核对。

## 权限分级

| 档 | 例子 | 放行方式 |
|---|---|---|
| L0 只读 | 查日程、读文档、总结聊天记录 | 自动 |
| L1 可逆写入 | 建待办、建日程草稿、写笔记 | 自动，事后可撤 |
| L2 对外可见 | 替人发消息、发邮件、群通知 | 卡片确认 |
| L3 物理或资金 | 家电、门锁、支付、下单 | 卡片确认，每次单独确认，不许"记住选择" |

## 非对称授权

飞书消息是不可信的外部输入，白名单是挡住陌生人的唯一一道闸。如果 agent 手里有一条能加白名单的
命令，"白名单内的人转发一段含注入的文本 → agent 执行 → 把攻击者加进白名单"就绕开了它。

| 操作 | 人 | agent |
|---|---|---|
| 读配置 | 可以 | 可以 |
| 收紧：删白名单、关路由、降权 | 可以 | 可以，直接生效 |
| 放松：加白名单、开路由、提权 | 可以 | 只能提议，进待批队列 |

agent 有完整 shell，能绕过任何 CLI 直接调插件 RPC；daemon 在协议层分不出调用方是人还是 agent。
所以放松操作的生效必须依赖一个 agent 产生不了的动作：人在 Paseo UI 上确认，或在飞书卡片上点批准。
不提供 `--approve` 一类的命令，免得留下"这条路是通的"的错觉。

## 实现时逐条对照的坑

每一条都属于"看起来正常、实际不工作"。

1. **`card.action.trigger` 要在开发者后台单独开启**（应用 → 事件与回调 → 回调配置）。没开时消费者
   照常启动、不报错，但一个事件都收不到。卡片按钮全部失灵先查这里。
2. **等 ready marker，不要 sleep**：`event consume` 在 stderr 输出 `[event] ready event_key=<key>`，
   读到这行再开始读 stdout。
3. **stdin EOF 等于优雅退出**：无界运行时 stdin 必须保持打开，重定向到 null 会让它立刻退出。
4. **一个 consume 只能一个 EventKey**，不支持逗号或通配；两个子进程共享同一个本地 bus。
5. **关停用 SIGTERM 或关 stdin，不要 kill -9**：某些 EventKey 会因此泄漏服务端订阅。
6. **不要用 `--quiet`**：它会连事件丢失的警告一起吞掉。
7. **`messages.patch` 只能改 14 天内的卡片**，content 序列化后不超过 30 KB。
8. **卡片回调 token 有效期 30 分钟、最多用 2 次**：本插件不用它，点击后改卡片走 `messages.patch`，
   所以审批卡片只受 14 天的限制。lark-cli 会自己在 3 秒内应答回调，飞书端不会弹提示，
   点击后的反馈全靠随后的 patch。
9. **settings 的 scope 只能是 host**：多台 daemon 要各配一份白名单和路由。

## 测试机器人

在飞书开放平台建一个单独的自建应用：

1. 添加"机器人"能力。
2. 事件与回调 → 订阅方式选**长连接**，添加事件 `im.message.receive_v1`。
3. **回调配置**里开启 `card.action.trigger`（见坑 1）。
4. 权限：接收单聊消息、以应用身份发消息。
5. 发布一个版本，然后用 `lark-cli` 把这个应用配成一个单独的 profile。
