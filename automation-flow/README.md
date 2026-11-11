# automation-flow

Registers the `flow.run` automation action. It runs an allowed orchestration flow and returns its
outcome, cost, caveats, value excerpt and event file. A flow itself decides what to do on an error.
The plugin does not start an AI session.

## Settings

Host settings are stored at `plugin-settings/automation-flow/automation-flow.json`:

```json
{
  "version": 1,
  "values": {
    "allowedFlows": ["example-sync"],
    "orchestrationDir": "/path/to/orchestration",
    "defaultTimeout": "30m"
  }
}
```

`allowedFlows` defaults to `[]`: no flow can run until explicitly allowed. Names must match
`^[a-z][a-z0-9-]*$`; paths are not accepted. Allowing a flow trusts its code and effects.
Set `orchestrationDir` to the absolute path of the orchestration checkout. The current host does
not expose the plugin directory to its compiled bundle, so the plugin cannot safely locate the
sibling checkout automatically. If omitted, a run fails with a configuration error.
`defaultTimeout` accepts integer seconds, minutes or hours
(e.g. `90s`, `30m`, `1h`), from 1 second to 1 hour. It is published as the action's default.
The runner's timeout subtracts the time already spent checking and a 60-second reserve, rounded
down to seconds, with a minimum of 1 second. For short timeouts that reserve cannot be guaranteed.
An individual automation can override the host timeout; this is not passed to the action, so the
runner still uses the plugin default. Reload the plugin after changing the default: action metadata is
registered at startup. The allowlist and directory are read for each run.

Example, once `example-sync` is installed and allowed:

```sh
paseo automation create --action flow.run --param flow=example-sync --every 1h "同步异常时说明原因"
```

To pass flow inputs, use `--params-json` with an object such as
`{"flow":"example-sync","input":{"key":"value"}}`. The prompt is passed verbatim as
`automationPrompt` only when the allowed flow declares that input. To determine this the plugin
runs `orch.mjs check <flow>` for that flow only, then invokes `run` with a temporary input file.
Results and failures are recorded by the automation host; a stopped flow is reported as stopped.
A host cancellation kills the process tree. The flow's event file is the detailed record.
Results may be delivered to external channels: do not put sensitive content in flow values or caveats.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests use an `orch.mjs` stub for check and run; no real flow or daemon is started.
