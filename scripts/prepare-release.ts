import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ReleaseOptions, ReleaseReport } from '../src/collector/export/types.js';
import { buildPublicArtifacts } from '../src/collector/export/json.js';
import { writePublicArtifacts } from '../src/collector/export/manifest.js';
import { validatePreviousRelease, validateRelease } from '../src/collector/export/validate.js';
import { generatedPath, PUBLIC_MARKER } from '../src/collector/export/directory.js';
import { inventory, safeDirectory } from '../src/collector/storage/directory.js';
import { loadState } from '../src/collector/storage/load.js';

export const RELEASE_MARKER = '.statusgrid-release.json';
export const receiptSchema = z.strictObject({
  kind: z.literal('statusgrid-release'), schemaVersion: z.literal('1.0'),
  mode: z.enum(['live', 'empty']), snapshotId: z.string().nullable(),
  sourceSha: z.string().nullable(), frontendFingerprint: z.string().nullable(),
});
export async function readReceipt(directory: string) {
  return receiptSchema.parse(JSON.parse(await readFile(join(directory, RELEASE_MARKER), 'utf8')));
}
export interface PrepareOptions extends ReleaseOptions {
  sourceSha?: string | null; frontendFingerprint?: string | null; previousReleaseDir?: string;
}
async function checkShell(directory: string): Promise<string[]> {
  const files = await inventory(directory);
  if (!files.includes('index.html')) throw new Error('Missing frontend shell index.html');
  if ((await readFile(join(directory, 'CNAME'), 'utf8')).trim() !== 'grid.thetamind.ai') {
    throw new Error('Unexpected public CNAME');
  }
  for (const path of files) {
    if (!['index.html', 'CNAME', 'favicon.svg', 'robots.txt', '.nojekyll', RELEASE_MARKER, PUBLIC_MARKER].includes(path)
      && !/^assets\/[^/]+\.(?:js|css|svg|png|webp|woff2?)$/.test(path) && !generatedPath.safeParse(path).success) {
      throw new Error(`Unexpected private or generated release file: ${path}`);
    }
    if (path.endsWith('.json') && /"dataMode"\s*:\s*"fixture"/.test(await readFile(join(directory, path), 'utf8'))) {
      throw new Error(`Fixture data rejected: ${path}`);
    }
  }
  return files;
}
export async function validatePreparedRelease(directory: string, options: ReleaseOptions = {}): Promise<ReleaseReport> {
  return validatePreparedReleaseWith(directory, options, validateRelease);
}
export async function validatePreviousPreparedRelease(directory: string, options: ReleaseOptions = {}): Promise<ReleaseReport> {
  return validatePreparedReleaseWith(directory, options, validatePreviousRelease);
}
async function validatePreparedReleaseWith(
  directory: string, options: ReleaseOptions, validate: typeof validateRelease,
): Promise<ReleaseReport> {
  const invalid = (message: string): ReleaseReport => ({
    valid: false, errors: [message], files: [], summaryGzipBytes: 0, snapshotId: null,
  });
  try {
    await safeDirectory(directory);
    const files = await checkShell(directory);
    const receipt = await readReceipt(directory);
    if (receipt.mode === 'empty') {
      if (receipt.snapshotId !== null || files.some((path) => generatedPath.safeParse(path).success || path === PUBLIC_MARKER)) {
        return invalid('Empty release contains public data');
      }
      return { valid: true, errors: [], files: [], summaryGzipBytes: 0, snapshotId: null };
    }
    const report = await validate(directory, { ...options, requireLive: true });
    if (receipt.snapshotId !== report.snapshotId) { report.errors.push('Release receipt snapshot mismatch'); report.valid = false; }
    return report;
  } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid prepared release'); }
}
export async function prepareRelease(
  shellDir: string, stateDir: string, destination: string, options: PrepareOptions = {},
): Promise<ReleaseReport> {
  await safeDirectory(destination);
  const shellFiles = await checkShell(shellDir);
  if (shellFiles.includes(PUBLIC_MARKER)) {
    const previous = await validatePreviousRelease(shellDir, { ...options, requireLive: true });
    if (!previous.valid) throw new Error(`Invalid shell data: ${previous.errors.join('; ')}`);
  }
  const state = await loadState(stateDir);
  await mkdir(destination, { recursive: false });
  await cp(shellDir, destination, { recursive: true });
  if (options.previousReleaseDir && options.previousReleaseDir !== shellDir) {
    const previous = await validatePreviousPreparedRelease(options.previousReleaseDir, options);
    if (!previous.valid) throw new Error(`Invalid previous release: ${previous.errors.join('; ')}`);
    for (const path of await inventory(options.previousReleaseDir)) {
      if (path !== PUBLIC_MARKER && !generatedPath.safeParse(path).success) continue;
      await mkdir(join(destination, path, '..'), { recursive: true });
      await copyFile(join(options.previousReleaseDir, path), join(destination, path));
    }
  }
  if (state.latest) await writePublicArtifacts(buildPublicArtifacts(state.latest, state), destination);
  await writeFile(join(destination, RELEASE_MARKER), `${JSON.stringify({
    kind: 'statusgrid-release', schemaVersion: '1.0', mode: state.latest ? 'live' : 'empty',
    snapshotId: state.latest?.snapshotId ?? null, sourceSha: options.sourceSha ?? null,
    frontendFingerprint: options.frontendFingerprint ?? null,
  })}\n`);
  await writeFile(join(destination, '.nojekyll'), '');
  const report = await validatePreparedRelease(destination, options);
  if (!report.valid) throw new Error(`Invalid prepared release: ${report.errors.join('; ')}`);
  return report;
}
