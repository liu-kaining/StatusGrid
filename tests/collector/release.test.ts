import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPublicArtifacts } from '../../src/collector/export/json.js';
import { writePublicArtifacts } from '../../src/collector/export/manifest.js';
import { validateRelease } from '../../src/collector/export/validate.js';
import { emptyState } from '../../src/collector/events/reconcile.js';
import { advance, run, source, time } from '../helpers/history.js';
import { parseReleaseArgs } from '../../scripts/release.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'statusgrid-release-test-'));
  dirs.push(dir);
  return dir;
}
function artifacts(at = time(0), title = 'API issues') {
  const collection = run(at, 'degraded', [source({ title })]);
  return buildPublicArtifacts(collection, advance(emptyState(), collection));
}

describe('release staging and runtime validation', () => {
  it('accepts the release check CLI contract and rejects unknown or incomplete flags', () => {
    expect(parseReleaseArgs(['--dir', 'dist', '--require-live'])).toEqual({ directory: 'dist', requireLive: true });
    expect(() => parseReleaseArgs(['--dir'])).toThrow();
    expect(() => parseReleaseArgs(['--dir', 'dist', '--mode', 'fixture'])).toThrow();
  });
  it('writes a complete independently valid release and preserves shell assets', async () => {
    const dir = await root();
    await writeFile(join(dir, 'index.html'), '<main>shell</main>');
    await writeFile(join(dir, 'favicon.ico'), 'icon');
    await writePublicArtifacts(artifacts(), dir);
    const report = await validateRelease(dir, { providerIds: ['github'], requireLive: true });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.summaryGzipBytes).toBeLessThanOrEqual(40 * 1024);
    expect(report.files.some(({ path, parsed, gzipBytes }) => path === 'api/v1/summary.json' && parsed && gzipBytes > 0)).toBe(true);
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe('<main>shell</main>');
    expect(await readFile(join(dir, 'favicon.ico'), 'utf8')).toBe('icon');
  });

  it.each(['missing-detail', 'cross-snapshot', 'invalid-shape', 'bad-index', 'bad-xml', 'unsafe-path', 'fixture-hidden',
    'wrong-day', 'wrong-archive-time', 'wrong-index-time', 'wrong-active-summary'])(
    'rejects release damage: %s', async (damage) => {
      const dir = await root();
      const output = artifacts();
      await writePublicArtifacts(output, dir);
      const manifest = output.manifest;
      if (damage === 'missing-detail') await rm(join(dir, manifest.paths.providers.github!.slice(1)));
      if (damage === 'cross-snapshot' || damage === 'invalid-shape') {
        const path = join(dir, manifest.paths.summary.slice(1));
        const summary = structuredClone(output.summary);
        if (damage === 'cross-snapshot') summary.snapshotId = 'wrong';
        else summary.providers[0]!.componentSummary.total = -1;
        await writeFile(path, JSON.stringify(summary));
      }
      if (damage === 'bad-index') {
        await writeFile(join(dir, manifest.paths.archiveIndex.slice(1)), JSON.stringify({
          ...output.archiveIndex, revision: 'wrong', months: [{ month: '2026-11', path: '/missing.json' }],
        }));
      }
      if (damage === 'bad-xml') await writeFile(join(dir, 'feed/all.xml'), '<rss><broken>');
      if (damage === 'unsafe-path') {
        await writeFile(join(dir, 'api/v1/manifest.json'), JSON.stringify({
          ...manifest, paths: { ...manifest.paths, summary: '/../outside.json' },
        }));
      }
      if (damage === 'fixture-hidden') {
        const path = join(dir, 'api/v1/search.json');
        await writeFile(path, JSON.stringify({ ...output.search, dataMode: 'fixture' }));
      }
      if (damage === 'wrong-day' || damage === 'wrong-active-summary') {
        const path = join(dir, manifest.paths.providers.github!.slice(1));
        const detail = structuredClone(output.details.github!);
        if (damage === 'wrong-day') detail.dailyHistory30d[0]!.date = '2026-01-01';
        else detail.provider.activeIncidents[0]!.title = 'Fabricated title';
        await writeFile(path, JSON.stringify(detail));
        await writeFile(join(dir, 'api/v1/providers/github.json'), JSON.stringify(detail));
        if (damage === 'wrong-active-summary') {
          const summary = structuredClone(output.summary);
          summary.providers[0]!.activeIncidents[0]!.title = 'Fabricated title';
          for (const summaryPath of ['api/v1/summary.json', manifest.paths.summary.slice(1)]) {
            await writeFile(join(dir, summaryPath), JSON.stringify(summary));
          }
        }
      }
      if (damage === 'wrong-archive-time') {
        await writeFile(join(dir, output.archiveIndex.months[0]!.path.slice(1)),
          JSON.stringify({ ...output.archives[0], updatedAt: '2026-01-01T00:00:00.000Z' }));
      }
      if (damage === 'wrong-index-time') {
        for (const indexPath of [manifest.paths.archiveIndex.slice(1), 'api/v1/incidents/archive/index.json']) {
          await writeFile(join(dir, indexPath),
            JSON.stringify({ ...output.archiveIndex, generatedAt: '2026-01-01T00:00:00.000Z' }));
        }
      }
      const report = await validateRelease(dir, { providerIds: ['github'], requireLive: true });
      expect(report.valid).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
    },
  );

  it.each(['unsafe-url', 'nested-title'])('rejects syntactically valid feed contract damage: %s', async (damage) => {
    const dir = await root();
    const output = artifacts();
    await writePublicArtifacts(output, dir);
    const body = output.feeds['feed/all.xml']!;
    const damaged = damage === 'unsafe-url'
      ? body.replace('<link>https://www.githubstatus.com/incidents/native</link>', '<link>javascript:alert(1)</link>')
      : body.replace('<title>GitHub: API issues (triggered)</title>', '<title><script>unsafe</script></title>');
    expect(damaged).not.toBe(body);
    await writeFile(join(dir, 'feed/all.xml'), damaged);
    expect((await validateRelease(dir, { providerIds: ['github'] })).valid).toBe(false);
  });

  it('requires every configured provider detail and enforces the compressed summary budget', async () => {
    const dir = await root();
    await writePublicArtifacts(artifacts(), dir);
    expect((await validateRelease(dir, { providerIds: ['github', 'openai'] })).valid).toBe(false);
    expect((await validateRelease(dir, { providerIds: ['github'], maxSummaryGzipBytes: 10 })).errors.join(' ')).toMatch(/gzip|size|budget/i);
  });

  it('rejects an unavailable cold revision even when the index itself still parses', async () => {
    const dir = await root();
    const output = artifacts();
    await writePublicArtifacts(output, dir);
    await rm(join(dir, output.archiveIndex.months[0]!.path.slice(1)));
    const report = await validateRelease(dir, { providerIds: ['github'] });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/missing|ENOENT/i);
  });

  it('rejects a valid XML document that is not a usable feed', async () => {
    const dir = await root();
    await writePublicArtifacts(artifacts(), dir);
    await writeFile(join(dir, 'feed/all.xml'), '<rss xmlns:sg="urn:statusgrid:v1" sg:schemaVersion="1.0" sg:snapshotId="2026-11-25T12:00:00.000Z" sg:dataMode="live"><channel/></rss>');
    expect((await validateRelease(dir, { providerIds: ['github'] })).valid).toBe(false);
  });

  it('detects fixture data retained behind a newer live manifest', async () => {
    const dir = await root();
    const collection = run(time(0), 'degraded', [source()]);
    await writePublicArtifacts(buildPublicArtifacts(collection, advance(emptyState(), collection), { dataMode: 'fixture' }), dir);
    await writePublicArtifacts(artifacts(time(5)), dir);
    const report = await validateRelease(dir, { providerIds: ['github'], requireLive: true });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toContain('Fixture');
    expect((await validateRelease(dir, { providerIds: ['github'] })).valid).toBe(true);
  });

  it('refuses source roots and symlink artifacts before changing content', async () => {
    await expect(writePublicArtifacts(artifacts(), process.cwd())).rejects.toThrow(/unsafe/i);
    const dir = await root();
    const outside = await root();
    await writeFile(join(outside, 'summary.json'), 'untouched');
    await mkdir(join(dir, 'api/v1'), { recursive: true });
    await symlink(join(outside, 'summary.json'), join(dir, 'api/v1/summary.json'));
    await expect(writePublicArtifacts(artifacts(), dir)).rejects.toThrow(/symlink|unsafe/i);
    expect(await readFile(join(outside, 'summary.json'), 'utf8')).toBe('untouched');
  });

  it('does not promote a staged invalid contract or absorb undeclared generated artifacts', async () => {
    const dir = await root();
    await writePublicArtifacts(artifacts(), dir);
    const previous = await readFile(join(dir, 'api/v1/manifest.json'), 'utf8');
    const next = artifacts(time(5));
    next.summary.providers[0]!.dailyCoverage30d[0]!.unknownMinutes = -1;
    await expect(writePublicArtifacts(next, dir)).rejects.toThrow(/staged|invalid/i);
    expect(await readFile(join(dir, 'api/v1/manifest.json'), 'utf8')).toBe(previous);
    const unowned = await root();
    await mkdir(join(unowned, 'api/v1'), { recursive: true });
    await writeFile(join(unowned, 'api/v1/extra.json'), '{"dataMode":"fixture"}');
    await expect(writePublicArtifacts(artifacts(), unowned)).rejects.toThrow(/undeclared/i);
    expect(await readFile(join(unowned, 'api/v1/extra.json'), 'utf8')).toContain('fixture');
  });

  it('rejects fixture releases, immutable collisions and undeclared generated replacement', async () => {
    const dir = await root();
    const collection = run(time(0), 'operational');
    const fixture = buildPublicArtifacts(collection, advance(emptyState(), collection), { dataMode: 'fixture' });
    await writePublicArtifacts(fixture, dir);
    expect((await validateRelease(dir, { providerIds: ['github'], requireLive: true })).valid).toBe(false);
    await expect(writePublicArtifacts(artifacts(), dir)).rejects.toThrow(/immutable|snapshot|collision/i);
    const other = await root();
    await mkdir(join(other, 'api/v1'), { recursive: true });
    await writeFile(join(other, 'api/v1/summary.json'), 'handwritten');
    await expect(writePublicArtifacts(artifacts(), other)).rejects.toThrow(/undeclared|owned|replace/i);
    expect(await readFile(join(other, 'api/v1/summary.json'), 'utf8')).toBe('handwritten');
  });

  it('retains hot references, reused months and latest two month revisions before cleaning unreferenced versions', async () => {
    const dir = await root();
    const first = artifacts('2026-11-25T00:00:00.000Z', 'first');
    await writePublicArtifacts(first, dir);
    const oldPath = first.manifest.paths.summary;
    const firstMonth = first.archiveIndex.months[0]!.path;
    // New snapshots reuse the same immutable month; do not age its revision by first write time.
    for (let index = 1; index <= 13; index++) {
      const collection = run(`2026-11-25T00:${String(index).padStart(2, '0')}:00.000Z`, 'degraded', [source()]);
      const state = advance(emptyState(), collection);
      state.incidents = structuredClone(advance(emptyState(), run('2026-11-25T00:00:00.000Z', 'degraded', [source({ title: 'first' })])).incidents);
      const output = buildPublicArtifacts(collection, state);
      expect(output.archiveIndex.months[0]!.path).toBe(firstMonth);
      await writePublicArtifacts(output, dir);
    }
    expect(await readFile(join(dir, oldPath.slice(1)), 'utf8')).toContain(first.summary.snapshotId);
    // Once outside both retention bounds, that hot version disappears; latest manifest relocates clients.
    for (let index = 0; index < 13; index++) {
      const output = artifacts(`2026-11-25T03:${String(index).padStart(2, '0')}:00.000Z`, `revision ${index}`);
      await writePublicArtifacts(output, dir);
    }
    await expect(readFile(join(dir, oldPath.slice(1)), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const latest = JSON.parse(await readFile(join(dir, 'api/v1/manifest.json'), 'utf8'));
    expect(latest.snapshotId).toBe('2026-11-25T03:12:00.000Z');
    expect(await readFile(join(dir, latest.paths.summary.slice(1)), 'utf8')).toContain(latest.snapshotId);
    expect((await validateRelease(dir, { providerIds: ['github'], requireLive: true })).valid).toBe(true);
  });

  it('keeps the latest two unique month revisions even after their hot references expire', async () => {
    const dir = await root();
    const versions = [artifacts('2026-11-25T00:00:00.000Z', 'first'),
      artifacts('2026-11-25T00:05:00.000Z', 'second'),
      artifacts('2026-11-25T00:10:00.000Z', 'third')];
    for (const output of versions) await writePublicArtifacts(output, dir);
    const frozenIncidents = versions[2]!.archives[0]!.incidents;
    for (let index = 0; index < 13; index++) {
      const collection = run(`2026-11-25T03:${String(index).padStart(2, '0')}:00.000Z`, 'degraded', [source({ title: 'third' })]);
      const state = advance(emptyState(), collection);
      state.incidents = structuredClone(frozenIncidents);
      await writePublicArtifacts(buildPublicArtifacts(collection, state), dir);
    }
    await expect(readFile(join(dir, versions[0]!.archiveIndex.months[0]!.path.slice(1)))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(dir, versions[1]!.archiveIndex.months[0]!.path.slice(1)), 'utf8')).toContain('second');
    expect(await readFile(join(dir, versions[2]!.archiveIndex.months[0]!.path.slice(1)), 'utf8')).toContain('third');
    await expect(readFile(join(dir, versions[1]!.manifest.paths.archiveIndex.slice(1)))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await validateRelease(dir, { providerIds: ['github'] })).valid).toBe(true);
  });
});
