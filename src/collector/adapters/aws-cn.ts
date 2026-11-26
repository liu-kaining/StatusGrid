import type { Adapter, AdapterResult, Component, ProviderConfig, SourceIncident } from '../../shared/contracts.js';
import { AdapterError, TransportError } from '../errors.js';
import { coverage, epoch, incident, record, rows, text, worse } from './common.js';
import type { ServiceStatus } from '../../shared/contracts.js';

export function parseAwsChina(config: ProviderConfig, payload: unknown, now: string,
  catalogPayload?: unknown, historyPayload?: unknown): AdapterResult {
  const events = rows(payload, 'AWS China current events');
  const serviceRows = catalogPayload === undefined ? null : rows(catalogPayload, 'AWS China service catalog');
  if (serviceRows) {
    const catalogRegions = new Set(serviceRows.map((raw) => record(raw, 'AWS China service').region_id)
      .filter((value): value is string => typeof value === 'string'));
    if (!config.adapter.requiredRegions.every((region) => catalogRegions.has(region))) {
      throw new AdapterError('coverage_incomplete', 'AWS China catalog does not cover required regions');
    }
  }
  const componentsById = new Map<string, Component>();
  for (const rawService of serviceRows ?? []) {
    const service = record(rawService, 'AWS China catalog service');
    const upstreamId = text(service.service, 'AWS China catalog service identity');
    const component: Component = {
      id: `${config.id}:${upstreamId}`, upstreamId, name: text(service.service_name, 'AWS China catalog service name'),
      region: text(service.region_id, 'AWS China catalog region'), groupId: null, aliases: [], reportedStatus: null,
    };
    const previous = componentsById.get(component.id);
    if (previous && (previous.name !== component.name || previous.region !== component.region)) {
      throw new AdapterError('coverage_incomplete', 'AWS China catalog service identity conflicts');
    }
    componentsById.set(component.id, component);
  }
  let reportedStatus: ServiceStatus = 'operational';
  const currentIds: string[] = [];
  const currentKeys = new Set(events.map((raw) => {
    const event = record(raw, 'AWS China current event');
    return JSON.stringify([event.service, event.region, event.startTime, event.typeCode]);
  }));
  const parseEvent = (raw: unknown, index: number): SourceIncident => {
    const event = record(raw, 'AWS China event');
    const service = text(event.service, 'AWS China service');
    const region = text(event.region, 'AWS China region');
    const typeCode = text(event.typeCode, 'AWS China typeCode');
    const catalogMatch = serviceRows?.some((rawService) => {
      const entry = record(rawService, 'AWS China catalog service');
      const key = typeof entry.service === 'string' ? entry.service : '';
      return entry.region_id === region && entry.event_type_code === typeCode
        && key.replace(/[^a-z0-9]/gi, '').toLowerCase()
          === `${service}${region}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
    });
    if (serviceRows ? !catalogMatch
      : service !== 'MULTIPLE_SERVICES' || region !== 'cn-north-1' || typeCode !== 'AWS_MULTIPLE_SERVICES_OPERATIONAL_ISSUE') {
      throw new AdapterError('coverage_incomplete', 'AWS China event/region enum not present in observed source');
    }
    const start = event.startTime;
    const end = event.endTime;
    const updated = event.lastUpdatedTime;
    if (typeof start !== 'number' || typeof updated !== 'number'
      || (end != null && typeof end !== 'number')) {
      throw new AdapterError('invalid_payload', 'AWS China event timestamps missing');
    }
    const startedAt = epoch(start, 'AWS China start');
    const updatedAt = epoch(updated, 'AWS China updated');
    const resolvedAt = end == null ? null : epoch(end, 'AWS China end');
    const metadata = record(event.metadata, 'AWS China metadata');
    let eventLog: unknown;
    try { eventLog = JSON.parse(text(metadata.EVENT_LOG, 'AWS China EVENT_LOG')) as unknown; }
    catch { throw new AdapterError('invalid_payload', 'AWS China EVENT_LOG malformed'); }
    const updates = rows(eventLog, 'AWS China EVENT_LOG').map((rawUpdate, updateIndex) => {
      const update = record(rawUpdate, 'AWS China event update');
      if (![0, 1, 2, 3].includes(update.status as number)) {
        throw new AdapterError('unknown_status', `AWS China event update status: ${String(update.status)}`);
      }
      const seconds = update.timestamp;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        throw new AdapterError('invalid_payload', 'AWS China update timestamp missing');
      }
      return {
        id: `${service}:${region}:${start}:${updateIndex}`,
        phase: update.status === 0 ? 'resolved' as const : 'unknown' as const,
        body: update.message == null ? '' : text(update.message, 'AWS China update message'),
        timestamp: epoch(seconds * 1000, 'AWS China update time'),
        summary: text(update.summary, 'AWS China update summary'),
        status: update.status as number,
      };
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (!updates.length) throw new AdapterError('coverage_incomplete', 'AWS China event has no update log');
    const id = `${service}:${region}:${start}:${typeCode}`;
    const latest = updates[updates.length - 1]!.status;
    if (resolvedAt && latest !== 0) {
      throw new AdapterError('coverage_incomplete', 'AWS China endTime conflicts with latest update lifecycle');
    }
    const resolved = resolvedAt !== null || latest === 0;
    if (index < events.length && !resolved) {
      currentIds.push(`${config.id}:${id}`);
      if (latest === 1) {
        throw new AdapterError('coverage_incomplete', 'AWS China informational/active lifecycle does not establish outage severity');
      }
      if (latest === 2) reportedStatus = worse(reportedStatus, 'degraded');
      if (latest === 3) reportedStatus = worse(reportedStatus, 'partial_outage');
    }
    return incident(config, now, id, updates[0]!.summary, startedAt, updatedAt, {
      state: resolved ? 'resolved' : 'investigating',
      resolvedAt, affectedRegions: [region],
      affectedComponentIds: [...componentsById.values()].filter((component) =>
        component.region === region && component.upstreamId!.replace(/[^a-z0-9]/gi, '').toLowerCase()
          === `${service}${region}`.replace(/[^a-z0-9]/gi, '').toLowerCase()).map(({ id }) => id),
      severity: index < events.length && !resolved && latest === 2 ? 'degraded'
        : index < events.length && !resolved && latest === 3 ? 'partial_outage' : null,
      sourceSeverity: typeCode, severityBasis: 'unknown',
      updates: updates.map(({ id: updateId, phase, body, timestamp: time }) =>
        ({ id: updateId, phase, body, timestamp: time })),
    });
  };
  const parsed = events.map(parseEvent);
  let historical: SourceIncident[] = [];
  let historyError: AdapterResult['evidence']['historyError'] = null;
  try {
    const sourceHistory = (historyPayload == null ? [] : rows(historyPayload, 'AWS China history events'))
      .filter((raw) => {
        const event = record(raw, 'AWS China historical event');
        return !currentKeys.has(JSON.stringify([event.service, event.region, event.startTime, event.typeCode]));
      });
    historical = sourceHistory.map((raw, index) => parseEvent(raw, events.length + index));
  } catch (error) {
    historyError = error instanceof AdapterError ? error.reason : 'invalid_payload';
  }
  return {
    providerId: config.id, reportedStatus: serviceRows ? reportedStatus : null, components: [...componentsById.values()],
    incidents: [...new Map([...historical, ...parsed].map((entry) => [entry.sourceIdentity, entry])).values()],
    coverage: {
      ...coverage(config, 'events_only', historyPayload == null || historyError ? 'none' : 'native',
        'AWS China public events; service catalog verifies China-region scope, finite history not exhaustive'),
      currentState: serviceRows ? 'complete' : 'partial',
      nativeHistoryEarliestAt: historical.reduce<string | null>((min, entry) =>
        min === null || entry.startedAt < min ? entry.startedAt : min, null),
    },
    sourceUpdatedAt: null,
    evidence: {
      requiredChecks: [
        { name: 'currentevents_shape', passed: true, checkedAt: now },
        ...(serviceRows ? [{ name: 'services_region_catalog', passed: true, checkedAt: now }] : []),
      ],
      historyCompleteThrough: null, historyError, currentIncidentIds: currentIds, warnings: [
        'Only cn-north-1/MULTIPLE_SERVICES event form sampled; unrecognized shapes fail closed',
      ],
    },
  };
}

export const awsChinaAdapter: Adapter = {
  async collect(config, context) {
    const url = config.adapter.endpoints.current;
    const catalogUrl = config.adapter.endpoints.services;
    if (!url || !catalogUrl) throw new AdapterError('coverage_incomplete', 'AWS China currentevents or catalog endpoint missing');
    const [current, services] = await Promise.all([
      context.http.getJson(url, context.signal), context.http.getJson(catalogUrl, context.signal),
    ]);
    let history: unknown = null;
    let historyError: AdapterResult['evidence']['historyError'] = null;
    if (config.adapter.endpoints.events) {
      try { history = await context.http.getJson(config.adapter.endpoints.events, context.signal); }
      catch (error) {
        historyError = error instanceof TransportError ? error.kind === 'cancelled' ? 'timeout' : error.kind : 'invalid_payload';
      }
    }
    const output = parseAwsChina(config, current, context.now, services, history);
    output.evidence.historyError ??= historyError;
    return output;
  },
};
