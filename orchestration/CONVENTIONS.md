# 编排脚本写法规范

> 界面上叫「流程」：下面（和这个目录的其他开发文档）用技术叫法，「运行（run）」就是界面上的一次流程。字段名、事件名、插件 id 都不变。

这份文档管的是"怎么写一个编排脚本"。运行时怎么搭的看 [README.md](README.md)，运行产出的事件看
[EVENTS.md](EVENTS.md)。

编排脚本只有一种格式：**flow 模块**。一次 agent 调用的契约叫 **step**。

## flow

```js
import { flow, define, text, count, choice } from "../runtime/flow.mjs";

const analyze = define({
  name: "analyze",
  title: "根因分析",        // 可选，给人看的
  headline: "diagnosis",   // 可选，给人看的
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
  summarize: (value) => value.diagnosis, // 可选，给人看的
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

**`summarize(value, { outcome })` 是唯一可选的键**，因为它不改变运行，只给人一句话：运行以 `done` 或
`stopped` 结束时调用一次，`value` 是 `run.end` 记下的那个值（`stopped` 时是 `$.stop` 给的部分结果），
返回的字符串进 `run.end.summary`，节点图的结论条显示它。超过 200 字符会被截断。它抛错、返回非字符串，
都只是一条 warn 加 `summary: null`，结局不变——所以不必为它写防御代码，但也别在里面做事情，它是同步调用、
不 await 的。committee 的写法可以照抄：收敛了说第几轮、结论是什么，没收敛说分歧是什么。

另两个可选键（`resume`，见「接着跑」；`wake: "problems"`，见「跑完叫醒」）同样不改变运行本身，只改变别人怎么对待它。

**`inputs` 用 step 的字段构造器写**（`text`/`count`/`flag`/`choice`/`list`/`group`），同样全字段必填、
不能有别的 JSON Schema 关键字（`default` 之类直接报错）。运行器在**第一笔花费之前**按它校验输入，
不合就拒绝运行、不产生事件文件。命令行上每个输入是一个 kebab-case 的 flag（`hotfixVersion` →
`--hotfix-version`），按类型解析：`text`/`choice` 是字符串，`count` 是数字，`flag` 是 `--x` / `--no-x`，
`list(text())` 重复写 flag；`group` 只能经 `--input <json 或 @文件>` 给。以 `-` 开头的值（写成列表的问题、
负数）照常能传。`input`、`timeout`、`host`、`cwd`、`help`、`runId`、`affair`、`notify`、`detach`
是运行器自己的 flag，不能当输入名。

没有默认值是刻意的：advisor 的 `role`、committee 的 `assessor` 都要调用方写出来。代价是命令行长一点，
换来的是事件里的 `input` 就是这次运行用的全部参数，没有藏在代码里的第二份。

2026-09-24 迁第一个参数多的私有 flow 时重新考虑过，结论仍是**不加默认值**：参数多就把常用的一组写进
JSON 文件，用 `--input @args.json` 传，文件本身就是那份可复用、看得见的默认。"按模式二选一"的输入
写成 `mode: choice([...])` 加一个在另一种模式下传空串的字段，模式和字段对不上时在第一笔花费前报错。
真要加默认值时，形状是构造器的显式参数（`text("…", { default: "worker" })`），并且运行器要把补上的值
写进 `run.start.input`，不能破坏上面那条。

### `$` 上的原语

每个原语对应界面上一种看得见的东西，只有这几个：

| 原语 | 做什么 | 事件 |
|---|---|---|
| `$.ask(step, input, { role?, provider?, thinking?, title?, cwd?, timeout?, archive?, check?, fixes?, reuse? })` | 一次 agent 调用，返回 schema 形状的、核对过的结果。**不接受 `mode`**（见 R8）。回答到手后先按 schema 查（多出来的字段直接删，不算错），再跑 `check`；有问题就在**同一个 agent** 里只把出问题的几处发回去改，见下「核对和针对性打回」；没有路可以发回去时（CLI 太旧、执行层不会 `send`）schema 不合还是抛 `OutputMismatch`（回答照样记在事件里）。`title` 是这一次调用的标题，优先于 step 的 `title`。`archive: "after"`：调用交卷（没失败）以后运行时把这个 agent 归档（`paseo archive <id>`，不加 `--force`）；提示词全文和交回的结果本来就在事件里，agent 本身不是需要人去翻的地方。失败、超时的调用不归档（留着查）；找不到 agent、还在跑被拒、归档报错只记一条 `caveat`，不让运行失败，每次试都写一条 `call.archive` 事件（成没成、CLI 的代码）。事项 workspace 里的 agent（后台的）CLI 归档不了，交给起这次运行的插件归档（reconcile 读 `call.archive` 做）。缺省不归档：事后还有人要接着翻、接着聊的会话，由 flow 自己决定。`reuse` 见「做过的事不重做」 | `call.start`（带 `archive`）/`call.agent`/`call.fix`/`call.fixed`/`call.end`（带 `rounds`）/`call.archive`，`type: "ask"`；`call.agent` 是后台按标签找到 agent 时发的 |
| `$.again(prev, text, { fresh?, check?, fixes?, archive?, title?, timeout?, role?, provider?, thinking?, cwd? })`、`$.again(prev, step, input, …)` | 接着问 `prev`（`$.ask` / `$.again` 返回的那个对象，原样传）的那个 agent，返回新的整份答案。`role` / `provider` / `thinking` / `cwd` 只在 `fresh: true` 时能给。见下「接着问：`$.again`」 | `call.start`（带 `continues` 或 `revises`）/`call.agent`（接着问的一开始就发）/…/`call.end`，`type: "ask"` |
| `$.do(name, fn, { title? })` | 脚本自己的确定性动作：读文件、跑 CLI、写文件。返回 `fn` 的值。`title` 给人看，不给就用 `name` | `type: "do"`；输出里超过 2000 字的字符串被截断，返回给脚本的是原值 |
| `$.gate({ title, content, name?, summary?, brief?, evidence?, timeout?, holdPath?, input? })` | 人闸，返回判定对象（看 `approved`），只有闸本身坏了才抛错。`title` 写成决定句；`holdPath` 是回执路径，不给就放在 `$.ctx.runDir/gate/` 下。`input: { label, secret?, pattern?, hint? }`：批准的同时带一个值（验证码），见下「批准并附一个值」。要 `gate:deny` grant；会动用人闸的 flow 在载体不可用时开跑前就被拒 | `type: "gate"` |
| `$.step(name, fn, { key?, still?, once?, probe?, before?, title? })` | 流程里**做一次**的一步：同一条线（一个运行和接着它跑的那些）里，`name`、`key`（它依赖的东西，任何 JSON）都没变，就拿上次的值，不再执行 `fn`。`fn` 的返回值是 JSON（最多 1 MB）。`once: true` 是不能撤回的事（提交、发出去）：先写"开始了"再做，开始了没有结果就**不凭猜测再做一遍**。`name` 在一个运行里只用一次。见下「做过的事不重做：`$.step` 和日志」 | `call.start`/`call.end`，`type: "step"`（带 `once`、`key`、`reused`） |
| `$.phase(id, fn)` | 阶段作用域。`fn` 里发起的调用自动带上 `phase`（AsyncLocalStorage，并发的阶段互不串）。`id` 必须在 `phases` 里声明过；同一阶段可以反复进入 | `phase.start`/`phase.end` |
| `$.all(tasks)` | 并发，等全部结束。**永不因为某个任务失败而 reject**，返回 `[{ ok: true, value } \| { ok: false, error }]`，和 `tasks` 一一对应。任务可以是 promise 或返回 promise 的函数 | 无（并发看调用的时间重叠） |
| `$.stop(reason, value)` | flow 主动停下，`value` 是部分结果。调用的那一刻运行器就记下这次停止（第一次为准），之后任何新的调用、阶段都抛 `RunEnded`。它也会抛出以便中断当前代码，但**接住它没有用**：结局照样是 `stopped`，接住之后想接着花钱会被拦下。`$.all` 里某个任务调了它，其他任务里已经在跑的调用照常结束，新的起不来 | `run.end.outcome = "stopped"` |
| `$.resumeWith({ flow, input, from, spends })` | 说这个运行如果没走到头，**从哪里接着、用什么接着**：另一个流程（可以是自己）的名字、它的输入、一句话给人看、会不会调模型。四个字段都必填；`resume: "auto"` 的流程只给与"用同样的输入再跑一遍"不同的那几个（`input`、`from`、`spends`）。随时调，**最后一次为准**，`null` 收回。当下就校验（流程按名字找得到、输入合它的 `inputs`、`from` 合规），不合格只写一条 `log` warn 和一条 `caveat`、不记下，**不让运行失败**。结局是 `done` 时不记（完成了的运行没有可接的）。见下「接着跑」 | `resume`；结局时 `run.end.resume` |
| `$.log.info/warn/error(...)` | 给人看的一行，参数按 `util.format` 拼 | `log` |
| `$.ctx` | 只读：`runId`、`caller`、`cwd`、`host`、`runDir`、`events`（事件文件路径）、`lineage`（这条线第一个运行的 id）、`lineDir`（`<logDir>/runs/<lineage>/`，线上每个运行看到同一个目录）、`resumed`（这个运行是不是接着别的运行）、`role(name)`（解析角色，没有就抛错） | — |

`return value` 就是 `outcome: "done"`。抛错是 `failed`，超过 `--timeout` 是 `timeout`；这两种运行器都照样
写 `run.end`、收成本、带 caveats。结局一定下来（flow 返回、抛错、超时，或第一次 `$.stop`），flow 里还在跑的
代码（超时后的后台部分、没 await 的分支、接住了 stop 的 catch）再调任何原语都会抛 `RunEnded`：不会再花钱，
也不会再往事件里写。

**`$.all` 的返回形状是刻意的**：R6 以前是约定（"用 `Promise.allSettled`"），committee 手写了 `failures`；
现在失败的任务只是数组里 `ok: false` 的一项，已经付费的结果不会被另一个失败吃掉——除非脚本自己去扔。
`Promise.all` 仍然能用，写了就是有意选择"一个失败全部作废"。

**什么该用 `$.do`**：会进界面、会失败、值得在事后看到的脚本动作——跑校验器、落盘、调外部 CLI。
算一个字符串、拼一个 prompt 不用包。包了的动作，出错时事件里有它，界面上能看出停在哪一步。

### 核对和针对性打回：`$.ask` 的 `check` 和 `fixes`

答案的格式脚本核得出来（提交说明的占位、补丁命中数、文件在不在），就写成 `check`，不要写第二个 step 去"改写"：

```js
import { pointer } from "paseo-orchestration/runtime/flow.mjs";

const patch = await $.ask(patchStep, input, {
  role: "worker",
  check: (a) => a.messages.flatMap((m, i) => (m.text.includes("{code}") ? [] : [{ at: pointer("messages", i, "text"), say: "要有且只有一个 {code} 占位" }])),
});
```

- `check(answer, { round })` 同步异步都行，返回问题清单 `[{ at, say }]`；空清单、`null`、`undefined` 都算过，返回一个字符串等于 `{ at: "", say }`。
  `at` 是 JSON 指针（`pointer("edits", 4, "old")` 拼，处理 `/` 和 `~`），`""` 是整份答案；`say` 写给模型看，说哪里不对、要什么样。
  拿到的是答案的拷贝，改它不影响运行时手里那份。`check` 抛错是它自己的 bug：这次调用失败，不算一轮。
- 运行时只把这几处发回**同一个 agent**：一条消息（几处问题、各自的现值、一句"其余不变、不要重复"）加一个只含这几处的 schema
  （`{ f1, f2, … }`，每个是原 schema 里那一处的子 schema，`description` 跟着走），交回来的按指针合并回去，再核一遍。流程拿到的永远是完整的、核过的答案。
  schema 不合走同一条路，所以"多一个字段"不再整份重来：schema 没声明的字段直接删掉，记一条 `log`。
- 一次最多 8 处；问题在整份答案上（`at` 为 `""`），或超过 8 处，就让它整份重交（仍是同一个会话，仍只发问题清单）。
  一处在另一处里面，合成外面那一处。指到答案里没有的地方，退到最近的存在的上级（记一条 `log` warn）。要增删数组元素，`at` 就得指到整个数组。
- `fixes`（缺省 2，0 到 5）：最多打回几轮。用完仍不过，`$.ask` 抛 `CheckFailed`（`problems`、`value`、`rounds`、`reason`）：flow 可以接住自己处理；
  没接住，运行以 **`stopped`** 结束（不是 `failed`），`stop.reason` 是"`<step>`：核对 3 轮还不过：<第一条问题>"。整个调用共用 step 的 `timeout`。
- **只按看得懂的 schema 逐处打回。** 逐处核对、删多余字段、拼回去，都只在 schema 全由 builder 的那几个关键字写成时做（`type`、`enum`、`items`、`properties`、`required`、`additionalProperties`，加不影响取值的 `description` 之类）。
  手写的 schema 里只要有别的（`minLength`、`pattern`、`$ref`、`oneOf`、`patternProperties`……），运行时看不见那些规则：**不删它没声明的字段**（`patternProperties` 之类可能声明了），
  **打回整份答案**，带整份 schema（`$ref` 指到的 `$defs` 也在里面），由 CLI 对整份回复核一遍。CLI 说回复不合 schema，那一轮就不算改好，它的话原样成为下一轮的问题——包括"有 schema 没声明的字段"：只有运行时自己删得掉的地方（上面那几个关键字写成的 object 节点）才不把这句当问题，别处它还在。
- `fixes: 0`：不打回，schema 不合时仍交给 CLI 自己重试，`check` 不过立刻 `CheckFailed`。
- 事件里每轮有 `call.fix`（发出去之前）和 `call.fixed`，`call.end.rounds` 是作答的轮数，`call.end.cost` 是各轮之和（EVENTS.md）。
- 要 fork CLI 的 `send --output-schema --max-retries`。Paseo CLI 太旧时（第一次见到 `unknown option '--max-retries'`）整次运行退回老办法：
  CLI 自己重试，打回发不出去，`check` 不过就是 `CheckFailed`（`rounds` 为 1），记一条 caveat，不让运行失败。

### 接着问：`$.again`

人没批、评审有意见，要原来写的那个 agent 接着改，而不是起一个新的、丢掉它的思路：

```js
let plan = await $.ask(planStep, input, { role: "worker", check: planProblems });
for (let v = 2; ; v += 1) {
  const g = await $.gate(planGate(plan, v - 1));
  if (g.approved) break;
  if (v > MAX_REVISIONS || !g.reason) $.stop(`方案第 ${v - 1} 版没批`, { plan });
  plan = await $.again(plan, `审批人没批这一版，原话：\n> ${g.reason}\n按意见改，交回完整的新方案。`);
}
```

- `prev` 必须是 `$.ask` / `$.again` 返回的**那个对象**：运行时靠对象本身认出它是哪个 agent、哪次调用答的。拷贝（`structuredClone`）、取出的一部分、别的运行返回的都不认，直接抛错（`TypeError`，说"原样传进来"）。
- **接着同一个 agent 问**：发出去的是 `text`、一句"你上一版存在 `<文件>`"（`<runDir>/answers/<callId>.json`）和"交回完整的新答案"；schema 还是那个 step 的整份。文件是 Paseo 重载过会话、上下文丢了时留的后路，几乎不花钱。agent 被归档过也照样接着问（发消息会唤回它）；这次调用带着 `archive: "after"` 时再归档一次。
- `check`、`fixes`、`archive` 沿用前一次调用的（`archive: null`、`check: null` 关掉，`check: fn` 换掉）。接着问的第一轮也是一次作答，不合 schema 或 `check` 不过照常在同一个 agent 里打回，所以 `$.again` 的结果和 `$.ask` 一样是核过的整份。
- `$.again(prev, step, input)`：同一个 agent 换一个 step 问（方案批了，接着让它写补丁）。发的是那个 step 自己的提示词（不重复角色指令，agent 早已收到），答案是那个 step 的 schema；`check` 不沿用（它是前一个 step 的答案的核对）。step 的 `effects` 要的模式必须和这个 agent 起来时的一样（栅栏换不了），不一样就抛错，用 `$.ask` 起新的。
- `{ fresh: true }`：起一个**新** agent，可以另外指定 `role` / `provider` / `thinking` / `cwd`（不给就沿用前一次的）。提示词 = 原来的提示词 + 你的话 + "上一版（另一个 agent 写的）在 `<文件>`"，调用的 `revises` 指向被改的那次。什么时候换人由流程定（"这一处已经被打回两次"）；缺省接着原 agent。`fresh` 不和换 step 合用。
- 原来的 agent 已经不在了（`inspect` 报 `AGENT_NOT_FOUND`）、Paseo CLI 太旧（`send` 不认 `--output-schema`）、执行层不会 `send`：运行时自动按 `fresh` 起新的，记一条 `caveat`，不让运行失败。换 step 问时，新 agent 会被告知前一个 agent 的答案在哪个文件。别的失败（连不上 daemon）是这次调用自己的失败，**不会**悄悄起新 agent 花钱。
- 一个 agent 现在可以对应多个调用：`call.end.cost` 记各自那几轮，`run.end.cost.agentCount` 数的是 agent。读事件的人按 `call.start.continues` 把它们串起来（EVENTS.md）。
- 现成的最小例子：`flows/again-smoke.mjs`（一个 fast 角色，几分钱，不过人闸）。

### 做过的事不重做：`$.step` 和日志

接着跑（下一节）要能不重做前面做完的事，前提是流程把"一件事"圈出来，运行时才知道哪些能沿用。圈法只有一种：`$.step`。

```js
export default flow({
  name: "build-and-publish",
  resume: "auto",                       // 停下以后，用同样的输入再跑一遍就是接着跑
  async run(input, $) {
    const built = await $.step("build", () => compile(input.dir), { key: input.dir });
    const plan = await $.ask(planStep, { built }, { role: "worker" });     // 同样的问题，沿用上次的答案
    const commit = await $.step("commit", (given) => submit(given.input), {
      once: true,                       // 提交撤不回
      before: async () => {                         // 授权它的那张卡，在它被写成"开始了"之前问
        const given = await $.gate({ title: "提交", content: diff, input: { label: "验证码" } });
        if (!given.approved) $.stop("提交没批");
        return given;
      },
      probe: () => lookUpRevision(input.dir),  // 开始了没有结果时，去外面查：{ done: true, value } 或 { done: false }
    });
    return await $.step("backfill", () => backfill(commit.revision), { once: true });
  },
});
```

- **谁沿用**：同一条线（`run.start.lineage`，一个运行和接着它跑的那些）里，`$.step` 按名字和 `key` 的指纹，`$.ask` / `$.again` 按提示词、schema、角色、问的目录和主机的指纹（`$.again` 还有它接着的那份答案和那个问题），`$.gate` 按标题和内容的指纹。
  依据变了就重做、重问。沿用的答案还要通过**这一次**的 `check`，不通过就作废、重新问。`$.do` 不记，每次都做——有副作用的、不能重做的事不要放在 `$.do` 里再指望接着跑。
- **`$.ask` 默认沿用**（`effects: "none"` 的）。会改文件的 agent（`effects: "workspace"`）答案说明不了文件现在的样子，默认重问；流程能核对文件还在，就给 `reuse: (answer) => 文件还对`。
- **人答过的卡不再问第二遍**：批了、不批都算，内容指纹要一样。过期、出错的，和带 `input` 的卡（验证码）每次重新问；值本身哪里都不记。
- **授权不可逆步骤的卡放进它的 `before`**，不要放在它前面的流程里，更不要放进一个包着它的普通 `$.step`。带 `input`（验证码）的卡每次都重新问，所以放在外面的话，
  "提交已经做完、回填还没做"的线接着跑时，包着提交的那一步要重新执行，卡也就再发一遍，要人再给一个验证码，而提交其实早已完成。`before` 只在这一步还要做的时候跑：
  这一步是 `done`，接着跑时 `before` 不跑、不发卡，直接去做回填。`before` 在步骤被写成"开始了"**之前**跑，它的结果不进日志，交给 `fn` 作参数。
  放进 `fn` 里（步骤已经写成"开始了"，人还在决定时运行被打断，接着跑会当成"可能已经做了"）：运行时在那张卡起来时记一条 `caveat`，说清该放进 `before`；
  `orch check` 在源码里看得出来（`once: true` 的 `$.step`、`fn` 就写在调用里、里面有带 `input` 的 `.gate(`）时报一条 warning。都不让运行失败；看不出来的（`fn` 是别处定义的函数）只有运行时那条。
- **步骤的值是 JSON**：取回来的和这次运行拿到的一样（`Date` 变成字符串，`undefined` 的字段没有）。超过 1 MB 或写不成 JSON 的，步骤失败（要大的东西写文件、返回路径）。带这次运行的秘密值的，这一次照常拿到，只是不记：非 `once` 的步骤接着跑时重做；`once` 的记成"做完了，没有值"，接着跑时当状态不明。
- **开始了没有结果的 `once`**（进程死在中间、抛了错、值没记下）：`probe` 返回 `{ done: true, value }` 就当做完了，`{ done: false }` 就再做一遍；没写 `probe` 或抛错，运行**停下**（`$.stop`），`stop.reason` 写着怎么了结：
  去外面看一眼，`orch.mjs settle <runId> <步骤> --done '<值的 JSON>'` 或 `--not-done`，再接着跑。
- **要重做某一步**：`orch.mjs resume <runId> --redo <步骤>`——这一步和它之后能撤回的（普通步骤、`$.ask`）都当没有；`once` 的和人答过的卡不动。`orch.mjs steps <runId>` 看这条线上记了什么。
- 一个 `$.step` 里面的 `$.ask`、`$.gate` 也进日志，名字带着这一步的名字，所以被沿用的步骤不会把后面的名字挤歪。步骤被沿用时，里面的代码一行都不跑。
- **同一条线同一时刻只有一个运行在写**：运行开始时取这条线的锁（`<logDir>/lines/<lineage>.lock`），取不到就被拒绝；超时或别的分支 `$.stop` 之后，还在动作里的撤不回的步骤会让锁留到它返回，所以 `run.end` 之后马上接着跑可能被拒，过一会儿再试（EVENTS.md「同一条线只有一个运行在写」）。
- **`$.step` 和 `$.again` 一起用的限制**：`$.step` 把值规范成 JSON，交回来的是一份拷贝；`$.again(prev, …)` 只认 `$.ask` / `$.again` 交回的**那个对象**（它靠对象找到 agent 和上一问）。
  所以 `const plan = await $.step("plan", () => $.ask(...)); await $.again(plan, "改")` 会失败。可行的写法：
  - 把追问也放进同一个步骤：`$.step("plan", async () => { const a = await $.ask(step, input, opts); return $.again(a, "改"); })`——步骤的值是最后那版答案；
  - 或者不要把 `$.ask` 包进 `$.step`：`$.ask` / `$.again` 自己就按指纹沿用，不需要 `$.step` 再包一层。
  从日志里取回来的步骤值同样是拷贝，没有 agent 的来历。
- 日志是 `<logDir>/runs/<lineage>/journal.jsonl`，格式和读者怎么读见 [EVENTS.md](EVENTS.md)「日志」。

### 接着跑：`$.resumeWith` 和 `orch.mjs resume`

一个流程停下（`$.stop`）、失败、超时、或进程被杀（机器重启）之后，人或调用方常常不想从头来：前面花的钱、做过的事（编译、写好的方案）还在。
**能不能接、从哪里接、用什么接，只有流程自己知道**（运行目录里哪一步做过，别人看不懂），所以由流程声明，运行时和调用方只照着办：

```js
await $.resumeWith({
  flow: "build-resume",                         // 流程名（运行时按名字找），不收路径
  input: { dir: "batch-1" },         // 照那个流程的 inputs 校验；运行目录只给目录名，不给绝对路径
  from: "编译已过：从核对接着，不重编",    // 一句话给人看，最多 60 个字符
  spends: "nothing",                            // "nothing" 不调模型；"maybe" 可能调
});
await $.resumeWith(null);                       // 收回：这次停下以后不能接着跑
```

- **每个里程碑更新一次。** `from` 说的是那一刻的实情："编译过了"之后，把 `from` 从"从编译接着"改成"从核对接着"。忘了更新，按钮旁的话会比实情保守。
  流程知道哪种停下**不该**接着跑（方案被拒、要重写），就在停之前 `$.resumeWith(null)`，或根本不声明。没声明就没有「接着跑」，调用方退回"从头重跑"，是安全的一侧。
- **接着跑的流程自己也要声明**：第一步就 `$.resumeWith`（常常就是它自己加同样的输入），否则它自己断在半路（机器重启）就没法再接。
  声明 `resume: "auto"` 的流程不用：运行一开始运行时就替它记"用同样的输入再跑一遍"，`from` 由运行时按日志写一句（"前面 N 步沿用……"，日志每多一条重写一次）。
  它前面做过的事靠 `$.step` 和日志沿用（上一节），**不能撤回的事必须放在 `once` 的 `$.step` 里**，这是 `auto` 对流程的唯一要求。想说得更具体，
  `$.resumeWith({ from, spends })` 只给要改的几项；`$.resumeWith(null)` 收回（被拒了的方案不该接着跑）。
- **`flow` 是名字，不是路径。** 一份事件文件谁都能改，不能让它指向盘上任意一个脚本：声明时不合格被拒，`orch resume` 读回来时再查一遍。
  `input` 也一样：读回来以后照那个流程的 `inputs` 再校验一遍，运行器照常在花钱之前拒绝。
- **不放秘密。** `input` 照样过事件的脱敏：已经知道的秘密值（带值的人闸批准的验证码）放进去，这次声明会被拒；声明之后才成为秘密的，结束时整个续跑点被丢掉。
  续跑的输入里需要某个值时，让续跑的流程自己再问人要（再起一张卡），不要把它带过去。
- **拿旧批准直接做不可逆的事，要在 `from` 里说出来。** 接着跑会不会重新问人，是流程的事：如果它会认之前核过的批准、内容没变就直接提交，`from` 必须写明
  （例："上次你批过，内容没变的话直接提交"）。调用方把 `from` 原样放在按钮旁，不另起确认框；按钮本身不批任何东西。
  每次都重新发卡要人批的流程，写"会重新发提交卡"。
- **接着跑跑的是现在的代码**，不是停下那一刻的：修好脚本再接着跑正是要的。新代码要读得懂旧运行目录，是流程自己的事。

`orch.mjs resume <runId>` 读上一段的 `run.end.resume`（没有 `run.end` 的、确知已经死了的，读事件里最后一行 `resume`），起声明里的流程和输入，
是**一次新的运行**，`run.start.resumeOf` 是上一段的 runId；上一段的 `affair`、`cwd`、`host` 沿用（所以人闸卡片和 agent 还在事项的同一个 workspace 里）。
**一次停下只能被接一次**：靠独占地建 `<logDir>/runs/<runId>.resumed`，按钮和命令行同时来、双击、两个进程，只有一个成，其余被拒、一分钟不花。
**上一段还活着时拒**：没有 `run.end` 的，必须占位过期并且同一台机器上它的 pid 已经不在才接；两个进程同时动一个工作目录，比多花一次钱糟。
超时之后留下的孤儿子进程运行时管不到，流程自己兜（比如"机器被别的构建占着就等"）。
**调用方把续跑点给人看过的，用 `--expect <指纹>` 交回来**（指纹 = 流程名和输入的 `pointPrint`）：运行时开跑前再读一次，点变了就拒，免得给人看的是 A、起来的是 B。
细节和读者怎么做：[EVENTS.md](EVENTS.md)「接着跑」。

`flows/resume-smoke.mjs` 是不花钱的演示（`resume: "auto"`，两段，各一张人闸卡）：`orch run resume-smoke --gate-timeout 30m …` 停在第 1 段，`orch resume <runId>` 接着：
第 1 段做过的（记下开始时间的步骤）不再做、第 1 张卡不再问，起第 2 张卡；批了就完成，过期了还能再接，不批则停下不再提供接着跑；同一次停下再接一次被拒。

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
const analyze = define({ name, effects, timeout, returns, prompt, title?, headline? });
```

三件事绑在一个对象里，因为它们是**一个**决定。prompt 要了一样 schema 里没有的东西，agent 会老实照
schema 返回，那样东西就静默丢了——没有任何测试能抓到这种错。绑在一起，至少 review 时看得见。
`effects` 也在这里，因为"这一步能碰到多远"是这一步的属性，不是调用点的。

`title` 和 `headline` 是给人看的，模型看不到，节点图用它们画节点：`title` 是节点名（写中文；调用点
`$.ask(..., { title })` 可以按这一次覆盖它，比如"成员 A（planner）独立分析"；都没写就是 `[name]`），它也是
Paseo 上那个 agent 的标题。`headline` 是 `returns` 里的一个键，说回答里哪个字段能一句话概括这次调用，
节点上就显示那个字段——选最短、最像结论的那个（advisor 的 `verdict`、assess 的 `converged`），
写成 `returns` 里没有的键，`define` 当场报错。

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

一个例外，边界说清楚：**答案的格式不对**（不合 schema，或 `check` 指出了问题）时，运行时在同一个 agent 里只把出问题的几处
发回去改，最多 `fixes` 轮（缺省 2，和 CLI 原来自己的重试一样多）。这是同一次调用的一部分，不是重来一次：轮数和每一轮的钱都记在这次调用的
事件里，用完仍不过就以 `stopped` 停下，由脚本或负责的人决定（见「核对和针对性打回」）。`fixes: 0` 关掉。

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
| orch-gate | 不支持 | 不支持 | 无 mode，强制（不带模型，只起一张卡） |

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
  sandbox 时才问，工作目录里的写不问，所以不支持。载体角色 `gate` 默认是 `orch-gate/card`（插件 provider，
  见下文「人闸」）；指向模型时用 claude。

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

**flow 名、phase id 用小写加连字符**，phase 的 `title` 是给人看的，写中文；step 和调用的 `title`、
`summarize` 的返回值同理。

**flow 的文件名就是别人引用它的名字。** 调用方（别的插件、调度器）只给名字：`orch.mjs run triage`
在 `flows/` 和 config.json 的 `flowsDirs` 里找 `triage.mjs`。所以文件名和 `flow({ name })` 写成同一个，
改文件名等于改了所有调用方依赖的接口。同名的 flow 出现在两个目录里是错误，不是覆盖。
`node runtime/orch.mjs list` 列出这两处的全部 flow（名字、说明、阶段、输入、文件；import 不了的文件也列，带原因），
不起任何东西、不花钱；「流程」页面上"有哪些流程"就是它。所以 `description` 是写给要挑流程的人看的一句话。
输入名 `runId`、`affair` 是运行器的 `--run-id`、`--affair` 占着的，flow 不能用（和 `input`、`timeout`、
`host`、`cwd` 一样，`flow()` 在 import 时就拒绝）。

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

**上下文窗口也写在模型 id 里，但要按模型看**：`claude-sonnet-5` 是 200K，`claude-sonnet-5[1m]` 是 1M，
在 `paseo provider models claude` 里是两个独立的 id；`claude-sonnet-5-5` 的普通 id 本身就是 1M
（看 `contextWindowMaxTokens`），没有 `[1m]` 版。`worker` 要 1M（2026-09-23 决定：200K 在真实任务里经常不够），
2026-10-16 换成 `claude-sonnet-5-5` 后用普通 id 即可。

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
| `inspect` 的 `LastUsage` 是**最后一轮**，不是累计（2026-10-31 实测：同一个 agent 先后两轮，第一轮 $0.0121，接着问的第二轮 $0.0131，各报各的，后一轮覆盖前一轮） | 运行时每轮交卷后 `inspect` 一次，一个调用的各轮加起来。CLI 在一条命令里自己重试的那几轮看不见，只算最后一轮（所以老 CLI 退回的路上是少算的） |
| Codex agent 的 `LastUsage.CostUsd` 是 **0**，token 数照常有（2026-09-23，gpt-6-astra，27k 输入） | `call.end.cost.usd` 照实给 0，`run.end.cost.totalUsd` 只含 Claude 系。要算 Codex 得按 token 自己折 |
| Claude 的 `LastUsage.InputTokens` 只数未缓存的输入（2026-09-24：一次 haiku 调用 `inputTokens: 10`，`usd: 0.075`） | 成本看 `usd`，不要按 token 数估 Claude 的钱 |
| 在 Paseo agent 里起的子 agent，cwd **一律是调用方 workspace 的目录**：`--cwd` 被忽略，子进程 cwd 也不管用（2026-09-23 实测：gate 探针指定了临时目录，agent 仍落在调用方的项目目录） | prompt 里一律给绝对路径。`$.ask` 的 `cwd` 是脚本**要求**的目录，不一定是 agent 实际所在的目录；`effects: "workspace"` 的"工作目录"因此也是调用方的。传 `--workspace` 也不能换目录：agent 的 cwd 是 **workspace 的目录**，`--cwd` 照样被忽略（2026-10-27 实测）。要换目录得换 workspace |
| `paseo archive <id>`（`agent archive`）**找不到后台 workspace 里的 agent**：它用 `includeArchived` 列 agent 再按 id 找，没带 `includeBackground`，报 `AGENT_NOT_FOUND`，尽管 `inspect`、`ls -a -g` 都看得到它（2026-10-29 实测，fork CLI 1.4.1；`archive.ts:60`）。事项的 workspace 是后台的，所以带 affair 的 `$.ask` 的 `archive: "after"` 运行时自己归档不成功，只记一条 caveat 和一条 `call.archive`（`ok: false`） | 起这次运行的插件用 `server.paseo` 归档（2026-10-29 定：reconcile 做；fork CLI 改一行——filter 加 `includeBackground: true`——记作 fork 的待办，下次发版顺带）；见 `docs/affair-workspace.md` |
| `paseo workspace create` **不去重**：同目录同标题连建两次得到两个 id；`workspace ls` 只有标题和目录，没有标签（2026-10-27） | 运行时不按标题找，用登记文件加锁，见 `docs/affair-workspace.md` |
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
- **跨机时没有父（实测，2026-10-21）。** 带 `--host` 时 CLI 先去目标 daemon 上查 `PASEO_AGENT_ID`，
  查不到就不传调用方（`cli/src/utils/caller-agent.ts`），不报错；远端 agent 在 App 上没有父，每次
  `paseo run` 还会在那边新建一个 workspace。事件里的 `caller` 照旧是本机这个 id。

---

## 跑完叫醒：负责的会话（steward）

一个没人守着的运行（后台起的、定时起的、插件起的）结束了，常常没人知道。运行时在写 `run.end` 之前，把结局告诉**一个**该知道的会话，并记一笔账。
消息只有一句话或几行：流程、结局、原因、事件文件、接着跑的命令、该流程的手册路径（`<flow>.steward.md`，在 flow 文件旁边有才写）；运行结束时还有调用没回来（这条线暂时被占着，现在接着跑会被拒；运行的进程还在就等它们回来，已经退出的话它们可能被截断，接着跑会停在"可能做了也可能没做"，要先 `settle`），也写一句。

**告诉谁**，先到先得（结果记在事件 `wake`，格式见 [EVENTS.md](EVENTS.md)）：

1. `orch.mjs run ... --notify <agent>`：显式指定的会话（`run.start.notify.via = "explicit"`）。
2. `orch.mjs run ... --detach`：运行转到后台进程里跑，命令立刻返回 `runId`；起它的会话（`PASEO_AGENT_ID`）结束时被告诉（`via = "caller"`）。`resume` 同样支持两个选项。
3. 前台跑的、有会话在前面等着的运行：不告诉，它自己从命令输出里读结果。
4. 配置里这个 flow 有负责会话：`~/.paseo-orchestration/config.json` 的 `stewards`（每台机器自己的，公开仓不放任何具体路径或人）：

   ```json
   "stewards": {
     "*": { "cwd": "D:\\private\\ops", "guide": ["D:\\private\\ops\\GUIDE.md"] },
     "build-and-ship": { "agent": "<agent id>" }
   }
   ```

   键是 flow 名，`*` 管没点名的。每项**恰好**写一个落脚处：`agent`（一个现成的会话）、`workspace`（Paseo workspace id）、`cwd`（一个目录，它的 workspace 找或建，登记在 `<logDir>/workspaces/`）；
   可选的 `role`（roster 里的角色，缺省 `steward`：公开仓 `roles/steward.md`）和 `guide`（新起的会话要先读的文件，写进它的第一条消息）。**公开仓只有机制，没有人或路径。**
5. 都没有：不发，`wake { to: null, why }` 说为什么。

负责会话的找法：配置的 `agent` 还在（没归档）就用它；`agent` 不在了、或配的是 `workspace` / `cwd`，就在那个 workspace 里找标签 `orch-steward=<flow 名>`（`*` 是 `all`）的、没归档的会话；
找不到就**现起一个**（角色见上），消息连同一段交代身份的开场白是它的第一条（`started: true`），之后的运行找到它、直接发。
"找，找不到就起"是一步：同时结束的几个运行不会各起一个。按（标签，目录）取锁 `<logDir>/steward/<名>.lock`，持到会话起好、id 写进同名的 `.json` 为止；
发送方等不及（30 秒）放弃时锁照持，由起会话的那一步自己放，下一个运行排在它后面、用它起的会话。列表里看不到时也认 `.json` 里记的、还没归档的那个。没配 `stewards`、也没给 `--notify` / `--detach` 的运行，什么都不发、也不记账，事件里只多一行 `wake { to: null }`。

**每条消息都是** `paseo send <agent> --prompt-file <文件> --behavior steer --no-wait`，最长等 30 秒，失败只是事件里一行（`wake.ok = false`、`error`），不改结局。运行时没有重试，也不会去找别的会话顶替。
`done` 也发一行（跑完的记一笔就行）；flow 想让负责会话只听出问题的，声明 `wake: "problems"`：`done` 就不发（`wake.why` 说明），但账里照记。它只管 steward 这一路，显式的 `--notify` 照发。

**账本** `<logDir>/steward/ledger.jsonl`：有 steward 配置的 flow，每次运行一行（不管有没有人收到）。负责会话隔了很久才被叫醒、或者换了一个会话，消息末尾会多一句
「账里自上次以来还有 N 次运行（路径）」——N 是上一条**送到了负责会话**的之后记的行数——它去读账补上漏的，不靠消息本身。

**失联的运行**（进程被杀、机器重启，没写出 `run.end`）自己不会说话。`orch.mjs wake-lost [--dry-run]` 找出同一台机器上进程确已不在、没有 `wake`、账里也没有的运行，各补发一次
（消息里结局是「失联了」；账本记一行）。**运行时里没有定时器**，什么时候跑它由人或别的程序决定（例如开机后跑一次、或每小时跑一次）；`--dry-run` 只列出会发给谁，不发。

### 注意：消息进来时对方在做什么（2026-10-31 实测）

用 Haiku 当探针 steward（`stewards.agent` 指向它），对着真 daemon 试了三种状态下的 `send --behavior steer --no-wait`（CLI 发的消息 daemon 会「排队约两秒再送」）：

- **空闲**：被叫醒（`idle` → `running` → `idle`），按消息办。
- **正在生成文字**：不会被打断；消息在这一段输出写完之后、同一次活动里处理（探针写 1 到 140 的清单，写完才回到消息）。所以「消息会并进当前这一轮」是对的，但不是「立刻」。
- **卡在一个权限请求上**（等人批工具调用）：steer 会**把那个请求当作被拒绝**撤掉，然后在同一轮里处理这条消息——也就是消息会替人把一个待批的请求否了。负责会话的权限模式越紧，这种事越可能发生。

由此：

- **运行时起的 steward 用的是 provider 的默认权限模式**（Claude 是 default），它每调一个工具都会向人要权限。运行时不会也不该替它选松的模式（`gate:allow` 不存在，权限请求不替人批）。
  所以 steward 若要无人值守地工作，要由部署方自己决定：给 `role` 配一个只读能力够用的模式，或自己起好会话再用 `stewards.agent` 指过去；否则它第一次调工具就会等人批，之后的消息又会把那个待批请求撤掉。
- 消息写得**不依赖回复**：开场白里已经告诉它「消息会并进当前这一轮，不用回复它」。

---

## 跨机：整次运行派到另一台主机

`orch.mjs run <flow> --host <host> --cwd <dir>`：`<host>` 是 config.json 里 `hosts` 的名字，或 `paseo --host`
认的任何形式（`ssh://user@box` 最省事，CLI 自己开隧道）；`<dir>` 是那台机器上的目录，带 `--host` 时必填
（本进程的目录是本机路径）。运行器、事件流、日志留在本机，每个 `$.ask` 的 agent 都在那台机器上跑。
2026-10-21 实测跑通两条路：SSH 到一台 macOS daemon，relay 配对链接到一台 Windows daemon。

- **配对链接是凭据**（`https://app.paseo.sh/#offer=...`，拿到就能操作那台 daemon），只能写进 `hosts`、经名字用；
  直接传给 `--host` 会被拒绝，事件里只记名字。连不上 SSH 的机器只能走它。
- **只能整次运行派过去**，`$.ask` 还不能按步选主机。
- **带人闸的 flow 会被拒绝**：`$.gate` 的回执和 hold 文件是本机路径，载体跑到别的主机上会写到那边去。
- **两边版本要对齐。** 本机 CLI 比远端 daemon 新时，按 label 找回 agent 用的 `ls -a` 会报
  `Update the host to use background workspaces.`（上游 0.12 的 CLI 对 0.11 的 daemon），运行照常成功，
  但事件里 `agentId`、`cost` 都是 null。同版本时都拿得到。
- **角色钉的模型要在远端也有**：roster 只在本机解析，远端 provider 的模型列表可能不一样（实测远端
  Codex CLI 较旧时缺新模型），用 `paseo --host <host> provider models <provider>` 先核对。
- **经 relay 测连通别用 `paseo status`**：它的连接超时约 2 秒，relay 建连要 2–5 秒，必然报超时；用 `ls`。
- 运行视图里点开的 agent 在远端，要在 Paseo App 里切到那台主机看。

## 人闸：`$.gate`

flow 要停下来等人拍板时，用 `$.gate({ title, content, name, summary, brief, evidence, timeout, holdPath })`，flow 要声明
`grants: ["gate:deny"]`。实现在 `runtime/gate.mjs`。

**人批的是一个决定，代码是证据。** 卡片第一眼要让一个新人三秒内看懂"要我批什么、批了会怎样"：

- `title` 写成决定句，例如"批准 hotfix #1 放进 data/7/1/（回放）"。它是卡片标题、推送正文的开头、回执的第一行。
  它会被压成一行。
- `summary` 是卡片说明，几行纯文本：结论、校验结果、要单独看的 ⚠。没有 ⚠ 也要明说。运行时会在后面补一行
  "批准意味着什么"，再补一行"不批怎么写理由"。
- `brief` 是 markdown，放在卡片上方，写判断所需的一切。`evidence` 是折叠的证据行，`kind: "diff"` 按 diff 显示。
- 原文 `content` 在卡片里，同时也在一行折叠的"待批全文"里。`name` 给原文起名，用来高亮。

**载体和回执。** 脚本自己发不出权限请求，所以人闸起一个载体，人在它的权限卡片上应答。人批准的是一张三行的
**回执**：决定句、`人闸 <callId> · 运行 <runId>`、`内容 sha256 <原文指纹>`。载体在批准后把回执写到 `holdPath`。
判定**以回执文件为准**：与预期相同判 `allowed`（`provider` 载体还要它记下的应答是 `allow`），不同判 `mismatch`，
没有文件则按情况判 `denied` / `expired` / `error`（见 EVENTS.md）。真正的写入由脚本随后用 `$.do` 自己做，写的是脚本
手里的原文。回执里的 sha256 指认的是这份原文，但不计换行符差异和结尾换行。核对落盘文件的字节，要用 `call.start.bytesSha256`。
载体只是载体，不是写入方。`holdPath` 要以 `.receipt.txt` 结尾，同一次运行里两个人闸不能共用。
这一条是第二个人闸开始时才查的：`holdPath` 往往在运行中才算出来，`check` 和开跑前查不了，所以前面已经花的钱照花。
在同一次运行里给多个人闸显式写 `holdPath` 时，自己保证路径各不相同。

载体由角色 `gate` 决定，有两种：

- **`orch-gate/card`（默认）**：`orchestration-gate` 插件的 provider，不带模型。
  - 运行时在回执旁写一份请求文件 `<callId>.request.json`，prompt 恰好三行：决定句、这份文件的路径、它的 sha256。
  - provider 核对两个指纹（请求文件的、原文的）后才起卡片。卡片标题是 `title`，说明是 `summary` 加两行，
    卡里是原文，按钮是「不批 / 批准」；`brief`、`evidence` 在卡片上方。
  - 写什么、写到哪，provider 都不听请求文件的。请求文件的出处没人认证，prompt 里的 sha256 也是发 prompt 的一方算的。
    - 应答记在请求文件旁边的 `<callId>.answer.json`，先记应答，批准时再写回执；
    - 回执只能是同一目录里的 `*.receipt.txt`，内容由 provider 按决定句、运行、调用、sha256 自己生成；
    - 两个文件都只新建、不覆盖。卡片说明里写着回执路径。
  - 卡片挂着时，人在对话底部的消息框里打一句话，按不批处理，那句话记成理由；对话里会立刻回一句"已记为不批"。
  - 插件没装或不可用时，会动用人闸的 flow 在花第一笔钱之前就被拒（`RunRefused`）。
- **一个模型（后备）**：在私有 `roles/gate.md` 里把 `gate` 指向便宜模型，例如 `claude/claude-haiku-5-5`，`thinking: off`。
  - 它跑在栅栏表 `ask-human` 那一档，被要求把回执 Write 到 `holdPath`。卡片是一张 Write 卡，框里是回执。
  - 决定、说明、证据和原文都在它的 prompt 里，prompt 是脚本写的，载体改不了。
  - 它抄错、改写，或者把原文当回执写，都判 `mismatch`。这条路受命令行长度限制，原文放不下时判 `error`、不起卡片。
  - 模型可能拒绝当载体：它看到"批准"和 ⚠，会觉得写回执就是替人批。它的 tool 记录里没有写回执路径那一行就结束时，
    判 `error`，不记成有人拒绝。
    2026-10-21 用 haiku 实测：
    - 从终端起：10 次里 9 次逐字提出了写回执，1 次因为卡片说明里的 ⚠ 拒绝了；
    - 从另一个 agent 的会话里起（环境里有 `PASEO_AGENT_ID`，Paseo 把 prompt 当成那个 agent 发来的消息）：2 次都拒绝了。
    所以后备载体只适合插件确实不可用的时候用。

**批准并附一个值（`input`）。** `$.gate({ …, input: { label: "验证码", pattern: "\\d{6}", hint: "6 位数字" } })`：
卡片是 Paseo 的 `question` 卡（一个文本框，「提交」= 批准并带值，「不批」= 拒绝），不是两个按钮。判定对象多一个
`input`（批准时是值，否则 `null`；没有 `input` 的闸没有这个键）。要点：

- **框里只填值，对话里打的字永远是理由**（`typed` 的拒绝），哪怕看着像验证码。卡片上写明了这一点。
- `pattern` 要**整个值**匹配；不合格的输入 provider 不当作答复（不记录、不写文件、不顶期限），原卡关掉、新卡带原因重挂，不回显填的内容。
  运行时读到值以后再查一遍。不带值的 allow（`permit allow` 不带 `--input`）同样被退回，永远不是批准。
- `secret` 缺省 **true**：值不进事件流——`call.end.output.input` 是 `"<已用>"`，之后写进事件流的任何字符串里凡含有它的都换成
  `<已用>`（`EventLog.addSecret`，flow 自己的 `$.log`、返回值、错误信息也在内）。`secret: false` 才照实记。值至少 4 个字符。
- 只有 `orch-gate` provider 能收值；角色 `gate` 指向模型时调用处抛错。
- 值从 provider 到运行时走 `<callId>.input.json`（明文，读完即删），不经应答记录和回执。
  **flow 拿到值之后写到哪、传给谁，运行时管不了**；终端打印的 `value` 也没有兜底。
- 调查、被否决的做法、已验证和没验证的：`docs/gate-input.md`。

**等得久的步骤。** `$.do` 没有时间上限，总超时缺省也没有（`--timeout` 由调用方给，flow 自己设不了）；`$.gate` 的
`timeout` 到 `8h` 没问题。运行"活着"看 claim 的心跳（定时器，每 30 秒），和事件无关；"可能卡住"的底线对一个开着的
`$.do` 是 15 分钟没有事件，所以长 `$.do` 里每 5–10 分钟 `$.log.info("还在编译，已 N 分钟")`。长步骤必须是异步的：
`execFileSync` 之类会让定时器停转，claim 两分钟后读作丢了。依据和测试：`docs/gate-input.md`、`test/long-task.test.mjs`。

为什么这样搭，而不是让脚本在终端里等人输入：

- 人本来就在 Paseo 里，权限卡片是现成的裁决界面，手机上也能批，推送会带上决定句。
- `paseo wait` 能区分"卡在权限请求上"和"结束了"。

已知的缺口，照实记下：

| 缺口 | 后果 |
|---|---|
| Paseo 不记录**谁**应答的；任何能跑 `paseo permit allow` 的进程都能应答 | `by` 记为 `unattributed`，不写成"人批准的"，并作为一条 caveat 进运行。`gate:allow` 这个 grant 不存在，flow 声明它直接报错 |
| `answeredVia` 只是应答方自报的 | `button`、`no-button`、`typed` 分得出"点了卡片按钮"和"命令行批的"，但本机任何进程都能伪装成任何一种。要知道是哪台设备、哪个 agent，需要 Paseo 在应答上带上连接信息（fork 扩展点，未做） |
| 有进程绕过卡片，直接把回执写到 `holdPath` | `provider` 载体：只有回执、没有 `allow` 应答记录，判 `error`；回执推翻不了已记下的拒绝。但同一用户的进程可以把两个文件都伪造出来，这和"任何进程都能 `permit allow`"同属本机信任边界。`model` 载体没有应答记录，只有回执也判 `allowed` |
| 有进程伪造请求文件，让 provider 起一张它编的卡 | 卡片上的决定、说明、原文都可以是编的；但 provider 只会在请求文件旁边新建一份三行回执和一份应答，不会写别处、不会覆盖文件 |
| App 的拒绝按钮不带理由 | `provider` 载体：人在对话里打的字就是理由，进 `reason`。`model` 载体：理由只到 agent，它转述的原话另存为 `agentReport`，标明是转述。**命令行不是给人用的审批渠道**，不要让人去敲 `permit deny` |
| 过期（默认 2h）时运行时替人**拒绝** | 需要 `gate:deny` grant。拒绝是保守方向，所以可以给 |
| 人可能不看就批（2026-10-21 冒烟：三张一样的卡全被批了） | `title` 和 `summary` 要写出"这张卡要你看什么"；更多建议见私有设计笔记，未实现 |

实测：
- 2026-09-23，旧机制（载体抄原文）：拒绝路径、过期路径、人在 App 上批准一个真实补丁的回放。
- 2026-10-21，新机制：`orch-gate` 载体在真 daemon 上起卡；人在 App 上批准判 `allowed / button`；
  点「不批」判 `denied / button`；在对话里打字判 `denied / typed`，打的字进了 `reason`。用的都是 `flows/gate-smoke.mjs`。

**审批渠道的方向**：判定语义（结果只看回执、超时替人拒绝、没有 `gate:allow`）与渠道分开。任何渠道，只要应答的是
载体的这个权限请求，就落到同一处判定。决定句和说明放在权限请求的标准字段 `title`、`description` 里，IM 渠道
（本仓库的 `feishu/` 插件，公司内部 IM 同理）不懂编排也能拿到。IM 卡片回调里带着点按钮的人，"谁批的"在那条
渠道上有着落。

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
