import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { collectProviders } from '../../src/collector/run.js';
import { validateAdapterResult } from '../../src/collector/storage/validate.js';
import { parseStatuspage } from '../../src/collector/adapters/statuspage.js';
import devin from '../fixtures/statuspage/devin/snapshot.json';
import factory from '../fixtures/statuspage/factory/snapshot.json';

const now = '2026-11-27T08:00:00.000Z';
const configs = parseRegistry(registry);

describe('Devin and Factory official Statuspage onboarding', () => {
  it('retains valid recent history while flagging a contradictory optional old source interval', () => {
    const config = configs.find(source => source.id === 'devin')!;
    const valid = devin.history.incidents[0]!;
    // Construct the same reversed-interval shape seen in four old Devin source rows.
    const contradictory = { ...valid, id: 'constructed-reversed',
      started_at: '2026-07-31T19:06:13.206Z', resolved_at: '2026-07-31T17:30:00.000Z' };
    const output = parseStatuspage(config, devin.summary, devin.active,
      { incidents: [contradictory, valid] }, now);
    expect(output.reportedStatus).toBe('operational');
    expect(output.incidents.map(incident => incident.sourceIdentity)).toEqual(['devin:hrnddcrr3fgr']);
    expect(output.coverage.history).toBe('native');
    expect(output.evidence.historyError).toBe('invalid_payload');
    expect(output.evidence.warnings).toContain('Historical backfill invalid (invalid_payload)');
  });

  it.each([
    { id: 'devin', fixture: devin, total: 14, event: 'hrnddcrr3fgr', severity: 'degraded' },
    { id: 'factory', fixture: factory, total: 15, event: '1mt8tnvvm9mp', severity: 'major_outage' },
  ])('collects $id using separate required active and optional native history responses', async ({ id, fixture, total, event, severity }) => {
    const config = configs.find(source => source.id === id)!;
    const requested: string[] = [];
    const run = await collectProviders([config], new Map(), {
      now, intervalMinutes: 5, signal: new AbortController().signal,
      http: {
        getJson: async url => {
          requested.push(url);
          if (url === config.adapter.endpoints.summary) return fixture.summary;
          if (url === config.adapter.endpoints.active) return fixture.active;
          if (url === config.adapter.endpoints.incidents) return fixture.history;
          throw new Error(`Unexpected URL: ${url}`);
        },
        getText: async () => { throw new Error('Unexpected text request'); },
        getResponse: async () => { throw new Error('Unexpected response request'); },
      },
      browser: { collect: async () => [], close: async () => {} },
    });
    const output = run.providers[0]!;
    expect(output.collection).toMatchObject({ freshness: 'fresh', outcome: 'success' });
    validateAdapterResult(output.result!, config.id);
    expect(output.result).toMatchObject({
      reportedStatus: 'operational', coverage: { currentState: 'complete', history: 'native' },
      evidence: { currentIncidentIds: [], historyError: null },
    });
    expect(output.result?.components).toHaveLength(total);
    expect(output.result?.incidents[0]).toMatchObject({
      sourceIdentity: `${id}:${event}`, state: 'resolved', severity,
      startedAt: new Date(fixture.history.incidents[0]!.started_at).toISOString(),
      resolvedAt: new Date(fixture.history.incidents[0]!.resolved_at).toISOString(),
      affectedComponentIds: [`${id}:${fixture.history.incidents[0]!.components[0]!.id}`],
    });
    expect(requested).toEqual([
      config.adapter.endpoints.summary, config.adapter.endpoints.active, config.adapter.endpoints.incidents,
    ]);
  });
});
