Shows CRS Key spending and authorized Claude / Codex account windows in Paseo's Usage dialog. The CRS screen adds per-account bars, used/remaining views, explicitly estimated tier-weighted totals, and credential-free links to the CRS website. Shared windows do not guarantee capacity for the next request.

Requires a Paseo host and app supporting usage sources (SDK baseline 0.14.0-beta.2), and a CRS implementing `GET /apiStats/api/usage-snapshot`. Reads provider URLs from the host's Pi `models.json` and api_key credentials from the corresponding `auth.json` entries.

Configure allowed origins or provider names in plugin settings; both default to empty, hiding discovery and the sidebar entry. An allowed provider name trusts its configured origin. The Pi directory defaults to `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Set a management SPA prefix to enable Key/account links; otherwise only `/apiStats/` is offered. Website operations use the website's own login permissions.

Credentials stay on the host and travel only in the HTTP header to the approved origin. Same-origin, same-key providers merge. Reads share a 12-second minimum interval, a 9-second aborting timeout, and failure backoff with Retry-After. Failed reads keep their error status and the last successful timestamp. Missing values stay unknown. Pool totals use explicitly estimated tier weights and are omitted if any account has missing, unknown, or stale inputs.

The native card has flat windows and text details; grouped graphics and management buttons live in the screen. The screen follows Paseo's theme; the optional CRS midnight theme provides the mockup's dark blue palette.
