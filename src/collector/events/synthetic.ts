import { createHash } from 'node:crypto';
import type { Incident, ServiceStatus } from '../../shared/contracts.js';
import type { ProviderCollection } from '../types.js';
import { coversScope, isClosed, isCurrentNativeFault } from './normalize.js';

export function reconcileSynthetic(
  incidents: Incident[], collection: ProviderCollection, now: string,
): void {
  const result = collection.result;
  if (!result || collection.collection.freshness !== 'fresh'
    || result.coverage.currentState !== 'complete'
    || !result.evidence.requiredChecks.every(({ passed }) => passed)) return;
  const native = incidents.filter((incident) => isCurrentNativeFault(incident, result));
  const scopes = result.components.filter(({ reportedStatus }) => reportedStatus && reportedStatus !== 'operational')
    .map((component) => ({ components: [component.id], regions: component.region ? [component.region] : [],
      status: component.reportedStatus!, title: component.name }));
  if (!scopes.length && result.reportedStatus && result.reportedStatus !== 'operational') {
    scopes.push({ components: [], regions: result.coverage.regions, status: result.reportedStatus, title: result.providerId });
  }
  for (const incident of incidents.filter((incident) => incident.providerId === result.providerId
    && incident.isSynthetic && !isClosed(incident) && !incident.supersededBy)) {
    const scopedComponents = result.components.filter(({ id }) => incident.affectedComponentIds.includes(id));
    const recovered = result.reportedStatus === 'operational'
      || (scopedComponents.length === incident.affectedComponentIds.length && scopedComponents.length > 0
        && scopedComponents.every(({ reportedStatus }) => reportedStatus === 'operational'));
    if (recovered) {
      incident.state = incident.kind === 'maintenance' ? 'completed' : 'resolved';
      incident.resolvedAt = now;
      incident.resolvedTimeBasis = 'first_observed';
      incident.updatedAt = now;
      incident.lastObservedAt = now;
      incident.durationMinutes = (Date.parse(now) - Date.parse(incident.startedAt)) / 60_000;
    }
  }
  for (const scope of scopes) {
    const kind = scope.status === 'maintenance' ? 'maintenance' : 'incident';
    const scopeIncident = { providerId: result.providerId, kind,
      affectedComponentIds: scope.components, affectedRegions: scope.regions } as Incident;
    if (native.some((incident) => coversScope(incident, scopeIncident))) continue;
    const existing = incidents.find((incident) => incident.isSynthetic && !isClosed(incident)
      && !incident.supersededBy && incident.providerId === result.providerId && incident.kind === kind
      && JSON.stringify(incident.affectedComponentIds) === JSON.stringify(scope.components)
      && JSON.stringify(incident.affectedRegions) === JSON.stringify(scope.regions));
    if (existing) {
      existing.lastObservedAt = now;
      if (existing.severity !== scope.status) {
        existing.severity = scope.status as Exclude<ServiceStatus, 'operational'>;
        existing.updatedAt = now;
        existing.updates.push({ id: `${existing.id}:update:${now}`, phase: existing.state,
          body: `Observed status changed to ${scope.status}`, timestamp: now });
      }
      continue;
    }
    if (!collection.officialStatusUrl) throw new Error(`Missing official URL for synthetic scope: ${result.providerId}`);
    const digest = createHash('sha256').update(JSON.stringify([scope.components, scope.regions, now, kind])).digest('hex').slice(0, 20);
    const sourceIdentity = `${result.providerId}:observed:${digest}`;
    incidents.push({
      id: `${sourceIdentity}:episode:1`, sourceIdentity, episode: 1, providerId: result.providerId,
      upstreamId: null, kind, title: `Observed ${scope.title} ${scope.status}`,
      severity: scope.status as Exclude<ServiceStatus, 'operational'>, sourceSeverity: null,
      severityBasis: scope.components.length ? 'component' : 'derived',
      state: kind === 'maintenance' ? 'in_progress' : 'investigating', origin: 'observed', isSynthetic: true,
      affectedComponentIds: scope.components, affectedRegions: scope.regions, startedAt: now,
      startTimeBasis: 'first_observed', resolvedAt: null, resolvedTimeBasis: null,
      lastObservedAt: now, updatedAt: now, durationMinutes: null,
      sourceUrl: collection.officialStatusUrl, postmortemUrl: null, supersededBy: null, updates: [],
    });
  }
}
