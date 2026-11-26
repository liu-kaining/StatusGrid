import type { DailyStat, ServiceStatus } from '../../shared/contracts.js';
import { STATUS_SEVERITY } from '../../shared/status.js';
import { incidentEndBound } from '../../shared/incident-time.js';
import type { PersistedState } from '../types.js';

type Interval = [number, number];
const DAY = 86_400_000;
export const historyBoundary = (now: string) => Math.floor(Date.parse(now) / DAY) * DAY - 89 * DAY;

function unionMinutes(intervals: Interval[], start: number, end: number): number {
  const clipped = intervals.map(([a, b]): Interval => [Math.max(a, start), Math.min(b, end)])
    .filter(([a, b]) => b > a).sort(([a], [b]) => a - b);
  let total = 0;
  let finish = start;
  for (const [a, b] of clipped) {
    total += Math.max(0, b - Math.max(a, finish));
    finish = Math.max(finish, b);
  }
  return total / 60_000;
}

export type DerivedRollupRevision = 1 | 2;

export function buildDailyStats(
  state: PersistedState, now: string, intervalMinutes: number, providerId?: string, revision: DerivedRollupRevision = 2,
): DailyStat[] {
  if (![5, 10].includes(intervalMinutes)) throw new Error('Invalid rollup interval');
  const until = Date.parse(now);
  if (!Number.isFinite(until)) throw new Error('Invalid rollup timestamp');
  const incidents = state.incidents.filter((incident) => !incident.supersededBy && incident.kind !== 'advisory'
    && (providerId === undefined || incident.providerId === providerId));
  const observations = Object.entries(state.observations)
    .filter(([id]) => providerId === undefined || id === providerId)
    .flatMap(([id, samples]) => samples.map((sample, index) => ({
      ...sample, providerId: id, start: Date.parse(sample.at), end: Math.min(until,
        Date.parse(sample.through) + sample.intervalMinutes * 2 * 60_000,
        samples[index + 1] ? Date.parse(samples[index + 1]!.at) : Infinity),
    })));
  const coverage: Interval[] = observations.filter(({ status }) => status !== null).map(({ start, end }) => [start, end]);
  const impact = (origin: 'official' | 'observed'): Interval[] => incidents
    .filter((incident) => incident.origin === origin && incident.severity !== null && incident.kind === 'incident'
      && (origin === 'observed' || (incident.resolvedAt !== null && incident.resolvedTimeBasis === 'source'
        && ['source_started_at', 'source_reopened_at'].includes(incident.startTimeBasis))))
    .flatMap((incident) => {
      const start = Date.parse(incident.startedAt);
      const end = revision === 1 ? Date.parse(incident.resolvedAt ?? now) : incidentEndBound(incident, now);
      if (origin === 'official') return [[start, end] as Interval];
      // Observed impact cannot claim the unknown gap during a failed or overdue collection.
      const evidence: Interval[] = revision === 1 ? coverage : observations.filter((sample) =>
        sample.providerId === incident.providerId && sample.status !== null
        && sample.status !== 'operational' && sample.status !== 'maintenance').map(({ start, end }) => [start, end]);
      return evidence.map(([a, b]): Interval => [Math.max(a, start), Math.min(b, end)]).filter(([a, b]) => b > a);
    });
  const official = impact('official');
  const observed = impact('observed');
  const days: DailyStat[] = [];
  for (let start = historyBoundary(now); start <= until; start += DAY) {
    const end = Math.min(until, start + DAY);
    const relevant = incidents.filter((incident) => incident.state !== 'scheduled'
      && Date.parse(incident.startedAt) <= end && Date.parse(incident.startedAt) < start + DAY
      && ((revision === 1 ? Date.parse(incident.resolvedAt ?? incident.lastObservedAt)
        : incidentEndBound(incident, incident.lastObservedAt)) > start
        || (incident.resolvedAt === null && (revision === 1 || !['resolved', 'completed'].includes(incident.state))
          && Date.parse(incident.lastObservedAt) === until && until === start)));
    const statuses: ServiceStatus[] = [
      ...observations.filter((sample) => sample.status !== null && sample.start <= end
        && sample.start < start + DAY && (sample.end > start || sample.start === until))
        .map((sample) => sample.status!),
      ...relevant.flatMap(({ severity }) => severity ? [severity] : []),
    ];
    const worstStatus = statuses.sort((a, b) => STATUS_SEVERITY[b] - STATUS_SEVERITY[a])[0] ?? null;
    const covered = unionMinutes(coverage, start, end);
    days.push({
      date: new Date(start).toISOString().slice(0, 10), worstStatus, incidentCount: relevant.length,
      reportedImpactMinutes: official.some(([a, b]) => a < end && b > start) ? unionMinutes(official, start, end) : null,
      observedImpactMinutes: observed.some(([a, b]) => a < end && b > start) ? unionMinutes(observed, start, end) : null,
      observedCoverageMinutes: covered, unknownMinutes: Math.max(0, (end - start) / 60_000 - covered),
      hasEstimatedTimes: relevant.some((incident) => !['source_started_at', 'source_reopened_at'].includes(incident.startTimeBasis)
        || incident.resolvedTimeBasis === 'first_observed' || incident.resolvedAt === null),
    });
  }
  return days;
}
