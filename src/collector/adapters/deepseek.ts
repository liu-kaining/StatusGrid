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
  const native = known(value, ['operational', 'degraded', 'partial_outage', 'full_outage'], 'DeepSeek component status');
  return native === 'full_outage' ? 'major_outage' : native;
}

function initialData(html: string): {
  data: Record<string, unknown>; pageId: string; updatedAt: string | null;
  calendar: unknown | null; historyError: AdapterResult['evidence']['historyError'];
} {
  // Flight push bodies are JSON string literals, never executable JavaScript.
  const pushes = html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g);
  let stream = '';
  for (const match of pushes) {
    try { stream += JSON.parse(match[1]!) as string; }
    catch { throw new AdapterError('invalid_payload', 'DeepSeek Flight literal is malformed'); }
  }
  const properties: Record<string, unknown>[] = [];
  for (const line of stream.split('\n')) {
    const separator = /^[0-9a-f]+:/i.exec(line);
    if (!separator) continue;
    let node: unknown;
    try { node = JSON.parse(line.slice(separator[0].length)) as unknown; } catch { continue; }
    if (Array.isArray(node) && node[3] && typeof node[3] === 'object' && !Array.isArray(node[3])) {
      properties.push(record(node[3], 'DeepSeek SSR properties'));
    }
  }
  const snapshots = properties.filter((entry) => entry.initialData && typeof entry.initialData === 'object'
    && !Array.isArray(entry.initialData) && ('page' in entry.initialData || 'active_changes' in entry.initialData));
  if (!snapshots.length || snapshots.some((entry) => JSON.stringify(entry.initialData) !== JSON.stringify(snapshots[0]!.initialData))) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek current snapshot missing or conflicting');
  }
  const current = snapshots[0]!;
  const data = record(current.initialData, 'DeepSeek SSR initialData');
  const page = record(data.page, 'DeepSeek page');
  const pageId = sourceId(page.page_id, 'DeepSeek page_id');
  if (sourceId(current.pageId, 'DeepSeek Flight pageId') !== pageId) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek page identity conflicts with Flight record');
  }
  const calendars = properties.filter((entry) => entry.initialCalendarData != null);
  const historyError = calendars.some((entry) => entry.pageId !== Number(pageId)
    || JSON.stringify(entry.initialCalendarData) !== JSON.stringify(calendars[0]!.initialCalendarData))
    ? 'coverage_incomplete' : null;
  const updated = current.initialDataUpdatedAt;
  return {
    data, pageId,
    updatedAt: typeof updated === 'number' && Number.isFinite(updated) ? epoch(updated, 'DeepSeek initialDataUpdatedAt') : null,
    calendar: historyError ? null : calendars[0]?.initialCalendarData ?? null, historyError,
  };
}

function parseChange(config: ProviderConfig, raw: unknown, now: string, pageId: string,
  componentIds: ReadonlySet<string>, active: boolean): { entry: SourceIncident; impact: ServiceStatus } {
  const change = record(raw, 'DeepSeek change');
  const id = sourceId(change.change_id, 'DeepSeek change_id');
  if (sourceId(change.page_id, 'DeepSeek change page_id') !== pageId) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek change belongs to another page');
  }
  const kind = known(change.type, ['incident', 'maintenance'], 'DeepSeek change type');
  const state = known(change.status,
    ['investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed'],
    'DeepSeek change lifecycle') as IncidentState;
  if (active && ['resolved', 'completed'].includes(state)) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek resolved change in active snapshot');
  }
  const startedAt = epoch(Number(change.start_at_seconds) * 1000, 'DeepSeek start_at_seconds');
  const resolvedAt = change.close_at_seconds == null ? null
    : epoch(Number(change.close_at_seconds) * 1000, 'DeepSeek close_at_seconds');
  if (resolvedAt && Date.parse(resolvedAt) < Date.parse(startedAt)) {
    throw new AdapterError('invalid_payload', 'DeepSeek change ends before it starts');
  }
  if (active && resolvedAt) throw new AdapterError('coverage_incomplete', 'DeepSeek active change has end time');
  if (!active && ['resolved', 'completed'].includes(state) && !resolvedAt) {
    throw new AdapterError('invalid_payload', 'DeepSeek resolved change lacks end time');
  }
  let currentImpact: ServiceStatus = 'operational';
  const affectedIds = rows(change.affected_components, 'DeepSeek affected_components').map((rawComponent) => {
    const component = record(rawComponent, 'DeepSeek affected component');
    const componentId = text(component.component_id, 'DeepSeek affected component_id');
    if (!componentIds.has(componentId)) {
      throw new AdapterError('coverage_incomplete', `DeepSeek component ${componentId} not in current directory`);
    }
    currentImpact = worse(currentImpact, status(component.status));
    return `${config.id}:${componentId}`;
  });
  if (!affectedIds.length || new Set(affectedIds).size !== affectedIds.length) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek affected components missing or duplicated');
  }
  let historicalImpact: ServiceStatus = 'operational';
  const updates = rows(change.updates, 'DeepSeek updates').map((rawUpdate) => {
    const update = record(rawUpdate, 'DeepSeek update');
    const phase = known(update.status,
      ['investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed'],
      'DeepSeek update lifecycle') as IncidentState;
    for (const rawComponent of rows(update.component_changes ?? [], 'DeepSeek update component_changes')) {
      const component = record(rawComponent, 'DeepSeek update component');
      const componentId = text(component.component_id, 'DeepSeek update component_id');
      if (!componentIds.has(componentId) || !affectedIds.includes(`${config.id}:${componentId}`)) {
        throw new AdapterError('coverage_incomplete', 'DeepSeek update component not in affected directory');
      }
      historicalImpact = worse(historicalImpact, status(component.status));
    }
    return {
      id: text(update.update_id, 'DeepSeek update_id'), phase,
      body: typeof update.description === 'string' ? update.description : '',
      timestamp: epoch(Number(update.at_seconds) * 1000, 'DeepSeek update at_seconds'),
    };
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (!updates.length || (active && kind === 'incident' && currentImpact === 'operational')) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek change impact or updates incomplete');
  }
  const impact = active ? currentImpact : worse(currentImpact, historicalImpact);
  const effective = active && kind === 'maintenance' ? 'maintenance' : impact;
  return {
    entry: incident(config, now, id, text(change.title, 'DeepSeek title'), startedAt, updates.at(-1)!.timestamp, {
      kind, state, affectedComponentIds: affectedIds, resolvedAt,
      severity: effective === 'operational' || effective === 'maintenance' ? null : effective,
      sourceSeverity: impact, severityBasis: impact === 'operational' ? 'unknown' : 'component',
      sourceUrl: new URL(`incidents/${id}`, config.officialStatusUrl).href, updates,
    }),
    impact: effective,
  };
}

export function parseDeepSeek(config: ProviderConfig, html: string, feed: string | null, now: string): AdapterResult {
  const { data, pageId, updatedAt, calendar, historyError: initialHistoryError } = initialData(html);
  const page = record(data.page, 'DeepSeek page');
  if (page.custom_domain !== new URL(config.officialStatusUrl).hostname || page.name !== config.name) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek page identity differs from registry');
  }
  if (!Array.isArray(page.components) || !Array.isArray(data.active_changes)) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek current component or active change coverage unavailable');
  }
  const components = rows(page.components, 'DeepSeek components').map((raw): Component => {
    const entry = record(raw, 'DeepSeek component');
    const upstreamId = text(entry.component_id, 'DeepSeek component_id');
    return {
      id: `${config.id}:${upstreamId}`, upstreamId,
      groupId: typeof entry.section_id === 'string' ? `${config.id}:${entry.section_id}` : null,
      name: text(entry.name, 'DeepSeek component name'), aliases: [], region: null,
      reportedStatus: 'operational',
    };
  });
  if (!components.length || new Set(components.map(({ id }) => id)).size !== components.length) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek component directory is empty or duplicated');
  }
  const active = rows(data.active_changes, 'DeepSeek active_changes');
  const knownIds = new Set(components.map((component) => component.upstreamId!));
  const activeChanges = active.map((change) => parseChange(config, change, now, pageId, knownIds, true));
  let reportedStatus: ServiceStatus = 'operational';
  for (const { entry, impact } of activeChanges) {
    reportedStatus = worse(reportedStatus, impact);
    for (const id of entry.affectedComponentIds) {
      const component = components.find((candidate) => candidate.id === id)!;
      component.reportedStatus = worse(component.reportedStatus!, impact);
    }
  }
  if (new Set(activeChanges.map(({ entry }) => entry.sourceIdentity)).size !== activeChanges.length) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek active changes duplicated');
  }
  let historyError: AdapterResult['evidence']['historyError'] = initialHistoryError;
  let historical: SourceIncident[] = [];
  let earliest: string | null = null;
  if (calendar !== null) {
    try {
      const native = record(calendar, 'DeepSeek calendar');
      const month = record(native.month, 'DeepSeek calendar month');
      if (!Number.isInteger(month.year) || !Number.isInteger(month.month)
        || (month.month as number) < 1 || (month.month as number) > 12) {
        throw new AdapterError('invalid_payload', 'DeepSeek calendar month malformed');
      }
      historical = rows(native.changes, 'DeepSeek historical changes')
        .map((change) => parseChange(config, change, now, pageId, knownIds, false).entry);
      if (new Set(historical.map(({ sourceIdentity }) => sourceIdentity)).size !== historical.length) {
        throw new AdapterError('coverage_incomplete', 'DeepSeek historical changes duplicated');
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
      'Native calendar covers a finite supplied month; Atom feed does not establish incident start times'),
      nativeHistoryEarliestAt: earliest },
    { components, incidents, sourceUpdatedAt: updatedAt });
  output.evidence.currentIncidentIds = activeChanges.map(({ entry }) => entry.sourceIdentity);
  output.evidence.historyError = historyError;
  output.evidence.warnings.push(`Atom feed supplied ${feedEntries} entries; history from source-native calendar only`);
  return output;
}

export const deepseekAdapter: Adapter = {
  async collect(config, context) {
    const pageUrl = config.adapter.endpoints.page;
    if (!pageUrl) throw new AdapterError('coverage_incomplete', 'DeepSeek page endpoint missing');
    const page = await context.http.getText(pageUrl, context.signal);
    let feed: string | null = null;
    let historyError: AdapterResult['evidence']['historyError'] = null;
    if (config.adapter.endpoints.feed) {
      try { feed = await context.http.getText(config.adapter.endpoints.feed, context.signal); }
      catch (error) {
        historyError = error instanceof TransportError ? error.kind === 'cancelled' ? 'timeout' : error.kind : 'invalid_payload';
      }
    }
    const output = parseDeepSeek(config, page, feed, context.now);
    output.evidence.historyError ??= historyError;
    return output;
  },
};
