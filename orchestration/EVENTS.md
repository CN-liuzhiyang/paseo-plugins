# 运行事件契约（v1）

> 界面上叫「流程」：下面（和这个目录的其他开发文档）用技术叫法，「运行（run）」就是界面上的一次流程。字段名、事件名、插件 id 都不变。

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
- 没有 `run.end` 的文件表示运行还没结束，**或者进程死了**。怎么分，见下面"运行还活着吗"。
- 运行在第一笔花费之前被拒（输入不合 `inputs`、flow 加载失败、源码扫描发现未声明的阶段）时**不产生
  事件文件**：运行没有开始。调用方从异常里拿到原因。调用方给了 `runId` 时，原因还会写进占位文件的
  `refused` 字段，见下。

## 占位文件和运行还活着吗

调用方可以给运行指定 `runId`（`orch.mjs run --run-id <id>`，选项 `runId`），格式
`^[A-Za-z0-9][A-Za-z0-9._-]*$`、最长 128 字符，不以 `.claim` 或 `.jsonl` 结尾（那是运行自己的文件名），
也不是 Windows 的设备名（`CON`、`NUL`、`COM1`……）。不给就是随机 UUID。**每一次运行**都有一个占位文件
`<logDir>/runs/<runId>.claim`。

事件文件要到 `run.start` 才出现，而运行器在这之前要加载 flow、扫描源码、读角色、检查人闸的 provider，
几秒钟。这段时间里另一个进程拿同一个 `runId` 来起，会发现什么都没有，再跑一遍、再付一遍钱。所以运行器
一开始（加载 flow 之前）就用 `wx`（排他创建，文件系统保证原子）建这个文件：

- 同一个 `runId` 同时有多个进程来起，只有一个建得成，其余报 `RunRefused`，**一分钱不花**，也不碰已有的占位。
  占位文件已存在、或事件文件已存在（占位被人删了），都拒。
- 内容是 JSON：`{ pid, hostname, startedAt }`，持有者的进程、机器和占位时间。
- 持有者每 30 秒碰一次这个文件（`utimes`，只改修改时间）；占位被删了就按原内容重建；连续 3 次碰不动才放弃，
  往事件流里写一条 `log` warn。运行结束（`run.end` 之后）停止碰，文件**保留**，作为"这个 id 用过了"的记录。
- 运行在 `run.start` 之前就结束（输入不合、flow 加载失败、`--affair` 不合格式、命令行参数错、找不到 flow
  名），并且 `runId` 是调用方给的：占位文件留下，多一个字段 `refused`（一行原因，最长 2000 字符），不再被碰。
  `refused` 是先写临时文件再改名覆盖的，读的人只会读到旧的或新的。**这个 id 就用掉了，包括环境类的拒绝**
  （`flowsDirs` 没配好、参数写错）：改好以后要换一个 id 才能重来。`runId` 是随机生成的，没人会来查，占位文件
  直接删掉，和以前一样不留任何文件。
- 它不是事件文件里的一行：`run.start` 必须是第一行，而占位要早于它。
- 另有一种文件：`<runId>.resumed`（和 `.resumed.2`、`.resumed.3`……），是**别人**要接着这个运行跑的占位，见下面"接着跑"。`runId`
  不能以 `.claim`、`.jsonl`、`.resumed`（带不带数字）结尾。
- 读占位文件时解析失败（空文件、半截 JSON），说明它正在被写：**稍等再读**，不是结论。
- 清理日志的人注意：正常结束的运行也留着 `.claim`。同时删掉某个 `runId` 的 `.claim` 和 `.jsonl`，就等于把
  这个 id 放出来了；要么成对删，要么都不删。
- **调用方读的 `logDir` 必须和运行器用的是同一个。** 命令行没有 `--log-dir`，运行器按 `ORCH_LOG_DIR`、config.json、
  默认目录的顺序找。调用方起子进程时显式设 `ORCH_LOG_DIR`，并从同一个值读；在不同进程里各自解析，环境变量
  不一样就会各看各的。

### 读：一个函数

**不要自己照着下面的表写判断，调 `runtime/state.mjs` 的 `readRunState({ dir, runId, spawnedAt })`。** 它读这两个
文件，返回 `{ state, safeToRestart, reason, refused, outcome, processAlive, claim, lastEventAt }`。表本身是数据，
`fixtures/run-state-cases.json`；判断本身是 `runtime/liveness.mjs` 的 `classify`（一个没有 import 的单文件），`state.mjs` 用它，
装在别处的插件带它的一份拷贝（`npm run sync:liveness` 复制，头部标着"由运行时复制，别手改"），每份拷贝的测试都逐行按这张表测、
并比对文字和运行时那份相同——改规则只改 `liveness.mjs`，再跑一次复制。

| `state` | 占位文件 | 事件文件 | 意思，和调用方该做什么 |
|---|---|---|---|
| `absent` | 没有 | 没有 | 没起来，什么都没发生，没花钱。调用方给了 `spawnedAt` 且距今已过 60 秒（`graceMs`）时 `safeToRestart` 为 true，**这是唯一一种可以自动重起的状态**；没给 `spawnedAt` 就不知道，`safeToRestart` 为 false |
| `pending` | 没有 | 没有 | 进程刚起（不到 `graceMs`），导入运行时要几百毫秒到几秒。再看一次 |
| `refused` | 有，内容里有 `refused` | 没有 | 被拒了，`refused` 是原因，没花钱，这个 id 已用掉。不管修改时间多新（写下原因时改过一次），先判这一行 |
| `starting` | 有，最近 2 分钟内碰过 | 没有 | 运行器在做 `run.start` 之前的检查 |
| `running` | 有，最近 2 分钟内碰过 | 有，没有 `run.end` | 运行中 |
| `dead-before-start` | 有，超过 2 分钟没碰 | 没有 | 持有者在 `run.start` 之前停了。没花钱。**不要自动重起**：机器休眠、进程被挂起也会这样，醒来还会接着跑，重起就是同一件事两次运行。交给人判断，要重来换一个 id |
| `stalled-before-start` | 同上，且持有者的 pid 还在 | 没有 | 同上，而且进程还在（也可能是 pid 被别的进程用了）。更不要重起，交给人 |
| `lost` | 有，超过 2 分钟没碰（或持有者的 pid 已经不在） | 有，没有 `run.end` | **失联**：多半死了，已经花的钱看事件文件里已经 `call.end` 的调用。别当它在运行，也不要自动重起 |
| `ended` | 随便 | 有，有 `run.end` | 结束了，结局看 `outcome`；占位文件的新旧已经不重要 |
| `unreadable` | 有，最近碰过，但读不出来 | 随便 | 正在被写，再看一次；超过 2 分钟还读不出来就按过期算 |

没有占位文件、但有事件文件（占位是后来加的，这是旧文件，或占位被人删了）：有 `run.end` 就是 `ended`；没有的
只能用老办法，最后一条事件的 `ts` 超过 15 分钟没动、或同一台机器上 `run.start.pid` 已经不在，就是 `lost`，
否则 `running`。

规则：

- **"活着"只看占位文件的修改时间。** pid 会被系统复用，一个同号的别的进程在，不能说明这次运行在。pid 只用来
  证明**死了**：在持有者那台机器上（`hostname` 一致），pid 不存在，就是死了，不管占位多新（`processAlive: false`）；
  pid 存在什么也证明不了（`processAlive: true` 只是说"进程还在，可能是它，可能是复用"）；别的机器上不查
  （`processAlive: null`）。
- 2 分钟是 4 个心跳。机器休眠或持有者被卡住超过它，会被读成过期。显示上这个方向是对的（宁可显示失联），
  **动作上不行**：对 `dead-before-start`、`stalled-before-start`、`lost` 先隔一个心跳（30 秒）再读一次，修改时间还是
  没变才算数，休眠刚醒来的那一刻不会误判；而且这三种都不自动重起。
- 占位文件的修改时间是文件系统的时间，不是持有者写进去的时间；共享盘、别的主机上的读者判断不了，只能用事件的 `ts`。

## 每一行都有的字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `v` | `1` | 契约版本 |
| `seq` | number | 本次运行内从 0 递增 |
| `ts` | string | ISO 8601 时间 |
| `runId` | string | 运行 id。默认是 UUID；调用方可以给定（见"占位文件和运行还活着吗"） |
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
| `affair` | `{ label, url?, link?, key? }` \| null | 这次运行属于哪件事，调用方给的（`orch.mjs run --affair '<json>'`，选项 `affair`），原样记在这里；没给为 null。后加的字段（2026-10-23），旧文件没有，读者按 null 处理。形状见下 |
| `resumeOf` | string \| null | 这次运行接着的是哪一次运行（`orch.mjs resume <runId>`，选项 `resumeOf`），那一次的 runId；不是接着跑的为 null。后加的字段（2026-10-31），旧文件没有，读者按 null 处理 |
| `resumePrint` | string \| null | 接着跑的运行是从哪个续跑点起的：那个点的**流程名和输入**的指纹（SHA-256 的前 16 位十六进制，对 `{ flow, input }` 的规范 JSON——每一层的键按名字排序——取；`resume-point.mjs` 的 `pointPrint`）。不是接着跑的为 null。读者拿它和自己给人看过的点的指纹比，就知道起来的是不是给人看的那个。后加的字段（2026-10-31），旧文件没有，读者按 null 处理 |
| `lineage` | string | 这次运行属于的那条"线"：一个运行和接着它跑的那些运行共用一份日志（见下面"日志"），线以第一个运行的 runId 为名。不接着谁跑的运行，`lineage` 就是自己的 runId；接着跑的运行取它接着的那一次的 `lineage`。后加的字段（2026-10-31），旧文件没有，读者按 `runId` 处理 |
| `redo` | string \| null | 接着跑时要求重做的步骤名（`orch.mjs resume --redo <步骤>`）：这一步和它之后能撤回的记录这次都当没有；不是则 null。后加的字段（2026-10-31），旧文件没有，读者按 null 处理 |
| `notify` | `{ agent, via }` \| null | 运行结束时要告诉的会话：`via` 是 `explicit`（`orch.mjs run --notify <agent>`，选项 `notify`）或 `caller`（`--detach` 起的后台运行，告诉起它的那个会话）。都没有为 null——负责的会话（steward）不在这里，它由配置和 flow 名定，结果记在 `wake` 事件里。后加的字段（2026-10-31），旧文件没有，读者按 null 处理 |

`affair` 是通用的，运行时不认识任何具体的插件或事务种类，只检查形状；界面只画它拿到的：

| 字段 | 类型 | 限制 |
|---|---|---|
| `label` | string | 必填。1 到 120 个字符（按 Unicode 码点），不含控制字符、换行、改变文字方向的字符、零宽和不显示的字符（零宽空格、软连字符、Hangul 填充符、tag 字符等；连接符 U+200C、U+200D 和 emoji 选择符 U+FE0F 允许），清单在 `fixtures/affair-cases.json` |
| `url` | string | 可选。绝对的 `http` / `https` 地址，最长 2048，不含空白和控制字符，不带用户名密码 |
| `link` | `{ plugin, screen, params? }` | 可选，指向 Paseo 插件的一个屏。`plugin`、`screen`：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；`params`：字符串到字符串，最多 16 个，键同上，值最长 256 个字符、不含控制字符 |
| `key` | string | 可选（后加，2026-10-27），给运行时用、界面不画：什么让两次运行是同一件事。1 到 256 个字符，文本限制同 `label`。没有时身份取 `link`（`plugin`、`screen` 和全部 `params`），再取 `url`；三样都没有就没有身份。同一件事的运行共用一个 Paseo workspace，见下面的 `workspace` 事件 |

- 不合格式、多出不认识的键，运行在花钱之前就被拒（`RunRefused`），不会被"清理"后接受：记下来的就是调用方写下的。
- **读的一方把它当不可信文本**：`label`、`url` 会被画到界面上，文件落盘后谁都改得了。读者自己再校验一遍，不要信文件
  里的内容合乎上面的限制：`url` 只认 `http(s)`，`link` 的 `plugin`、`screen` 不合白名单就当没有。
- 有 `link` 时界面拼成插件屏的路由让人点回去；只有 `url` 就当外链；都没有只显示文字。两个都有，`link` 优先。

### `workspace`

运行带 `affair` 且能认出它是哪件事（`affair.key`，或 `link`、`url`）时，这件事的 agent 和人闸卡片放进同一个 Paseo
workspace（每个目录一个）。第一次要起 agent 的调用要用某个目录的 workspace 时，找到或建好它，发一条。设计和
实测：`docs/affair-workspace.md`。

| 字段 | 类型 | 含义 |
|---|---|---|
| `workspaceId` | string | Paseo 的 workspace id |
| `cwd` | string | 这个 workspace 对应的目录（`$.ask` 的 `cwd` 或运行的 `cwd`） |
| `title` | string | 建的时候发给 Paseo 的标题（最长 120 个字符，按码点；登记文件里也是这一串）；复用已有的时，人可能已经改过名，这里是**这次会用的**标题，不是 workspace 现在的 |
| `key` | string | 事项的身份（带前缀 `key:` / `link:` / `url:`） |
| `created` | boolean | true：这次新建的；false：用了之前某次运行建的 |

- 每个目录最多一条，在用到它的第一个 `call.start` 之前。没有 `affair`、身份认不出、跨机（`--host`）、或者找/建失败时
  **没有这条**；后三种会有一条 `caveat`（`affair: ...`），调用照老办法起 agent，运行不因此失败。
- 之前的文件没有这个事件，读者忽略不认识的 `kind`（见"演进规则"）。

### `resume`

flow 调 `$.resumeWith(...)` 一次写一行（后加的事件，2026-10-31）：这一刻起，如果这个运行没走到头，从哪里、用什么接着跑。

| 字段 | 类型 | 含义 |
|---|---|---|
| `flow` | string | 接着跑要起的流程，**流程名**（不是路径：全小写、数字、连字符），运行时按名字在 `flows/` 和 `flowsDirs` 里找 |
| `input` | object | 那个流程的输入，调用的当下已经按它的 `inputs` 校验过。照样过脱敏：含这次运行当时已知的秘密值的声明不会被记下 |
| `from` | string | 一句话给人看：从哪里接着、有什么会重做或直接做。最多 60 个字符（码点），不含控制字符和改变文字方向的字符，读者当不可信文本 |
| `spends` | `"nothing"` \| `"maybe"` | `nothing`：不调模型；`maybe`：可能调 |

或者 `{ cleared: true }`（`$.resumeWith(null)`）：flow 把之前的声明收回了，这个运行没有可接的地方。

- `resume: "auto"` 的流程不用自己声明：运行一开始运行时就记一条"用同样的输入再跑一遍这个流程"（`spends: "maybe"`），`from` 是运行时按日志写的一句话（"前面 N 步沿用……"），日志每多一条记录就按新情况重写一次、再发一行 `resume`。流程自己调 `$.resumeWith({ ... })` 给的字段盖在它上面（只给 `from` 就不再被重写），`$.resumeWith(null)` 收回。
- **最后一次为准。** 不合格的声明（流程名是路径或找不到、输入对不上那个流程、`from` 不合规、秘密值）**不写这一行**，写一条
  `log` warn 和一条 `caveat`（`resume: …`），运行不因此失败，之前的声明照旧。
- 读者读到的"现在能怎么接"，对**没写出 `run.end`** 的运行（`lost`）就是最后一行 `resume`；对已经结束的就读 `run.end.resume`。

### `phase.start` / `phase.end`

| 字段 | 类型 | 含义 |
|---|---|---|
| `phase` | string | 阶段 id，必定出现在 `run.start.flow.phases` 里 |
| `ok` | boolean | 仅 `phase.end`：阶段内的代码是否正常结束（没抛错）。因 `$.stop` 退出的阶段记 `true`：那是有意结束，不是失败 |

同一阶段可以进出多次（例如循环里反复进入 `debate`）；也可能有并发的阶段。运行结束时还开着的阶段，
在 `run.end` 之前补 `phase.end`，`ok: false`。

### `call.start`

一次调用：agent 调用（`ask`）、脚本自己的动作（`do`）、人闸（`gate`）、流程里做一次的一步（`step`，后加，2026-10-31）。

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string | 本次运行内唯一（运行时写成 `c1`、`c2`……，按开始顺序）。Paseo 上的 agent 带 `orch-run=<runId>` 和 `orch-call=<callId>` 两个标签，两个一起才唯一 |
| `type` | `"ask"` \| `"do"` \| `"gate"` \| `"step"` | |
| `name` | string | `ask`：step 名；`do`：动作名；`gate`：`"gate"` |
| `title` | string | 给人看的标题。`ask`：调用点的 `$.ask(step, input, { title })` → step 的 `define({ title })` → `` `[${name}]` ``，取第一个有的，截到 120 字符，和发给 Paseo 的 agent 标题（`--title`）是同一个值；`do`：`$.do(name, fn, { title })` 的 `title`，没给就等于 `name`；`gate`：`$.gate` 的 `title`，截到 120 字符；`step`：`$.step(name, fn, { title })` 的 `title`，没给就等于 `name` |
| `phase` | string \| null | 所在阶段，不在任何阶段内为 null |

所有 `timeout` 字段是运行时 `parseDuration` 接受的格式：正则 `^\d+(s|m|h)$`，即一个非负整数紧跟一个单位
`s`（秒）、`m`（分）、`h`（时），例如 `90s`、`12m`、`2h`。没有小数、空格、组合（`1h30m` 不合法）。
`ask` 的是单次调用的上限（step 的 `timeout`，没写时为 `30m`）；`gate` 的是等人的上限（默认 `2h`）。

`ask`、`gate`、`step` 另有（后加，2026-10-31，缺省 null）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `reused` | `{ runId, callId }` \| null | 这次调用没有做，是从日志里拿了前面某次运行的结果：那次运行的 `runId` 和它当时的 `callId`（那条记录不是某次调用写的——探查或 `orch.mjs settle` 写的——时 `callId` 为 null）。拿来的 `ask`：没有起 agent，`archive` 为 null，`call.end.cost` 为 null，`call.agent` 和 `call.end.agentId` 是**当初给出这个答案的 agent**（让人能点进去看），不是这次起的；拿来的 `gate`：没有起载体、没有问人，`call.end.output` 是人当时的判定对象原样（含当时的 `decidedAt`）；拿来的 `step`：函数没有跑，`call.end.output` 是当时的值。不是拿来的为 null |

`type: "step"` 另有：

| 字段 | 类型 | 含义 |
|---|---|---|
| `once` | boolean | `$.step` 的 `once`：这一步不能撤回（开始前先落盘，开始了没有结果就不凭猜测再做一遍） |
| `key` | string | `$.step` 的 `key` 的指纹，16 位十六进制（没给 `key` 就是 null 的指纹） |

`step` 没有 agent：`call.end.agentId` 与 `cost` 为 null。`step` 里面的 `ask`、`gate` 是它的子调用，各有各的 `call.start`（`step` 是从日志拿的，就没有这些子调用）。

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
| `archive` | `"after"` \| null | 调用点的 `$.ask(step, input, { archive })`：flow 要求这次调用交卷以后归档它的 agent。没要求为 null。后加的字段（2026-10-29），旧文件没有，读者按 null 处理 |
| `headline` | string \| null | step 的 `define({ headline })`：`schema.properties` 里的一个键，说明回答里哪个字段可以当这次调用的一句话（界面在节点上显示 `call.end.output[headline]`）。step 没声明时为 null。运行时写的每条 `ask` 都有这个字段；之前写的文件没有，读者按 null 处理 |
| `continues` | `{ runId, callId }` \| null | `$.again` 接着问的是哪次调用的 agent：同一个 agent，对话接着往下。现在总是本次运行里的调用（`runId` 是本次的）。这时 `call.agent` 在 `call.start` 之后立刻发，`call.end.agentId` 与那次调用的相同。普通 `$.ask` 为 null。后加的字段（2026-10-31），旧文件没有，读者按 null 处理 |
| `revises` | `{ runId, callId }` \| null | `$.again` 起的是**新** agent（flow 要求 `fresh: true`，或原来的 agent 已经不在、CLI 太旧而退回）：它改的是哪次调用的答案，上一版放在 `<runDir>/answers/<callId>.json`，提示词里说了。和 `continues` 不会同时有。后加的字段（2026-10-31），缺省 null |

`type: "gate"` 另有：

| 字段 | 类型 | 含义 |
|---|---|---|
| `brief` | string | 给审批人的说明（markdown） |
| `content` | string | 待批准的原文 |
| `sha256` | string | 原文指纹：换行符统一、去掉结尾换行后的 sha256，与判定对象里的 `sha256`、回执里的相同。**不是**存着原文的文件的 `sha256sum`，那个看 `bytesSha256` |
| `bytesSha256` | string | 原文原样（UTF-8 字节）的 sha256：flow 把原文原样写进文件时，文件的 `sha256sum` 就是它。核对落盘文件用这个 |
| `timeout` | string | |
| `holdPath` | string | **回执**路径，以 `.receipt.txt` 结尾：人批准后载体把回执写在这里（以前是"原文的暂存路径"，见下）。同一次运行里两个人闸不能共用 |
| `provider` | string | 载体的 `family/model`（角色 `gate`） |
| `fence` | object | 同 `ask`，`mode` 是"每次写都要人批"那一档；`orch-gate` 载体是 `null`、`enforced: true` |
| `prompt` | string | 实际发给载体的完整 prompt。`model` 载体：决定、summary、brief、证据、原文、给载体的指令（brief 和证据过长时被截断的那份）；`provider` 载体：恰好三行，`人闸 <callId> · 运行 <runId>：<title>`、请求文件路径、它的 sha256 |
| `input` | `{ label, secret, pattern, hint }` | 仅在 `$.gate` 带 `input` 时有（后加）：要人填的值是什么。**没有值本身**。`pattern` 无则为 null |
| `carrier` | `"provider"` \| `"model"` | 载体种类：`orchestration-gate` 插件的无模型 provider，或者一个写回执的模型 |
| `contentName` | string | 原文的显示名（高亮、卡片上的"待批全文 x.lua"），flow 没给时是 `content.txt` |
| `summary` | string | 卡片说明（几行纯文本），flow 没给时是空串 |
| `evidence` | `{ label, text, kind?: "diff" \| "text", name? }[]` | 卡片上方折叠展示的证据，按顺序 |
| `receipt` | string | 预期的回执全文：决定、`人闸 <callId> · 运行 <runId>`、`内容 sha256 <原文指纹>` 三行 |
| `requestPath` | string \| null | `provider` 载体读的请求文件（与回执同目录的 `<callId>.request.json`）；`model` 载体为 null |

`carrier` 起的 6 个字段和 `bytesSha256` 是后加的（2026-10-21），之前写的文件没有，读者按 null（`evidence` 按空数组）处理；
`title` 现在是一行（换行和连续空白压成一个空格）；
之前的 `holdPath` 是原文的暂存路径，载体写的是原文而不是回执。

### `call.agent`

一知道某个调用对应哪个 Paseo agent 就发一条，让人在调用进行中就能点进那个 agent 看。

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string | |
| `agentId` | string | |

- 只有 `ask` 和 `gate` 会有；`do`、`step` 没有。从日志拿来的 `ask` 在 `call.start` 之后立刻发一条，`agentId` 是当初那个 agent。
- 每个调用**最多一条**，而且一定在该调用的 `call.end` 之前；调用结束后不再为它发。
- **一个 agent 可以对应多个调用**：`$.again` 接着问的调用带着同一个 agent（`call.start.continues` 指向前一次）。按 `agentId` 归并调用的读者要处理这一点；一个调用对应一个 agent 仍然成立。
- `gate` 在载体 agent 起来之后立刻发。`$.again` 接着问的 `ask` 在 `call.start` 之后立刻发（agent 是已知的，中间至多隔几条 `caveat`）。别的 `ask` 的 agent id 不会随 `run --output-schema` 返回，运行时在后台按
  标签找：调用开始后约 3 秒找第一次，找不到就隔一段再试，总共最多 5 次（约 78 秒内）。所以短调用、
  或者一直没找到的调用，**可能没有** `call.agent`——那时以 `call.end.agentId` 为准。
- 两条都有时，`call.end.agentId` 与 `call.agent.agentId` 相同。

### `call.end`

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string | |
| `ok` | boolean | |
| `durationMs` | number | |
| `output` | any | `ask`：schema 形状的结构化结果，即核对过、合并过的最终答案（没有可以打回的路时回答不合 schema，调用记失败，`error.name` 为 `"OutputMismatch"`；打回用完仍不过，`error.name` 为 `"CheckFailed"`；两种情况 `output` 都是最后手里那份答案）；`do`：返回值（可 JSON 化，过长的字符串会被截断并加 `"…(truncated N chars)"`）；`step`：函数返回的值（也是 JSON，同样的截断）；`gate`：判定对象，见下 |
| `error` | `{ name, message }` \| null | |
| `agentId` | string \| null | 这次调用对应的 Paseo agent（`ask`、`gate` 有；`do`、`step` 为 null；查不到时为 null）。从日志拿来的 `ask` 是当初的 agent |
| `cost` | `{ usd: number \| null, inputTokens: number \| null, outputTokens: number \| null }` \| null | 该 agent 的 `LastUsage`；`ask` 打回过的，是每一轮 `LastUsage` 之和（每一轮单独的在 `call.fixed.cost`）。失败的调用照样有（钱已经花了）。Codex 的 `usd` 是 0，照实给 |
| `rounds` | number | 仅 `ask`：作答了几轮，1 是一次过；打回一次是 2。失败的调用也有（第一轮没交出答案算 1）。后加的字段（2026-10-31），旧文件没有，读者按 1 处理 |

每个 `call.start` 都有且只有一条 `call.end`。运行结束时还没结束的调用（总超时，或 flow 抛错时没等它），
在 `run.end` 之前补一条：`ok: false`，`error.name` 为 `"RunEnded"`，`agentId` 照常查。那个 agent
**没有被停掉**，可能还在跑、还在花钱；之后它的结果不会再进这个文件。

`gate` 的 `output` 就是 `requestApproval()` 的判定对象：
`{ outcome: "allowed"|"denied"|"expired"|"mismatch"|"error", approved, agentId, sha256, askedAt, decidedAt, waitedMs, reason, agentReport, by, agentStatusAtDecision, answeredVia }`。

判定以回执文件为准：

- **回执与 `call.start.receipt` 相同**（换行符统一、去掉结尾换行）：`model` 载体判 `allowed`。`provider` 载体还要
  它的应答记录（`<callId>.answer.json`）是 `allow`；记录缺失、出错或是拒绝时判 `error`（回执和记录对不上）。
  回执推翻不了已经记下的拒绝。
- **有回执但不同**：`mismatch`。
- **没有回执**：到期判 `expired`。`provider` 载体记下了人的拒绝判 `denied`；`model` 载体的 tool 记录里有写回执路径
  的那一行（`[Write] <holdPath>`）判 `denied`。下面这些不是谁的拒绝，判 `error`（以前都记成 `denied`）：
  - 载体被关掉、出错；
  - 运行时收尾时自己发的拒绝（载体出错时卡片还挂着，运行时去关它）；
  - 卡片被中断关闭（停止按钮，或 Paseo 重载、替换这个 agent；`answer.json` 里 `via` 是 `"interrupt"`）；
  - `provider` 载体没留下应答记录；
  - `model` 载体没有写回执路径的那一行（它拒绝当载体，或只调了别的工具），或者读不到它的 tool 记录。
- `provider` 载体的应答记录说"批了"而回执不在，不算批准。
- 已知限制：`model` 载体在挂着卡片时被 daemon 重启打断，tool 记录里有那一行、却没人应答，仍判 `denied`。
  被拒绝的 Write 在 tool 记录里还留着那一行，是读 Paseo 代码得出的，没有实测。

带 `input` 的闸，判定对象另有 `input`（后加）：批准时是值，其余结局为 null；`secret` 的值在事件里写成 `"<已用>"`
（flow 拿到的是真的值），事件流里别处出现的该值也一律换成 `<已用>`（`EventLog.addSecret`）。不带 `input` 的闸，判定对象没有这个键。
批准要求应答记录里 `input.given === true`、值文件读得出来、值通过 `pattern`；缺哪样判 `error`，`reason` 不含值。

`answeredVia`（后加，之前的文件没有，按 null 处理）是应答方自己发来的东西，**弱信号，不是"谁"**：
`"button"` 带着卡片按钮的 id（Paseo App、IM 卡片会带），`"no-button"` 没带（`paseo permit`、到期替人拒绝），
`"typed"` 卡片挂着时有人在对话里打了字（按不批处理）；`"form"` 带值闸收到带值的 allow（App 表单或 `permit allow --input`）；
`"dismiss"` 带值闸收到的 deny 恰是表单"不批"按钮发的 `"Dismissed by user"`（`reason` 为 null）；`model` 载体、过期、出错时为 null（中断判 `error`，也是 null）。
本机任何进程都能发出其中任何一种，所以它挡不住有意伪造；flow 可以用它挡"顺手用命令行批了"，例如写盘只认 `button`。

`reason`：`expired`、`error` 时是运行时确知的原因；`denied` 时，`typed` 是人在对话里打的那句话，`no-button`
是应答里带的消息（例如 `permit deny --message`、到期时运行时自己的说明），`button` 为 null（App 的拒绝按钮只发
固定的 "Denied by user"）。这句话是谁打的，Paseo 不记录。

`agentReport` 是 `model` 载体自己说的最后几句话（取最后 1000 字），不是人的理由：只在有人应答过（`denied`、`mismatch`）时取，只取载体自己的回话，不含它收到的 prompt 和思考；其余结局和 `provider` 载体（它是代码，没有自己的话）为空串。载体什么都没说时也是空串。

`gate` 的 `call.end.ok` 说的是**人闸这个机制**有没有正常走完，不是人批没批：拒绝、过期、内容不一致、
甚至判定为 `error`（内容太长起不了卡片、轮询一直失败）都是 `ok: true`，结论看 `output.outcome`
（或 `output.approved`）。`ok: false` 只在人闸自身抛错时出现（例如起载体 agent 失败），这时 `output` 为 null。

`by` 是给人看的一句话，和 `outcome` 的对应关系固定。目前的取值如下；读者对不认识的值原样显示（以后加上应答方
归属时会出现 `<渠道>:<是谁>` 这一类，例如飞书审计里已有的 `feishu:<open_id>`）：

| `by` | 何时 |
|---|---|
| `"unattributed (Paseo does not record who answered)"` | `allowed`、`denied`、`mismatch`：有人（或别的进程）应答了卡片，Paseo 不记录是谁 |
| `"gate timeout"` | `expired`：到期没人应答，运行时替人拒绝 |
| `"nobody (gate lost sight of the request)"` | `error`：轮询 agent 状态连续失败，不知道发生了什么 |
| `"nobody (no card was raised)"` | `error`：内容太长，`model` 载体的 prompt 超限，卡片没起 |
| `"nobody (the carrier ended without an answer)"` | `error`（后加）：载体被关掉、出错，或者运行时收尾时自己发的拒绝；`provider` 载体没起卡（请求文件对不上）或没留下应答记录；`model` 载体没有写回执路径（`reason` 里带着它说的话）或读不到它的 tool 记录 |
| `"nobody (the carrier was interrupted)"` | `error`（后加）：卡片被中断关闭，没有裁决 |
| `"nobody (the run ended)"` | `error`（后加）：运行结束（总超时、`$.stop`、flow 抛错）时这个闸还在等人。运行器对卡片发 deny、停载体，不读任何回执和值，`reason` 写明运行以什么结束 |
| `"nobody (the receipt and the answer record disagree)"` | `error`（后加）：`provider` 载体有回执，应答记录却不是 `allow`（缺失、出错或是拒绝），`reason` 写明记的是什么；或者反过来，记的是 `allow`、回执却没写出来（`reason` 是 `an allow was recorded but the receipt was not written`） |

### `call.fix` 和 `call.fixed`

`$.ask` 的答案不合 schema，或者 flow 给的 `check` 指出了问题时，运行时在**同一个 agent** 里只把出问题的几处发回去改（`paseo send`），最多 `fixes` 轮（缺省 2）。后加的事件（2026-10-31）。`call.fix` 在发出去**之前**写，让运行视图马上能显示"第 2 轮：在改 /edits/4"；`call.fixed` 在这一轮交回来之后写。

| `call.fix` 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string | 一定是 `ask` |
| `round` | number | 这一轮的序号，从 2 起（第 1 轮是原来那次作答）；同一个调用里递增 |
| `problems` | `{ at, say }[]` | 要改的地方：`at` 是 JSON 指针（`/edits/4/old`），`""` 是整份答案；`say` 是发给模型的一句话。非空 |
| `prompt` | string | 发出去的消息全文。**不含 schema**：CLI 会把 `schema` 字段拼在它后面 |
| `schema` | object | 这一轮的回答要符合的 schema：只含出问题的几处（`{ f1, f2, … }`，每个是原 schema 里那一处的子 schema），或者整份答案时就是 step 的 schema |

| `call.fixed` 字段 | 类型 | 含义 |
|---|---|---|
| `callId`、`round` | | 同它的 `call.fix` |
| `answer` | any | 这一轮交回来的原样：读出的 JSON（只含 `f1`…，整份时是整份答案）；读不出 JSON 时是 agent 写的原文（字符串）；都没有为 null |
| `ok` | boolean | 交回来的是 JSON，而且合这一轮的 schema。不合的地方保持原样，下一轮再问 |
| `cost` | 同 `call.end.cost` | 这一轮的 `LastUsage` |
| `durationMs` | number | |

- 每个 `call.fix` 之后最多一条 `call.fixed`；发送失败（agent 不在了、超时）时没有，错误在 `call.end` 里，那一轮的钱照样记进 `call.end.cost`。
- 都在该调用的 `call.end` 之前；运行已经定了结局之后不再发（调用已经被补了 `RunEnded`）。
- 一个 `ask` 调用里这几条和 `call.agent` 对应的是**同一个 agent**：打回不起新 agent。`$.again` 接着问的调用，打回也在那个 agent 里。
- 运行时没法打回的情况（Paseo CLI 太旧，没有 `send --output-schema` / `--max-retries`，或找不到这次调用的 agent）不写这两个事件，写一条 caveat：该 CLI 自己重试不合 schema 的回答，`check` 指出的问题发不回去，调用以 `CheckFailed` 结束。

### `call.archive`

`$.ask` 带 `archive: "after"` 且这次调用成功（`call.end.ok` 为 true）时，运行时在交卷之后试着归档它的 agent（`paseo archive`，不加 `--force`），**不管成没成都写一条**。后加的事件（2026-10-29）。

| 字段 | 类型 | 含义 |
|---|---|---|
| `callId` | string | |
| `agentId` | string \| null | 要归档的 agent，即 `call.end.agentId`；没找到为 null |
| `ok` | boolean | 归档成了 |
| `code` | string \| null | 没成时的原因：`NO_AGENT`（没找到这次调用的 agent）、`NO_ARCHIVE`（执行层不会归档），或 CLI 自己报的代码：`AGENT_RUNNING`（agent 还在跑，CLI 不加 `--force` 不肯）、`AGENT_NOT_FOUND`（CLI 找不到它；实测 fork CLI 1.4.1 对**后台 workspace 里的 agent** 就是这样，agent 明明在）等；CLI 没给代码时是 `ERROR`。成了为 null |
| `message` | string \| null | 没成时 CLI 的原话，一行，最长 200 字符。成了为 null |

- 每个调用最多一条，在它的 `call.end` 之后、`run.end` 之前；没有 `archive: "after"` 的调用、失败的调用没有这条。
- **起这次运行的一方靠它认出"要求了归档、没归成"的 agent**，不必解析 `caveat` 的文字：`call.start.archive` 是 `"after"`、`call.end.ok` 为 true、`call.end.agentId` 有值，而没有 `ok: true` 的 `call.archive`——包括根本没有这条（进程在交卷和归档之间死了）——就是还没归档的。CLI 归档不了后台 workspace 里的 agent，所以带事项（`affair`）的运行里这是常态，归档由起运行的插件来做（reconcile：运行结束以后读事件文件，按 agent 的标签核对它是这次调用的 agent、没在跑，再用宿主的接口归档；见 `docs/affair-workspace.md`）。
- 运行时自己不再试第二次，也不因为没归成让运行失败。

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

### `wake`

运行结束时告诉谁、告诉成没成，一次运行最多一行，写在 `run.end` **之前**一刻（后加的事件，2026-10-31）。要告诉的人是这样定的，先到先得：
`run.start.notify`（`--notify`，或 `--detach` 起它的会话）→ 前台起它的会话（`run.start.caller` 有值，它自己从命令输出里读结果，不告诉）→ 配置 `stewards`
里这个 flow 的负责会话（flow 名一栏，没有就取 `*`）→ 没人。

| 字段 | 类型 | 含义 |
|---|---|---|
| `to` | string \| null | 收消息的 agent id；没人要告诉为 null |
| `via` | `"explicit"` \| `"caller"` \| `"steward"` \| null | 为什么是它；`to` 为 null 时为 null |
| `ok` | boolean \| null | 有收件人时：消息送到了没有（`send` 命令成了，**不等于它读了**）；没收件人为 null，找负责会话时就出了错为 false |
| `error` | string \| null | 没送成或找不到时的一行原话（最多 300 字符）；送成了为 null |
| `why` | string \| null | 没发的原因，给人看的一句话（没配负责会话、flow 说只听出问题的、前台的会话自己读结果、配置的 agent 不在了……）；同一个 label 下有几个会话时也在这里说「取了第一个」 |
| `started` | boolean | 负责会话是这一下才起的（消息是它的第一条，`ok` 即为 true）；只有 `via` 是 `steward` 时才会是 true |
| `unseen` | number | 这条消息发出前，账里「自从上一条送到负责会话的以来」的运行数，消息里的「账里自上次以来还有 N 次运行」就是它；没有配负责会话为 0 |
| `ledger` | boolean | 这次运行已经记进账本 `<logDir>/steward/ledger.jsonl` 了。有负责会话配置（不管有没有人收到）才记 |

- **送不出去只是这一行，不改变结局**，不写 `caveat` 也不让运行失败。每次投递最长等 30 秒，超时算没送成（`error` 里写「no answer in 30s」）。
- 消息一律是 `paseo send <agent> --prompt-file <文件> --behavior steer --no-wait`：并进对方正在跑的那一轮，不排队等。文件放
  `<logDir>/steward/wake/<runId>.txt`（消息正文，经过脱敏），读者想看发了什么就看它。
- **账本 `<logDir>/steward/ledger.jsonl`** 只追加，一行一次运行：`{ v, at, runId, lineage, flow, affair: { key, label } | null, outcome, why, durationMs, usd, to, via, ok, started }`。
  负责会话隔了一阵被叫醒、或换了一个会话时，靠它知道漏了什么；读者对读不懂的行当没有。
- **失联的运行**（同一台机器上进程已不在、没写出 `run.end`）自己不会发 `wake`，由 `orch.mjs wake-lost` 找出来补发一次：消息里说「失联了」，账本里记一行（`outcome: "lost"`）；
  **不往那个运行的事件文件里写**（它已经没有人在写了）。已经有 `wake` 事件或账本里已经有它的运行不会再发；没有定时器，什么时候跑 `wake-lost` 由人或别的程序定。
- 之前的文件没有这个事件，读者忽略不认识的 `kind`。

### `run.end`（最后一行）

| 字段 | 类型 | 含义 |
|---|---|---|
| `outcome` | `"done"` \| `"stopped"` \| `"failed"` \| `"timeout"` | `done`：flow 返回了；`stopped`：flow 调过 `$.stop`（以第一次为准；之后 flow 就算接住了它、返回了、或抛了别的错，结局也是 `stopped`），或者 `$.ask` 的 `CheckFailed`（答案打回用完仍不过）没有被 flow 接住，`stop.reason` 是 `<step>：核对 N 轮还不过：<第一条问题>`，`value` 为 null；`failed`：抛错；`timeout`：超出运行总时限 |
| `value` | any | `done` / `stopped` 时 flow 给出的结果 |
| `summary` | string \| null | 给人看的一句话结论，来自 flow 的 `summarize(value, { outcome })`（`value` 就是本行的 `value`）。只在 `done` / `stopped` 时调用；flow 没声明 `summarize`、结局是 `failed` / `timeout`、它抛错（这时前面有一条 `log` warn 说原因）或返回的不是非空字符串时为 null。超过 200 字符（按 Unicode 码点算）截断并加 `…`。它出错不影响结局。运行时写的每条 `run.end` 都有这个字段；之前写的文件没有，读者按 null 处理 |
| `stop` | `{ reason: string, phase: string \| null }` \| null | 仅 `stopped` |
| `error` | `{ name, message }` \| null | 仅 `failed` / `timeout` |
| `durationMs` | number | |
| `cost` | `{ totalUsd: number, agentCount: number, partial: string }` \| null | 各 `call.end.cost.usd` 之和；`agentCount` 是这次运行用过的 agent 数（从日志拿来的答案不算：那是前面某次运行起的 agent，这次没花钱）。一个 agent 都没起时为 null。`partial` 是给人看的一句说明，讲 `totalUsd` 少算了什么（现在是：每个 agent 每一轮算它的 `LastUsage`，一个调用的各轮加起来；CLI 在一条命令里自己重试的那几轮只算最后一轮；Codex 报 `CostUsd` 0，所以只含 Claude 系）。原样显示即可，不要解析；内容可能变 |
| `caveats` | string[] | 本次运行所有 caveat 的去重列表 |
| `resume` | `{ flow, input, from, spends }` \| null | 这个运行没走到头时，flow 最后一次声明的续跑点（同上面 `resume` 事件）；没声明或收回了为 null。**`outcome` 是 `done` 时恒为 null**：完成了的运行没有可接的。后加的字段（2026-10-31），旧文件没有，读者按 null 处理 |

## 接着跑

一个没走到头的运行（`stopped`、`failed`、`timeout`，或没有 `run.end` 的 `lost`）能不能接着跑、怎么接，只看上面的 `run.end.resume`
（`lost` 的看最后一行 `resume`）。接着跑是**一次新的运行**：另一个 runId，`run.start.resumeOf` 指向它接着的那一次。

读者怎么判断"这次停下已经被接过了"：看 `<runId>.resumed`（再看 `.resumed.2`……）有没有、里面的 runId 是什么、那个运行现在什么状态。
`orch.mjs resume` 的做法（`runtime/resume.mjs`）：

1. 先独占地（`wx`）建 `<上一段 runId>.resumed`，内容是新的 runId。一个建不成就被拒，什么都没花；
2. 文件已经在：读它里面的 runId，看那个运行——占位里有 `refused`（起来之前就被拒了），或者没有占位也没有事件、而且文件已经建了 60 秒以上
   （`state.mjs` 的 `absent` 且 `safeToRestart`），或者占位在 `run.start` 之前就过期了而且同一台机器上它的 pid 确知已不在（`dead-before-start` 且
   `processAlive === false`：什么都没花，也不会再有人写 `run.start`），这次停下算"没被接成"，换 `.resumed.2`、`.resumed.3` 再占；
   别的状态（在跑、结束了、失联、pid 还在的 `stalled-before-start`……）都算被接了，拒；
3. **没有 `run.end` 的运行只在确知它死了时才接**：`readRunState` 说 `lost` 且 `processAlive === false`（同一台机器上占位里的 pid 已不存在）。
   占位只是过期的、pid 还在的、在别的机器上的，都不接。

接着跑那一段如果又停了，它有自己的 `run.end.resume`，下一次接的是它，不是最初那一段。`resumeOf` 串起来的是一条链。

**给人看过的点就是起来的点。** 调用方（一个页面）把一个续跑点给人看过之后，运行时读到的可能已经不是它（文件被改了，或者一个被判成 `lost` 的运行后来又往下走、声明变了）。
`orch.mjs resume <runId> --expect <指纹>` 在占位之前再读一次上一段的点，指纹（`pointPrint`：流程名和输入，不含给人看的那句话）对不上就拒，什么都不占、不花；
起来的运行在 `run.start.resumePrint` 里记着它从哪个点起，读者事后也能核对。

## 日志（journal）

`$.step`、`$.ask`、`$.again`、`$.gate` 做完的事记在一份**日志**里，接着跑的运行从那里拿，而不是再做一遍。一个运行和接着它跑的那些运行（`run.start.resumeOf` 串起来的一条链）共用一份：

```
<logDir>/runs/<lineage>/journal.jsonl
```

`lineage` 是线上第一个运行的 runId（`run.start.lineage`）。只追加，不改写；一行一个 JSON 对象：

| 字段 | 含义 |
|---|---|
| `v` | 1。读者对不认识的版本，把这一行当"有，但不知道是什么" |
| `id` | 这个位置的名字：`step:<名>`、`ask:<step 名>#<第几次>`、`again:<前一个 id>#<第几次>`、`gate#<第几次>`。在某个 `$.step` 里面的，带上那一步的名字作前缀（`ask:build/analyze#1`、`gate:commit#1`），所以一个被沿用的 `step` 不会把后面的名字挤歪 |
| `kind` | `step` \| `ask` \| `again` \| `gate` |
| `state` | `done`；`begun`（`once` 的步骤开始了，还没有结果）；`failed`（`once` 的步骤抛了错）；`settled`（人用 `orch.mjs settle` 或探查说了结果，`by` 是 `cli` 或 `probe`，`done` 说做没做） |
| `keyPrint` | 做这件事的依据的指纹：`step` 的 `key`；`ask` 的提示词、schema、provider、thinking、effects；`again` 再加上它接着的那份答案和那个 agent；`gate` 的标题和内容。依据变了，这一条就不算数 |
| `value` | 结果（JSON，最多 1 MB；`step` 的值超过或写不成 JSON，这一步失败）。含这次运行的秘密值的，或 `ask` / `again` 的答案过大，不记（这一条干脆没有，接着跑时重做；`once` 的步骤记 `done` 加 `dropped: true`，没有值）。要人填一个值（`input`）的人闸不进日志 |
| `runId`、`callId` | 哪个运行、哪次调用写下的 |
| `at` | 时间 |

同一个 `id` 取**最后一行**。读者对读不懂的行（不是 JSON、没有 `id`、末尾没写完的一行）当没有。日志在运行开始时读一次；一条线上同一时刻只有一个运行在跑（占位文件保证），所以没有锁。

什么算沿用（接着跑的运行里）：

- `step`：`done`，`key` 指纹相同，`still`（若有）说还成立。
- `ask`：指纹相同，而且 step 的 `effects` 是 `none`（会改文件的 agent，答案说明不了文件现在的样子；调用点的 `reuse` 选项让流程看一眼再说）。
- `again`：同上，另外它接着的那份答案、那个 agent 也要和日志里的相同。
- `gate`：只沿用人**批了**或**不批**的，内容指纹相同；过期、出错、内容不一致的，以及要人填值的，每次都重新问。
- `$.do` 不记，每次都做。

`once` 的步骤（不能撤回的）：`before`（若有，是授权它的那张卡，不进日志）跑完以后，先写 `begun` 并落盘（fsync），才执行；做完写 `done`，抛错写 `failed`。接着跑时见到 `begun`、`failed`，或值没记下的 `done`，**不凭猜测再做一遍**：有 `probe` 就先去外面查；没有或查不出，就停下（`stop.reason` 里写着怎么了结）：`orch.mjs settle <runId> <步骤> --done '<值的 JSON>'` 或 `--not-done`，写一条 `settled`，下一个运行按人说的做。只有 `still` 说不再成立的 `done` 才会重做；`key` 变了的不会（做过的事不因为依据变了就再做一遍）。

`orch.mjs steps <runId>` 列出这条线的日志；`orch.mjs resume <runId> --redo <步骤>` 让这一步和它之后能撤回的记录这次都当没有（`run.start.redo`），不能撤回的步骤和人答过的卡不动。

## 演进规则

- 加字段不升版本；读者必须忽略不认识的字段和不认识的 `kind`。
- 后加的字段，旧文件里没有：读者按表里写的缺省处理。`checkEvents` 非 strict 时放过缺失、strict 时要求有。
  目前后加的：`wake` 事件、`run.start.notify`（2026-10-31，缺省分别是没有这种事件、null）；`call.fix` / `call.fixed` 事件、`call.end.rounds`（`ask`）、`call.start.continues` / `revises`（`ask`）（2026-10-31，缺省分别是没有这种事件、没有这种事件、1、null、null）；`resume` 事件、`run.end.resume`、`run.start.resumeOf`、`run.start.resumePrint`（2026-10-31，缺省分别是没有这种事件、null、null、null）；`run.start.lineage`、`run.start.redo`、`call.start.reused`、`call.start.type: "step"` 及它的 `once` / `key`（2026-10-31，缺省分别是取 `runId`、null、null、没有这种调用）；`call.start.archive`（`ask`）和 `call.archive` 事件（2026-10-29，缺省分别是 null、没有这种事件）、`call.start.headline`（`ask`）、`run.end.summary`、`run.start.affair`（2026-10-23），缺省都是 null；`run.start.affair.key` 和 `workspace` 事件（2026-10-27），缺省分别是没有这个键、没有这种事件。人闸的 `call.start.carrier`
  等 6 个字段、`call.start.bytesSha256` 和判定对象的 `answeredVia`（2026-10-21）`checkEvents` 不检查，读者按 null 处理。
- 给 `by` 加取值不升版本：它是给人看的一句话，读者对不认识的值原样显示。
- 改字段含义、删字段才升 `v`。
