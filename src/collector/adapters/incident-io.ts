import { load } from 'cheerio';
import type { Adapter, AdapterResult, Component, IncidentState, ProviderConfig, ServiceStatus, SourceIncident } from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
import { coverage, incident, known, record, result, rows, text, timestamp, worse } from './common.js';
import { requireCoverage } from './regional.js';

const present = (raw: unknown): boolean => raw !== null && raw !== undefined && raw !== '$undefined';
function nativeStatus(raw: unknown): ServiceStatus {
  const status = known(raw, ['operational', 'degraded_performance', 'partial_outage', 'full_outage', 'under_maintenance'],
    'incident.io component status');
  return status === 'degraded_performance' ? 'degraded' : status === 'under_maintenance' ? 'maintenance'
    : status === 'full_outage' ? 'major_outage' : status;
}
function lifecycle(raw: unknown): IncidentState {
  const state = known(raw, ['investigating', 'identified', 'monitoring', 'resolved',
    'maintenance_scheduled', 'maintenance_in_progress', 'maintenance_complete'],
    'incident.io lifecycle');
  return state === 'maintenance_scheduled' ? 'scheduled' : state === 'maintenance_in_progress' ? 'in_progress'
    : state === 'maintenance_complete' ? 'completed' : state;
}

/** Decode literal Flight data only. Captured script is never evaluated. */
function findSummary(config: ProviderConfig, html: string): Record<string, unknown> {
  const $ = load(html);
  let stream = '';
  $('script').each((_index, element) => {
    const script = $(element).text();
    const pushes = script.matchAll(/(?:^|;)\s*self\.__next_f\.push\(\s*(\[1,\s*"(?:\\.|[^"\\])*"\s*\])\s*\)\s*(?=;|$)/g);
    for (const match of pushes) {
      let literal: unknown;
      try { literal = JSON.parse(match[1]!) as unknown; }
      catch { throw new AdapterError('invalid_payload', 'incident.io Flight literal malformed'); }
      if (Array.isArray(literal) && literal[0] === 1 && typeof literal[1] === 'string') stream += literal[1];
    }
  });
  const summaries: Record<string, unknown>[] = [];
  const visit = (raw: unknown) => {
    if (Array.isArray(raw)) { raw.forEach(visit); return; }
    if (!raw || typeof raw !== 'object') return;
    const node = raw as Record<string, unknown>;
    if ('public_url' in node && 'components' in node && 'id' in node) {
      let url: string | null = null;
      try { url = new URL(String(node.public_url)).href; } catch { /* Not a typed summary. */ }
      if (url === new URL(config.officialStatusUrl).href && node.id === config.adapter.sourcePageId) summaries.push(node);
    }
    Object.values(node).forEach(visit);
  };
  for (const line of stream.split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    let node: unknown;
    try { node = JSON.parse(line.slice(separator + 1)) as unknown; } catch { continue; }
    visit(node);
  }
  requireCoverage(config.adapter.sourcePageId && summaries.length, 'incident.io matching public summary/page identity unavailable');
  requireCoverage(summaries.every((summary) => JSON.stringify(summary) === JSON.stringify(summaries[0])),
    'incident.io current summaries conflict');
  return summaries[0]!;
}

export function parseIncidentIo(config: ProviderConfig, html: string, now: string): AdapterResult {
  const summary = findSummary(config, html);
  const pageId = text(summary.id, 'incident.io page ID');
  requireCoverage(Array.isArray(summary.components) && Array.isArray(summary.affected_components)
    && Array.isArray(summary.ongoing_incidents) && Array.isArray(summary.scheduled_maintenances),
  'incident.io explicit current component/incident/maintenance arrays unavailable');
  const components = rows(summary.components, 'incident.io components').map((raw): Component => {
    const component = record(raw, 'incident.io component');
    const id = text(component.id, 'incident.io component id');
    requireCoverage(component.status_page_id === pageId, 'incident.io component belongs to another page');
    return {
      id: `${config.id}:${id}`, upstreamId: id, name: text(component.name, 'incident.io component name'),
      groupId: null, aliases: [], region: null, reportedStatus: 'operational',
    };
  });
  requireCoverage(components.length && new Set(components.map(({ id }) => id)).size === components.length,
    'incident.io component directory empty or duplicated');
  const byId = new Map(components.map((component) => [component.upstreamId!, component]));
  const structure = record(summary.structure, 'incident.io structure');
  requireCoverage(structure.status_page_id === pageId, 'incident.io structure belongs to another page');
  const grouped = new Set<string>();
  const assignGroup = (raw: unknown, group: string | null) => {
    const id = text(record(raw, 'incident.io structure component').component_id, 'incident.io structure component ID');
    requireCoverage(byId.has(id) && !grouped.has(id), 'incident.io structure component missing or duplicated');
    grouped.add(id);
    byId.get(id)!.groupId = group;
  };
  for (const rawItem of rows(structure.items, 'incident.io structure items')) {
    const item = record(rawItem, 'incident.io structure item');
    if (present(item.group)) {
      const group = record(item.group, 'incident.io group');
      const id = `${config.id}:${text(group.id, 'incident.io group id')}`;
      rows(group.components, 'incident.io grouped components').forEach((entry) => assignGroup(entry, id));
    } else if (present(item.component)) {
      assignGroup(item.component, null);
    } else {
      throw new AdapterError('coverage_incomplete', 'incident.io unsupported structure entry');
    }
  }
  requireCoverage(grouped.size === components.length, 'incident.io structure omits components');
  const topAffected = new Set<string>();
  for (const rawAffected of rows(summary.affected_components, 'incident.io affected_components')) {
    const affected = record(rawAffected, 'incident.io affected component');
    const id = text(affected.component_id, 'incident.io affected component ID');
    requireCoverage(byId.has(id) && !topAffected.has(id), 'incident.io affected component unresolved or duplicated');
    topAffected.add(id);
    byId.get(id)!.reportedStatus = nativeStatus(present(affected.current_status) ? affected.current_status : affected.status);
  }
  const $ = load(html);
  const detailUrl = (id: string) => {
    for (const element of $('a[href]').toArray()) {
      let url: URL;
      try { url = new URL($(element).attr('href')!, config.officialStatusUrl); } catch { continue; }
      if (url.origin === new URL(config.officialStatusUrl).origin && url.pathname === `/incidents/${id}`) return url.href;
    }
    return config.officialStatusUrl;
  };
  const currentIds: string[] = [];
  const parseEntry = (raw: unknown, expectedKind: 'incident' | 'maintenance'): SourceIncident => {
    const entry = record(raw, 'incident.io current entry');
    const id = text(entry.id, 'incident.io incident id');
    requireCoverage(entry.type === expectedKind && entry.status_page_id === pageId, 'incident.io entry type/page identity mismatch');
    const state = lifecycle(entry.status);
    requireCoverage(expectedKind === 'incident' ? ['investigating', 'identified', 'monitoring'].includes(state)
      : ['scheduled', 'in_progress'].includes(state), 'incident.io closed/unknown lifecycle in current list');
    const publishedAt = timestamp(entry.published_at, 'incident.io published_at');
    const affectedIds = rows(entry.affected_components, 'incident.io incident affected_components').map((rawAffected) => {
      const affected = record(rawAffected, 'incident.io incident affected component');
      const componentId = text(affected.component_id, 'incident.io incident component ID');
      requireCoverage(byId.has(componentId), 'incident.io incident component not in directory');
      nativeStatus(affected.status);
      if (present(affected.current_status)) nativeStatus(affected.current_status);
      return componentId;
    });
    requireCoverage(affectedIds.length && new Set(affectedIds).size === affectedIds.length, 'incident.io incident component coverage missing/duplicated');
    const impacts = rows(entry.component_impacts, 'incident.io component_impacts').map((rawImpact) => {
      const impact = record(rawImpact, 'incident.io component impact');
      const componentId = text(impact.component_id, 'incident.io impact component ID');
      requireCoverage(affectedIds.includes(componentId), 'incident.io impact component absent from affected list');
      const start = timestamp(impact.start_at, 'incident.io component impact start');
      const end = present(impact.end_at) ? timestamp(impact.end_at, 'incident.io component impact end') : null;
      requireCoverage(!end || end >= start, 'incident.io component impact ends before it starts');
      requireCoverage(expectedKind !== 'incident' || Date.parse(start) <= Date.parse(now),
        'incident.io current incident has a future component impact');
      return { start, end, status: nativeStatus(impact.status), componentId };
    });
    // Summaries are intervals: ended historical severities cannot establish current severity.
    for (const rawInterval of rows(entry.status_summaries, 'incident.io status_summaries')) {
      const interval = record(rawInterval, 'incident.io status summary interval');
      const start = timestamp(interval.start_at, 'incident.io status summary start');
      const end = present(interval.end_at) ? timestamp(interval.end_at, 'incident.io status summary end') : null;
      nativeStatus(interval.worst_component_status);
      requireCoverage(!end || end >= start, 'incident.io status interval ends before it starts');
    }
    const updates = rows(entry.updates, 'incident.io updates').map((rawUpdate) => {
      const update = record(rawUpdate, 'incident.io update');
      requireCoverage(typeof update.message_string === 'string' && update.message_string !== '$undefined',
        'incident.io plain update message unavailable');
      return {
        id: text(update.id, 'incident.io update ID'), phase: lifecycle(update.to_status),
        timestamp: timestamp(update.published_at, 'incident.io update published_at'), body: update.message_string,
      };
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    requireCoverage(updates.length && new Set(updates.map(({ id }) => id)).size === updates.length,
      'incident.io update coverage empty/duplicated');
    let startedAt = impacts.reduce<string | null>((min, impact) => min === null || impact.start < min ? impact.start : min, null) ?? publishedAt;
    let startTimeBasis: SourceIncident['startTimeBasis'] = impacts.length ? 'source_started_at' : 'source_published_at';
    let current = expectedKind === 'incident';
    if (expectedKind === 'maintenance') {
      requireCoverage(impacts.length, 'incident.io maintenance has no source component impact schedule');
      startedAt = impacts.reduce((min, impact) => impact.start < min ? impact.start : min, impacts[0]!.start);
      startTimeBasis = 'source_started_at';
      current = state === 'in_progress' && Date.parse(startedAt) <= Date.parse(now);
      const activeImpacts = impacts.filter(({ start, end }) => Date.parse(start) <= Date.parse(now)
        && (end === null || Date.parse(end) > Date.parse(now)));
      if (current) {
        requireCoverage(activeImpacts.length, 'incident.io in-progress maintenance has no current source impact interval');
        activeImpacts.forEach(({ componentId, status }) => {
          requireCoverage(status === 'maintenance', 'incident.io maintenance impact has nonmaintenance status');
          byId.get(componentId)!.reportedStatus = worse(byId.get(componentId)!.reportedStatus!, 'maintenance');
        });
      }
    }
    let impact: ServiceStatus = 'operational';
    for (const componentId of affectedIds) impact = worse(impact, byId.get(componentId)!.reportedStatus!);
    if (current && expectedKind === 'incident') {
      for (const native of impacts.filter(({ start, end }) => Date.parse(start) <= Date.parse(now) && end === null)) {
        requireCoverage(byId.get(native.componentId)!.reportedStatus === native.status,
          'incident.io current component impact disagrees with authoritative summary');
      }
    }
    const output = incident(config, now, id, text(entry.name, 'incident.io incident name'), startedAt, updates.at(-1)!.timestamp, {
      kind: expectedKind, state, startTimeBasis,
      severity: expectedKind === 'maintenance' ? current ? 'maintenance' : null : impact === 'operational' ? null : impact,
      sourceSeverity: expectedKind === 'maintenance' || impact === 'maintenance' ? 'under_maintenance'
        : impact === 'degraded' ? 'degraded_performance' : impact === 'major_outage' ? 'full_outage' : impact,
      severityBasis: 'component',
      affectedComponentIds: affectedIds.map((componentId) => `${config.id}:${componentId}`),
      updates, sourceUrl: detailUrl(id),
    });
    if (present(entry.write_up_url)) {
      const url = new URL(text(entry.write_up_url, 'incident.io write_up_url'));
      requireCoverage(url.protocol === 'https:' && !url.username && !url.password, 'incident.io write-up URL not public HTTPS');
      output.postmortemUrl = url.href;
    }
    if (current) currentIds.push(output.sourceIdentity);
    return output;
  };
  const incidents = [
    ...rows(summary.ongoing_incidents, 'incident.io ongoing_incidents').map((raw) => parseEntry(raw, 'incident')),
    ...rows(summary.scheduled_maintenances, 'incident.io scheduled_maintenances').map((raw) => parseEntry(raw, 'maintenance')),
  ];
  requireCoverage(new Set(incidents.map(({ sourceIdentity }) => sourceIdentity)).size === incidents.length,
    'incident.io current entries duplicated');
  const reportedStatus = components.reduce<ServiceStatus>((worst, component) => worse(worst, component.reportedStatus!), 'operational');
  const output = result(config, now, reportedStatus, ['official_flight_summary_identity', 'components_and_sparse_current_impacts', 'ongoing_incidents', 'scheduled_maintenances', 'structure_component_membership'],
    coverage(config, 'full', 'none',
      'Authoritative incident.io structured page covers current components, ongoing incidents and scheduled maintenance. No finite legacy history backfill is imported; incident publish/start/update times retain source semantics.'),
    { components, incidents });
  output.evidence.currentIncidentIds = currentIds;
  return output;
}

export const incidentIoAdapter: Adapter = {
  async collect(config, context) {
    const url = config.adapter.endpoints.page;
    requireCoverage(url && new URL(url).href === new URL(config.officialStatusUrl).href, 'incident.io official page endpoint missing/mismatched');
    let html: string;
    try {
      html = await context.http.getText(url, context.signal);
      return parseIncidentIo(config, html, context.now);
    } catch (error) {
      if (!config.adapter.browserFallback || context.signal.aborted) throw error;
      const responses = await context.browser.collect(config.id, url, context.signal, (candidate) => candidate === url);
      const matching = responses.filter((response) => response.url === url);
      requireCoverage(matching.length === 1, 'incident.io exact official homepage response unavailable/ambiguous');
      const response = matching[0]!;
      if (response.status < 200 || response.status >= 300) throw new AdapterError('http_error', 'incident.io official homepage response failed');
      html = response.body;
      return parseIncidentIo(config, html, context.now);
    }
  },
};
