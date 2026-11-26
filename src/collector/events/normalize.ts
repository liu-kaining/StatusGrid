import { load } from 'cheerio';
import type { AdapterResult, Incident, SourceIncident } from '../../shared/contracts.js';

export const isClosed = (incident: Pick<Incident, 'state'>) =>
  incident.state === 'resolved' || incident.state === 'completed';
export const isActiveFault = (incident: Pick<Incident, 'state' | 'kind' | 'severity'>) =>
  !isClosed(incident) && incident.state !== 'scheduled'
  && incident.kind !== 'advisory' && incident.severity !== null;

export function isCurrentNativeFault(incident: Incident, result: AdapterResult): boolean {
  return incident.providerId === result.providerId && incident.origin === 'official'
    && isActiveFault(incident) && Boolean(result.evidence.currentIncidentIds?.includes(incident.sourceIdentity));
}

export function normalizeIncident(source: SourceIncident, episode: number, now: string): Incident {
  return {
    ...structuredClone(source), id: `${source.sourceIdentity}:episode:${episode}`, episode,
    supersededBy: null, lastObservedAt: now,
    title: load(source.title, null, false).text(),
    updates: source.updates.map((update) => ({ ...update, body: load(update.body, null, false).text() }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)),
    durationMinutes: source.resolvedAt && ['source_started_at', 'source_reopened_at'].includes(source.startTimeBasis)
      ? Math.max(0, (Date.parse(source.resolvedAt) - Date.parse(source.startedAt)) / 60_000) : null,
  };
}

export function sameScope(a: Incident, b: Incident): boolean {
  if (a.providerId !== b.providerId || a.kind !== b.kind) return false;
  const intersects = (left: string[], right: string[]) =>
    !left.length || !right.length || left.some((id) => right.includes(id));
  return intersects(a.affectedComponentIds, b.affectedComponentIds)
    && intersects(a.affectedRegions, b.affectedRegions);
}

export function coversScope(official: Incident, observed: Incident): boolean {
  const covers = (native: string[], scope: string[]) =>
    native.length === 0 || (scope.length > 0 && scope.every((id) => native.includes(id)));
  return sameScope(official, observed)
    && covers(official.affectedComponentIds, observed.affectedComponentIds)
    && covers(official.affectedRegions, observed.affectedRegions);
}

export function overlaps(a: Incident, b: Incident): boolean {
  return Date.parse(a.startedAt) <= Date.parse(b.resolvedAt ?? '9999-12-31T00:00:00Z')
    && Date.parse(b.startedAt) <= Date.parse(a.resolvedAt ?? '9999-12-31T00:00:00Z');
}
