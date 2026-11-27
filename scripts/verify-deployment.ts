import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { readReceipt } from './prepare-release.js';
const envelope = z.object({ snapshotId: z.string(), dataMode: z.literal('live') });
function responseContext(response: Response): string {
  return `${response.url}; cache-control=${response.headers.get('cache-control') ?? 'unknown'}`
    + `; age=${response.headers.get('age') ?? 'unknown'}; cf-cache-status=${response.headers.get('cf-cache-status') ?? 'unknown'}`;
}
export async function verifyDeployment(url: string, snapshotId: string | null, signal?: AbortSignal): Promise<void> {
  const nonce = randomUUID();
  const get = (path: string, base: string | URL = url) => {
    const target = new URL(path, base);
    target.searchParams.set('__statusgrid_verify', nonce);
    return fetch(target, {
      cache: 'no-store', headers: { 'cache-control': 'no-cache, no-store, max-age=0', pragma: 'no-cache' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  };
  const index = await get('');
  if (!index.ok || !(await index.text()).includes('<')) {
    throw new Error(`Deployed shell is unavailable (HTTP ${index.status}: ${index.url})`);
  }
  const base = new URL(index.url);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const response = await get('api/v1/manifest.json', base);
  if (snapshotId === null) {
    if (response.status !== 404) {
      throw new Error(`Empty deployment manifest must return HTTP 404 (HTTP ${response.status}: ${response.url})`);
    }
    return;
  }
  if (!response.ok) throw new Error(`Deployed manifest is unavailable (HTTP ${response.status}: ${response.url})`);
  const manifest = envelope.extend({
    paths: z.object({ summary: z.string().regex(/^\/api\/v1\/[a-zA-Z0-9/._:-]+\.json$/) }),
  }).parse(await response.json());
  if (manifest.snapshotId !== snapshotId) {
    throw new Error(`Deployed manifest snapshot does not match release: expected ${snapshotId}, received ${manifest.snapshotId} (${responseContext(response)})`);
  }
  const summaryResponse = await get(manifest.paths.summary.slice(1), base);
  if (!summaryResponse.ok) throw new Error(`Deployed summary is unavailable (HTTP ${summaryResponse.status}: ${summaryResponse.url})`);
  const summary = envelope.parse(await summaryResponse.json());
  if (summary.snapshotId !== snapshotId) {
    throw new Error(`Deployed summary snapshot does not match release: expected ${snapshotId}, received ${summary.snapshotId} (${responseContext(summaryResponse)})`);
  }
}
export async function verifyDeploymentWithRetry(
  url: string, snapshotId: string | null,
  options: { timeoutMs?: number; retryDelayMs?: number; onRetry?: (error: Error, attempt: number) => void } = {},
): Promise<void> {
  const { timeoutMs = 120_000, retryDelayMs = 5_000, onRetry } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(retryDelayMs) || retryDelayMs <= 0) {
    throw new Error('Deployment verification timeout and retry delay must be positive integers');
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  let lastError: unknown;
  let attempt = 0;
  while (!deadline.aborted) {
    try {
      await verifyDeployment(url, snapshotId, deadline);
      return;
    } catch (error) {
      if (deadline.aborted) {
        lastError ??= error;
        break;
      }
      lastError = error;
      onRetry?.(error instanceof Error ? error : new Error(String(error)), ++attempt);
    }
    try { await setTimeout(retryDelayMs, undefined, { signal: deadline }); }
    catch (error) { if (!deadline.aborted) throw error; }
  }
  throw new Error(`Deployment verification timed out after ${timeoutMs} ms for ${snapshotId ?? 'empty shell'}: ${
    lastError instanceof Error ? lastError.message : String(lastError)
  }`, { cause: lastError });
}
export async function main(): Promise<void> {
  const url = process.env.DEPLOYMENT_URL;
  const directory = process.env.RELEASE_SITE;
  if (!url || !directory) throw new Error('Deployment URL and release site are required');
  const receipt = await readReceipt(directory);
  await verifyDeploymentWithRetry(url, receipt.snapshotId, {
    onRetry: (error, attempt) => console.warn(`Deployment not visible yet (attempt ${attempt}): ${error.message}`),
  });
  console.log(`Verified deployed ${receipt.snapshotId ?? 'empty shell'}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Deployment verification failed');
    process.exitCode = 2;
  });
}
