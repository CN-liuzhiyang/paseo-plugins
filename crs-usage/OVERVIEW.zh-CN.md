在 Paseo「使用情况」中显示 CRS Key 今日和累计费用，以及授权范围内 Claude / Codex 账号的窗口用量。侧栏「CRS 用量与管理」提供逐账号进度条、已用 / 剩余切换、标为估算的档位折合和无凭据网页入口。共享窗口不能保证下一请求可用多少。

需要支持 usage-source 的 Paseo（SDK 基线 0.14.0-beta.2）及实现只读 `GET /apiStats/api/usage-snapshot` 接口的 CRS。

一般不用填设置。自动读取主机 Pi 的 `models.json` / `auth.json` api_key、Claude Code `settings.json` 的 env（`ANTHROPIC_BASE_URL` 加 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`）、Codex `config.toml` 选中的自定义 provider 加 `auth.json` API key。不会使用 OAuth 凭据；文件不存在或读不到就跳过。遵从各工具的主目录环境变量；Pi 目录默认为 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`。

用各候选自己的 key 探测其 origin 下的快照接口。跳过 `api.anthropic.com`、`api.openai.com` 及其子域。JSON 200/401/403 识别为 CRS；其他服务隐藏。按 origin 和凭据摘要在内存缓存，正向 24 小时、负向 10 分钟。HTTP 返回 403 `Management HTTPS required` 时，只尝试同主机名 HTTPS 443，成功后记住管理地址。不会跟随重定向或错误正文里的地址，证书校验保持启用。

`allowedOrigins` / `providerNames` 是可选来源筛选，非空时只探测命中的地址 / provider，两项均填则均需匹配；留空即自动。`managementOrigin` 可显式覆盖所有候选的取数和网页地址，须为 HTTPS origin；请只填写你信任接收这些 key 的管理地址。管理网页 SPA 前缀留空时只提供 `/apiStats/`；填写后另有 Key 和账号入口，操作遵从网页自身登录权限。

Key 仅在服务端读取，通过 HTTP header 发往配置来源、同主机 HTTPS 管理入口或显式覆盖的管理地址，不进入插件设置或客户端；网页链接不带 key / apiId。同 origin、同 key 合并。读取共用 12 秒最短间隔、9 秒超时 Abort、30 / 60 / 120 / 240 / 300 秒失败退避及少量抖动，遵从 Retry-After；失败明确提示并保留上次成功时间。

缺失值保留未知；费用上限为 null 显示「无上限」，面板不画费用进度条。粗略折合权重为 max20=20、max5=5、pro/plus/team=1、free=0.2，仅纳入档位已知、可用且窗口有效的账号，标明数量。过期窗口显示采集时间，不显示当前百分比；不可用账号显示为灰色一行。主/次窗口时长未知时保留原标签，不猜成 5 小时或本周。

原生卡使用宿主的平铺窗口和文字明细，未知值轨道由宿主 renderer 决定；图形分组和管理按钮在独立面板。面板遵从当前主题，可选「CRS 夜色」提供示意稿的深蓝配色。
