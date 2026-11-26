import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { PersistedState } from '../types.js';
import { buildShards } from './archive.js';
import { absent, MARKER, safeDirectory } from './directory.js';
import { loadState, loadUnlockedState } from './load.js';
import { validateState } from './validate.js';

export async function stageState(
  input: PersistedState, directory: string, options: { expectedSnapshotId?: string | null } = {},
): Promise<void> {
  const state = validateState(input);
  const target = await safeDirectory(directory);
  await mkdir(dirname(target), { recursive: true });
  const lock = `${target}.lock`;
  try { await mkdir(lock); } catch (error) { throw new Error('State directory is locked by another writer', { cause: error }); }
  let staging: string | undefined;
  let backup: string | undefined;
  try {
    // Refuse higher versions, malformed shards, undeclared files and non-generated directories before replacement.
    const current = await loadUnlockedState(target);
    if (options.expectedSnapshotId !== undefined && options.expectedSnapshotId !== (current.latest?.snapshotId ?? null)) {
      throw new Error('Concurrent state snapshot changed since collection began');
    }
    staging = await mkdtemp(join(dirname(target), `.${basename(target)}.staging-`));
    const shards = buildShards(state);
    for (const [file, content] of Object.entries(shards)) {
      const path = join(staging, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx' });
    }
    await writeFile(join(staging, MARKER), `${JSON.stringify({
      kind: 'statusgrid-generated-state', schemaVersion: '1.0', files: Object.keys(shards).sort(),
    }, null, 2)}\n`, { flag: 'wx' });
    await loadState(staging);
    const previous = `${staging}.previous`;
    try { await rename(target, previous); backup = previous; }
    catch (error) { if (!absent(error)) throw error; }
    try { await rename(staging, target); staging = undefined; }
    catch (error) {
      if (backup) { await rename(backup, target); backup = undefined; }
      throw error;
    }
    if (backup) { await rm(backup, { recursive: true }); backup = undefined; }
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    // A failed rollback retains its generated backup for recovery.
    await rm(lock, { recursive: true });
  }
}
