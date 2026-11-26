import { createHash } from 'node:crypto';
import type { ArchiveIndex, IncidentArchive } from '../../shared/contracts.js';
import type { PersistedState } from '../types.js';

export const revisionOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

export function buildArchives(state: PersistedState): { index: ArchiveIndex; archives: IncidentArchive[] } {
  const groups = new Map<string, PersistedState['incidents']>();
  for (const incident of state.incidents) {
    const month = incident.startedAt.slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), incident]);
  }
  const archives = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, values]): IncidentArchive => {
    const incidents = [...values].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    const updatedAt = incidents.map(({ updatedAt, lastObservedAt }) => updatedAt > lastObservedAt ? updatedAt : lastObservedAt).sort().at(-1)!;
    return { schemaVersion: '1.0', month, revision: revisionOf(incidents), updatedAt, incidents };
  });
  const months = archives.map((archive) => ({
    month: archive.month, revision: archive.revision, path: `incidents/archive/${archive.month}.json`,
    incidentCount: archive.incidents.length, minStartedAt: archive.incidents.map(({ startedAt }) => startedAt).sort()[0] ?? null,
    maxResolvedAt: archive.incidents.flatMap(({ resolvedAt }) => resolvedAt ? [resolvedAt] : []).sort().at(-1) ?? null,
    updatedAt: archive.updatedAt,
  }));
  return { archives, index: { schemaVersion: '1.0', revision: revisionOf(months),
    generatedAt: months.map(({ updatedAt }) => updatedAt).sort().at(-1) ?? state.latest?.completedAt ?? '1970-01-01T00:00:00.000Z', months } };
}

export function buildShards(state: PersistedState): Record<string, unknown> {
  const wrap = (value: object) => ({ schemaVersion: '1.0', ...value });
  const { archives, index } = buildArchives(state);
  const cutoff = Date.parse(state.latest?.completedAt ?? '1970-01-01T00:00:00.000Z') - 30 * 86_400_000;
  const shards: Record<string, unknown> = {
    'state/latest.json': wrap({ run: state.latest }),
    'state/collector-health.json': wrap({ providers: Object.fromEntries(state.latest?.providers.map(({ providerId, collection }) => [providerId, collection]) ?? []) }),
    'state/open-incidents.json': wrap({ incidents: state.openIncidents }),
    'state/incident-identities.json': wrap({ identities: state.identities }),
    'state/notification-ledger.json': wrap(state.ledger),
    'state/observations.json': wrap({ providers: state.observations }),
    'rollup/daily-stats-90d.json': wrap({ providers: state.dailyStats }),
    'incidents/recent-30d.json': wrap({ incidents: state.incidents.filter((incident) =>
      state.openIncidents.some(({ id }) => id === incident.id)
      || Date.parse(incident.resolvedAt ?? incident.lastObservedAt) >= cutoff) }),
    'incidents/archive/index.json': index,
  };
  for (const provider of state.latest?.providers ?? []) shards[`providers/${provider.providerId}.json`] = wrap({ provider });
  for (const archive of archives) shards[`incidents/archive/${archive.month}.json`] = archive;
  return shards;
}
