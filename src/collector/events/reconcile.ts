import type { SourceIncident } from '../../shared/contracts.js';
import type { CollectionRun, PersistedState, ReconcileResult } from '../types.js';
import { coversScope, isClosed, isCurrentNativeFault, normalizeIncident, overlaps } from './normalize.js';
import { recordMilestones } from './milestones.js';
import { reconcileSynthetic } from './synthetic.js';
import { buildDailyStats, historyBoundary } from '../storage/rollup.js';

export function emptyState(): PersistedState {
  return { schemaVersion: '1.0', latest: null, incidents: [], openIncidents: [], identities: {},
    ledger: { milestones: [], aliases: {} }, observations: {}, dailyStats: {} };
}

export function reconcileIncidents(
  previous: PersistedState, incoming: SourceIncident[], collection: CollectionRun, now: string,
): ReconcileResult {
  const incidents = structuredClone(previous.incidents);
  const identities = structuredClone(previous.identities);
  const ledger = structuredClone(previous.ledger);
  const before = new Map(previous.incidents.map((incident) => [incident.id, incident]));
  for (const source of incoming) {
    const provider = collection.providers.find(({ providerId }) => providerId === source.providerId);
    if (!provider?.result || provider.collection.freshness !== 'fresh') continue;
    const identity = identities[source.sourceIdentity];
    let last = identity ? incidents.find(({ id }) => id === identity.latestIncidentId) : undefined;
    // A late resolved-history correction belongs to its original episode.
    if (last && isClosed(source)) {
      const historical = source.resolvedAt && Date.parse(source.resolvedAt) < Date.parse(last.startedAt)
        ? incidents.filter((incident) => incident.sourceIdentity === source.sourceIdentity
          && isClosed(incident) && Date.parse(incident.startedAt) <= Date.parse(source.resolvedAt!))
          .sort((a, b) => b.episode - a.episode)[0]
        : incidents.find((incident) => incident.sourceIdentity === source.sourceIdentity
          && incident.resolvedAt !== null && incident.resolvedAt === source.resolvedAt);
      if (historical) last = historical;
      else if (Date.parse(source.updatedAt) < Date.parse(last.startedAt)) continue;
    }
    const current = provider.result.evidence.currentIncidentIds?.includes(source.sourceIdentity) ?? false;
    if (last && isClosed(last) && !isClosed(source) && !current) continue;
    let next = normalizeIncident(source, last?.episode ?? 1, now);
    if (last && isClosed(last) && !isClosed(source)) {
      const boundary = last.resolvedAt ?? last.updatedAt;
      const activeUpdates = source.updates.filter((update) =>
        ['investigating', 'identified', 'monitoring', 'in_progress'].includes(update.phase)
        && Date.parse(update.timestamp) > Date.parse(boundary) && Date.parse(update.timestamp) <= Date.parse(now));
      const explicit = ['source_reopened_at', 'source_started_at'].includes(source.startTimeBasis)
        && Date.parse(source.startedAt) > Date.parse(boundary) && Date.parse(source.startedAt) <= Date.parse(now)
        ? source.startedAt : null;
      const startedAt = explicit ?? activeUpdates.sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0]?.timestamp ?? now;
      next = normalizeIncident({ ...source, startedAt,
        startTimeBasis: explicit || activeUpdates.length ? 'source_reopened_at' : 'first_observed',
        resolvedAt: null, resolvedTimeBasis: null, durationMinutes: null,
        updates: source.updates.filter((update) => Date.parse(update.timestamp) >= Date.parse(startedAt)),
      }, (identity?.latestEpisode ?? last.episode) + 1, now);
      last = undefined;
    } else if (last) {
      if (Date.parse(source.updatedAt) < Date.parse(last.updatedAt)) continue;
      const updates = new Map(last.updates.map((update) => [update.id, update]));
      for (const update of next.updates) {
        if (Date.parse(update.timestamp) >= Date.parse(last.startedAt)) updates.set(update.id, update);
      }
      next = { ...next, startedAt: last.startedAt, startTimeBasis: last.startTimeBasis,
        updates: [...updates.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)) };
      if (!isClosed(next) && next.resolvedAt && Date.parse(next.resolvedAt) < Date.parse(next.startedAt)) {
        next.resolvedAt = null;
        next.resolvedTimeBasis = null;
      }
      next.durationMinutes = next.resolvedAt && ['source_started_at', 'source_reopened_at'].includes(next.startTimeBasis)
        ? Math.max(0, (Date.parse(next.resolvedAt) - Date.parse(next.startedAt)) / 60_000) : null;
    }
    const index = incidents.findIndex(({ id }) => id === next.id);
    if (index < 0) incidents.push(next); else incidents[index] = next;
    if (!identity || next.episode >= identity.latestEpisode) {
      identities[source.sourceIdentity] = { sourceIdentity: source.sourceIdentity, latestEpisode: next.episode,
        latestIncidentId: next.id, resolvedAt: next.resolvedAt, aliases: identity?.aliases ?? [] };
    }
  }
  // Alias before synthesizing or notifying so one fault has one notification identity.
  for (const observed of incidents.filter((incident) => incident.isSynthetic && !incident.supersededBy)) {
    const result = collection.providers.find(({ providerId }) => providerId === observed.providerId)?.result;
    const official = incidents.find((incident) => incident.origin === 'official' && coversScope(incident, observed)
      && overlaps(observed, incident) && incident.kind !== 'advisory' && incident.severity !== null
      && (isClosed(observed) || Boolean(result && isCurrentNativeFault(incident, result))));
    if (!official) continue;
    observed.supersededBy = official.id;
    ledger.aliases[official.id] ??= ledger.aliases[observed.id] ?? observed.id;
    identities[official.sourceIdentity]!.aliases = [...new Set([
      ...identities[official.sourceIdentity]!.aliases, observed.sourceIdentity,
    ])].sort();
  }
  for (const provider of collection.providers) reconcileSynthetic(incidents, provider, now);
  for (const incident of incidents) {
    if (!identities[incident.sourceIdentity]) {
      identities[incident.sourceIdentity] = { sourceIdentity: incident.sourceIdentity, latestEpisode: incident.episode,
        latestIncidentId: incident.id, resolvedAt: incident.resolvedAt, aliases: [] };
    } else if (identities[incident.sourceIdentity]!.latestIncidentId === incident.id) {
      identities[incident.sourceIdentity]!.resolvedAt = incident.resolvedAt;
    }
    const provider = collection.providers.find(({ providerId }) => providerId === incident.providerId);
    const current = incident.origin === 'observed' || Boolean(
      provider?.result?.evidence.currentIncidentIds?.includes(incident.sourceIdentity),
    );
    const alias = ledger.aliases[incident.id];
    const previousIncident = alias && alias !== previous.ledger.aliases[incident.id]
      ? before.get(alias) ?? before.get(incident.id) : before.get(incident.id);
    recordMilestones(ledger, previousIncident, incident, now, current);
  }
  incidents.sort((a, b) => a.sourceIdentity.localeCompare(b.sourceIdentity) || a.episode - b.episode);
  return { incidents, openIncidents: incidents.filter((incident) => !isClosed(incident) && !incident.supersededBy),
    identities, ledger, milestones: ledger.milestones.filter(({ id }) => !previous.ledger.milestones.some((old) => old.id === id)) };
}

export function applyCollection(previous: PersistedState, run: CollectionRun): PersistedState {
  const reconciled = reconcileIncidents(previous, run.providers.flatMap(({ result }) => result?.incidents ?? []), run, run.completedAt);
  const state: PersistedState = { ...structuredClone(previous), latest: structuredClone(run),
    incidents: reconciled.incidents, openIncidents: reconciled.openIncidents,
    identities: reconciled.identities, ledger: reconciled.ledger };
  for (const provider of run.providers) {
    const samples = state.observations[provider.providerId] ?? [];
    const at = provider.collection.lastCheckedAt ?? run.completedAt;
    const last = samples.at(-1);
    const status = provider.result && provider.collection.freshness === 'fresh' ? provider.result.reportedStatus : null;
    if (last && Date.parse(at) < Date.parse(last.through)) throw new Error('Collection observations must be chronological');
    if (last?.through === at) {
      if (last.status !== status || last.intervalMinutes !== run.intervalMinutes) {
        throw new Error('Conflicting collection observations at the same timestamp');
      }
    } else if (last && last.status === status && last.intervalMinutes === run.intervalMinutes
      && Date.parse(at) - Date.parse(last.through) <= last.intervalMinutes * 2 * 60_000) {
      last.through = at;
    } else {
      samples.push({ at, through: at, intervalMinutes: run.intervalMinutes, status });
    }
    const boundary = historyBoundary(run.completedAt);
    state.observations[provider.providerId] = samples.filter((sample) =>
      Date.parse(sample.through) + sample.intervalMinutes * 2 * 60_000 > boundary);
    const first = state.observations[provider.providerId]?.[0];
    if (first && Date.parse(first.at) < boundary) {
      first.at = new Date(Math.min(boundary, Date.parse(first.through))).toISOString();
    }
  }
  for (const providerId of Object.keys(state.observations)) {
    state.dailyStats[providerId] = buildDailyStats(state, run.completedAt, run.intervalMinutes, providerId);
  }
  return state;
}
