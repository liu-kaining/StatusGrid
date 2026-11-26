import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const execute = promisify(execFile);
export async function git(repository: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return (await execute('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-C', repository, ...args], {
    env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
  })).stdout.trim();
}
