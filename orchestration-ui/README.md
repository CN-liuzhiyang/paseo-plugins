# orchestration-ui：编排运行

只读地查看编排运行时（[`../orchestration/`](../orchestration/)）每次运行干了什么：按 flow 声明的阶段
排好，每个阶段下面是它的调用（`ask` agent 调用、`do` 脚本动作、`gate` 人闸），顶上一句话说结局或
正在发生什么。对话记录和 prompt 是折叠起来的证据，不是主角。

它不启动运行、不批人闸、不改任何文件。

## 数据从哪来

唯一的数据来源是运行事件流 `<logDir>/runs/<runId>.jsonl`，契约见
[`../orchestration/EVENTS.md`](../orchestration/EVENTS.md)。插件不依赖运行时的代码。

`logDir` 的找法和运行时一致：插件设置里填的 → daemon 进程的环境变量 `ORCH_LOG_DIR` →
`ORCH_CONFIG` 或 `~/.paseo-orchestration/config.json` 里的 `logDir` → `~/.paseo-orchestration/logs`。
注意第二条读的是 **daemon** 的环境，不是你跑 flow 的那个终端；两边不一致时在设置里直接填。

- 列表：已结束的运行只读首行和末行，按文件大小和修改时间缓存；没结束的运行按字节偏移增量读完，
  因为要知道哪些调用还开着，才分得清「运行中」和「失联」。
- 详情：客户端带着上次的字节偏移来要新增的完整行，运行中约 1.5 秒一次，失联时 5 秒一次，
  拿到 `run.end` 就停。最后半行留到下次。
- 没有 `run.end` 的运行是「运行中」还是「失联」：`run.start` 记下的 `hostname` 就是 daemon 所在的机器时，
  daemon 直接查 `pid` 还在不在（`process.kill(pid, 0)`，EPERM 也算在），不在就立刻判失联；进程在就是运行中，
  安静再久也只是注明"多久没有新事件"。别的机器上的运行、或者没有 `pid` 的旧文件，查不了进程，才按阈值猜：
  安静超过默认 15 分钟（设置里可改）显示失联，正在等的调用自己的 `timeout` 更长时按那个算。
  判定在 daemon 上做完随 RPC 带给界面，列表和详情是同一个答案。进程先查、事件后读，所以进程写完
  `run.end` 就退出时不会被误判。
- `call.agent` 一到，进行中的调用就能「在 Paseo 中打开」对应的 agent。
- 详情页结局横幅下面有一条阶段进度条：每个声明的阶段一段，点一段滚到下面对应的阶段。

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

`fixtures/` 里是按契约手写的四份运行，都带 `pid`、`hostname`（占位的 `fixture-host`，不是真机器名）和 `call.agent`：`committee-done`（两个阶段、辩论进了两轮、每轮两个并发调用）、
`hotfix-stopped`（有阶段外的 `do`、有人闸、在「人工审批」停下、最后一个阶段没进入）、
`advisor-failed`（调用超时、阶段 `ok:false`、运行失败）、`survey-unfinished`（两个阶段并发、
一个调用有了 agent 还没结束、一个不认识的事件、末尾半行、没有 `run.end`）。单测和手工预览都用它们：
按 `<runId>.jsonl` 拷进某个 logDir 的 `runs/` 就能在界面里看。要演示 pid 判定，把 `run.start` 的
`hostname` 改成本机、`pid` 改成一个活的或已退出的进程。

想在真界面里看又不碰在用的 daemon：用 fork 的 CLI 以独立 home 和端口起一个 daemon
（`paseo daemon start --home <临时目录>`，home 的 `config.json` 里写 `daemon.listen` 为别的端口、
`pluginsEnabled: true`，不要带 `PASEO_DESKTOP_MANAGED`），`paseo plugin install ... --host 127.0.0.1:<端口>`，
浏览器打开 Paseo 网页端「直接连接」到那个端口；看完 `paseo daemon stop --home <临时目录>`。

## 目录

```
index.server.ts     注册设置和三个 RPC：runs.list / runs.read / status
index.client.tsx    侧边栏入口、整页 surface、设置页、Command Center 项
shared/run.ts       事件折叠成运行状态（纯函数，daemon 和 app 共用）；运行/阶段/调用的状态判定
shared/format.ts    给人看的文字：时长、成本、「正在做什么」
shared/rpc.ts       RPC 契约
shared/settings.ts  logDir 覆盖、失联阈值
server/lines.ts     按字节偏移读 JSONL：首行、末尾若干行、从偏移起的完整行
server/runs.ts      列表摘要（缓存 + 增量折叠）与单次运行的增量读取
server/logdir.ts    logDir 解析
server/alive.ts     未结束的运行的进程还在不在（只在同一台机器上查）
client/             列表页、详情页、调用卡片、按 schema 渲染结构化输出
fixtures/           样例运行
```
