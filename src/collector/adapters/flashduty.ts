import type { Adapter, AdapterResult, Component, IncidentState, ProviderConfig, ServiceStatus, SourceIncident } from '../../shared/contracts.js';
import { AdapterError, TransportError } from '../errors.js';
import { coverage, epoch, incident, known, record, result, rows, text, worse } from './common.js';
import { parseFeed } from './feed.js';

function sourceId(value: unknown, label: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AdapterError('invalid_payload', `${label} must be a positive integer`);
  }
  return String(value);
}

function status(value: unknown): ServiceStatus {
  const native = known(value, ['operational', 'degraded', 'partial_outage', 'full_outage'], 'Flashduty component status');
  return native === 'full_outage' ? 'major_outage' : native;
}

function flightProperties(html: string): Record<string, unknown>[] {
  // Flight push bodies are JSON string literals, never executable JavaScript.
  const pushes = html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g);
  let stream = '';
  for (const match of pushes) {
    try { stream += JSON.parse(match[1]!) as string; }
    catch { throw new AdapterError('invalid_payload', 'Flashduty Flight literal is malformed'); }
  }
  const properties: Record<string, unknown>[] = [];
  for (const line of stream.split('\n')) {
    const separator = /^[0-9a-f]+:/i.exec(line);
    if (!separator) continue;
    let node: unknown;
    try { node = JSON.parse(line.slice(separator[0].length)) as unknown; } catch { continue; }
    if (Array.isArray(node) && node[3] && typeof node[3] === 'object' && !Array.isArray(node[3])) {
      properties.push(record(node[3], 'Flashduty SSR properties'));
    }
  }
  return properties;
}

function initialData(html: string, historyHtml: string | null): {
  data: Record<string, unknown>; pageId: string; updatedAt: string | null;
  calendar: unknown | null; historyError: AdapterResult['evidence']['historyError'];
} {
  const properties = flightProperties(html);
  const snapshots = properties.filter((entry) => entry.initialData && typeof entry.initialData === 'object'
    && !Array.isArray(entry.initialData) && ('page' in entry.initialData || 'active_changes' in entry.initialData));
  if (!snapshots.length || snapshots.some((entry) => JSON.stringify(entry.initialData) !== JSON.stringify(snapshots[0]!.initialData))) {
    throw new AdapterError('coverage_incomplete', 'Flashduty current snapshot missing or conflicting');
  }
  const current = snapshots[0]!;
  const data = record(current.initialData, 'Flashduty SSR initialData');
  const page = record(data.page, 'Flashduty page');
  const pageId = sourceId(page.page_id, 'Flashduty page_id');
  if (sourceId(current.pageId, 'Flashduty Flight pageId') !== pageId) {
    throw new AdapterError('coverage_incomplete', 'Flashduty page identity conflicts with Flight record');
  }
  const calendars = properties.filter((entry) => entry.initialCalendarData != null
    && entry.initialCalendarData !== '$undefined');
  let historyError: AdapterResult['evidence']['historyError'] = null;
  if (historyHtml !== null) {
    try {
      const lists = flightProperties(historyHtml).filter((entry) => 'initialChanges' in entry);
      if (!lists.length) throw new AdapterError('coverage_incomplete', 'Flashduty history list missing');
      for (const entry of lists) calendars.push({
        pageId: entry.pageId,
        initialCalendarData: { changes: entry.initialChanges, month: entry.initialMonth },
      });
    } catch (error) {
      historyError = error instanceof AdapterError ? error.reason : 'invalid_payload';
    }
  }
  historyError ??= calendars.some((entry) => entry.pageId !== Number(pageId)
    || JSON.stringify(entry.initialCalendarData) !== JSON.stringify(calendars[0]!.initialCalendarData))
    ? 'coverage_incomplete' : null;
  const updated = current.initialDataUpdatedAt;
  return {
    data, pageId,
    updatedAt: typeof updated === 'number' && Number.isFinite(updated) ? epoch(updated, 'Flashduty initialDataUpdatedAt') : null,
    calendar: historyError ? null : calendars[0]?.initialCalendarData ?? null, historyError,
  };
}

function parseChange(config: ProviderConfig, raw: unknown, now: string, pageId: string,
  componentIds: ReadonlySet<string>, active: boolean): {
    entry: SourceIncident; impact: ServiceStatus; componentStatuses: Map<string, ServiceStatus>; isCurrent: boolean;
  } {
  const change = record(raw, 'Flashduty change');
  const id = sourceId(change.change_id, 'Flashduty change_id');
  if (sourceId(change.page_id, 'Flashduty change page_id') !== pageId) {
    throw new AdapterError('coverage_incomplete', 'Flashduty change belongs to another page');
  }
  const kind = known(change.type, ['incident', 'maintenance'], 'Flashduty change type');
  const state = known(change.status,
    ['investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed'],
    'Flashduty change lifecycle') as IncidentState;
  if (active && ['resolved', 'completed'].includes(state)) {
    throw new AdapterError('coverage_incomplete', 'Flashduty resolved change in active snapshot');
  }
  if (active && kind === 'maintenance' && state !== 'scheduled' && state !== 'in_progress') {
    throw new AdapterError('coverage_incomplete', 'Flashduty active maintenance lifecycle is unknown');
  }
  const startedAt = epoch(Number(change.start_at_seconds) * 1000, 'Flashduty start_at_seconds');
  const resolvedAt = change.close_at_seconds == null ? null
    : epoch(Number(change.close_at_seconds) * 1000, 'Flashduty close_at_seconds');
  if (resolvedAt && Date.parse(resolvedAt) < Date.parse(startedAt)) {
    throw new AdapterError('invalid_payload', 'Flashduty change ends before it starts');
  }
  if (active && resolvedAt) throw new AdapterError('coverage_incomplete', 'Flashduty active change has end time');
  if (!active && ['resolved', 'completed'].includes(state) && !resolvedAt) {
    throw new AdapterError('invalid_payload', 'Flashduty resolved change lacks end time');
  }
  let currentImpact: ServiceStatus = 'operational';
  const componentStatuses = new Map<string, ServiceStatus>();
  const affectedIds = rows(change.affected_components, 'Flashduty affected_components').map((rawComponent) => {
    const component = record(rawComponent, 'Flashduty affected component');
    const componentId = text(component.component_id, 'Flashduty affected component_id');
    if (!componentIds.has(componentId)) {
      throw new AdapterError('coverage_incomplete', `Flashduty component ${componentId} not in current directory`);
    }
    const impact = status(component.status);
    const id = `${config.id}:${componentId}`;
    currentImpact = worse(currentImpact, impact);
    componentStatuses.set(id, impact);
    return id;
  });
  if (!affectedIds.length || new Set(affectedIds).size !== affectedIds.length) {
    throw new AdapterError('coverage_incomplete', 'Flashduty affected components missing or duplicated');
  }
  let historicalImpact: ServiceStatus = 'operational';
  const updates = rows(change.updates, 'Flashduty updates').map((rawUpdate) => {
    const update = record(rawUpdate, 'Flashduty update');
    const phase = known(update.status,
      ['investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed'],
      'Flashduty update lifecycle') as IncidentState;
    for (const rawComponent of rows(update.component_changes ?? [], 'Flashduty update component_changes')) {
      const component = record(rawComponent, 'Flashduty update component');
      const componentId = text(component.component_id, 'Flashduty update component_id');
      if (!componentIds.has(componentId) || !affectedIds.includes(`${config.id}:${componentId}`)) {
        throw new AdapterError('coverage_incomplete', 'Flashduty update component not in affected directory');
      }
      historicalImpact = worse(historicalImpact, status(component.status));
    }
    return {
      id: text(update.update_id, 'Flashduty update_id'), phase,
      body: typeof update.description === 'string' ? update.description : '',
      timestamp: epoch(Number(update.at_seconds) * 1000, 'Flashduty update at_seconds'),
    };
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (!updates.length || (active && kind === 'incident' && currentImpact === 'operational')) {
    throw new AdapterError('coverage_incomplete', 'Flashduty change impact or updates incomplete');
  }
  const impact = active ? currentImpact : worse(currentImpact, historicalImpact);
  const isCurrent = active && (kind !== 'maintenance'
    || (state === 'in_progress' && Date.parse(startedAt) <= Date.parse(now)));
  const effective = isCurrent && kind === 'maintenance' ? 'maintenance' : impact;
  return {
    entry: incident(config, now, id, text(change.title, 'Flashduty title'), startedAt, updates.at(-1)!.timestamp, {
      kind, state, affectedComponentIds: affectedIds, resolvedAt,
      severity: effective === 'operational' || effective === 'maintenance' ? null : effective,
      sourceSeverity: impact, severityBasis: impact === 'operational' ? 'unknown' : 'component',
      sourceUrl: new URL(`incidents/${id}`, config.officialStatusUrl).href, updates,
    }),
    impact: effective, componentStatuses, isCurrent,
  };
}

export function parseFlashduty(
  config: ProviderConfig, html: string, feed: string | null, now: string, historyHtml: string | null = null,
): AdapterResult {
  const { data, pageId, updatedAt, calendar, historyError: initialHistoryError } = initialData(html, historyHtml);
  const page = record(data.page, 'Flashduty page');
  if (page.custom_domain !== new URL(config.officialStatusUrl).hostname || page.name !== config.name) {
    throw new AdapterError('coverage_incomplete', 'Flashduty page identity differs from registry');
  }
  if ((config.adapter.type === 'flashduty' && !config.adapter.sourcePageId)
    || (config.adapter.sourcePageId && config.adapter.sourcePageId !== pageId)) {
    throw new AdapterError('coverage_incomplete', 'Flashduty page identity differs from pinned registry ID');
  }
  if (!Array.isArray(page.components) || !Array.isArray(data.active_changes)) {
    throw new AdapterError('coverage_incomplete', 'Flashduty current component or active change coverage unavailable');
  }
  const components = rows(page.components, 'Flashduty components').map((raw): Component => {
    const entry = record(raw, 'Flashduty component');
    const upstreamId = text(entry.component_id, 'Flashduty component_id');
    return {
      id: `${config.id}:${upstreamId}`, upstreamId,
      groupId: typeof entry.section_id === 'string' ? `${config.id}:${entry.section_id}` : null,
      name: text(entry.name, 'Flashduty component name'), aliases: [], region: null,
      reportedStatus: 'operational',
    };
  });
  if (!components.length || new Set(components.map(({ id }) => id)).size !== components.length) {
    throw new AdapterError('coverage_incomplete', 'Flashduty component directory is empty or duplicated');
  }
  const active = rows(data.active_changes, 'Flashduty active_changes');
  const knownIds = new Set(components.map((component) => component.upstreamId!));
  const activeChanges = active.map((change) => parseChange(config, change, now, pageId, knownIds, true));
  let reportedStatus: ServiceStatus = 'operational';
  for (const { entry, impact, componentStatuses, isCurrent } of activeChanges) {
    if (!isCurrent) continue;
    reportedStatus = worse(reportedStatus, impact);
    for (const id of entry.affectedComponentIds) {
      const component = components.find((candidate) => candidate.id === id)!;
      const ownStatus = entry.kind === 'maintenance' ? 'maintenance' : componentStatuses.get(id)!;
      component.reportedStatus = worse(component.reportedStatus!, ownStatus);
    }
  }
  if (new Set(activeChanges.map(({ entry }) => entry.sourceIdentity)).size !== activeChanges.length) {
    throw new AdapterError('coverage_incomplete', 'Flashduty active changes duplicated');
  }
  let historyError: AdapterResult['evidence']['historyError'] = initialHistoryError;
  let historical: SourceIncident[] = [];
  let earliest: string | null = null;
  if (calendar !== null) {
    try {
      const native = record(calendar, 'Flashduty calendar');
      const month = record(native.month, 'Flashduty calendar month');
      if (!Number.isInteger(month.year) || !Number.isInteger(month.month)
        || (month.month as number) < 1 || (month.month as number) > 12) {
        throw new AdapterError('invalid_payload', 'Flashduty calendar month malformed');
      }
      historical = rows(native.changes, 'Flashduty historical changes')
        .map((change) => parseChange(config, change, now, pageId, knownIds, false).entry);
      if (new Set(historical.map(({ sourceIdentity }) => sourceIdentity)).size !== historical.length) {
        throw new AdapterError('coverage_incomplete', 'Flashduty historical changes duplicated');
      }
      earliest = historical.reduce<string | null>((min, item) => min === null || item.startedAt < min ? item.startedAt : min, null);
    } catch (error) {
      historyError = error instanceof AdapterError ? error.reason : 'invalid_payload';
      historical = [];
      earliest = null;
    }
  }
  const nativeHistoryValid = calendar !== null && historyError === null;
  let feedEntries = 0;
  if (feed !== null) {
    try { feedEntries = parseFeed(feed, 'atom').length; }
    catch { historyError = 'invalid_payload'; }
  }
  const incidents = [...new Map([...historical, ...activeChanges.map(({ entry }) => entry)]
    .map((entry) => [entry.sourceIdentity, entry])).values()];
  const output = result(config, now, reportedStatus, ['ssr_components', 'ssr_active_changes'],
    { ...coverage(config, 'full', nativeHistoryValid ? 'native' : 'none',
      'Native history covers only the supplied calendar/list window; feeds do not establish incident start times'),
      nativeHistoryEarliestAt: earliest },
    { components, incidents, sourceUpdatedAt: updatedAt });
  output.evidence.currentIncidentIds = activeChanges.filter(({ isCurrent }) => isCurrent)
    .map(({ entry }) => entry.sourceIdentity);
  output.evidence.historyError = historyError;
  if (feed !== null) output.evidence.warnings.push(`Atom feed supplied ${feedEntries} entries; history from source-native calendar/list only`);
  return output;
}

export const flashdutyAdapter: Adapter = {
  async collect(config, context) {
    const pageUrl = config.adapter.endpoints.page;
    if (!pageUrl) throw new AdapterError('coverage_incomplete', 'Flashduty page endpoint missing');
    const page = await context.http.getText(pageUrl, context.signal);
    let feed: string | null = null;
    let historyHtml: string | null = null;
    let historyError: AdapterResult['evidence']['historyError'] = null;
    if (config.adapter.endpoints.history) {
      try { historyHtml = await context.http.getText(config.adapter.endpoints.history, context.signal); }
      catch (error) {
        historyError = error instanceof TransportError ? error.kind === 'cancelled' ? 'timeout' : error.kind : 'invalid_payload';
      }
    }
    if (config.adapter.endpoints.feed) {
      try { feed = await context.http.getText(config.adapter.endpoints.feed, context.signal); }
      catch (error) {
        historyError = error instanceof TransportError ? error.kind === 'cancelled' ? 'timeout' : error.kind : 'invalid_payload';
      }
    }
    const output = parseFlashduty(config, page, feed, context.now, historyHtml);
    output.evidence.historyError ??= historyError;
    return output;
  },
};
