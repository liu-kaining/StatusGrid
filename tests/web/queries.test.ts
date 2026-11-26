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
  it('shares a day request without letting one consumer cancel another and caches its result', async () => {
    const client = createDataClient({ fetcher });
    await client.loadSnapshot(signal());
    const first = new AbortController();
    const one = client.loadDayHistory(fixture.summary.snapshotId, first.signal);
    const two = client.loadDayHistory(fixture.summary.snapshotId, signal());
    first.abort();
    await expect(one).rejects.toMatchObject({ name: 'AbortError' });
    const events = await two;
    expect(events.some(({ providerId }) => providerId === 'openai')).toBe(true);
    expect(await client.loadDayHistory(fixture.summary.snapshotId, signal())).toEqual(events);
    expect(requested.filter((path) => path === fixture.manifest.paths.recentIncidents)).toHaveLength(1);
  });

  it('retries failed day history and keeps snapshots separate', async () => {
    const client = createDataClient({ fetcher });
    await client.loadSnapshot(signal());
    const path = fixture.manifest.paths.recentIncidents.slice(1);
    delete files[path];
    await expect(client.loadDayHistory(fixture.summary.snapshotId, signal())).rejects.toThrow();
    files[path] = fixture.recent;
    const events = await client.loadDayHistory(fixture.summary.snapshotId, signal());
    expect(events.length).toBeGreaterThan(0);
    const newer = webFixture('2026-11-26T08:05:00.000Z');
    Object.assign(files, newer.files);
    await client.loadSnapshot(signal());
    const next = await client.loadDayHistory(newer.summary.snapshotId, signal());
    expect(next.find(({ resolvedAt }) => !resolvedAt)?.lastObservedAt).toBe(newer.summary.generatedAt);
    expect(events.find(({ resolvedAt }) => !resolvedAt)?.lastObservedAt).toBe(fixture.summary.generatedAt);
  });

  it('preserves snapshot-change errors for shared day callers and loads only the refreshed publication', async () => {
    const client = createDataClient({ fetcher });
    await client.loadSnapshot(signal());
    delete files[fixture.manifest.paths.recentIncidents.slice(1)];
    const next = webFixture('2026-11-26T08:05:00.000Z');
    next.recent.incidents.find(({ providerId, resolvedAt }) => providerId === 'openai' && !resolvedAt)!.title = 'New publication event';
    Object.assign(files, next.files);
    const results = await Promise.allSettled([
      client.loadDayHistory(fixture.summary.snapshotId, signal()),
      client.loadDayHistory(fixture.summary.snapshotId, signal()),
    ]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(SnapshotChangedError);
    }
    const summary = await client.loadSnapshot(signal());
    const events = await client.loadDayHistory(summary.snapshotId, signal());
    expect(summary.snapshotId).toBe(next.summary.snapshotId);
    expect(events.find(({ title }) => title === 'New publication event')?.lastObservedAt).toBe('2026-11-26T08:05:00.000Z');
  });

  it('retains cross-month cold events through the versioned archive index', async () => {
    const month = fixture.archiveIndex.months[0]!;
    // Explicit cold-only fixture: an October event restored in the November track window.
    const archive = structuredClone(fixture.archives[0]!);
    archive.incidents[0]!.resolvedAt = '2026-11-01T00:05:00Z';
    archive.incidents[0]!.lastObservedAt = '2026-11-01T00:05:00Z';
    const index = structuredClone(fixture.archiveIndex);
    index.months[0]!.maxResolvedAt = '2026-11-01T00:05:00Z';
    files[month.path.slice(1)] = archive;
    files[fixture.manifest.paths.archiveIndex.slice(1)] = index;
    const events = await createDataClient({ fetcher }).loadDayHistory(fixture.summary.snapshotId, signal());
    expect(events.find(({ title }) => title === 'October API interruption')?.resolvedAt).toBe('2026-11-01T00:05:00Z');
  });

  it('retains only two completed day snapshots and reloads an evicted version', async () => {
    const client = createDataClient({ fetcher });
    for (const at of ['2026-11-26T08:00:00.000Z', '2026-11-26T08:05:00.000Z', '2026-11-26T08:10:00.000Z']) {
      const next = webFixture(at);
      Object.assign(files, next.files);
      await client.loadSnapshot(signal());
      await client.loadDayHistory(next.summary.snapshotId, signal());
    }
    await client.loadDayHistory(fixture.summary.snapshotId, signal());
    expect(requested.filter((path) => path === fixture.manifest.paths.recentIncidents)).toHaveLength(2);
  });

  it('releases the owned request when every consumer cancels and allows another attempt', async () => {
    let ownedSignal: AbortSignal | null | undefined;
    let hold = true;
    const delayed: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/incidents/recent.json') && hold) {
        ownedSignal = init?.signal;
        await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
      }
      return fetcher(input, init);
    };
    const client = createDataClient({ fetcher: delayed });
    await client.loadSnapshot(signal());
    const controller = new AbortController();
    const pending = client.loadDayHistory(fixture.summary.snapshotId, controller.signal);
    await vi.waitFor(() => expect(ownedSignal).toBeTruthy());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect((ownedSignal as AbortSignal | undefined)?.aborted).toBe(true);
    hold = false;
    expect((await client.loadDayHistory(fixture.summary.snapshotId, signal())).length).toBeGreaterThan(0);
  });

  it('transfers an in-flight hover request to a day page in the same navigation turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed: typeof fetch = async (input, init) => {
      const result = await fetcher(input, init);
      if (String(input).endsWith('/incidents/recent.json')) {
        await gate;
        init?.signal?.throwIfAborted();
      }
      return result;
    };
    const client = createDataClient({ fetcher: delayed });
    await client.loadSnapshot(signal());
    const controller = new AbortController();
    const hover = client.loadDayHistory(fixture.summary.snapshotId, controller.signal);
    await vi.waitFor(() => expect(requested).toContain(fixture.manifest.paths.recentIncidents));
    controller.abort();
    const page = client.loadDayHistory(fixture.summary.snapshotId, signal());
    release();
    await expect(hover).rejects.toMatchObject({ name: 'AbortError' });
    expect((await page).length).toBeGreaterThan(0);
    expect(requested.filter((path) => path === fixture.manifest.paths.recentIncidents)).toHaveLength(1);
  });
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
