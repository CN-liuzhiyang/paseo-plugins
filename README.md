# paseo-plugins

Plugins and tooling for [Paseo](https://paseo.sh), one directory each.

| Directory | What it is | Status |
|---|---|---|
| [`feishu/`](feishu/) | Paseo plugin. A resident dispatcher on the daemon that turns Feishu (Lark) messages and card callbacks into agent runs, and sends results, progress and approval requests back as one card updated in place. | Skeleton |
| [`orchestration/`](orchestration/) | Not a plugin: a Node runtime for deterministic flows that dispatch Paseo agents through the `paseo` CLI -- steps with output schemas and declared effects, roles, one event stream per run, and a human approval gate. | In use |

Install a plugin straight from this repository:

```bash
paseo plugin add CN-liuzhiyang/paseo-plugins:feishu
```

## Reuse Paseo, then add

A plugin adds only what Paseo does not already do. Timing, automation and orchestration use what
Paseo ships -- schedules, heartbeats, `notifyOnFinish`, the orchestration runtime -- and a channel
plugin such as `feishu/` is the way in and the way out: it turns messages into agent turns and
delivers what agents say back to the chat, whoever started the turn. When Paseo lacks something
generic, the fix is an extension point in Paseo, not a copy of it inside each plugin.

## Code here, data elsewhere

This repository holds code and the schemas of its configuration, never the configuration itself.
Who may message a bot, which chat routes to which workspace, where Paseo is installed on a machine,
private roles and scripts, credentials, audit logs -- all of that lives in Paseo's per-host plugin
settings, in `~/.paseo-orchestration/config.json`, or in the user's own private repositories.
Every table that grants access ships empty and fails closed.

Documentation inside each directory is in Chinese.

中文说明见各目录下的 README。原则：代码公开，数据私有——白名单、路由、凭据、机器配置、私有脚本和
审计日志都不进这个仓库。
