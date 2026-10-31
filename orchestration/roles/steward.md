---
provider: claude/claude-sonnet-5-5
# A long-lived session that is told, one message at a time, how the runs of flows ended, and looks into the ones that did not come out
# right. It reads a lot and changes little; Sonnet 5.5 at high thinking, as for the everyday worker. Change this file to change the model
# of every steward the runtime starts (a deployment can also name another role in config.json, `stewards`).
thinking: high
description: The session that watches the runs of flows -- told when a run ends, looks at why it stopped or failed, carries it on or fixes the flow. Started by the runtime (wake.mjs) where config.json says, and reused after that.
---
