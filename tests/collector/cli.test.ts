import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseCollectArgs, main } from '../../src/collector/cli.js';
import { loadState } from '../../src/collector/storage/load.js';
import type { CollectionContext } from '../../src/collector/types.js';
import { validateRelease } from '../../src/collector/export/validate.js';

const temporary: string[] = [];
afterEach(async () => {
  process.exitCode = 0;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const context = (): CollectionContext => ({
  now: '2026-11-25T12:00:00.000Z', clock: { now: () => '2026-11-25T12:00:00.000Z', monotonic: () => 0 },
  intervalMinutes: 5, signal: new AbortController().signal,
  http: { getJson: async () => { throw new Error('offline'); }, getText: async () => { throw new Error('offline'); },
    getResponse: async () => { throw new Error('offline'); } },
  browser: { collect: async () => [], close: async () => {} },
});
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'statusgrid-cli-test-'));
  temporary.push(dir);
  return dir;
}

describe('explicit persistent and read-only diagnostic CLI modes', () => {
  it('selects all enabled providers and requires persistent full scope for public output', () => {
    const parsed = parseCollectArgs(['--state-dir', '.statusgrid/state']);
    expect(parsed.providers).toEqual(registry.filter(({ enabled }) => enabled).map(({ id }) => id));
    expect(parsed.providers).toHaveLength(13);
    expect(parsed.stateDir).toBe('.statusgrid/state');
    expect(() => parseCollectArgs(['--providers', 'github', '--state-dir', '.statusgrid/state'])).toThrow(/providers|subset/i);
    expect(parseCollectArgs(['--state-dir', '.statusgrid/state', '--output-dir', 'public']).outputDir).toBe('public');
    expect(() => parseCollectArgs(['--output-dir', 'public'])).toThrow(/persistent|state-dir/i);
    expect(() => parseCollectArgs(['--providers', 'github', '--output-dir', 'public'])).toThrow(/providers|persistent|scope/i);
    expect(() => parseCollectArgs(['--state-dir', '.statusgrid/state', '--output-dir', '.statusgrid/state/export'])).toThrow(/overlap/i);
    expect(() => parseCollectArgs(['--state-dir', '.statusgrid/state', '--report', '.statusgrid/state/state/latest.json']))
      .toThrow(/report.*state|overlap/i);
  });

  it('exports a real full persistent initialized-no-data live release through --output-dir', async () => {
    const dir = await root();
    await main(['--state-dir', join(dir, 'state'), '--output-dir', join(dir, 'public'),
      '--report', join(dir, 'report.json')], context());
    expect(process.exitCode).toBe(0);
    const report = await validateRelease(join(dir, 'public'), { requireLive: true });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.snapshotId).toBe((await loadState(join(dir, 'state'))).latest?.snapshotId);
    const summary = JSON.parse(await readFile(join(dir, 'public/api/v1/summary.json'), 'utf8'));
    expect(summary.providers).toHaveLength(13);
    expect(summary.globalSummary.overallStatus).toBe('stale');
    expect(summary.providers.every((provider: { reportedStatus: unknown }) => provider.reportedStatus === null)).toBe(true);
  });
  it('actually persists a full valid stale run and exits zero so public export can proceed', async () => {
    const dir = await root();
    await main(['--state-dir', join(dir, 'generated'), '--report', join(dir, 'report.json')], context());
    expect(process.exitCode).toBe(0);
    const state = await loadState(join(dir, 'generated'));
    expect(state.latest?.providers).toHaveLength(13);
    expect(state.latest?.providers.every(({ collection }) => collection.freshness === 'missing')).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')).providers).toHaveLength(13);
  });

  it('writes only a diagnostic report for selected providers and preserves failure exit one', async () => {
    const dir = await root();
    await main(['--providers', 'github', '--report', join(dir, 'report.json')], context());
    expect(process.exitCode).toBe(1);
    expect(await readdir(dir)).toEqual(['report.json']);
    expect(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')).providers[0].collection.freshness).toBe('missing');
  });

  it('rejects infrastructure/state damage before collection or overwriting any report', async () => {
    const dir = await root();
    await mkdir(join(dir, 'generated'));
    await writeFile(join(dir, 'generated/source.txt'), 'untouched');
    await writeFile(join(dir, 'report.json'), 'previous');
    await expect(main(['--state-dir', join(dir, 'generated'), '--report', join(dir, 'report.json')], context()))
      .rejects.toThrow(/state|corrupt|missing/i);
    expect(await readFile(join(dir, 'generated/source.txt'), 'utf8')).toBe('untouched');
    expect(await readFile(join(dir, 'report.json'), 'utf8')).toBe('previous');
  });
});
