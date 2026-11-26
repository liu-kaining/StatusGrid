import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inventory } from '../src/collector/storage/directory.js';
import { execute, git } from './git.js';

export interface BranchSnapshot { branch: string; sha: string | null; directory: string }
async function branchRef(repository: string, branch: string) {
  const ref = `refs/heads/${branch}`;
  await git(repository, ['check-ref-format', ref]);
  return ref;
}
export async function readBranch(repository: string, branch: string, directory: string): Promise<BranchSnapshot> {
  const ref = await branchRef(repository, branch);
  const output = await git(repository, ['ls-remote', '--refs', 'origin', ref]);
  const sha = output ? output.split(/\s+/)[0]! : null;
  // A present but empty/unmarked branch is not initialization: consumers must validate it.
  if (!sha) return { branch, sha, directory: resolve(directory) };
  await mkdir(directory, { recursive: false });
  await git(repository, ['fetch', '--no-tags', 'origin', sha]);
  const temporary = await mkdtemp(join(tmpdir(), 'statusgrid-read-'));
  try {
    const archive = join(temporary, 'branch.tar');
    const { stdout } = await execute('git', ['-C', repository, 'archive', '--format=tar', sha], {
      encoding: 'buffer', maxBuffer: 128 * 1024 * 1024,
    });
    await writeFile(archive, stdout);
    await execute('tar', ['-xf', archive, '-C', directory]);
    await inventory(directory); // Reject symlinks before a caller can copy them.
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { branch, sha, directory: resolve(directory) };
}

/** Single-snapshot history bounds commit ancestry, not remote object or archive size. */
export async function updateSnapshot(repository: string, snapshot: BranchSnapshot, source: string, message: string): Promise<string> {
  const ref = await branchRef(repository, snapshot.branch);
  await inventory(source);
  const temporary = await mkdtemp(join(tmpdir(), 'statusgrid-index-'));
  const env = { GIT_INDEX_FILE: join(temporary, 'index'),
    GIT_AUTHOR_NAME: 'StatusGrid', GIT_AUTHOR_EMAIL: 'statusgrid@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'StatusGrid', GIT_COMMITTER_EMAIL: 'statusgrid@users.noreply.github.com' };
  try {
    await git(repository, ['read-tree', '--empty'], env);
    await git(repository, [`--work-tree=${resolve(source)}`, 'add', '--all', '--force', '.'], env);
    const tree = await git(repository, ['write-tree'], env);
    const sha = await git(repository, ['commit-tree', tree, '-m', message], env);
    try {
      // An empty expected value means the branch must still not exist.
      await git(repository, ['push', `--force-with-lease=${ref}:${snapshot.sha ?? ''}`, 'origin', `${sha}:${ref}`]);
    } catch (cause) { throw new Error(`Snapshot branch changed or lease rejected: ${snapshot.branch}`, { cause }); }
    return sha;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
