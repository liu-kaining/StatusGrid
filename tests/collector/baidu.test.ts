import { expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { createAdapter } from '../../src/collector/adapters/index.js';
import type { AdapterContext, BrowserResponse, ProviderConfig } from '../../src/shared/contracts.js';
import fixture from '../fixtures/baidu/public.json';

const base = parseRegistry(registry).find(({ id }) => id === 'baidu-cloud')!;
const config: ProviderConfig = { ...base, adapter: { ...base.adapter, requiredRegions: ['华北-北京', '华东-上海'] } };
function context(current: unknown = fixture.current, includeShanghai = true): AdapterContext {
  const responses: BrowserResponse[] = [
    { url: 'https://cloud.baidu.com/dashboard/v1/get_region', status: 200, body: JSON.stringify(fixture.regions) },
    { url: 'https://cloud.baidu.com/dashboard/v1/get_banner', status: 200, body: JSON.stringify(fixture.banner) },
  ];
  for (const region of includeShanghai ? config.adapter.requiredRegions : ['华北-北京']) {
    responses.push({ url: 'https://cloud.baidu.com/dashboard/v1/get_prod_by_region', status: 200,
      body: JSON.stringify(fixture.products), requestScope: { region } });
    responses.push({ url: 'https://cloud.baidu.com/dashboard/v1/get_event_info', status: 200,
      body: JSON.stringify(current).replaceAll('华北-北京', region), requestScope: { region } });
  }
  return {
    now: '2026-11-25T16:20:00Z', signal: new AbortController().signal,
    http: { getJson: async () => { throw new Error('No signed API replay'); }, getText: async () => '', getResponse: async () => { throw new Error('No response'); } },
    browser: { collect: async () => responses, close: async () => {} },
  };
}
it('checks browser request scope, each region catalog and current rows, ignoring an off banner', async () => {
  const output = await createAdapter(config).collect(config, context());
  expect(output.reportedStatus).toBe('operational');
  expect(output.components.map(({ region }) => region)).toEqual(['华北-北京', '华东-上海']);
  expect(output.components[0]!.upstreamId).not.toBeNull();
  expect(output.coverage.limitation).toContain('name');
});
it('blocks directory-only data and missing required region instead of declaring normal', async () => {
  await expect(createAdapter(config).collect(config, context(fixture.current, false))).rejects.toMatchObject({ reason: 'coverage_incomplete' });
});
it('rejects challenge/error responses and uninitialized all-zero counts', async () => {
  await expect(createAdapter(config).collect(config, context({ code: 90003, msg: 'DEVICE sign error' }))).rejects.toMatchObject({ reason: 'blocked' });
  await expect(createAdapter(config).collect(config, context('<html>challenge</html>'))).rejects.toMatchObject({ reason: 'invalid_payload' });
  await expect(createAdapter(config).collect(config, context({ code: 0, data: { event_ok: 0, event_error: 0, event_info: 0, event: [] } })))
    .rejects.toMatchObject({ reason: 'coverage_incomplete' });
});
it('uses nowtime for current state and retains dated historical incidents separately', async () => {
  const restored = { status: 'error', title: 'Constructed restored issue',
    s_time: '2026-11-25 10:00:00', e_time: '2026-11-25 11:00:00', s_msg: 'Investigating', e_msg: 'Restored' };
  const current = { ...fixture.current, data: { ...fixture.current.data, event: [
    { ...fixture.current.data.event[0]!, '2026-11-25': restored },
  ] } };
  let output = await createAdapter(config).collect(config, context(current));
  expect(output.reportedStatus).toBe('operational');
  expect(output.incidents[0]).toMatchObject({ state: 'resolved', resolvedAt: '2026-11-25T03:00:00.000Z' });
  current.data.event[0]!.nowtime = { ...restored, title: 'Constructed current issue', e_time: '', e_msg: '' };
  current.data.event_ok = 0; current.data.event_error = 1;
  output = await createAdapter(config).collect(config, context(current));
  expect(output.reportedStatus).toBe('partial_outage');
  expect(output.evidence.currentIncidentIds).toHaveLength(2);
});
it('preserves informational nowtime as an advisory without asserting an availability outage', async () => {
  const current = { ...fixture.current, data: { ...fixture.current.data, event_ok: 0, event_info: 1, event: [
    { ...fixture.current.data.event[0]!, nowtime: { status: 'info', title: 'Constructed notice',
      s_time: '2026-11-26 00:10:00', e_time: '', s_msg: 'Notice', e_msg: '' } },
  ] } };
  const output = await createAdapter(config).collect(config, context(current));
  expect(output.reportedStatus).toBe('operational');
  expect(output.incidents[0]).toMatchObject({ kind: 'advisory', severity: null, sourceSeverity: 'info' });
});
it('does not claim native history when only current nowtime was supplied', async () => {
  const current = { ...fixture.current, data: { ...fixture.current.data,
    event: fixture.current.data.event.map(({ region, product, nowtime }) => ({ region, product, nowtime })),
  } };
  const output = await createAdapter(config).collect(config, context(current));
  expect(output.reportedStatus).toBe('operational');
  expect(output.coverage.history).toBe('none');
});
