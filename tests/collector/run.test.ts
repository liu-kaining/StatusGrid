import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import registry from '../../registry/providers.json';
import github from '../fixtures/statuspage/github/summary.json';
import gcpIncidents from '../fixtures/gcp/incidents.json';
import gcpProducts from '../fixtures/gcp/products.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { collectProviders, runPersistentCollection } from '../../src/collector/run.js';
import { loadState } from '../../src/collector/storage/load.js';
import { TransportError } from '../../src/collector/errors.js';
import { createHttpClient } from '../../src/collector/http.js';
import type { CollectionContext } from '../../src/collector/types.js';
import type { ProviderConfig } from '../../src/shared/contracts.js';
import { time, run as fixtureRun, source } from '../helpers/history.js';
import { validateAdapterResult } from '../../src/collector/storage/validate.js';
import { buildPublicArtifacts } from '../../src/collector/export/json.js';
import { writePublicArtifacts } from '../../src/collector/export/manifest.js';
import { validateRelease } from '../../src/collector/export/validate.js';

const configs = parseRegistry(registry);
const config = configs.find(({ id }) => id === 'github')!;
const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function context(at: string, componentStatus = 'operational', failed = false): CollectionContext {
  return {
    now: at, intervalMinutes: 5, signal: new AbortController().signal,
    clock: { now: () => at, monotonic: () => 0 },
    http: {
      getJson: async (url) => {
        if (failed) throw new TransportError('timeout', 'offline');
        if (url.includes('incidents') || url.includes('unresolved')) return { incidents: [] };
        return { ...github, components: github.components.map((component) => ({ ...component, status: componentStatus })) };
      },
      getText: async () => '', getResponse: async () => { throw new Error('unused'); },
    },
    browser: { collect: async () => [], close: async () => {} },
  };
}

describe('production collection and persistence boundary', () => {
  it.each(['provider', 'component', 'duplicate', 'incident', 'current', 'timestamp', 'lifecycle'])(
    'rejects malformed %s candidate before trust', (kind) => {
      const candidate = structuredClone(fixtureRun(time(0), 'degraded', [source()]).providers[0]!.result!);
      if (kind === 'provider') candidate.providerId = 'gcp';
      if (kind === 'component') candidate.components[0]!.id = 'gcp:api';
      if (kind === 'duplicate') candidate.components.push(candidate.components[0]!);
      if (kind === 'incident') candidate.incidents[0]!.sourceIdentity = 'gcp:native';
      if (kind === 'current') candidate.evidence.currentIncidentIds = ['github:absent'];
      if (kind === 'timestamp') candidate.sourceUpdatedAt = 'not-a-time';
      if (kind === 'lifecycle') candidate.incidents[0]!.resolvedAt = '2026-11-25T11:00:00Z';
      expect(() => validateAdapterResult(candidate, 'github')).toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
    },
  );
  it('rejects invalid closure rereads without advancing the stored legacy observation bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'statusgrid-closure-evidence-test-'));
    temporary.push(root);
    const dir = join(root, 'state');
    const row = { id: 'closed-unknown', name: 'Resolved issue', status: 'resolved', impact: 'minor',
      started_at: '2026-11-20T12:00:00Z', created_at: '2026-11-20T12:00:00Z',
      resolved_at: null, updated_at: '2026-11-20T13:00:00Z' };
    for (const minute of [0, 5, 10]) {
      const ctx = context(time(minute));
      const original = ctx.http.getJson;
      ctx.http.getJson = async (url, signal) => url.includes('incidents.json')
        ? { incidents: [{ ...row, updated_at: minute === 0 ? row.updated_at : '2026-11-19T12:00:00Z' }] }
        : original(url, signal);
      const result = await runPersistentCollection([config], ctx, dir);
      expect(result.state.incidents[0]).toMatchObject({
        resolvedAt: null, resolvedTimeBasis: null, durationMinutes: null, lastObservedAt: time(0),
      });
      if (minute > 0) expect(result.run.providers[0]?.collection).toMatchObject({ freshness: 'fresh', outcome: 'partial' });
      expect(result.state.dailyStats.github?.at(-1)?.incidentCount).toBe(0);
    }
  });
  it('isolates malformed GCP lifecycle with local HTTP fixtures while healthy GitHub persists and exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'statusgrid-isolation-test-'));
    temporary.push(root);
    let invalid = false;
    let changed = false;
    const gcp = configs.find(({ id }) => id === 'gcp')!;
    const payloads = () => new Map<string, unknown>([
      [gcp.adapter.endpoints.products!, gcpProducts],
      [gcp.adapter.endpoints.incidents!, invalid ? [{ ...gcpIncidents[0], begin: time(0), end: '2026-11-25T11:00:00Z' }] : []],
      [config.adapter.endpoints.summary!, { ...github, components: github.components.map((component) =>
        ({ ...component, status: changed ? 'degraded_performance' : 'operational' })) }],
      [config.adapter.endpoints.active!, { incidents: [] }],
      [config.adapter.endpoints.incidents!, { incidents: [] }],
    ]);
    const server = createServer((request, response) => {
      const upstream = new URL(request.url!, 'http://fixture').searchParams.get('upstream')!;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payloads().get(upstream)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const transport = createHttpClient({ timeoutMs: 2000, retries: 0 });
    try {
      const ctx = (at: string) => {
        const value = context(at);
        value.http.getJson = (url, signal) =>
          transport.getJson(`http://127.0.0.1:${address.port}/?upstream=${encodeURIComponent(url)}`, signal);
        return value;
      };
      const dir = join(root, 'state');
      const first = await runPersistentCollection([config, gcp], ctx(time(0)), dir);
      const trusted = first.run.providers.find(({ providerId }) => providerId === 'gcp')!.result;
      invalid = true;
      changed = true;
      const second = await runPersistentCollection([config, gcp], ctx(time(5)), dir);
      expect(second.run.providers.find(({ providerId }) => providerId === 'gcp')).toMatchObject({
        result: null, lastTrustedResult: trusted,
        collection: { freshness: 'stale', reason: 'invalid_payload', outcome: 'failure' },
      });
      expect(second.run.providers.find(({ providerId }) => providerId === 'github')?.result?.reportedStatus).toBe('degraded');
      expect(await loadState(dir)).toEqual(second.state);
      await writePublicArtifacts(buildPublicArtifacts(second.run, second.state), join(root, 'public'));
      const release = await validateRelease(join(root, 'public'), { providerIds: ['github', 'gcp'], requireLive: true });
      expect(release.errors).toEqual([]);
      expect(release.valid).toBe(true);
      const missing = await runPersistentCollection([config, gcp], ctx(time(10)), join(root, 'new'));
      expect(missing.run.providers.find(({ providerId }) => providerId === 'gcp')?.collection)
        .toMatchObject({ freshness: 'missing', reason: 'invalid_payload' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('treats an empty Statuspage directory as first missing and later stale without dropping trusted state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'statusgrid-empty-directory-test-'));
    temporary.push(root);
    const badContext = (at: string) => {
      const ctx = context(at);
      const get = ctx.http.getJson;
      ctx.http.getJson = async (url, signal) => url.includes('summary.json') ? { ...github, components: [] } : get(url, signal);
      return ctx;
    };
    const dir = join(root, 'state');
    const first = await runPersistentCollection([config], badContext(time(0)), dir);
    expect(first.run.providers[0]?.collection).toMatchObject({ freshness: 'missing', reason: 'coverage_incomplete' });
    await runPersistentCollection([config], context(time(5)), dir);
    const last = await runPersistentCollection([config], badContext(time(10)), dir);
    expect(last.run.providers[0]?.collection).toMatchObject({ freshness: 'stale', reason: 'coverage_incomplete' });
    expect(last.run.providers[0]?.lastTrustedResult?.coverage.observedSince).toBe(time(5));
    expect(last.run.providers[0]?.lastTrustedResult?.reportedStatus).toBe('operational');
    expect(await loadState(dir)).toEqual(last.state);
  });
  it('persists and exports verified current data despite impossible optional historical intervals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'statusgrid-bad-history-test-'));
    temporary.push(root);
    const ctx = context(time(0));
    const original = ctx.http.getJson;
    ctx.http.getJson = async (url, signal) => url.includes('incidents.json') ? { incidents: [{
      id: '6yk962mhlr3h', name: '[Retroactive] Actions workflow run logs delayed', status: 'resolved', impact: 'minor',
      created_at: '2026-10-13T20:30:00.000Z', started_at: '2026-10-14T00:12:44.500Z',
      resolved_at: '2026-10-13T20:30:00.000Z', updated_at: '2026-10-14T00:13:11.803Z',
    }] } : original(url, signal);
    const result = await runPersistentCollection([config], ctx, join(root, 'state'));
    expect(result.run.providers[0]?.collection).toMatchObject({ freshness: 'fresh', outcome: 'partial' });
    expect(result.run.providers[0]?.result?.evidence.historyError).toBe('invalid_payload');
    expect(result.state.incidents).toEqual([]);
    expect(await loadState(join(root, 'state'))).toEqual(result.state);
    const output = buildPublicArtifacts(result.run, result.state);
    await writePublicArtifacts(output, join(root, 'public'));
    expect((await validateRelease(join(root, 'public'), { providerIds: ['github'], requireLive: true })).valid).toBe(true);
    // The same malformed row in a required endpoint must fail honestly and retain prior trusted data.
    const badCurrent = context(time(5));
    badCurrent.http.getJson = async (url, signal) => url.includes('unresolved.json')
      ? ctx.http.getJson(config.adapter.endpoints.incidents!, signal) : original(url, signal);
    const failed = await runPersistentCollection([config], badCurrent, join(root, 'state'));
    expect(failed.run.providers[0]?.collection).toMatchObject({ freshness: 'stale', outcome: 'failure', reason: 'invalid_payload' });
    expect(failed.run.providers[0]?.result).toBeNull();
    expect(failed.run.providers[0]?.lastTrustedResult?.reportedStatus).toBe('operational');
    expect(await loadState(join(root, 'state'))).toEqual(failed.state);
  });

  it('uses an observation-anchored clock and captures actual completion independently of start', async () => {
    let at = time(0);
    let tick = 0;
    const ctx = context(at);
    const getJson = ctx.http.getJson;
    ctx.clock = { now: () => at, monotonic: () => tick };
    ctx.http.getJson = async (url, signal) => {
      const payload = await getJson(url, signal);
      at = time(1);
      tick = 1200;
      return payload;
    };
    const run = await collectProviders([config], new Map(), ctx);
    expect(run).toMatchObject({ startedAt: time(0), completedAt: time(1) });
    expect(run.providers[0]?.collection).toMatchObject({ lastCheckedAt: time(1), lastSuccessAt: time(1), durationMs: 1200 });
    const anchored = await collectProviders([], new Map(), { ...context('2040-01-01T00:00:00.000Z'), clock: undefined });
    expect(anchored.startedAt).toMatch(/^2040-01-01T00:00:00/);
  });

  it('persists real multi-round source collection, preserves stale evidence and reconciles once across filesystem reloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'statusgrid-run-test-'));
    temporary.push(root);
    const directory = join(root, 'generated');
    for (const [minute, status, failed] of [[0, 'operational', false], [5, 'degraded_performance', false],
      [10, 'major_outage', false], [15, 'operational', true], [20, 'operational', false]] as const) {
      const result = await runPersistentCollection([config], context(time(minute), status, failed), directory);
      expect(result.kind).toBe('valid');
      expect(result.hasProviderFailures).toBe(failed);
      const stored = await loadState(directory);
      expect(stored).toEqual(result.state);
      expect(stored.latest?.providers[0]?.lastTrustedResult?.coverage.observedSince).toBe(time(0));
      if (minute === 15) {
        expect(stored.latest?.providers[0]).toMatchObject({ result: null, collection: { freshness: 'stale', consecutiveFailures: 1 } });
        expect(stored.latest?.providers[0]?.lastTrustedResult?.reportedStatus).toBe('major_outage');
        expect(stored.openIncidents).toHaveLength(1);
      }
    }
    const before = await loadState(directory);
    const archive = await readFile(join(directory, 'incidents/archive/2026-11.json'), 'utf8');
    expect(before.incidents).toHaveLength(1);
    expect(before.ledger.milestones.map(({ kind }) => kind)).toEqual(['triggered', 'escalated', 'resolved']);
    expect(before.dailyStats.github?.at(-1)).toMatchObject({ observedImpactMinutes: 10, observedCoverageMinutes: 15, unknownMinutes: 725 });
    await runPersistentCollection([config], context(time(20)), directory);
    const rerun = await loadState(directory);
    expect(rerun.incidents).toEqual(before.incidents);
    expect(rerun.ledger).toEqual(before.ledger);
    expect(rerun.dailyStats).toEqual(before.dailyStats);
    expect(await readFile(join(directory, 'incidents/archive/2026-11.json'), 'utf8')).toBe(archive);
    const replayDirectory = join(root, 'replayed');
    for (const [minute, status, failed] of [[0, 'operational', false], [5, 'degraded_performance', false],
      [10, 'major_outage', false], [15, 'operational', true], [20, 'operational', false]] as const) {
      await runPersistentCollection([config], context(time(minute), status, failed), replayDirectory);
    }
    const replay = await loadState(replayDirectory);
    expect(replay.incidents).toEqual(before.incidents);
    expect(replay.ledger).toEqual(before.ledger);
    expect(replay.dailyStats).toEqual(before.dailyStats);
    expect(await readFile(join(replayDirectory, 'incidents/archive/2026-11.json'), 'utf8')).toBe(archive);
    await expect(runPersistentCollection([], context(time(25)), directory)).rejects.toThrow(/subset|provider|scope/i);
  });

  it('isolates concurrent failures, missing first data, and bounds all pending/queued providers by the global deadline', async () => {
    vi.useFakeTimers();
    const ctx = context(time(0));
    ctx.http.getJson = async () => new Promise(() => {});
    const copies: ProviderConfig[] = Array.from({ length: 13 }, (_, index) => ({ ...config, id: `provider-${index}` }));
    const pending = collectProviders(copies, new Map(), ctx);
    await vi.advanceTimersByTimeAsync(120_000);
    const run = await pending;
    expect(run.providers).toHaveLength(13);
    expect(run.providers.every(({ result, lastTrustedResult, collection }) =>
      result === null && lastTrustedResult === null && collection.freshness === 'missing')).toBe(true);
    expect(run.providers.every(({ collection }) => collection.reason === 'timeout')).toBe(true);
  });
});
