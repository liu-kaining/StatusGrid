import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import incidents from '../fixtures/gcp/incidents.json';
import products from '../fixtures/gcp/products.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { parseGoogleCloud } from '../../src/collector/adapters/google-cloud.js';
import { googleCloudAdapter } from '../../src/collector/adapters/google-cloud.js';
import { TransportError } from '../../src/collector/errors.js';

const config = parseRegistry(registry).find(({ id }) => id === 'gcp')!;
const now = '2026-11-25T16:20:00Z';
describe('GCP incidents', () => {
  it('keeps active regions separate from previously affected and uses explicit end as resolution', () => {
    const result = parseGoogleCloud(config, incidents, products, now);
    expect(result.reportedStatus).toBe('degraded');
    expect(result.incidents[0]).toMatchObject({ startedAt: '2026-11-25T10:00:00.000Z', resolvedAt: null, affectedRegions: ['us-central1'], state: 'investigating' });
    expect(result.incidents[1]).toMatchObject({ resolvedAt: '2026-11-24T11:00:00.000Z', state: 'resolved', affectedRegions: ['us-west1'] });
    expect(result.evidence.currentIncidentIds).toEqual(['gcp:issue-1']);
  });
  it('fails without product dictionary instead of mislabeling products', () => {
    expect(() => parseGoogleCloud(config, incidents, null, now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });
  it('does not turn service information into active outages', () => {
    const info = { ...incidents[0], id: 'info', status_impact: 'SERVICE_INFORMATION', currently_affected_locations: [] };
    expect(parseGoogleCloud(config, [info], products, now).reportedStatus).toBe('operational');
  });
  it('rejects unknown impact and missing timestamp', () => {
    expect(() => parseGoogleCloud(config, [{ ...incidents[0], status_impact: 'NEW_STATE' }], products, now))
      .toThrowError(expect.objectContaining({ reason: 'unknown_status' }));
    expect(() => parseGoogleCloud(config, [{ ...incidents[0], begin: null }], products, now))
      .toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
  });
  it('falls back to official exact-URL browser responses when Node HTTP is blocked', async () => {
    const result = await googleCloudAdapter.collect(config, {
      now, signal: new AbortController().signal,
      http: {
        getJson: async () => { throw new TransportError('timeout', 'network timeout'); },
        getText: async () => { throw new Error('not used'); },
        getResponse: async () => { throw new Error('not used'); },
      },
      browser: {
        collect: async (_id, url) => [{ url, status: 200,
          body: JSON.stringify(url.endsWith('products.json') ? products : incidents) }],
        close: async () => {},
      },
    });
    expect(result.incidents).toHaveLength(2);
    expect(result.reportedStatus).toBe('degraded');
  });
});
