import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

export const MARKER = '.statusgrid-state.json';
export const markerSchema = z.strictObject({
  kind: z.literal('statusgrid-generated-state'), schemaVersion: z.literal('1.0'),
  derivedRollupRevision: z.union([z.literal(1), z.literal(2)]).optional(),
  files: z.array(z.string().regex(/^(state|providers|rollup|incidents)\/[a-zA-Z0-9/.-]+\.json$/)),
});
export const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export async function safeDirectory(directory: string): Promise<string> {
  const target = resolve(directory);
  const cwd = resolve(process.cwd());
  if (target === sep || target === homedir() || target === cwd || cwd.startsWith(`${target}${sep}`)
    || ['src', 'tests', 'registry', 'docs', '.git', 'node_modules'].some((part) =>
      target === join(cwd, part) || target.startsWith(`${join(cwd, part)}${sep}`))) {
    throw new Error(`Unsafe generated state directory: ${target}`);
  }
  let current = target;
  while (true) {
    try {
      const stat = await lstat(current);
      // macOS exposes its temporary directory through the system /var alias.
      if ((stat.isSymbolicLink() && !['/var', '/tmp'].includes(current))
        || (!stat.isDirectory() && !stat.isSymbolicLink())) throw new Error(`Unsafe generated state path: ${current}`);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}

export async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`Corrupt or missing state shard: ${path}`, { cause: error }); }
}

export async function inventory(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error(`Unsafe state shard: ${path}`);
    if (entry.isDirectory()) paths.push(...await inventory(directory, path)); else paths.push(path);
  }
  return paths.sort();
}
