import type {
  Adapter, AdapterContext, AdapterResult, Component, FailureReason,
  IncidentState, ProviderConfig, ServiceStatus, SourceIncident,
} from '../../shared/contracts.js';
import { STATUS_SEVERITY } from '../../shared/status.js';
import { TransportError } from '../errors.js';

export class AdapterError extends Error {
  constructor(public readonly reason: FailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AdapterError';
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdapterError('invalid_payload', `${label} must be an object`);
  }
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AdapterError('invalid_payload', `${label} must be a nonempty string`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  const date = Date.parse(text(value, label));
  if (!Number.isFinite(date)) throw new AdapterError('invalid_payload', `${label} is not a valid timestamp`);
  return new Date(date).toISOString();
}

function optionalIso(value: unknown, label: string): string | null {
  return value == null ? null : iso(value, label);
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new AdapterError('invalid_payload', `${label} must be an array`);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string') throw new AdapterError('invalid_payload', `${label} is missing`);
  if (!allowed.includes(value as T)) throw new AdapterError('unknown_status', `${label}: ${value}`);
  return value as T;
}

const indicatorValues = ['none', 'maintenance', 'minor', 'major', 'critical'] as const;
const componentValues = ['operational', 'under_maintenance', 'degraded_performance', 'partial_outage', 'major_outage'] as const;
const incidentValues = [
  'investigating', 'identified', 'monitoring', 'resolved', 'scheduled',
  'in_progress', 'verifying', 'completed', 'postmortem', 'cancelled',
] as const;

const indicatorStatus: Record<(typeof indicatorValues)[number], ServiceStatus> = {
  none: 'operational', maintenance: 'maintenance', minor: 'degraded',
  major: 'partial_outage', critical: 'major_outage',
};
const componentStatus: Record<(typeof componentValues)[number], ServiceStatus> = {
  operational: 'operational', under_maintenance: 'maintenance',
  degraded_performance: 'degraded', partial_outage: 'partial_outage',
  major_outage: 'major_outage',
};

function worse(a: ServiceStatus, b: ServiceStatus): ServiceStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

function incidentState(value: unknown, warnings: string[]): IncidentState {
  const state = enumValue(value, incidentValues, 'incident status');
  if (state === 'verifying') return 'in_progress';
  if (state === 'cancelled' || state === 'postmortem') {
    warnings.push(`Incident lifecycle ${state} has no equivalent public state`);
    return 'unknown';
  }
  return state;
}

function parseIncident(raw: unknown, config: ProviderConfig, now: string, warnings: string[]): SourceIncident {
  const value = object(raw, 'incident');
  const upstreamId = text(value.id, 'incident.id');
  const kind = value.scheduled_for != null || value.scheduled_until != null
    || value.impact === 'maintenance'
    || ['scheduled', 'in_progress', 'verifying', 'completed'].includes(String(value.status))
    ? 'maintenance' : 'incident';
  const state = incidentState(value.status, warnings);
  const sourceSeverity = enumValue(value.impact, [...indicatorValues, 'maintenance'], 'incident impact');
  const severity: SourceIncident['severity'] = sourceSeverity === 'none' ? null
    : sourceSeverity === 'maintenance' ? 'maintenance'
      : sourceSeverity === 'major' || sourceSeverity === 'critical' ? 'major_outage'
        : 'degraded';
  const created = iso(value.created_at, 'incident.created_at');
  const started = optionalIso(value.started_at, 'incident.started_at');
  const resolved = optionalIso(value.resolved_at, 'incident.resolved_at');
  const updated = iso(value.updated_at, 'incident.updated_at');
  const startAt = started ?? created;
  const rawComponents = value.components == null ? [] : list(value.components, 'incident.components');
  const affectedComponentIds = rawComponents.map((entry) => `${config.id}:${text(object(entry, 'incident.component').id, 'incident.component.id')}`);
  const rawUpdates = value.incident_updates == null ? [] : list(value.incident_updates, 'incident.incident_updates');
  const updates = rawUpdates.map((entry) => {
    const update = object(entry, 'incident update');
    return {
      id: text(update.id, 'incident update.id'),
      phase: incidentState(update.status, warnings),
      body: typeof update.body === 'string' ? update.body : '',
      timestamp: iso(update.display_at ?? update.created_at, 'incident update timestamp'),
    };
  });
  const sourceUrl = typeof value.shortlink === 'string' && /^https:\/\//.test(value.shortlink)
    ? value.shortlink : config.officialStatusUrl;
  const postmortemUrl = typeof value.postmortem_url === 'string' && /^https:\/\//.test(value.postmortem_url)
    ? value.postmortem_url : null;
  return {
    sourceIdentity: `${config.id}:${upstreamId}`, providerId: config.id, upstreamId,
    kind, title: text(value.name, 'incident.name'), severity, sourceSeverity,
    severityBasis: severity === null ? 'unknown' : 'source',
    state, origin: 'official', isSynthetic: false,
    affectedComponentIds, affectedRegions: [],
    startedAt: startAt, startTimeBasis: started ? 'source_started_at' : 'source_created_at',
    resolvedAt: resolved, resolvedTimeBasis: resolved ? 'source' : null,
    lastObservedAt: now, updatedAt: updated,
    durationMinutes: resolved ? Math.max(0, (Date.parse(resolved) - Date.parse(startAt)) / 60_000) : null,
    sourceUrl, postmortemUrl, updates,
  };
}

export function parseStatuspage(
  config: ProviderConfig, currentPayload: unknown, activePayload: unknown,
  historyPayload: unknown, now: string,
): AdapterResult {
  const current = object(currentPayload, 'summary');
  const root = object(current.status, 'summary.status');
  const sourceStatus = indicatorStatus[enumValue(root.indicator, indicatorValues, 'summary.status.indicator')];
  const page = object(current.page, 'summary.page');
  const sourceUpdatedAt = optionalIso(page.updated_at, 'summary.page.updated_at');
  const warnings: string[] = [];
  const rawComponents = list(current.components, 'summary.components');
  const allComponents = rawComponents.map((raw): Component & { group: boolean } => {
    const component = object(raw, 'component');
    const upstreamId = text(component.id, 'component.id');
    const status = componentStatus[enumValue(component.status, componentValues, 'component.status')];
    const name = text(component.name, 'component.name');
    const declaredGroup = config.adapter.componentGroups.find((group) =>
      group.upstreamIds.includes(upstreamId) || group.namePatterns.some((pattern) => {
        try { return new RegExp(pattern, 'i').test(name); } catch { throw new AdapterError('invalid_payload', `Invalid group pattern: ${pattern}`); }
      }));
    return {
      id: `${config.id}:${upstreamId}`, upstreamId,
      groupId: declaredGroup ? `${config.id}:${declaredGroup.id}`
        : typeof component.group_id === 'string' ? `${config.id}:${component.group_id}` : null,
      name, aliases: [], region: null, reportedStatus: status, group: component.group === true,
    };
  });
  if (new Set(allComponents.map(({ id }) => id)).size !== allComponents.length) {
    throw new AdapterError('invalid_payload', 'Duplicate component source ID');
  }
  const excluded = new Set(config.adapter.componentDisplay?.excludeIds ?? []);
  const components = allComponents.filter((component) => !excluded.has(component.upstreamId!));
  const allCurrent = activePayload == null
    ? current.incidents
    : object(activePayload, 'active').incidents;
  if (allCurrent === undefined) {
    throw new AdapterError('coverage_incomplete', 'Current incident coverage is unavailable');
  }
  const activeRows = list(allCurrent, 'active.incidents');
  const currentIncidents = activeRows.map((entry) => parseIncident(entry, config, now, warnings));
  let historical: SourceIncident[] = [];
  let historyError: FailureReason | null = null;
  if (historyPayload != null) {
    try {
      historical = list(object(historyPayload, 'history').incidents, 'history.incidents')
        .map((entry) => parseIncident(entry, config, now, warnings));
    } catch (error) {
      if (!(error instanceof AdapterError)) throw error;
      historyError = error.reason;
      warnings.push(`Historical backfill invalid (${error.reason})`);
    }
  }
  const incidentMap = new Map(historical.map((incident) => [incident.sourceIdentity, incident]));
  for (const incident of currentIncidents) incidentMap.set(incident.sourceIdentity, incident);
  let reportedStatus = sourceStatus;
  for (const component of allComponents) {
    if (component.reportedStatus && !excluded.has(component.upstreamId!)) {
      reportedStatus = worse(reportedStatus, component.reportedStatus);
    }
  }
  for (const [index, incident] of currentIncidents.entries()) {
    if (incident.state === 'resolved' || incident.state === 'completed') continue;
    if (incident.kind === 'maintenance' && incident.state === 'scheduled') {
      const scheduledFor = object(activeRows[index], 'active incident').scheduled_for;
      if (scheduledFor != null && Date.parse(iso(scheduledFor, 'incident.scheduled_for')) > Date.parse(now)) continue;
    }
    if (incident.severity) reportedStatus = worse(reportedStatus, incident.severity);
  }
  if (reportedStatus !== sourceStatus) {
    warnings.push(`Aggregate ${sourceStatus} is less severe than current component or incident evidence (${reportedStatus})`);
  }
  const earliest = historical.length
    ? historical.reduce((first, incident) => incident.startedAt < first ? incident.startedAt : first, historical[0]!.startedAt)
    : null;
  return {
    providerId: config.id, reportedStatus,
    components: components.map((component) => ({
      id: component.id,
      upstreamId: component.upstreamId,
      groupId: component.groupId,
      name: component.name,
      aliases: component.aliases,
      region: component.region,
      reportedStatus: component.reportedStatus,
      displayCollapsed: Boolean(
        config.adapter.componentDisplay?.collapseOperational
        && component.reportedStatus === 'operational' && !component.group,
      ),
    })),
    incidents: [...incidentMap.values()],
    coverage: {
      basis: 'official_public', regions: config.adapter.requiredRegions,
      componentScope: excluded.size ? 'filtered' : 'full',
      currentState: 'complete', history: historyPayload == null || historyError ? 'none' : 'native',
      observedSince: null, nativeHistoryEarliestAt: earliest,
      limitation: historyPayload == null || historyError ? 'Historical backfill unavailable' : 'Historical endpoint returns a finite recent window',
    },
    sourceUpdatedAt,
    evidence: {
      requiredChecks: [
        { name: 'summary', passed: true, checkedAt: now },
        { name: 'active_incidents', passed: true, checkedAt: now },
      ],
      historyCompleteThrough: null, historyError, warnings,
      currentIncidentIds: currentIncidents.map(({ sourceIdentity }) => sourceIdentity),
    },
  };
}

export const statuspageAdapter: Adapter = {
  async collect(config: ProviderConfig, context: AdapterContext): Promise<AdapterResult> {
    const summaryUrl = config.adapter.endpoints.summary;
    if (!summaryUrl) throw new AdapterError('coverage_incomplete', 'Summary endpoint is not configured');
    const summary = await context.http.getJson(summaryUrl, context.signal);
    let active: unknown = null;
    if (config.adapter.endpoints.active) {
      try {
        active = await context.http.getJson(config.adapter.endpoints.active, context.signal);
      } catch (error) {
        throw new AdapterError('coverage_incomplete', 'Independent active incident endpoint unavailable', { cause: error });
      }
    }
    let history: unknown = null;
    let historyError: FailureReason | null = null;
    if (config.adapter.endpoints.incidents) {
      try {
        history = await context.http.getJson(config.adapter.endpoints.incidents, context.signal);
      } catch (error) {
        historyError = error instanceof TransportError ? error.kind === 'cancelled' ? 'timeout' : error.kind : 'invalid_payload';
      }
    }
    const result = parseStatuspage(config, summary, active, history, context.now);
    if (historyError) {
      result.evidence.historyError = historyError;
      result.evidence.warnings.push(`Historical backfill unavailable (${historyError})`);
    }
    return result;
  },
};
