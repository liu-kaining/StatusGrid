import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Incident } from '../../src/shared/contracts.js';
import { IncidentTimeline } from '../../src/web/components/IncidentTimeline.js';
import { webFixture } from '../helpers/web-fixture.js';

const official = webFixture().recent.incidents.find(({ providerId }) => providerId === 'openai')!;
const render = (patch: Partial<Incident>) => renderToStaticMarkup(createElement(IncidentTimeline, { incidents: [{ ...official, ...patch }] }));

it('keeps official event origin separate from estimated start and recovery boundaries', () => {
  const markup = render({ origin: 'official', startTimeBasis: 'first_observed',
    resolvedAt: official.updatedAt, resolvedTimeBasis: 'first_observed', lastObservedAt: '2026-11-26T08:09:00.000Z' });
  expect(markup).toContain('官方事件');
  expect(markup).toContain('估计开始（首次观测）');
  expect(markup).toContain('估计恢复（首次观测）');
  expect(markup).toContain('最近观测时间');
  expect(markup).toContain('2026-11-26 08:09:00 UTC');
  expect(markup).not.toContain('官方开始时间');
  expect(markup).not.toContain('官方恢复时间');
});

it.each([
  ['source_started_at', '官方开始时间'],
  ['source_reopened_at', '官方重开时间'],
  ['source_created_at', '官方创建时间（非确认开始）'],
  ['source_published_at', '官方发布时间（非确认开始）'],
] as const)('preserves the start basis %s rather than presenting every source time as an outage start', (startTimeBasis, label) => {
  const markup = render({ startTimeBasis });
  expect(markup).toContain(label);
  expect(markup).toContain('最近观测时间');
});

it('labels source recovery explicitly and does not infer a recovery basis when it is absent', () => {
  expect(render({ resolvedAt: official.updatedAt, resolvedTimeBasis: 'source' })).toContain('官方恢复时间');
  expect(render({ resolvedAt: official.updatedAt, resolvedTimeBasis: null })).toContain('恢复时间（依据未知）');
  expect(render({ resolvedAt: null, resolvedTimeBasis: null })).not.toContain('恢复时间');
});

it('does not infer an estimated boundary solely from observed event origin', () => {
  const markup = render({ origin: 'observed', startTimeBasis: 'source_started_at' });
  expect(markup).toContain('观测事件');
  expect(markup).toContain('官方开始时间');
  expect(markup).not.toContain('观测事件 · 估计时间');
});
