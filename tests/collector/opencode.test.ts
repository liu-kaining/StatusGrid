import { describe, expect, it } from 'vitest';
import type { AdapterContext, ProviderConfig } from '../../src/shared/contracts.js';
import { parseOpenCode, opencodeAdapter } from '../../src/collector/adapters/opencode.js';
import { validateAdapterResult } from '../../src/collector/storage/validate.js';
import fixture from '../fixtures/opencode/status.json';

const config: ProviderConfig = {
  id: 'opencode', name: 'OpenCode', category: 'ai', aliases: [], tags: ['ai'],
  officialStatusUrl: 'https://status.opencode.ai/', officialHomeUrl: 'https://opencode.ai/',
  displayOrder: 11, enabled: true,
  adapter: { type: 'opencode', endpoints: { status: 'https://status.opencode.ai/api/status' },
    timeoutMs: 8000, retries: 2, requiredRegions: [], componentGroups: [], browserFallback: false },
};
const now = '2026-11-27T07:50:20.000Z';

describe('OpenCode official status', () => {
  it('preserves captured service status, native active IDs and source resolution times', () => {
    const result = validateAdapterResult(parseOpenCode(config, fixture, now), 'opencode');
    expect(result.reportedStatus).toBe('degraded');
    expect(result.components).toHaveLength(6);
    expect(result.components.find(({ upstreamId }) => upstreamId === 'console')).toMatchObject({
      name: 'Console API', groupId: 'opencode:console', reportedStatus: 'degraded',
    });
    expect(result.components.find(({ upstreamId }) => upstreamId === 'free')).toMatchObject({
      name: 'Free inference', reportedStatus: 'operational',
    });
    expect(result.evidence.currentIncidentIds).toEqual([
      'opencode:console-1795207592485', 'opencode:payg-1795756892498',
    ]);
    expect(result.incidents.find(({ upstreamId }) => upstreamId === 'free-1795763612498')).toMatchObject({
      state: 'resolved', severity: 'degraded', severityBasis: 'source',
      startedAt: '2026-11-27T07:13:32.498Z', resolvedAt: '2026-11-27T07:19:32.498Z',
      durationMinutes: 6, affectedComponentIds: ['opencode:free'],
      sourceUrl: 'https://status.opencode.ai/#incident-free-1795763612498',
    });
    expect(result.coverage.history).toBe('native');
    expect(result.sourceUpdatedAt).toBe('2026-11-27T07:49:32.498Z');
  });

  it('keeps a recovered source incident open as monitoring until native resolution', () => {
    const payload = structuredClone(fixture);
    payload.status = 'operational';
    payload.components.forEach(component => { component.status = 'operational'; });
    const result = parseOpenCode(config, payload, now);
    expect(result.reportedStatus).toBe('operational');
    expect(result.incidents.find(({ upstreamId }) => upstreamId === 'console-1795207592485')).toMatchObject({
      state: 'monitoring', resolvedAt: null, durationMinutes: null,
    });
    expect(result.evidence.currentIncidentIds).toContain('opencode:console-1795207592485');
  });

  it('reports a constructed healthy empty-incident snapshot without generating incidents', () => {
    const payload = structuredClone(fixture);
    payload.status = 'operational';
    payload.components.forEach(component => { component.status = 'operational'; });
    payload.incidents = [];
    const result = parseOpenCode(config, payload, now);
    expect(result.reportedStatus).toBe('operational');
    expect(result.incidents).toEqual([]);
    expect(result.evidence.currentIncidentIds).toEqual([]);
  });

  it('maps a constructed outage and does not let a weaker aggregate hide component impact', () => {
    const payload = structuredClone(fixture);
    payload.status = 'operational';
    payload.components[0]!.status = 'outage';
    payload.incidents[0]!.status = 'outage';
    const result = parseOpenCode(config, payload, now);
    expect(result.reportedStatus).toBe('major_outage');
    expect(result.incidents[0]).toMatchObject({ state: 'in_progress', severity: 'major_outage' });
  });

  it.each([
    { label: 'unknown aggregate', change: { status: 'brand-new-state' }, reason: 'unknown_status' },
    { label: 'upstream unknown', change: { status: 'unknown' }, reason: 'coverage_incomplete' },
    { label: 'stale flag', change: { stale: true }, reason: 'overdue' },
    { label: 'old source timestamp', change: { updatedAt: 1795765472498 }, reason: 'overdue' },
    { label: 'missing components', change: { components: undefined }, reason: 'coverage_incomplete' },
    { label: 'empty directory', change: { components: [] }, reason: 'coverage_incomplete' },
    { label: 'missing incidents', change: { incidents: undefined }, reason: 'coverage_incomplete' },
  ])('rejects $label instead of reporting fresh healthy state', ({ change, reason }) => {
    expect(() => parseOpenCode(config, { ...fixture, ...change }, now))
      .toThrowError(expect.objectContaining({ reason }));
  });

  it('rejects missing, duplicate and unknown service state before trusting current coverage', () => {
    for (const components of [
      fixture.components.slice(1),
      [...fixture.components, fixture.components[0]],
      fixture.components.map((component, index) => index ? component : { ...component, status: 'unknown' }),
      fixture.components.map((component, index) => index ? component : { ...component, status: 'new-state' }),
    ]) {
      expect(() => parseOpenCode(config, { ...fixture, components }, now)).toThrow();
    }
  });

  it('rejects an invalid active incident and never invents a source resolution time', () => {
    const payload = structuredClone(fixture);
    payload.incidents[0]!.resolvedAt = payload.incidents[0]!.startedAt - 1;
    const result = parseOpenCode(config, payload, now);
    expect(result.evidence.historyError).toBe('invalid_payload');
    payload.incidents[0]!.resolvedAt = null;
    payload.incidents[0]!.status = 'not-a-status';
    expect(() => parseOpenCode(config, payload, now))
      .toThrowError(expect.objectContaining({ reason: 'unknown_status' }));
  });

  it('keeps verified current evidence when a finite historical row is malformed', () => {
    const payload = structuredClone(fixture);
    payload.incidents[2]!.status = 'unknown-history-status';
    const result = parseOpenCode(config, payload, now);
    expect(result.evidence.historyError).toBe('unknown_status');
    expect(result.coverage.currentState).toBe('complete');
    expect(result.coverage.history).toBe('none');
    expect(result.evidence.currentIncidentIds).toHaveLength(2);
  });

  it('attaches constructed official notes by event with original note identity and timestamp', () => {
    const result = parseOpenCode(config, {
      ...fixture, notes: [{ id: 'constructed-note', event: 'console-1795207592485',
        body: 'Constructed official note', at: 1795761032498, updatedAt: null }],
    }, now);
    expect(result.incidents[0]!.updates).toEqual([{
      id: 'constructed-note', phase: 'unknown', body: 'Constructed official note',
      timestamp: '2026-11-27T06:30:32.498Z',
    }]);
    expect(result.incidents[1]!.updates).toEqual([]);
  });

  it('preserves a constructed note edit time without changing its original publication time', () => {
    const result = parseOpenCode(config, {
      ...fixture, notes: [{ id: 'constructed-note', event: 'console-1795207592485',
        body: 'Edited note', at: 1795761032498, updatedAt: 1795763972498 }],
    }, now);
    expect(result.incidents[0]!.updatedAt).toBe('2026-11-27T07:19:32.498Z');
    expect(result.incidents[0]!.updates[0]!.timestamp).toBe('2026-11-27T06:30:32.498Z');
  });

  it('does not hide a constructed affected model behind an operational plan aggregate', () => {
    const result = parseOpenCode(config, { ...fixture, components: fixture.components.map(component =>
      component.service === 'go' ? { ...component, breakdown: [{ id: 'constructed-model', status: 'outage' }] } : component),
    }, now);
    expect(result.reportedStatus).toBe('major_outage');
    expect(result.components.find(({ upstreamId }) => upstreamId === 'go')!.reportedStatus).toBe('major_outage');
  });

  it('collects from the configured official JSON API and exposes parseable current results', async () => {
    const context: AdapterContext = {
      now, signal: new AbortController().signal,
      http: {
        getJson: async url => {
          if (url !== 'https://status.opencode.ai/api/status') throw new Error('Wrong source URL');
          return fixture;
        },
        getText: async () => { throw new Error('Unexpected HTML request'); },
        getResponse: async () => { throw new Error('Unexpected response request'); },
      },
      browser: { collect: async () => { throw new Error('Unexpected browser launch'); }, close: async () => {} },
    };
    const result = validateAdapterResult(await opencodeAdapter.collect(config, context), 'opencode');
    expect(result.reportedStatus).toBe('degraded');
    expect(result.components).toHaveLength(6);
  });
});
