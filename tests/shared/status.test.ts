import { describe, expect, it } from 'vitest';
import type { ProviderSummary } from '../../src/shared/contracts';
import { publicStatus, summarizeProviders } from '../../src/shared/status';

const operational: ProviderSummary = {
  id: 'example',
  name: 'Example',
  category: 'infra',
  status: 'operational',
  reportedStatus: 'operational',
  officialStatusUrl: 'https://status.example.com/',
  collection: {
    outcome: 'success',
    freshness: 'fresh',
    reason: null,
    message: null,
    lastCheckedAt: '2026-11-25T12:00:00Z',
    lastSuccessAt: '2026-11-25T12:00:00Z',
    sourceUpdatedAt: null,
    durationMs: 100,
    consecutiveFailures: 0,
  },
  coverage: {
    basis: 'official_public',
    regions: ['global'],
    componentScope: 'full',
    currentState: 'complete',
    history: 'none',
    observedSince: null,
    nativeHistoryEarliestAt: null,
    limitation: null,
  },
  componentSummary: {
    total: 1,
    abnormal: 0,
    abnormalNames: [],
    affectedRegions: [],
  },
  dailyTrack30d: '999999999999999999999999999999',
  dailyCoverage30d: Array.from({ length: 30 }, (_, index) => ({
    observedCoverageMinutes: 0, unknownMinutes: index === 29 ? 720 : 1440,
  })),
  activeIncidents: [],
};

const notConnected: ProviderSummary = {
  ...operational,
  id: 'pending',
  name: 'Pending',
  status: 'stale',
  reportedStatus: null,
  collection: {
    outcome: 'not_connected',
    freshness: 'missing',
    reason: 'not_connected',
    message: 'Adapter not connected',
    lastCheckedAt: null,
    lastSuccessAt: null,
    sourceUpdatedAt: null,
    durationMs: null,
    consecutiveFailures: 0,
  },
  coverage: {
    basis: 'official_public',
    regions: [],
    componentScope: 'full',
    currentState: 'unavailable',
    history: 'none',
    observedSince: null,
    nativeHistoryEarliestAt: null,
    limitation: 'Adapter not connected',
  },
};

describe('publicStatus', () => {
  it('does not show the last reported operational state as live after collection fails', () => {
    expect(publicStatus('operational', 'stale')).toBe('stale');
  });

  it('does not invent an operational state before any trusted collection', () => {
    expect(publicStatus(null, 'missing')).toBe('stale');
    expect(publicStatus(null, 'fresh')).toBe('stale');
  });

  it('preserves a fresh reported outage', () => {
    expect(publicStatus('partial_outage', 'fresh')).toBe('partial_outage');
  });
});

describe('summarizeProviders', () => {
  it('does not declare all operational with an unconnected provider', () => {
    const summary = summarizeProviders([operational, notConnected]);
    expect(summary).toMatchObject({
      overallStatus: 'stale',
      totalProviders: 2,
      connectedProviders: 1,
      staleProviderCount: 1,
      abnormalProviderCount: 0,
      countsByStatus: {
        operational: 1,
        maintenance: 0,
        degraded: 0,
        partial_outage: 0,
        major_outage: 0,
        stale: 1,
      },
    });
  });

  it('prioritizes known faults over maintenance and blocked collection', () => {
    const degraded: ProviderSummary = {
      ...operational, id: 'degraded', status: 'degraded', reportedStatus: 'degraded',
      activeIncidents: [{
        id: 'incident-1', title: 'Latency', severity: 'degraded', origin: 'official',
        startedAt: '2026-11-25T11:00:00Z', updatedAt: '2026-11-25T11:30:00Z',
        sourceUrl: 'https://status.example.com/incidents/1',
      }],
    };
    const maintenance: ProviderSummary = {
      ...operational, id: 'maintenance', status: 'maintenance', reportedStatus: 'maintenance',
    };
    const summary = summarizeProviders([notConnected, maintenance, degraded]);
    expect(summary).toMatchObject({
      overallStatus: 'degraded',
      connectedProviders: 2,
      abnormalProviderCount: 1,
      activeIncidentCount: 1,
      maintenanceCount: 1,
      staleProviderCount: 1,
    });
  });

  it('chooses the highest trusted outage severity', () => {
    const minor: ProviderSummary = { ...operational, status: 'partial_outage', reportedStatus: 'partial_outage' };
    const major: ProviderSummary = { ...operational, id: 'major', status: 'major_outage', reportedStatus: 'major_outage' };
    expect(summarizeProviders([minor, major]).overallStatus).toBe('major_outage');
  });

  it.each([
    ['stale', 'operational'],
    ['major_outage', 'operational'],
    ['operational', 'major_outage'],
  ] as const)('rejects a published %s status inconsistent with reported %s', (status, reportedStatus) => {
    const contradictory: ProviderSummary = { ...operational, status, reportedStatus };
    expect(() => summarizeProviders([contradictory])).toThrow(/inconsistent.*status/i);
  });

  it('shows maintenance when every provider is fresh and no service has failed', () => {
    const maintenance: ProviderSummary = {
      ...operational, status: 'maintenance', reportedStatus: 'maintenance',
    };
    expect(summarizeProviders([operational, maintenance])).toMatchObject({
      overallStatus: 'maintenance',
      maintenanceCount: 1,
      staleProviderCount: 0,
    });
  });

  it('shows stale ahead of maintenance when a provider is unconnected', () => {
    const maintenance: ProviderSummary = {
      ...operational, status: 'maintenance', reportedStatus: 'maintenance',
    };
    expect(summarizeProviders([maintenance, notConnected])).toMatchObject({
      overallStatus: 'stale',
      maintenanceCount: 1,
      staleProviderCount: 1,
    });
  });

  it('does not announce operational for an empty provider list', () => {
    expect(summarizeProviders([])).toMatchObject({
      overallStatus: 'stale',
      totalProviders: 0,
      connectedProviders: 0,
    });
  });

  it('does not trust contradictory fresh or cached green summaries', () => {
    const invalid: ProviderSummary = {
      ...operational,
      collection: { ...operational.collection, outcome: 'failure', freshness: 'fresh' },
      coverage: { ...operational.coverage, currentState: 'partial' },
    };
    expect(summarizeProviders([invalid])).toMatchObject({
      overallStatus: 'stale', staleProviderCount: 1, connectedProviders: 0,
    });
  });
});
