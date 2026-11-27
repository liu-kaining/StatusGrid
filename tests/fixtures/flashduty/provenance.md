# Flashduty source samples

These are reviewed, minimized JSON projections from official public Next Flight responses, not complete HTML captures. Tests wrap the preserved properties in inert Flight JSON string literals. UI translations, styles, logos, and volatile request timestamps are omitted.

| Source | Retrieved UTC | HTTP | Original HTML SHA-256 |
| --- | --- | --- | --- |
| `https://status.minimax.cn/` | 2026-11-27T06:59:58.887Z | 200 | `9940996db201c2fa6b140e4395de9dc9751844ae67b30f1ca18864f4b29af7bc` |
| `https://status.streamlake.com/` | 2026-11-27T06:59:58.844Z | 200 | `412cf5f92614c45019df28f6dced2cda365cc67359e80aed61136951cde67edd` |
| `https://status.streamlake.com/history` | 2026-11-27T07:15:42.305Z | 200 | `66f294a81dbae1be8916a6f512297f6ad8b835a9750bd328d8ca939942e36bc1` |

- MiniMax's five component IDs, names, video section ID, and one resolved incident are preserved. The original November calendar response supplied 26 events, including earlier dates; this fixture retains only incident `7307657128086`. Its timestamps and update impact are real source values.
- StreamLake's six component IDs and names are preserved. Its list view really supplies `initialCalendarData: "$undefined"` in the Flight wire representation.
- StreamLake's history page supplied the preserved `initialChanges: []` and November 2026 `initialMonth`. This establishes only the supplied history window, not unlimited incident-free history. Its Atom feed was also empty and is not used as proof of health.
- Wrong identities, active incidents, malformed arrays, and transport failures in tests are constructed mutations. They are not claims that an actual outage or response failure was observed.
- Full transport captures and local live diagnostic reports remain in ignored `.statusgrid/` paths and are not committed.
