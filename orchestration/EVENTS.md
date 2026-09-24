# 运行事件契约（v1）

一次 flow 运行产生一份事件流。它是运行时唯一的对外产出：审计、可视化插件、飞书卡片、评测采集
都只读它，互不耦合。**执行层以后怎么换（shell out 调 CLI，或挪进 daemon），这份契约不变。**

这份契约的代码形式是 `runtime/events.mjs` 的 `checkEvents(events, { strict, complete })`，返回违反之处
的列表；`readEvents(file)` 按下面"最后一行"的规则读文件。样例：`fixtures/committee.jsonl`（假执行层
跑的一次 committee，含并发调用、一次失败的调用、反复进入的阶段、caveat 和成本；`node test/make-fixture.mjs`
重新生成）。

## 存放

- 一次运行一个文件：`<logDir>/runs/<runId>.jsonl`，只追加，一行一个 JSON 对象，UTF-8，`\n` 结尾。
  文件名去掉 `.jsonl` 就是 `runId`，与文件里每一行的 `runId` 相同。
- `run.end` 是最后一行，之后不会再有任何行（包括运行结束后才返回的调用）。
- `logDir` 的解析顺序与运行时一致：环境变量 `ORCH_LOG_DIR` → `~/.paseo-orchestration/config.json`
  的 `logDir` → `~/.paseo-orchestration/logs`。
- 读者可以按字节偏移增量读取；最后一行可能是写了一半的（没有 `\n` 结尾），读者要忽略它，下次再读。
- 没有 `run.end` 的文件表示运行还没结束，**或者进程死了**。和运行在同一台机器上的读者（`run.start.hostname`
  等于本机 hostname）直接查 `run.start.pid` 这个进程还在不在；进程不在又没有 `run.end`，就是死了。别的
  机器上的读者只能用最后一条事件的 `ts` 判断：很久没有新事件、又没有 `run.end`，显示为"失联"，不要显示为
  "运行中"。pid 会被系统复用，所以"进程在"只说明可能还活着，配合 `ts` 看。
- 运行在第一笔花费之前被拒（输入不合 `inputs`、flow 加载失败、源码扫描发现未声明的阶段）时**不产生
  文件**：运行没有开始。调用方从异常里拿到原因。

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
| `pid` | number | 跑这次运行的进程 id |
| `hostname` | string | 跑这次运行的机器，Node 的 `os.hostname()` |

### `phase.start` / `phase.end`

| 字段 | 类型 | 含义 |
|---|---|---|
| `phase` | string | 阶段 id，必定出现在 `run.start.flow.phases` 里 |
| `ok` | boolean | 仅 `phase.end`：阶段内的代码是否正常结束（没抛错）。因 `$.stop` 退出的阶段记 `true`：那是有意结束，不是失败 |

同一阶段可以进出多次（例如循环里反复进入 `debate`）；也可能有并发的阶段。运行结束时还开着的阶段，
在 `run.end` 之前补 `phase.end`，`ok: false`。

### `call.start`

一次调用：agent 调用（`ask`）、脚本自己的动作（`do`）、人闸（`gate`）。

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string | 本次运行内唯一（运行时写成 `c1`、`c2`……，按开始顺序）。Paseo 上的 agent 带 `orch-run=<runId>` 和 `orch-call=<callId>` 两个标签，两个一起才唯一 |
| `type` | `"ask"` \| `"do"` \| `"gate"` | |
| `name` | string | `ask`：step 名；`do`：动作名；`gate`：`"gate"` |
| `title` | string | 给人看的标题。`ask`：调用点的 `$.ask(step, input, { title })` → step 的 `define({ title })` → `` `[${name}]` ``，取第一个有的，截到 120 字符，和发给 Paseo 的 agent 标题（`--title`）是同一个值；`do`：`$.do(name, fn, { title })` 的 `title`，没给就等于 `name`；`gate`：`$.gate` 的 `title`，截到 120 字符 |
| `phase` | string \| null | 所在阶段，不在任何阶段内为 null |

所有 `timeout` 字段是运行时 `parseDuration` 接受的格式：正则 `^\d+(s|m|h)$`，即一个非负整数紧跟一个单位
`s`（秒）、`m`（分）、`h`（时），例如 `90s`、`12m`、`2h`。没有小数、空格、组合（`1h30m` 不合法）。
`ask` 的是单次调用的上限（step 的 `timeout`，没写时为 `30m`）；`gate` 的是等人的上限（默认 `2h`）。

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
| `headline` | string \| null | step 的 `define({ headline })`：`schema.properties` 里的一个键，说明回答里哪个字段可以当这次调用的一句话（界面在节点上显示 `call.end.output[headline]`）。step 没声明时为 null。运行时写的每条 `ask` 都有这个字段；之前写的文件没有，读者按 null 处理 |

`type: "gate"` 另有：

| 字段 | 类型 | 含义 |
|---|---|---|
| `brief` | string | 给审批人的说明 |
| `content` | string | 待批准的原文 |
| `sha256` | string | 原文指纹（换行符统一、去掉结尾换行后的 sha256，与判定对象里的 `sha256` 相同） |
| `timeout` | string | |
| `holdPath` | string | 载体要写入的暂存路径，人在权限卡片上看到的就是它 |
| `provider` | string | 载体 agent 的 `family/model` |
| `fence` | object | 同 `ask`，`mode` 是"每次写都要人批"那一档 |
| `prompt` | string | 实际发给载体的完整 prompt（含 `brief`，`brief` 过长时被截断的那份） |

### `call.agent`

一知道某个调用对应哪个 Paseo agent 就发一条，让人在调用进行中就能点进那个 agent 看。

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string | |
| `agentId` | string | |

- 只有 `ask` 和 `gate` 会有；`do` 没有。
- 每个调用**最多一条**，而且一定在该调用的 `call.end` 之前；调用结束后不再为它发。
- `gate` 在载体 agent 起来之后立刻发。`ask` 的 agent id 不会随 `run --output-schema` 返回，运行时在后台按
  标签找：调用开始后约 3 秒找第一次，找不到就隔一段再试，总共最多 5 次（约 78 秒内）。所以短调用、
  或者一直没找到的调用，**可能没有** `call.agent`——那时以 `call.end.agentId` 为准。
- 两条都有时，`call.end.agentId` 与 `call.agent.agentId` 相同。

### `call.end`

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string | |
| `ok` | boolean | |
| `durationMs` | number | |
| `output` | any | `ask`：schema 形状的结构化结果（回答不合 schema 时调用记失败，`error.name` 为 `"OutputMismatch"`，`output` 是原样收到的回答）；`do`：返回值（可 JSON 化，过长的字符串会被截断并加 `"…(truncated N chars)"`）；`gate`：判定对象，见下 |
| `error` | `{ name, message }` \| null | |
| `agentId` | string \| null | 这次调用对应的 Paseo agent（`ask`、`gate` 有；`do` 为 null；查不到时为 null） |
| `cost` | `{ usd: number \| null, inputTokens: number \| null, outputTokens: number \| null }` \| null | 该 agent 的 `LastUsage`。失败的调用照样有（钱已经花了）。Codex 的 `usd` 是 0，照实给 |

每个 `call.start` 都有且只有一条 `call.end`。运行结束时还没结束的调用（总超时，或 flow 抛错时没等它），
在 `run.end` 之前补一条：`ok: false`，`error.name` 为 `"RunEnded"`，`agentId` 照常查。那个 agent
**没有被停掉**，可能还在跑、还在花钱；之后它的结果不会再进这个文件。

`gate` 的 `output` 就是现有 `requestApproval()` 的判定对象，字段不变：
`{ outcome: "allowed"|"denied"|"expired"|"mismatch"|"error", approved, agentId, sha256, askedAt, decidedAt, waitedMs, reason, agentReport, by, agentStatusAtDecision }`。

`gate` 的 `call.end.ok` 说的是**人闸这个机制**有没有正常走完，不是人批没批：拒绝、过期、内容不一致、
甚至判定为 `error`（内容太长起不了卡片、轮询一直失败）都是 `ok: true`，结论看 `output.outcome`
（或 `output.approved`）。`ok: false` 只在人闸自身抛错时出现（例如起载体 agent 失败），这时 `output` 为 null。

`by` 的取值是封闭集合，v1 只有这四个，和 `outcome` 的对应关系固定：

| `by` | 何时 |
|---|---|
| `"unattributed (Paseo does not record who answered)"` | `allowed`、`denied`、`mismatch`：有人（或别的进程）应答了卡片，Paseo 不记录是谁 |
| `"gate timeout"` | `expired`：到期没人应答，运行时替人拒绝 |
| `"nobody (gate lost sight of the request)"` | `error`：轮询 agent 状态连续失败，不知道发生了什么 |
| `"nobody (no card was raised)"` | `error`：内容太长，载体 prompt 超限，卡片没起 |

### `caveat`

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string \| null | 关联的调用 |
| `text` | string | 一条没被机械强制的约束，照实说 |

同一段文字一次运行只发一次，`callId` 是第一次触发它的调用。所以"这次调用有没有被强制"要看它
`call.start` 里的 `fence.enforced`，不要看它有没有自己的 caveat。

### `log`

| 字段 | 类型 | 含义 |
|---|---|---|
| `level` | `"info"` \| `"warn"` \| `"error"` | |
| `message` | string | |

### `run.end`（最后一行）

| 字段 | 类型 | 含义 |
|---|---|---|
| `outcome` | `"done"` \| `"stopped"` \| `"failed"` \| `"timeout"` | `done`：flow 返回了；`stopped`：flow 调过 `$.stop`（以第一次为准；之后 flow 就算接住了它、返回了、或抛了别的错，结局也是 `stopped`）；`failed`：抛错；`timeout`：超出运行总时限 |
| `value` | any | `done` / `stopped` 时 flow 给出的结果 |
| `summary` | string \| null | 给人看的一句话结论，来自 flow 的 `summarize(value, { outcome })`（`value` 就是本行的 `value`）。只在 `done` / `stopped` 时调用；flow 没声明 `summarize`、结局是 `failed` / `timeout`、它抛错（这时前面有一条 `log` warn 说原因）或返回的不是非空字符串时为 null。超过 200 字符（按 Unicode 码点算）截断并加 `…`。它出错不影响结局。运行时写的每条 `run.end` 都有这个字段；之前写的文件没有，读者按 null 处理 |
| `stop` | `{ reason: string, phase: string \| null }` \| null | 仅 `stopped` |
| `error` | `{ name, message }` \| null | 仅 `failed` / `timeout` |
| `durationMs` | number | |
| `cost` | `{ totalUsd: number, agentCount: number, partial: string }` \| null | 各 `call.end.cost.usd` 之和；`agentCount` 是有 agent 的调用数。一个 agent 都没起时为 null。`partial` 是给人看的一句说明，讲 `totalUsd` 少算了什么（现在是：每个 agent 只算最后一轮 `LastUsage`；Codex 报 `CostUsd` 0，所以只含 Claude 系）。原样显示即可，不要解析；内容可能变 |
| `caveats` | string[] | 本次运行所有 caveat 的去重列表 |

## 演进规则

- 加字段不升版本；读者必须忽略不认识的字段和不认识的 `kind`。
- 后加的字段，旧文件里没有：读者按表里写的缺省处理。`checkEvents` 非 strict 时放过缺失、strict 时要求有。
  目前后加的：`call.start.headline`（`ask`）、`run.end.summary`，缺省都是 null。
- 改字段含义、删字段才升 `v`。
