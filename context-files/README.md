# context-files

Paseo plugin. Appends files you name (a shared knowledge index, house rules) to the system prompt of every
new agent. The files are read when the agent is created, so editing one affects the next agent without a
plugin reload. Nothing else about the agent changes, and a file the plugin cannot read is skipped with a
log line -- creating an agent never fails because of it.

Use it to give every harness the same standing instructions without a per-tool config file: Paseo's
Codex and pi agents have no `CLAUDE.md` to import from, so the plugin carries the file in.

## How it works

- `agent.create` hook: for a provider in `providers`, the files are appended to `config.systemPrompt`,
  after whatever is already there (another plugin may have set it). Each file is wrapped in
  `<!-- context-files: <path> -->` ... `<!-- /context-files: <path> -->`. All three model providers
  append the text to their own prompt rather than replacing it. The prompt is stored with the agent, so it
  is still there when a session is resumed, and the hook is not run again then.
- A provider without a model (`orch-gate`, `reconcile`) is never touched, even if listed.
- Claude agents read their own `CLAUDE.md`, so by default they are skipped. If the create request turns
  `CLAUDE.md` loading off (`CLAUDE_CODE_DISABLE_CLAUDE_MDS` in its environment) and
  `claudeWhenClaudeMdDisabled` is on, the files are added after all.
- `agent.session_open` hook: adds `claudeEnv` to the environment of every Claude session, create and
  resume alike (the environment is not stored with the agent). Use it to set
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` when the files replace Claude Code's own memory.

## Settings

Stored by the daemon in `plugin-settings/context-files/context-files.json` as `{"version":1,"values":{...}}`.

| Setting | Default | Meaning |
|---|---|---|
| `files` | `[]` | Absolute paths, appended in order. A relative path, a missing file and an empty file are skipped. |
| `providers` | `["codex","pi"]` | Providers that get the files. |
| `claudeWhenClaudeMdDisabled` | `true` | See above. |
| `claudeEnv` | `{}` | Variables added to Claude sessions. |
| `cwdPrefixes` | `[]` | Only agents whose working directory is inside one of these directories. Empty: all. The hook is not given an agent's labels, so a directory is the way to scope a trial run. |
| `maxFileBytes` | `65536` | A longer file is cut at this many bytes (on a character boundary) and says so. |

## Limits

- Only new agents get the files. An agent that already exists keeps the prompt it was created with.
- The files go to the model provider: do not list a file that must not leave the machine.

## Development

```bash
npm install
npm run typecheck
npm test
```
