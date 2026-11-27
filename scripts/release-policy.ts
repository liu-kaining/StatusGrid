import { createHash } from 'node:crypto';
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
