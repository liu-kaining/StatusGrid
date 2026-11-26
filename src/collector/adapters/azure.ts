import { load } from 'cheerio';
import type { Adapter, AdapterResult, Component, ProviderConfig, ServiceStatus } from '../../shared/contracts.js';
import { AdapterError, TransportError } from '../errors.js';
import { coverage, incident, result, worse } from './common.js';
import { parseFeed } from './feed.js';

export function parseAzure(config: ProviderConfig, feed: string | null, html: string, now: string): AdapterResult {
  if (!html) throw new AdapterError('coverage_incomplete', 'Azure current status page missing');
  const $ = load(html);
  const table = $('table[data-zone-name="current-impact"]');
  if (table.length !== 1) throw new AdapterError('coverage_incomplete', 'Azure current-impact table unavailable');
  const impactRows = table.find('tbody > tr.current-incident');
  if (!impactRows.length) throw new AdapterError('coverage_incomplete', 'Azure current-impact rows unavailable');
  const emptyImpact = impactRows.length === 1 && impactRows.first().find('td.bg-green').length === 1
    && /There are currently no active events\./i.test(impactRows.first().text());
  const matrix = $('table[data-zone-name]').filter((_index, element) =>
    $(element).attr('data-zone-name') !== 'current-impact');
  if (!matrix.length) throw new AdapterError('coverage_incomplete', 'Azure service-region matrix unavailable');
  const declared = $('li.zone[data-zone-name]').map((_index, element) => $(element).attr('data-zone-name')).get();
  const advertised = declared.filter((zone) => zone !== 'current-impact');
  const present = matrix.map((_index, element) => $(element).attr('data-zone-name')).get();
  if (!declared.includes('current-impact') || !advertised.length
    || new Set(declared).size !== declared.length
    || advertised.length !== present.length || advertised.some((zone) => !present.includes(zone))) {
    throw new AdapterError('coverage_incomplete', 'Azure advertised matrix zones do not match status tables');
  }
  const components: Component[] = [];
  const zones = new Set<string>();
  let reportedStatus: ServiceStatus = 'operational';
  for (const element of matrix.toArray()) {
    const zone = $(element).attr('data-zone-name');
    if (!zone || zones.has(zone)) throw new AdapterError('coverage_incomplete', 'Azure matrix zone missing or duplicated');
    zones.add(zone);
    const headings = $(element).find('thead > tr').first().children('th').map((_index, cell) => $(cell).text().trim()).get();
    if (headings.length < 2 || !headings[0] || headings.slice(1).some((name) => !name || name === 'Products and services')) {
      throw new AdapterError('coverage_incomplete', 'Azure region headings incomplete');
    }
    const regionNames = headings.slice(1);
    if (new Set(regionNames).size !== regionNames.length) throw new AdapterError('coverage_incomplete', 'Azure region headings duplicated');
    let services = 0;
    $(element).find('tbody > tr').each((_index, row) => {
      const cells = $(row).children('td');
      if ($(row).hasClass('status-category')) return;
      if (cells.length !== headings.length || cells.filter('.status-cell').length !== regionNames.length) {
        throw new AdapterError('coverage_incomplete', 'Azure matrix row/column coverage incomplete');
      }
      const name = cells.first().text().trim();
      if (!name) throw new AdapterError('coverage_incomplete', 'Azure service name missing');
      services++;
      cells.slice(1).each((index, cell) => {
        const labels = $(cell).find('[data-label]').map((_labelIndex, label) => $(label).attr('data-label')).get();
        if (labels.length !== 1 || !['Good', 'Not available', 'Information', 'Warning', 'Critical'].includes(labels[0]!)) {
          throw new AdapterError('coverage_incomplete', 'Azure service-region status ambiguous');
        }
        const label = labels[0]!;
        const status = label === 'Good' ? 'operational' : label === 'Warning' ? 'degraded'
          : label === 'Critical' ? 'major_outage' : null;
        if (status) reportedStatus = worse(reportedStatus, status);
        if (label === 'Not available') return;
        const region = regionNames[index]!;
        const upstreamId = `${zone}:${region}:${name}`;
        components.push({
          id: `${config.id}:${encodeURIComponent(upstreamId)}`, upstreamId, name,
          aliases: [], groupId: null, region,
          reportedStatus: status,
        });
      });
    });
    if (!services) throw new AdapterError('coverage_incomplete', 'Azure matrix has no service rows');
  }
  if (!components.length || new Set(components.map(({ id }) => id)).size !== components.length
    || (!emptyImpact && reportedStatus === 'operational')) {
    throw new AdapterError('coverage_incomplete', 'Azure current impact cannot be reconciled with matrix');
  }
  let incidents: AdapterResult['incidents'] = [];
  let historyError: AdapterResult['evidence']['historyError'] = null;
  if (feed !== null) {
    try {
      incidents = parseFeed(feed, 'rss').map((entry) => incident(config, now, entry.id, entry.title, entry.updatedAt, entry.updatedAt, {
        state: 'unknown', startTimeBasis: 'source_published_at', severity: null,
        sourceUrl: entry.url ?? config.officialStatusUrl,
        // RSS publication time is a bound on the entry, not the beginning or end of an outage.
      }));
    }
    catch { historyError = 'invalid_payload'; }
  }
  const output = result(config, now, 'operational', ['current_impact', 'service_region_matrix'],
    coverage(config, 'filtered', 'none', 'Matrix Warning/Critical severity is derived; native current incident lifecycle unsupported, RSS entries retain publication timestamps, not incident start/end'),
    { incidents, components, reportedStatus });
  output.evidence.historyError = historyError;
  if (!emptyImpact) output.evidence.warnings.push('Azure native current incident rows are unparsed; current severity derives from validated service-region matrix');
  if (incidents.length) output.evidence.warnings.push('RSS timestamps are publication times; incident start/end and resolution remain unverified');
  return output;
}

export const azureAdapter: Adapter = {
  async collect(config, context) {
    const page = config.adapter.endpoints.page;
    if (!page) throw new AdapterError('coverage_incomplete', 'Azure page endpoint missing');
    const html = await context.http.getText(page, context.signal);
    let feed: string | null = null;
    let historyError: AdapterResult['evidence']['historyError'] = null;
    if (config.adapter.endpoints.feed) {
      try { feed = await context.http.getText(config.adapter.endpoints.feed, context.signal); }
      catch (error) {
        historyError = error instanceof TransportError ? error.kind === 'cancelled' ? 'timeout' : error.kind : 'invalid_payload';
      }
    }
    const output = parseAzure(config, feed, html, context.now);
    output.evidence.historyError ??= historyError;
    return output;
  },
};
