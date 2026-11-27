import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import type { ProviderConfig } from '../../src/shared/contracts.js';
import { parseRegistry } from '../../src/shared/schemas.js';
import { parseFlashduty } from '../../src/collector/adapters/flashduty.js';
import { collectProviders } from '../../src/collector/run.js';
import { TransportError } from '../../src/collector/errors.js';
import minimax from '../fixtures/flashduty/minimax.json';
import streamlake from '../fixtures/flashduty/streamlake.json';
import streamlakeHistory from '../fixtures/flashduty/streamlake-history.json';

const now = '2026-11-27T07:00:00.000Z';
function flight(...properties: unknown[]): string {
  const stream = properties.map((value, index) =>
    `${(index + 30).toString(16)}:${JSON.stringify(['$', '$L1', null, value])}\n`).join('');
  return `<script>self.__next_f.push([1,${JSON.stringify(stream)}])</script>`;
}
const minimaxConfig: ProviderConfig = {
  id: 'minimax', name: 'MiniMax', category: 'ai', aliases: ['海螺'], tags: ['ai'],
  officialStatusUrl: 'https://status.minimax.cn/', officialHomeUrl: 'https://www.minimaxi.com/',
  displayOrder: 7, enabled: true,
  adapter: {
    type: 'flashduty', sourcePageId: '7298961802939', endpoints: { page: 'https://status.minimax.cn/' },
    timeoutMs: 15000, retries: 2, requiredRegions: [], componentGroups: [], browserFallback: false,
  },
};
const streamlakeConfig: ProviderConfig = {
  ...minimaxConfig, id: 'streamlake', name: 'StreamLake', aliases: ['快手', '万擎'],
  officialStatusUrl: 'https://status.streamlake.com/', officialHomeUrl: 'https://www.streamlake.com/',
  displayOrder: 8,
  adapter: { ...minimaxConfig.adapter, sourcePageId: '6794868175813',
    endpoints: { page: 'https://status.streamlake.com/', history: 'https://status.streamlake.com/history' } },
};

describe('shared Flashduty sources', () => {
  it.each([
    { config: minimaxConfig, snapshot: minimax, total: 5 },
    { config: streamlakeConfig, snapshot: streamlake, total: 6 },
  ])('reads $config.name current state from the complete official directory', ({ config, snapshot, total }) => {
    const result = parseFlashduty(config, flight(snapshot), null, now);
    expect(result.components).toHaveLength(total);
    expect(result.reportedStatus).toBe('operational');
    expect(result.coverage.currentState).toBe('complete');
    expect(result.evidence.currentIncidentIds).toEqual([]);
  });

  it('imports MiniMax source-native history with its real lifecycle and per-update impact', () => {
    const result = parseFlashduty(minimaxConfig, flight(minimax), null, now);
    expect(result.coverage.history).toBe('native');
    expect(result.incidents[0]).toMatchObject({
      sourceIdentity: 'minimax:7307657128086', state: 'resolved', severity: 'partial_outage',
      startedAt: '2026-11-22T02:10:00.000Z', resolvedAt: '2026-11-22T02:11:00.000Z',
      sourceUrl: 'https://status.minimax.cn/incidents/7307657128086',
    });
    expect(result.components[2]?.groupId).toBe('minimax:01M88QV2PB9WV1QPBNTTQZQH84');
  });

  it('treats an absent list-view calendar as absent optional history rather than malformed history', () => {
    const result = parseFlashduty(streamlakeConfig, flight(streamlake), null, now);
    expect(result.evidence.historyError).toBeNull();
    expect(result.coverage.history).toBe('none');
  });

  it('reads StreamLake native empty monthly history separately from current-state evidence', () => {
    const result = parseFlashduty(streamlakeConfig, flight(streamlake), null, now, flight(streamlakeHistory));
    expect(result.coverage.history).toBe('native');
    expect(result.evidence.historyError).toBeNull();
    expect(result.incidents).toEqual([]);
    expect(result.reportedStatus).toBe('operational');
  });

  it('imports a constructed resolved event from the native history list when it is nonempty', () => {
    const componentId = '01KZ3DT1GJS4XMFYFMDCGFJW92';
    const change = { ...minimax.initialCalendarData.changes[0]!, page_id: 6794868175813,
      change_id: 42, title: 'Constructed StreamLake incident',
      affected_components: [{ component_id: componentId, name: 'KAT-Coder-Pro-V2.5 API服务', status: 'operational' }],
      updates: minimax.initialCalendarData.changes[0]!.updates.map(update => ({
        ...update, component_changes: update.component_changes.map(component => ({ ...component, component_id: componentId })),
      })) };
    const result = parseFlashduty(streamlakeConfig, flight(streamlake), null, now,
      flight({ ...streamlakeHistory, initialChanges: [change] }));
    expect(result.incidents[0]).toMatchObject({
      sourceIdentity: 'streamlake:42', state: 'resolved', severity: 'partial_outage',
      affectedComponentIds: ['streamlake:01KZ3DT1GJS4XMFYFMDCGFJW92'],
      startedAt: '2026-11-22T02:10:00.000Z', resolvedAt: '2026-11-22T02:11:00.000Z',
    });
    expect(result.coverage.history).toBe('native');
    expect(result.reportedStatus).toBe('operational');
  });

  it('rejects a wrong pinned page ID even when name and hostname match', () => {
    expect(() => parseFlashduty({
      ...minimaxConfig, adapter: { ...minimaxConfig.adapter, sourcePageId: '999' },
    }, flight(minimax), null, now)).toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });

  it.each([
    { history: flight({ ...streamlakeHistory, pageId: 7298961802939 }), reason: 'coverage_incomplete' },
    { history: '<html/>', reason: 'coverage_incomplete' },
    { history: flight({ ...streamlakeHistory, initialChanges: [{}] }), reason: 'invalid_payload' },
  ])('keeps current coverage when optional history is invalid: $reason', ({ history, reason }) => {
    const result = parseFlashduty(streamlakeConfig, flight(streamlake), null, now, history);
    expect(result.evidence.historyError).toBe(reason);
    expect(result.coverage.history).toBe('none');
    expect(result.coverage.currentState).toBe('complete');
  });

  it.each([
    { initialData: { ...minimax.initialData, active_changes: undefined } },
    { initialData: { ...minimax.initialData, page: { ...minimax.initialData.page, components: [] } } },
    { initialData: { ...minimax.initialData, page: { ...minimax.initialData.page, custom_domain: 'wrong.example' } } },
  ])('rejects incomplete or mismatched current coverage', (mutation) => {
    expect(() => parseFlashduty(minimaxConfig, flight({ ...minimax, ...mutation }), null, now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });

  it('uses a constructed active event to report affected components and preserves healthy components', () => {
    const change = { ...minimax.initialCalendarData.changes[0]!, status: 'investigating',
      close_at_seconds: undefined,
      affected_components: [{ component_id: '01M88QV58SMAA318DVA1HBG6Y8', name: '文本模型', status: 'partial_outage' }],
      updates: minimax.initialCalendarData.changes[0]!.updates.slice(0, 1) };
    const snapshot = { ...minimax, initialData: { ...minimax.initialData, active_changes: [change] } };
    const result = parseFlashduty(minimaxConfig, flight(snapshot), null, now);
    expect(result.reportedStatus).toBe('partial_outage');
    expect(result.components[0]?.reportedStatus).toBe('partial_outage');
    expect(result.components[3]?.reportedStatus).toBe('operational');
    expect(result.evidence.currentIncidentIds).toEqual(['minimax:7307657128086']);
    change.affected_components[0]!.status = 'unexpected';
    expect(() => parseFlashduty(minimaxConfig, flight(snapshot), null, now))
      .toThrowError(expect.objectContaining({ reason: 'unknown_status' }));
  });

  it('dispatches the generic adapter and reads the configured history endpoint', async () => {
    const requests: string[] = [];
    const run = await collectProviders([streamlakeConfig], new Map(), {
      now, intervalMinutes: 5, signal: new AbortController().signal,
      http: {
        getText: async (url) => {
          requests.push(url);
          if (url === 'https://status.streamlake.com/') return flight(streamlake);
          if (url === 'https://status.streamlake.com/history') return flight(streamlakeHistory);
          throw new Error(`Unexpected URL: ${url}`);
        },
        getJson: async () => { throw new Error('Unexpected JSON request'); },
        getResponse: async () => { throw new Error('Unexpected response request'); },
      },
      browser: { collect: async () => [], close: async () => {} },
    });
    expect(run.providers[0]?.collection).toMatchObject({ freshness: 'fresh', outcome: 'success' });
    expect(run.providers[0]?.result?.coverage.history).toBe('native');
    expect(requests).toEqual(['https://status.streamlake.com/', 'https://status.streamlake.com/history']);
  });

  it('keeps verified current state when the optional history request times out', async () => {
    const run = await collectProviders([streamlakeConfig], new Map(), {
      now, intervalMinutes: 5, signal: new AbortController().signal,
      http: {
        getText: async (url) => {
          if (url === 'https://status.streamlake.com/') return flight(streamlake);
          throw new TransportError('timeout', 'History timed out');
        },
        getJson: async () => { throw new Error('Unexpected JSON request'); },
        getResponse: async () => { throw new Error('Unexpected response request'); },
      },
      browser: { collect: async () => [], close: async () => {} },
    });
    expect(run.providers[0]?.collection).toMatchObject({ freshness: 'fresh', outcome: 'partial' });
    expect(run.providers[0]?.result?.evidence.historyError).toBe('timeout');
  });

  it('registers both sources with explicit official page identities', () => {
    const sources = parseRegistry(registry);
    expect(sources.find(({ id }) => id === 'minimax')).toMatchObject({
      enabled: true, category: 'ai', adapter: { type: 'flashduty', sourcePageId: '7298961802939' },
    });
    expect(sources.find(({ id }) => id === 'streamlake')).toMatchObject({
      enabled: true, category: 'ai', adapter: { type: 'flashduty', sourcePageId: '6794868175813' },
    });
  });
});
