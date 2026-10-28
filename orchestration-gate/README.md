# orchestration-gate：编排人闸的载体

编排运行时（[`../orchestration/`](../orchestration/)）的人闸 `$.gate` 要人拍板时，起的就是这个插件提供的
provider `orch-gate/card`。它不带模型，只做一件事：把待批的东西做成一张 Paseo 原生权限卡片，
人答了以后照实记下来。

## 人看到什么

在承载人闸的 agent 对话里：

1. 一条说明（markdown）：要你决定的事，加上 flow 给的 brief；
2. 收起的证据行：flow 给的每条证据（diff 用 diff 视图），最后一行是待批全文；
3. 权限卡片：
   - 标题是决定本身，例如"批准 补丁 #1 放进 …"；
   - 说明是 flow 给的 summary，加上两行：批准意味着什么、不批怎么写理由；
   - 卡片里是待批全文；
   - 按钮是「不批」和「批准」。

推送和通知的正文就是标题和说明。

## 带值的人闸（`$.gate({ input })`）

运行时的请求文件带 `input` 时，卡片是 Paseo 的 `question` 卡而不是两个按钮：

- 一个文本框（占位符是 `hint`）、「提交」（批准，带框里的值）和「不批」（拒绝）。标题、说明、待批全文在卡片上方和问题文字里。
- **框里只填值**；想说明不批的理由，点「不批」，再在对话底部的消息框里写（照旧是 `typed` 的拒绝）。对话里打的字永远不会当成值。
- 填的内容不合格（`pattern` 要整个值匹配，空、过长、`secret` 太短都算），provider **不当作答复**：不记录、不写文件，
  关掉这张卡，换一个 id 再挂一张，卡片顶上写原因，不回显填的内容。
- 合格的值写进 `<callId>.input.json`（只新建），应答记录里只记 `input: { given: true, secret }`，对话里说"已记为批准（值不会显示在这里）"。
  运行时读完就删。
- 命令行 `paseo permit allow <agent> <id> --input '{"answers":{"<label>":"<值>"}}'` 发的是同一种应答；不带 `--input` 的 allow 被当作不合格退回。
- IM 渠道的问题卡只认 claude/codex 的提问，这张卡在 IM 里会退成「请到 Paseo 里回答」（读代码，未实测）。

细节、被否决的做法和没验证的：[`../orchestration/docs/gate-input.md`](../orchestration/docs/gate-input.md)。

## 它做什么、不做什么

- 运行时在回执路径旁边写一份请求文件（`<callId>.request.json`），prompt 恰好三行：决定句、文件路径、它的 sha256。
  如果运行是从另一个 agent 的会话里起的，Paseo 会把 prompt 包成那个 agent 的消息，provider 先拆掉这层包装。
  provider 先核对这份文件的 sha256，再核对原文的 sha256，两个都对才起卡片；任何一个不对，就不起卡片，
  并记一条错误。
- **写什么、写到哪，不听请求文件的**：请求文件谁都能写，prompt 里的 sha256 也是发 prompt 的一方算的。
  - 应答记在请求文件旁边、按它命名的 `<callId>.answer.json`；
  - 回执只能是同一目录里的 `*.receipt.txt`，内容是 provider 按决定、run、call、原文 sha256 自己生成的三行；
  - 两个文件都只新建，不覆盖已有的文件，也不建目录。卡片说明里写着回执路径。
- **任何应答**都先记进 `<callId>.answer.json`，批准时再写回执。记的是批没批，以及是怎么答的（`via`）：
  - `button`：带着这张卡片按钮的 id。Paseo App 和 IM 卡片会带；
  - `no-button`：没带，例如 `paseo permit allow/deny`、到期时运行时替人拒绝；
  - `typed`：卡片挂着的时候，有人在对话里打了字，按不批处理，打的字记成理由；
  - `form`、`dismiss`：只有带值的闸——带值的 allow（表单提交，或命令行 `--input`）、表单「不批」按钮发的 `Dismissed by user`；
  - `interrupt`：卡片被中断关闭（停止，或 Paseo 重载、替换这个会话），不是谁的裁决。
- **判定不在这里**（见 `orchestration/runtime/gate.mjs`）。运行时要回执与它预期的一致，**并且**应答记录是批准，
  才算批准。应答记录说"批了"而回执不在，或者回执在而记录是拒绝，都不算。
- **它不知道是谁答的**。Paseo 不记录应答方；`via` 是应答方自己发来的东西，是弱信号，本机任何进程都能伪造。

## 安装

```bash
paseo plugin install /absolute/path/to/orchestration-gate
paseo provider ls        # 应该能看到 orch-gate，状态 available
```

运行时开跑前会检查 `orch-gate` 是否可用；不可用时，会动用人闸的 flow 在花第一笔钱之前就被拒。没装插件的机器，
可以在私有 `roles/gate.md` 里把角色 `gate` 指向一个便宜模型（例如 `claude/claude-haiku-5-5`，`thinking: off`），
人闸就改用模型载体。模型载体没有应答记录，回执就是它的批准；它也可能拒绝当载体（从另一个 agent 的会话里起时
基本都会拒绝），所以只适合插件确实不可用的时候用。

冒烟（不花钱，内容是假的）：

```bash
node ../orchestration/runtime/orch.mjs run ../orchestration/flows/gate-smoke.mjs --round 1 --gate-timeout 30m
```

## 开发

```bash
npm ci
npm run typecheck
npm test     # 含一组契约测试：用运行时自己的 prepareGate / requestApproval 驱动这个 provider
```
