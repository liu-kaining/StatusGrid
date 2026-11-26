import type { AdapterResult, SourceIncident } from '../../src/shared/contracts.js';
import type { CollectionRun, PersistedState } from '../../src/collector/types.js';
import { applyCollection } from '../../src/collector/events/reconcile.js';

export const time = (minute: number) => `2026-11-25T12:${String(minute).padStart(2, '0')}:00.000Z`;
export function source(patch: Partial<SourceIncident> = {}): SourceIncident {
  return {
    sourceIdentity: 'github:native', providerId: 'github', upstreamId: 'native',
    kind: 'incident', title: 'API issues', severity: 'degraded', sourceSeverity: 'minor',
    severityBasis: 'source', state: 'investigating', origin: 'official', isSynthetic: false,
    affectedComponentIds: ['github:api'], affectedRegions: [], startedAt: time(0),
    startTimeBasis: 'source_started_at', resolvedAt: null, resolvedTimeBasis: null,
    lastObservedAt: time(0), updatedAt: time(0), durationMinutes: null,
    sourceUrl: 'https://www.githubstatus.com/incidents/native', postmortemUrl: null, updates: [],
    ...patch,
  };
}
export function run(at: string, status: AdapterResult['reportedStatus'], incidents: SourceIncident[] = [],
  currentIds: string[] = incidents.map(({ sourceIdentity }) => sourceIdentity)): CollectionRun {
  const result: AdapterResult | null = status === null ? null : {
    providerId: 'github', reportedStatus: status,
    components: [{ id: 'github:api', upstreamId: 'api', groupId: null, name: 'API', aliases: [],
      region: null, reportedStatus: status }],
    incidents, sourceUpdatedAt: at,
    coverage: { basis: 'official_public', regions: [], componentScope: 'full', currentState: 'complete',
      history: 'native', observedSince: null, nativeHistoryEarliestAt: null, limitation: null },
    evidence: { requiredChecks: [{ name: 'current', passed: true, checkedAt: at }],
      currentIncidentIds: currentIds, historyCompleteThrough: null, warnings: [] },
  };
  return {
    snapshotId: at, startedAt: at, completedAt: at, intervalMinutes: 5,
    providers: [{
      providerId: 'github', officialStatusUrl: 'https://www.githubstatus.com',
      result, lastTrustedResult: result,
      collection: { outcome: result ? 'success' : 'failure', freshness: result ? 'fresh' : 'missing',
        reason: result ? null : 'timeout', message: null, lastCheckedAt: at, lastSuccessAt: result ? at : null,
        sourceUpdatedAt: result ? at : null, durationMs: 0, consecutiveFailures: result ? 0 : 1 },
    }],
  };
}
export function advance(state: PersistedState, collection: CollectionRun): PersistedState {
  return applyCollection(state, collection);
}
