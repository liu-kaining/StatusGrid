import { describe, expect, it } from 'vitest';
import { buildDailyStats } from '../../src/collector/storage/rollup.js';
import { applyCollection, emptyState } from '../../src/collector/events/reconcile.js';
import { source, run, time } from '../helpers/history.js';

describe('UTC daily historical rollups', () => {
  it.each([[time(0), 720], ['2026-11-25T00:00:00.000Z', 0]] as const)(
    'records an anomaly observed at cutoff %s without inventing elapsed impact', (at, unknownMinutes) => {
    const state = applyCollection(emptyState(), run(at, 'degraded'));
    expect(state.dailyStats.github?.at(-1)).toMatchObject({
      worstStatus: 'degraded', incidentCount: 1, observedImpactMinutes: null,
      observedCoverageMinutes: 0, unknownMinutes,
    });
  });
  it('excludes incidents and observation coverage ending exactly at the next UTC day boundary', () => {
    const midnight = '2026-11-25T00:00:00.000Z';
    let state = applyCollection(emptyState(), run('2026-11-24T23:50:00.000Z', 'degraded', [source({
      startedAt: '2026-11-24T23:00:00.000Z', updatedAt: '2026-11-24T23:50:00.000Z',
    })]));
    state = applyCollection(state, run(midnight, 'operational', [source({
      startedAt: '2026-11-24T23:00:00.000Z', state: 'resolved', resolvedAt: midnight,
      resolvedTimeBasis: 'source', updatedAt: midnight,
    })], []));
    const days = buildDailyStats(state, '2026-11-25T00:05:00.000Z', 5, 'github');
    expect(days.at(-2)).toMatchObject({
      date: '2026-11-24', worstStatus: 'degraded', incidentCount: 1, reportedImpactMinutes: 60,
    });
    expect(days.at(-1)).toMatchObject({
      date: '2026-11-25', worstStatus: 'operational', incidentCount: 0,
      reportedImpactMinutes: null, observedCoverageMinutes: 5,
    });
  });

  it('unions official impact, excludes imprecise and unknown finish, and splits UTC midnight', () => {
    let state = emptyState();
    const closed = (id: string, start: string, end: string | null) => source({
      sourceIdentity: `github:${id}`, upstreamId: id, startedAt: start,
      state: 'resolved', resolvedAt: end, resolvedTimeBasis: end ? 'source' : null,
    });
    state = applyCollection(state, run(time(20), 'operational', [
      closed('a', '2026-11-24T23:50:00.000Z', '2026-11-25T00:10:00.000Z'),
      closed('b', '2026-11-24T23:55:00.000Z', '2026-11-25T00:20:00.000Z'),
      { ...closed('publication', time(0), time(20)), startTimeBasis: 'source_published_at' },
      closed('unknown-finish', time(0), null),
    ], []));
    const days = buildDailyStats(state, time(20), 5, 'github');
    expect(days.at(-2)).toMatchObject({ date: '2026-11-24', reportedImpactMinutes: 10, incidentCount: 2 });
    expect(days.at(-1)).toMatchObject({ date: '2026-11-25', reportedImpactMinutes: 20, hasEstimatedTimes: true });
  });

  it('never fills pre-observation time and stops extrapolation at two original periods or immediate failure', () => {
    let state = applyCollection(emptyState(), run(time(0), 'operational'));
    state = applyCollection(state, run(time(5), 'degraded'));
    state = applyCollection(state, run(time(10), null));
    state = applyCollection(state, { ...run(time(20), 'operational'), intervalMinutes: 10 });
    const day = buildDailyStats(state, time(50), 10, 'github').at(-1)!;
    expect(day).toMatchObject({ observedCoverageMinutes: 30, unknownMinutes: 740, observedImpactMinutes: 5, worstStatus: 'degraded' });
    expect(day.observedCoverageMinutes + day.unknownMinutes).toBe(770);
    expect(state.observations.github).toHaveLength(4);
  });

  it('coalesces compatible observations while preserving changed cadence and failure boundaries', () => {
    let state = emptyState();
    for (const minute of [0, 5, 10, 15]) state = applyCollection(state, run(time(minute), 'operational'));
    state = applyCollection(state, run(time(20), null));
    state = applyCollection(state, { ...run(time(25), 'operational'), intervalMinutes: 10 });
    expect(state.observations.github).toEqual([
      { at: time(0), through: time(15), status: 'operational', intervalMinutes: 5 },
      { at: time(20), through: time(20), status: null, intervalMinutes: 5 },
      { at: time(25), through: time(25), status: 'operational', intervalMinutes: 10 },
    ]);
    expect(buildDailyStats(state, time(30), 10, 'github').at(-1)).toMatchObject({ observedCoverageMinutes: 25, unknownMinutes: 725 });
  });

  it('retains ancient open events while pruning observation history to the recomputable window', () => {
    let state = applyCollection(emptyState(), run('2026-06-01T00:00:00.000Z', 'degraded', [source({
      startedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
    })]));
    state = applyCollection(state, run(time(0), 'operational', [], []));
    expect(state.openIncidents).toHaveLength(1);
    expect(state.observations.github?.every(({ through }) => through >= '2026-08-28T00:00:00.000Z')).toBe(true);
    expect(state.dailyStats.github).toHaveLength(90);
    expect(state.dailyStats.github?.at(-1)?.unknownMinutes).toBe(720);
  });
});
