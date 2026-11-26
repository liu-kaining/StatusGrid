import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRelease } from '../src/collector/export/validate.js';
import { validatePreparedRelease } from './prepare-release.js';

export function parseReleaseArgs(argv: string[]): { directory: string; requireLive: boolean; allowEmpty?: boolean } {
  let directory: string | undefined;
  let requireLive = false;
  let allowEmpty: boolean | undefined;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--dir' && !directory && argv[index + 1] && !argv[index + 1]!.startsWith('--')) directory = argv[++index];
    else if (flag === '--require-live' && !requireLive) requireLive = true;
    else if (flag === '--allow-empty' && !allowEmpty) allowEmpty = true;
    else throw new Error(`Unknown, duplicate or incomplete release flag: ${flag}`);
  }
  if (!directory) throw new Error('Release check requires --dir');
  return { directory, requireLive, ...(allowEmpty ? { allowEmpty } : {}) };
}
export async function main(argv: string[]): Promise<void> {
  const options = parseReleaseArgs(argv);
  const report = options.allowEmpty ? await validatePreparedRelease(resolve(options.directory), { requireLive: true })
    : await validateRelease(resolve(options.directory), { requireLive: options.requireLive });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.valid ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Release validation failed');
    process.exitCode = 2;
  });
}
