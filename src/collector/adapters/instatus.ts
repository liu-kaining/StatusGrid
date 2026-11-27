import type {
  Adapter, AdapterResult, Component, IncidentKind, IncidentState, ProviderConfig, ServiceStatus, SourceIncident,
} from '../../shared/contracts.js';
import { AdapterError, TransportError } from '../errors.js';
import { coverage, incident, known, record, result, rows, text, timestamp, worse } from './common.js';

const componentStatuses = {
  OPERATIONAL: 'operational', UNDERMAINTENANCE: 'maintenance', DEGRADEDPERFORMANCE: 'degraded',
  PARTIALOUTAGE: 'partial_outage', MAJOROUTAGE: 'major_outage',
} as const;
const lifecycle = {
  INVESTIGATING: 'investigating', IDENTIFIED: 'identified', MONITORING: 'monitoring', RESOLVED: 'resolved',
  NOTSTARTEDYET: 'scheduled', INPROGRESS: 'in_progress', COMPLETED: 'completed',
} as const;

function localized(raw: unknown, label: string, strings: ReadonlyMap<string, string>): string {
  const value = typeof raw === 'string' ? raw : record(raw, label).default;
  text(value, label);
  const encoded = value as string;
  if (encoded.startsWith('$$')) return encoded.slice(1);
  if (!encoded.startsWith('$')) return encoded;
  const reference = /^\$([0-9a-f]+)$/i.exec(encoded);
  const resolved = reference ? strings.get(reference[1]!) : undefined;
  if (resolved === undefined) throw new AdapterError('invalid_payload', `${label} has an unresolved Flight text reference`);
  text(resolved, label);
  return resolved;
}

/** Parse inert JSON string literals and records only; never evaluate a page script. */
function snapshot(html: string, kind: 'current' | 'history'): {
  data: Record<string, unknown>; strings: ReadonlyMap<string, string>;
} {
  let stream = '';
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)) {
    try { stream += JSON.parse(match[1]!) as string; }
    catch { throw new AdapterError('invalid_payload', 'Instatus Flight literal is malformed'); }
  }
  const candidates: Record<string, unknown>[] = [];
  const strings = new Map<string, string>();
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      if (object.site && object.url && (kind === 'history' ? 'monthlyGroupedNotices' in object
        : 'activeIncidents' in object || 'activeMaintenances' in object || 'activeGenericNotices' in object)) {
        candidates.push(object);
        return;
      }
    }
    for (const child of Object.values(value)) visit(child);
  }
  // Flight text records carry a UTF-8 byte length and need not end with a newline.
  // Read all text records before resolving fields, including forward references.
  const bytes = Buffer.from(stream);
  let offset = 0;
  while (offset < bytes.length) {
    const textHeader = /^([0-9a-f]+):T([0-9a-f]+),/i.exec(bytes.subarray(offset, offset + 60).toString());
    if (textHeader) {
      const start = offset + textHeader[0].length;
      const end = start + Number.parseInt(textHeader[2]!, 16);
      if (end > bytes.length) throw new AdapterError('invalid_payload', 'Instatus Flight text record is truncated');
      const id = textHeader[1]!;
      const value = bytes.subarray(start, end).toString('utf8');
      if (strings.has(id) && strings.get(id) !== value) {
        throw new AdapterError('invalid_payload', 'Instatus Flight text records conflict');
      }
      strings.set(id, value);
      offset = end;
      continue;
    }
    const newline = bytes.indexOf(10, offset);
    const line = bytes.subarray(offset, newline < 0 ? bytes.length : newline).toString();
    offset = newline < 0 ? bytes.length : newline + 1;
    const prefix = /^[0-9a-f]+:/i.exec(line);
    if (prefix) {
      let value: unknown;
      try { value = JSON.parse(line.slice(prefix[0].length)) as unknown; } catch { continue; }
      visit(value);
    }
  }
  if (!candidates.length || candidates.some(value => JSON.stringify(value) !== JSON.stringify(candidates[0]))) {
    throw new AdapterError('coverage_incomplete', `Instatus ${kind} snapshot missing or conflicting`);
  }
  return { data: candidates[0]!, strings };
}

function identity(config: ProviderConfig, root: Record<string, unknown>, strings: ReadonlyMap<string, string>): Record<string, unknown> {
  const site = record(root.site, 'Instatus site');
  const host = new URL(config.officialStatusUrl).hostname;
  if (!config.adapter.sourcePageId || site.id !== config.adapter.sourcePageId
    || site.customDomain !== host || root.url !== host || localized(site.name, 'Instatus page name', strings) !== config.name) {
    throw new AdapterError('coverage_incomplete', 'Instatus page identity differs from registry');
  }
  return site;
}

function pageStatus(raw: unknown): ServiceStatus {
  const value = text(raw, 'Instatus page status');
  if (value === 'UP') return 'operational';
  if (value === 'HASISSUES') return 'degraded';
  if (value === 'UNDERMAINTENANCE') return 'maintenance';
  const granular = /^(?:ALL|SOME|ONE)(UNDERMAINTENANCE|DEGRADEDPERFORMANCE|PARTIALOUTAGE|MINOROUTAGE|MAJOROUTAGE)$/.exec(value);
  if (!granular) throw new AdapterError('unknown_status', `Instatus page status: ${value}`);
  return granular[1] === 'MINOROUTAGE' ? 'partial_outage'
    : componentStatuses[granular[1] as keyof typeof componentStatuses];
}

function componentStatus(raw: unknown): ServiceStatus {
  return componentStatuses[known(raw, Object.keys(componentStatuses), 'Instatus component status') as keyof typeof componentStatuses];
}

function state(raw: unknown, kind: IncidentKind): IncidentState {
  const native = known(raw, kind === 'maintenance' ? ['NOTSTARTEDYET', 'INPROGRESS', 'COMPLETED']
    : ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'], 'Instatus notice lifecycle');
  return lifecycle[native as keyof typeof lifecycle];
}

function parseNotice(config: ProviderConfig, raw: unknown, now: string,
  componentIds: ReadonlySet<string>, active: boolean, kind: IncidentKind, strings: ReadonlyMap<string, string>): SourceIncident {
  const value = record(raw, 'Instatus notice');
  const id = text(value.id, 'Instatus notice.id');
  const phase = state(value.status, kind);
  const updates = rows(value.updates, 'Instatus notice.updates').map((rawUpdate) => {
    const update = record(rawUpdate, 'Instatus update');
    return {
      id: text(update.id, 'Instatus update.id'), phase: state(update.status, kind),
      body: localized(update.message, 'Instatus update.message', strings),
      timestamp: timestamp(update.started, 'Instatus update.started'),
    };
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const startedAt = timestamp(kind === 'maintenance' ? value.start : value.started, 'Instatus notice start');
  const resolvedAt = kind === 'maintenance'
    ? phase === 'completed' ? updates.filter(update => update.phase === 'completed').at(-1)?.timestamp ?? null : null
    : value.resolved == null ? null : timestamp(value.resolved, 'Instatus notice.resolved');
  const closed = phase === 'resolved' || phase === 'completed';
  if (active && (closed || resolvedAt) || !active && closed !== Boolean(resolvedAt)) {
    throw new AdapterError('coverage_incomplete', 'Instatus notice lifecycle and closure disagree');
  }
  if (resolvedAt && resolvedAt < startedAt) {
    throw new AdapterError('invalid_payload', 'Instatus notice resolves before its start');
  }
  const affectedComponentIds = rows(value.components, 'Instatus notice.components').map((entry) => {
    const componentId = text(record(entry, 'Instatus notice component').id, 'Instatus notice component.id');
    if (active && !componentIds.has(componentId)) {
      throw new AdapterError('coverage_incomplete', 'Instatus active notice component is absent from directory');
    }
    return `${config.id}:${componentId}`;
  });
  if (new Set(affectedComponentIds).size !== affectedComponentIds.length) {
    throw new AdapterError('coverage_incomplete', 'Instatus notice component IDs duplicated');
  }
  const severity = kind === 'maintenance' ? 'maintenance' : componentStatus(value.impact);
  return incident(config, now, id, localized(value.name, 'Instatus notice name', strings), startedAt,
    typeof value.updatedAt === 'string' ? timestamp(value.updatedAt, 'Instatus notice.updatedAt')
      : updates.at(-1)?.timestamp ?? resolvedAt ?? startedAt, {
      kind, state: phase, severity: severity === 'operational' ? null : severity,
      sourceSeverity: kind === 'maintenance' ? 'UNDERMAINTENANCE' : text(value.impact, 'Instatus notice impact'),
      severityBasis: 'source', affectedComponentIds, resolvedAt,
      sourceUrl: new URL(`${kind}/${encodeURIComponent(id)}`, config.officialStatusUrl).href, updates,
    });
}

export function parseInstatus(config: ProviderConfig, html: string, historyHtml: string | null, now: string): AdapterResult {
  const { data: current, strings } = snapshot(html, 'current');
  const site = identity(config, current, strings);
  if (!Array.isArray(site.components) || !site.components.length
    || !Array.isArray(current.activeIncidents) || !Array.isArray(current.activeMaintenances)
    || !Array.isArray(current.activeGenericNotices) || current.activeGenericNotices.length) {
    throw new AdapterError('coverage_incomplete', 'Instatus current directory or notice coverage is incomplete');
  }
  let reportedStatus = worse(pageStatus(site.status), pageStatus(site.mainStatus));
  const components: Component[] = [];
  const componentIds = new Set<string>();
  function addComponent(raw: unknown, groupId: string | null): void {
    const value = record(raw, 'Instatus component');
    const upstreamId = text(value.id, 'Instatus component.id');
    if (componentIds.has(upstreamId)) throw new AdapterError('coverage_incomplete', 'Instatus component IDs duplicated');
    componentIds.add(upstreamId);
    const status = componentStatus(value.status);
    const children = rows(value.children, 'Instatus component.children');
    if (typeof value.isParent !== 'boolean' || value.isParent !== Boolean(children.length)) {
      throw new AdapterError('coverage_incomplete', 'Instatus component group coverage is incomplete');
    }
    const id = `${config.id}:${upstreamId}`;
    components.push({
      id, upstreamId, groupId, name: localized(value.name, 'Instatus component name', strings),
      aliases: [], region: null, reportedStatus: status,
    });
    reportedStatus = worse(reportedStatus, status);
    for (const child of children) addComponent(child, id);
  }
  for (const entry of site.components) addComponent(entry, null);
  const active = [
    ...current.activeIncidents.map(entry => parseNotice(config, entry, now, componentIds, true, 'incident', strings)),
    ...current.activeMaintenances.map(entry => parseNotice(config, entry, now, componentIds, true, 'maintenance', strings)),
  ];
  if (new Set(active.map(entry => entry.sourceIdentity)).size !== active.length) {
    throw new AdapterError('coverage_incomplete', 'Instatus active notice IDs duplicated');
  }
  for (const entry of active) {
    if (entry.severity && entry.state !== 'scheduled') reportedStatus = worse(reportedStatus, entry.severity);
  }
  let historyError: AdapterResult['evidence']['historyError'] = null;
  let historical: SourceIncident[] = [];
  if (historyHtml !== null) {
    try {
      const { data: history, strings: historyStrings } = snapshot(historyHtml, 'history');
      identity(config, history, historyStrings);
      historical = rows(history.monthlyGroupedNotices, 'Instatus monthly notices').flatMap((entry) =>
        rows(record(entry, 'Instatus month').notices, 'Instatus monthly notice list')
          .map((notice) => {
            const value = record(notice, 'Instatus historical notice');
            return parseNotice(config, value, now, componentIds, false, 'start' in value ? 'maintenance' : 'incident', historyStrings);
          }));
      if (new Set(historical.map(entry => entry.sourceIdentity)).size !== historical.length) {
        throw new AdapterError('coverage_incomplete', 'Instatus history notice IDs duplicated');
      }
    } catch (error) {
      if (!(error instanceof AdapterError)) throw error;
      historyError = error.reason;
      historical = [];
    }
  }
  const incidents = new Map(historical.map(entry => [entry.sourceIdentity, entry]));
  for (const entry of active) incidents.set(entry.sourceIdentity, entry);
  const earliest = historical.reduce<string | null>((first, entry) =>
    first === null || entry.startedAt < first ? entry.startedAt : first, null);
  const output = result(config, now, reportedStatus, ['current_page_identity', 'complete_components', 'active_notices'],
    { ...coverage(config, 'full', historyHtml !== null && !historyError ? 'native' : 'none',
      'Instatus native history is a finite recent page; generic notices are not supported'),
    nativeHistoryEarliestAt: earliest },
    { components, incidents: [...incidents.values()] });
  output.evidence.currentIncidentIds = active.map(entry => entry.sourceIdentity);
  output.evidence.historyError = historyError;
  if (historyError) output.evidence.warnings.push(`Historical backfill unavailable (${historyError})`);
  return output;
}

export const instatusAdapter: Adapter = {
  async collect(config, context) {
    const page = config.adapter.endpoints.page;
    if (!page) throw new AdapterError('coverage_incomplete', 'Instatus current page endpoint is missing');
    const html = await context.http.getText(page, context.signal);
    let historyHtml: string | null = null;
    let historyError: AdapterResult['evidence']['historyError'] = null;
    if (config.adapter.endpoints.history) {
      try { historyHtml = await context.http.getText(config.adapter.endpoints.history, context.signal); }
      catch (error) {
        historyError = error instanceof TransportError ? error.kind === 'cancelled' ? 'timeout' : error.kind : 'invalid_payload';
      }
    }
    const output = parseInstatus(config, html, historyHtml, context.now);
    if (historyError) {
      output.evidence.historyError = historyError;
      output.evidence.warnings.push(`Historical backfill unavailable (${historyError})`);
    }
    return output;
  },
};
