import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadState } from '../src/collector/storage/load.js';
import { execute } from './git.js';
export async function backupState(stateDir: string, destination: string): Promise<void> {
  const state = await loadState(stateDir);
  if (!state.latest) throw new Error('No collected state to back up');
  await mkdir(dirname(destination), { recursive: true });
  await execute('tar', ['-czf', resolve(destination), '-C', resolve(stateDir), '.']);
}
