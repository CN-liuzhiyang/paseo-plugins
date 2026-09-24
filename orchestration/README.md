# orchestration

确定性脚本调度 Paseo agent：机制写死，策略交给 agent。脚本叫 **flow**，执行层是 `paseo` CLI，
产出是每次运行一份的**事件流**。

它**不是** Paseo 插件——插件只该做 CLI 做不到的三件事（常驻进程、daemon 内的 hook、UI），编排
一样都不需要。它和插件放在同一个仓库，是因为它们一起分发、一起演进：`feishu/` 的审批卡片复用这里
`gate.mjs` 的判定语义，可视化插件读这里的事件流。

写 flow 前先读 **[CONVENTIONS.md](CONVENTIONS.md)**——那里是规范，这里是结构。事件的契约是
**[EVENTS.md](EVENTS.md)**。

```
runtime/
  flow.mjs       flow() 与 step 构造器的入口（flow 只 import 这一个）；check
  flow.d.mts     写 flow 用的类型
  step.mjs       step 定义、schema 构造器、输入校验
  run.mjs        运行器：$ 原语、事件、成本、caveats、收尾
  orch.mjs       命令行：run / check
  fences.mjs     栅栏表：effects -> 各 provider 的 mode
  events.mjs     事件写入、读取、契约校验
  executor.mjs   执行层：唯一跟 Paseo 说话的地方
  paseo-cli.mjs  CLI 调用（Windows 上绕开 cmd.exe）
  gate.mjs       人闸：把待审内容变成一张 Paseo 权限卡片，由人裁决
  roster.mjs     读 roles/，严格解析；角色绑定
  config.mjs     本机配置（~/.paseo-orchestration/config.json）
  smoke.mjs      升级后回归检查（经真实 Paseo）
flows/       固化的编排流程（committee、advisor）
roles/       一个角色一个 .md：provider/model、thinking、常驻指令
test/        单测（假执行层，不花钱）、fixture 生成、类型探针
fixtures/    committee.jsonl：一次完整运行的事件样例
```

## 跑

需要 Node 22.4+ 和一个在跑的 Paseo daemon。目前只在 Windows 上实测过。

```bash
node runtime/orch.mjs check flows/committee.mjs     # 不花钱：元信息、step、阶段、grants
node runtime/orch.mjs run flows/committee.mjs --question "<问题>" --committee cheap --rounds 3 --assessor worker
node runtime/orch.mjs run flows/advisor.mjs --question "<问题>" --role reviewer
node runtime/orch.mjs run flows/advisor.mjs --input @args.json --timeout 30m

npm test                                            # 单测，不需要 daemon
node runtime/smoke.mjs                              # 不花钱的检查（含 roles 里的模型 id、thinking id、栅栏）
node runtime/smoke.mjs --agent                      # 再加两次真实 haiku 往返
```

`run` 打印一个 JSON：`{ ok, outcome, value, runId, events, cost, caveats, durationMs, error, stop }`，
`events` 是这次运行的事件文件。退出码：0 是 `done`/`stopped`，1 是 `failed`/`timeout`，2 是运行前就被拒
（参数、输入、检查不过；这时没有事件文件）。

从代码里跑（以后飞书、schedule、界面按钮都走这个）：

```js
import { runFlow } from "paseo-orchestration/runtime/run.mjs";
const result = await runFlow("/abs/path/flows/advisor.mjs", { input: { question, role: "reviewer" }, timeout: "30m" });
```

`runFlow` 只在运行开始之前抛错（`RunRefused`）；开始之后，失败、超时都在返回值和 `run.end` 里。

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
| `logDir` | `~/.paseo-orchestration/logs` | 事件文件在 `<logDir>/runs/<runId>.jsonl`，里面是完整的 prompt 和 agent 输出，所以默认就不在任何 checkout 里 |

解析是严格的：未知键、类型不对都直接报错。`ORCH_CONFIG` 指向另一个文件；老的环境变量
`PASEO_INSTALL_DIR`、`ORCH_LOG_DIR` 仍然优先于文件。

以前的按天审计文件（`<logDir>/YYYY-MM-DD.jsonl`）不再写，已有的原地保留。

私有 flow 放在自己的仓库里，把这个目录当依赖：

```json
{ "dependencies": { "paseo-orchestration": "file:../paseo-plugins/orchestration" } }
```

```js
import { flow, define, text } from "paseo-orchestration/runtime/flow.mjs";
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
执行层是一个可注入的对象（`runtime/executor.mjs`，七个方法），运行器只经它碰 Paseo：单测注入假的，
真要挪进 daemon 或换成插件托管，换的也只是它。

## 几个结构性决定

**只有一种脚本格式。** 以前有两套：脚本各自手写 `main`（生命周期写了四遍，已经走偏：advisor、committee
失败时不记结束，运行 id 字段名不一，caveats 各自手抄），和一个 `eval` 入口（把源码包进 AsyncFunction，
**不能有 import**——已实测报 `Cannot use import statement outside a module`——现有脚本都跑不了）。
现在 flow 只写 `run`，生命周期由唯一的运行器负责，`eval` 删掉了。

**"一次运行"是一等对象。** 每次运行一个事件文件：开始就写 `run.start`（元信息、输入），调用**开始**就写
`call.start`，结束才写 `call.end`，所以运行中的调用在文件里看得见，界面可以实时画。脚本自己的步骤
（`$.do`）、人闸、阶段、主动停下的原因都在里面。写是同步追加：一行落盘之后调用才往下走，顺序就是
`seq`，进程崩了最多丢正在写的那一行。事件量是每次调用几行，阻塞事件循环的代价可以忽略。

**不做沙箱，也不假装做。** flow 在本进程执行，拿得到完整 Node 能力。安全来自事件流 + grants + 只有
本机能调。用 `node:vm` 反而会把 Node 全局藏起来，跟"全权限入口"这个决定打架，还给人一种有隔离的错觉。

**grants 按爆炸半径分级，写在 flow 的元信息里，运行前就可见。** 默认 `spawn/send/wait/read`（调用方 agent
本来就能做这些），不用写。额外的只有 `gate:deny`（人闸过期时替人拒绝，保守方向）。`gate:allow` 是"代替
人批准"——它不存在，声明它直接报错。越权直接拒绝，不升级成人闸。

**栅栏是数据。** step 声明 `effects`，`runtime/fences.mjs` 把它换成每家 provider 的 mode，并说明是否被
机械强制；未知 provider 直接报错。见 CONVENTIONS R8。

## 成本怎么收回来的

带 `--output-schema` 时 CLI 返回的是结构化结果，**不含 agentId**，事后没法 inspect。所以运行时给每次调用
的 agent 打 `orch-run=<runId>` 和 `orch-call=<callId>` 两个 label，调用一结束就
`ls -g -a --label orch-run=... --label orch-call=...` 找回、`inspect` 收成本，写进这次调用的 `call.end`；
`run.end.cost` 是它们的和。失败的调用也收——钱已经花了。

`LastUsage` 只是最后一轮；一次结构化调用只发一个 prompt，应该就是一轮，所以按调用收是准的（推断，
没有拿多轮 agent 对比过）。Codex agent 的 `CostUsd` 读出来是 0，
所以 `totalUsd` 只含 Claude 系。

## 一个未决问题

`committee` 的裁决者（`assess`）默认比它裁决的成员便宜。让 committee 自己吵这个问题，三轮没收敛：
一方主张先做消融测试定一个固定能力下限，另一方主张默认起步就用弱模型、靠运行时信号（出现否决、
排序置信度低、议题被反复拖延）逐次升级。两边都同意剩余风险是**把两个只是看起来像的立场静默合并掉**，
而成员不会察觉。定下来之前，`--assessor <role>` 是抬高它的办法。
