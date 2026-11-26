import type { Adapter, AdapterResult, ProviderConfig } from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
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
  let reportedStatus: ServiceStatus = 'operational';
  const currentIds: string[] = [];
  const sourceHistory = historyPayload == null ? [] : rows(historyPayload, 'AWS China history events');
  const parsed = [...events, ...sourceHistory].map((raw, index) => {
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
    });
    if (!updates.length) throw new AdapterError('coverage_incomplete', 'AWS China event has no update log');
    const id = `${service}:${region}:${start}:${typeCode}`;
    if (index < events.length && !resolvedAt) {
      currentIds.push(`${config.id}:${id}`);
      const current = updates[updates.length - 1]!.status;
      if (current === 1 || current === 0) {
        throw new AdapterError('coverage_incomplete', 'AWS China informational/active lifecycle does not establish outage severity');
      }
      if (current === 2) reportedStatus = worse(reportedStatus, 'degraded');
      if (current === 3) reportedStatus = worse(reportedStatus, 'partial_outage');
    }
    return incident(config, now, id, updates[0]!.summary, startedAt, updatedAt, {
      state: resolvedAt ? 'resolved' : 'investigating',
      resolvedAt, affectedRegions: [region],
      severity: index < events.length && !resolvedAt && updates.at(-1)!.status === 2 ? 'degraded'
        : index < events.length && !resolvedAt && updates.at(-1)!.status === 3 ? 'partial_outage' : null,
      sourceSeverity: typeCode, severityBasis: 'unknown',
      updates: updates.map(({ id: updateId, phase, body, timestamp: time }) =>
        ({ id: updateId, phase, body, timestamp: time })),
    });
  });
  return {
    providerId: config.id, reportedStatus: serviceRows ? reportedStatus : null, components: [],
    incidents: [...new Map(parsed.map((entry) => [entry.sourceIdentity, entry])).values()],
    coverage: {
      ...coverage(config, 'events_only', historyPayload == null ? 'none' : 'native',
        'AWS China public events; service catalog verifies China-region scope, finite history not exhaustive'),
      currentState: serviceRows ? 'complete' : 'partial',
      nativeHistoryEarliestAt: sourceHistory.length
        ? parsed.reduce<string | null>((min, entry) => min === null || entry.startedAt < min ? entry.startedAt : min, null) : null,
    },
    sourceUpdatedAt: null,
    evidence: {
      requiredChecks: [
        { name: 'currentevents_shape', passed: true, checkedAt: now },
        ...(serviceRows ? [{ name: 'services_region_catalog', passed: true, checkedAt: now }] : []),
      ],
      historyCompleteThrough: null, currentIncidentIds: currentIds, warnings: [
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
    if (config.adapter.endpoints.events) {
      try { history = await context.http.getJson(config.adapter.endpoints.events, context.signal); }
      catch { /* Historical window is optional after current and catalog are verified. */ }
    }
    return parseAwsChina(config, current, context.now, services, history);
  },
};
