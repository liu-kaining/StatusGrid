import { z } from 'zod';

export const text = z.string().min(1);
export const instant = z.string().refine((value) => value.endsWith('Z') && Number.isFinite(Date.parse(value)), 'Invalid UTC timestamp');
export const nullableTime = instant.nullable();
export const https = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Invalid HTTPS URL');
export const version = z.literal('1.0');
export const providerId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const status = z.enum(['operational', 'maintenance', 'degraded', 'partial_outage', 'major_outage']);
export const publicStatusSchema = z.enum(['operational', 'maintenance', 'degraded', 'partial_outage', 'major_outage', 'stale']);
export const phase = z.enum(['investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed', 'unknown']);
export const reason = z.enum(['not_connected', 'timeout', 'http_error', 'blocked', 'invalid_payload', 'unknown_status', 'coverage_incomplete', 'overdue']);
export const number = z.number().finite().nonnegative();
export const strings = z.array(text);
export const sourceFields = {
  sourceIdentity: text, providerId, upstreamId: text.nullable(),
  kind: z.enum(['incident', 'maintenance', 'advisory']), title: text,
  severity: z.enum(['maintenance', 'degraded', 'partial_outage', 'major_outage']).nullable(),
  sourceSeverity: z.string().nullable(), severityBasis: z.enum(['source', 'component', 'derived', 'unknown']),
  state: phase, affectedComponentIds: strings, affectedRegions: strings, startedAt: instant,
  startTimeBasis: z.enum(['source_started_at', 'source_created_at', 'source_published_at', 'source_reopened_at', 'first_observed']),
  resolvedAt: nullableTime, resolvedTimeBasis: z.enum(['source', 'first_observed']).nullable(),
  lastObservedAt: instant, updatedAt: instant, durationMinutes: number.nullable(),
  sourceUrl: https, postmortemUrl: https.nullable(),
  updates: z.array(z.strictObject({ id: text, phase, body: z.string(), timestamp: instant })),
};
export const incidentSchema = z.strictObject({
  ...sourceFields, id: text, episode: z.number().int().positive(),
  origin: z.enum(['official', 'observed']), isSynthetic: z.boolean(), supersededBy: text.nullable(),
});
export const componentSchema = z.strictObject({
  id: text, upstreamId: text.nullable(), groupId: text.nullable(), name: text, aliases: strings,
  region: text.nullable(), reportedStatus: status.nullable(), displayCollapsed: z.boolean().optional(),
});
export const coverageSchema = z.strictObject({
  basis: z.literal('official_public'), regions: strings, componentScope: z.enum(['full', 'filtered', 'events_only']),
  currentState: z.enum(['complete', 'partial', 'unavailable']), history: z.enum(['native', 'observed', 'mixed', 'none']),
  observedSince: nullableTime, nativeHistoryEarliestAt: nullableTime, limitation: z.string().nullable(),
});
export const collectionSchema = z.strictObject({
  outcome: z.enum(['success', 'partial', 'failure', 'not_connected']),
  freshness: z.enum(['fresh', 'stale', 'missing']), reason: reason.nullable(), message: z.string().nullable(),
  lastCheckedAt: nullableTime, lastSuccessAt: nullableTime, sourceUpdatedAt: nullableTime,
  durationMs: number.nullable(), consecutiveFailures: z.number().int().nonnegative(),
});
export const dailyStatSchema = z.strictObject({
  date: z.iso.date(), worstStatus: status.nullable(), incidentCount: z.number().int().nonnegative(),
  reportedImpactMinutes: number.max(1440).nullable(), observedImpactMinutes: number.max(1440).nullable(),
  observedCoverageMinutes: number.max(1440), unknownMinutes: number.max(1440), hasEstimatedTimes: z.boolean(),
});
