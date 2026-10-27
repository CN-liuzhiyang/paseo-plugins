# 同一事项的 agent 放进同一个 workspace

> 实现：`runtime/workspaces.mjs`（找/建、锁、登记），接线在 `runtime/run.mjs`（`$.ask`、`$.gate`），CLI 调用在
> `runtime/executor.mjs`。契约：`EVENTS.md` 的 `workspace` 事件和 `affair.key`。测试：`test/workspaces.test.mjs`。

## 要解决的事

运行时 shell out 调 `paseo run`。没指定 workspace 时，Paseo 按进程目录**新建**一个（调用方本身是 Paseo agent 时，
放进调用方的 workspace）。结果是在用的 daemon 上留下一堆没标题的 workspace：每个 `$.ask` 一个，每张人闸卡
一个（目录是 `<runDir>/gate`）。要看一件事现在在干什么，得一个个点开。

做法：运行带着 **affair**（调用方说这次运行是为哪件事跑的）时，这件事的所有运行里起的 agent 和人闸卡片，放进
同一个 workspace，标题是事项的名字。没有 affair 的运行，一切照旧。

## 实测（2026-10-27，fork CLI 1.4.1，临时 PASEO_HOME 的开发 daemon）

| 命令 | 结果 |
|---|---|
| `paseo workspace create --isolation local --path <dir> --title <t> [--no-background] --json` | 返回 `{ workspaceId, project, name, isolation, cwd, background }`。**不去重**：同目录同标题连建两次，得到两个不同的 id |
| `paseo workspace ls [--background] --json` | 数组，每项 `{ workspaceId, project, name, isolation, cwd, background }`，**没有标签**，只有 `name`（标题）和 `cwd`。只列活跃的，归档了的不在；`--background` 把后台 workspace 也列出来 |
| `paseo workspace rename <id> <title>` | 改标题。所以标题不能当身份 |
| `paseo run --workspace <id> ...` | agent 进了那个 workspace。stderr 打一行 `Using workspace <id>`，**stdout 的 JSON 不受影响**（`--output-schema` 的结构化结果、`--background` 的 `{ agentId }` 都照常） |
| `paseo run --workspace <id> --cwd <另一个目录>` | **`--cwd` 被忽略**：agent 的 cwd 是 workspace 的目录（`inspect` 的 `Cwd`、`ls` 的 `cwd` 一致）。一个 workspace 里的 agent 没法用别的目录 |
| `paseo run --background` | 仍能用，但 CLI 打 `Warning: --background (-d) is deprecated. Use --no-wait instead.`（stderr）。`executor.spawn` 还在用它，不是这次的事，记在这里 |
| `paseo run --workspace <id>`，id 不存在或已归档 | 退出码 1，stdout 空。**stderr 不是纯 JSON**：先一行 `Using workspace <id>`，再是缩进多行的 `{"error":{"code":"WORKSPACE_NOT_FOUND","message":"Workspace not found: <id>"}}`。`--background` 形态（人闸卡片用的）前面还有一行 `Warning: --background (-d) is deprecated. Use --no-wait instead.`。没有创建 agent（`agent ls -g -a` 为空） |
| `paseo run --bogus-flag`（CLI 不认识的选项，老版本不认识 `--workspace` 时同理） | 退出码 1，stderr 是参数解析器的一行纯文本 `error: unknown option '--bogus-flag'`，不是 JSON。同样没有创建 agent |

这几段 stderr 是**逐字**抓的（经运行时自己的 `runPaseo`，和 executor 走同一条路），存在 `test/fixtures/paseo-refusals.json`，
测试里 fake executor 抛的错就是用它做的。夹具里的 workspace id（随机的）换成了占位符 `wks_0000000000000000`，除此之外
没改（里面本来就没有路径或用户名）；"不认识的选项"那段用的是 `--bogus-flag`，测试里把它换成 `--workspace` 来代表老版本 CLI，
这是**推断**，没有真的拿一个老版本 CLI 抓过。第一轮评审我只看了终端里合并显示的输出，把 stderr 当成纯 JSON，
`workspaceRefusal` 因此对整段 stderr 做 `JSON.parse`、在真实形态下一次都认不出来；这是那次的错。
| `PASEO_HOME` 环境变量 | 和 `--home` 一样选 daemon；运行时的 `runPaseo` 原样转交环境，所以实测时设它就能让整个运行器对着临时 daemon |

端到端（真实的 `orch.mjs` + `paseoExecutor`，两个 haiku 调用，一个在目录 `a`、一个在目录 `b`，总共几美分）：

- 同一事项跑两次：第一次建出 2 个 workspace（`Probe affair 7`、`Probe affair 7 · b`），第二次两个都复用
  （`workspace` 事件 `created: false`），4 个 agent 的 cwd 分别是各自 workspace 的目录。
- 同一事项，**3 个 `orch.mjs run` 进程同时起**：daemon 上只多出 2 个 workspace（每个目录 1 个），三个进程都退出码 0。
- 没有在真 daemon 上跑人闸载体（见"失败与限制"）。

## 设计

### 事项的身份（key）

`label` 不唯一，不能当身份。身份按这个顺序取，第一个有的：

1. `affair.key`：调用方给的，**新增的可选字段**（`affair.mjs`，1–256 个字符，和 `label` 同样的文本限制）。
   它只给运行时用，界面不画它（`orchestration-ui` 对 affair 是宽松读，不认识的键丢掉，不用改）。
2. `affair.link`：`plugin`、`screen` 和**全部** `params`（按键排序，所以顺序无关）。
3. `affair.url`。

三样都没有（只有 `label`）：**不建、不用 workspace**，在事件里记一条 caveat，运行照旧。

为什么要有 `key`：`link.params` 里可能夹着不属于"这件事"的东西（比如一个阶段），拿全部 params 当身份，
同一件事的不同阶段就各有一个 workspace。调用方想让它们合一，就给 `key`。

### 谁建、什么时候建

**第一次要起 agent 时**（`$.ask` 校验通过之后、`call.start` 之前；`$.gate` 同理），不是运行一开始：一次什么 agent
都没起的运行（flow 一上来就 `$.stop`，或只有 `$.do`）不会留下空 workspace。同一次运行里每个目录只解析一次
（缓存的是 promise，并行的 `$.ask` 共用同一个）。

### 怎么找已有的：登记文件，不按标题

按标题找不行：标题不唯一，人还会改名。运行时在 `<logDir>/workspaces/<hash>.json` 登记
`(key, 目录) → workspaceId`，`<hash>` 是 `sha256(key + NUL + 规范化目录)` 的前 32 位。用之前问 daemon
（`workspace ls --background`）这个 id 还在不在：

- 在：复用（`created: false`）。人改过标题也照样找到。
- 不在（人归档了）或没有登记：新建，覆盖登记。

只比 id，不比目录：daemon 可能用自己的写法拼目录（斜杠、大小写），比目录会让每次都对不上、每次都新建。
目录已经在登记文件的名字里了。

### 标题

`affair.label`；这次调用的目录不是运行本身的目录时（`$.ask(..., { cwd })` 指到别处），后面加
` · <目录名>`。最长 120 个字符，**按码点**算，不会切开代理对；太长时让的是 label，不是后缀（后缀才是区分两个
目录的那部分）。这个最终文本在运行器里只生成一次，发给 Paseo、写进 `workspace` 事件、写进登记文件的是同一串。

没有按任务书建议的 `<flow 名> · <label>`：一件事下可以有好几个 flow 的运行，它们共用一个 workspace，
标题里写哪个 flow 都是错的。flow 名在每个 agent 的标题和运行视图里本来就有。标题只在建的时候写，
之后不改：人可能改过。

### 目录：按 (事项, 目录) 分

实测 `--workspace` 下 `--cwd` 被忽略，agent 只能在 workspace 的目录里。所以同一事项下 cwd 不同的调用，
各用各的 workspace（`$.ask` 的 `cwd` 选项真的有意义时才会多出来）。运行的 `cwd` 和每个 `$.ask` 的 `cwd`
都算。同一个目录的不同写法（Windows 上的大小写、正反斜杠、`.`/`..`）是同一个目录：运行里缓存解析结果用的键和登记
文件名用的是同一个规范化函数（`normalizeDir`），所以并行的调用不管怎么写这个目录，都只解析一次、只发一条事件；
展示和传给命令的仍是第一个调用写的原样。

### 人闸卡片

`orchestration-gate` 的卡片 agent 现在也带 `--workspace`，放进**运行本身的目录**对应的那个 workspace，
也就是和这次运行的 agent 放一起。它不需要自己的目录：提示词给的是请求文件、回执的绝对路径
（`gate.mjs`），provider 只是把 `config.cwd` 回显在事件里（`orchestration-gate/server/provider.ts`），不拿它读写。
`spawn` 请求里的 `cwd` 仍是 `<runDir>/gate`，这是"想要的目录"，实际落在 workspace 的目录。

**model 载体**（角色 `gate` 被私有角色文件指到某个模型）不动，保持原样：它要自己 Write 回执，换了 cwd 会
不会改变它的权限请求，没验证过。

### 跨机（`--host`）

保持现状，不用 workspace，记一条 caveat。理由：登记文件和锁是本机的，而 `workspace` 命令得在目标 daemon 上
执行；跨机这件事自己还有别的限制（没有父、每次 `run` 在那边新建 workspace，见 CONVENTIONS）。后面要做，
登记文件的名字里加上 host 就行。

### 失败降级

建、列、锁、写登记，任何一步失败（含老版本 CLI 没有 `workspace create` 或 `--workspace`）：

- 不抛，运行不失败；
- 记一条 caveat（`affair: no shared workspace (<原因>); the agents are where Paseo puts them by default`），
  同一个原因一次运行只记一次；
- 这次调用照老办法起 agent（不传 `--workspace`）。

登记写不进去但 workspace 已经建好：这次运行照用，caveat 说"下一次运行会再建一个"。
登记文件在但读不了（半写、被改坏）：当作没有，重建，并记一条 caveat 说"以前为它建的 workspace 可能没被找到"。
一个目录的解析结果（含失败）在一次运行里是缓存的，不会每个 `$.ask` 都重试一遍、各等一次超时。

**选定 workspace 之后、agent 还没创建就被 Paseo 拒绝**（人在这期间归档了它；或者 `workspace create` 能用而 `run`
的 CLI 不认识 `--workspace`）也走这条路，不让运行失败。依据是上面实测的两种拒绝，它们都发生在创建 agent 之前
（`agent ls` 为空）：`workspaceRefusal(error)` 只认 **退出码非 0 的 `PaseoCliError`**，且 stderr 里：从某一行以 `{` 开头起能解析出一个 JSON 对象
（容忍前面的 `Using workspace`、弃用警告和后面的杂行），它的 `error.code === "WORKSPACE_NOT_FOUND"`（`gone`）；或者有一行以
`error: unknown option '--workspace'` 开头（`flag`；正则的 `m` 标志是必要的，参数解析器的那行前面可能有别的行，但它必须是
一行的开头）。**只看 `code` 字段，不看正文里出现的字样**：标题、提示词或错误信息里写着 `WORKSPACE_NOT_FOUND` 的普通失败不会被当成拒绝
（有测试）。认出来时：

- 记一条 caveat；
- 缓存里只丢掉**被拒绝的那一个**结果（别的调用可能已经换了新的）；
- `gone`：重新解析（登记里的 id 已不在 daemon 的列表里，所以会新建），**重试一次**；还是同一个 id（daemon 还列着它却拒绝）
  就不带 workspace 重试；
- `flag`：不带 workspace 重试，并且这次运行里之后的调用都不再要 workspace（不会每个 `$.ask` 各被拒一次）。

重试只发生在这一种情形下，且最多一次。**判断不了就不重试**：别的任何错误（含超时、退出码为空、agent 起来后才失败的
`OUTPUT_SCHEMA_FAILED`）都是调用自己的失败，照旧向外抛——agent 可能已经花了钱、动了东西，再来一遍就是两遍。
人闸卡片的 `spawn` 同样处理。

**验证到什么程度**：识别函数用真实 CLI 的 stderr 形态（上面的夹具）测了，单测和三条回归（归档后第二次 ask、启动前被归档、
卡片 spawn）都用这些形态。另外在临时 daemon 上用真实的 `orch.mjs` 和 `paseoExecutor` 端到端跑了一次：两次 `$.ask` 之间用 `$.do` 把事项的
workspace 归档掉，第二次 ask 被 Paseo 以 `WORKSPACE_NOT_FOUND` 拒绝，运行时记 caveat、重新建了 workspace、重试成功，运行 `done`；
同一场景用改之前的识别函数跑，运行 `failed`，报的正是这个 `WORKSPACE_NOT_FOUND`。**这一条端到端覆盖的是 `ask` 形态；
`flag`（老 CLI）和人闸卡片的真实重试没有在真 daemon 上跑过。**

### 并发

`workspace create` 不去重，所以"查登记 → 问 daemon → 没有就建 → 写登记"整段在一把锁里
（`<hash>.json.lock`，`openSync(..., "wx")`，文件系统保证只有一个进程建得出来），跨进程有效：

- 拿不到锁就每 200 ms 再试，最多等 30 秒；等不到按失败降级，**不是自己去建**，所以不会因为等不到而多建一个。
- 锁文件超过 3 分钟没动算持有者死了，抢过来。（比里面两条 CLI 调用各 60 秒的超时之和长。）
- 同一进程里并行的 `$.ask` 共用一个 promise，根本不进锁。
- 锁里写一个随机 token，释放时**只删自己的**：读出来 token 对得上才删。所以持有者的锁被别人当过期锁接管之后，
  它收尾时不会把新持有者的锁也删了（再带出第三个等待者）。
- 锁文件一创建成功，后面不管写内容还是关文件失败，都把它删掉再抛，不会留下一把没人持有的新锁让后面几次运行各等
  30 秒（评审里的 `ENOSPC` 注入）。

接管过期锁的竞态**没有解决，是已接受的限制**，见下面"失败与限制"。

`workspaces.mjs` 导出的 `lockIo` 是**测试接缝**（让测试能让"锁文件已创建、写内容失败"发生），运行时代码不改它。

### 不自动归档、不自动删

有意的。归档由人决定：workspace 是人看事项进展的地方，一件事收尾后里面的 agent 还有人要翻。登记文件也不清理
（一条几百字节）。

## 事件

新增一种事件 `workspace`（`EVENTS.md`），解析出一个 workspace 时发一次（每个目录一次）：
`{ workspaceId, cwd, title, key, created }`。在用到它的第一个 `call.start` 之前。旧读者按契约忽略不认识的
`kind`（`orchestration-ui` 已经这样做，计入 `unknownKinds`）；`checkEvents` 的 strict 模式认识它。
没有加 `call.start` 的字段：agent 在哪个 workspace 看 Paseo 就行，不为此动 `call.start` 和样例 fixture。
降级走已有的 `caveat` 事件。

## 失败与限制

已接受的，每条说明依据和后果。

1. **接管过期锁有竞态。** 读 mtime 判过期和 `unlink` 是两步。评审用强制时序复现了：两个进程都读到旧锁的 mtime，A 删了旧锁
   并拿到新锁、开始建 workspace，B 按旧判断把 A 的新锁也删了，再自己拿锁——结果两个都 `created: true`，建出两个
   workspace。（不注入时序的三进程正常竞争只建 1 个，我们的真 daemon 实测也是。）token 校验只保证"收尾时不删别人的锁"，
   **不**让接管本身原子，评审也指出光"再查一次 token/mtime"补不上。要严格唯一得换成经过验证的跨进程锁或租约，
   不在这次范围里。触发条件是：上一个持有者死在那一小段里，**并且**两个新运行在同一瞬间都来接管；后果是多一个
   workspace，不是运行失败，也不是永久死锁。**没有加测试**：复现它要在 `statSync` 和 `unlinkSync` 之间插入另一个进程的动作，
   模块没有也不该为此开接缝；所有权校验的部分有测试（`test/workspaces-failures.test.mjs`）。
2. **运行总 timeout 包含等 workspace 的时间。** 全局 timeout 到了就结束运行，此时还在找/建 workspace 的解析会在后台
   做完，但事件流已经关了，不再记 `workspace` 事件（评审实测：timeout=1s，建 workspace 1.1s，结果 timeout、
   没起 agent）。"降级不影响运行"指的是失败不让运行失败，不是这段等待不花预算。默认每条 CLI 调用最多 60 秒，
   等锁最多 30 秒。
3. **自定义 executor 没有外层超时。** 内置的 `paseoExecutor` 每条 workspace 调用有 60 秒超时；测试里或别处注入的
   executor 如果 `listWorkspaces`/`createWorkspace` 永不返回，这个目录的解析就一直挂着（锁也一直被持有）。接口上没有规定超时，
   由 executor 自己负责。
4. **登记读坏了重建，可能留下重复。** 读到的文件不是合法记录时当作没有、新建，并记一条 caveat；以前为这个事项建的
   workspace 不会被认领，会留在 App 里。不校验记录里的 `key`/`cwd`（文件名就是它们的哈希）。
5. **model 载体的人闸没接**：它要自己 Write 回执，换 cwd 会不会改变它的权限请求没验证过。
6. **人闸 provider 没在真 daemon 上跑**（卡片的重试同样只在假 executor 上，用真实 stderr 形态测过）：orchestration-gate 要 `npm ci` 构建，而且会写到插件目录，没有为它动在用的
   目录。验证到的是：同样形态的命令（`run --no-wait --workspace <id>`，claude agent）进了那个 workspace。
   第一次真的发起带 affair 的人闸时看一眼卡片是不是进了事项的 workspace。
7. **多个 daemon**：运行时不传 `--home`，登记文件按 logDir 共用。拿另一个 daemon 的 id 去问当前 daemon 会得到"不在"，
   于是新建并覆盖登记；两个 daemon 轮流跑同一事项才会来回覆盖，没处理。
8. **标题不跟 label 走**：label 里带状态的话（"… · blocked"），建好以后 workspace 的标题就停在建的那一刻。
   不自动改名是因为人可能改过。
9. **一个调用方是 Paseo agent 时**，以前新 agent 进调用方的 workspace，现在带 affair 就进事项的 workspace；
   父子 label（`paseo.parent-agent-id`）不变，App 上的分组照旧。
10. **身份只在一份配置内唯一。** 事项追踪的 `caseId` 是 `<来源>:<编号>`，来源 id 只在一份配置里唯一；几份独立的配置共用同一个
    logDir 和 cwd 时，相同的 `caseId` 会被当成同一件事。要支持就得给 key 加部署命名空间。
11. `executor.spawn` 用的 `--background` 已被 CLI 标为弃用（改 `--no-wait`），另议。

## 已解决

- **事项追踪（reconcile）传的 affair 按阶段拆开**：已解决。`reconcile/server/flows.ts` 的 `affairOf` 现在给 `--affair` 带 `key`，
  来源是 `FlowRec.caseId`（`<来源>:<编号>`，事项本身的 id，不含阶段、轮次；阶段在 `stage`，运行身份另算）。
  长度不超过 256 个字符（码点）就原样用；超过就取前 223 个字符 + `~` + 完整 `caseId` 的 SHA-256 前 32 位，
  总长 256，所以只在 256 个字符之后才不同的两个长 id 仍是两个 key（评审 F5：以前截断后会撞）。链接里的
  `params.case` 仍按旧办法截到 256，它是用来跳回页面的，不是身份。key 不进界面：reconcile 只读 link 的
  plugin、screen、case、stage，orchestration-ui 只取 label、url、link。
