import { expect, it } from 'vitest';
import type { Incident } from '../../src/shared/contracts.js';
import { isCalendarDate, incidentsForDay } from '../../src/web/data/day.js';
import { webFixture } from '../helpers/web-fixture.js';

it('validates actual UTC calendar days including leap years', () => {
  for (const value of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-1-01', '', '2026-11-26T00:00Z']) expect(isCalendarDate(value)).toBe(false);
  for (const value of ['2028-02-29', '2026-11-26', '2026-12-31']) expect(isCalendarDate(value)).toBe(true);
});

it('uses half-open UTC day intersections, point events, observation bounds and deduplication', () => {
  const base = webFixture().recent.incidents[0]!;
  const event = (id: string, startedAt: string, resolvedAt: string | null, patch: Partial<Incident> = {}): Incident =>
    ({ ...base, id, providerId: 'openai', startedAt, resolvedAt, ...patch });
  const events = [
    event('ongoing', '2026-10-31T23:00:00Z', null),
    event('midnight-end', '2026-10-31T20:00:00Z', '2026-11-01T00:00:00Z'),
    event('next-day', '2026-11-02T00:00:00Z', null),
    event('point', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    event('other', '2026-11-01T02:00:00Z', null, { providerId: 'github' }),
    event('replaced', '2026-11-01T02:00:00Z', null, { supersededBy: 'ongoing' }),
    event('unknown', '2026-11-01T03:00:00Z', null, { severity: null, kind: 'advisory' }),
    event('maintenance', '2026-11-01T04:00:00Z', null, { kind: 'maintenance', severity: 'maintenance' }),
    event('future', '2026-11-01T10:00:00Z', null),
    event('observation-end', '2026-11-01T08:00:00Z', null),
  ];
  expect(incidentsForDay([...events, events[0]!], 'openai', '2026-11-01', '2026-11-01T08:00:00Z').map(({ id }) => id))
    .toEqual(['maintenance', 'unknown', 'point', 'ongoing']);
  expect(incidentsForDay(events, 'openai', '2026-11-02', '2026-11-01T08:00:00Z')).toEqual([]);
  expect(incidentsForDay(events, 'openai', '2026-02-30', '2026-11-01T08:00:00Z')).toEqual([]);
});
