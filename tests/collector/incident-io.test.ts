import { expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { createAdapter } from '../../src/collector/adapters/index.js';
import { TransportError } from '../../src/collector/errors.js';
import type { AdapterContext, ProviderConfig } from '../../src/shared/contracts.js';
import summary from '../fixtures/incident-io/summary.json';

const base = parseRegistry(registry).find(({ id }) => id === 'openai')!;
const config: ProviderConfig = { ...base, adapter: { ...base.adapter, type: 'incident-io',
  sourcePageId: '01JMDK9XYNY6RXSED6SDWW50WY',
  browserFallback: true, endpoints: { page: 'https://status.openai.com/' } } };
const page = (...snapshots: unknown[]) => `<html><script>self.__next_f.push([1,${JSON.stringify(
  snapshots.map((snapshot, index) => `${index.toString(16)}:${JSON.stringify(['$', '$L1', null, { payload: snapshot }])}\n`).join(''),
)}])</script></html>`;
function context(html = page(summary), fallback = false): AdapterContext {
  return {
    now: '2026-11-25T17:00:00Z', signal: new AbortController().signal,
    http: {
      getText: async () => { if (fallback) throw new TransportError('http_error', 'Page network failure'); return html; },
      getJson: async () => { throw new Error('Legacy summary cannot prove current state'); },
      getResponse: async () => { throw new Error('No response'); },
    },
    browser: { collect: async () => [{ url: config.officialStatusUrl, status: 200, body: html }], close: async () => {} },
  };
}
it('uses the native summary identity, sparse current impact, true groups and publish/update times', async () => {
  const output = await createAdapter(config).collect(config, context());
  expect(output.reportedStatus).toBe('degraded');
  expect(output.components.map(({ groupId }) => groupId)).toEqual([
    'openai:01K5H8S53SY1KMS4GQMNMZXTR1', 'openai:01K5H8S53SY1KMS4GQMNMQM1K5', 'openai:01KMKF9EBTCD8BN9PG8DJZXRSQ',
  ]);
  expect(output.components.map(({ reportedStatus }) => reportedStatus)).toEqual(['operational', 'operational', 'degraded']);
  expect(output.incidents[0]).toMatchObject({
    upstreamId: '01M89RGC3STKK2MT53TXHFMY4H', state: 'monitoring', severity: 'degraded', sourceSeverity: 'degraded_performance',
    startedAt: '2026-11-25T16:27:02.136Z', updatedAt: '2026-11-25T16:58:51.832Z',
    startTimeBasis: 'source_started_at', resolvedAt: null, postmortemUrl: null,
    sourceUrl: 'https://status.openai.com/',
  });
  expect(output.incidents[0]!.updates[1]!.body).toContain('confirm recovery');
  expect(output.evidence.currentIncidentIds).toEqual(['openai:01M89RGC3STKK2MT53TXHFMY4H']);
});
it('uses exact homepage HTML browser fallback and accepts identical summary copies', async () => {
  const output = await createAdapter(config).collect(config, context(page(summary, summary), true));
  expect(output.components).toHaveLength(3);
});
it('blocks legacy/missing, conflicting, or wrong-page structured summaries', async () => {
  for (const html of [
    '<html>Currently experiencing issues</html>',
    page(summary, { ...summary, affected_components: [] }),
    page({ ...summary, id: 'another-page' }),
    page({ ...summary, public_url: 'https://other.example/' }),
  ]) {
    await expect(createAdapter(config).collect(config, context(html))).rejects.toMatchObject({ reason: 'coverage_incomplete' });
  }
});
it('requires explicit affected/current arrays and resolvable component IDs before assigning normal complement', async () => {
  for (const payload of [
    { ...summary, affected_components: undefined },
    { ...summary, ongoing_incidents: undefined },
    { ...summary, scheduled_maintenances: undefined },
    { ...summary, affected_components: [{ component_id: 'unknown', status: 'degraded_performance' }] },
  ]) {
    await expect(createAdapter(config).collect(config, context(page(payload)))).rejects.toMatchObject({ reason: 'coverage_incomplete' });
  }
});
it('fails closed for unknown native statuses and ignores nonliteral executable Flight calls', async () => {
  await expect(createAdapter(config).collect(config, context(page({ ...summary,
    affected_components: [{ component_id: '01JVCV8YSWZFRSM1G5CVP253SK', status: 'future-status' }],
  })))).rejects.toMatchObject({ reason: 'unknown_status' });
  await expect(createAdapter(config).collect(config, context('<script>self.__next_f.push([1,runCode()])</script>')))
    .rejects.toMatchObject({ reason: 'coverage_incomplete' });
});
it('uses publication when the native incident has no impact start and does not treat sentinel as a date', async () => {
  const payload = structuredClone(summary);
  payload.ongoing_incidents[0]!.component_impacts = [];
  const output = await createAdapter(config).collect(config, context(page(payload)));
  expect(output.incidents[0]).toMatchObject({ startTimeBasis: 'source_published_at', startedAt: '2026-11-25T16:27:02.136Z' });
});
it('keeps constructed future maintenance separate from current impact and applies in-progress maintenance', async () => {
  const maintenance = { ...structuredClone(summary.ongoing_incidents[0]!), id: 'constructed-maintenance',
    type: 'maintenance', status: 'maintenance_scheduled',
    affected_components: [{ component_id: '01JVCV8YSWZFRSM1G5CVP253SK', current_status: 'under_maintenance', status: 'under_maintenance' }],
    component_impacts: [{ component_id: '01JVCV8YSWZFRSM1G5CVP253SK', start_at: '2026-11-26T10:00:00Z', end_at: '2026-11-26T11:00:00Z', status: 'under_maintenance' }],
    status_summaries: [{ start_at: '2026-11-26T10:00:00Z', end_at: '2026-11-26T11:00:00Z', worst_component_status: 'under_maintenance' }],
    updates: [{ id: 'schedule-update', published_at: '2026-11-25T16:00:00Z', to_status: 'maintenance_scheduled', message_string: 'Planned maintenance' }],
  };
  let payload = { ...summary, affected_components: [], ongoing_incidents: [], scheduled_maintenances: [maintenance] };
  let output = await createAdapter(config).collect(config, context(page(payload)));
  expect(output.reportedStatus).toBe('operational');
  expect(output.incidents[0]).toMatchObject({ kind: 'maintenance', state: 'scheduled', startedAt: '2026-11-26T10:00:00.000Z' });
  maintenance.status = 'maintenance_in_progress';
  maintenance.component_impacts[0]!.start_at = '2026-11-25T16:00:00Z';
  maintenance.updates.push({ id: 'start-update', published_at: '2026-11-25T16:00:00Z',
    to_status: 'maintenance_in_progress', message_string: 'Maintenance started' });
  payload = { ...payload, scheduled_maintenances: [maintenance] };
  output = await createAdapter(config).collect(config, context(page(payload)));
  expect(output.reportedStatus).toBe('maintenance');
  expect(output.components[2]!.reportedStatus).toBe('maintenance');
});
it('maps the source full_outage enum to major_outage and retains the native severity', async () => {
  const payload = structuredClone(summary);
  payload.affected_components[0]!.status = 'full_outage';
  payload.ongoing_incidents[0]!.affected_components[0]!.status = 'full_outage';
  payload.ongoing_incidents[0]!.affected_components[0]!.current_status = 'full_outage';
  payload.ongoing_incidents[0]!.component_impacts[0]!.status = 'full_outage';
  const output = await createAdapter(config).collect(config, context(page(payload)));
  expect(output.reportedStatus).toBe('major_outage');
  expect(output.incidents[0]!.sourceSeverity).toBe('full_outage');
});
it('rejects a future-dated component impact from establishing current severity', async () => {
  const payload = structuredClone(summary);
  payload.ongoing_incidents[0]!.component_impacts[0]!.start_at = '2026-11-25T17:00:01Z';
  await expect(createAdapter(config).collect(config, context(page(payload))))
    .rejects.toMatchObject({ reason: 'coverage_incomplete' });
});
