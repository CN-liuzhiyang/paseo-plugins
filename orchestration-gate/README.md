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

## 它做什么、不做什么

- 运行时在回执路径旁边写一份请求文件（`<callId>.request.json`），把文件路径和 sha256 写进 prompt。
  provider 先核对这份文件的 sha256，再核对原文的 sha256，两个都对才起卡片；任何一个不对，就不起卡片，
  并记一条错误。
- **批准**：把请求里给的回执原样写到回执路径。回执是三行：决定、run 和 call、原文 sha256。
- **任何应答**都记进 `<callId>.answer.json`：批没批，以及是怎么答的（`via`）：
  - `button`：带着这张卡片按钮的 id。Paseo App 和 IM 卡片会带；
  - `no-button`：没带，例如 `paseo permit allow/deny`、到期时运行时替人拒绝、中断；
  - `typed`：卡片挂着的时候，有人在对话里打了字，按不批处理，打的字记成理由。
- **判定不在这里**。运行时只看回执文件是否与它预期的一致（见 `orchestration/runtime/gate.mjs`）。
  answer 文件只说明应答是怎么来的，它说"批了"而回执不在，也不算批准。
- **它不知道是谁答的**。Paseo 不记录应答方；`via` 是应答方自己发来的东西，是弱信号，本机任何进程都能伪造。

## 安装

```bash
paseo plugin install /absolute/path/to/orchestration-gate
paseo provider ls        # 应该能看到 orch-gate，状态 available
```

运行时开跑前会检查 `orch-gate` 是否可用；不可用时，会动用人闸的 flow 在花第一笔钱之前就被拒。没装插件的机器，
可以在私有 `roles/gate.md` 里把角色 `gate` 指向一个便宜模型（例如 `claude/claude-haiku-5-5`，`thinking: off`），
人闸就改用模型载体，判定方式完全一样。

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
