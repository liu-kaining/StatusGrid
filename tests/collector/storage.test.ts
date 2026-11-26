import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, applyCollection } from '../../src/collector/events/reconcile.js';
import { loadState } from '../../src/collector/storage/load.js';
import { stageState } from '../../src/collector/storage/save.js';
import { source, run, time } from '../helpers/history.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'statusgrid-state-test-'));
  temporary.push(root);
  return join(root, 'generated');
}

describe('generated persisted state transaction', () => {
  it('distinguishes a missing state from corruption and refuses arbitrary non-generated directories', async () => {
    const dir = await directory();
    expect(await loadState(dir)).toEqual(emptyState());
    await mkdir(dir);
    await writeFile(join(dir, 'source.txt'), 'keep');
    await expect(loadState(dir)).rejects.toThrow(/generated|missing|corrupt/i);
    await expect(stageState(emptyState(), dir)).rejects.toThrow(/generated|unsafe/i);
    expect(await readFile(join(dir, 'source.txt'), 'utf8')).toBe('keep');
    await expect(stageState(emptyState(), process.cwd())).rejects.toThrow(/unsafe|generated/i);
  });

  it('round trips every shard, corrects closed archives across months and remains semantically idempotent', async () => {
    const dir = await directory();
    const opened = '2026-10-31T23:55:00.000Z';
    let state = applyCollection(emptyState(), run(opened, 'degraded', [source({ startedAt: opened, updatedAt: opened })]));
    await stageState(state, dir);
    state = await loadState(dir);
    state = applyCollection(state, run(time(5), 'operational', [source({
      startedAt: opened, updatedAt: time(5), state: 'resolved', resolvedAt: time(5), resolvedTimeBasis: 'source',
    })], []));
    await stageState(state, dir);
    const indexBefore = await readFile(join(dir, 'incidents/archive/index.json'), 'utf8');
    const archiveBefore = await readFile(join(dir, 'incidents/archive/2026-10.json'), 'utf8');
    expect(await loadState(dir)).toEqual(state);
    const archive = JSON.parse(archiveBefore);
    expect(archive.incidents[0]).toMatchObject({ resolvedAt: time(5), episode: 1 });
    expect(JSON.parse(indexBefore).months[0]).toMatchObject({ month: '2026-10', incidentCount: 1 });
    state = applyCollection(await loadState(dir), run(time(5), 'operational', [source({
      startedAt: opened, updatedAt: time(5), state: 'resolved', resolvedAt: time(5), resolvedTimeBasis: 'source',
    })], []));
    await stageState(state, dir);
    expect(await readFile(join(dir, 'incidents/archive/index.json'), 'utf8')).toBe(indexBefore);
    expect(await readFile(join(dir, 'incidents/archive/2026-10.json'), 'utf8')).toBe(archiveBefore);
    expect((await readdir(join(dir, 'state'))).sort()).toEqual([
      'collector-health.json', 'incident-identities.json', 'latest.json', 'notification-ledger.json',
      'observations.json', 'open-incidents.json',
    ]);
    expect(await readdir(join(dir, 'providers'))).toEqual(['github.json']);
    expect(await readdir(join(dir, 'rollup'))).toEqual(['daily-stats-90d.json']);
    const corrected = applyCollection(state, run(time(10), 'operational', [source({
      startedAt: opened, updatedAt: time(10), state: 'resolved', resolvedAt: time(5), resolvedTimeBasis: 'source',
      postmortemUrl: 'https://www.githubstatus.com/review',
    })], []));
    await stageState(corrected, dir);
    expect(JSON.parse(await readFile(join(dir, 'incidents/archive/2026-10.json'), 'utf8')).incidents[0].postmortemUrl)
      .toBe('https://www.githubstatus.com/review');
  });

  it.each([
    ['state/latest.json', { schemaVersion: '2.0', run: null }],
    ['state/notification-ledger.json', { schemaVersion: '1.0', milestones: [{ id: 'broken' }], aliases: {} }],
    ['providers/github.json', { schemaVersion: '1.0', provider: { providerId: 'github' } }],
    ['incidents/archive/2026-11.json', { schemaVersion: '1.0', month: '2026-11', incidents: [] }],
    ['rollup/daily-stats-90d.json', { schemaVersion: '1.0', providers: { github: [{ date: 'bogus' }] } }],
    ['state/observations.json', { schemaVersion: '1.0', providers: { github: [{ at: 'invalid' }] } }],
  ])('refuses corrupt %s before any overwrite', async (shard, invalid) => {
    const dir = await directory();
    const state = applyCollection(emptyState(), run(time(0), 'degraded', [source()]));
    await stageState(state, dir);
    const before = await readFile(join(dir, 'state/open-incidents.json'), 'utf8');
    await writeFile(join(dir, shard), JSON.stringify(invalid));
    await expect(loadState(dir)).rejects.toThrow(/schema|corrupt|invalid|version/i);
    await expect(stageState(state, dir)).rejects.toThrow(/schema|corrupt|invalid|version/i);
    expect(await readFile(join(dir, shard), 'utf8')).toBe(JSON.stringify(invalid));
    expect(await readFile(join(dir, 'state/open-incidents.json'), 'utf8')).toBe(before);
  });

  it('rejects internally inconsistent input and leaves the previous generation intact', async () => {
    const dir = await directory();
    const state = applyCollection(emptyState(), run(time(0), 'degraded', [source()]));
    await stageState(state, dir);
    const before = await readFile(join(dir, 'state/latest.json'), 'utf8');
    const broken = structuredClone(state);
    broken.openIncidents = [];
    await expect(stageState(broken, dir)).rejects.toThrow(/inconsistent|open|corrupt/i);
    expect(await readFile(join(dir, 'state/latest.json'), 'utf8')).toBe(before);
    expect(await loadState(dir)).toEqual(state);
  });

  it('round trips multiple interleaved identities and episodes without corrupting open shard ordering', async () => {
    const dir = await directory();
    let state = applyCollection(emptyState(), run(time(0), 'degraded', [
      source(), source({ sourceIdentity: 'github:second', upstreamId: 'second' }),
    ]));
    state = applyCollection(state, run(time(5), 'degraded', [source({
      state: 'resolved', resolvedAt: time(5), resolvedTimeBasis: 'source', updatedAt: time(5),
    })], ['github:second']));
    state = applyCollection(state, run(time(20), 'degraded', [source({ updatedAt: time(20) })]));
    await stageState(state, dir);
    expect(await loadState(dir)).toEqual(state);
  });

  it('refuses semantically invalid rollups even if each numeric field passes the structural schema', async () => {
    const dir = await directory();
    const state = applyCollection(emptyState(), run(time(0), 'operational'));
    state.dailyStats.github!.at(-1)!.observedCoverageMinutes = 600;
    await expect(stageState(state, dir)).rejects.toThrow(/rollup|statistics|inconsistent/i);
  });

  it('refuses symlink shards, read-during-replacement, and stale concurrent writers', async () => {
    const dir = await directory();
    const first = applyCollection(emptyState(), run(time(0), 'operational'));
    await stageState(first, dir);
    await mkdir(`${dir}.lock`);
    await expect(loadState(dir)).rejects.toThrow(/lock|writer|progress/i);
    await expect(stageState(first, dir)).rejects.toThrow(/lock|writer/i);
    await rm(`${dir}.lock`, { recursive: true });
    const second = applyCollection(first, run(time(5), 'operational'));
    await stageState(second, dir, { expectedSnapshotId: time(0) });
    await expect(stageState(first, dir, { expectedSnapshotId: time(0) })).rejects.toThrow(/concurrent|changed|snapshot/i);
    expect((await loadState(dir)).latest?.snapshotId).toBe(time(5));
    const openPath = join(dir, 'state/open-incidents.json');
    const original = await readFile(openPath, 'utf8');
    await writeFile(join(dir, '../external.json'), original);
    await rm(openPath);
    await symlink(join(dir, '../external.json'), openPath);
    await expect(loadState(dir)).rejects.toThrow(/unsafe|symlink/i);
    await expect(stageState(second, dir)).rejects.toThrow(/unsafe|symlink/i);
    expect(await readFile(join(dir, '../external.json'), 'utf8')).toBe(original);
  });

  it('retains only the boundary predecessor needed for original-cadence extrapolation', async () => {
    const dir = await directory();
    let state = applyCollection(emptyState(), run('2026-08-27T23:55:00.000Z', 'operational'));
    state = applyCollection(state, run(time(0), 'operational'));
    expect(state.dailyStats.github?.[0]).toMatchObject({
      date: '2026-08-28', observedCoverageMinutes: 5, unknownMinutes: 1435,
    });
    await stageState(state, dir);
    expect(await loadState(dir)).toEqual(state);
  });
});
