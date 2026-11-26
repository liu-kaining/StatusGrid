import type { Adapter, Component, ServiceStatus, SourceIncident } from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
import { coverage, incident, known, record, result, rows, text, worse } from './common.js';
import { chinaTime, digestIdentity, requireCoverage, requireRegions, shanghaiDate } from './regional.js';
import { load } from 'cheerio';

function data(raw: unknown): Record<string, unknown> {
  const response = record(record(raw, 'Tencent envelope').Response, 'Tencent Response');
  if (response.Error) throw new AdapterError('http_error', 'Tencent public business request rejected');
  return record(response.Data, 'Tencent Data');
}

function nativeStatus(raw: unknown): ServiceStatus {
  const status = known(raw, ['NORMAL', 'NOTIFY', 'ABNORMAL'], 'Tencent current status');
  return status === 'ABNORMAL' ? 'partial_outage' : 'operational';
}

export const tencentAdapter: Adapter = {
  async collect(config, context) {
    const required = requireRegions(config);
    const endpoint = (name: string, params: Record<string, string> = {}) => {
      const url = new URL(`/v1/api/status/${name}`, config.officialStatusUrl);
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
      return url.href;
    };
    const directory = data(await context.http.getJson(endpoint('DescribeRegions'), context.signal));
    const regionIds = rows(directory.AreaDetailList, 'Tencent areas').flatMap((area) =>
      rows(record(area, 'Tencent area').RegionList, 'Tencent regions').map((raw) =>
        text(record(raw, 'Tencent region').RegionId, 'Tencent RegionId')));
    requireCoverage(regionIds.length && required.every((region) => regionIds.includes(region)), 'Tencent required region absent from directory');
    const components: Component[] = [];
    const incidents: SourceIncident[] = [];
    let reportedStatus: ServiceStatus = 'operational';
    for (const region of required) {
      const [catalog, current] = await Promise.all([
        context.http.getJson(endpoint('DescribeProductsByRegion', { RegionId: region }), context.signal),
        context.http.getJson(endpoint('DescribeProductEventForRegionInPeriod', {
          RegionId: region, EndDate: shanghaiDate(context.now), NumOfDay: '7',
        }), context.signal),
      ]);
      const products = rows(data(catalog).List, 'Tencent catalog').map((raw) => record(raw, 'Tencent product'));
      const catalogIds = products.map((product) => text(product.ProductId, 'Tencent ProductId'));
      requireCoverage(catalogIds.length && new Set(catalogIds).size === catalogIds.length, 'Tencent catalog empty or duplicated');
      const snapshot = data(current);
      const summaries = record(snapshot.Summary, 'Tencent Summary');
      const counts = { NORMAL: 0, NOTIFY: 0, ABNORMAL: 0 };
      const currentIds = new Set<string>();
      for (const rawCategory of rows(snapshot.CategoryList, 'Tencent categories')) {
        const category = record(rawCategory, 'Tencent category');
        for (const rawProduct of rows(category.ProductList, 'Tencent current products')) {
          const product = record(rawProduct, 'Tencent current product');
          const id = text(product.ProductId, 'Tencent current ProductId');
          requireCoverage(catalogIds.includes(id) && !currentIds.has(id), 'Tencent current products differ from catalog');
          currentIds.add(id);
          const native = known(product.CurrentStatus, ['NORMAL', 'NOTIFY', 'ABNORMAL'], 'Tencent current status');
          counts[native]++;
          const status = nativeStatus(native);
          reportedStatus = worse(reportedStatus, status);
          const component: Component = {
            id: `${config.id}:${region}:${id}`, upstreamId: id,
            name: text(product.ProductName, 'Tencent ProductName'), aliases: [],
            groupId: `${config.id}:${region}:${text(category.CategoryName, 'Tencent CategoryName')}`,
            region, reportedStatus: status,
          };
          requireCoverage(products.find((entry) => entry.ProductId === id)?.ProductName === component.name,
            'Tencent product identity conflicts with catalog');
          components.push(component);
          rows(product.EventListGroupByZoneAndDate, 'Tencent finite dated events');
          if (native === 'NORMAL') {
            requireCoverage(product.CurrentEvent === null, 'Tencent normal status conflicts with current event');
            continue;
          }
          const events = rows(record(product.CurrentEvent, 'Tencent CurrentEvent').EventItemList, 'Tencent EventItemList');
          requireCoverage(events.length, 'Tencent abnormal product lacks current events');
          for (const rawEvent of events) {
            const event = record(rawEvent, 'Tencent event item');
            const updates = rows(event.ZoneEventList, 'Tencent ZoneEventList').map((rawUpdate) => {
              const update = record(rawUpdate, 'Tencent zone event');
              const nativeUpdate = known(update.Status, ['NORMAL', 'NOTIFY', 'ABNORMAL'], 'Tencent event status');
              return {
                id: text(update.EventId, 'Tencent EventId'),
                timestamp: chinaTime(update.EventTime, 'Tencent EventTime'),
                phase: nativeUpdate === 'NORMAL' ? 'resolved' as const : 'unknown' as const,
                body: typeof update.Content === 'string' ? load(update.Content).text().trim() : '',
              };
            }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            requireCoverage(updates.length && updates.at(-1)!.phase !== 'resolved', 'Tencent current event missing or already resolved');
            const start = updates[0]!;
            const eventId = digestIdentity(region, id, start.id);
            incidents.push(incident(config, context.now, eventId, text(event.Title, 'Tencent event Title'),
              start.timestamp, updates.at(-1)!.timestamp, {
                upstreamId: null, kind: native === 'NOTIFY' ? 'advisory' : 'incident',
                state: 'unknown', severity: status === 'operational' ? null : status,
                severityBasis: 'component', sourceSeverity: native, startTimeBasis: 'source_published_at',
                affectedComponentIds: [component.id], affectedRegions: [region], updates,
              }));
          }
        }
      }
      requireCoverage(currentIds.size === catalogIds.length, 'Tencent current coverage incomplete');
      requireCoverage(summaries.NormalCount === counts.NORMAL && summaries.NotifyCount === counts.NOTIFY
        && summaries.AbnormalCount === counts.ABNORMAL, 'Tencent summary counts conflict with initialized current products');
    }
    const output = result(config, context.now, reportedStatus, ['region_directory', 'per_region_catalog', 'per_region_current_counts_and_events'],
      coverage(config, 'full', 'none',
        'Complete only for declared requiredRegions, a subset of the public directory. NOTIFY is advisory, not proven availability impact. Current event start is earliest supplied update; identity derives from region/product/first supplied update ID and may change if upstream truncates the update window (no verified thread ID). Dated product cells are not exhaustive native history. Hidden banners are not event coverage.'),
      { components, incidents });
    output.evidence.currentIncidentIds = incidents.map(({ sourceIdentity }) => sourceIdentity);
    return output;
  },
};
