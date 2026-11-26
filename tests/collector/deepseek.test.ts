import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { parseDeepSeek } from '../../src/collector/adapters/deepseek.js';
import { collectProviders } from '../../src/collector/run.js';
import { parseCollectArgs } from '../../src/collector/cli.js';

const config = parseRegistry(registry).find(({ id }) => id === 'deepseek')!;
const now = '2026-11-25T16:20:00Z';
const page = readFileSync('tests/fixtures/deepseek/page.txt', 'utf8');

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
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
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
