import { expect, it } from 'vitest';
import { filterProviders } from '../../src/web/data/queries.js';
import { parseViewState } from '../../src/web/state/url.js';
import { webFixture } from '../helpers/web-fixture.js';

const fixture = webFixture();
it('searches the independent component index and composes category/abnormal filters', () => {
  expect(filterProviders(fixture.summary.providers, parseViewState('?q=neural-endpoint&cat=ai'), fixture.search).map(({ id }) => id)).toEqual(['openai']);
  expect(filterProviders(fixture.summary.providers, parseViewState('?only_abnormal=1'), fixture.search).map(({ id }) => id))
    .toEqual(['openai', 'cloudflare', 'aliyun']);
});
it('sorts real service faults before maintenance and separates blocked sources from normal cards', () => {
  expect(filterProviders([...fixture.summary.providers].reverse(), parseViewState(''), fixture.search).map(({ id }) => id))
    .toEqual(['openai', 'cloudflare', 'aliyun', 'github']);
});
it('sorts equal severity by the newest event even when source events arrive oldest first', () => {
  const openai = structuredClone(fixture.summary.providers.find(({ id }) => id === 'openai')!);
  const cloudflare = structuredClone(fixture.summary.providers.find(({ id }) => id === 'cloudflare')!);
  openai.activeIncidents.push({ ...openai.activeIncidents[0]!, id: 'newer', updatedAt: '2026-11-26T08:10:00.000Z' });
  cloudflare.status = 'degraded';
  cloudflare.activeIncidents = [{ ...openai.activeIncidents[0]!, updatedAt: '2026-11-26T08:05:00.000Z' }];
  expect(filterProviders([cloudflare, openai], parseViewState('')).map(({ id }) => id)).toEqual(['openai', 'cloudflare']);
});
