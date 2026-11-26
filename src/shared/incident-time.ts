import type { Incident } from './contracts.js';

type IncidentTimes = Pick<Incident, 'state' | 'startedAt' | 'resolvedAt' | 'updates' | 'updatedAt' | 'lastObservedAt'>;

/** A source closure update is stronger than a later metadata update. */
export function sourceClosureBound(incident: IncidentTimes): number | null {
  const start = Date.parse(incident.startedAt);
  const observed = Date.parse(incident.lastObservedAt);
  const closures = incident.updates.filter(({ phase }) => phase === 'resolved' || phase === 'completed')
    .map(({ timestamp }) => Date.parse(timestamp)).filter((at) => at >= start && at <= observed);
  const updated = Date.parse(incident.updatedAt);
  return closures.length ? Math.min(...closures) : updated >= start && updated <= observed ? updated : null;
}

/** Membership bound only; never an official recovery time or duration. */
export function incidentEndBound(
  incident: IncidentTimes,
  ongoingUntil: string,
): number {
  if (incident.resolvedAt !== null) return Date.parse(incident.resolvedAt);
  if (incident.state !== 'resolved' && incident.state !== 'completed') return Date.parse(ongoingUntil);
  // Only existing legacy records can lack source evidence. New candidates fail closed.
  return sourceClosureBound(incident) ?? Math.max(Date.parse(incident.startedAt), Date.parse(incident.lastObservedAt));
}
