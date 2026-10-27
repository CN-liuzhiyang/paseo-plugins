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
| `PASEO_HOME` 环境变量 | 和 `--home` 一样选 daemon；运行时的 `runPaseo` 原样转交环境，所以实测时设它就能让整个运行器对着临时 daemon |

端到端（真实的 `orch.mjs` + `paseoExecutor`，两个 haiku 调用，一个在目录 `a`、一个在目录 `b`，总共几美分）：

- 同一事项跑两次：第一次建出 2 个 workspace（`Probe affair 7`、`Probe affair 7 · b`），第二次两个都复用
  （`workspace` 事件 `created: false`），4 个 agent 的 cwd 分别是各自 workspace 的目录。
- 同一事项，**3 个 `orch.mjs run` 进程同时起**：daemon 上只多出 2 个 workspace（每个目录 1 个），三个进程都退出码 0。
- 没有在真 daemon 上跑人闸载体（见"未决"）。

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
` · <目录名>`。最长 120。

没有按任务书建议的 `<flow 名> · <label>`：一件事下可以有好几个 flow 的运行，它们共用一个 workspace，
标题里写哪个 flow 都是错的。flow 名在每个 agent 的标题和运行视图里本来就有。标题只在建的时候写，
之后不改：人可能改过。

### 目录：按 (事项, 目录) 分

实测 `--workspace` 下 `--cwd` 被忽略，agent 只能在 workspace 的目录里。所以同一事项下 cwd 不同的调用，
各用各的 workspace（`$.ask` 的 `cwd` 选项真的有意义时才会多出来）。运行的 `cwd` 和每个 `$.ask` 的 `cwd`
都算。

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
一个目录的解析结果（含失败）在一次运行里是缓存的，不会每个 `$.ask` 都重试一遍、各等一次超时。

### 并发

`workspace create` 不去重，所以"查登记 → 问 daemon → 没有就建 → 写登记"整段在一把锁里
（`<hash>.json.lock`，`openSync(..., "wx")`，文件系统保证只有一个进程建得出来），跨进程有效：

- 拿不到锁就每 200 ms 再试，最多等 30 秒；等不到按失败降级，**不是自己去建**，所以不会因为等不到而多建一个。
- 锁文件超过 3 分钟没动算持有者死了，抢过来。（比里面两条 CLI 调用各 60 秒的超时之和长。）
- 同一进程里并行的 `$.ask` 共用一个 promise，根本不进锁。

抢过期锁本身有个小竞态（两个等待者同时抢）；过期锁是持有进程在这一小段里死掉才有的，代价是多建一个，
不是运行失败，接受。

### 不自动归档、不自动删

有意的。归档由人决定：workspace 是人看事项进展的地方，一件事收尾后里面的 agent 还有人要翻。登记文件也不清理
（一条几百字节）。

## 事件

新增一种事件 `workspace`（`EVENTS.md`），解析出一个 workspace 时发一次（每个目录一次）：
`{ workspaceId, cwd, title, key, created }`。在用到它的第一个 `call.start` 之前。旧读者按契约忽略不认识的
`kind`（`orchestration-ui` 已经这样做，计入 `unknownKinds`）；`checkEvents` 的 strict 模式认识它。
没有加 `call.start` 的字段：agent 在哪个 workspace 看 Paseo 就行，不为此动 `call.start` 和样例 fixture。
降级走已有的 `caveat` 事件。

## 未决

1. **事项追踪（reconcile）传的 affair 会按阶段拆开。** 它的 `link.params` 是 `{ case, stage? }`，
   没有 `key`，按上面的规则同一件事的不同阶段各有一个 workspace。想合一，它传 `affair.key`（比如案件号）。
   那边不在这次的范围里，没改。
2. **model 载体的人闸**没接（上面说了原因）。
3. **人闸 provider 没在真 daemon 上跑**：orchestration-gate 要 `npm ci` 构建，而且会写到插件目录，没有为它动在用的
   目录。验证到的是：同样形态的命令（`run --background --workspace <id>`，claude agent）进了那个 workspace。
   第一次真的发起带 affair 的人闸时看一眼卡片是不是进了事项的 workspace。
4. **多个 daemon**：运行时不传 `--home`，登记文件按 logDir 共用。拿另一个 daemon 的 id 去问当前 daemon 会得到"不在"，
   于是新建并覆盖登记；两个 daemon 轮流跑同一事项才会来回覆盖，没处理。
5. **标题不跟 label 走**：label 里带状态的话（"… · blocked"），建好以后 workspace 的标题就停在建的那一刻。
   不自动改名是因为人可能改过。
6. **一个调用方是 Paseo agent 时**，以前新 agent 进调用方的 workspace，现在带 affair 就进事项的 workspace；
   父子 label（`paseo.parent-agent-id`）不变，App 上的分组照旧。
7. `executor.spawn` 用的 `--background` 已被 CLI 标为弃用（改 `--no-wait`），另议。
