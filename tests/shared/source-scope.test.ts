import { expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';

it('requires declared regional scopes and pinned structured-page identities', () => {
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
  for (const source of sources.filter(({ adapter }) => adapter.type === 'flashduty')) {
    const config = structuredClone(source);
    delete config.adapter.sourcePageId;
    expect(() => parseRegistry([config])).toThrow(/pinned.*page identity/i);
    config.adapter.sourcePageId = 'invalid-id';
    expect(() => parseRegistry([config])).toThrow(/pinned.*page identity/i);
  }
});
