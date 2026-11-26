import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { git } from './git.js';

// frontend.yml has no native paths filter: it asks this canonical set before building.
export const FRONTEND_PATHS = [
  'src/web/', 'src/shared/', 'public/', 'index.html', 'package.json', 'package-lock.json',
  'tsconfig.json', 'vite.config.ts', '.github/workflows/frontend.yml', '.github/workflows/pages.yml',
  'scripts/release-policy.ts',
] as const;
export async function frontendFingerprint(repository: string, ref: string): Promise<string> {
  const files = (await git(repository, ['ls-tree', '-r', '--full-tree', ref])).split('\n')
    .filter((line) => {
      const path = line.split('\t')[1];
      return path && FRONTEND_PATHS.some((entry) => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
    }).sort();
  return createHash('sha256').update(files.join('\n')).digest('hex');
}
export function shouldSkipSync(now: string, completedAt: string | null, interval: 5 | 10, manual: boolean): boolean {
  if (manual || !completedAt) return false;
  const age = Date.parse(now) - Date.parse(completedAt);
  return age >= 0 && age < interval * 60_000 / 2;
}
export async function readInterval(eventPath: string | undefined): Promise<5 | 10> {
  if (!eventPath) return 5;
  const event = JSON.parse(await readFile(eventPath, 'utf8')) as { inputs?: { interval?: string } };
  const value = event.inputs?.interval ?? '5';
  if (!['5', '10'].includes(value)) throw new Error('Interval must be 5 or 10 minutes');
  return Number(value) as 5 | 10;
}
