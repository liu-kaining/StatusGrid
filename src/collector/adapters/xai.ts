import type {
  Adapter, AdapterResult, Component, FailureReason, IncidentState, ProviderConfig, ServiceStatus, SourceIncident,
} from '../../shared/contracts.js';
import { AdapterError, TransportError } from '../errors.js';
import { coverage, incident, known, record, result, rows, text, timestamp, worse } from './common.js';
import { requireCoverage } from './regional.js';

function serviceStatus(raw: unknown): ServiceStatus | null {
  const value = known(raw, ['available', 'degraded', 'unavailable', 'maintenance', 'info'], 'xAI service status');
  // "info" is an informational marker, not an upstream service-impact severity.
  return value === 'available' ? 'operational' : value === 'unavailable' ? 'major_outage'
    : value === 'info' ? null : value;
}

function lifecycle(raw: unknown): IncidentState {
  return known(raw, ['investigating', 'identified', 'monitoring', 'resolved'], 'xAI incident status');
}

function sourceIncident(config: ProviderConfig, raw: unknown, now: string): SourceIncident {
  const entry = record(raw, 'xAI incident');
  const id = text(entry.id, 'xAI incident id');
  const state = lifecycle(entry.status);
  const impact = known(entry.impact, ['none', 'minor', 'major', 'critical'], 'xAI incident impact');
  const severity = impact === 'none' ? null : impact === 'minor' ? 'degraded' : 'major_outage';
  const startedAt = timestamp(entry.started_at, 'xAI incident started_at');
  const updatedAt = timestamp(entry.updated_at, 'xAI incident updated_at');
  const resolvedAt = entry.resolved_at == null ? null : timestamp(entry.resolved_at, 'xAI incident resolved_at');
  if (updatedAt < startedAt || (resolvedAt && resolvedAt < startedAt)) {
    throw new AdapterError('invalid_payload', 'xAI incident source timestamps are reversed');
  }
  requireCoverage(state === 'resolved' ? resolvedAt !== null : resolvedAt === null,
    'xAI lifecycle and source closure disagree');
  const affectedComponentIds = rows(entry.components, 'xAI incident components').map((rawComponent) => {
    const component = record(rawComponent, 'xAI incident component');
    return `${config.id}:${text(component.id, 'xAI incident component id')}`;
  });
  requireCoverage(new Set(affectedComponentIds).size === affectedComponentIds.length, 'xAI incident component IDs duplicated');
  const updates = rows(entry.updates, 'xAI incident updates').map((rawUpdate) => {
    const update = record(rawUpdate, 'xAI incident update');
    if (typeof update.body !== 'string') throw new AdapterError('invalid_payload', 'xAI incident update body missing');
    return {
      id: text(update.id, 'xAI update id'), phase: lifecycle(update.status),
      body: update.body, timestamp: timestamp(update.created_at, 'xAI update created_at'),
    };
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  requireCoverage(updates.length && new Set(updates.map(({ id: updateId }) => updateId)).size === updates.length,
    'xAI incident updates empty or duplicated');
  if (updates.some(({ timestamp: at }) => at < startedAt || at > updatedAt)) {
    throw new AdapterError('invalid_payload', 'xAI update is outside source incident timestamps');
  }
  const rawUrl = text(entry.url, 'xAI incident URL');
  let sourceUrl: URL;
  try { sourceUrl = new URL(rawUrl); }
  catch { throw new AdapterError('invalid_payload', 'xAI incident URL invalid'); }
  requireCoverage(sourceUrl.origin === new URL(config.officialStatusUrl).origin,
    'xAI incident URL belongs to another source');
  return incident(config, now, id, text(entry.title, 'xAI incident title'), startedAt, updatedAt, {
    kind: impact === 'none' ? 'advisory' : 'incident', state,
    severity, sourceSeverity: impact, severityBasis: severity ? 'source' : 'unknown',
    affectedComponentIds, resolvedAt, sourceUrl: sourceUrl.href, updates,
  });
}

function sourceIncidents(config: ProviderConfig, raw: unknown, now: string): SourceIncident[] {
  const incidents = rows(record(raw, 'xAI incident response').incidents, 'xAI incidents')
    .map((entry) => sourceIncident(config, entry, now));
  requireCoverage(new Set(incidents.map(({ sourceIdentity }) => sourceIdentity)).size === incidents.length,
    'xAI incident IDs duplicated');
  return incidents;
}

export function parseXai(
  config: ProviderConfig, currentPayload: unknown, activePayload: unknown,
  historyPayload: unknown, now: string,
): AdapterResult {
  const current = record(currentPayload, 'xAI status response');
  const sourceUpdatedAt = timestamp(current.updated_at, 'xAI status updated_at');
  const sourceStatus = serviceStatus(record(current.overall, 'xAI overall').status);
  requireCoverage(sourceStatus !== null, 'xAI aggregate does not report service availability');
  let reportedStatus = sourceStatus;
  const products = rows(current.products, 'xAI products');
  requireCoverage(products.length, 'xAI product directory is empty');
  const productIds = new Set<string>();
  const components: Component[] = [];
  let informational = 0;
  for (const rawProduct of products) {
    const product = record(rawProduct, 'xAI product');
    const id = text(product.id, 'xAI product id');
    text(product.name, 'xAI product name');
    requireCoverage(!productIds.has(id), 'xAI product IDs duplicated');
    productIds.add(id);
    const productStatus = serviceStatus(product.status);
    if (productStatus) reportedStatus = worse(reportedStatus, productStatus);
    const productComponents = rows(product.components, 'xAI product components');
    requireCoverage(productComponents.length, 'xAI product component directory is empty');
    for (const rawComponent of productComponents) {
      const component = record(rawComponent, 'xAI component');
      const upstreamId = text(component.id, 'xAI component id');
      const componentStatus = serviceStatus(component.status);
      if (componentStatus) reportedStatus = worse(reportedStatus, componentStatus);
      else informational++;
      components.push({
        id: `${config.id}:${upstreamId}`, upstreamId, groupId: `${config.id}:${id}`,
        name: text(component.name, 'xAI component name'), aliases: [], region: null,
        reportedStatus: componentStatus,
      });
    }
  }
  requireCoverage(new Set(components.map(({ id }) => id)).size === components.length, 'xAI component IDs duplicated');
  const componentIds = new Set(components.map(({ id }) => id));
  const active = sourceIncidents(config, activePayload, now);
  for (const entry of active) {
    requireCoverage(entry.state !== 'resolved', 'xAI current list contains a resolved incident');
    requireCoverage(entry.affectedComponentIds.length && entry.affectedComponentIds.every((id) => componentIds.has(id)),
      'xAI active incident component coverage missing');
    if (entry.severity) reportedStatus = worse(reportedStatus, entry.severity);
  }
  let history: SourceIncident[] = [];
  let historyError: FailureReason | null = null;
  const warnings: string[] = [];
  if (historyPayload != null) {
    try {
      const parsed = sourceIncidents(config, historyPayload, now);
      requireCoverage(parsed.every(({ state }) => state === 'resolved'), 'xAI resolved history contains an active incident');
      history = parsed;
    } catch (error) {
      if (!(error instanceof AdapterError)) throw error;
      historyError = error.reason;
      warnings.push(`xAI native history invalid (${error.reason})`);
    }
  }
  if (informational) warnings.push(`${informational} xAI components use info without a service-impact severity; component status is unspecified`);
  if (reportedStatus !== sourceStatus) warnings.push(`xAI aggregate ${sourceStatus} is less severe than component/incident evidence (${reportedStatus})`);
  const incidents = new Map(history.map((entry) => [entry.sourceIdentity, entry]));
  for (const entry of active) incidents.set(entry.sourceIdentity, entry);
  const nativeHistory = historyPayload != null && historyError === null;
  return result(config, now, reportedStatus, ['status_directory', 'active_incidents'],
    {
      ...coverage(config, 'full', nativeHistory ? 'native' : 'none',
        nativeHistory ? 'Official resolved endpoint provides a finite recent window; info components have no service severity'
          : 'Native history unavailable; info components have no service severity'),
      nativeHistoryEarliestAt: history.reduce<string | null>((earliest, entry) =>
        earliest === null || entry.startedAt < earliest ? entry.startedAt : earliest, null),
    }, {
      components, incidents: [...incidents.values()], sourceUpdatedAt,
      evidence: {
        requiredChecks: ['status_directory', 'active_incidents'].map((name) => ({ name, passed: true, checkedAt: now })),
        historyCompleteThrough: null, historyError,
        currentIncidentIds: active.map(({ sourceIdentity }) => sourceIdentity), warnings,
      },
    });
}

export const xaiAdapter: Adapter = {
  async collect(config, context) {
    const { status, active, history } = config.adapter.endpoints;
    requireCoverage(status && active, 'xAI status and active incident endpoints required');
    const [currentPayload, activePayload] = await Promise.all([
      context.http.getJson(status, context.signal),
      context.http.getJson(active, context.signal),
    ]);
    let historyPayload: unknown = null;
    let historyError: FailureReason | null = null;
    if (history) {
      try { historyPayload = await context.http.getJson(history, context.signal); }
      catch (error) {
        historyError = error instanceof TransportError
          ? error.kind === 'cancelled' ? 'timeout' : error.kind
          : error instanceof AdapterError ? error.reason : 'invalid_payload';
      }
    }
    const parsed = parseXai(config, currentPayload, activePayload, historyPayload, context.now);
    if (historyError) {
      parsed.evidence.historyError = historyError;
      parsed.evidence.warnings.push(`xAI native history unavailable (${historyError})`);
    }
    return parsed;
  },
};
