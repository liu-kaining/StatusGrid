import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import registry from '../../registry/providers.json';
import github from '../fixtures/statuspage/github/summary.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { collectProviders, runPersistentCollection } from '../../src/collector/run.js';
import { loadState } from '../../src/collector/storage/load.js';
import { TransportError } from '../../src/collector/errors.js';
import type { CollectionContext } from '../../src/collector/types.js';
import type { ProviderConfig } from '../../src/shared/contracts.js';
import { time } from '../helpers/history.js';

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
