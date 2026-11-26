import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDataClient, SnapshotChangedError } from '../../src/web/data/client.js';
import { webFixture } from '../helpers/web-fixture.js';
import { run, advance, time } from '../helpers/history.js';
import { emptyState } from '../../src/collector/events/reconcile.js';
import { buildPublicArtifacts } from '../../src/collector/export/json.js';

const fixture = webFixture();
let requested: string[] = [];
let files: Record<string, unknown>;
const signal = () => new AbortController().signal;
const fetcher: typeof fetch = async (input, init) => {
  init?.signal?.throwIfAborted();
  const path = String(input);
  requested.push(path);
  return files[path.slice(1)] === undefined ? new Response('missing', { status: 404 })
    : Response.json(files[path.slice(1)]);
};
beforeEach(() => { files = structuredClone(fixture.files); requested = []; });

describe('versioned browser client', () => {
  it('loads summary first, lazily loads checked details, and passes cancellation', async () => {
    const client = createDataClient({ fetcher });
    const summary = await client.loadSnapshot(signal());
    expect(requested).toEqual(['/api/v1/manifest.json', fixture.manifest.paths.summary]);
    const detail = await client.loadProvider('openai', summary.snapshotId, signal());
    expect(detail.provider.id).toBe('openai');
    expect(requested.at(-1)).toBe(fixture.manifest.paths.providers.openai);
    const controller = new AbortController(); controller.abort();
    await expect(client.loadSnapshot(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rechecks manifest once on invalid snapshot and rejects an untrusted replacement', async () => {
    files[fixture.manifest.paths.summary.slice(1)] = { ...fixture.summary, snapshotId: 'wrong' };
    const client = createDataClient({ fetcher });
    await expect(client.loadSnapshot(signal())).rejects.toThrow(/快照|snapshot/i);
    expect(requested.filter((path) => path === '/api/v1/manifest.json')).toHaveLength(2);
  });

  it('does not silently mix a newly discovered snapshot into an old provider detail', async () => {
    const client = createDataClient({ fetcher });
    await client.loadSnapshot(signal());
    delete files[fixture.manifest.paths.providers.openai!.slice(1)];
    const newer = webFixture('2026-11-26T08:05:00.000Z');
    Object.assign(files, newer.files);
    await expect(client.loadProvider('openai', fixture.summary.snapshotId, signal())).rejects.toBeInstanceOf(SnapshotChangedError);
  });

  it('shows missing archive index as an error; empty index is ordinary empty history', async () => {
    const client = createDataClient({ fetcher });
    await client.loadSnapshot(signal());
    delete files[fixture.manifest.paths.archiveIndex.slice(1)];
    await expect(client.loadHistory({ range: '90d' }, signal())).rejects.toThrow();
    expect(requested.filter((path) => path === '/api/v1/manifest.json')).toHaveLength(2);
    const collection = run(time(0), 'operational');
    const empty = buildPublicArtifacts(collection, advance(emptyState(), collection), { dataMode: 'fixture' });
    files = empty.files;
    expect(empty.archiveIndex.generatedAt).toBeNull();
    await expect(createDataClient({ fetcher }).loadHistory({ range: '90d' }, signal())).resolves.toEqual([]);
  });

  it('uses the archive index across months, deduplicates events and keeps active older incidents', async () => {
    const client = createDataClient({ fetcher });
    const events = await client.loadHistory({ range: '90d' }, signal());
    expect(events.some(({ title }) => title === 'October API interruption')).toBe(true);
    expect(events.some(({ resolvedAt }) => resolvedAt === null)).toBe(true);
    expect(new Set(events.map(({ id }) => id)).size).toBe(events.length);
    expect(requested.some((path) => path.includes('/archive/') && !path.includes('/indexes/'))).toBe(true);
  });

  it('rejects shape-invalid search and archive revisions rather than using partial data', async () => {
    const client = createDataClient({ fetcher });
    const summary = await client.loadSnapshot(signal());
    files[fixture.manifest.paths.search.slice(1)] = { schemaVersion: '1.0', providers: [] };
    await expect(client.loadSearch(summary.snapshotId, signal())).rejects.toThrow();
    const month = fixture.archiveIndex.months[0]!;
    files[month.path.slice(1)] = { ...fixture.archives[0], revision: 'a'.repeat(24) };
    await expect(client.loadHistory({ range: '90d' }, signal())).rejects.toThrow(/revision|版本/);
  });

  it('does not retry aborted requests', async () => {
    const abortedFetch = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    const client = createDataClient({ fetcher: abortedFetch });
    await expect(client.loadSnapshot(signal())).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedFetch).toHaveBeenCalledTimes(1);
  });

  it('never splices relocated history into an already displayed old summary', async () => {
    const client = createDataClient({ fetcher });
    const summary = await client.loadSnapshot(signal());
    delete files[fixture.manifest.paths.recentIncidents.slice(1)];
    Object.assign(files, webFixture('2026-11-26T08:05:00.000Z').files);
    await expect(client.loadHistory({ range: '90d', snapshotId: summary.snapshotId }, signal()))
      .rejects.toBeInstanceOf(SnapshotChangedError);
  });

  it('rejects a valid-looking search index that omits configured providers', async () => {
    const client = createDataClient({ fetcher });
    await client.loadSnapshot(signal());
    files[fixture.manifest.paths.search.slice(1)] = { ...fixture.search, providers: [] };
    await expect(client.loadSearch(fixture.summary.snapshotId, signal())).rejects.toThrow(/索引/);
  });
});
