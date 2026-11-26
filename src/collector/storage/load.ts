import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { PersistedState } from '../types.js';
import { emptyState } from '../events/reconcile.js';
import { buildShards } from './archive.js';
import { buildDailyStats } from './rollup.js';
import { absent, inventory, MARKER, markerSchema, readJson, safeDirectory } from './directory.js';
import { assertEqual, dailyStatsSchema, identitiesSchema, incidentSchema, ledgerSchema, observationsSchema, runSchema, validateState, version } from './validate.js';

export async function loadState(directory: string): Promise<PersistedState> {
  const target = await safeDirectory(directory);
  const checkLock = async () => {
    try { await lstat(`${target}.lock`); }
    catch (error) { if (absent(error)) return; throw error; }
    throw new Error('State replacement is in progress: directory locked by a writer');
  };
  await checkLock();
  const state = await loadUnlockedState(target);
  await checkLock();
  return state;
}

/** Internal reader used while stageState already owns the generated-directory lock. */
export async function loadUnlockedState(directory: string): Promise<PersistedState> {
  const target = await safeDirectory(directory);
  try { await lstat(target); } catch (error) { if (absent(error)) return emptyState(); throw error; }
  const marker = markerSchema.parse(await readJson(join(target, MARKER)));
  if (marker.files.some((file) => file.split('/').includes('..')) || new Set(marker.files).size !== marker.files.length) {
    throw new Error('Corrupt generated state inventory');
  }
  assertEqual(await inventory(target), [...marker.files, MARKER].sort(), 'generated directory inventory');
  const shards = Object.fromEntries(await Promise.all(marker.files.map(async (file) => [file, await readJson(join(target, file))])));
  const latest = z.strictObject({ schemaVersion: version, run: runSchema.nullable() }).parse(shards['state/latest.json']);
  const open = z.strictObject({ schemaVersion: version, incidents: z.array(incidentSchema) }).parse(shards['state/open-incidents.json']);
  const identities = z.strictObject({ schemaVersion: version, identities: identitiesSchema }).parse(shards['state/incident-identities.json']);
  const ledger = z.strictObject({ schemaVersion: version, ...ledgerSchema.shape }).parse(shards['state/notification-ledger.json']);
  const observations = z.strictObject({ schemaVersion: version, providers: observationsSchema }).parse(shards['state/observations.json']);
  const stats = z.strictObject({ schemaVersion: version, providers: dailyStatsSchema }).parse(shards['rollup/daily-stats-90d.json']);
  const archiveSchema = z.strictObject({
    schemaVersion: version, month: z.string().regex(/^\d{4}-\d{2}$/), revision: z.string().min(1),
    updatedAt: z.string(), incidents: z.array(incidentSchema),
  });
  const incidents = Object.entries(shards).filter(([file]) => /^incidents\/archive\/\d{4}-\d{2}\.json$/.test(file))
    .flatMap(([file, value]) => {
      const archive = archiveSchema.parse(value);
      if (file !== `incidents/archive/${archive.month}.json`
        || archive.incidents.some(({ startedAt }) => startedAt.slice(0, 7) !== archive.month)) throw new Error('Corrupt archive month');
      return archive.incidents;
    });
  incidents.sort((a, b) => a.sourceIdentity.localeCompare(b.sourceIdentity) || a.episode - b.episode);
  const revision = marker.derivedRollupRevision ?? 1;
  const state = validateState({
    schemaVersion: '1.0', latest: latest.run, incidents, openIncidents: open.incidents, identities: identities.identities,
    ledger: { milestones: ledger.milestones, aliases: ledger.aliases }, observations: observations.providers, dailyStats: stats.providers,
  }, revision);
  const expected = buildShards(state);
  assertEqual(Object.keys(shards).sort(), Object.keys(expected).sort(), 'required shards');
  for (const [file, content] of Object.entries(expected)) assertEqual(shards[file], content, file);
  if (revision === 1 && state.latest) {
    for (const provider of Object.keys(state.observations)) {
      state.dailyStats[provider] = buildDailyStats(state, state.latest.completedAt, state.latest.intervalMinutes, provider);
    }
  }
  return state;
}
