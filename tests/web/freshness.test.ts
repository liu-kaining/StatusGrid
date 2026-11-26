import { expect, it } from 'vitest';
import { snapshotFreshness, trackDate } from '../../src/web/data/queries.js';

it('uses two and three collection cycles, including ten-minute configuration', () => {
  const at = '2026-11-25T23:59:00.000Z';
  const now = Date.parse(at);
  expect(snapshotFreshness(at, 5, now + 9 * 60_000)).toBe('fresh');
  expect(snapshotFreshness(at, 5, now + 10 * 60_000)).toBe('delayed');
  expect(snapshotFreshness(at, 5, now + 15 * 60_000)).toBe('stale');
  expect(snapshotFreshness(at, 10, now + 19 * 60_000)).toBe('fresh');
  expect(snapshotFreshness(at, 10, now + 20 * 60_000)).toBe('delayed');
  expect(snapshotFreshness(at, 10, now + 30 * 60_000)).toBe('stale');
});

it('anchors track dates to snapshot UTC date rather than local browser midnight', () => {
  expect(trackDate('2026-11-25T23:59:00.000Z', 29)).toBe('2026-11-25');
  expect(trackDate('2026-11-25T23:59:00.000Z', 0)).toBe('2026-10-27');
});
