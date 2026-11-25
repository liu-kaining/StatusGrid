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
