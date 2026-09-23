---
provider: claude/claude-sonnet-5[1m]
# [1m] = 1M-token context, by decision (2026-09-23): the plain id is 200K, and
# real tasks (a hotfix draft reads the skill docs plus several large source
# files) run out. The [1m] variant is a separate id in `paseo provider models`.
description: Everyday execution -- edits, tests, mechanical work with a clear spec. Calls that name neither a role nor a provider run as this one.
---
