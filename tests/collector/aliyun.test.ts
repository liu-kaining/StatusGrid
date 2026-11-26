import { expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { createAdapter } from '../../src/collector/adapters/index.js';
import type { AdapterContext, BrowserResponse, ProviderConfig } from '../../src/shared/contracts.js';
import fixture from '../fixtures/aliyun/public.json';

const base = parseRegistry(registry).find(({ id }) => id === 'aliyun')!;
const config: ProviderConfig = { ...base, adapter: { ...base.adapter, requiredRegions: ['cn-shanghai'] } };
const payloads = {
  listProductRegionInAllZone: fixture.regions, listProductForAllTypeInRegion: fixture.products,
  listCurrentProductStatus: fixture.current, listEventInProgress: fixture.active,
};
function context(overrides: Record<string, unknown> = {}, browser = false): AdapterContext {
  const responses = { ...payloads, ...overrides };
  return {
    now: '2026-11-25T16:40:00Z', signal: new AbortController().signal,
    http: {
      getJson: async (url) => browser ? { success: false, code: 502, info: '不在白名单', data: null }
        : responses[new URL(url).pathname.split('/').at(-1)! as keyof typeof responses],
      getText: async () => { throw new Error('No page text'); },
      getResponse: async () => { throw new Error('No response'); },
    },
    browser: {
      collect: async () => Object.entries(responses).map(([name, body]): BrowserResponse => ({
        url: `https://status.aliyun.com/api/status/${name}${['listCurrentProductStatus', 'listProductForAllTypeInRegion'].includes(name) ? '?regionId=cn-shanghai' : ''}`,
        status: 200, body: JSON.stringify(body),
      })),
      close: async () => {},
    },
  };
}
it('accepts sparse current maps only after region, catalog and global active event checks', async () => {
  const output = await createAdapter(config).collect(config, context());
  expect(output.reportedStatus).toBe('operational');
  expect(output.components[0]).toMatchObject({ id: 'aliyun:cn-shanghai:ecs', region: 'cn-shanghai', reportedStatus: 'operational' });
  expect(output.coverage.limitation).toContain('declared');
});
it('uses successful page-owned API responses after direct HTTP business restriction', async () => {
  expect((await createAdapter(config).collect(config, context({}, true))).reportedStatus).toBe('operational');
});
it('does not announce normal from a directory when current event request fails', async () => {
  await expect(createAdapter(config).collect(config, context({
    listCurrentProductStatus: { success: false, code: 500, data: null },
  }))).rejects.toMatchObject({ reason: 'http_error' });
});
it('rejects missing required region responses and business restrictions in browser fallback', async () => {
  const expanded = { ...config, adapter: { ...config.adapter, requiredRegions: ['cn-shanghai', 'cn-beijing'] } };
  await expect(createAdapter(expanded).collect(expanded, context({}, true))).rejects.toMatchObject({ reason: 'coverage_incomplete' });
  await expect(createAdapter(config).collect(config, context({
    listProductRegionInAllZone: { success: false, code: 502, info: '不在白名单', data: null },
  }, true))).rejects.toMatchObject({ reason: 'blocked' });
});
it('keeps current map incidents with source start and updates, rejecting unresolved map references', async () => {
  const event = { id: 'event-1', title: 'Constructed issue', startTime: 1795623000000, eventUpdates: [
    { id: 'update-1', publishTime: 1795623600000, severity: 'ALARM', content: 'Investigating' },
  ] };
  const current = { success: true, code: 200, data: [{ eventDetails: { 'event-1': event },
    productStatus: { ecs: [{ eventId: 'event-1', impactLevel: 'ALARM' }] } }] };
  const output = await createAdapter(config).collect(config, context({ listCurrentProductStatus: current, listEventInProgress: { success: true, code: 200, data: [event] } }));
  expect(output.reportedStatus).toBe('partial_outage');
  expect(output.incidents[0]).toMatchObject({ upstreamId: 'event-1', affectedComponentIds: ['aliyun:cn-shanghai:ecs'] });
  current.data[0]!.eventDetails = {} as typeof current.data[0]['eventDetails'];
  await expect(createAdapter(config).collect(config, context({ listCurrentProductStatus: current })))
    .rejects.toMatchObject({ reason: 'coverage_incomplete' });
});
it('preserves an informational current overlay as an advisory without availability degradation', async () => {
  const event = { id: 'notice-1', title: 'Constructed notice', startTime: 1795623000000, eventUpdates: [
    { id: 'update-1', publishTime: 1795623600000, severity: 'NOTIFICATION', content: 'Notice' },
  ] };
  const output = await createAdapter(config).collect(config, context({
    listCurrentProductStatus: { success: true, code: 200, data: [{ eventDetails: { 'notice-1': event },
      productStatus: { ecs: [{ eventId: 'notice-1', impactLevel: 'NORMAL' }] } }] },
    listEventInProgress: { success: true, code: 200, data: [event] },
  }));
  expect(output.reportedStatus).toBe('operational');
  expect(output.incidents[0]).toMatchObject({ kind: 'advisory', severity: null, sourceSeverity: 'NORMAL' });
});
it('falls back for a restricted current API even when the public directory is accessible', async () => {
  const initial = context();
  const getJson = initial.http.getJson;
  initial.http.getJson = async (url, signal) => url.includes('listCurrentProductStatus')
    ? { success: false, code: 502, info: '不在白名单', data: null } : getJson(url, signal);
  expect((await createAdapter(config).collect(config, initial)).reportedStatus).toBe('operational');
});
