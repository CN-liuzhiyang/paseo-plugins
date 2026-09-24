# 运行事件契约（v1）

一次 flow 运行产生一份事件流。它是运行时唯一的对外产出：审计、可视化插件、飞书卡片、评测采集
都只读它，互不耦合。**执行层以后怎么换（shell out 调 CLI，或挪进 daemon），这份契约不变。**

## 存放

- 一次运行一个文件：`<logDir>/runs/<runId>.jsonl`，只追加，一行一个 JSON 对象，UTF-8，`\n` 结尾。
- `logDir` 的解析顺序与运行时一致：环境变量 `ORCH_LOG_DIR` → `~/.paseo-orchestration/config.json`
  的 `logDir` → `~/.paseo-orchestration/logs`。
- 读者可以按字节偏移增量读取；最后一行可能是写了一半的（没有 `\n` 结尾），读者要忽略它，下次再读。
- 没有 `run.end` 的文件表示运行还没结束，**或者进程死了**。读者用最后一条事件的 `ts` 判断：
  很久没有新事件、又没有 `run.end`，显示为"失联"，不要显示为"运行中"。

## 每一行都有的字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `v` | `1` | 契约版本 |
| `seq` | number | 本次运行内从 0 递增 |
| `ts` | string | ISO 8601 时间 |
| `runId` | string | 运行 id（UUID） |
| `kind` | string | 事件类型，见下 |

## 事件类型

### `run.start`（永远是第一行）

| 字段 | 类型 | 含义 |
|---|---|---|
| `flow` | object | `{ name, description, phases: [{ id, title }], inputs: <JSON Schema>, grants: string[] }`，即 flow 的元信息 |
| `source` | string \| null | flow 文件的绝对路径 |
| `input` | object | 本次运行的输入值 |
| `caller` | string \| null | 发起方 Paseo agent id（`PASEO_AGENT_ID`），终端里跑为 null |
| `cwd` | string | 运行时的工作目录 |
| `host` | string \| null | `--host`，本机为 null |

### `phase.start` / `phase.end`

| 字段 | 类型 | 含义 |
|---|---|---|
| `phase` | string | 阶段 id，必定出现在 `run.start.flow.phases` 里 |
| `ok` | boolean | 仅 `phase.end`：阶段内的代码是否正常结束（没抛错） |

同一阶段可以进出多次（例如循环里反复进入 `debate`）；也可能有并发的阶段。

### `call.start`

一次调用：agent 调用（`ask`）、脚本自己的动作（`do`）、人闸（`gate`）。

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string | 本次运行内唯一 |
| `type` | `"ask"` \| `"do"` \| `"gate"` | |
| `name` | string | `ask`：step 名；`do`：动作名；`gate`：`"gate"` |
| `title` | string | 给人看的标题 |
| `phase` | string \| null | 所在阶段，不在任何阶段内为 null |

`type: "ask"` 另有：

| 字段 | 类型 | 含义 |
|---|---|---|
| `role` | string \| null | 角色名；字面 provider 调用为 null |
| `provider` | string | `family/model` |
| `thinking` | string \| null | |
| `effects` | `"none"` \| `"workspace"` | step 声明的影响范围 |
| `fence` | object | `{ mode: string \| null, enforced: boolean, note: string }`：该 provider 下这一档实际用了什么模式、是否机械强制、给人看的一句说明 |
| `prompt` | string | 实际发出的完整 prompt（含角色指令） |
| `schema` | object | 输出 JSON Schema；字段的 `description` 可用作界面标签 |
| `schemaFingerprint` | string | |
| `timeout` | string | |

`type: "gate"` 另有：

| 字段 | 类型 | 含义 |
|---|---|---|
| `brief` | string | 给审批人的说明 |
| `content` | string | 待批准的原文 |
| `sha256` | string | 原文指纹 |
| `timeout` | string | |

### `call.end`

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string | |
| `ok` | boolean | |
| `durationMs` | number | |
| `output` | any | `ask`：schema 形状的结构化结果；`do`：返回值（可 JSON 化，过长的字符串会被截断并加 `"…(truncated N chars)"`）；`gate`：判定对象，见下 |
| `error` | `{ name, message }` \| null | |
| `agentId` | string \| null | 这次调用对应的 Paseo agent（`ask`、`gate` 有；`do` 为 null；查不到时为 null） |
| `cost` | `{ usd: number \| null, inputTokens: number \| null, outputTokens: number \| null }` \| null | |

`gate` 的 `output` 就是现有 `requestApproval()` 的判定对象，字段不变：
`{ outcome: "allowed"|"denied"|"expired"|"mismatch"|"error", approved, agentId, sha256, askedAt, decidedAt, waitedMs, reason, agentReport, by, agentStatusAtDecision }`。

### `caveat`

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string \| null | 关联的调用 |
| `text` | string | 一条没被机械强制的约束，照实说 |

### `log`

| 字段 | 类型 | 含义 |
|---|---|---|
| `level` | `"info"` \| `"warn"` \| `"error"` | |
| `message` | string | |

### `run.end`（正常情况下是最后一行）

| 字段 | 类型 | 含义 |
|---|---|---|
| `outcome` | `"done"` \| `"stopped"` \| `"failed"` \| `"timeout"` | `done`：flow 返回了；`stopped`：flow 主动停下（`$.stop`）；`failed`：抛错；`timeout`：超出运行总时限 |
| `value` | any | `done` / `stopped` 时 flow 给出的结果 |
| `stop` | `{ reason: string, phase: string \| null }` \| null | 仅 `stopped` |
| `error` | `{ name, message }` \| null | 仅 `failed` / `timeout` |
| `durationMs` | number | |
| `cost` | `{ totalUsd: number, agentCount: number, partial: string }` \| null | |
| `caveats` | string[] | 本次运行所有 caveat 的去重列表 |

## 演进规则

- 加字段不升版本；读者必须忽略不认识的字段和不认识的 `kind`。
- 改字段含义、删字段才升 `v`。
