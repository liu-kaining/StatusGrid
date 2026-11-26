import type { BranchSnapshot } from './update-snapshot.js';
import type { ReleaseOptions } from '../src/collector/export/types.js';
import { updateSnapshot } from './update-snapshot.js';
import { loadState } from '../src/collector/storage/load.js';
import { validatePreparedRelease } from './prepare-release.js';
export interface PublishOptions extends ReleaseOptions {
  repository: string; stateDir: string; siteDir: string; data: BranchSnapshot; pages: BranchSnapshot;
}
export async function publishRelease(options: PublishOptions): Promise<void> {
  const state = await loadState(options.stateDir);
  const report = await validatePreparedRelease(options.siteDir, options);
  if (!report.valid) throw new Error(`Invalid full release: ${report.errors.join('; ')}`);
  if (report.snapshotId !== (state.latest?.snapshotId ?? null)) throw new Error('Invalid state/release snapshot mismatch');
  // Separate CAS operations are deliberately not a transaction. Preserve data on later failure.
  if (state.latest) await updateSnapshot(options.repository, options.data, options.stateDir, `StatusGrid data ${state.latest.snapshotId}`);
  await updateSnapshot(options.repository, options.pages, options.siteDir, `StatusGrid release ${report.snapshotId ?? 'empty'}`);
}
