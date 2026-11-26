import type { Adapter, AdapterContext, BrowserResponse, Component, ProviderConfig, ServiceStatus, SourceIncident } from '../../shared/contracts.js';
import { coverage, incident, known, record, result, rows, text, worse } from './common.js';
import { businessData, chinaTime, requireCoverage, requireRegions, scopedResponse } from './regional.js';
import { load } from 'cheerio';

const methods = ['listProductRegionInAllZone', 'listProductForAllTypeInRegion', 'listCurrentProductStatus', 'listEventInProgress'] as const;
type Inputs = { regions: unknown; active: unknown; byRegion: Map<string, { catalog: unknown; current: unknown }> };
function endpoint(config: ProviderConfig, method: string, region?: string): string {
  const url = new URL(`/api/status/${method}`, config.officialStatusUrl);
  if (region) url.searchParams.set('regionId', region);
  return url.href;
}
function directory(raw: unknown): Map<string, string> {
  const entries = rows(businessData(raw, 'aliyun'), 'Aliyun zones').flatMap((zone) =>
    rows(record(zone, 'Aliyun zone').regionList, 'Aliyun regions').map((rawRegion) => {
      const region = record(rawRegion, 'Aliyun region');
      return [text(region.regionId, 'Aliyun regionId'), text(region.regionName, 'Aliyun regionName')] as const;
    }));
  requireCoverage(entries.length && new Set(entries.map(([id]) => id)).size === entries.length, 'Aliyun region directory empty or duplicated');
  return new Map(entries);
}

async function browserInputs(config: ProviderConfig, context: AdapterContext): Promise<Inputs> {
  const required = requireRegions(config);
  const matcher = (value: string) => {
    const url = new URL(value);
    return url.origin === new URL(config.officialStatusUrl).origin
      && methods.some((method) => url.pathname === `/api/status/${method}`);
  };
  let responses: BrowserResponse[] = await context.browser.collect(config.id, config.officialStatusUrl, context.signal, matcher);
  const regions = scopedResponse(responses, endpoint(config, methods[0]));
  const names = directory(regions);
  requireCoverage(required.every((region) => names.has(region)), 'Aliyun required region absent from browser directory');
  const missing = required.filter((region) => !responses.some((response) => response.url === endpoint(config, methods[2], region)));
  if (missing.length) {
    responses = [...responses, ...await context.browser.collect(config.id, config.officialStatusUrl, context.signal, matcher, {
      steps: missing.map((region) => ({
        clickText: names.get(region)!,
        waitFor: [{ url: endpoint(config, methods[2], region) }, { url: endpoint(config, methods[1], region) }],
      })),
    })];
  }
  return {
    regions, active: scopedResponse(responses, endpoint(config, methods[3])),
    byRegion: new Map(required.map((region) => [region, {
      catalog: scopedResponse(responses, endpoint(config, methods[1], region)),
      current: scopedResponse(responses, endpoint(config, methods[2], region)),
    }])),
  };
}

function parseInputs(config: ProviderConfig, context: AdapterContext, input: Inputs) {
  const names = directory(input.regions);
  requireCoverage(requireRegions(config).every((region) => names.has(region)), 'Aliyun required region absent from directory');
  const globalEvents = rows(businessData(input.active, 'aliyun'), 'Aliyun global active events');
  const globalIds = globalEvents.map((raw) => String(record(raw, 'Aliyun active event').id));
  requireCoverage(new Set(globalIds).size === globalIds.length, 'Aliyun global active events duplicated');
  const components: Component[] = [];
  const incidentMap = new Map<string, SourceIncident>();
  let reportedStatus: ServiceStatus = 'operational';
  for (const region of config.adapter.requiredRegions) {
    const inputs = input.byRegion.get(region);
    requireCoverage(inputs, 'Aliyun required region current response missing');
    const catalog = rows(businessData(inputs.catalog, 'aliyun'), 'Aliyun categories');
    const local = new Map<string, Component>();
    for (const rawCategory of catalog) {
      const category = record(rawCategory, 'Aliyun category');
      const type = record(category.type, 'Aliyun category type');
      for (const rawProduct of rows(category.productList, 'Aliyun products')) {
        const product = record(rawProduct, 'Aliyun product');
        const id = text(product.productId, 'Aliyun productId');
        requireCoverage(!local.has(id), 'Aliyun catalog product duplicated');
        const component: Component = {
          id: `${config.id}:${region}:${id}`, upstreamId: id, name: text(product.productName, 'Aliyun productName'),
          aliases: [], groupId: `${config.id}:${region}:${text(type.typeId, 'Aliyun typeId')}`,
          region, reportedStatus: 'operational',
        };
        local.set(id, component);
        components.push(component);
      }
    }
    requireCoverage(local.size, 'Aliyun product catalog empty');
    const current = rows(businessData(inputs.current, 'aliyun'), 'Aliyun current status');
    requireCoverage(current.length === 1, 'Aliyun current sparse snapshot absent or ambiguous');
    const snapshot = record(current[0], 'Aliyun current sparse snapshot');
    const details = record(snapshot.eventDetails, 'Aliyun eventDetails');
    const statuses = record(snapshot.productStatus, 'Aliyun productStatus');
    const referencedIds = new Set<string>();
    for (const [productId, rawReferences] of Object.entries(statuses)) {
      const component = local.get(productId);
      requireCoverage(component, 'Aliyun current product absent from catalog');
      for (const rawReference of rows(rawReferences, 'Aliyun product event references')) {
        const reference = record(rawReference, 'Aliyun product event reference');
        const id = text(String(reference.eventId ?? ''), 'Aliyun eventId');
        const detail = details[id];
        requireCoverage(detail && globalIds.includes(id), 'Aliyun current event reference absent from details or global active list');
        referencedIds.add(id);
        const event = record(detail, 'Aliyun event detail');
        requireCoverage(String(event.id) === id, 'Aliyun current event identity conflict');
        const level = known(reference.impactLevel, ['ALARM', 'NORMAL'], 'Aliyun impactLevel');
        const impact: ServiceStatus = level === 'ALARM' ? 'partial_outage' : 'operational';
        component.reportedStatus = worse(component.reportedStatus!, impact);
        reportedStatus = worse(reportedStatus, impact);
        requireCoverage(event.endTime == null || event.endTime === '', 'Aliyun current event already ended');
        const updates = rows(event.eventUpdates, 'Aliyun eventUpdates').map((rawUpdate, index) => {
          const update = record(rawUpdate, 'Aliyun update');
          known(update.severity, ['ALARM', 'NORMAL', 'NOTIFICATION'], 'Aliyun update severity');
          return {
            id: String(update.id ?? `${id}:${index}`), phase: 'unknown' as const,
            timestamp: chinaTime(update.stateDate ?? update.publishTime, 'Aliyun update time'),
            body: typeof (update.detail ?? update.content) === 'string' ? load(String(update.detail ?? update.content)).text().trim() : '',
          };
        }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        requireCoverage(updates.length, 'Aliyun current event updates absent');
        const startedAt = chinaTime(event.startTime, 'Aliyun event startTime');
        requireCoverage(updates[0]!.timestamp >= startedAt, 'Aliyun update precedes event start');
        const prior = incidentMap.get(id);
        if (prior) {
          prior.affectedComponentIds.push(component.id);
          prior.affectedRegions = [...new Set([...prior.affectedRegions, region])];
          prior.severity = impact === 'operational' ? prior.severity : impact;
          if (impact !== 'operational') prior.kind = 'incident';
        } else {
          incidentMap.set(id, incident(config, context.now, id, text(event.title, 'Aliyun event title'),
            startedAt, updates.at(-1)!.timestamp, {
              state: 'unknown', sourceSeverity: level, severity: impact === 'operational' ? null : impact,
              kind: level === 'NORMAL' ? 'advisory' : 'incident', severityBasis: 'component',
              affectedComponentIds: [component.id], affectedRegions: [region], updates,
              sourceUrl: new URL(`/#/eventDetail?eventId=${encodeURIComponent(id)}`, config.officialStatusUrl).href,
            }));
        }
      }
    }
    requireCoverage(Object.keys(details).every((id) => referencedIds.has(id)), 'Aliyun event details contain unresolved product coverage');
  }
  requireCoverage(globalIds.every((id) => incidentMap.has(id)), 'Aliyun global active event has no verified region association within declared scope');
  const incidents = [...incidentMap.values()];
  const output = result(config, context.now, reportedStatus, ['region_directory', 'per_region_catalog', 'sparse_current_event_maps', 'global_active_events'],
    coverage(config, 'full', 'none',
      'Complete only for declared requiredRegions, a subset of the upstream directory. Official frontend overlays sparse current maps on the full regional catalog; absent entries are normal after successful event checks. Historical cells are not imported. Unmapped global active events fail closed.'),
    { components, incidents });
  output.evidence.currentIncidentIds = incidents.map(({ sourceIdentity }) => sourceIdentity);
  return output;
}

export const aliyunAdapter: Adapter = {
  async collect(config, context) {
    const required = requireRegions(config);
    try {
      const regions = await context.http.getJson(endpoint(config, methods[0]), context.signal);
      directory(regions);
      const active = await context.http.getJson(endpoint(config, methods[3]), context.signal);
      const byRegion = new Map<string, { catalog: unknown; current: unknown }>();
      for (const region of required) {
        const [catalog, current] = await Promise.all([
          context.http.getJson(endpoint(config, methods[1], region), context.signal),
          context.http.getJson(endpoint(config, methods[2], region), context.signal),
        ]);
        byRegion.set(region, { catalog, current });
      }
      return parseInputs(config, context, { regions, active, byRegion });
    } catch (error) {
      if (!config.adapter.browserFallback || context.signal.aborted) throw error;
      return parseInputs(config, context, await browserInputs(config, context));
    }
  },
};
