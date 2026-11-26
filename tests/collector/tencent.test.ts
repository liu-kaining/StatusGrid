import { expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { createAdapter } from '../../src/collector/adapters/index.js';
import { collectProviders } from '../../src/collector/run.js';
import type { AdapterContext, ProviderConfig } from '../../src/shared/contracts.js';
import fixture from '../fixtures/tencent/public.json';

const base = parseRegistry(registry).find(({ id }) => id === 'tencent-cloud')!;
const config: ProviderConfig = { ...base, adapter: { ...base.adapter, requiredRegions: ['ap-shanghai', 'ap-beijing'] } };
const now = '2026-11-25T16:20:00Z';
function context(current: unknown = fixture.current, regions: unknown = fixture.regions): AdapterContext {
  return {
    now, signal: new AbortController().signal,
    http: {
      getJson: async (value) => {
        const url = new URL(value);
        if (url.pathname.endsWith('/DescribeRegions')) return regions;
        if (url.pathname.endsWith('/DescribeProductsByRegion')) return fixture.products;
        if (url.pathname.endsWith('/DescribeProductEventForRegionInPeriod')
          && url.searchParams.get('EndDate') === '2026-11-26'
          && url.searchParams.get('NumOfDay') === '7'
          && config.adapter.requiredRegions.includes(url.searchParams.get('RegionId')!)) return current;
        throw new Error(`Unexpected public query ${value}`);
      },
      getText: async () => { throw new Error('Unexpected page scraping'); },
      getResponse: async () => { throw new Error('Unexpected response'); },
    },
    browser: { collect: async () => { throw new Error('Public HTTP should suffice'); }, close: async () => {} },
  };
}
it('checks each declared region against a nonempty catalog and current counts using Shanghai calendar date', async () => {
  const output = await createAdapter(config).collect(config, context());
  expect(output.reportedStatus).toBe('operational');
  expect(output.components.map(({ id, region }) => [id, region])).toEqual([
    ['tencent-cloud:ap-shanghai:cvm', 'ap-shanghai'], ['tencent-cloud:ap-beijing:cvm', 'ap-beijing'],
  ]);
  expect(output.coverage).toMatchObject({ currentState: 'complete', regions: ['ap-shanghai', 'ap-beijing'] });
  expect(output.coverage.limitation).toContain('declared');
});
it('does not treat uninitialized SSR zero counts as an initialized current view', async () => {
  const current = structuredClone(fixture.current);
  current.Response.Data.Summary.NormalCount = 0;
  current.Response.Data.CategoryList = [];
  await expect(createAdapter(config).collect(config, context(current))).rejects.toMatchObject({ reason: 'coverage_incomplete' });
});
it('rejects business errors instead of accepting HTTP200 as data', async () => {
  await expect(createAdapter(config).collect(config, context({ Response: { Error: { Code: 'InvalidParameter' } } })))
    .rejects.toMatchObject({ reason: 'http_error' });
});
it('fails collection at the production run boundary when a required region is missing', async () => {
  const run = await collectProviders([config], new Map(), { ...context(fixture.current,
    { Response: { Data: { AreaDetailList: [{ RegionList: [{ RegionId: 'ap-shanghai' }] }] } } }), intervalMinutes: 5 });
  expect(run.providers[0]).toMatchObject({ result: null, collection: { outcome: 'failure', reason: 'coverage_incomplete' } });
});
it('uses current event updates for an abnormal product and rejects unknown current states', async () => {
  const product = { ...fixture.current.Response.Data.CategoryList[0]!.ProductList[0]!,
    CurrentStatus: 'ABNORMAL', CurrentEvent: { EventItemList: [{ Title: 'Constructed service issue', ZoneEventList: [
    { EventId: 'event-1', Status: 'ABNORMAL', EventTime: '2026-11-26 00:10:00', Content: 'Investigating' },
  ] }] } };
  const current = { Response: { Data: { Summary: { NormalCount: 0, NotifyCount: 0, AbnormalCount: 1 },
    CategoryList: [{ CategoryName: '计算', ProductList: [product] }] } } };
  const output = await createAdapter(config).collect(config, context(current));
  expect(output.reportedStatus).toBe('partial_outage');
  expect(output.incidents[0]).toMatchObject({ title: 'Constructed service issue', startedAt: '2026-11-25T16:10:00.000Z', startTimeBasis: 'source_published_at' });
  expect(output.evidence.currentIncidentIds).toHaveLength(2);
  product.CurrentStatus = 'FUTURE';
  await expect(createAdapter(config).collect(config, context(current))).rejects.toMatchObject({ reason: 'unknown_status' });
});
it('preserves a Tencent NOTIFY as an advisory without inventing availability degradation', async () => {
  const product = { ...fixture.current.Response.Data.CategoryList[0]!.ProductList[0]!,
    CurrentStatus: 'NOTIFY', CurrentEvent: { EventItemList: [{ Title: 'Constructed notice', ZoneEventList: [
    { EventId: 'notice-1', Status: 'NOTIFY', EventTime: '2026-11-26 00:10:00', Content: '<p>Service notice</p>' },
  ] }] } };
  const current = { Response: { Data: { Summary: { NormalCount: 0, NotifyCount: 1, AbnormalCount: 0 },
    CategoryList: [{ CategoryName: '计算', ProductList: [product] }] } } };
  const output = await createAdapter(config).collect(config, context(current));
  expect(output.reportedStatus).toBe('operational');
  expect(output.incidents[0]).toMatchObject({ kind: 'advisory', severity: null, sourceSeverity: 'NOTIFY' });
  expect(output.incidents[0]!.updates[0]!.body).toBe('Service notice');
});
