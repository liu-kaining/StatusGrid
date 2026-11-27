import { describe, expect, it } from 'vitest';
import type { AdapterContext, ProviderConfig } from '../../src/shared/contracts.js';
import { parseXai, xaiAdapter } from '../../src/collector/adapters/xai.js';
import { validateAdapterResult } from '../../src/collector/storage/validate.js';
import { AdapterError, TransportError } from '../../src/collector/errors.js';
import status from '../fixtures/xai/status.json';
import active from '../fixtures/xai/active.json';
import history from '../fixtures/xai/history.json';

const now = '2026-11-27T08:00:00.000Z';
const config: ProviderConfig = {
  id: 'xai', name: 'xAI', category: 'ai', aliases: ['Grok'], tags: ['ai'],
  officialStatusUrl: 'https://status.x.ai/', officialHomeUrl: 'https://x.ai/',
  displayOrder: 9, enabled: true,
  adapter: {
    type: 'xai',
    endpoints: {
      status: 'https://status.x.ai/api/status',
      active: 'https://status.x.ai/api/incidents?status=active',
      history: 'https://status.x.ai/api/incidents?status=resolved',
    },
    timeoutMs: 15000, retries: 2, requiredRegions: [], componentGroups: [], browserFallback: false,
  },
};
const parse = (current: unknown = status, ongoing: unknown = active, past: unknown = history) =>
  parseXai(config, current, ongoing, past, now);

describe('xAI public status and incident API', () => {
  it('keeps official available aggregate and info advisory distinct without inventing outage impact', () => {
    const result = validateAdapterResult(parse(), 'xai');
    expect(result.reportedStatus).toBe('operational');
    expect(result.components).toHaveLength(5);
    expect(result.components.find(({ upstreamId }) => upstreamId === 'api-global')).toMatchObject({
      id: 'xai:api-global', groupId: 'xai:api', reportedStatus: null,
    });
    expect(result.incidents.find(({ upstreamId }) => upstreamId === 'ps_665a368941fa8b5a')).toMatchObject({
      kind: 'advisory', severity: null, sourceSeverity: 'none', state: 'investigating',
      startedAt: '2026-11-27T04:26:05.000Z', resolvedAt: null,
      affectedComponentIds: ['xai:api-global'],
    });
    expect(result.evidence.currentIncidentIds).toEqual(['xai:ps_665a368941fa8b5a']);
  });

  it('preserves native resolved lifecycle and updates in chronological order', () => {
    const result = parse();
    const closed = result.incidents.find(({ upstreamId }) => upstreamId === 'ps_9c3a169909dde9f2');
    expect(closed).toMatchObject({
      state: 'resolved', severity: 'degraded', severityBasis: 'source',
      startedAt: '2026-11-26T10:44:55.000Z', resolvedAt: '2026-11-26T11:16:47.000Z',
      durationMinutes: 31.866666666666667,
      sourceUrl: 'https://status.x.ai/history?incident=grok-bot%2Fps_9c3a169909dde9f2',
    });
    expect(closed?.updates.map(({ phase }) => phase)).toEqual(['investigating', 'resolved']);
    expect(result.coverage).toMatchObject({
      history: 'native', currentState: 'complete', nativeHistoryEarliestAt: '2026-11-26T10:44:55.000Z',
    });
    expect(result.sourceUpdatedAt).toBe('2026-11-27T07:51:15.280Z');
  });

  it('reports current incident impact even if the aggregate has not caught up', () => {
    const ongoing = structuredClone(active);
    ongoing.incidents[0]!.impact = 'major';
    const result = parse(status, ongoing);
    expect(result.reportedStatus).toBe('major_outage');
    expect(result.incidents.find(({ state }) => state === 'investigating')).toMatchObject({
      kind: 'incident', severity: 'major_outage',
    });
  });

  it.each([
    { mutation: { overall: { status: 'brand_new' } }, reason: 'unknown_status' },
    { mutation: { products: [] }, reason: 'coverage_incomplete' },
    { mutation: { products: undefined }, reason: 'invalid_payload' },
  ])('rejects unsupported or empty current coverage: $reason', ({ mutation, reason }) => {
    expect(() => parse({ ...status, ...mutation })).toThrowError(expect.objectContaining({ reason }));
  });

  it('rejects a missing active list rather than treating it as no incidents', () => {
    expect(() => parse(status, {})).toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
  });

  it('rejects unknown component status and duplicate component identity', () => {
    const current = structuredClone(status);
    current.products[0]!.components[0]!.status = 'surprise';
    expect(() => parse(current)).toThrowError(expect.objectContaining({ reason: 'unknown_status' }));
    current.products[0]!.components[0]!.status = 'available';
    current.products[0]!.components.push(current.products[0]!.components[0]!);
    expect(() => parse(current)).toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });

  it('rejects active incidents with missing components or contradictory closure', () => {
    const ongoing = structuredClone(active);
    ongoing.incidents[0]!.components = [{ id: 'removed-component', name: 'Removed' }];
    expect(() => parse(status, ongoing)).toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
    ongoing.incidents[0]!.components = active.incidents[0]!.components;
    ongoing.incidents[0]!.status = 'resolved';
    expect(() => parse(status, ongoing)).toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });

  it('does not let malformed optional history erase verified current state', () => {
    const result = parse(status, active, { incidents: [{}] });
    expect(result.reportedStatus).toBe('operational');
    expect(result.coverage.history).toBe('none');
    expect(result.evidence.historyError).toBe('invalid_payload');
    expect(result.evidence.currentIncidentIds).toEqual(['xai:ps_665a368941fa8b5a']);
  });

  it('rejects history with source end before source start without corrupting current state', () => {
    const past = structuredClone(history);
    past.incidents[0]!.resolved_at = '2026-11-25T00:00:00.000Z';
    const result = parse(status, active, past);
    expect(result.coverage.history).toBe('none');
    expect(result.evidence.historyError).toBe('invalid_payload');
    expect(result.incidents).toHaveLength(1);
  });

  it('uses separate required current and optional resolved endpoints', async () => {
    const context: AdapterContext = {
      now, signal: new AbortController().signal,
      http: {
        getJson: async (url) => {
          if (url === config.adapter.endpoints.status) return status;
          if (url === config.adapter.endpoints.active) return active;
          if (url === config.adapter.endpoints.history) throw new TransportError('timeout', 'history timed out');
          throw new Error(`Unexpected source URL ${url}`);
        },
        getText: async () => { throw new Error('Unexpected text request'); },
        getResponse: async () => { throw new Error('Unexpected response request'); },
      },
      browser: { collect: async () => [], close: async () => {} },
    };
    const result = await xaiAdapter.collect(config, context);
    expect(result.coverage.currentState).toBe('complete');
    expect(result.evidence.historyError).toBe('timeout');
    expect(result.incidents[0]?.sourceIdentity).toBe('xai:ps_665a368941fa8b5a');
    context.http.getJson = async () => { throw new AdapterError('http_error', 'source unavailable'); };
    await expect(xaiAdapter.collect(config, context)).rejects.toMatchObject({ reason: 'http_error' });
  });
});
