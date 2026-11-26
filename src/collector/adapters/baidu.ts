import type { Adapter, Component, ServiceStatus, SourceIncident } from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
import { coverage, incident, known, record, result, rows, text, worse } from './common.js';
import { businessData, chinaTime, digestIdentity, requireCoverage, requireRegions, scopedResponse } from './regional.js';

function nativeStatus(raw: unknown): ServiceStatus {
  const state = known(raw, ['ok', 'info', 'error'], 'Baidu current status');
  return state === 'error' ? 'partial_outage' : 'operational';
}

export const baiduAdapter: Adapter = {
  async collect(config, context) {
    const required = requireRegions(config);
    if (!config.adapter.browserFallback) throw new AdapterError('blocked', 'Baidu public API requires ordinary page-owned requests');
    const endpoint = (name: string) => new URL(`/dashboard/v1/${name}`, config.officialStatusUrl).href;
    const urls = ['get_region', 'get_prod_by_region', 'get_event_info', 'get_banner'].map(endpoint);
    const responses = await context.browser.collect(config.id, config.officialStatusUrl, context.signal,
      (url) => urls.includes(url), {
        requestScopeFields: ['region'],
        // The homepage selects Beijing. Other configured scopes are selected through normal UI.
        steps: required.filter((region) => region !== '华北-北京').map((region) => ({
          clickText: region, waitFor: [
            { url: endpoint('get_event_info'), requestFields: { region } },
            { url: endpoint('get_prod_by_region'), requestFields: { region } },
          ],
        })),
      });
    const rawRegions = businessData(scopedResponse(responses, endpoint('get_region')), 'baidu');
    let decoded: unknown;
    try { decoded = JSON.parse(text(rawRegions, 'Baidu encoded regions')) as unknown; }
    catch { throw new AdapterError('invalid_payload', 'Baidu encoded region directory malformed'); }
    const regions = rows(decoded, 'Baidu region directory').map((region) => text(region, 'Baidu region'));
    requireCoverage(regions.length && new Set(regions).size === regions.length && required.every((region) => regions.includes(region)),
      'Baidu required region absent from directory');
    const components: Component[] = [];
    const incidentMap = new Map<string, SourceIncident>();
    const currentIds = new Set<string>();
    let reportedStatus: ServiceStatus = 'operational';
    let hasNativeHistory = true;
    for (const region of required) {
      const catalog = rows(businessData(scopedResponse(responses, endpoint('get_prod_by_region'), { region }), 'baidu'),
        'Baidu regional products').map((raw) => text(raw, 'Baidu product name'));
      requireCoverage(catalog.length && new Set(catalog).size === catalog.length, 'Baidu product directory empty or duplicated');
      const snapshot = record(businessData(scopedResponse(responses, endpoint('get_event_info'), { region }), 'baidu'), 'Baidu current data');
      const products = rows(snapshot.event, 'Baidu product event rows');
      const counts = { ok: 0, error: 0, info: 0 };
      const seen = new Set<string>();
      for (const rawProduct of products) {
        const product = record(rawProduct, 'Baidu product event');
        hasNativeHistory &&= Object.keys(product).some((key) => /^\d{4}-\d\d-\d\d$/.test(key));
        const name = text(product.product, 'Baidu product');
        requireCoverage(product.region === region && catalog.includes(name) && !seen.has(name), 'Baidu product/region coverage conflict');
        seen.add(name);
        const nowtime = record(product.nowtime, 'Baidu nowtime');
        const native = known(nowtime.status, ['ok', 'info', 'error'], 'Baidu current status');
        counts[native]++;
        const status = nativeStatus(native);
        reportedStatus = worse(reportedStatus, status);
        const upstreamId = digestIdentity(config.id, region, name);
        const component: Component = {
          id: `${config.id}:${upstreamId}`, upstreamId, name, aliases: [], region, groupId: null, reportedStatus: status,
        };
        components.push(component);
        for (const [key, rawCell] of Object.entries(product)) {
          if (key !== 'nowtime' && !/^\d{4}-\d\d-\d\d$/.test(key)) continue;
          const cell = record(rawCell, 'Baidu event cell');
          const impact = nativeStatus(cell.status);
          if (cell.status === 'ok') continue;
          const startedAt = chinaTime(cell.s_time, 'Baidu event s_time');
          const endedAt = cell.e_time === '' || cell.e_time == null ? null : chinaTime(cell.e_time, 'Baidu event e_time');
          requireCoverage(!endedAt || endedAt >= startedAt, 'Baidu event ends before it starts');
          const isCurrent = key === 'nowtime';
          requireCoverage(!isCurrent || !endedAt, 'Baidu nowtime reports a finished event as abnormal');
          const title = text(cell.title, 'Baidu event title');
          const id = digestIdentity(config.id, region, name, startedAt, title);
          const entry = incident(config, context.now, id, title, startedAt, endedAt ?? startedAt, {
            affectedComponentIds: [component.id], affectedRegions: [region],
            state: endedAt ? 'resolved' : 'unknown', resolvedAt: endedAt,
            sourceSeverity: String(cell.status), severity: impact === 'operational' ? null : impact,
            kind: cell.status === 'info' ? 'advisory' : 'incident',
            severityBasis: 'component', updates: [
              { id: `${id}:start`, phase: 'unknown', timestamp: startedAt, body: typeof cell.s_msg === 'string' ? cell.s_msg : '' },
              ...(endedAt ? [{ id: `${id}:end`, phase: 'resolved' as const, timestamp: endedAt,
                body: typeof cell.e_msg === 'string' ? cell.e_msg : '' }] : []),
            ],
          });
          if (!incidentMap.has(id) || isCurrent) incidentMap.set(id, entry);
          if (isCurrent) currentIds.add(entry.sourceIdentity);
        }
      }
      requireCoverage(seen.size === catalog.length, 'Baidu current rows do not cover product catalog');
      requireCoverage(snapshot.event_ok === counts.ok && snapshot.event_error === counts.error && snapshot.event_info === counts.info,
        'Baidu counters conflict with initialized nowtime rows');
    }
    const incidents = [...incidentMap.values()];
    const output = result(config, context.now, reportedStatus, ['region_directory', 'scoped_product_catalog', 'scoped_nowtime_rows_and_counts'],
      coverage(config, 'full', hasNativeHistory ? 'native' : 'none',
        'Complete only for declared requiredRegions, a subset of the public directory. Product identity is a stable digest of source/region/name because upstream supplies no product ID; renames change identity. nowtime establishes current state; dated cells provide finite history only. Hidden banners are ignored.'),
      { components, incidents });
    output.coverage.nativeHistoryEarliestAt = incidents.reduce<string | null>((min, entry) =>
      min === null || entry.startedAt < min ? entry.startedAt : min, null);
    output.evidence.currentIncidentIds = [...currentIds];
    return output;
  },
};
