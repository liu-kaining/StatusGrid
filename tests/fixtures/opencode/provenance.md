# OpenCode public API fixture

Captured 2026-11-27T07:50:20Z from `https://status.opencode.ai/api/status`.
The official homepage links this unauthenticated JSON API and documents its
current status, incidents and three-hour history. `view.js` on the same official
host defines the six public service names, incident titles, grouping by `event`,
and the recovery hold: an open incident with healthy components is monitoring,
not resolved. `app.js` masks snapshots older than three minutes as unknown.

`status.json` preserves all six service rows, both actual open incidents, and
the most recent resolved incident, including original IDs, epochs and model
references. Unused speed, model breakdown and three-hour history fields, and
older resolved rows, are omitted to keep the regression fixture focused.
All state, time, missing-field and note variants in the tests are explicitly
constructed; they are not claimed to be captured outages or manual updates.

OpenCode monitors its own console/inference services. Plan health follows its
most-used models and does not represent every possible upstream model or every
OpenCode client installation.
