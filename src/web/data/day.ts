import type { Incident } from '../../shared/contracts.js';
import { deduplicateIncidents } from './queries.js';
import { incidentEndBound } from '../../shared/incident-time.js';

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function incidentsForDay(incidents: Incident[], providerId: string, date: string, generatedAt: string): Incident[] {
  if (!isCalendarDate(date)) return [];
  const start = Date.parse(`${date}T00:00:00Z`);
  const observed = Date.parse(generatedAt);
  const end = Math.min(start + 86_400_000, observed);
  if (start > observed) return [];
  return deduplicateIncidents(incidents).filter((incident) => {
    if (incident.providerId !== providerId) return false;
    const from = Date.parse(incident.startedAt);
    const to = incidentEndBound(incident, generatedAt);
    if (from > observed) return false;
    if (incident.resolvedAt && from === to) return from >= start && from < start + 86_400_000;
    return from < end && to > start;
  });
}
