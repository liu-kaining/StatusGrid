import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState } from '../../src/collector/events/reconcile.js';
import { buildPublicArtifacts } from '../../src/collector/export/json.js';
import { immutablePath } from '../../src/collector/export/directory.js';
import { writePublicArtifacts } from '../../src/collector/export/manifest.js';
import { inventory } from '../../src/collector/storage/directory.js';
import { loadState } from '../../src/collector/storage/load.js';
import { stageState } from '../../src/collector/storage/save.js';
import { prepareRelease, validatePreparedRelease, validatePreviousPreparedRelease } from '../../scripts/prepare-release.js';
import { readBranch, updateSnapshot } from '../../scripts/update-snapshot.js';
import { runWorkflowRelease } from '../../scripts/workflow-release.js';
import { advance, run, source, time } from '../helpers/history.js';

const exec = promisify(execFile);
const roots: string[] = [];
const originalScope = { providerIds: ['github'] };
const expandedScope = { providerIds: ['github', 'openai'] };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'statusgrid-expansion-test-'));
  roots.push(directory);
  const shell = join(directory, 'shell');
  await mkdir(shell);
  await writeFile(join(shell, 'index.html'), '<main>StatusGrid</main>');
  await writeFile(join(shell, 'CNAME'), 'grid.thetamind.ai\n');
  const state = join(directory, 'state');
  const original = advance(emptyState(), run(time(0), 'operational', [source({
    state: 'resolved', resolvedAt: time(0), resolvedTimeBasis: 'source', durationMinutes: 0,
  })], []));
  await stageState(original, state);
  return { directory, shell, state, original };
}
function expandedRun(at: string) {
  const collection = run(at, 'operational', [], []);
  collection.providers.push({
    ...run(at, null).providers[0]!, providerId: 'openai', officialStatusUrl: 'https://status.openai.com',
  });
  return collection;
}
async function immutableFiles(directory: string) {
  return Object.fromEntries(await Promise.all((await inventory(directory)).filter(immutablePath)
    .map(async (path) => [path, await readFile(join(directory, path), 'utf8')])));
}
async function repository(directory: string) {
  const remote = join(directory, 'remote.git');
  const repo = join(directory, 'repo');
  await exec('git', ['init', '--bare', remote]);
  await exec('git', ['init', repo]);
  await exec('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  return repo;
}
async function publishedOriginal() {
  const context = await setup();
  const repo = await repository(context.directory);
  const site = join(context.directory, 'original-site');
  await prepareRelease(context.shell, context.state, site, originalScope);
  await updateSnapshot(repo, { branch: 'data', sha: null, directory: context.state }, context.state, 'original data');
  await updateSnapshot(repo, { branch: 'gh-pages', sha: null, directory: site }, site, 'original release');
  return { ...context, repo, site };
}

describe('additive provider publication', () => {
  it('publishes the expanded scope while preserving every retained snapshot and archive byte', async () => {
    const { directory, shell, state, original } = await setup();
    const oldSite = join(directory, 'old-site');
    await prepareRelease(shell, state, oldSite, originalScope);
    const retained = await immutableFiles(oldSite);
    const expanded = advance(original, expandedRun(time(5)));
    await stageState(expanded, state);
    const nextSite = join(directory, 'next-site');
    expect((await prepareRelease(oldSite, state, nextSite, expandedScope)).valid).toBe(true);
    expect((await validatePreparedRelease(nextSite, expandedScope)).valid).toBe(true);
    const manifest = JSON.parse(await readFile(join(nextSite, 'api/v1/manifest.json'), 'utf8'));
    expect(Object.keys(manifest.paths.providers).sort()).toEqual(['github', 'openai']);
    for (const [path, body] of Object.entries(retained)) {
      expect(await readFile(join(nextSite, path), 'utf8'), path).toBe(body);
    }
    expect((await loadState(state)).incidents).toEqual(original.incidents);
    expect((await loadState(state)).ledger).toEqual(original.ledger);
  });

  it.each(['frontend', 'retry'] as const)(
    'allows %s before the first expanded sync without collecting or inventing providers',
    async (mode) => {
      const { directory, shell, original, repo, site } = await publishedOriginal();
      const retained = await immutableFiles(site);
      expect((await runWorkflowRelease({
        repository: repo, sourceSha: 'expanded', ...expandedScope, workDir: join(directory, mode), mode,
        ...(mode === 'frontend' ? { shellDir: shell } : {}),
        collect: async () => { throw new Error('Frontend and retry must not collect'); },
      })).status).toBe('published');
      const pages = await readBranch(repo, 'gh-pages', join(directory, 'pages'));
      expect((await validatePreparedRelease(pages.directory, originalScope)).valid).toBe(true);
      expect((await validatePreparedRelease(pages.directory, expandedScope)).valid).toBe(false);
      expect(await immutableFiles(pages.directory)).toEqual(retained);
      expect(await loadState((await readBranch(repo, 'data', join(directory, 'data'))).directory)).toEqual(original);
    },
  );

  it('publishes a complete expanded sync after the frontend has republished the older scope', async () => {
    const { directory, shell, repo, site, original } = await publishedOriginal();
    const retained = await immutableFiles(site);
    await runWorkflowRelease({
      repository: repo, workDir: join(directory, 'frontend'), mode: 'frontend', shellDir: shell,
      sourceSha: 'expanded', ...expandedScope,
      collect: async () => { throw new Error('Frontend must not collect'); },
    });
    expect((await runWorkflowRelease({
      repository: repo, workDir: join(directory, 'sync'), mode: 'sync', sourceSha: 'expanded', ...expandedScope,
      collect: async (stateDir, interval) => {
        expect(interval).toBe(5);
        const collection = expandedRun(time(5));
        const next = advance(await loadState(stateDir), collection);
        await stageState(next, stateDir);
        return { kind: 'valid', run: collection, state: next, hasProviderFailures: true };
      },
    })).status).toBe('published');
    const currentPages = await readBranch(repo, 'gh-pages', join(directory, 'current-pages'));
    expect((await validatePreparedRelease(currentPages.directory, expandedScope)).valid).toBe(true);
    for (const [path, body] of Object.entries(retained)) {
      expect(await readFile(join(currentPages.directory, path), 'utf8'), path).toBe(body);
    }
    const data = await loadState((await readBranch(repo, 'data', join(directory, 'data'))).directory);
    expect(data.latest?.providers.map(({ providerId }) => providerId).sort()).toEqual(['github', 'openai']);
    expect(data.incidents).toEqual(original.incidents);
    expect(data.ledger).toEqual(original.ledger);
  });

  it('retries an already expanded publication without changing collected state or immutable files', async () => {
    const { directory, repo, site, state, original } = await publishedOriginal();
    const expanded = advance(original, expandedRun(time(5)));
    await stageState(expanded, state);
    const expandedSite = join(directory, 'expanded-site');
    await prepareRelease(site, state, expandedSite, expandedScope);
    const beforeData = await readBranch(repo, 'data', join(directory, 'before-data'));
    const beforePages = await readBranch(repo, 'gh-pages', join(directory, 'before-pages'));
    await updateSnapshot(repo, beforeData, state, 'expanded data');
    await updateSnapshot(repo, beforePages, expandedSite, 'expanded release');
    const retained = await immutableFiles(expandedSite);
    expect((await runWorkflowRelease({
      repository: repo, workDir: join(directory, 'retry'), mode: 'retry', sourceSha: 'expanded', ...expandedScope,
      collect: async () => { throw new Error('Retry must not collect'); },
    })).status).toBe('published');
    const pages = await readBranch(repo, 'gh-pages', join(directory, 'pages'));
    expect((await validatePreparedRelease(pages.directory, expandedScope)).valid).toBe(true);
    expect(await immutableFiles(pages.directory)).toEqual(retained);
    expect(await loadState((await readBranch(repo, 'data', join(directory, 'data'))).directory)).toEqual(expanded);
  });

  it('rejects a partial sync even when the durable shell still has the older provider scope', async () => {
    const { directory, shell, state } = await setup();
    const repo = await repository(directory);
    await updateSnapshot(repo, { branch: 'data', sha: null, directory: state }, state, 'original data');
    await runWorkflowRelease({
      repository: repo, workDir: join(directory, 'original'), mode: 'frontend', shellDir: shell,
      sourceSha: 'original', ...originalScope,
    });
    const beforeData = await readBranch(repo, 'data', join(directory, 'before-data'));
    const beforePages = await readBranch(repo, 'gh-pages', join(directory, 'before-pages'));
    let collected = false;
    await expect(runWorkflowRelease({
      repository: repo, workDir: join(directory, 'partial-sync'), mode: 'sync', sourceSha: 'expanded', ...expandedScope,
      collect: async (stateDir) => {
        collected = true;
        const collection = run(time(5), null);
        const next = advance(await loadState(stateDir), collection);
        await stageState(next, stateDir);
        return { kind: 'valid', run: collection, state: next, hasProviderFailures: true };
      },
    })).rejects.toThrow(/invalid/i);
    expect(collected).toBe(true);
    expect((await readBranch(repo, 'data', join(directory, 'after-data'))).sha).toBe(beforeData.sha);
    expect((await readBranch(repo, 'gh-pages', join(directory, 'after-pages'))).sha).toBe(beforePages.sha);
  });

  it('retries an expanded data commit against older Pages without recollecting or losing history', async () => {
    const { directory, shell, state, original } = await setup();
    const repo = await repository(directory);
    await updateSnapshot(repo, { branch: 'data', sha: null, directory: state }, state, 'original data');
    await runWorkflowRelease({
      repository: repo, workDir: join(directory, 'original'), mode: 'frontend', shellDir: shell,
      sourceSha: 'original', ...originalScope,
    });
    const pages = await readBranch(repo, 'gh-pages', join(directory, 'old-pages'));
    const retained = await immutableFiles(pages.directory);
    const data = await readBranch(repo, 'data', join(directory, 'old-data'));
    const expanded = advance(original, expandedRun(time(5)));
    await stageState(expanded, state);
    // This is the durable state after data CAS succeeds and the later Pages CAS fails.
    await updateSnapshot(repo, data, state, 'expanded data awaiting Pages retry');
    expect((await runWorkflowRelease({
      repository: repo, workDir: join(directory, 'retry'), mode: 'retry', sourceSha: 'expanded', ...expandedScope,
      collect: async () => { throw new Error('Retry must not collect'); },
    })).status).toBe('published');
    const durablePages = await readBranch(repo, 'gh-pages', join(directory, 'durable-pages'));
    expect((await validatePreparedRelease(durablePages.directory, expandedScope)).snapshotId).toBe(time(5));
    for (const [path, body] of Object.entries(retained)) {
      expect(await readFile(join(durablePages.directory, path), 'utf8'), path).toBe(body);
    }
    expect(await loadState((await readBranch(repo, 'data', join(directory, 'durable-data'))).directory)).toEqual(expanded);
  });

  it('rejects an empty collected scope instead of treating it as an older live publication', async () => {
    const { directory, shell, state } = await setup();
    const repo = await repository(directory);
    await runWorkflowRelease({
      repository: repo, workDir: join(directory, 'empty-frontend'), mode: 'frontend', shellDir: shell,
      sourceSha: 'original', ...expandedScope,
    });
    const collection = run(time(0), null);
    collection.providers = [];
    await stageState(advance(emptyState(), collection), state);
    const emptySite = join(directory, 'empty-live-site');
    await prepareRelease(shell, state, emptySite, { providerIds: [] });
    expect((await validatePreviousPreparedRelease(emptySite, expandedScope)).valid).toBe(false);
    await updateSnapshot(repo, { branch: 'data', sha: null, directory: state }, state, 'empty provider scope');
    const pages = await readBranch(repo, 'gh-pages', join(directory, 'before-pages'));
    await expect(runWorkflowRelease({
      repository: repo, workDir: join(directory, 'retry'), mode: 'retry', sourceSha: 'expanded', ...expandedScope,
      collect: async () => { throw new Error('Retry must not collect'); },
    })).rejects.toThrow(/invalid/i);
    expect((await readBranch(repo, 'gh-pages', join(directory, 'after-pages'))).sha).toBe(pages.sha);
  });

  it('rejects provider removals, unsupported prior scopes and corruption during expansion', async () => {
    const { directory, shell, state, original } = await setup();
    const oldSite = join(directory, 'old-site');
    await prepareRelease(shell, state, oldSite, originalScope);
    await stageState(advance(original, expandedRun(time(5))), state);
    await expect(prepareRelease(oldSite, state, join(directory, 'unknown'), { providerIds: ['openai'] })).rejects.toThrow(/invalid/i);
    const expanded = join(directory, 'expanded');
    await prepareRelease(oldSite, state, expanded, expandedScope);
    const removed = advance(await loadState(state), run(time(10), null));
    await stageState(removed, state);
    await expect(prepareRelease(expanded, state, join(directory, 'removed'), originalScope)).rejects.toThrow(/invalid/i);
    await expect(writePublicArtifacts(buildPublicArtifacts(removed.latest!, removed), expanded)).rejects.toThrow(/invalid/i);
    await writeFile(join(oldSite, 'api/v1/summary.json'), '{}');
    await stageState(advance(original, expandedRun(time(5))), state);
    await expect(prepareRelease(oldSite, state, join(directory, 'corrupt'), expandedScope)).rejects.toThrow(/invalid/i);
  });
});
