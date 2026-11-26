import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRelease } from '../src/collector/export/validate.js';

export function parseReleaseArgs(argv: string[]): { directory: string; requireLive: boolean } {
  let directory: string | undefined;
  let requireLive = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--dir' && !directory && argv[index + 1] && !argv[index + 1]!.startsWith('--')) directory = argv[++index];
    else if (flag === '--require-live' && !requireLive) requireLive = true;
    else throw new Error(`Unknown, duplicate or incomplete release flag: ${flag}`);
  }
  if (!directory) throw new Error('Release check requires --dir');
  return { directory, requireLive };
}
export async function main(argv: string[]): Promise<void> {
  const options = parseReleaseArgs(argv);
  const report = await validateRelease(resolve(options.directory), { requireLive: options.requireLive });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.valid ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Release validation failed');
    process.exitCode = 2;
  });
}
