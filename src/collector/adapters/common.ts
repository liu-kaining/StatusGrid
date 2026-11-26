import type { AdapterResult, IncidentState, ProviderConfig, ServiceStatus, SourceIncident } from '../../shared/contracts.js';
import { STATUS_SEVERITY } from '../../shared/status.js';
import { AdapterError } from '../errors.js';

export function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AdapterError('invalid_payload', `${label} must be an object`);
  return raw as Record<string, unknown>;
}
export function rows(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw)) throw new AdapterError('invalid_payload', `${label} must be an array`);
  return raw;
}
export function text(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new AdapterError('invalid_payload', `${label} must be a nonempty string`);
  return raw.trim();
}
export function timestamp(raw: unknown, label: string): string {
  const value = text(raw, label);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new AdapterError('invalid_payload', `${label} is not a timestamp`);
  return new Date(millis).toISOString();
}
export function epoch(raw: unknown, label: string): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new AdapterError('invalid_payload', `${label} is not an epoch`);
  }
  return new Date(raw).toISOString();
}
export function known<T extends string>(raw: unknown, allowed: readonly T[], label: string): T {
  if (typeof raw !== 'string') throw new AdapterError('invalid_payload', `${label} missing`);
  if (!allowed.includes(raw as T)) throw new AdapterError('unknown_status', `${label}: ${raw}`);
  return raw as T;
}
export function worse(a: ServiceStatus, b: ServiceStatus): ServiceStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}
export function incident(
  config: ProviderConfig, now: string, upstreamId: string, title: string,
  startedAt: string, updatedAt: string, fields: Partial<SourceIncident>,
): SourceIncident {
  const resolved = fields.resolvedAt ?? null;
  return {
    sourceIdentity: `${config.id}:${upstreamId}`, providerId: config.id, upstreamId, title,
    kind: 'incident', severity: null, sourceSeverity: null, severityBasis: 'unknown',
    state: 'unknown' as IncidentState, origin: 'official', isSynthetic: false,
    affectedComponentIds: [], affectedRegions: [], startedAt, startTimeBasis: 'source_started_at',
    resolvedAt: resolved, resolvedTimeBasis: resolved ? 'source' : null, lastObservedAt: now, updatedAt,
    durationMinutes: resolved ? Math.max(0, (Date.parse(resolved) - Date.parse(startedAt)) / 60_000) : null,
    sourceUrl: config.officialStatusUrl, postmortemUrl: null, updates: [], ...fields,
  };
}
export function result(
  config: ProviderConfig, now: string, reportedStatus: ServiceStatus,
  checks: string[], coverage: AdapterResult['coverage'], fields: Partial<AdapterResult> = {},
): AdapterResult {
  return {
    providerId: config.id, reportedStatus, components: [], incidents: [],
    sourceUpdatedAt: null, coverage, evidence: {
      requiredChecks: checks.map((name) => ({ name, passed: true, checkedAt: now })),
      historyCompleteThrough: null, currentIncidentIds: [], warnings: [],
    }, ...fields,
  };
}
export function coverage(config: ProviderConfig, scope: AdapterResult['coverage']['componentScope'],
  history: AdapterResult['coverage']['history'], limitation: string): AdapterResult['coverage'] {
  return {
    basis: 'official_public', regions: config.adapter.requiredRegions,
    componentScope: scope, currentState: 'complete', history,
    observedSince: null, nativeHistoryEarliestAt: null, limitation,
  };
}
