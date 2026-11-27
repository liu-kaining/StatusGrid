import type {
  Adapter, AdapterResult, Component, FailureReason, ProviderConfig, ServiceStatus, SourceIncident,
} from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
import { incident, known, record, rows, text, worse } from './common.js';

// Official public directory and names from status.opencode.ai/view.js.
const services: Record<string, { name: string; group: string }> = {
  console: { name: 'Console API', group: 'console' },
  logs: { name: 'Request logs', group: 'console' },
  inference: { name: 'Inference API', group: 'inference' },
  go: { name: 'Go', group: 'inference' },
  payg: { name: 'Pay-as-you-go', group: 'inference' },
  free: { name: 'Free inference', group: 'inference' },
};
const statuses = ['operational', 'degraded', 'outage', 'unknown'] as const;
const reasons = ['none', 'errors', 'upstream', 'latency', 'availability'] as const;

function millis(raw: unknown, label: string): string {
  if (typeof raw !== 'number' || raw <= 0 || !Number.isFinite(raw)
    || !Number.isFinite(new Date(raw).getTime())) {
    throw new AdapterError('invalid_payload', `${label} must be an epoch in milliseconds`);
  }
  return new Date(raw).toISOString();
}

function status(raw: unknown, label: string): ServiceStatus {
  const value = known(raw, statuses, label);
  if (value === 'unknown') throw new AdapterError('coverage_incomplete', `${label} has no monitoring data`);
  return value === 'outage' ? 'major_outage' : value;
}

function serviceName(id: string): string {
  return Object.hasOwn(services, id) ? services[id]!.name : id;
}

function eventTitle(reason: string, severity: ServiceStatus): string {
  if (reason === 'upstream') return 'Upstream provider issues';
  if (reason === 'latency') return 'Slow responses';
  if (reason === 'availability') return severity === 'major_outage' ? 'Service unavailable' : 'Intermittent availability';
  return severity === 'major_outage' ? 'Most requests failing' : 'Elevated error rates';
}

function parseIncident(
  config: ProviderConfig, raw: unknown, notes: unknown[], components: Map<string, Component>,
  now: string,
): SourceIncident {
  const row = record(raw, 'incident');
  const upstreamId = text(row.id, 'incident.id');
  const eventId = text(row.event, 'incident.event');
  const service = text(row.service, 'incident.service');
  const startedAt = millis(row.startedAt, 'incident.startedAt');
  const resolvedAt = row.resolvedAt === null ? null : millis(row.resolvedAt, 'incident.resolvedAt');
  if (resolvedAt && resolvedAt < startedAt) {
    throw new AdapterError('invalid_payload', 'Incident resolution precedes source start');
  }
  const severity = status(row.status, 'incident.status');
  if (severity === 'operational') throw new AdapterError('invalid_payload', 'Incident has no source impact');
  const reason = known(row.reason, reasons, 'incident.reason');
  if (!resolvedAt && !components.has(service)) {
    throw new AdapterError('coverage_incomplete', `Active incident references an unavailable service: ${service}`);
  }
  const state = resolvedAt ? 'resolved'
    : components.get(service)?.reportedStatus === 'operational' ? 'monitoring' : 'in_progress';
  const matchingNotes = notes.map(value => record(value, 'note'))
    .filter(note => text(note.event, 'note.event') === eventId);
  const updates = matchingNotes.map((note) => {
    return {
      id: text(note.id, 'note.id'), phase: 'unknown' as const,
      body: typeof note.body === 'string' ? note.body : text(note.body, 'note.body'),
      timestamp: millis(note.at, 'note.at'),
    };
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const models = row.models === undefined ? [] : rows(row.models, 'incident.models')
    .map(value => text(record(value, 'incident.model').id, 'incident.model.id'));
  // Native notes have no lifecycle phase. Never invent a closure from a healthy check.
  const updatedAt = [startedAt, resolvedAt, ...updates.map(update => update.timestamp),
    ...matchingNotes.flatMap(note => note.updatedAt == null ? [] : [millis(note.updatedAt, 'note.updatedAt')])]
    .filter((value): value is string => value !== null).sort().at(-1)!;
  return incident(config, now, upstreamId,
    `${eventTitle(reason, severity)} · ${serviceName(service)}${models.length ? ` (${models.join(', ')})` : ''}`,
    startedAt, updatedAt, {
      state, severity, sourceSeverity: String(row.status), severityBasis: 'source',
      affectedComponentIds: [`${config.id}:${service}`],
      sourceUrl: new URL(`#incident-${encodeURIComponent(eventId)}`, config.officialStatusUrl).href,
      resolvedAt, resolvedTimeBasis: resolvedAt ? 'source' : null, updates,
    });
}

export function parseOpenCode(config: ProviderConfig, payload: unknown, now: string): AdapterResult {
  const data = record(payload, 'OpenCode status');
  const sourceUpdatedAt = millis(data.updatedAt, 'updatedAt');
  if (typeof data.stale !== 'boolean') throw new AdapterError('invalid_payload', 'Missing upstream stale flag');
  // Match the official app's freshness window rather than repainting an old API cache as fresh.
  if (data.stale || Date.parse(now) - Date.parse(sourceUpdatedAt) >= 3 * 60_000) {
    throw new AdapterError('overdue', 'OpenCode monitoring snapshot is stale');
  }
  let reportedStatus = status(data.status, 'aggregate status');
  if (!Array.isArray(data.components) || !data.components.length || !Array.isArray(data.incidents)) {
    throw new AdapterError('coverage_incomplete', 'Complete component and incident directories are required');
  }
  const components = new Map<string, Component>();
  for (const raw of data.components) {
    const component = record(raw, 'component');
    const upstreamId = text(component.service, 'component.service');
    if (components.has(upstreamId)) throw new AdapterError('invalid_payload', 'Duplicate component ID');
    let reported = status(component.status, 'component.status');
    // A future API inconsistency must not hide an affected model behind an operational plan.
    if (component.breakdown !== undefined) {
      for (const model of rows(component.breakdown, 'component.breakdown')) {
        reported = worse(reported, status(record(model, 'model').status, 'model.status'));
      }
    }
    reportedStatus = worse(reportedStatus, reported);
    components.set(upstreamId, {
      id: `${config.id}:${upstreamId}`, upstreamId,
      groupId: Object.hasOwn(services, upstreamId) ? `${config.id}:${services[upstreamId]!.group}` : null,
      name: serviceName(upstreamId), aliases: [], region: null, reportedStatus: reported,
    });
  }
  if (Object.keys(services).some(id => !components.has(id))) {
    throw new AdapterError('coverage_incomplete', 'Official OpenCode service directory is incomplete');
  }
  const notes = rows(data.notes, 'notes');
  const incidents: SourceIncident[] = [];
  const identities = new Set<string>();
  const warnings: string[] = [];
  let historyError: FailureReason | null = null;
  for (const raw of data.incidents) {
    const row = record(raw, 'incident');
    // Only rows with explicit native closure can be optional history; a missing closure is invalid current data.
    const historical = typeof row.resolvedAt === 'number' && Number.isFinite(row.resolvedAt);
    try {
      const parsed = parseIncident(config, row, notes, components, now);
      if (identities.has(parsed.sourceIdentity)) throw new AdapterError('invalid_payload', 'Duplicate incident ID');
      identities.add(parsed.sourceIdentity);
      incidents.push(parsed);
    } catch (error) {
      if (!historical || !(error instanceof AdapterError)) throw error;
      historyError = error.reason;
      warnings.push(`Historical incident unavailable (${error.reason})`);
    }
  }
  const historicalStarts = incidents.filter(value => value.resolvedAt).map(value => value.startedAt).sort();
  return {
    providerId: config.id, reportedStatus, components: [...components.values()], incidents,
    sourceUpdatedAt,
    coverage: {
      basis: 'official_public', regions: config.adapter.requiredRegions, componentScope: 'full',
      currentState: 'complete', history: historyError ? 'none' : 'native',
      observedSince: null, nativeHistoryEarliestAt: historicalStarts[0] ?? null,
      limitation: 'Official console and inference services; plan health covers its most-used models. Native incidents are a finite recent window; three-hour history bars are not uptime percentages.',
    },
    evidence: {
      requiredChecks: ['fresh_monitoring_snapshot', 'service_directory', 'current_incidents']
        .map(name => ({ name, passed: true, checkedAt: now })),
      currentIncidentIds: incidents.filter(value => value.resolvedAt === null).map(value => value.sourceIdentity),
      historyCompleteThrough: null, historyError, warnings,
    },
  };
}

export const opencodeAdapter: Adapter = {
  async collect(config, context) {
    const url = config.adapter.endpoints.status;
    if (!url) throw new AdapterError('coverage_incomplete', 'OpenCode status endpoint is missing');
    return parseOpenCode(config, await context.http.getJson(url, context.signal), context.now);
  },
};
