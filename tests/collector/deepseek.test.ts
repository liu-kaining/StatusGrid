import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { parseDeepSeek } from '../../src/collector/adapters/deepseek.js';
import { collectProviders } from '../../src/collector/run.js';
import { parseCollectArgs } from '../../src/collector/cli.js';
import history from '../fixtures/deepseek/history.json';
import { deepseekAdapter } from '../../src/collector/adapters/deepseek.js';
import { TransportError } from '../../src/collector/errors.js';

const config = parseRegistry(registry).find(({ id }) => id === 'deepseek')!;
const now = '2026-11-25T16:20:00Z';
const page = readFileSync('tests/fixtures/deepseek/page.txt', 'utf8');
const withHistory = (snapshot: string, payload: unknown) => snapshot.replace('</script>',
  `self.__next_f.push([1,${JSON.stringify(`3c:${JSON.stringify(['$', '$L41', null, { pageId: 6410630422455, initialCalendarData: payload }])}\n`)}])</script>`);

describe('DeepSeek current snapshot', () => {
  it('reads the reviewed SSR component snapshot and active changes as inert data', () => {
    const result = parseDeepSeek(config, page, null, now);
    expect(result.coverage.currentState).toBe('complete');
    expect(result.components.length).toBeGreaterThan(0);
    expect(result.reportedStatus).toBe('operational');
    expect(result.evidence.currentIncidentIds).toEqual([]);
  });
  it('finds structured initialData when Next changes its Flight record identifier', () => {
    expect(parseDeepSeek(config, page.replace('3b:', '4f:'), null, now).components).toHaveLength(1);
  });
  it('rejects missing snapshot, even if a feed is present', () => {
    expect(() => parseDeepSeek(config, '<html/>', '<feed/>', now)).toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });
  it('rejects malformed current components and does not execute page scripts', () => {
    expect(() => parseDeepSeek(config, page.replace('components', 'missing'), null, now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
    expect(() => parseDeepSeek(config, '<script>globalThis.exploited=true</script>', null, now)).toThrow();
    expect((globalThis as { exploited?: boolean }).exploited).toBeUndefined();
  });
  it('does not accept an active change that cannot be reconstructed as a source incident', () => {
    const active = page.replace('active_changes\\":[]', 'active_changes\\":[{\\"change_id\\":\\"c1\\",\\"status\\":\\"degraded\\",\\"components\\":[{\\"component_id\\":\\"api\\"}]}]');
    expect(() => parseDeepSeek(config, active, null, now))
      .toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
  });
  it('retains source-native resolved history severity from update component impact', () => {
    const result = parseDeepSeek(config, withHistory(page, history), null, now);
    expect(result.coverage.history).toBe('native');
    expect(result.reportedStatus).toBe('operational');
    expect(result.incidents[0]).toMatchObject({
      upstreamId: '7297926596703', state: 'resolved', severity: 'degraded',
      startedAt: '2026-11-25T01:10:00.000Z', resolvedAt: '2026-11-25T01:20:00.000Z',
      affectedComponentIds: ['deepseek:api'],
    });
    expect(result.incidents[0]?.updates).toHaveLength(2);
  });
  it('reports a constructed active change from source-native lifecycle and affected component status', () => {
    const active = { ...history.changes[0]!, change_id: 12345, status: 'identified', close_at_seconds: undefined,
      affected_components: [{ component_id: 'api', name: 'API', status: 'partial_outage' }],
      updates: [history.changes[0]!.updates[0]] };
    const snapshot = page.replace('active_changes\\":[]', `active_changes\\":${JSON.stringify([active]).replaceAll('"', '\\"')}`);
    const result = parseDeepSeek(config, snapshot, null, now);
    expect(result.reportedStatus).toBe('partial_outage');
    expect(result.evidence.currentIncidentIds).toEqual(['deepseek:12345']);
    expect(result.components[0]?.reportedStatus).toBe('partial_outage');
    expect(result.incidents[0]?.state).toBe('identified');
  });
  it('rejects conflicting matching current snapshots and wrong page identity', () => {
    const conflicting = page.replace('</script>', `self.__next_f.push([1,${JSON.stringify(`4a:${JSON.stringify(['$', '$L41', null, { pageId: 6410630422455, initialData: { page: { page_id: 6410630422455, custom_domain: 'status.deepseek.com', name: 'DeepSeek', components: [{ component_id: 'api', name: 'API 2' }] }, active_changes: [] } }])}\n`)}])</script>`);
    expect(() => parseDeepSeek(config, conflicting, null, now)).toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
    expect(() => parseDeepSeek(config, page.replace('pageId\\":6410630422455', 'pageId\\":777'), null, now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });
  it('reports malformed optional native history without discarding verified current coverage', () => {
    const malformed = withHistory(page, { changes: [{}], month: { year: 2026, month: 11 } });
    const result = parseDeepSeek(config, malformed, null, now);
    expect(result.reportedStatus).toBe('operational');
    expect(result.coverage.history).toBe('none');
    expect(result.evidence.historyError).toBe('invalid_payload');
  });
  it('accepts source-native lifecycle updates without component changes', () => {
    const resolved = { ...history.changes[0]!, updates: [
      history.changes[0]!.updates[0], { ...history.changes[0]!.updates[1], component_changes: undefined },
    ] };
    const result = parseDeepSeek(config, withHistory(page, { changes: [resolved], month: history.month }), null, now);
    expect(result.coverage.history).toBe('native');
    expect(result.incidents[0]).toMatchObject({ state: 'resolved', severity: 'degraded' });
  });
  it('keeps parsed native history when the independent Atom feed is malformed', () => {
    const result = parseDeepSeek(config, withHistory(page, history), '<feed>', now);
    expect(result.evidence.historyError).toBe('invalid_payload');
    expect(result.coverage.history).toBe('native');
    expect(result.incidents).toHaveLength(1);
  });
  it('preserves optional feed timeout as history error', async () => {
    const result = await deepseekAdapter.collect(config, {
      now, signal: new AbortController().signal,
      http: {
        getText: async (url) => {
          if (url === config.adapter.endpoints.page) return page;
          throw new TransportError('timeout', 'Atom timeout');
        },
        getJson: async () => { throw new Error('unexpected'); },
        getResponse: async () => { throw new Error('unexpected'); },
      }, browser: { collect: async () => [], close: async () => {} },
    });
    expect(result.evidence.historyError).toBe('timeout');
  });
  it('dispatches a dedicated adapter through the collector and accepts the registry ID in CLI', async () => {
    expect(parseCollectArgs(['--providers', 'deepseek']).providers).toEqual(['deepseek']);
    const run = await collectProviders([config], new Map(), {
      intervalMinutes: 5, now, signal: new AbortController().signal,
      http: {
        getText: async (url) => url.endsWith('feed.atom') ? '<feed/>' : page,
        getJson: async () => { throw new Error('unexpected JSON'); },
        getResponse: async () => { throw new Error('unexpected response'); },
      },
      browser: { collect: async () => [], close: async () => {} },
    });
    expect(run.providers[0]?.collection.freshness).toBe('fresh');
    expect(run.providers[0]?.result?.providerId).toBe('deepseek');
  });
});
