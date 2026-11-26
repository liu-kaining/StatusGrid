import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { readReceipt } from './prepare-release.js';
const envelope = z.object({ snapshotId: z.string(), dataMode: z.literal('live') });
export async function verifyDeployment(url: string, snapshotId: string | null): Promise<void> {
  const get = (path: string) => fetch(new URL(path, url), { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  const index = await get('/');
  if (!index.ok || !(await index.text()).includes('<')) throw new Error('Deployed shell is unavailable');
  const response = await get('/api/v1/manifest.json');
  if (snapshotId === null) {
    if (response.status !== 404) throw new Error('Empty deployment unexpectedly serves public data');
    return;
  }
  if (!response.ok) throw new Error('Deployed manifest is unavailable');
  const manifest = envelope.extend({
    paths: z.object({ summary: z.string().regex(/^\/api\/v1\/[a-zA-Z0-9/._:-]+\.json$/) }),
  }).parse(await response.json());
  if (manifest.snapshotId !== snapshotId) throw new Error('Deployed manifest snapshot does not match release');
  const summaryResponse = await get(manifest.paths.summary);
  if (!summaryResponse.ok) throw new Error('Deployed summary is unavailable');
  const summary = envelope.parse(await summaryResponse.json());
  if (summary.snapshotId !== snapshotId) throw new Error('Deployed summary snapshot does not match release');
}
export async function main(): Promise<void> {
  const url = process.env.DEPLOYMENT_URL;
  const directory = process.env.RELEASE_SITE;
  if (!url || !directory) throw new Error('Deployment URL and release site are required');
  const receipt = await readReceipt(directory);
  for (let attempt = 0; ; attempt++) {
    try { await verifyDeployment(url, receipt.snapshotId); break; }
    catch (error) {
      if (attempt >= 5) throw error;
      await setTimeout(5_000);
    }
  }
  console.log(`Verified deployed ${receipt.snapshotId ?? 'empty shell'}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Deployment verification failed');
    process.exitCode = 2;
  });
}
