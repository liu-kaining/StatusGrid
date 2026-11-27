import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { archiveIndexSchema, manifestSchema } from '../../shared/public-schemas.js';
import { absent, inventory, safeDirectory } from '../storage/directory.js';
import { generatedPath, immutablePath, PUBLIC_MARKER, publicMarkerSchema, readPublicMarker, serialize, type PublicMarker } from './directory.js';
import { validatePreviousRelease, validateRelease } from './validate.js';
import type { PublicArtifacts } from './types.js';

async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) { if (absent(error)) return false; throw error; }
}
async function safeFile(directory: string, path: string): Promise<void> {
  generatedPath.parse(path);
  let current = join(directory, path);
  while (current !== directory) {
    if (await exists(current)) {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink artifact: ${current}`);
      if (current !== join(directory, path) && !stat.isDirectory()) throw new Error(`Invalid artifact parent: ${current}`);
    }
    current = dirname(current);
  }
}
function retain(marker: PublicMarker, artifacts: PublicArtifacts): PublicMarker {
  const cutoff = Date.parse(artifacts.manifest.generatedAt) - 60 * 60_000;
  const snapshots = [...marker.snapshots].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  const kept = snapshots.filter((snapshot, index) => index >= snapshots.length - 12 || Date.parse(snapshot.generatedAt) >= cutoff);
  const keep = new Set(Object.keys({ ...artifacts.files, ...artifacts.feeds }));
  for (const snapshot of kept) {
    const prefix = `api/v1/snapshots/${snapshot.snapshotId}/`;
    for (const path of marker.files) if (path.startsWith(prefix)) keep.add(path);
  }
  const latestTwo = new Set<string>();
  const monthVersions = marker.monthVersions;
  for (const month of new Set(monthVersions.map(({ month }) => month))) {
    monthVersions.filter((version) => version.month === month).slice(-2).forEach(({ path }) => latestTwo.add(path));
  }
  for (const path of latestTwo) keep.add(path);
  return { ...marker, snapshots: kept, files: [...keep].sort() };
}

/** Stage and validate generated files; publish individual declared files, discovery manifest last. */
export async function writePublicArtifacts(artifacts: PublicArtifacts, directory: string): Promise<void> {
  const target = await safeDirectory(directory);
  await mkdir(dirname(target), { recursive: true });
  const lock = `${target}.public-lock`;
  try { await mkdir(lock); } catch (error) { throw new Error('Public output locked by another writer', { cause: error }); }
  let staging: string | undefined;
  const changed: string[] = [];
  const backups = new Map<string, Buffer | null>();
  try {
    await mkdir(target, { recursive: true });
    const previous = await exists(join(target, PUBLIC_MARKER)) ? await readPublicMarker(target) : publicMarkerSchema.parse({
      kind: 'statusgrid-public', schemaVersion: '1.0', files: [], snapshots: [], monthVersions: [],
    });
    for (const path of await inventory(target)) {
      if (generatedPath.safeParse(path).success && !previous.files.includes(path)) {
        throw new Error(`Undeclared generated artifact: ${path}`);
      }
    }
    if (previous.files.length) {
      const validation = await validatePreviousRelease(target, { providerIds: Object.keys(artifacts.manifest.paths.providers) });
      if (!validation.valid) throw new Error(`Previous public release is invalid: ${validation.errors.join('; ')}`);
      if (previous.snapshots.some(({ generatedAt }) => Date.parse(generatedAt) > Date.parse(artifacts.manifest.generatedAt))) {
        throw new Error('Cannot publish an older snapshot over a newer release');
      }
    }
    const bodies: Record<string, string> = {
      ...Object.fromEntries(Object.entries(artifacts.files).map(([path, value]) => [path, serialize(value)])),
      ...artifacts.feeds,
    };
    for (const [path, body] of Object.entries(bodies)) {
      await safeFile(target, path);
      if (await exists(join(target, path))) {
        if (!previous.files.includes(path)) throw new Error(`Refuse undeclared generated replacement: ${path}`);
        if (immutablePath(path) && await readFile(join(target, path), 'utf8') !== body) throw new Error(`Immutable snapshot/revision collision: ${path}`);
      }
    }
    const marker: PublicMarker = { ...previous, files: [...new Set([...previous.files, ...Object.keys(bodies)])],
      snapshots: [...previous.snapshots.filter(({ snapshotId }) => snapshotId !== artifacts.manifest.snapshotId), {
        snapshotId: artifacts.manifest.snapshotId, generatedAt: artifacts.manifest.generatedAt,
        manifestPath: `api/v1/snapshots/${artifacts.manifest.snapshotId}/manifest.json`,
      }], monthVersions: [...previous.monthVersions] };
    for (const archive of artifacts.archives) {
      const path = `api/v1/incidents/archive/${archive.month}/${archive.revision}.json`;
      if (!marker.monthVersions.some((version) => version.path === path)) marker.monthVersions.push({
        month: archive.month, revision: archive.revision, path, publishedAt: artifacts.manifest.generatedAt,
      });
    }
    const next = retain(marker, artifacts);
    staging = await mkdtemp(join(dirname(target), '.statusgrid-public-stage-'));
    // Resolve references from every retained hot manifest, including reused cold revisions.
    const keep = new Set(next.files);
    for (const snapshot of next.snapshots) {
      const manifest = manifestSchema.parse(artifacts.files[snapshot.manifestPath]
        ?? JSON.parse(await readFile(join(target, snapshot.manifestPath), 'utf8')));
      keep.add(manifest.paths.archiveIndex.slice(1));
      const index = archiveIndexSchema.parse(artifacts.files[manifest.paths.archiveIndex.slice(1)]
        ?? JSON.parse(await readFile(join(target, manifest.paths.archiveIndex.slice(1)), 'utf8')));
      for (const month of index.months) keep.add(month.path.slice(1));
    }
    next.files = [...keep].sort();
    next.monthVersions = next.monthVersions.filter(({ path }) => keep.has(path));
    for (const path of next.files) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      if (bodies[path] !== undefined) await writeFile(join(staging, path), bodies[path]!, 'utf8');
      else await copyFile(join(target, path), join(staging, path));
    }
    await writeFile(join(staging, PUBLIC_MARKER), serialize(next));
    const validation = await validateRelease(staging, { providerIds: Object.keys(artifacts.manifest.paths.providers) });
    if (!validation.valid) throw new Error(`Staged public release invalid: ${validation.errors.join('; ')}`);
    const order = next.files.filter((path) => path !== 'api/v1/manifest.json');
    order.push('api/v1/manifest.json', PUBLIC_MARKER);
    for (const path of order) {
      const destination = join(target, path);
      if (path !== PUBLIC_MARKER) await safeFile(target, path);
      backups.set(path, await exists(destination) ? await readFile(destination) : null);
      await mkdir(dirname(destination), { recursive: true });
      await rename(join(staging, path), destination);
      changed.push(path);
    }
    // Cleanup is exclusively the prior declared inventory minus the retained reference closure.
    for (const path of previous.files.filter((path) => !keep.has(path))) {
      await safeFile(target, path);
      backups.set(path, await readFile(join(target, path)));
      await rm(join(target, path));
      changed.push(path);
    }
  } catch (error) {
    for (const path of changed.reverse()) {
      const backup = backups.get(path);
      if (backup) await writeFile(join(target, path), backup);
      else await rm(join(target, path), { force: true });
    }
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rmdir(lock);
  }
}
