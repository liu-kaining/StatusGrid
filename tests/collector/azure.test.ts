import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { parseAzure } from '../../src/collector/adapters/azure.js';

const config = parseRegistry(registry).find(({ id }) => id === 'azure')!;
const now = '2026-11-25T16:20:00Z';
const page = readFileSync('tests/fixtures/azure/page.html', 'utf8');
const feed = readFileSync('tests/fixtures/azure/feed.xml', 'utf8');
describe('Azure', () => {
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
});
