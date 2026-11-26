import { expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';

it('requires declared regional scopes and a pinned incident.io page identity', () => {
  const sources = parseRegistry(registry);
  for (const type of ['aliyun', 'tencent-cloud', 'baidu-cloud']) {
    const config = structuredClone(sources.find((source) => source.adapter.type === type)!);
    config.adapter.requiredRegions = [];
    expect(() => parseRegistry([config])).toThrow();
  }
  const openai = structuredClone(sources.find(({ id }) => id === 'openai')!);
  openai.adapter.type = 'incident-io';
  delete openai.adapter.sourcePageId;
  expect(() => parseRegistry([openai])).toThrow();
});
