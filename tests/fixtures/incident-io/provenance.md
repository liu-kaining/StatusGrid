The summary fixture is a reviewed three-component subset of the public OpenAI
incident.io Flight summary captured by ordinary browser on 2026-11-25 at
`.statusgrid/source-samples/openai-browser/{page.html,structured.json}`.
IDs, group membership, incident title, publish time and update times are native.
The older status summary interval was deliberately changed to full_outage to
prove ended intervals cannot override current component impact. Update messages
are shortened. Maintenance and malformed variants in tests are constructed;
the captured page had an explicit empty scheduled_maintenances array.
Native enum and maintenance time-field characterization on 2026-11-26 used the
official page-owned public chunk `/_next/static/chunks/4128kizc0ru5y.js`:
full_outage, maintenance_scheduled, maintenance_in_progress,
maintenance_complete, and component_impacts start_at/end_at. Its maintenance
UI derives its displayed start from component_impacts, with published_at only
as fallback; no scheduled_start_at or scheduled_end_at fields are present.
Maintenance records in tests remain constructed because none was observed live.
No executable source scripts, request headers, tokens, or recording are copied.
