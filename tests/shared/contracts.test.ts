import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas';

const validProvider = {
  id: 'example',
  name: 'Example',
  category: 'infra',
  aliases: ['Example Status'],
  tags: ['network'],
  officialStatusUrl: 'https://status.example.com/',
  officialHomeUrl: null,
  displayOrder: 1,
  enabled: true,
  adapter: {
    type: 'statuspage-v2',
    endpoints: { summary: 'https://status.example.com/api/v2/summary.json' },
    timeoutMs: 8000,
    retries: 2,
    requiredRegions: ['global'],
    componentGroups: [{
      id: 'core',
      name: 'Core',
      upstreamIds: ['upstream-core'],
      namePatterns: ['Core'],
    }],
    browserFallback: false,
  },
};

describe('parseRegistry', () => {
  it('accepts a complete provider configuration', () => {
    expect(parseRegistry([validProvider])).toEqual([validProvider]);
  });

  it('rejects duplicate provider IDs', () => {
    expect(() => parseRegistry([validProvider, { ...validProvider, displayOrder: 2 }]))
      .toThrow(/duplicate.*id/i);
  });

  it.each([
    { officialStatusUrl: 'http://status.example.com/' },
    { officialStatusUrl: 'javascript:alert(1)' },
    { officialHomeUrl: 'http://example.com' },
    { adapter: { ...validProvider.adapter, endpoints: { summary: 'http://status.example.com/api' } } },
  ])('rejects non-HTTPS official and endpoint URLs: %j', (change) => {
    expect(() => parseRegistry([{ ...validProvider, ...change }])).toThrow();
  });

  it('rejects unknown enum values and unknown fields', () => {
    expect(() => parseRegistry([{ ...validProvider, category: 'unknown' }])).toThrow();
    expect(() => parseRegistry([{ ...validProvider, adapter: { ...validProvider.adapter, type: 'unknown' } }]))
      .toThrow();
    expect(() => parseRegistry([{ ...validProvider, unreviewed: true }])).toThrow();
  });

  it('rejects duplicate declared regions', () => {
    const adapter = { ...validProvider.adapter, requiredRegions: ['cn-north-1', 'cn-north-1'] };
    expect(() => parseRegistry([{ ...validProvider, adapter }])).toThrow(/duplicate.*region/i);
  });

  it('loads all 20 declared providers without implying adapter connectivity', () => {
    const providers = parseRegistry(registry);
    expect(providers).toHaveLength(20);
    expect(providers.map(({ id }) => id)).toEqual([
      'cloudflare', 'github', 'claude', 'openai', 'moonshot', 'deepseek', 'minimax', 'streamlake',
      'xai', 'devin', 'opencode', 'factory', 'zed',
      'gcp', 'apple-cn', 'azure', 'aws-cn', 'tencent-cloud', 'aliyun', 'baidu-cloud',
    ]);
    expect(providers.every(({ enabled, adapter }) => enabled && Boolean(adapter.type))).toBe(true);
  });

  it.each(['xai', 'opencode', 'instatus'])('accepts the %s source protocol', (type) => {
    const source = { ...validProvider, adapter: { ...validProvider.adapter, type, sourcePageId: 'verified-page-id' } };
    expect(parseRegistry([source])).toEqual([source]);
  });

  it('requires a pinned Instatus page identity', () => {
    expect(() => parseRegistry([{ ...validProvider, adapter: { ...validProvider.adapter, type: 'instatus' } }]))
      .toThrow(/pinned.*page identity/i);
  });

  it.each([
    ['devin', 'https://www.devinstatus.com'],
    ['factory', 'https://status.factory.ai'],
  ])('uses official structured Statuspage current and history endpoints for %s', (id, origin) => {
    expect(parseRegistry(registry).find((source) => source.id === id)).toMatchObject({
      enabled: true, category: 'ai', officialStatusUrl: `${origin}/`,
      adapter: { type: 'statuspage-v2', browserFallback: false, endpoints: {
        summary: `${origin}/api/v2/summary.json`,
        active: `${origin}/api/v2/incidents/unresolved.json`,
        incidents: `${origin}/api/v2/incidents.json`,
      } },
    });
  });
});
