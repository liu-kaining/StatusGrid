import { createHash } from 'node:crypto';
import type { Adapter, AdapterResult, Component, ProviderConfig, ServiceStatus } from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
import { coverage, epoch, incident, known, record, result, rows, text, worse } from './common.js';

const eventStatuses = ['resolved', 'ongoing'] as const;
const impactTypes = ['Outage', 'Issue', 'Maintenance'] as const;
const impact: Record<(typeof impactTypes)[number], Exclude<ServiceStatus, 'operational'>> = {
  Outage: 'major_outage', Issue: 'degraded', Maintenance: 'maintenance',
};
function payload(input: string): unknown {
  const stripped = input.trim();
  const wrapper = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(stripped);
  try { return JSON.parse(wrapper ? wrapper[2]! : stripped) as unknown; }
  catch { throw new AdapterError('invalid_payload', 'Apple data is neither JSON nor a valid JSONP wrapper'); }
}

export function parseApple(config: ProviderConfig, input: string, now: string): AdapterResult {
  const root = record(payload(input), 'Apple response');
  const services = rows(root.services, 'Apple services');
  if (!services.length) throw new AdapterError('coverage_incomplete', 'Apple service directory empty');
  const names = services.map((raw) => text(record(raw, 'Apple service').serviceName, 'Apple service name'));
  if (new Set(names).size !== names.length) {
    throw new AdapterError('coverage_incomplete', 'Apple service names are not uniquely identifiable');
  }
  const components: Component[] = [];
  const incidents: AdapterResult['incidents'] = [];
  let reportedStatus: ServiceStatus = 'operational';
  const activeIds: string[] = [];
  services.forEach((raw) => {
    const service = record(raw, 'Apple service');
    const name = text(service.serviceName, 'Apple service name');
    const componentId = `${config.id}:service-${createHash('sha256').update(name).digest('hex').slice(0, 20)}`;
    let componentStatus: ServiceStatus = 'operational';
    const events = rows(service.events, 'Apple service events');
    for (const rawEvent of events) {
      const event = record(rawEvent, 'Apple event');
      const id = text(event.messageId, 'Apple event ID');
      const type = known(event.statusType, impactTypes, 'Apple impact type');
      const ended = event.epochEndDate == null ? null : epoch(event.epochEndDate, 'Apple event end');
      const lifecycle = known(event.eventStatus, eventStatuses, 'Apple event status');
      if ((lifecycle === 'resolved') !== Boolean(ended)) {
        throw new AdapterError('coverage_incomplete', 'Apple event lifecycle and end time disagree');
      }
      const started = epoch(event.epochStartDate, 'Apple event start');
      const title = typeof event.message === 'string' && event.message.trim() ? event.message.trim() : `${name} status update`;
      incidents.push(incident(config, now, id, title, started, ended ?? started, {
        state: lifecycle === 'resolved' ? 'resolved' : 'investigating', severity: impact[type],
        sourceSeverity: type, severityBasis: 'source',
        kind: type === 'Maintenance' ? 'maintenance' : 'incident',
        resolvedAt: ended, updatedAt: ended ?? started, affectedComponentIds: [componentId],
      }));
      if (lifecycle !== 'resolved') {
        activeIds.push(`${config.id}:${id}`);
        componentStatus = worse(componentStatus, impact[type]);
        reportedStatus = worse(reportedStatus, impact[type]);
      }
    }
    components.push({
      id: componentId, upstreamId: null, groupId: null, name, aliases: [],
      region: 'cn', reportedStatus: componentStatus,
    });
  });
  if (new Set(incidents.map(({ sourceIdentity }) => sourceIdentity)).size !== incidents.length) {
    throw new AdapterError('coverage_incomplete', 'Apple event IDs are not unique');
  }
  const earliest = incidents.reduce<string | null>((min, entry) => min === null || entry.startedAt < min ? entry.startedAt : min, null);
  const output = result(config, now, reportedStatus, ['current_services', 'service_events'],
    { ...coverage(config, 'full', 'native', 'Apple data supplies events for listed services; no guaranteed full history window'),
      nativeHistoryEarliestAt: earliest },
    { components, incidents });
  output.evidence.currentIncidentIds = activeIds;
  return output;
}

export const appleAdapter: Adapter = {
  async collect(config, context) {
    const url = config.adapter.endpoints.current;
    if (!url) throw new AdapterError('coverage_incomplete', 'Apple current endpoint missing');
    return parseApple(config, await context.http.getText(url, context.signal), context.now);
  },
};
