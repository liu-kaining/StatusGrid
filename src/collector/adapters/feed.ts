import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AdapterError } from '../errors.js';
import { record, text, timestamp } from './common.js';

export interface FeedEntry {
  id: string;
  title: string;
  url: string | null;
  updatedAt: string;
  body: string;
}
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
  processEntities: false, htmlEntities: false, trimValues: true });

function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
function bodyText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null && '#text' in raw && typeof raw['#text'] === 'string') return raw['#text'];
  return '';
}
export function parseFeed(xml: string, format: 'atom' | 'rss'): FeedEntry[] {
  if (typeof xml !== 'string' || XMLValidator.validate(xml) !== true || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new AdapterError('invalid_payload', 'Invalid XML feed');
  }
  const root = record(parser.parse(xml), 'feed');
  const data = format === 'rss' ? record(record(root.rss, 'rss').channel, 'rss.channel') : record(root.feed, 'atom.feed');
  const rawEntries = format === 'rss' ? data.item : data.entry;
  const entries = rawEntries == null ? [] : Array.isArray(rawEntries) ? rawEntries : [rawEntries];
  return entries.map((raw, index) => {
    const item = record(raw, 'feed.entry');
    const id = format === 'rss' ? item.guid ?? item.link : item.id;
    const link = format === 'rss' ? item.link
      : typeof item.link === 'object' && item.link !== null ? record(item.link, 'atom.link')['@_href'] : null;
    return {
      id: text(typeof id === 'object' && id !== null ? record(id, 'feed.id')['#text'] : id, `feed.entry[${index}].id`),
      title: text(bodyText(item.title), `feed.entry[${index}].title`),
      url: safeUrl(link),
      updatedAt: timestamp(format === 'rss' ? item.pubDate : item.updated, `feed.entry[${index}].date`),
      body: bodyText(format === 'rss' ? item.description : item.content ?? item.summary),
    };
  });
}
