# orchestration

> 界面上叫「流程」：下面（和这个目录的其他开发文档）用技术叫法，「运行（run）」就是界面上的一次流程。字段名、事件名、插件 id 都不变。

确定性脚本调度 Paseo agent：机制写死，策略交给 agent。脚本叫 **flow**，执行层是 `paseo` CLI，
产出是每次运行一份的**事件流**。

它**不是** Paseo 插件——插件只该做 CLI 做不到的三件事（常驻进程、daemon 内的 hook、UI），编排
一样都不需要。它和插件放在同一个仓库，是因为它们一起分发、一起演进：`feishu/` 的审批卡片复用这里
`gate.mjs` 的判定语义，可视化插件读这里的事件流，人闸的卡片由 `orchestration-gate/` 插件的 provider 承载。

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
  claim.mjs      运行 id 的占位文件：原子占位、心跳、被拒的原因
  liveness.mjs   活着的判断本身：表（classify）、pid 只证明死亡（pidFact）、活着但安静多久算"可能卡住"（staleAfterMs）；
                 没有 import 的单文件，装在别处的插件带一份拷贝（npm run sync:liveness）
  state.mjs      一次运行处在什么状态（读占位和事件文件）：调用方判断活没活着、能不能重起，只用它
  affair.mjs     run.start.affair 的形状和校验
  resolve.mjs    flow 名字到文件（flows/ 加 config 的 flowsDirs）
  catalog.mjs    有哪些 flow（`orch.mjs list` 的数据：名字、说明、阶段、输入、文件、读不了的原因）
  executor.mjs   执行层：唯一跟 Paseo 说话的地方
  paseo-cli.mjs  CLI 调用（Windows 上绕开 cmd.exe）
  gate.mjs       人闸：起一张 Paseo 权限卡片，人批的是回执，判定只看回执文件
  roster.mjs     读 roles/，严格解析；角色绑定
  config.mjs     本机配置（~/.paseo-orchestration/config.json）
  smoke.mjs      升级后回归检查（经真实 Paseo）
flows/       固化的编排流程（committee、advisor；gate-smoke 是人闸冒烟，不花钱）
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
（参数、输入、检查不过、id 被占；这时没有事件文件）。

从代码里跑（以后飞书、schedule、界面按钮都走这个）：

```js
import { runFlow } from "paseo-orchestration/runtime/run.mjs";
const result = await runFlow("/abs/path/flows/advisor.mjs", { input: { question, role: "reviewer" }, timeout: "30m" });
```

`runFlow` 只在运行开始之前抛错（`RunRefused`）；开始之后，失败、超时都在返回值和 `run.end` 里。

## 从别的进程起一次运行（插件、调度器）

别的插件要起一次运行、并把它挂在自己的一件事上，走命令行，不走 `runFlow`：运行器要独占一个进程，
崩了不能带走调用方。一条命令：

```bash
node runtime/orch.mjs run triage --run-id item-123-1   --affair '{"label":"事项 #123 · 等单独 merge","link":{"plugin":"tracker","screen":"item","params":{"id":"123"}}}'   --cwd D:/work/repo --timeout 2h --question "<问题>"
```

- `triage` 是 flow 的名字，不是路径：按文件名（不带 `.mjs`）在 `flows/` 和 config.json 的 `flowsDirs` 里找。
  找不到、或两个目录里有同名的，报错并列出找过的目录和能找到的名字；给路径的老用法不变。
  `flowsDirs` 和 `rolesDirs` 一样放在本机的 `~/.paseo-orchestration/config.json`（`ORCH_CONFIG` 可改位置）。
- `--run-id` 是调用方自己的 id：运行的文件就叫这个名字，调用方不用等输出就知道去哪儿找。一个 id 只能用一次。
- `--affair` 是这次运行属于哪件事，原样记进 `run.start.affair`，界面在运行视图顶上写"属于：<label>"，有
  `link` 就能点回去（形状和限制见 [EVENTS.md](EVENTS.md)）。运行时不认识具体的插件，`plugin` / `screen`
  是调用方的插件 id 和那个插件里注册的屏 id。JSON 里有引号，用命令行传不方便时写成文件：`--affair @affair.json`
  （`--input` 同样）。从代码里起子进程时用参数数组，不经过 shell，就没有引号问题。

### 先写意图，再起进程；重启后按文件判断

起进程和写下"我要起"不是一步。顺序是：

1. 调用方先把意图记在自己的存储里（`runId`、flow、输入、`affair`、起的时间）；
2. 再起子进程；
3. 之后——包括调用方自己崩了、重启、插件 reload 之后——调 `runtime/state.mjs` 的
   `readRunState({ dir: logDir, runId, spawnedAt })`，按返回的 `state` 办。**状态表和"活着"的定义在
   [EVENTS.md](EVENTS.md) 的"占位文件和运行还活着吗"，表是 `fixtures/run-state-cases.json`**：占位文件最近
   2 分钟被碰过才算活着，pid 只用来证明死了；被拒的运行在占位文件里留着原因。

两条硬规则：

- **`safeToRestart` 为 true 才能自动重起，它只在"没有占位、没有事件文件、距起进程已过 60 秒"时为 true。**
  `dead-before-start`（占位过期、没有事件文件）、`stalled-before-start`、`lost` 都不自动重起，交给人：机器休眠或
  进程被挂起时占位也会过期，醒来原进程还会接着跑。要重来用新的 `runId`。看到这三种时先隔 30 秒再读一次。
- **被拒的 id 用掉了**，包括 flow 名没配好这类环境问题；修好之后换一个 id（比如在 id 里带轮次）。不要对被拒的
  运行自动重试。

不要用"事件文件不存在就再起一次"来恢复：事件文件要到 `run.start` 才有，之前的几秒里运行器已经在了。
占位文件是为这个存在的：同一个 `--run-id` 起两次，第二次一定被拒（退出码 2，一分钟都不花）。

调用方和运行器必须读写**同一个** `logDir`：命令行没有 `--log-dir`，起子进程时显式设 `ORCH_LOG_DIR`，并从同一个值读。

### 起子进程要注意的

- **用哪个 Node。** Paseo 插件宿主进程的 `process.execPath` 是 `Paseo.exe`，它是 Electron，当 Node 用要
  `ELECTRON_RUN_AS_NODE=1`；不设，起出来的是一个桌面应用的窗口，不是脚本。Windows 上再加 `windowsHide: true`，
  否则每次闪一个控制台窗口。（`runtime/paseo-cli.mjs` 起 `paseo` 命令行也是这么做的。）
- **要不要分离。** 想让运行比调用方活得久，用 `detached: true`、`stdio: "ignore"`、`child.unref()`。Windows 上实测：
  - 调用方优雅退出、插件 reload（只杀自己，不杀进程树）：分离的子进程**活着**；
  - 用 `taskkill /pid <父> /T /F` 杀进程树（Paseo 的 `--force` 强制停止 daemon 走的是这个）：分离的子进程**一起死**。
  所以调用方重启之后要预期会遇到"失联"的运行：没有 `run.end`，占位文件不再被碰。已经花的钱看事件文件里
  已经 `call.end` 的调用，不要靠重跑来"补"。
  另外，daemon 优雅退出时会关掉它所有的 agent，一个还在等 agent 的 flow 多半会以 `failed` 结束，所以分离
  带来的"接着读"价值有限，主要是留下记录。
- **输出去哪儿。** `stdio: "ignore"` 时终端上的 JSON 结果和错误信息都丢了，这没关系：结果在事件文件的 `run.end`，
  `run.start` 之前的失败（找不到 flow、参数错、`--affair` 不合格式）在占位文件的 `refused` 里。想在调用方
  的日志里也有一份，给 `stdio` 一个文件描述符即可。
- **退出码。** 0 是 `done` / `stopped`，1 是 `failed` / `timeout`，2 是运行前就被拒（包括 id 被占）。
- **取消。** 没有。终止运行器进程只是让运行器消失：agent 是 daemon 管的，不是它的子进程，不会被一起停，仍在花钱；运行视图里能看到它们，要在 Paseo 里停。

## 数据不在这里

本机相关的东西都在仓库外的 `~/.paseo-orchestration/config.json`，每个键都可省：

```json
{
  "paseoInstallDir": "C:/Users/me/AppData/Local/Programs/Paseo",
  "rolesDirs": ["D:/private/roles"],
  "logDir": "D:/private/logs",
  "hosts": { "build-box": "ssh://me@build-box", "home": "https://app.paseo.sh/#offer=..." }
}
```

| 键 | 默认 | 用途 |
|---|---|---|
| `paseoInstallDir` | `%LOCALAPPDATA%\Programs\Paseo` | fork 构建或第二份安装在别处时指过去 |
| `rolesDirs` | 无 | 私有角色（内部中转、公司模型）放在自己的仓库里，这里加进来。和自带角色重名直接报错，不做覆盖 |
| `logDir` | `~/.paseo-orchestration/logs` | 事件文件在 `<logDir>/runs/<runId>.jsonl`，里面是完整的 prompt 和 agent 输出，所以默认就不在任何 checkout 里 |
| `hosts` | 无 | `orch.mjs run --host <名字>` 能派到的 daemon。值是 `paseo --host` 认的任何形式；配对链接是凭据，只能经名字用，运行只记名字 |

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
事件流是审计，**不是 checkpoint**：运行器不读回它，进程一死这次运行就断了，重跑是新的运行、从头开始，
已经付过钱的调用会再付一遍。续跑长期要做，方向是重放式：从头重跑 `run`，已完成的 `$.ask` 从事件流
返回缓存结果，`$.do` 先记意图再执行，同一次运行加锁防双开；这要求 flow 是确定性的。还没实现。

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
