import { load } from 'cheerio';
import type { Adapter, AdapterResult, ProviderConfig } from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
import { coverage, incident, result } from './common.js';
import { parseFeed } from './feed.js';

export function parseAzure(config: ProviderConfig, feed: string | null, html: string, now: string): AdapterResult {
  if (!html) throw new AdapterError('coverage_incomplete', 'Azure current status page missing');
  const $ = load(html);
  const table = $('table[data-zone-name="current-impact"]');
  if (table.length !== 1) throw new AdapterError('coverage_incomplete', 'Azure current-impact table unavailable');
  const rows = table.find('tbody > tr.current-incident');
  if (rows.length !== 1 || !rows.first().find('td.bg-green').length
    || !/There are currently no active events\./i.test(rows.first().text())) {
    throw new AdapterError('coverage_incomplete', 'Azure current-impact state is not a verified empty state');
  }
  const matrix = $('table[data-zone-name]').filter((_index, element) =>
    $(element).attr('data-zone-name') !== 'current-impact');
  const labels = matrix.find('td.status-cell [data-label]').map((_index, element) =>
    $(element).attr('data-label')).get();
  if (!matrix.length || !labels.includes('Good') || labels.some((label) => !['Good', 'Not available'].includes(label))) {
    throw new AdapterError('coverage_incomplete', 'Azure service-region matrix unavailable');
  }
  let entries: ReturnType<typeof parseFeed> = [];
  let historyError: AdapterResult['evidence']['historyError'] = null;
  if (feed !== null) {
    try { entries = parseFeed(feed, 'rss'); }
    catch { historyError = 'invalid_payload'; }
  }
  const incidents = entries.map((entry) => incident(config, now, entry.id, entry.title, entry.updatedAt, entry.updatedAt, {
    state: 'unknown', startTimeBasis: 'source_published_at', severity: null,
    sourceUrl: entry.url ?? config.officialStatusUrl,
    // RSS publication time is a bound on the entry, not the beginning or end of an outage.
  }));
  const output = result(config, now, 'operational', ['current_impact', 'service_region_matrix'],
    coverage(config, 'events_only', 'none', 'Widespread Azure incidents only; RSS entries retain publication timestamps, not incident start/end'),
    { incidents });
  output.evidence.historyError = historyError;
  if (entries.length) output.evidence.warnings.push('RSS timestamps are publication times; incident start/end and resolution remain unverified');
  return output;
}

export const azureAdapter: Adapter = {
  async collect(config, context) {
    const page = config.adapter.endpoints.page;
    if (!page) throw new AdapterError('coverage_incomplete', 'Azure page endpoint missing');
    const html = await context.http.getText(page, context.signal);
    let feed: string | null = null;
    if (config.adapter.endpoints.feed) {
      try { feed = await context.http.getText(config.adapter.endpoints.feed, context.signal); }
      catch { /* Current coverage requires the page, never the RSS feed. */ }
    }
    return parseAzure(config, feed, html, context.now);
  },
};
