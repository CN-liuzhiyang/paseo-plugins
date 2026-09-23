# orchestration

确定性脚本调度 Paseo agent：机制写死，策略交给 agent。执行层是 `paseo` CLI。

它**不是** Paseo 插件——插件只该做 CLI 做不到的三件事（常驻进程、daemon 内的 hook、UI），编排
一样都不需要。它和插件放在同一个仓库，是因为它们一起分发、一起演进：`feishu/` 的审批卡片复用这里
`gate.mjs` 的判定语义。

写脚本前先读 **[CONVENTIONS.md](CONVENTIONS.md)**——那里是规范，这里是结构。

```
runtime/
  paseo-cli.mjs  CLI 调用（Windows 上绕开 cmd.exe）
  config.mjs     本机配置（~/.paseo-orchestration/config.json）
  step.mjs       step 定义 + schema builder
  agents.mjs     ask / run / 栅栏 / 成本回收
  roster.mjs     读 roles/，严格解析
  gate.mjs       人闸：把待审内容变成一张 Paseo 权限卡片，由人裁决
  audit.mjs      审计（JSONL 按天）
  orch.mjs       eval 入口
  smoke.mjs      升级后回归检查
scripts/     固化的编排流程（committee、advisor）
roles/       一个角色一个 .md：provider/model、thinking、常驻指令
```

## 跑

需要 Node 20+ 和一个在跑的 Paseo daemon。目前只在 Windows 上实测过。

```bash
node runtime/smoke.mjs              # 不花钱的检查（含 roles 里的模型 id 和 thinking id 是否还存在）
node runtime/smoke.mjs --agent      # 再加两次真实 haiku 往返

node scripts/committee.mjs "<问题>" --committee cheap --rounds 3
node scripts/advisor.mjs "<问题>" --role reviewer

node runtime/orch.mjs eval script.mjs --grants spawn,send
```

`eval` 里可用 `agents` / `log` / `ctx` / `roster` / `step`，顶层可 `await`，
返回值出现在 `{ok, value, logs, cost, caveats, auditId}` 里。

## 数据不在这里

本机相关的东西都在仓库外的 `~/.paseo-orchestration/config.json`，每个键都可省：

```json
{
  "paseoInstallDir": "C:/Users/me/AppData/Local/Programs/Paseo",
  "rolesDirs": ["D:/private/roles"],
  "logDir": "D:/private/logs"
}
```

| 键 | 默认 | 用途 |
|---|---|---|
| `paseoInstallDir` | `%LOCALAPPDATA%\Programs\Paseo` | fork 构建或第二份安装在别处时指过去 |
| `rolesDirs` | 无 | 私有角色（内部中转、公司模型）放在自己的仓库里，这里加进来。和自带角色重名直接报错，不做覆盖 |
| `logDir` | `~/.paseo-orchestration/logs` | 审计日志里是完整的 prompt 和 agent 输出，所以默认就不在任何 checkout 里 |

解析是严格的：未知键、类型不对都直接报错。`ORCH_CONFIG` 指向另一个文件；老的环境变量
`PASEO_INSTALL_DIR`、`ORCH_LOG_DIR` 仍然优先于文件。

私有脚本放在自己的仓库里，把这个目录当依赖：

```json
{ "dependencies": { "paseo-orchestration": "file:../paseo-plugins/orchestration" } }
```

```js
import { Orchestrator } from "paseo-orchestration/runtime/agents.mjs";
import { requestApproval } from "paseo-orchestration/runtime/gate.mjs";
```

## 为什么执行层是 CLI，不是 SDK 或插件

CLI 已经覆盖全部编排动作：

| 编排需要 | CLI |
|---|---|
| 起 agent 并等完成 | `run`（默认阻塞）+ `--wait-timeout` |
| 拿结构化结果 | `run --output-schema`，直接把 agent 的结构化输出打到 stdout |
| 后台 / 跟进 / 等待 | `run --background` / `send` / `wait` |
| 人闸 | `permit ls / allow / deny`（与 App 同一队列） |
| 跨机 | 全局 `--host`，支持 SSH |
| 用量 | `inspect --json` 的 `LastUsage` |

换来零依赖、不依赖插件 API 的稳定性、上游和 fork 都能跑、别的 harness 不配 MCP 也能调同一套脚本。
真要换成插件托管，`runtime/paseo-cli.mjs` 是唯一要换的文件。

## 三个结构性决定

**不走 `paseo.cmd`，直接 spawn `Paseo.exe`。** Windows 上 `.cmd` 只能经 cmd.exe 启动，
参数要拼成一行自己转义——中文 prompt、内联 JSON schema 全是坑（经 PowerShell 传 schema，
引号被吃掉报 `INVALID_OUTPUT_SCHEMA`）。`paseo.cmd` 本身只是设四个环境变量再调 `Paseo.exe`，
`runtime/paseo-cli.mjs` 复现这件事，参数数组交给 `CreateProcessW`。代价是依赖安装目录布局，
所以启动前显式检查三个路径，缺了就报错，不猜也不退回 `.cmd`。`smoke.mjs` 每次都验一遍中文参数。

**eval 不做沙箱，且不假装做。** 脚本以 AsyncFunction 在本进程执行，拿得到完整 Node 能力。
安全来自审计 + grants + 只有本机能调。用 `node:vm` 反而会把 Node 全局藏起来，
跟"全权限入口"这个决定打架，还给人一种有隔离的错觉。

**grants 按爆炸半径分级。** 默认 `spawn/send/wait/read`（调用方 agent 本来就能做这些）；
`archive`、`gate:allow`、`gate:deny` 必须显式授予。尤其 `gate:allow` 是"代替人批准"——
这个运行时不该让它变方便。越权直接拒绝并记 `grant.denied`，不升级成人闸。

## 成本怎么收回来的

带 `--output-schema` 时 CLI 返回的是结构化结果，**不含 agentId**，事后没法 inspect。
所以运行时给每个起出来的 agent 打 `orch-run=<runId>` label，脚本结束时
`ls -g -a --label orch-run=...` 找回全部，逐个 inspect 汇总进 `script.end`。

`LastUsage` 只是最后一轮，多轮 `send()` 会低估。Codex agent 的 `CostUsd` 读出来是 0，
所以 `totalUsd` 只含 Claude 系。

## 一个未决问题

`committee` 的裁决者（`assess`）默认比它裁决的成员便宜。让 committee 自己吵这个问题，三轮没收敛：
一方主张先做消融测试定一个固定能力下限，另一方主张默认起步就用弱模型、靠运行时信号（出现否决、
排序置信度低、议题被反复拖延）逐次升级。两边都同意剩余风险是**把两个只是看起来像的立场静默合并掉**，
而成员不会察觉。定下来之前，`--assessor <role>` 是抬高它的办法。
