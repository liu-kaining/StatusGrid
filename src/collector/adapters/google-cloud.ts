import type { Adapter, AdapterResult, ProviderConfig, ServiceStatus } from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
import { TransportError } from '../errors.js';
import type { AdapterContext } from '../../shared/contracts.js';
import { coverage, incident, known, record, result, rows, text, timestamp, worse } from './common.js';

const impacts = ['SERVICE_INFORMATION', 'SERVICE_DISRUPTION', 'SERVICE_OUTAGE'] as const;
const severities = ['low', 'medium', 'high'] as const;
const severityByImpact: Record<(typeof impacts)[number], ServiceStatus> = {
  SERVICE_INFORMATION: 'operational', SERVICE_DISRUPTION: 'degraded', SERVICE_OUTAGE: 'major_outage',
};

function regions(raw: unknown, label: string): string[] {
  return rows(raw, label).map((entry) => text(record(entry, label).id, `${label}.id`));
}

export function parseGoogleCloud(config: ProviderConfig, incidentsPayload: unknown, productsPayload: unknown, now: string): AdapterResult {
  if (productsPayload === null) throw new AdapterError('coverage_incomplete', 'Google Cloud product dictionary unavailable');
  const products = rows(record(productsPayload, 'products').products, 'products.products');
  if (!products.length) throw new AdapterError('coverage_incomplete', 'Google Cloud product dictionary empty');
  const productNames = new Map(products.map((raw) => {
    const entry = record(raw, 'product');
    return [text(entry.id, 'product.id'), text(entry.title, 'product.title')] as const;
  }));
  const incidents = rows(incidentsPayload, 'incidents');
  let reportedStatus: ServiceStatus = 'operational';
  const currentIds: string[] = [];
  const normalized = incidents.map((raw) => {
    const item = record(raw, 'incident');
    const id = text(item.id, 'incident.id');
    const begin = timestamp(item.begin, 'incident.begin');
    const end = item.end == null ? null : timestamp(item.end, 'incident.end');
    const updated = timestamp(item.modified ?? item.created ?? item.begin, 'incident.modified');
    const impact = known(item.status_impact, impacts, 'incident.status_impact');
    const severity = item.severity == null ? null : known(item.severity, severities, 'incident.severity');
    const activeRegions = regions(item.currently_affected_locations ?? [], 'currently_affected_locations');
    const pastRegions = regions(item.previously_affected_locations ?? [], 'previously_affected_locations');
    const affectedProducts = rows(item.affected_products ?? [], 'incident.affected_products').map((entry) => {
      const product = record(entry, 'affected product');
      const key = text(product.id, 'affected product id');
      if (!productNames.has(key)) throw new AdapterError('coverage_incomplete', `Google Cloud product ${key} is not in dictionary`);
      return `${config.id}:${key}`;
    });
    const state = end ? 'resolved' : impact === 'SERVICE_INFORMATION' ? 'unknown' : 'investigating';
    const sourceUrl = typeof item.uri === 'string'
      ? new URL(item.uri.replace(/^\//, ''), config.officialStatusUrl).href : config.officialStatusUrl;
    if (!end && impact !== 'SERVICE_INFORMATION') {
      currentIds.push(`${config.id}:${id}`);
      reportedStatus = worse(reportedStatus, severityByImpact[impact]);
    }
    return incident(config, now, id, text(item.external_desc ?? item.service_name, 'incident description'), begin, updated, {
      state, kind: impact === 'SERVICE_INFORMATION' ? 'advisory' : 'incident',
      severity: impact === 'SERVICE_INFORMATION' ? null : severityByImpact[impact] as Exclude<ServiceStatus, 'operational'>,
      sourceSeverity: severity ?? impact, severityBasis: impact === 'SERVICE_INFORMATION' ? 'unknown' : 'source',
      affectedRegions: end ? [...new Set([...activeRegions, ...pastRegions])] : activeRegions,
      affectedComponentIds: affectedProducts,
      resolvedAt: end, sourceUrl,
    });
  });
  const earliest = normalized.reduce<string | null>((min, entry) => min === null || entry.startedAt < min ? entry.startedAt : min, null);
  const output = result(config, now, reportedStatus, ['incidents', 'products'],
    { ...coverage(config, 'events_only', 'native', 'Finite incidents endpoint; currently affected and previously affected regions are distinct'),
      nativeHistoryEarliestAt: earliest },
    { incidents: normalized });
  output.evidence.currentIncidentIds = currentIds;
  return output;
}

export const googleCloudAdapter: Adapter = {
  async collect(config, context) {
    const incidentsUrl = config.adapter.endpoints.incidents;
    const productsUrl = config.adapter.endpoints.products;
    if (!incidentsUrl || !productsUrl) throw new AdapterError('coverage_incomplete', 'Google Cloud endpoints missing');
    const json = async (url: string): Promise<unknown> => {
      try { return await context.http.getJson(url, context.signal); }
      catch (error) {
        if (!config.adapter.browserFallback || !(error instanceof TransportError)
          || error.kind === 'cancelled' || error.kind === 'invalid_payload') throw error;
        return browserJson(context, config.id, url);
      }
    };
    const [incidents, products] = await Promise.all([json(incidentsUrl), json(productsUrl)]);
    return parseGoogleCloud(config, incidents, products, context.now);
  },
};

async function browserJson(context: AdapterContext, providerId: string, url: string): Promise<unknown> {
  const responses = await context.browser.collect(providerId, url, context.signal, (captured) => captured === url);
  const response = responses.find((entry) => entry.url === url && entry.status === 200);
  if (!response) throw new AdapterError('coverage_incomplete', `Google Cloud browser response unavailable: ${url}`);
  try { return JSON.parse(response.body) as unknown; }
  catch { throw new AdapterError('invalid_payload', `Google Cloud browser response invalid: ${url}`); }
}
