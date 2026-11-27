Fixture summaries are representative excerpts of official API responses captured
on 2026-11-25 UTC. Each excerpt retains source IDs, status, time and core
incident fields, but omits unrelated rows and long update bodies. Full raw
responses and request metadata remain in the ignored
`.statusgrid/statuspage-samples/` directory at:

`cloudflare/maintenance.json` is a representative excerpt of the first native
`scheduled_maintenances` entry in Cloudflare's saved summary; tests construct
its in-progress and completed lifecycle variants explicitly.

- cloudflare: `2026-11-25T14-16-53-599Z/cloudflare/`
- github, openai, moonshot: `2026-11-25T14-16-53-600Z/{provider}/`
- claude: `2026-11-25T14-18-33-322Z/claude/`

Additional edge-case payloads in the tests (unknown enumerations, missing
fields, duplicate labels, lifecycle variants) are constructed variants.

`devin/snapshot.json` and `factory/snapshot.json` retain the full current component
directories, actual empty active/maintenance lists and one recent resolved native
event each. Responses were read from each official host's `/api/v2/summary.json`,
`/api/v2/incidents/unresolved.json` and `/api/v2/incidents.json`:

| Host | Captured (UTC) | Summary SHA-256 | History SHA-256 |
| --- | --- | --- | --- |
| `www.devinstatus.com` | 2026-11-27T07:55:11.565Z | `1e64117599ba966ee2067dcaf5545e0f3d9eca2738b9cc42e5204d7fbcdfbf87` | `9090e01768a0dd448e6409279680cbbdc0158ec0c22112309ecadc54c6995ef5` |
| `status.factory.ai` | 2026-11-27T07:52:37.880Z | `369f0c2b8348fcc1cf38aeabbefb517c8ac0efe0ec1dd6557f966a73e7739209` | `b1b7fb47ccf6ce5e588222e3ae0d2aa4117db6597abd0aaf146be27938f06d18` |

All six responses were HTTP 200 JSON. Local direct routing to Devin timed out;
the captured responses used the machine's existing SOCKS proxy, without changing
network configuration. Raw bytes/metadata remain under ignored
`.statusgrid/five-ai-probes/`. Minimized files omit descriptions, presentation
metadata and older history; source identities, statuses and timestamps are retained.
