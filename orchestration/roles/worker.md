---
provider: claude/claude-sonnet-5-5
# Sonnet 5.5, by decision (2026-10-16): it executes better than Sonnet 5 and
# costs less. Its plain id is already 1M tokens (contextWindowMaxTokens in
# `paseo provider models`), so there is no [1m] variant to pick; Sonnet 5
# needed `claude-sonnet-5[1m]` because its plain id was 200K.
# Thinking pinned to high: Sonnet 5 defaulted to high, Sonnet 5.5 defaults to
# medium, and the swap must not lower the depth unnoticed.
thinking: high
description: Everyday execution -- edits, tests, mechanical work with a clear spec. Calls that name neither a role nor a provider run as this one.
---
