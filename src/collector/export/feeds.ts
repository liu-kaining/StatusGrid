import type { Envelope, ProviderConfig } from '../../shared/contracts.js';
import type { PersistedState } from '../types.js';

export function escapeXml(value: string): string {
  return Array.from(value).filter((character) => character.charCodeAt(0) >= 32 || '\t\n\r'.includes(character)).join('')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildFeeds(state: PersistedState, envelope: Envelope, configs: ProviderConfig[]): Record<string, string> {
  const entries = [...state.ledger.milestones].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .flatMap((milestone) => {
      const incident = state.incidents.find((item) => state.ledger.aliases[item.id] === milestone.incidentId && !item.supersededBy)
        ?? state.incidents.find(({ id }) => id === milestone.incidentId);
      if (!incident) throw new Error(`Missing feed lifecycle ${milestone.incidentId}`);
      const config = configs.find(({ id }) => id === incident.providerId);
      if (!config) return [];
      const body = incident.updates.filter(({ timestamp }) => Date.parse(timestamp) <= Date.parse(milestone.at)).at(-1)?.body ?? '';
      return [{ id: milestone.id, at: milestone.at, providerId: incident.providerId, category: config.category,
        title: `${config.name}: ${incident.title} (${milestone.kind})`, body, url: incident.sourceUrl }];
    });
  const metadata = `xmlns:sg="urn:statusgrid:v1" sg:schemaVersion="1.0" sg:snapshotId="${escapeXml(envelope.snapshotId)}" sg:dataMode="${envelope.dataMode}"`;
  const rss = (subset: typeof entries, title: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" ${metadata}><channel><title>${escapeXml(title)}</title><link>/</link><description>StatusGrid lifecycle milestones</description><lastBuildDate>${new Date(envelope.generatedAt).toUTCString()}</lastBuildDate>${subset.map((entry) =>
      `<item><guid isPermaLink="false">${escapeXml(entry.id)}</guid><title>${escapeXml(entry.title)}</title><link>${escapeXml(entry.url)}</link><pubDate>${new Date(entry.at).toUTCString()}</pubDate><description>${escapeXml(entry.body)}</description></item>`).join('')}</channel></rss>\n`;
  const feeds: Record<string, string> = {
    'feed/all.xml': rss(entries, 'StatusGrid'),
    'feed/atom.xml': `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" ${metadata}><id>urn:statusgrid:all</id><title>StatusGrid</title><updated>${envelope.generatedAt}</updated><link href="/feed/atom.xml" rel="self"/>${entries.map((entry) =>
      `<entry><id>${escapeXml(entry.id)}</id><title>${escapeXml(entry.title)}</title><updated>${entry.at}</updated><link href="${escapeXml(entry.url)}"/><content type="text">${escapeXml(entry.body)}</content></entry>`).join('')}</feed>\n`,
  };
  for (const category of ['ai', 'cloud-cn', 'cloud-global', 'infra']) {
    feeds[`feed/category/${category}.xml`] = rss(entries.filter((entry) => entry.category === category), `StatusGrid: ${category}`);
  }
  for (const config of configs) {
    feeds[`feed/provider/${config.id}.xml`] = rss(entries.filter((entry) => entry.providerId === config.id), `StatusGrid: ${config.name}`);
  }
  return feeds;
}
