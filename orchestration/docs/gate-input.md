# 人闸"批准并附一个值"，和几个小时的步骤

两件事，都是让一条流程在中途等人、等机器：

- **A. 批准并附一个值。** 人闸批准的同时拿到一个字符串（比如验证码），只在内存里给 flow 用。
- **B. 长时间步骤。** 一个 `$.do` 要等几个小时（编译、轮询构建进程），后面接一个等人最多 8 小时的人闸。

下面先写调查（带出处），再写选了什么、为什么，最后是怎么验证的和**没验证的**。
出处的写法：`fork:` 是 Paseo 的 fork 源码（只读查的），其余是本仓库。

## A. 调查：一张人闸卡到底能收到什么

人闸载体是 `orchestration-gate` 插件的 provider `orch-gate/card`（不带模型）。它从 daemon 收到的输入只有三种，
都是真实抓到的（`orchestration-gate/server/fixtures/real-responses.json`，临时 daemon 上用 `paseo permit` 应答时，
在 provider 里把 `session.permission` 的整条输入打出来）：

| 应答 | provider 收到 | 出处 |
|---|---|---|
| 权限卡片上点按钮（App、IM 卡片） | `session.permission`，`response: { behavior, selectedActionId: <按钮 id>, message? }`。`selectedActionId` 就是 provider 自己在卡片 `actions` 里给的 id | `fork:packages/app/src/agent-stream/view.tsx` `handleActionPress`：allow 发 `{ behavior: "allow", selectedActionId }`，deny 发 `{ behavior: "deny", selectedActionId, message: "Denied by user" }` |
| 命令行 `paseo permit allow/deny` | 同一种输入，**没有 `selectedActionId`**。`allow` 不带 `--input` 时连 `updatedInput` 都没有：`{ "behavior": "allow" }`；`deny --message x` 是 `{ "behavior": "deny", "message": "x" }`。运行时在到期时替人关卡片，走的也是这条（`message: "gate expired after 12s without an answer"`） | 实测；`fork:packages/cli/src/commands/permit/allow.ts` |
| 卡片挂着时，人在对话底部消息框里写字 | `session.prompt`，`delivery: "steer"`，`clearPendingPermissions: true`。provider 把它记成 `typed` 的拒绝，写的字进 `reason`（`gate.mjs` 里 `via === "typed"` 的分支） | 实测（`paseo send` 到卡片挂着的 agent） |

`answeredVia` 的来龙去脉：provider 只有"应答里有没有它自己给的按钮 id"这一点信息。有 → `button`，没有 → `no-button`，
走 `steer` 的字 → `typed`，卡片被中断关闭 → `interrupt`（不是裁决，运行时判 `error`）。它是**应答方自己发来的东西**，
任何本机进程都能伪造；"谁"点的，Paseo 不记录。这次新增两个值，见下。

**还有第四种：`kind: "question"` 的权限请求。** 这是 Paseo 为 agent 的"向用户提问"做的卡片（Claude 的
`AskUserQuestion`、Codex 的 `request_user_input`），provider 也能发：

- App 对 `request.kind === "question"` 不画标题、说明、`detail` 和 `actions`，画的是 `QuestionFormCard`
  （`fork:packages/app/src/agent-stream/view.tsx` 的 `if (request.kind === "question")`，
  `fork:packages/app/src/components/question-form-card.tsx`）。
- 它读 `request.input.questions[]`：`{ header, question, options, multiSelect, allowOther, allowEmpty, placeholder, dismissLabel }`
  （`question-form-card-core.ts` `parseQuestionFormQuestions`）。**`options` 为空就是一个纯文本输入框。**
- 提交：`{ behavior: "allow", updatedInput: { ...request.input, answers: { [header]: 文本 } } }`；
  右边的"消极"按钮（文案取 `dismissLabel`）：`{ behavior: "deny", message: "Dismissed by user" }`。
  例外：只有一个"允许为空、没有选项"的问题时，点它会**以空答案 allow**（`shouldSubmitEmptyOnDismiss`），
  所以人闸的问题必须 `allowEmpty: false`。
- 命令行 `paseo permit allow <agent> <id> --input '{"answers":{"验证码":"…"}}'` 发的是同一种应答（实测，见夹具）。
- 在 IM 里：本仓库 `feishu/server/questions.ts` 的 `questionsOf` 只认 provider 是 `claude`/`codex` 的问题，
  别的 provider 的问题卡片退成"问题格式无法识别，请到 Paseo 里回答"（读代码得出，**没在飞书里跑过**）。
  公司内部 IM 的插件（它的 `questions.ts` 是从这份拷的）同理，也是读代码，没跑。

## A. 选了什么，没选什么

**选的：input 类人闸起的是一张 `question` 卡片**，一个文本框，两个出口——"提交"（批准，带框里的值）和"不批"
（`dismissLabel`，拒绝）。值不走 `selectedActionId`、不走回执，走它自己的文件。

为什么这样：

- 判据一：人在 App 和 IM 里都不用敲命令。`question` 卡是 App 自带的表单，输入框就在卡片里。
- 判据二：**不会把"打回意见"和"验证码"搞混。** 两个入口的位置不同，卡片上写明白：框里只填值，"提交"才是批准；
  想说理由，点"不批"，再在对话底部的消息框里写（那是 `typed` 的拒绝，和从前一样）。
  对话里打的字**永远不是值**，哪怕它看起来像验证码（有测试）。
- 判据三：弃权、过期、取消的语义不变：没人答 → `expired`；中断 → `error`；"不批"/命令行 deny/对话里打字 → `denied`。
  没有值的 allow（命令行的 `permit allow` 不带 `--input`）**不是批准也不是拒绝**，见下。

没选的：

1. **让对话里的文字回复在 input 类人闸里当"批准并带值"。** 否决。`typed` 现在是"不批 + 意见"，flow 的"打回重做"
   就靠它；同一个入口在两种闸里意思相反，敲错一次就烧验证码，这正是要避免的。再有，打的字会进对话记录，值就不止在内存里。
   而且没有按钮可以点，"批准"这个动作本身变成了"打一行字"，和 `permit allow` 分不出来。
2. **两张卡：先一张确认卡（批准/不批），批准后再起一张 question 卡取值。** 否决。多一次交互、两张卡之间要接状态
   （第一张批了第二张没填、卡在中间怎么算），而 question 卡自己就有"提交/不批"，一张够了。
3. **把值塞进按钮 id、`message` 或回执。** 不可能（按钮 id 是 provider 自己给的；回执是三行固定文本）或不该（回执在事件流里）。

**输入不合格不烧一次作答。** `pattern`（整个值要匹配的正则）和长度由 provider 先查：不合格就不记任何应答、不写文件，
关掉这张卡，用新 id（`gate-<callId>-<n>-r<k>`）再挂一张，卡片最上面写原因（"格式不对（要求：6 位数字）"），**不回显填的内容**。
期限不顺延。这一步在真 daemon 上走通了（见"实测"）：`session.permission_resolved` 之后立刻再发一个 `session.permission`，
daemon 接受，`paseo permit ls` 里看到的是新 id。同一条规则运行时读到值以后**再查一遍**，provider 不照做也不会被当成批准。

## A. 契约

### `$.gate` 的 `input`

```js
const d = await $.gate({
  title: "批准提交 r12 并输入验证码", content: "svn commit -m …\n", timeout: "8h",
  input: { label: "验证码", pattern: "\\d{6}", hint: "6 位数字" },   // secret 缺省 true
});
if (d.approved) use(d.input);   // 只在内存里
```

- `label`（必填，卡片上表单字段的名字）；`secret`（缺省 **true**）；`pattern`（JS 正则源码，**整个值**要匹配，要能编译）；
  `hint`（一句话，写在输入框的占位符和"格式不对"的提示里）。多余的键、类型不对都在调用处抛 `TypeError`，不起卡片。
- 只有载体是 `orch-gate` provider 时能用；角色 `gate` 指向模型时在调用处抛错（模型载体没法收值）。
- 返回的判定对象多一个 `input`：批准时是值，其余结局是 `null`。没有 `input` 的闸，判定对象里**没有**这个键，和从前一样。
- 一个 `secret` 的值至少 4 个字符（太短没法从日志里可靠地抹掉，provider 和运行时都拒）；最长 1000。

### 文件和顺序

| 文件（都在回执旁，`<callId>.…`） | 谁写 | 里面有值吗 |
|---|---|---|
| `request.json` | 运行时 | 没有，只有 `input: { label, secret, pattern, hint }` 和值要放哪（`inputPath`） |
| `input.json` | provider，**只新建** | **有**（`{ v: 1, value }`）。运行时读完立刻删，不管结局；开始前也先删旧的 |
| `answer.json` | provider | 没有，只有 `input: { given: true, secret }` |
| `receipt.txt` | provider | 没有（三行回执，和从前一样） |

provider 的顺序：值文件 → 应答记录 → 回执。任何一步失败，应答记录里写 `error`，运行时判 `error`。
运行时判批准要**同时**：回执对、应答记录是 allow、记录里 `input.given === true`、值文件读得出来、值通过规则。
缺哪样都是 `error`（`by: nobody (the receipt and the answer record disagree)`），`reason` 里不带值。

### 值不进任何记录

- `call.start`（`input` 只有 `label/secret/pattern/hint`）、请求文件、应答记录、对话里 provider 说的话（"已记为批准（值不会显示在这里）"）、
  `call.end.output`（`input` 是 `"<已用>"`）都不含值。
- **兜底**：`EventLog.addSecret(value)`。值一出现（运行时读到它的那一刻），之后写进事件流的**任何字符串**——flow 自己的
  `$.log`、`$.do` 的返回值、错误信息、`run.end.value`，对象的键也算——凡是包含它（原样或 JSON 转义后的样子）都换成 `<已用>`。
  信封字段（`v/seq/ts/runId/kind`）不处理，免得一个短值吃掉时间戳。
- `secret: false`：值照常写在 `call.end.output.input` 里，caveat 里也说了。

### 值经过的地方（照实写）

1. Paseo 的权限应答（`updatedInput.answers`）：App 或 `permit allow --input` 发给 daemon，daemon 转给 provider。
   **Paseo 自己的记录可能有它**：实测在临时 home 里把 daemon 的所有文本文件搜了一遍没有，但没有解开二进制/压缩存储，
   所以不能说没有。caveat 里写了这一句。
2. provider 内存 → `input.json`（明文，在 `<logDir>/runs/<runId>/gate/`，权限随那个目录）→ 运行时读完删除。
   只有运行器进程恰好在"provider 写完、运行时还没读完删掉"之间崩了，文件才会留着；运行器崩了就没有人再清它。
   运行时不扫这类孤儿文件。值本身有时效（验证码），所以没有为这个做清理。
3. 运行时内存 → flow。**flow 之后拿它做什么（写文件、放进命令行、传给子进程）运行时管不了。**
   事件流里的兜底只管事件流；flow 自己写出去的文件不在它管的范围内。
4. 终端里：`orch.mjs run` 结束时打印的 JSON 里的 `value` 是 flow 的返回值，**没经过兜底**（实测，flow 返回了
   `got: true`，要是返回值里放了验证码，终端上就看得见；事件文件里的 `run.end.value` 有兜底）。flow 别把值放进返回值。

### `answeredVia` 的新值

| 值 | 何时 |
|---|---|
| `"form"` | input 闸收到带值的 allow（App 的表单提交，或 `permit allow --input`；两者分不出来） |
| `"dismiss"` | input 闸收到的 deny 的 `message` 恰好是 App 表单"消极"按钮发的 `"Dismissed by user"`（`reason` 为 null）。命令行一样能发这句，所以和别的一样是弱信号 |

别的拒绝（命令行 `permit deny`、到期）在 input 闸上仍是 `no-button`，`reason` 是带的消息；对话里打字仍是 `typed`。

## B. 长时间步骤：已有机制够用，没动运行时

逐条查的（代码 + `test/long-task.test.mjs`，用 node:test 的 mock timers 把 Date/setTimeout/setInterval 换掉，
四小时在毫秒里过完，执行层是假的）：

| 问题 | 结论 |
|---|---|
| `$.do` 有没有时间上限 | **没有。** `run.mjs` 的 `do` 只是 `await fn()`，没有计时器。4 小时的 `$.do` 照常结束，`call.end.durationMs` 是 4 小时 |
| 总超时 `--timeout`，flow 里能不能设 | 缺省**没有**总超时。只能由调用方给（`orch.mjs run --timeout`、`runFlow({ timeout })`），范围 1s 到 596h；**flow 自己设不了**。到点运行以 `timeout` 结束，还在跑的调用补一条 `call.end`（`RunEnded`）。调用方要给就得比"最长编译 + 最长等人"大 |
| 长时间没有事件，会不会被误判成卡死/孤儿 | **"活着"不会。** 活着只看 claim 文件（`<runId>.claim`）每 30 秒被 `setInterval` 碰一次，和事件无关；`readRunState` 在 1h/2h/3h 都是 `running`（有测试）。**"可能卡住"会：** `liveness.staleAfterMs` 对一个开着的 `$.do`（`call.start` 里没有 `timeout`）用 15 分钟的底线，所以一个 3 小时一句话不说的 `$.do`，界面和对账会在 15 分钟后说它"可能卡住"。等人闸、`$.ask` 不受影响（它们的 `timeout` 抬高了底线：gate 8h → 8h2m，有测试） |
| 那个陷阱 | claim 的心跳是**事件循环里的定时器**。`$.do` 里如果同步阻塞几个小时（`execFileSync`、死循环），定时器跑不了，claim 两分钟后就读作"丢了"（`lost`）。长步骤必须是异步的（`spawn`/`await`），别用 `*Sync` |
| `$.gate` 的 `timeout` 放 8 小时，到点替人拒绝有没有问题 | **没有。** `parseDuration` 认 `8h`；到点 `expired`，`reason: no answer within 8h`，运行时对卡片发一次 deny 再 stop 载体（有测试，8 小时在 mock 钟下 10 秒一步）。8 小时约 2900 次 `paseo inspect`；连续 6 次（约 1 分钟）失败会判 `error`——daemon 重启超过 1 分钟本来就会丢掉 provider 里的卡（会话在内存里），所以这是对的，没改 |
| 定期报"还在编译，已 N 分钟"，`$.log` 够不够，界面看得见吗 | **够。** `$.log.info(...)` 写一条事件，立刻把静默时钟归零（测试里每 10 分钟一条，最长静默 10 分钟 < 15 分钟底线）；`$.do` 的 `fn` 是闭包，里面能直接用 `$.log`。界面（`orchestration-ui` 运行详情里"flow 写的日志 N 条"）折叠着，展开看得见，没有单独的进度条 |

要加的话是下面这些，**没做**，因为现有机制够：

- `$.do(name, fn, { timeout })`，写进 `call.start`，让"可能卡住"的底线自动抬高。要改 `orchestration-ui` 和 `reconcile`
  两处读 `call.ask?.timeout ?? call.gate?.timeout` 的地方，三处一起动，不值得为这一个用法。
- 总超时由 flow 声明。

**建议**：长 `$.do` 里每 5–10 分钟 `$.log.info("还在编译，已 N 分钟")`；用异步 spawn，别用 Sync；总超时要么不给，要么给得足够大。

## 实测

2026-10-28，fork CLI 1.4.1，**临时 daemon**（端口 16781、relay 关、home 在临时目录，用完 `daemon stop` 并删除），
插件从本工作树装进去，运行时是真的 `orch.mjs run`，执行层是真的 `paseoExecutor`，人那一侧用 `paseo permit` / `paseo send`：

| 场景 | 结果 |
|---|---|
| 带值批准（`permit allow --input`） | flow 拿到值，`via: form`；事件流、日志目录、daemon home 里搜不到值；`input.json` 已删；`call.end.output.input` 是 `<已用>` |
| 先填 `12ab56`（不合格）再填对的 | 第一次：新卡 `gate-c1-1-r1`，`answer.json` 不存在，对话里一句"上一次填的不符合要求…"，**错的内容哪里都搜不到**；第二次：批准 |
| 命令行 `permit deny --message` | `denied`，`via: no-button`，`reason` 是那句话 |
| 对话里写字（`paseo send`） | `denied`，`via: typed`，`reason` 是那句话 |
| 没人答，12 秒过期 | `expired`，`reason: no answer within 12s` |
| `permit allow` 不带 `--input` | provider 把它当不合格的输入：关卡再挂一张（`gate-c1-1-r1`），没有批准 |

**没验证的：**

- **Paseo App 的真表单**。表单怎么提交、"不批"发什么，是读 `fork:packages/app` 源码得出的，没有在 App 或浏览器里点过。
  夹具里的应答是命令行发的，形状（`updatedInput.answers`、`Dismissed by user`）是源码与命令行实测的交集。
- **IM 渠道**（飞书、公司内部 IM）上这张 question 卡会怎样：读代码，退到"请到 Paseo 里回答"；没跑。要让它们能在 IM 里答，
  各自的 `questionsOf` 要认 `orch-gate`，而且飞书那张问题卡**没有"不批"按钮**，要补。这次没碰这两个插件。
- daemon 自己是否在二进制存储里留下值（只搜了文本文件）。
- 在用的 daemon（没碰：没 reload、没重启）。
- `paseo send` 来自 agent 会话时，对话里的字会被 Paseo 包一层 `<paseo-system …>` 信封进 `reason`（实测看到的）。
  这是已有行为，不是这次引入的；真人在 App 里打的字没有信封。没处理。
