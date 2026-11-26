import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { buildPublicArtifacts } from '../../src/collector/export/json.js';
import { emptyState } from '../../src/collector/events/reconcile.js';
import { advance, run, source, time } from '../helpers/history.js';

describe('persisted lifecycle feeds', () => {
  it('emits one stable trigger, escalation and resolution, with no wording or retry spam', () => {
    const initial = source();
    let collection = run(time(0), 'degraded', [initial]);
    let state = advance(emptyState(), collection);
    collection = run(time(5), 'degraded', [{ ...initial, title: 'New words', updatedAt: time(5) }]);
    state = advance(state, collection);
    expect(buildPublicArtifacts(collection, state).feeds['feed/all.xml']?.match(/<item>/g)).toHaveLength(1);
    collection = run(time(10), 'major_outage', [{ ...initial, severity: 'major_outage', updatedAt: time(10),
      updates: [{ id: 'update-major', phase: 'identified', body: 'Escalated', timestamp: time(10) }] }]);
    state = advance(state, collection);
    state = advance(state, collection);
    collection = run(time(15), 'operational', [{ ...initial, state: 'resolved', resolvedAt: time(15),
      resolvedTimeBasis: 'source', updatedAt: time(15) }], []);
    state = advance(state, collection);
    const feeds = buildPublicArtifacts(collection, state).feeds;
    const rss = new XMLParser().parse(feeds['feed/all.xml']!).rss.channel.item;
    expect(rss.map((item: { guid: string }) => item.guid).sort()).toEqual([
      'github:native:episode:1:escalated:update-major', 'github:native:episode:1:resolved',
      'github:native:episode:1:triggered',
    ]);
    expect(feeds['feed/provider/github.xml']?.match(/<item>/g)).toHaveLength(3);
    expect(feeds['feed/category/infra.xml']?.match(/<item>/g)).toHaveLength(3);
    expect(feeds['feed/category/ai.xml']).not.toContain('<item>');
    expect(feeds['feed/atom.xml']?.match(/<entry>/g)).toHaveLength(3);
  });

  it('escapes text and URL attributes in valid RSS/Atom and identifies fixture output', () => {
    const collection = run(time(0), 'degraded', [source({
      title: 'API & "Apps" <broken>',
      sourceUrl: 'https://www.githubstatus.com/incidents/native?x=1&y=2',
      updates: [{ id: 'u', phase: 'identified', body: 'A & B <script>alert(1)</script>', timestamp: time(0) }],
    })]);
    const artifacts = buildPublicArtifacts(collection, advance(emptyState(), collection), { dataMode: 'fixture' });
    for (const feed of Object.values(artifacts.feeds)) {
      expect(XMLValidator.validate(feed)).toBe(true);
      expect(feed).toContain('fixture');
      expect(feed).not.toContain('<script>');
    }
    expect(artifacts.feeds['feed/atom.xml']).toContain('x=1&amp;y=2');
    expect(artifacts.feeds['feed/all.xml']).toContain('API &amp;');
  });
});
