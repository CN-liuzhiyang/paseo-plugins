# 编排脚本写法规范

这份文档管的是"怎么写一个编排脚本"。运行时怎么搭的看 [README.md](README.md)，运行产出的事件看
[EVENTS.md](EVENTS.md)。

编排脚本只有一种格式：**flow 模块**。一次 agent 调用的契约叫 **step**。

## flow

```js
import { flow, define, text, count, choice } from "../runtime/flow.mjs";

const analyze = define({
  name: "analyze",
  effects: "none",
  timeout: "12m",
  returns: {
    diagnosis: text("The root cause as you see it."),
    confidence: choice(["low", "medium", "high"]),
  },
  prompt: ({ question }) => `Step back and analyze at the root-cause level.\n\n## Problem\n${question}`,
});

export default flow({
  name: "probe",
  description: "一句话说这个 flow 做什么",
  phases: [{ id: "analyze", title: "分析" }],
  inputs: { question: text("要分析的问题") },
  grants: [],
  async run({ question }, $) {
    const result = await $.phase("analyze", () => $.ask(analyze, { question }, { role: "planner" }));
    return result; // { diagnosis, confidence }，不用解包
  },
});
```

```bash
node runtime/orch.mjs check flows/probe.mjs                 # 不花钱：能查的都查
node runtime/orch.mjs run flows/probe.mjs --question "..."  # 跑
```

**元信息是纯数据**：`name`、`description`、`phases`、`inputs`、`grants` 在 import 时就被 `flow()` 校验，
不执行 `run` 就能读出来。界面据此在运行前画骨架、生成启动表单；`orch check` 据此零花费查错。
五个键加 `run` 全部必填，"没有阶段""没有额外权限"写 `[]`，"没有输入"写 `{}`——和 R2 同一个理由：
缺省值会让两个读者对同一个 flow 有不同的理解。

**`inputs` 用 step 的字段构造器写**（`text`/`count`/`flag`/`choice`/`list`/`group`），同样全字段必填、
不能有别的 JSON Schema 关键字（`default` 之类直接报错）。运行器在**第一笔花费之前**按它校验输入，
不合就拒绝运行、不产生事件文件。命令行上每个输入是一个 kebab-case 的 flag（`hotfixVersion` →
`--hotfix-version`），按类型解析：`text`/`choice` 是字符串，`count` 是数字，`flag` 是 `--x` / `--no-x`，
`list(text())` 重复写 flag；`group` 只能经 `--input <json 或 @文件>` 给。以 `-` 开头的值（写成列表的问题、
负数）照常能传。`input`、`timeout`、`help`
是运行器自己的 flag，不能当输入名。

没有默认值是刻意的：advisor 的 `role`、committee 的 `assessor` 都要调用方写出来。代价是命令行长一点，
换来的是事件里的 `input` 就是这次运行用的全部参数，没有藏在代码里的第二份。

### `$` 上的原语

每个原语对应界面上一种看得见的东西，只有这几个：

| 原语 | 做什么 | 事件 |
|---|---|---|
| `$.ask(step, input, { role?, provider?, thinking?, title?, cwd?, timeout? })` | 一次 agent 调用，返回 schema 形状的结果。**不接受 `mode`**（见 R8）。回答到手后再按 schema 查一遍，不合就抛 `OutputMismatch`（回答照样记在事件里） | `call.start`/`call.end`，`type: "ask"` |
| `$.do(name, fn)` | 脚本自己的确定性动作：读文件、跑 CLI、写文件。返回 `fn` 的值 | `type: "do"`；输出里超过 2000 字的字符串被截断，返回给脚本的是原值 |
| `$.gate({ title, content, brief?, timeout?, holdPath? })` | 人闸，返回判定对象（看 `approved`），只有闸本身坏了才抛错。`holdPath` 不给就放在 `$.ctx.runDir/gate/` 下。要 `gate:deny` grant | `type: "gate"` |
| `$.phase(id, fn)` | 阶段作用域。`fn` 里发起的调用自动带上 `phase`（AsyncLocalStorage，并发的阶段互不串）。`id` 必须在 `phases` 里声明过；同一阶段可以反复进入 | `phase.start`/`phase.end` |
| `$.all(tasks)` | 并发，等全部结束。**永不因为某个任务失败而 reject**，返回 `[{ ok: true, value } \| { ok: false, error }]`，和 `tasks` 一一对应。任务可以是 promise 或返回 promise 的函数 | 无（并发看调用的时间重叠） |
| `$.stop(reason, value)` | flow 主动停下，`value` 是部分结果。它靠抛出实现，**不要 catch 它**；`$.all` 里的任务调了它，等全部任务结束后照样停 | `run.end.outcome = "stopped"` |
| `$.log.info/warn/error(...)` | 给人看的一行，参数按 `util.format` 拼 | `log` |
| `$.ctx` | 只读：`runId`、`caller`、`cwd`、`host`、`runDir`、`events`（事件文件路径）、`role(name)`（解析角色，没有就抛错） | — |

`return value` 就是 `outcome: "done"`。抛错是 `failed`，超过 `--timeout` 是 `timeout`；这两种运行器都照样
写 `run.end`、收成本、带 caveats。结局一定下来，flow 里还在跑的代码（超时后的后台部分、没 await 的分支）
再调任何原语都会抛 `RunEnded`：不会再花钱，也不会再往事件里写。

**`$.all` 的返回形状是刻意的**：R6 以前是约定（"用 `Promise.allSettled`"），committee 手写了 `failures`；
现在失败的任务只是数组里 `ok: false` 的一项，已经付费的结果不会被另一个失败吃掉——除非脚本自己去扔。
`Promise.all` 仍然能用，写了就是有意选择"一个失败全部作废"。

**什么该用 `$.do`**：会进界面、会失败、值得在事后看到的脚本动作——跑校验器、落盘、调外部 CLI。
算一个字符串、拼一个 prompt 不用包。包了的动作，出错时事件里有它，界面上能看出停在哪一步。

### 能在花费前发现的错，都在花费前报

| 时机 | 查什么 |
|---|---|
| import（`check` 和 `run` 都会） | `flow()` 的元信息；每个模块顶层 `define()` 的 step（`effects` 必填、名字、timeout 格式……） |
| 源码扫描（`check` 和 `run`） | `$.phase("x"` 的 `x` 是否声明过；调了 `.gate(` 却没声明 `gate:deny` |
| 运行开始前（`run`） | 输入按 `inputs` 校验；`--timeout` 格式 |
| 每次调用开始前 | 角色存在、thinking 绑定、prompt 读的字段调用方都传了、provider 有栅栏、没传 `mode`、grant 够 |

`orch check` **查不了**的，也列在它的输出里（`notChecked`）：`$.ask` 用的角色名（到调用时才解析——所以
把角色当输入的 flow 要在第一次 ask 之前用 `$.ctx.role()` 自己查，committee 和 advisor 都这么做）；
prompt 渲染（要有输入）；`run()` 里面才定义的 step；换了写法的 `$.phase`/`.gate` 调用（扫描是文本的）；
flow 的逻辑本身。

### 类型

`runtime/flow.d.mts` 给写 flow 用的 API 标了类型：`$.ask(step, ...)` 的返回类型由 `define({ returns })`
推出来，拼错字段、比较一个不存在的枚举值、传 `mode`、进一个没声明的阶段，在编辑器里就是红线。
`test/typecheck/` 是它的探针，每个 `@ts-expect-error` 都是一种必须被抓到的写错：

```bash
npx -p typescript tsc -p test/typecheck   # 本仓库不依赖 typescript，要验时临时拉一个
```

（2026-09-24 用 TypeScript 5.9.3 验过；它还顺带抓到了 committee 里一个在闭包里赋值、类型被推成
`never` 的变量，已经改了结构。）

**`.ts` 的 flow 可以直接跑**：Node 22.18 起默认剥离类型，本机 22.20 实测 `orch run`/`check` 一个 `.ts`
flow 都正常。限制是 Node 的：只能用可擦除的语法（不能有 `enum`、`namespace`、参数属性），import 要写全
扩展名；所在目录的 `package.json` 没写 `"type": "module"` 时 Node 会先按 CommonJS 试一次并打警告。
`.mjs` 照常是主格式。

---

## step

```js
const analyze = define({ name, effects, timeout, returns, prompt });
```

三件事绑在一个对象里，因为它们是**一个**决定。prompt 要了一样 schema 里没有的东西，agent 会老实照
schema 返回，那样东西就静默丢了——没有任何测试能抓到这种错。绑在一起，至少 review 时看得见。
`effects` 也在这里，因为"这一步能碰到多远"是这一步的属性，不是调用点的。

## R1. prompt 说"做什么"，schema 说"交什么"，两边不重复

**不要**在 prompt 里再写一遍"请返回 JSON，包含 diagnosis、plan、confidence 三个字段"。
schema 已经作为硬约束下发给 provider 了，prompt 里那份只会和它漂移。

prompt 该写的是：任务、读哪些东西、有什么前提不能假设、什么算做完。
schema 该写的是：交什么结构、每个字段是什么意思。

这条消掉的是一整类 bug，而不是一处重复。

**prompt 读了调用方没传的字段，会直接报错。** 模板字符串会把缺失的字段渲染成字面上的
`undefined`，agent 照样作答，没有任何检查能发现（`step.mjs` 的 `strictInput`）。
确实"没有"就显式传 `undefined` 或空字符串——那是有意的缺席，照常读取。只管第一层字段。

## R2. 不存在可选字段

`define()` 生成的 schema 一律全字段 `required` + `additionalProperties: false`，
builder 也**不提供** optional。这不是口味问题：

Paseo 的 Codex provider 会递归改写你的 schema
（`paseo/packages/server/src/server/agent/providers/codex-app-server-agent.ts:391-408`）——
给每个 object 节点补 `additionalProperties: false`，并把所有 properties 的 key 全塞进
`required`。Claude 那边则原样透传。所以**一个带可选字段的 schema，在 Codex 上字段一定在、
在 Claude 上可能缺**，脚本分支会在其中一家上拿到 `undefined` 然后静默走错。

真的"可能没有内容"时，用字段自己的词汇表达，而不是让字段消失：空字符串、空数组、
枚举里加一个 `"none"`。flow 的 `inputs` 用同一套规则。

## R3. description 是写给模型的指令

它进 prompt 的上下文，不是给人读的注释。

```js
// 好：约束了模型的行为
whatWouldChangeMyMind: text("The specific finding that would flip this verdict. A falsifier, not a hedge.")

// 没用：模型从字段名就知道了
confidence: choice(["low","medium","high"], "置信度")
```

字段名能自解释的（`answer`、`summary`）可以不写 description。写了就要写成指令。
（`inputs` 的 description 是给人和启动表单看的，写中文的用途说明即可。）

## R4. 判断让模型自陈，脚本不做语义比对

判"两个结论是不是一回事"是泛化问题，不是字符串问题。脚本不要去比对两段文本。

正确做法是让它成为一个 schema 字段，由有上下文的一方回答：
`converged: flag("True only if both positions are substantively the same. Ending the argument is not agreement.")`

description 里那句"结束争论不等于同意"是有用的——它堵的是模型为了收敛而收敛。

## R5. 机制确定，策略智能

这条是 committee 第一次跑起来时，两个模型独立指出来的，现在是本仓库的分界线：

- **该写死的（机制）**：并发、超时、轮数上限、重试与否、事件、清理、schema、栅栏。
- **该是 agent 调用的（策略）**：下一轮问什么、还缺什么证据、该不该停、该找谁。

把策略写死，就等于把"卡住时该问什么"提前替模型答了——而那正是找 agent 来做的原因。
反过来把机制交给模型，就回到 LLM 当调度器，顺序和终止都没有保证。

`flows/committee.mjs` 是这条的样板：循环骨架固定，`assess` step 产出 `nextQuestion`
来驱动下一轮。

需要"动态选 schema"时，是**选**不是**生成**：预先定义 N 个 step，让一个只能输出有限枚举的
step 挑一个。Paseo Hub 对这条的说法是 "Later authority must be bounded by `enum` or `const`
in that output schema"（`public-docs/hub/workflows.md:120`）。让模型自由生成 schema
等于把栅栏取消掉。

## R6. 不自动重试

agent 调用会花钱，可能有副作用。失败了要不要再来一次，是脚本作者的显式决定，
不是运行时替你做的。

并行多个 agent 用 `$.all`：它等全部结束、失败的只是结果里的一项（见上）。钱已经花了，
不要让一个失败吃掉另一个已经拿到的结果。失败的调用在事件里照样有 `agentId` 和 `cost`——
结构化调用中途失败，前面的 token 不退。

## R7. 每个 step 声明自己的 timeout

默认上限是 30 分钟，那是**单次调用**的上限。多步编排会把它叠起来：一个三轮 committee
最坏情况能跑几小时，而你要等到最后才知道。`orch check` 对没写 timeout 的 step 给警告。

同一个 step 在不同 provider 上的耗时差一个量级——2026-09-22 实测，同一个 `analyze`
在 claude-sonnet-5 上花了 **855 秒**，在 codex/gpt-5.6-sol 上只用 138 秒。
同一次 committee 的三轮里，两家各自的耗时也在 33s 到 855s 之间跳。
**按"最慢的那家的最慢一次"估，不要按平均，也不要假设哪家一定更快。**

超时的 step 会失败，所以脚本必须能在中间步骤失败时保住前面已经付费的结果（见 R6）。
整次运行的上限是 `orch run --timeout 2h`（不给就不限；超出 1s 到 596h 的值在运行前被拒——`setTimeout`
过了上限会退化成 1ms，等于第一次调用就超时）；到点时运行以 `timeout` 结束，还在跑的
调用补一条 `RunEnded` 的 `call.end`，它们的 agent **不会被停掉**——停不停由跑它的人决定。

## R8. 栅栏按爆炸半径声明，没被强制的要如实说出来

step 声明 `effects`，**必填、没有默认**：

| `effects` | 含义 |
|---|---|
| `"none"` | 只读、只回答。prompt 末尾自动加一句"不要改任何文件" |
| `"workspace"` | 可以改工作目录里的文件。prompt 末尾自动加一句"只在工作目录里改，不提交、不推送、不发给别的系统" |

**没有第三档。** 对外可见的后果——写别的系统、提交、推送、发消息、写进别人的目录——一律由脚本在
`$.gate` 之后用 `$.do` 执行，不交给 agent。hotfix 就是这么做的：agent 交回文件内容，人批准之后，
脚本写入的是它手里那份原文。旧的 `readOnly: true` 会直接报错并提示改用 `effects`。

`effects` 经 **`runtime/fences.mjs` 的栅栏表**变成 provider 的 mode。脚本里不再出现任何 provider 词汇
（`auto`、`default`），`$.ask` 传 `mode` 直接报错。表里每一格是 `{ mode, enforced, note }`，每个值都写了
依据；`enforced: false` 的格子会在运行里产生一条 caveat，`call.start.fence` 里也有：

| family | `none` | `workspace` | `ask-human`（人闸载体） |
|---|---|---|---|
| claude | `auto`，不强制 | `auto`，不强制 | `default`，强制 |
| codex | `auto`，不强制 | `auto`，不强制 | 不支持 |
| pi | 无 mode，不强制 | 无 mode，不强制 | 不支持 |

表里没有的 family、或某一格不支持，**直接报错**（fail closed），不会退回 Paseo 的默认 mode——那正是
"结构化调用卡在没人应答的权限请求上、花完钱才炸"的来路。

每一格的依据：

- **mode 取值的来源**（源码确认，路径相对 `paseo/packages/server/src/server/agent/providers/`）：
  claude 是 `plan | default | acceptEdits | auto | bypassPermissions`（`claude/agent.ts` 的 `DEFAULT_MODES`）；
  codex 是 `auto | auto-review | full-access`，另有一个列表里不显示、但校验接受的 `read-only` 预设
  （`codex-app-server-agent.ts` 的 `CODEX_MODES`、`MODE_PRESETS`），`auto` = approvalPolicy `on-request`
  + sandbox `workspace-write`；pi 没有 mode，`setMode` 直接抛 "Pi does not expose selectable modes"
  （`pi/agent.ts`），它的权限请求只来自扩展的提问，工具调用不问。`paseo provider ls` 显示的是标签
  （"Default Permissions" 就是 codex 的 `auto`）。
- **claude `none`/`workspace` 用 `auto`**（实测）：`auto` 是唯一既能无人值守跑完、又不是 bypass 的档。
  它用分类器审工具调用，写也会放行，所以不强制。
  **不要"优化"成 `plan`**：plan 的语义是"先出计划、再请求批准执行"，agent 每轮结束都会发一个权限请求。
  没人应答时 Paseo 直接报 `OUTPUT_SCHEMA_FAILED: Agent is waiting for permission before producing
  structured output`——**而且是在 token 已经花完之后**（2026-09-22 实测于 claude-sonnet-5）。
  更麻烦的是善后：那个 agent 不会自己结束，它以 `running` 状态**一直挂着**等人应答（实测挂了一小时，
  `PendingPermissions` 里是 `ExitPlanMode`）。清理要三步——`permit deny <agent> --all`（单给 agent id
  会报缺 req_id）、`agent stop <agent>`（deny 之后它会接着跑，不会自己停）、然后才能 `archive`。
  发现这类孤儿用 `ls -g` 看谁还 `running`。
  `default`、`acceptEdits` 也不行：2026-09-23 一个起草补丁的 step 在 `default` 下读 workspace 外的文档，
  卡在权限请求上，照样花完钱才炸；`acceptEdits` 只自动批编辑，跑命令照样要问（hapi 时代实测）。
- **codex 用 `auto`**：最严的**实测可用**档，但它是 workspace-write，所以 `none` 不强制。`workspace`
  也记为不强制：sandbox 在 Windows 上是否真的拦得住没实测过，而且在 Paseo agent 里起的子 agent，
  工作目录是调用方的 workspace，不是脚本要求的 cwd（见下文 CLI 事实）。隐藏的 `read-only` 预设在源码里
  存在，但没有无人值守实测过：`on-request` 下一旦模型想写就会发权限请求，结局可能和 claude 的 plan
  一样。实测之前不启用。
- **pi 不传 mode**（源码确认，未实测）：私有仓的 `relay-*` 角色走它。
- **`ask-human` 是人闸载体用的那一档**：要的是"每次写都要人批"。claude 的 `default`（Always Ask）
  实测会把载体唯一的一次 Write 挂成权限卡片（2026-09-23）。codex 的 `on-request` 只在命令越出
  sandbox 时才问，工作目录里的写不问，所以不支持；载体角色 `fast` 是 claude。

加一个 provider 就是往表里加一行，并写上每一格的依据。这是有意的：换 provider 应该是一次决定。
跨 provider 统一栅栏语义仍然是空位——这张表只是把"哪里没统一"写成了数据，假装统一了才是 bug。

---

## 命名与放置

**step 名用动词小写**：`analyze`、`assess`、`respond`、`advise`。它描述的是这次调用**做什么**，
不是它返回什么。名字会进事件和 label，改名等于换一条数据线，想清楚再改。

**只服务一个 flow 的 step，就定义在那个 flow 里。** `flows/committee.mjs` 顶部那三个就是。
等到第二个 flow 真的要用同一个 step 了，再提出来——不要预先建 `steps/` 目录，
也不要为"将来可能复用"把 step 放到别处，那只会让读 flow 的人多跳一个文件。

**step 定义在模块顶层。** `orch check` 靠 import 模块来检查 step，`run()` 里面才 `define()` 的查不到。

**角色名写在调用点，不要写进 step。** step 不该知道自己会被哪个模型执行，
那是调用点的决定（`$.ask(step, input, { role })`）。flow 里也只写角色名，不写模型 id——
模型会换，角色名不换。

**flow 名、phase id 用小写加连字符**，phase 的 `title` 是给人看的，写中文。

## 角色：`roles/<name>.md`

一个角色一个文件，文件名就是角色名：

```md
---
provider: claude/claude-opus-5-5
# opus-5-5 默认 medium，opus-5 默认 high；显式钉住，换模型时不会悄悄降档
thinking: xhigh
description: Root-cause analysis, design, planning. Reads a lot before concluding.
---
（可选）这个角色的常驻指令。
```

| 键 | 必填 | 含义 |
|---|---|---|
| `provider` | 是 | `<family>/<model>`，即 `paseo run --provider` 的写法。只写 family 会被拒——那等于"Paseo 今天默认用哪个模型就用哪个"。family 必须在栅栏表里 |
| `description` | 是 | 什么时候选这个角色。给人和给写编排的 agent 看 |
| `thinking` | 否 | thinking 档位 id。**id 按模型不同**，由 smoke 对照 `provider models` 校验 |

**正文会被拼在这个角色每一次调用的 prompt 前面，会被模型看到。** 给人看的备注写在
frontmatter 的 `#` 注释行里，不要写进正文。正文走 prompt 而不是 system prompt，
因为 `paseo run` 没有 system prompt 参数；好处是同一份指令对所有 provider 都生效——
同时面向两种 harness 的项目，每个 reviewer 都得维护两份（`.claude/agents/*.md` 和
`.codex/agents/*.toml`），就是因为每个 harness 只读自己的格式。

**正文放什么**：这个角色无论做哪一步都成立的东西——审查视角的范围与边界、必读文档、
要回避的领域误判。项目自带的 reviewer 定义就是这一类，迁进来时会是第一批有正文的角色。
**不放任务提示词**：同一个 step 会跑在不同角色上——committee 的 `analyze` 同时发给两个成员，
两边拿到同一份 prompt、同一份 schema，答案才可比；任务提示词还必须和它的
schema 待在一起（R1）。现在的角色正文都是空的，因为它们只是模型档位，没有跨步骤成立的视角；
往里写"请仔细""请给依据"这类通用话，每次调用都付 token，还可能和 step 的 prompt 打架。

**不做 `{{占位符}}` 模板。** step 的 `prompt: ({ question }) => ...` 本身就是模板：替换有了，
条件和循环（`assess` 逐个渲染两方立场）直接写 JS，不必再发明一门
模板语言、再维护一套转义规则。占位符方案真正的好处是"缺变量会报错"，这一条已经由 R1
末尾那条拿到了。角色正文不接受变量：随调用变化的信息属于 step 的输入；随环境变化的
（cwd、日期）Claude Code 的 system prompt 本来就带。哪天真出现一个需要运行时事实的角色，
再加一个**封闭的**变量集，缺了就报错——不要开放成任意变量。

解析是**故意严格**的：只认扁平的 `key: value`，不支持嵌套和列表；未知键、重复键、空值、
开了引号没闭合，一律报错并给出文件和行号。拼错的键被静默忽略，等于这个角色静默跑在
默认设置上。注释只能是**独占一行、顶格**的 `#`；行尾的 `#` 不是注释，会成为值的一部分。
加字段就是改 `runtime/roster.mjs` 里的 `FIELDS`，这是有意的——扩展应该是一次决定，
不是一次笔误。

**调用点怎么选角色**（`runtime/roster.mjs` 的 `bindRole`）：

| 传了什么 | 结果 |
|---|---|
| `role` | 用角色的 provider、thinking、指令 |
| 只有 `provider` | 字面调用：不带任何角色，没有指令 |
| 都没传 | 用 `worker`（`runtime/roster.mjs` 的 `DEFAULT_ROLE`） |
| `role` + 不同的 `provider` | 角色指令跑在那个模型上。**角色钉了 `thinking` 时必须同时显式传 `thinking`，否则直接报错**——那个档位未必存在于新模型上，而悄悄丢掉它，正是钉住它要防的"推理深度被悄悄降档" |
| 显式 `thinking` | 永远优先 |

`role: ""` 按未知角色报错，不会被当成"没写"。

**换模型的流程**：改 `provider` → 看一眼 `thinking` 是否还合适（换模型会换默认档）→
跑 `node runtime/smoke.mjs`（校验模型 id、thinking id 都还存在，每个角色都有栅栏）。

**上下文窗口也写在模型 id 里**：`claude-sonnet-5` 是 200K，`claude-sonnet-5[1m]` 是 1M，
在 `paseo provider models claude` 里是两个独立的 id（opus-5-5、fable-5-1 也各有 `[1m]` 版）。
`worker` 用 `[1m]`（2026-09-23 决定：200K 在真实任务里经常不够）。

为什么不用别的形态：`roster.json` 装不下成段的指令；Paseo 自己的 agent profiles
在 CLI 上没有入口（`run --help` 里没有 profile 参数，本机 `list_profiles` 为空，2026-09-23 查）。
committee 的配对不属于角色，放在 `flows/committee.mjs` 的 `COMMITTEES` 里——那是它唯一的读者。

## 一次性的调用

以前有一个不带 step 的自由调用 `agents.run({ prompt })`，现在没有了：`$.ask` 只收 step。一次性的、
探索性的调用就在 flow 里就地 `define` 一个——多写的是 `effects` 和 `returns`，恰好是事后读事件的人
需要知道的两件事。不要为了复用把一次性的 step 提出去（见"命名与放置"）。

---

## `paseo` CLI 的既成事实

这些都实测过，写运行时和 flow 时会撞上：

| 事实 | 影响 |
|---|---|
| `--output-schema` **不能**和 `--background` 同用（`public-docs/cli.md:58`） | 并行只能靠同时跑多个阻塞 `run`，不能 spawn 后再 wait。只有人闸载体（不要结构化输出）是后台起的 |
| 带 `--output-schema` 时 stdout 是**结构化结果**，不含 agentId | 拿不到 agent 句柄。运行时给每次调用打 `orch-run=<runId>` 和 `orch-call=<callId>` 两个 label，调用结束后 `ls -g -a --label ... --label ...` 找回（多个 `--label` 是"且"，`cli/src/commands/agent/ls.ts`），再 inspect 收成本。2026-09-24 实测拿到了 |
| `ls` 默认**只列当前目录**的 agent | 找自己起的 agent 必须加 `-g`，否则 cwd 不同就查不到（已归档的还要加 `-a`） |
| `ls --json` 是**小写** `id/name`，`inspect --json` 是**大写** `Id/Name` | 同一个字段两种写法；只有 `runtime/executor.mjs` 碰这两个命令 |
| `inspect` 的 `LastUsage` 是**最后一轮**，不是累计 | 一次结构化调用只发一个 prompt，按调用收应该是准的（推断）；多轮对话会低估 |
| Codex agent 的 `LastUsage.CostUsd` 是 **0**，token 数照常有（2026-09-23，gpt-6-astra，27k 输入） | `call.end.cost.usd` 照实给 0，`run.end.cost.totalUsd` 只含 Claude 系。要算 Codex 得按 token 自己折 |
| Claude 的 `LastUsage.InputTokens` 只数未缓存的输入（2026-09-24：一次 haiku 调用 `inputTokens: 10`，`usd: 0.075`） | 成本看 `usd`，不要按 token 数估 Claude 的钱 |
| 在 Paseo agent 里起的子 agent，cwd **一律是调用方 workspace 的目录**：`--cwd` 被忽略，子进程 cwd 也不管用（2026-09-23 实测：gate 探针指定了临时目录，agent 仍落在调用方的项目目录） | prompt 里一律给绝对路径。`$.ask` 的 `cwd` 是脚本**要求**的目录，不一定是 agent 实际所在的目录；`effects: "workspace"` 的"工作目录"因此也是调用方的。真要换目录大概得传 `--workspace`，未验证 |
| Claude 的 `plan` 模式每轮结束都会发权限请求 | 无人值守 + `--output-schema` 必炸（`OUTPUT_SCHEMA_FAILED`），且是花完 token 之后。见 R8 |
| 结构化调用中途失败，前面轮次的钱**不会**退 | 失败的调用也收成本；多步编排要让中间失败保住已有结果（R6） |
| `run` 的 prompt **只能**是命令行参数（没有 stdin、没有文件，`cli/src/commands/agent/run.ts`），而 Windows 命令行上限 32767 字符。超了 Node 只报 `ENAMETOOLONG`（2026-09-23 实测：一个 818 行的补丁文件放进 prompt 就超了） | `runPaseo` 超过 `COMMAND_LINE_BUDGET`（32000）直接报错并说明原因。大段输入给文件路径让 agent 读：小于几千字符的内联，更大的只给绝对路径 |
| `run` 没有 system prompt 参数，也没有 profile 参数 | 角色指令只能拼进 prompt；角色表只能自己维护（`roles/`） |
| `--thinking` 的 id 按模型不同，换模型也会换默认档（opus-5 默认 `high`；opus-5-5 默认 `medium`，而且没有 `off`） | 角色里显式写 `thinking`，换模型后跑 smoke |
| `paseo provider ls` 列的是 mode 的**标签**，不是 id（codex 显示 "Default Permissions"，id 是 `auto`） | 栅栏表写 id，来源看 provider 源码 |
| Windows 上 `.cmd` 只能经 cmd.exe 启动 | 运行时直接 spawn `Paseo.exe`（`runtime/paseo-cli.mjs`），参数数组交给 `CreateProcessW`。中文 prompt 和内联 JSON schema 才能原样到达 |

最后一条的反面教训：用 PowerShell 把内联 JSON schema 传给 `paseo.cmd`，引号会被吃掉，
报 `INVALID_OUTPUT_SCHEMA`。

---

## 父子关系是怎么来的

本运行时**不传父 id**。App 上子 agent 挂在调用方下面，靠的是环境变量隐式传递，链路全在 Paseo 里
（路径相对 `paseo/packages/`）：

1. Paseo 启动每个 agent 时往它的环境里写 `PASEO_AGENT_ID=<它自己的 id>`
   （`server/src/server/agent/agent-manager.ts:5150-5155`）。
2. `runtime/paseo-cli.mjs` spawn `Paseo.exe` 时原样转交 `process.env`。
3. `paseo run` 读这个变量当 `callerAgentId` 发给 daemon（`cli/src/commands/agent/run.ts:745-750`，
   用在 `:626`、`:697`）。
4. daemon 给新 agent 打 `paseo.parent-agent-id=<调用方>` label；没传 `--workspace` 时还把它放进
   调用方的 workspace（`server/src/server/agent/create-agent/intent.ts`）。App 按这个 label 分组
   （`app/src/utils/agent-snapshots.ts:101`）。

2026-09-22 实测：从 Paseo agent 里跑 committee，子 agent 在 App 上挂在调用方下面；
当时审计里 69 条记录的 `caller` 全是同一个 id。现在事件里的 `run.start.caller` 就是这个变量。

由此而来的几条：

- **不要在 `runPaseo` 里清环境变量**，清了父子关系就断了。
- **嵌套自然成树**：子 agent 里再跑编排，Paseo 给它注入的是它自己的 id，覆盖继承来的那个，
  孙辈挂在它下面。（源码确认，未实测）
- **在普通终端里跑没有父**；不传 `--workspace` 时每次还会新建一个 workspace（`run.ts:527-533`
  的优先级注释）。
- **父被 archive，带这个 label 的子 agent 跟着 archive**（`agent-manager.ts:1756` 起，
  另有一个 `shouldDetachFromArchivedParent` 分支没细看）。找回 agent 因此要带 `-a`，现在已经带了。
- **身份是自报的。** daemon 只查这个 id 存不存在（`server/src/server/session.ts:4324-4328`），
  不验证调用的真是它；任何继承了或手工设了这个变量的进程都能以它的名义建 agent。事件里的
  `caller` 和 App 上的父子关系是声明，不是认证，不能当权限依据——grants 由本运行时在进程内检查，
  Paseo 并不知道它们。
- **跨机时大概会炸（只读了代码，未实测）。** 带 `--host` 时本机的 `PASEO_AGENT_ID` 也会发给
  远端 daemon，远端没有这个 agent，按上面那段代码会报 `Caller agent ... not found`。
  第一次跨机派活时先验证；属实的话，`runPaseo` 在 `host` 非空时要去掉这个变量，
  代价是远端 agent 在 App 上没有父。

---

## 人闸：`$.gate`

flow 要停下来等人拍板时，用 `$.gate({ title, content, brief, timeout, holdPath })`，flow 要声明
`grants: ["gate:deny"]`。实现在 `runtime/gate.mjs` 的 `requestApproval`。

**载体是 Paseo 的权限请求。** 脚本自己发不出权限请求，所以人闸起一个 `fast` 角色的 agent，
跑在栅栏表 `ask-human` 那一档（claude 的 `default`，Always Ask），唯一的任务是把待审内容 Write 到
`holdPath`。人在 App 的权限卡片上看到的就是这次 Write，卡片会渲染工具调用详情，所以看到的是**原文**，
不是摘要。批准，文件落地；拒绝，文件不在。`brief` 排在载体 prompt 的最前面，人在卡片上方的对话里
先看到它：校验结果、起草方自报的风险、要实现的改动。

**结果只看文件，不看 agent 说了什么**：文件存在且内容与 `content` 一致（换行符和结尾换行
不计），判 `allowed`；不存在判 `denied`；内容不一致判 `mismatch`，按未批准处理。真正的写入
由脚本随后用 `$.do` 自己做，写的是脚本手里的原文。agent 只是载体，不是写入方。

为什么这样搭，而不是让脚本在终端里等人输入：

- 人本来就在 Paseo 里，权限卡片是现成的裁决界面，手机上也能批。
- `paseo wait` 能区分"卡在权限请求上"（`status: permission`）和"结束了"。之前用过的另一个
  底座区分不了这两种状态，这是换到 Paseo 之后白捡的能力。

已知的缺口，照实记下：

| 缺口 | 后果 |
|---|---|
| Paseo 不记录**谁**应答的；任何能跑 `paseo permit allow` 的进程都能应答 | 决定记为 `unattributed`，不写成"人批准的"，并作为一条 caveat 进运行。`gate:allow` 这个 grant 不存在，flow 声明它直接报错 |
| App 的拒绝按钮不带理由；`permit deny --message` 的理由只送到 agent，不回给脚本 | `reason` 只记运行时确知的（超时）；agent 转述的原话另存为 `agentReport`，标明是转述。**命令行不是给人用的审批渠道**，不要让人去敲 `permit deny`。方向见下 |
| 过期（默认 2h）时运行时替人**拒绝** | 需要 `gate:deny` grant。拒绝是保守方向，所以可以给 |
| 载体是模型，抄长内容可能抄错 | 抄错判 `mismatch`，失败方向是"没批准"，不会误放行。实测 haiku 257 行一字不差 |
| 内容在载体的 prompt 里，prompt 受命令行长度限制 | 超过 30000 字符直接判 `error`、不起卡片（一个 818 行的补丁就超了）。改成让载体先 Read 文件，人会先看到一张 Read 卡片，所以没这么做；真要解，得让 Paseo 接受文件形式的 prompt（fork 扩展点或插件） |

实测（2026-09-23）：拒绝路径——`permit deny --message` 的理由原样到达 agent，文件未写；
过期路径——40 秒到期后自动拒绝，判 `expired`；批准路径——一个真实补丁的回放由人在 App 上批准。
这一轮（2026-09-24）人闸改成经 `$.gate` 调用、mode 改由栅栏表给出，三条路径在假执行层上有单测，
**没有经真实 Paseo 再跑一次**。

**审批渠道的方向**：判定语义（结果只看文件、超时替人拒绝、没有 `gate:allow`）与渠道分开，
渠道要能有多种：

- **Paseo 里要展示得更好**——主渠道。现在的权限卡片只是一张 Write 工具调用卡，缺标题、上下文
  （单号、diff、校验结果）和理由输入框。改进方向是插件或 fork 扩展点，属于"能做成插件就做插件"；
  事件流里 gate 的 `call.start` 已经带着标题、brief、原文和暂存路径。
- **在 Paseo 对话里审批**——过渡期可用：人在对话里说"批 / 拒，理由是……"，由会话里的 agent
  代为应答。这时 agent 是执行者、人是决定者，审计要能关联到那句话；这和 Orchestrator
  "自己拿主意批"不是一回事。
- **IM 卡片**（本仓库的 `feishu/` 插件，公司内部 IM 同理）——渠道不同，判定语义不变。卡片能带
  输入框，拒绝理由可以回到脚本；回调里带着点按钮的人，"谁批的"也有了着落（待实测）。

## 事件里有什么

每次运行一个文件 `<logDir>/runs/<runId>.jsonl`，契约是 [EVENTS.md](EVENTS.md)。它替代了以前按天的
审计文件（旧文件原地保留，不再写）：两份记录同一批调用，迟早会对不上。两条不变量不变：

- **模型看到的都有记录**：发给模型的每个 prompt 完整地在 `call.start.prompt` 里（人闸载体的也在），
  每个结构化回答在 `call.end.output` 里。flow 让 agent 去读的文件，要放在 `$.ctx.runDir` 或别的留存处，
  这一条才对 prompt 之外的部分也成立——hotfix 的 diff、草稿就是这么留的。
- **prompt 存全文**，不做摘要：评测语料从这里来，摘要没法回放。

每个 ask 带 `schemaFingerprint`（schema 的 sha256 前 8 位）。指纹是给评测语料用的——同一个 step 名下，
schema 改过之后产生的数据不能和改之前的混在一起比。改了 `returns` 就会换指纹，这是设计如此，
不用去保持稳定。
