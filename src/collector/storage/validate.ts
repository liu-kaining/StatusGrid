import { z } from 'zod';
import type { PersistedState } from '../types.js';
import { isClosed } from '../events/normalize.js';
import { buildDailyStats } from './rollup.js';

const text = z.string().min(1);
const instant = z.string().refine((value) => value.endsWith('Z') && Number.isFinite(Date.parse(value)), 'Invalid UTC timestamp');
const nullableTime = instant.nullable();
const https = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Invalid HTTPS URL');
export const version = z.literal('1.0');
const providerId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const status = z.enum(['operational', 'maintenance', 'degraded', 'partial_outage', 'major_outage']);
const phase = z.enum(['investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed', 'unknown']);
const reason = z.enum(['not_connected', 'timeout', 'http_error', 'blocked', 'invalid_payload', 'unknown_status', 'coverage_incomplete', 'overdue']);
const number = z.number().finite().nonnegative();
const strings = z.array(text);
const update = z.strictObject({ id: text, phase, body: z.string(), timestamp: instant });
const sourceFields = {
  sourceIdentity: text, providerId, upstreamId: text.nullable(),
  kind: z.enum(['incident', 'maintenance', 'advisory']), title: text,
  severity: z.enum(['maintenance', 'degraded', 'partial_outage', 'major_outage']).nullable(),
  sourceSeverity: z.string().nullable(), severityBasis: z.enum(['source', 'component', 'derived', 'unknown']),
  state: phase, affectedComponentIds: strings, affectedRegions: strings, startedAt: instant,
  startTimeBasis: z.enum(['source_started_at', 'source_created_at', 'source_published_at', 'source_reopened_at', 'first_observed']),
  resolvedAt: nullableTime, resolvedTimeBasis: z.enum(['source', 'first_observed']).nullable(),
  lastObservedAt: instant, updatedAt: instant, durationMinutes: number.nullable(),
  sourceUrl: https, postmortemUrl: https.nullable(), updates: z.array(update),
};
export const incidentSchema = z.strictObject({
  ...sourceFields, id: text, episode: z.number().int().positive(),
  origin: z.enum(['official', 'observed']), isSynthetic: z.boolean(), supersededBy: text.nullable(),
});
const sourceIncident = z.strictObject({ ...sourceFields, origin: z.literal('official'), isSynthetic: z.literal(false) });
const component = z.strictObject({
  id: text, upstreamId: text.nullable(), groupId: text.nullable(), name: text, aliases: strings,
  region: text.nullable(), reportedStatus: status.nullable(), displayCollapsed: z.boolean().optional(),
});
const adapterResult = z.strictObject({
  providerId, reportedStatus: status.nullable(), components: z.array(component), incidents: z.array(sourceIncident),
  sourceUpdatedAt: nullableTime,
  coverage: z.strictObject({
    basis: z.literal('official_public'), regions: strings, componentScope: z.enum(['full', 'filtered', 'events_only']),
    currentState: z.enum(['complete', 'partial', 'unavailable']), history: z.enum(['native', 'observed', 'mixed', 'none']),
    observedSince: nullableTime, nativeHistoryEarliestAt: nullableTime, limitation: z.string().nullable(),
  }),
  evidence: z.strictObject({
    requiredChecks: z.array(z.strictObject({ name: text, passed: z.boolean(), checkedAt: instant })),
    historyCompleteThrough: nullableTime, historyError: reason.nullable().optional(),
    currentIncidentIds: strings.optional(), warnings: z.array(z.string()),
  }),
});
export const collectionSchema = z.strictObject({
  outcome: z.enum(['success', 'partial', 'failure', 'not_connected']),
  freshness: z.enum(['fresh', 'stale', 'missing']), reason: reason.nullable(), message: z.string().nullable(),
  lastCheckedAt: nullableTime, lastSuccessAt: nullableTime, sourceUpdatedAt: nullableTime,
  durationMs: number.nullable(), consecutiveFailures: z.number().int().nonnegative(),
});
export const providerSchema = z.strictObject({
  providerId, officialStatusUrl: https.optional(), result: adapterResult.nullable(),
  lastTrustedResult: adapterResult.nullable(), collection: collectionSchema,
});
export const runSchema = z.strictObject({
  snapshotId: text, startedAt: instant, completedAt: instant, intervalMinutes: z.union([z.literal(5), z.literal(10)]),
  providers: z.array(providerSchema),
});
const identity = z.strictObject({
  sourceIdentity: text, latestEpisode: z.number().int().positive(), latestIncidentId: text,
  resolvedAt: nullableTime, aliases: strings,
});
const milestone = z.strictObject({
  id: text, incidentId: text, kind: z.enum(['triggered', 'escalated', 'resolved']), at: instant,
});
export const ledgerSchema = z.strictObject({ milestones: z.array(milestone), aliases: z.record(text, text) });
const observation = z.strictObject({
  at: instant, through: instant, intervalMinutes: z.union([z.literal(5), z.literal(10)]), status: status.nullable(),
});
const dailyStat = z.strictObject({
  date: z.iso.date(), worstStatus: status.nullable(), incidentCount: z.number().int().nonnegative(),
  reportedImpactMinutes: number.max(1440).nullable(), observedImpactMinutes: number.max(1440).nullable(),
  observedCoverageMinutes: number.max(1440), unknownMinutes: number.max(1440), hasEstimatedTimes: z.boolean(),
});
export const identitiesSchema = z.record(text, identity);
export const observationsSchema = z.record(providerId, z.array(observation));
export const dailyStatsSchema = z.record(providerId, z.array(dailyStat).max(90));
const persistedStateSchema: z.ZodType<PersistedState> = z.strictObject({
  schemaVersion: version, latest: runSchema.nullable(), incidents: z.array(incidentSchema),
  openIncidents: z.array(incidentSchema), identities: identitiesSchema, ledger: ledgerSchema,
  observations: observationsSchema, dailyStats: dailyStatsSchema,
});

export function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Corrupt inconsistent state: ${label}`);
}

export function validateState(input: unknown): PersistedState {
  const state = persistedStateSchema.parse(input);
  const ids = new Set<string>();
  for (const incident of state.incidents) {
    if (ids.has(incident.id) || incident.id !== `${incident.sourceIdentity}:episode:${incident.episode}`
      || incident.isSynthetic !== (incident.origin === 'observed')
      || (incident.resolvedAt !== null && Date.parse(incident.resolvedAt) < Date.parse(incident.startedAt))
      || (incident.resolvedAt === null && incident.durationMinutes !== null)) {
      throw new Error(`Corrupt incident lifecycle: ${incident.id}`);
    }
    ids.add(incident.id);
  }
  for (const incident of state.incidents) {
    if (incident.supersededBy && !ids.has(incident.supersededBy)) throw new Error('Corrupt incident alias target');
    const identity = state.identities[incident.sourceIdentity];
    if (!identity || identity.latestEpisode < incident.episode) throw new Error('Corrupt incident identity');
  }
  for (const [key, identity] of Object.entries(state.identities)) {
    const episode = state.incidents.find(({ id }) => id === identity.latestIncidentId);
    if (!episode || identity.sourceIdentity !== key || episode.sourceIdentity !== key
      || episode.episode !== identity.latestEpisode || episode.resolvedAt !== identity.resolvedAt) {
      throw new Error('Corrupt latest incident identity');
    }
  }
  assertEqual(state.openIncidents, state.incidents.filter((incident) => !isClosed(incident) && !incident.supersededBy), 'open incidents');
  const milestones = new Set<string>();
  for (const entry of state.ledger.milestones) {
    if (milestones.has(entry.id) || !ids.has(entry.incidentId) || !entry.id.startsWith(`${entry.incidentId}:${entry.kind}`)) {
      throw new Error('Corrupt notification ledger');
    }
    milestones.add(entry.id);
  }
  for (const [alias, target] of Object.entries(state.ledger.aliases)) {
    if (!ids.has(alias) || !ids.has(target) || alias === target) throw new Error('Corrupt notification alias');
  }
  for (const samples of Object.values(state.observations)) {
    let previousEnd = -Infinity;
    for (const sample of samples) {
      if (Date.parse(sample.at) <= previousEnd || Date.parse(sample.through) < Date.parse(sample.at)) {
        throw new Error('Corrupt chronological observations');
      }
      previousEnd = Date.parse(sample.through);
    }
  }
  if (state.latest) {
    if (Date.parse(state.latest.startedAt) > Date.parse(state.latest.completedAt)) throw new Error('Corrupt run timestamps');
    const providers = new Set<string>();
    for (const provider of state.latest.providers) {
      if (providers.has(provider.providerId) || (provider.result && provider.result.providerId !== provider.providerId)
        || (provider.lastTrustedResult && provider.lastTrustedResult.providerId !== provider.providerId)) {
        throw new Error('Corrupt provider identity');
      }
      providers.add(provider.providerId);
      if (provider.result && (provider.collection.freshness !== 'fresh'
        || provider.result.coverage.currentState !== 'complete'
        || !provider.result.evidence.requiredChecks.every(({ passed }) => passed))) {
        throw new Error('Corrupt trusted collection result');
      }
      if (!provider.result && provider.collection.freshness === 'fresh') throw new Error('Corrupt fresh collection without result');
    }
    assertEqual(Object.keys(state.dailyStats).sort(), Object.keys(state.observations).sort(), 'rollup provider coverage');
    for (const provider of Object.keys(state.observations)) {
      assertEqual(state.dailyStats[provider], buildDailyStats(state, state.latest.completedAt, state.latest.intervalMinutes, provider), 'rollup statistics');
    }
  }
  return state;
}
