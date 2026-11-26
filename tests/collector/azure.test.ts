import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { parseAzure } from '../../src/collector/adapters/azure.js';
import { azureAdapter } from '../../src/collector/adapters/azure.js';
import { TransportError } from '../../src/collector/errors.js';
import { collectProviders } from '../../src/collector/run.js';

const config = parseRegistry(registry).find(({ id }) => id === 'azure')!;
const now = '2026-11-25T16:20:00Z';
const page = readFileSync('tests/fixtures/azure/page.html', 'utf8');
const feed = readFileSync('tests/fixtures/azure/feed.xml', 'utf8');
const invalidHistory = feed.replace('</channel>', `<item><guid>invalid-link</guid><title>Another update</title>
  <link>https://user:password@azure.status.microsoft/en-us/status/</link>
  <pubDate>Wed, 25 Nov 2026 11:00:00 GMT</pubDate><description>Update.</description></item></channel>`);
describe('Azure', () => {
  it('discards the complete optional RSS batch when event conversion rejects a later entry', () => {
    const output = parseAzure(config, invalidHistory, page, now);
    expect(output.reportedStatus).toBe('operational');
    expect(output.coverage.currentState).toBe('complete');
    expect(output.evidence.historyError).toBe('invalid_payload');
    expect(output.incidents).toEqual([]);
    expect(output.components).toContainEqual(expect.objectContaining({
      name: 'Compute', region: 'East US', reportedStatus: 'operational',
    }));
  });

  it('keeps real adapter realtime fresh and partial at the runner boundary after optional conversion fails', async () => {
    const run = await collectProviders([config], new Map(), {
      now, intervalMinutes: 5, signal: new AbortController().signal,
      clock: { now: () => now, monotonic: () => 0 },
      http: {
        getText: async (url) => {
          if (url === config.adapter.endpoints.page) return page;
          if (url === config.adapter.endpoints.feed) return invalidHistory;
          throw new Error('unexpected endpoint');
        },
        getJson: async () => { throw new Error('unexpected'); },
        getResponse: async () => { throw new Error('unexpected'); },
      }, browser: { collect: async () => [], close: async () => {} },
    });
    expect(run.providers[0]?.collection).toMatchObject({
      freshness: 'fresh', outcome: 'partial', reason: null, consecutiveFailures: 0,
    });
    expect(run.providers[0]?.result).toMatchObject({
      reportedStatus: 'operational', coverage: { currentState: 'complete' },
      incidents: [], evidence: { historyError: 'invalid_payload' },
    });
    expect(run.providers[0]?.lastTrustedResult).toEqual(run.providers[0]?.result);
  });
  it('accepts affirmative current page even when RSS is empty', () => {
    const result = parseAzure(config, '<rss><channel><title>Azure Status</title></channel></rss>', page, now);
    expect(result.reportedStatus).toBe('operational');
    expect(result.evidence.currentIncidentIds).toEqual([]);
  });
  it('retains historical RSS entries without title-based resolution guesses', () => {
    const result = parseAzure(config, feed, page, now);
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]).toMatchObject({ state: 'unknown', resolvedAt: null, startTimeBasis: 'source_published_at' });
    expect(result.evidence.currentIncidentIds).toEqual([]);
  });
  it('rejects missing page and unsupported current-impact structure', () => {
    expect(() => parseAzure(config, feed, '<html/>', now)).toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
    expect(() => parseAzure(config, feed, '', now)).toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });
  it('fails closed when a matrix cell signals an unverified service impact', () => {
    expect(() => parseAzure(config, feed, page.replace('</tbody></table></html>',
      '<tr><td>Storage</td><td class="status-cell"><span data-label="Degraded">Degraded</span></td></tr></tbody></table></html>'), now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });
  it('does not silently omit a malformed status cell beside a valid one', () => {
    const malformed = page.replace('</tr></tbody></table></html>', '<td class="status-cell"><span>Degraded</span></td></tr></tbody></table></html>');
    expect(() => parseAzure(config, feed, malformed, now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });
  it('rejects a zone advertised in navigation without a corresponding matrix table', () => {
    const absentZone = page.replace('</ul>', '<li class="zone" data-zone-name="europe"></li></ul>');
    expect(() => parseAzure(config, null, absentZone, now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });
  it('reads a complete warning matrix as derived current service impact, with no invented native incident', () => {
    const warning = page.replace('data-label="Good">Good', 'data-label="Warning">Warning');
    const result = parseAzure(config, null, warning, now);
    expect(result.reportedStatus).toBe('degraded');
    expect(result.components).toContainEqual(expect.objectContaining({
      name: 'Compute', region: 'East US', reportedStatus: 'degraded',
    }));
    expect(result.incidents).toEqual([]);
  });
  it('keeps matrix impact even when current-impact rows have unrecognized incident details', () => {
    const warning = page.replace('data-label="Good">Good', 'data-label="Critical">Critical')
      .replace('There are currently no active events.', 'Current service alert').replace('class="bg-green"', '');
    const result = parseAzure(config, null, warning, now);
    expect(result.reportedStatus).toBe('major_outage');
    expect(result.incidents).toEqual([]);
    expect(result.coverage.limitation).toContain('native current incident');
  });
  it('preserves typed history transport failure while keeping current page fresh', async () => {
    const result = await azureAdapter.collect(config, {
      now, signal: new AbortController().signal,
      http: {
        getText: async (url) => {
          if (url === config.adapter.endpoints.page) return page;
          throw new TransportError('timeout', 'RSS timeout');
        },
        getJson: async () => { throw new Error('unexpected'); },
        getResponse: async () => { throw new Error('unexpected'); },
      }, browser: { collect: async () => [], close: async () => {} },
    });
    expect(result.evidence.historyError).toBe('timeout');
    expect(result.reportedStatus).toBe('operational');
  });
  it('keeps parser invalid_payload when a successful RSS fetch has malformed XML', async () => {
    const result = await azureAdapter.collect(config, {
      now, signal: new AbortController().signal,
      http: {
        getText: async (url) => url === config.adapter.endpoints.page ? page : '<rss>',
        getJson: async () => { throw new Error('unexpected'); },
        getResponse: async () => { throw new Error('unexpected'); },
      }, browser: { collect: async () => [], close: async () => {} },
    });
    expect(result.reportedStatus).toBe('operational');
    expect(result.evidence.historyError).toBe('invalid_payload');
  });
});
