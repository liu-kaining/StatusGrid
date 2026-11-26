import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import cloudflare from '../fixtures/statuspage/cloudflare/summary.json';
import cloudflareMaintenance from '../fixtures/statuspage/cloudflare/maintenance.json';
import github from '../fixtures/statuspage/github/summary.json';
import claude from '../fixtures/statuspage/claude/summary.json';
import openai from '../fixtures/statuspage/openai/summary.json';
import moonshot from '../fixtures/statuspage/moonshot/summary.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { parseStatuspage } from '../../src/collector/adapters/statuspage.js';
import { createAdapter } from '../../src/collector/adapters/index.js';
import { collectProviders } from '../../src/collector/run.js';
import { TransportError } from '../../src/collector/errors.js';
import { parseCollectArgs } from '../../src/collector/cli.js';
import type { AdapterContext, ProviderConfig } from '../../src/shared/contracts.js';

const configs = parseRegistry(registry);
const config = (id: string): ProviderConfig => configs.find((provider) => provider.id === id)!;
const now = '2026-11-25T14:20:00.000Z';
const active = (summary: { incidents: unknown[] }) => ({ incidents: summary.incidents });

describe('Statuspage parser', () => {
  it.each([
    ['cloudflare', cloudflare, 'degraded', 1],
    ['github', github, 'operational', 0],
    ['claude', claude, 'major_outage', 1],
    ['openai', openai, 'degraded', 1],
    ['moonshot', moonshot, 'operational', 0],
  ] as const)('%s normalizes official source evidence', (id, summary, expected, incidentCount) => {
    const result = parseStatuspage(config(id), summary, active(summary), null, now);
    expect(result.reportedStatus).toBe(expected);
    expect(result.incidents).toHaveLength(incidentCount);
    expect(result.evidence.currentIncidentIds).toEqual(summary.incidents.map((incident) => `${id}:${incident.id}`));
    expect(result.coverage.currentState).toBe('complete');
    expect(result.evidence.requiredChecks.every((check) => check.passed)).toBe(true);
  });

  it('marks normal Cloudflare nodes collapsed but retains every source ID for search', () => {
    const result = parseStatuspage(config('cloudflare'), cloudflare, active(cloudflare), null, now);
    expect(result.components.map(({ upstreamId }) => upstreamId)).toContain('57srcl8zcn7c');
    expect(result.components.find(({ upstreamId }) => upstreamId === '57ctn3f2qsyj')?.displayCollapsed).toBe(true);
    expect(result.components.find(({ upstreamId }) => upstreamId === '57srcl8zcn7c')?.displayCollapsed).toBe(false);
    expect(result.components.find(({ upstreamId }) => upstreamId === '57srcl8zcn7c')?.groupId).toBe('cloudflare:1km35smx8p41');
    expect(result.coverage.componentScope).toBe('full');
  });

  it('filters GitHub explanation component by declared ID', () => {
    const result = parseStatuspage(config('github'), github, active(github), null, now);
    expect(result.components.map(({ upstreamId }) => upstreamId)).toEqual(['8l4ygp009s5s']);
  });

  it('preserves duplicate names in different groups as separate component IDs', () => {
    const summary = { ...moonshot, components: [
      { id: 'parent-a', name: 'A', status: 'operational', group: true },
      { id: 'parent-b', name: 'B', status: 'operational', group: true },
      { id: 'child-a', name: 'API', status: 'degraded_performance', group_id: 'parent-a' },
      { id: 'child-b', name: 'API', status: 'partial_outage', group_id: 'parent-b' },
    ] };
    const result = parseStatuspage(config('moonshot'), summary, { incidents: [] }, null, now);
    expect(result.components.filter(({ name }) => name === 'API').map(({ id, groupId }) => [id, groupId]))
      .toEqual([['moonshot:child-a', 'moonshot:parent-a'], ['moonshot:child-b', 'moonshot:parent-b']]);
  });

  it('requires current incidents when summary lacks incidents even if history lists recent events', () => {
    const withoutIncidents = Object.fromEntries(Object.entries(openai).filter(([key]) => key !== 'incidents'));
    expect(() => parseStatuspage(config('openai'), withoutIncidents, null, { incidents: openai.incidents }, now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });

  it('rejects missing required fields and unknown status enum with typed reasons', () => {
    expect(() => parseStatuspage(config('github'), { ...github, status: {} }, active(github), null, now))
      .toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
    expect(() => parseStatuspage(config('github'), { ...github, status: { indicator: 'new_type' } }, active(github), null, now))
      .toThrowError(expect.objectContaining({ reason: 'unknown_status' }));
    expect(() => parseStatuspage(config('github'), { ...github, components: [{ id: 'x', name: 'X', status: 'unseen' }] }, active(github), null, now))
      .toThrowError(expect.objectContaining({ reason: 'unknown_status' }));
  });

  it('preserves source lifecycle for maintenance and postmortem updates', () => {
    const maintenance = {
      id: 'planned-1', name: 'Maintenance', status: 'verifying', impact: 'maintenance',
      created_at: '2026-11-25T10:00:00Z', updated_at: '2026-11-25T11:00:00Z',
      scheduled_for: '2026-11-25T10:30:00Z', scheduled_until: '2026-11-25T12:00:00Z',
      incident_updates: [{ id: 'update-1', status: 'postmortem', body: 'Review', display_at: '2026-11-25T11:00:00Z' }],
    };
    const result = parseStatuspage(
      config('github'),
      { ...github, scheduled_maintenances: [maintenance] },
      { incidents: [] },
      null, now,
    );
    expect(result.incidents[0]).toMatchObject({ kind: 'maintenance', state: 'in_progress', resolvedAt: null });
    expect(result.incidents[0]?.updates[0]?.phase).toBe('unknown');
  });

  it('retains scheduled_maintenances separately from incidents without degrading future work', () => {
    const summary = { ...cloudflare, status: { indicator: 'none' }, components: [], incidents: [], scheduled_maintenances: [cloudflareMaintenance] };
    const result = parseStatuspage(config('cloudflare'), summary, { incidents: [] }, null, now);
    expect(result.reportedStatus).toBe('operational');
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]).toMatchObject({
      sourceIdentity: 'cloudflare:6450da4h5bdu',
      kind: 'maintenance', state: 'scheduled', startedAt: '2026-11-25T23:00:00.000Z',
      affectedComponentIds: ['cloudflare:w8pgyc1hh9hw'], resolvedAt: null,
    });
    expect(result.evidence.currentIncidentIds).toEqual(['cloudflare:6450da4h5bdu']);
  });

  it('reflects in-progress native maintenance but does not resurrect completed maintenance', () => {
    const current = {
      ...cloudflareMaintenance, status: 'in_progress',
      scheduled_for: '2026-11-25T12:30:00.000Z', scheduled_until: '2026-11-25T16:00:00.000Z',
      started_at: '2026-11-25T13:00:00.000Z', updated_at: now,
    };
    const completed = {
      ...cloudflareMaintenance,
      id: 'maintenance-completed', status: 'completed', updated_at: now, resolved_at: now,
      scheduled_for: '2026-11-25T10:00:00.000Z', scheduled_until: '2026-11-25T11:00:00.000Z',
      started_at: '2026-11-25T10:00:00.000Z',
    };
    const summary = {
      ...cloudflare, status: { indicator: 'none' }, components: [], incidents: [],
      scheduled_maintenances: [current, completed],
    };
    const result = parseStatuspage(config('cloudflare'), summary, { incidents: [] }, null, now);
    expect(result.reportedStatus).toBe('maintenance');
    expect(result.incidents.map(({ state, resolvedAt }) => [state, resolvedAt])).toEqual([
      ['in_progress', null], ['completed', now],
    ]);
    expect(result.evidence.currentIncidentIds).toEqual(['cloudflare:6450da4h5bdu']);
  });

  it('rejects malformed present maintenance payload but permits a source without that optional field', () => {
    expect(parseStatuspage(config('openai'), openai, null, null, now).incidents).toHaveLength(1);
    expect(() => parseStatuspage(config('cloudflare'), { ...cloudflare, scheduled_maintenances: null }, active(cloudflare), null, now))
      .toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
  });

  it('applies declarative display groups without merging matching source IDs', () => {
    const customized = {
      ...config('moonshot'),
      adapter: {
        ...config('moonshot').adapter,
        componentGroups: [{ id: 'service', name: 'Services', upstreamIds: ['sttxgsd2bps7'], namePatterns: [] }],
      },
    };
    const result = parseStatuspage(customized, moonshot, active(moonshot), null, now);
    expect(result.components.find(({ upstreamId }) => upstreamId === 'sttxgsd2bps7')?.groupId).toBe('moonshot:service');
  });

  it('does not classify future scheduled maintenance as an active degradation', () => {
    const maintenance = {
      id: 'planned-future', name: 'Maintenance', status: 'scheduled', impact: 'maintenance',
      created_at: '2026-11-25T13:00:00Z', updated_at: '2026-11-25T13:00:00Z',
      scheduled_for: '2026-11-26T10:30:00Z', incident_updates: [],
    };
    expect(parseStatuspage(
      config('github'), { ...github, scheduled_maintenances: [maintenance] },
      { incidents: [] }, null, now,
    ).reportedStatus)
      .toBe('operational');
  });

  it('keeps a complete current result fresh in spite of failed historical backfill', async () => {
    const run = await collectProviders([config('github')], new Map(), {
      now, signal: new AbortController().signal, intervalMinutes: 5,
      http: {
        getJson: async (url) => {
          if (url.includes('incidents.json')) throw new TransportError('timeout', 'history timeout');
          if (url.includes('unresolved.json')) return { incidents: [] };
          return github;
        },
        getText: async () => '', getResponse: async () => { throw new Error('unused'); },
      },
      browser: { collect: async () => [], close: async () => {} },
    });
    expect(run.providers[0]?.collection.freshness).toBe('fresh');
    expect(run.providers[0]?.result?.evidence.historyError).toBe('timeout');
  });

  it('keeps a complete current result fresh when history has a malformed entry', async () => {
    const run = await collectProviders([config('github')], new Map(), {
      now, signal: new AbortController().signal, intervalMinutes: 5,
      http: {
        getJson: async (url) => url.includes('incidents.json')
          ? { incidents: [{ id: 'broken' }] }
          : url.includes('unresolved.json') ? { incidents: [] } : github,
        getText: async () => '', getResponse: async () => { throw new Error('unused'); },
      },
      browser: { collect: async () => [], close: async () => {} },
    });
    expect(run.providers[0]?.collection.freshness).toBe('fresh');
    expect(run.providers[0]?.result?.evidence.historyError).toBe('invalid_payload');
  });
});

describe('collection boundary', () => {
  const context = (data: unknown, activeError?: Error): AdapterContext & { intervalMinutes: 5 } => ({
    now, intervalMinutes: 5, signal: new AbortController().signal,
    http: {
      getJson: async (url) => {
        if (url.includes('unresolved.json') && activeError) throw activeError;
        if (url.includes('unresolved.json')) return { incidents: [] };
        if (url.includes('incidents.json')) return { incidents: [] };
        return data;
      },
      getText: async () => '', getResponse: async () => { throw new Error('unused'); },
    },
    browser: { collect: async () => [], close: async () => {} },
  });

  it('summary without incidents and failing active endpoint never becomes a fresh empty state', async () => {
    const withoutIncidents = Object.fromEntries(Object.entries(openai).filter(([key]) => key !== 'incidents'));
    const prior = await collectProviders([config('openai')], new Map(), context(openai));
    const run = await collectProviders(
      [config('openai')],
      new Map([['openai', prior.providers[0]!]]),
      context(withoutIncidents, new TransportError('http_error', 'active endpoint unavailable', 404)),
    );
    expect(run.providers[0]?.collection.freshness).toBe('stale');
    expect(run.providers[0]?.collection.reason).toBe('coverage_incomplete');
    expect(run.providers[0]?.result).toBeNull();
    expect(run.providers[0]?.lastTrustedResult?.incidents).toHaveLength(1);
  });

  it('configured independent active endpoint returning JSON null cannot fall back to summary incidents', async () => {
    const run = await collectProviders([config('github')], new Map(), {
      ...context(github),
      http: {
        ...context(github).http,
        getJson: async (url) => url.includes('unresolved.json') ? null
          : url.includes('incidents.json') ? { incidents: [] } : github,
      },
    });
    expect(run.providers[0]?.collection.freshness).toBe('missing');
    expect(run.providers[0]?.collection.reason).toBe('coverage_incomplete');
    expect(run.providers[0]?.result).toBeNull();
  });

  it('configured independent active endpoint missing incidents array fails closed', async () => {
    const run = await collectProviders([config('github')], new Map(), {
      ...context(github),
      http: {
        ...context(github).http,
        getJson: async (url) => url.includes('unresolved.json') ? {}
          : url.includes('incidents.json') ? { incidents: [] } : github,
      },
    });
    expect(run.providers[0]?.collection.freshness).toBe('missing');
    expect(run.providers[0]?.collection.reason).toBe('coverage_incomplete');
  });

  it('isolates failed provider and rejects unknown adapters without creating results', async () => {
    const run = await collectProviders([config('github'), config('tencent-cloud')], new Map(), context(github));
    expect(run.providers.map(({ collection, result }) => [collection.freshness, result?.providerId ?? null]))
      .toEqual([['fresh', 'github'], ['missing', null]]);
    expect(run.providers[1]?.collection.reason).toBe('not_connected');
    expect(() => createAdapter(config('tencent-cloud'))).toThrow(/adapter/i);
  });

  it('only accepts shared five/ten minute collection intervals', async () => {
    const run = await collectProviders([], new Map(), { ...context(github), intervalMinutes: 10 });
    expect(run.intervalMinutes).toBe(10);
    await expect(collectProviders([], new Map(), { ...context(github), intervalMinutes: 7 }))
      .rejects.toThrow(/interval/i);
  });

  it('independent active endpoint failure prevents a complete current result despite summary incidents', async () => {
    const run = await collectProviders(
      [config('claude')], new Map(),
      context(claude, new TransportError('timeout', 'unresolved endpoint timeout')),
    );
    expect(run.providers[0]?.collection.freshness).toBe('missing');
    expect(run.providers[0]?.collection.reason).toBe('coverage_incomplete');
  });
});

describe('collection CLI arguments', () => {
  it('selects exact provider IDs, report destination and shared collection interval', () => {
    expect(parseCollectArgs(['--providers', 'github,openai', '--report', '.statusgrid/report.json', '--interval', '10']))
      .toEqual({ providers: ['github', 'openai'], report: '.statusgrid/report.json', intervalMinutes: 10 });
    expect(() => parseCollectArgs(['--providers', 'github,missing'])).toThrow(/unknown provider/i);
    expect(() => parseCollectArgs(['--interval', '7'])).toThrow(/interval/i);
  });
});
