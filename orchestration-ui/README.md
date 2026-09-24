# orchestration-ui：编排运行

只读地查看编排运行时（[`../orchestration/`](../orchestration/)）每次运行干了什么。详情页分四层，
每层回答一个问题：

1. **结论条**：一句话说在干什么、结果如何、要不要你动手，旁边是唯一的主按钮（人闸在等时是
   「在 Paseo 打开审批卡片」，打开承载人闸的 agent；失联或失败时打开那个 agent）。下面一行关键数字：
   用时、花费、agent 数、人闸状态，和「N 条约束没被机械强制」（点开看整次运行的说明，只说这一遍）。
2. **流程图**：阶段是框，调用是框里的节点，时间从左往右；时间上重叠的并排上下堆叠，重新进入的阶段
   收进「↻ N 轮」容器，声明了没走到的阶段是虚线占位，两端是输入和结局。另有「时间线」（甘特条，
   看时间花在哪）和「事件」（原始事件表）两个视图。
3. **详情抽屉**：点任何节点，右边依次是结论、谁做的、花费、约束有没有被机械强制、在 Paseo 中打开；
   窄屏时是弹出的面板。
4. **证据**：prompt、输出 schema、完整输出 JSON、栅栏说明、运行事实（pid、cwd、runId、flow 文件），
   默认全部折叠。

列表页按「需要你处理（人闸在等、失联）/ 运行中 / 最近结束」分组，每行是 flow 名加输入里最能认出它
的值、阶段色带、和详情页结论条同一句话、花费、开始时间。

它不启动运行、不批人闸、不改任何文件。

## 数据从哪来

唯一的数据来源是运行事件流 `<logDir>/runs/<runId>.jsonl`，契约见
[`../orchestration/EVENTS.md`](../orchestration/EVENTS.md)。插件不依赖运行时的代码。

`logDir` 的找法和运行时一致：插件设置里填的 → daemon 进程的环境变量 `ORCH_LOG_DIR` →
`ORCH_CONFIG` 或 `~/.paseo-orchestration/config.json` 里的 `logDir` → `~/.paseo-orchestration/logs`。
注意第二条读的是 **daemon** 的环境，不是你跑 flow 的那个终端；两边不一致时在设置里直接填。

- 列表：运行按字节偏移增量折叠，因为要知道哪些调用还开着才分得清「运行中」和「失联」，也要知道
  每个阶段走到哪才画得出色带。已结束的运行折叠一次，按文件大小和修改时间缓存；超过 8 MB 的已结束
  运行只读首行和末行，没有色带。
- 详情：客户端带着上次的字节偏移来要新增的完整行，运行中约 1.5 秒一次，失联时 5 秒一次，
  拿到 `run.end` 就停。最后半行留到下次。
- 没有 `run.end` 的运行是「运行中」还是「失联」：`run.start` 记下的 `hostname` 就是 daemon 所在的机器时，
  daemon 直接查 `pid` 还在不在（`process.kill(pid, 0)`，EPERM 也算在），不在就立刻判失联；进程在就是运行中，
  安静再久也只是注明"多久没有新事件"。别的机器上的运行、或者没有 `pid` 的旧文件，查不了进程，才按阈值猜：
  安静超过默认 15 分钟（设置里可改）显示失联，正在等的调用自己的 `timeout` 更长时按那个算。
  判定在 daemon 上做完随 RPC 带给界面，列表和详情是同一个答案。进程先查、事件后读，所以进程写完
  `run.end` 就退出时不会被误判。
- `call.agent` 一到，进行中的调用就能「在 Paseo 中打开」对应的 agent。
- 时长的「现在」：运行中量到当前时间；结束或失联的运行量到最后一条事件，不会越数越多。
- 契约之外、运行时新加的字段，有就用、没有就退回：`call.start.title` 是人话标题（旧日志里的
  `[advise]`、`[draft] #100231` 显示成「所在阶段 · advise」）；`call.start.headline` 指定输出里哪个字段
  是节点上的一句话，没有时按启发式猜；`run.end.summary` 是结论条上的一句话结果，没有时退回
  「完成」或停下的原因。

## 图是怎么推出来的

`shared/graph.ts` 从折叠好的运行状态推出图，纯函数，列表和详情共用：

- 每个 `phase.start`…`phase.end` 是一次**访问**，一个框；同一阶段第 n 次进入是第 n 次访问。
  调用挂到开始时该阶段还开着的那次访问上。阶段外的调用是无框节点，连续的 `do` 合一组。
- 访问按开始时间排，时间区间重叠的归入同一列（并行，上下堆叠），不重叠的从左往右。框里的调用
  用同一规则分成「波」，连续两个以上单独的 `do` 折成「N 个脚本步骤」。**箭头只表示先后，不表示
  数据流向**：事件里没有「这个调用用了谁的输出」。
- 某阶段被重新进入时，从它第一次进入起、到第一轮里没出现过的阶段为止，收进「↻ N 轮」，每轮一行。
  这是**推断**：flow 不声明循环；形状对不上（比如中间夹着并行的列）就平铺，不会丢节点。
- 节点上的一句话：step 声明了 `headline` 就用那个字段；否则数脚本返回的检查项（`passed`/`ok`），
  或取输出里第一个短字符串、布尔、列表；人闸给判定。

## 装

插件放在这个仓库里，Paseo 从 git 装、装时跑 `npm ci`（只装类型检查和测试用的依赖，运行时模块
由 Paseo 提供）：

```bash
paseo plugin add CN-liuzhiyang/paseo-plugins:orchestration-ui
```

或者从本地目录装（改代码后 `paseo plugin reload orchestration-ui`）：

```bash
cd orchestration-ui && npm install
paseo plugin install /absolute/path/to/paseo-plugins/orchestration-ui
```

daemon 的 `pluginsEnabled` 要开着。装完 `paseo plugin ls` 里应是 `running`，侧边栏出现「编排运行」，
Command Center 里有「打开编排运行」，设置 → 插件下有它的设置页。

## 开发

```bash
npm install
npm run typecheck
npm test
```

`fixtures/` 里是按契约手写的五份运行，都带 `pid`、`hostname`（占位的 `fixture-host`，不是真机器名）和 `call.agent`：`committee-done`（两个阶段、辩论进了两轮、每轮两个并发调用）、
`hotfix-stopped`（有阶段外的 `do`、有人闸、在「人工审批」停下、最后一个阶段没进入）、
`advisor-failed`（调用超时、阶段 `ok:false`、运行失败）、`survey-unfinished`（两个阶段并发、
一个调用有了 agent 还没结束、一个不认识的事件、末尾半行、没有 `run.end`）、`docfix-waiting`（人闸
正在等人：准备阶段四个 `do`、一轮起草⇄校验的修复、阶段外的 `do`、人闸和另一个 ask 并行、一个声明了
还没到的阶段；带人话 `title` 和 `headline`，没有 `run.end`）。前四份是旧日志，没有新字段，用来测退化。
单测（`server/run.test.ts`、`server/graph.test.ts`、`server/files.test.ts`）和手工预览都用它们：
按 `<runId>.jsonl` 拷进某个 logDir 的 `runs/` 就能在界面里看。要演示 pid 判定，把 `run.start` 的
`hostname` 改成本机、`pid` 改成一个活的或已退出的进程；`docfix-waiting` 最好再把时间戳整体挪到
最近，否则「已等」会是好几个小时。

想在真界面里看又不碰在用的 daemon：用 fork 的 CLI 以独立 home 和端口起一个 daemon
（`paseo daemon start --home <临时目录>`，home 的 `config.json` 里写 `daemon.listen` 为别的端口、
`pluginsEnabled: true`，不要带 `PASEO_DESKTOP_MANAGED`），`paseo plugin install ... --host 127.0.0.1:<端口>`，
浏览器打开 Paseo 网页端「直接连接」到那个端口；看完 `paseo daemon stop --home <临时目录>`。
插件设置可以直接写在临时 home 的 `plugin-settings/orchestration-ui/orchestration-ui.json`
（`{"version":1,"values":{"logDir":"…"}}`）。用无头浏览器时注意两点：网页端会自动探测
`localhost:6767`，也就是在用的 daemon，用一个全新的浏览器配置并加
`--host-rules="MAP localhost 127.0.0.1:<端口>, MAP 127.0.0.1 127.0.0.1:<端口>"` 把回环连接都导到临时
daemon（DevTools 的 URL 屏蔽拦不住 WebSocket）；Chrome 的本地网络访问检查会拦住 https 页面连回环地址，
无头模式下要用 `--disable-features=LocalNetworkAccessChecks` 关掉。

## 目录

```
index.server.ts     注册设置和三个 RPC：runs.list / runs.read / status
index.client.tsx    侧边栏入口、整页 surface、设置页、Command Center 项
shared/run.ts       事件折叠成运行状态（纯函数，daemon 和 app 共用）；运行/阶段/调用的状态判定、阶段访问
shared/graph.ts     运行状态推出图（访问、并行列、循环、脚本组、占位）、结论条 hero、节点一句话 headline
shared/format.ts    给人看的文字：时长、成本、「正在做什么」
shared/rpc.ts       RPC 契约
shared/settings.ts  logDir 覆盖、失联阈值
server/lines.ts     按字节偏移读 JSONL：首行、末尾若干行、从偏移起的完整行
server/runs.ts      列表摘要（缓存 + 增量折叠）与单次运行的增量读取
server/logdir.ts    logDir 解析
server/alive.ts     未结束的运行的进程还在不在（只在同一台机器上查）
client/run-list.tsx      列表页：按要不要你处理分组
client/run-detail.tsx    详情页：结论条、数字行、三个视图、抽屉（窄屏时是 Modal）
client/graph-view.tsx    流程图，只用 View、flex 和边框（插件 SDK 没有 SVG），颜色全取宿主主题
client/timeline-view.tsx 时间线（甘特条）
client/events-view.tsx   原始事件表
client/drawer.tsx        选中节点的详情与折叠的证据
client/value.tsx         按 schema 渲染结构化输出
fixtures/           样例运行
```
