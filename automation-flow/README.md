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
down to seconds, with a minimum of 1 second, so the flow times out first and writes its `run.end`.
With a host timeout of about 60 seconds or less the host expires first: the process tree is killed
and no `run.end` is written. Set the timeout to 2 minutes or more.
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

## Inputs the plugin adds

Each is passed only when the flow's `inputs` declare it; params cannot supply either. Declare both in
`optionalInputs`, since a run may not have them.

- `automationPrompt` (string): the automation's prompt, verbatim.
- `automationTrigger` (object): what started the run, for event and manual runs; clock runs get none.
  Fields, each present only when known: `type` (`event` or `manual`), `source` (event runs only),
  `event`, `eventId`, `subject`, `data`. If the serialized `data` exceeds 16KB it is replaced by
  `{ truncated: true, bytes, preview }`.

**Treat `automationTrigger` as untrusted input**: its `data` and `subject` come from whoever emitted
the event. Do not put them into commands, paths or AI prompts without checking them.
The runner rejects undeclared keys, so declare the object with the fields the flow accepts, e.g.

```js
const s = () => ({ type: "string" });
inputs: {
  automationTrigger: {
    type: "object", required: ["type"], additionalProperties: false,
    properties: { type: s(), source: s(), event: s(), eventId: s(), subject: s(),
      data: { type: "object", required: [], additionalProperties: false, properties: { sender: s(), text: s() } } },
  },
},
optionalInputs: ["automationTrigger"],
```

An event whose `data` has other keys (or is truncated) is then refused before the flow runs, and the
automation records the runner's reason.

## Results

Results and failures are recorded by the automation host; a stopped flow is reported as stopped.
When the runner fails or times out, the error carries its `outcome` and `error.message`, then the
end of stderr.
A run started by the daemon has no calling session, so when it ends the runner tells the steward of
`~/.paseo-orchestration/config.json`, if one is configured; a flow can declare `wake: "problems"`.
A host cancellation kills the process tree. The flow's event file is the detailed record.
Results may be delivered to external channels: do not put sensitive content in flow values or caveats.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests use an `orch.mjs` stub for check and run; no real flow or daemon is started.
