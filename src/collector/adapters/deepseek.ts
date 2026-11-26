import type { Adapter, AdapterResult, Component, ProviderConfig } from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
import { coverage, record, result, rows, text } from './common.js';
import { parseFeed } from './feed.js';

function initialData(html: string): { data: Record<string, unknown>; updatedAt: string | null } {
  // Flight push bodies are JSON string literals, never executable JavaScript.
  const pushes = html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g);
  let stream = '';
  for (const match of pushes) {
    try { stream += JSON.parse(match[1]!) as string; }
    catch { throw new AdapterError('invalid_payload', 'DeepSeek Flight literal is malformed'); }
  }
  for (const line of stream.split('\n')) {
    const separator = /^[0-9a-f]+:/i.exec(line);
    if (!separator) continue;
    let node: unknown;
    try { node = JSON.parse(line.slice(separator[0].length)) as unknown; } catch { continue; }
    if (!Array.isArray(node) || !node[3] || typeof node[3] !== 'object') continue;
    const properties = record(node[3], 'DeepSeek SSR properties');
    if (!properties.initialData || typeof properties.initialData !== 'object') continue;
    const data = record(properties.initialData, 'DeepSeek SSR initialData');
    if (!data.page || !('active_changes' in data)) continue;
    const updated = properties.initialDataUpdatedAt;
    return {
      data,
      updatedAt: typeof updated === 'number' && Number.isFinite(updated) ? new Date(updated).toISOString() : null,
    };
  }
  throw new AdapterError('coverage_incomplete', 'DeepSeek SSR current state is unavailable');
}

export function parseDeepSeek(config: ProviderConfig, html: string, feed: string | null, now: string): AdapterResult {
  const { data, updatedAt } = initialData(html);
  const page = record(data.page, 'DeepSeek page');
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
  if (active.length) {
    throw new AdapterError('coverage_incomplete', 'DeepSeek nonempty active change lifecycle has not been verified');
  }
  let historyError: AdapterResult['evidence']['historyError'] = null;
  let feedEntries = 0;
  if (feed !== null) {
    try { feedEntries = parseFeed(feed, 'atom').length; }
    catch { historyError = 'invalid_payload'; }
  }
  const output = result(config, now, 'operational', ['ssr_components', 'ssr_active_changes'],
    coverage(config, 'full', 'none', 'Atom entries omit reliable incident start times; nonempty active change shape is unverified'),
    { components, sourceUpdatedAt: updatedAt });
  output.evidence.historyError = historyError;
  output.evidence.warnings.push(`Atom feed supplied ${feedEntries} entries; no reliable start-time history is claimed`);
  return output;
}

export const deepseekAdapter: Adapter = {
  async collect(config, context) {
    const pageUrl = config.adapter.endpoints.page;
    if (!pageUrl) throw new AdapterError('coverage_incomplete', 'DeepSeek page endpoint missing');
    const page = await context.http.getText(pageUrl, context.signal);
    let feed: string | null = null;
    if (config.adapter.endpoints.feed) {
      try { feed = await context.http.getText(config.adapter.endpoints.feed, context.signal); }
      catch { /* Feed history is optional; it does not establish current health. */ }
    }
    return parseDeepSeek(config, page, feed, context.now);
  },
};
