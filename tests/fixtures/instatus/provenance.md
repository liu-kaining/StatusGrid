# Instatus / Zed fixtures

Captured from the official public status pages on 2026-11-27 (Asia/Shanghai):

- `https://status.zed.dev/`: `zed.json` contains the relevant inert Next Flight properties: page identity, full nested component directory and explicit active incident, maintenance and generic-notice arrays.
- `https://status.zed.dev/history`: `zed-history.json` contains the native three-month notice window, minimized to identity and incident fields consumed by the parser. IDs, timestamps, states, impact and update messages are source values. The October incident includes a resolution followed by reopening, and a later final resolution; its final `resolved` timestamp is preserved.
- `https://status.zed.dev/public-api` documents `/v3/summary.json` and `/v3/components.json`. The observed empty summary omits its active arrays, so the adapter uses the atomically rendered homepage properties to require explicit current coverage.
- `https://instatus.com/help/api` and `https://instatus.com/help/api/public-data` document native component, page, incident and maintenance status values.

The tests serialize these captured properties into minimal Flight literal wrappers. Abnormal current snapshots, unknown/missing fields, identity conflicts and maintenance cases are explicitly constructed mutations, not historical claims. Historical coverage is the finite native window from `/history`, not guaranteed complete archival history. Page scripts are never evaluated.
