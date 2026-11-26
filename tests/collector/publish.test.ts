import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState } from '../../src/collector/events/reconcile.js';
import { stageState } from '../../src/collector/storage/save.js';
import { loadState } from '../../src/collector/storage/load.js';
import { advance, run, source, time } from '../helpers/history.js';
import { prepareRelease, validatePreparedRelease } from '../../scripts/prepare-release.js';
import { readBranch, updateSnapshot } from '../../scripts/update-snapshot.js';
import { frontendFingerprint, shouldSkipSync } from '../../scripts/release-policy.js';
import { publishRelease } from '../../scripts/publish-release.js';
import { backupState } from '../../scripts/backup-state.js';
import { runWorkflowRelease } from '../../scripts/workflow-release.js';
import { verifyDeployment } from '../../scripts/verify-deployment.js';
import { withHttpServer } from '../helpers/http-server.js';

const exec = promisify(execFile);
const roots: string[] = [];
const options = { providerIds: ['github'] };
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'statusgrid-publish-test-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 3 }))); });
async function setup() {
  const directory = await root();
  const shell = join(directory, 'shell');
  await mkdir(shell);
  await writeFile(join(shell, 'index.html'), '<main>Unable to load published status</main>');
  await writeFile(join(shell, 'CNAME'), 'grid.thetamind.ai\n');
  const state = join(directory, 'state');
  await stageState(advance(emptyState(), run(time(0), null)), state);
  return { directory, shell, state, site: join(directory, 'site') };
}
async function repository() {
  const directory = await root();
  const remote = join(directory, 'remote.git');
  const repo = join(directory, 'repo');
  await exec('git', ['init', '--bare', remote]);
  await exec('git', ['init', repo]);
  await exec('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  return { directory, remote, repo };
}

describe('validated release assembly', () => {
  it('exports valid missing-source freshness without inventing green status', async () => {
    const { shell, state, site } = await setup();
    expect((await prepareRelease(shell, state, site, options)).valid).toBe(true);
    const summary = JSON.parse(await readFile(join(site, 'api/v1/summary.json'), 'utf8'));
    expect(summary.dataMode).toBe('live');
    expect(summary.providers[0].collection.freshness).toBe('missing');
    expect(summary.providers[0].reportedStatus).toBeNull();
    expect(await readFile(join(site, 'CNAME'), 'utf8')).toBe('grid.thetamind.ai\n');
  });
  it('permits a strict empty shell before the first collection, with no fixture API', async () => {
    const { directory, shell, site } = await setup();
    const report = await prepareRelease(shell, join(directory, 'absent'), site, options);
    expect(report.valid).toBe(true);
    expect(report.snapshotId).toBeNull();
    expect((await validatePreparedRelease(site, options)).valid).toBe(true);
    await expect(readFile(join(site, 'api/v1/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains old hot references when a fresh frontend shell replaces the previous shell', async () => {
    const { directory, shell, state, site } = await setup();
    await prepareRelease(shell, state, site, options);
    const oldPath = 'api/v1/snapshots/2026-11-25T12:00:00.000Z/summary.json';
    await stageState(advance(await loadState(state), run(time(5), null)), state);
    const newShell = join(directory, 'new-shell');
    await mkdir(newShell);
    await writeFile(join(newShell, 'index.html'), '<main>new frontend</main>');
    await writeFile(join(newShell, 'CNAME'), 'grid.thetamind.ai\n');
    const updated = join(directory, 'updated');
    await prepareRelease(newShell, state, updated, { ...options, previousReleaseDir: site });
    expect(await readFile(join(updated, oldPath), 'utf8')).toContain(time(0));
    expect(await readFile(join(updated, 'index.html'), 'utf8')).toContain('new frontend');
    expect((await validatePreparedRelease(updated, options)).snapshotId).toBe(time(5));
  });
  it('rejects missing shell, corrupt state, private files and fixture data', async () => {
    const { directory, shell, state, site } = await setup();
    await expect(prepareRelease(join(directory, 'missing'), state, site, options)).rejects.toThrow(/shell|ENOENT/i);
    await writeFile(join(state, 'state/latest.json'), '{}');
    await expect(prepareRelease(shell, state, site, options)).rejects.toThrow();
    const clean = await setup();
    await writeFile(join(clean.shell, 'collection-run.json'), '{}');
    await expect(prepareRelease(clean.shell, clean.state, clean.site, options)).rejects.toThrow(/unexpected|private/i);
    await rm(join(clean.shell, 'collection-run.json'));
    await mkdir(join(clean.shell, 'api/v1'), { recursive: true });
    await writeFile(join(clean.shell, 'api/v1/summary.json'), '{"dataMode":"fixture"}');
    await expect(prepareRelease(clean.shell, clean.state, clean.site, options)).rejects.toThrow(/fixture|undeclared/i);
  });
});

describe('snapshot branches use captured-SHA compare and swap', () => {
  it('initializes absent branches, updates snapshots and refuses unknown changes', async () => {
    const { repo, directory } = await repository();
    const source = join(directory, 'snapshot');
    await mkdir(source);
    await writeFile(join(source, 'hello.txt'), 'one');
    const initial = await readBranch(repo, 'data', join(directory, 'read'));
    expect(initial.sha).toBeNull();
    const first = await updateSnapshot(repo, initial, source, 'first');
    await writeFile(join(source, 'hello.txt'), 'two');
    await expect(updateSnapshot(repo, initial, source, 'racing initialization')).rejects.toThrow(/changed|lease|stale/i);
    const current = await readBranch(repo, 'data', join(directory, 'current'));
    expect(current.sha).toBe(first);
    expect(await readFile(join(current.directory, 'hello.txt'), 'utf8')).toBe('one');
    const second = await updateSnapshot(repo, current, source, 'second');
    await expect(updateSnapshot(repo, current, source, 'stale writer')).rejects.toThrow(/changed|lease|stale/i);
    expect((await readBranch(repo, 'data', join(directory, 'latest'))).sha).toBe(second);
    expect((await exec('git', ['-C', repo, 'rev-list', '--count', second])).stdout.trim()).toBe('1');
  });
  it('does not change data when full release validation fails', async () => {
    const { repo, directory } = await repository();
    const { shell, state, site } = await setup();
    await prepareRelease(shell, state, site, options);
    await writeFile(join(site, 'api/v1/summary.json'), '{}');
    const data = await readBranch(repo, 'data', join(directory, 'data'));
    const pages = await readBranch(repo, 'gh-pages', join(directory, 'pages'));
    await expect(publishRelease({ repository: repo, stateDir: state, siteDir: site, data, pages, ...options })).rejects.toThrow(/invalid/i);
    expect((await readBranch(repo, 'data', join(directory, 'after'))).sha).toBeNull();
  });
  it('recovers from data success followed by Pages CAS failure using durable state and shell', async () => {
    const { repo, directory } = await repository();
    const { shell, state, site } = await setup();
    const original = advance(emptyState(), run(time(0), 'degraded', [source()]));
    await stageState(original, state);
    await prepareRelease(shell, state, site, options);
    const data = await readBranch(repo, 'data', join(directory, 'data'));
    const pages = await readBranch(repo, 'gh-pages', join(directory, 'pages'));
    await updateSnapshot(repo, pages, site, 'another Pages writer');
    await expect(publishRelease({ repository: repo, stateDir: state, siteDir: site, data, pages, ...options })).rejects.toThrow(/changed|lease|stale/i);
    const retryData = await readBranch(repo, 'data', join(directory, 'retry-data'));
    const retryPages = await readBranch(repo, 'gh-pages', join(directory, 'retry-pages'));
    expect((await loadState(retryData.directory)).latest?.snapshotId).toBe(time(0));
    const retrySite = join(directory, 'retry-site');
    await prepareRelease(retryPages.directory, retryData.directory, retrySite, options);
    await publishRelease({ repository: repo, stateDir: retryData.directory, siteDir: retrySite, data: retryData, pages: retryPages, ...options });
    const durable = await readBranch(repo, 'gh-pages', join(directory, 'durable'));
    expect((await validatePreparedRelease(durable.directory, options)).snapshotId).toBe(time(0));
    const finalData = await readBranch(repo, 'data', join(directory, 'final-data'));
    expect((await loadState(finalData.directory)).ledger).toEqual(original.ledger);
    expect((await loadState(finalData.directory)).incidents).toEqual(original.incidents);
    // A deployment failure happens after these durable writes. Repeating assembly needs no artifact or collection.
    expect((await prepareRelease(durable.directory, retryData.directory, join(directory, 'rerun'), options)).valid).toBe(true);
  });
  it('backs up validated state for a 30-day artifact and rejects corrupt input', async () => {
    const directory = await root();
    const { state } = await setup();
    const archive = join(directory, 'state-2026-11-25.tar.gz');
    await backupState(state, archive);
    const restored = join(directory, 'restored');
    await mkdir(restored);
    await exec('tar', ['-xzf', archive, '-C', restored]);
    expect((await loadState(restored)).latest?.snapshotId).toBe(time(0));
    await writeFile(join(state, 'state/latest.json'), '{}');
    await expect(backupState(state, join(directory, 'corrupt.tar.gz'))).rejects.toThrow();
    await expect(readFile(join(directory, 'corrupt.tar.gz'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('queue recovery and frontend input identity', () => {
  it('skips a queued sync only within half a target interval and allows next/manual recovery', () => {
    expect(shouldSkipSync(time(2), time(0), 5, false)).toBe(true);
    expect(shouldSkipSync('2026-11-25T12:02:30.000Z', time(0), 5, false)).toBe(false);
    expect(shouldSkipSync(time(4), time(0), 10, false)).toBe(true);
    expect(shouldSkipSync(time(5), time(0), 10, false)).toBe(false);
    expect(shouldSkipSync(time(1), time(0), 5, true)).toBe(false);
    expect(shouldSkipSync(time(1), null, 5, false)).toBe(false);
    expect(shouldSkipSync(time(0), time(1), 5, false)).toBe(false);
  });
  it('keeps frontend A publishable after docs-only B and rejects it after frontend C', async () => {
    const { repo } = await repository();
    await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    await mkdir(join(repo, 'src/web'), { recursive: true });
    await writeFile(join(repo, 'src/web/App.tsx'), 'frontend A');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'A']);
    const a = await frontendFingerprint(repo, 'HEAD');
    await writeFile(join(repo, 'README.md'), 'docs B');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'B']);
    expect(await frontendFingerprint(repo, 'HEAD')).toBe(a);
    await writeFile(join(repo, 'src/web/App.tsx'), 'frontend C');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'C']);
    expect(await frontendFingerprint(repo, 'HEAD')).not.toBe(a);
  });
});

describe('workflow entrypoints stage before remote writes', () => {
  it('initializes an empty frontend but requires its durable shell for scheduled sync', async () => {
    const { repo, directory } = await repository();
    const { shell } = await setup();
    await expect(runWorkflowRelease({ repository: repo, workDir: join(directory, 'sync'), mode: 'sync', sourceSha: 'local' }))
      .rejects.toThrow(/shell|frontend/i);
    const result = await runWorkflowRelease({
      repository: repo, workDir: join(directory, 'frontend'), mode: 'frontend', shellDir: shell,
      sourceSha: 'local', ...options,
    });
    expect(result.status).toBe('published');
    expect((await readBranch(repo, 'data', join(directory, 'data'))).sha).toBeNull();
    const pages = await readBranch(repo, 'gh-pages', join(directory, 'pages'));
    expect((await validatePreparedRelease(pages.directory, options)).snapshotId).toBeNull();
  });
  it('refuses an existing corrupt data branch instead of treating it as first initialization', async () => {
    const { repo, directory } = await repository();
    const { shell } = await setup();
    const bad = join(directory, 'bad');
    await mkdir(bad);
    await writeFile(join(bad, 'unknown.txt'), 'not generated state');
    const before = await updateSnapshot(repo, { branch: 'data', sha: null, directory: bad }, bad, 'corrupt data');
    await expect(runWorkflowRelease({
      repository: repo, workDir: join(directory, 'frontend'), mode: 'frontend', shellDir: shell, sourceSha: 'local',
    })).rejects.toThrow();
    expect((await readBranch(repo, 'data', join(directory, 'after'))).sha).toBe(before);
    expect((await readBranch(repo, 'gh-pages', join(directory, 'pages'))).sha).toBeNull();
  });
  it('fails incomplete staged collection before replacing either durable branch', async () => {
    const { repo, directory } = await repository();
    const { shell } = await setup();
    await runWorkflowRelease({
      repository: repo, workDir: join(directory, 'frontend'), mode: 'frontend', shellDir: shell, sourceSha: 'local',
    });
    const pages = await readBranch(repo, 'gh-pages', join(directory, 'pages'));
    await expect(runWorkflowRelease({
      repository: repo, workDir: join(directory, 'sync'), mode: 'sync', sourceSha: 'local',
      collect: async (stateDir) => {
        const collection = run(time(0), null);
        const state = advance(emptyState(), collection);
        await stageState(state, stateDir);
        return { kind: 'valid', run: collection, state, hasProviderFailures: true };
      },
    })).rejects.toThrow(/invalid/i); // One provider cannot replace the full configured public scope.
    expect((await readBranch(repo, 'data', join(directory, 'after'))).sha).toBeNull();
    expect((await readBranch(repo, 'gh-pages', join(directory, 'unchanged'))).sha).toBe(pages.sha);
  });
  it('skips queued work then recovers with the next tick and manual retry without collecting again', async () => {
    const { repo, directory } = await repository();
    const { shell, state } = await setup();
    await updateSnapshot(repo, { branch: 'data', sha: null, directory: state }, state, 'initial state');
    await runWorkflowRelease({
      repository: repo, workDir: join(directory, 'frontend'), mode: 'frontend', shellDir: shell, sourceSha: 'local', ...options,
    });
    const shared = { repository: repo, mode: 'sync' as const, sourceSha: 'local', ...options };
    const skipped = await runWorkflowRelease({ ...shared, workDir: join(directory, 'queued'), now: time(2),
      collect: async () => { throw new Error('Queued run must skip collection'); } });
    expect(skipped.status).toBe('skipped');
    const next = await runWorkflowRelease({ ...shared, workDir: join(directory, 'next'), now: time(5),
      collect: async (stateDir) => {
        const collection = run(time(5), null);
        const state = advance(await loadState(stateDir), collection);
        await stageState(state, stateDir);
        return { kind: 'valid', run: collection, state, hasProviderFailures: true };
      } });
    expect(next.status).toBe('published');
    const retry = await runWorkflowRelease({ ...shared, mode: 'retry', workDir: join(directory, 'retry'), manual: true,
      collect: async () => { throw new Error('Retry must preserve state and ledger'); } });
    expect(retry.status).toBe('published');
    const durable = await readBranch(repo, 'data', join(directory, 'durable'));
    expect((await loadState(durable.directory)).latest?.snapshotId).toBe(time(5));
  });
  it('publishes frontend A after docs-only B but drops superseded A after frontend C', async () => {
    const { repo, directory } = await repository();
    await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    await mkdir(join(repo, 'src/web'), { recursive: true });
    await writeFile(join(repo, 'src/web/App.tsx'), 'A');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'A']);
    const a = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const fingerprint = await frontendFingerprint(repo, a);
    await writeFile(join(repo, 'README.md'), 'B');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'B']);
    await exec('git', ['-C', repo, 'push', 'origin', 'HEAD:refs/heads/main']);
    const { shell } = await setup();
    const request = { repository: repo, mode: 'frontend' as const, shellDir: shell, sourceSha: a, expectedFingerprint: fingerprint };
    expect((await runWorkflowRelease({ ...request, workDir: join(directory, 'a-after-b') })).status).toBe('published');
    const pages = await readBranch(repo, 'gh-pages', join(directory, 'published'));
    await writeFile(join(repo, 'src/web/App.tsx'), 'C');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'C']);
    await exec('git', ['-C', repo, 'push', 'origin', 'HEAD:refs/heads/main']);
    expect((await runWorkflowRelease({ ...request, workDir: join(directory, 'stale-a') })).status).toBe('skipped');
    expect((await readBranch(repo, 'gh-pages', join(directory, 'unchanged'))).sha).toBe(pages.sha);
  });
});

it('verifies the deployed snapshot and rejects old or fixture data over HTTP', async () => {
  let mode = 'live';
  const server = await withHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url?.includes('summary')
      ? JSON.stringify({ snapshotId: time(0), dataMode: mode })
      : request.url?.includes('manifest')
        ? JSON.stringify({ snapshotId: time(0), dataMode: mode, paths: { summary: '/api/v1/summary.json' } })
        : '<main>StatusGrid</main>');
  });
  try {
    await expect(verifyDeployment(server.url, time(0))).resolves.toBeUndefined();
    await expect(verifyDeployment(server.url, time(5))).rejects.toThrow(/snapshot/i);
    mode = 'fixture';
    await expect(verifyDeployment(server.url, time(0))).rejects.toThrow(/live|fixture/i);
  } finally { await server.close(); }
});
