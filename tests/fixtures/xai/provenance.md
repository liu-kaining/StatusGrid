# xAI public status API fixtures

Captured on 2026-11-27 around 07:51–07:55 UTC from the user-supplied official origin:

- `https://status.x.ai/api/status`
- `https://status.x.ai/api/incidents?status=active`
- `https://status.x.ai/api/incidents?status=resolved`

The active/resolved query contract was also confirmed by the API's response to
`status=all`: `status must be active or resolved.`

`status.json` keeps three real product entries and five real component rows,
omitting other rows for a small structural fixture. The actual complete endpoint
listed eight product families and 61 components. `active.json` retains the real
active incident and both source updates. `history.json` keeps the first of the
20 returned resolved incidents. Public source text, IDs and timestamps are
unchanged. Tests explicitly construct mutations for other states and failures.

At capture, overall/product status was `available`, while two API components
were marked `info` and the active incident's impact was `none`. These fields
must not be upgraded into an invented outage severity. The adapter preserves
the active advisory with unknown severity and `info` component state as null.
Finite resolved history is native history, not an all-time history guarantee.

Local direct requests encountered incorrect DNS and timeouts; read-only capture
used the already-configured operating-system SOCKS proxy. The parser and deployed
collector do not contain proxy addresses, DNS overrides or credentials.
