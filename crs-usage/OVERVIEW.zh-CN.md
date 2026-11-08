在 Paseo「使用情况」中显示 CRS Key 的今日和累计费用，以及授权范围内 Claude / Codex 账号的窗口用量。侧栏「CRS 用量与管理」提供逐账号双进度条、已用 / 剩余切换、标为估算的档位折合和 CRS 网页入口。账号窗口是共享消耗，不能保证下一请求可用多少。

需要支持 usage-source 的 Paseo（SDK 基线 0.14.0-beta.2）及实现只读 `GET /apiStats/api/usage-snapshot` 接口的 CRS。主机 Pi 配置目录须有 `models.json` 与同名 provider 的 `auth.json` api_key 项。

在插件设置中填写 CRS 地址白名单或 Pi provider 名称，默认均为空，未配置时不发现来源、不显示侧栏入口。地址白名单按 origin 匹配；provider 名称代表信任该 provider 当前配置的 origin。Pi 配置目录可留空以使用 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`。管理网页 SPA 前缀留空时只显示 `/apiStats/` 用量入口；填写后另显示 Key 与账号管理入口，需要 CRS 网页自己的登录权限。

Key 仅由主机服务端读取，作为 HTTP header 发送给允许的 CRS，不写入插件设置或发给客户端。网页链接不携带 Key 或 apiId。同 origin、同 Key 合并；12 秒内复用同一读取结果，9 秒超时后中止，失败按 30 / 60 / 120 / 240 / 300 秒退避并加少量抖动，遵从 Retry-After。失败明确提示，并保留上次成功数据的时间。

缺失数据保留未知。粗略折合使用 max20=20、max5=5、pro/plus/team=1、free=0.2 的估算权重；任一账号档位未知、窗口缺失或数据陈旧时不给全池估算。原生卡仅支持平铺窗口和文字明细，图形分组和操作按钮在独立面板。面板遵从当前 Paseo 主题；可选「CRS 夜色」还原示意稿的深蓝配色。
