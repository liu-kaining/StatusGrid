import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { verifyDeployment, verifyDeploymentWithRetry } from '../../scripts/verify-deployment.js';
import { withHttpServer } from '../helpers/http-server.js';

const documents: Record<string, string> = {
  '': '<main>StatusGrid</main>',
  'api/v1/manifest.json': JSON.stringify({
    snapshotId: 'release-1', dataMode: 'live',
    paths: { summary: '/api/v1/snapshots/release-1/summary.json' },
  }),
  'api/v1/snapshots/release-1/summary.json': JSON.stringify({ snapshotId: 'release-1', dataMode: 'live' }),
};

function serve(path: string, response: ServerResponse, status = 200) {
  response.writeHead(documents[path] === undefined ? 404 : status);
  response.end(documents[path] ?? 'Not found');
}
const pathname = (url: string | undefined) => new URL(url ?? '/', 'http://localhost').pathname;

describe('deployment verification URLs', () => {
  it.each([
    { mode: 'live', snapshot: 'release-1', paths: [
      '/StatusGrid/', '/StatusGrid/api/v1/manifest.json', '/StatusGrid/api/v1/snapshots/release-1/summary.json',
    ] },
    { mode: 'empty', snapshot: null, paths: ['/StatusGrid/', '/StatusGrid/api/v1/manifest.json'] },
  ])('verifies a $mode project deployment without requesting the account root', async ({ snapshot, paths }) => {
    const requests: string[] = [];
    const server = await withHttpServer((request, response) => {
      const path = pathname(request.url);
      requests.push(path);
      if (!path.startsWith('/StatusGrid/')) {
        response.writeHead(404).end();
        return;
      }
      serve(path.slice('/StatusGrid/'.length), response, snapshot === null && path.endsWith('manifest.json') ? 404 : 200);
    });
    try {
      await expect(verifyDeployment(`${server.url}/StatusGrid/`, snapshot)).resolves.toBeUndefined();
      expect(requests).toEqual(paths);
    } finally { await server.close(); }
  });

  it('follows the project redirect and verifies API paths on the final site', async () => {
    const destinationRequests: string[] = [];
    const destination = await withHttpServer((request, response) => {
      destinationRequests.push(pathname(request.url));
      serve(pathname(request.url).slice(1), response);
    });
    const entryRequests: string[] = [];
    const entry = await withHttpServer((request, response) => {
      entryRequests.push(pathname(request.url));
      if (pathname(request.url) === '/StatusGrid/') response.writeHead(301, { Location: `${destination.url}/` }).end();
      else response.writeHead(404).end();
    });
    try {
      await expect(verifyDeployment(`${entry.url}/StatusGrid/`, 'release-1')).resolves.toBeUndefined();
      expect(entryRequests).toEqual(['/StatusGrid/']);
      expect(destinationRequests).toEqual(['/', '/api/v1/manifest.json', '/api/v1/snapshots/release-1/summary.json']);
    } finally {
      await Promise.all([entry.close(), destination.close()]);
    }
  });

  it.each([
    { path: '/', status: 503, snapshot: 'release-1' },
    { path: '/api/v1/manifest.json', status: 530, snapshot: 'release-1' },
    { path: '/api/v1/snapshots/release-1/summary.json', status: 500, snapshot: 'release-1' },
    { path: '/api/v1/manifest.json', status: 503, snapshot: null },
  ])('reports the actual HTTP $status and URL for a failed request to $path', async ({ path, status, snapshot }) => {
    const server = await withHttpServer((request, response) => {
      serve(pathname(request.url).slice(1), response, pathname(request.url) === path ? status : 200);
    });
    try {
      const error: unknown = await verifyDeployment(server.url, snapshot).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`HTTP ${status}`);
      expect((error as Error).message).toContain(`${server.url}${path}`);
    } finally { await server.close(); }
  });

  it('reads the new release through a shared URL cache instead of reusing an old fixed manifest', async () => {
    let current = 'release-1';
    const cache = new Map<string, string>();
    const server = await withHttpServer((request, response) => {
      const key = request.url ?? '/';
      const path = pathname(key);
      if (!cache.has(key)) {
        cache.set(key, path.includes('manifest')
          ? JSON.stringify({ snapshotId: current, dataMode: 'live',
            paths: { summary: `/api/v1/snapshots/${current}/summary.json` } })
          : path.includes('summary')
            ? JSON.stringify({ snapshotId: path.includes('release-2') ? 'release-2' : 'release-1', dataMode: 'live' })
            : '<main>StatusGrid</main>');
      }
      response.writeHead(200, { 'cache-control': 'max-age=600' }).end(cache.get(key));
    });
    try {
      await verifyDeployment(server.url, 'release-1');
      current = 'release-2';
      await expect(verifyDeployment(server.url, 'release-2')).resolves.toBeUndefined();
    } finally { await server.close(); }
  });

  it.each([
    { mismatch: 'manifest', expected: 'release-2', actual: 'release-1', path: '/api/v1/manifest.json' },
    { mismatch: 'summary', expected: 'release-1', actual: 'release-2', path: '/api/v1/snapshots/release-1/summary.json' },
  ])('keeps a real $mismatch mismatch as failure with expected, received and cache evidence', async ({ mismatch, expected, actual, path }) => {
    const server = await withHttpServer((request, response) => {
      response.setHeader('age', '300');
      response.setHeader('cf-cache-status', 'HIT');
      if (mismatch === 'summary' && pathname(request.url) === path) {
        response.writeHead(200).end(JSON.stringify({ snapshotId: actual, dataMode: 'live' }));
      } else serve(pathname(request.url).slice(1), response);
    });
    try {
      const error: unknown = await verifyDeployment(server.url, expected).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`expected ${expected}`);
      expect((error as Error).message).toContain(`received ${actual}`);
      expect((error as Error).message).toContain(`${server.url}${path}`);
      expect((error as Error).message).toContain('300');
      expect((error as Error).message).toContain('HIT');
    } finally { await server.close(); }
  });

  it('waits for propagation with a fresh request on each attempt and verifies the expected summary', async () => {
    let attempts = 0;
    let summaryRead = false;
    const cache = new Map<string, string>();
    const server = await withHttpServer((request, response) => {
      const path = pathname(request.url);
      if (path === '/api/v1/manifest.json') {
        if (!cache.has(request.url!)) {
          attempts++;
          cache.set(request.url!, JSON.stringify({
            snapshotId: attempts < 8 ? 'old-release' : 'release-1', dataMode: 'live',
            paths: { summary: '/api/v1/snapshots/release-1/summary.json' },
          }));
        }
        response.writeHead(200).end(cache.get(request.url!));
      } else {
        if (path.endsWith('summary.json')) summaryRead = true;
        serve(path.slice(1), response);
      }
    });
    try {
      await expect(verifyDeploymentWithRetry(server.url, 'release-1', { timeoutMs: 2000, retryDelayMs: 1 }))
        .resolves.toBeUndefined();
      expect(summaryRead).toBe(true);
      expect(attempts).toBe(8);
    } finally { await server.close(); }
  });

  it('bounds propagation waiting and retains a persistent wrong snapshot in the final error', async () => {
    let manifests = 0;
    const server = await withHttpServer((request, response) => {
      const path = pathname(request.url);
      // The second request deliberately stalls until the deadline, after the first
      // attempt has supplied a useful snapshot mismatch.
      if (path.includes('manifest') && ++manifests > 1) {
        response.writeHead(200, { 'content-type': 'application/json' }).write('{');
      } else serve(path.slice(1), response);
    });
    try {
      await expect(verifyDeploymentWithRetry(server.url, 'release-2', { timeoutMs: 1000, retryDelayMs: 1 }))
        .rejects.toThrow(/expected release-2, received release-1/);
      expect(manifests).toBe(2);
    } finally { await server.close(); }
  });

  it('cancels an unfinished response at the overall deadline without reading a summary', async () => {
    let summaryRead = false;
    let manifestStarted = false;
    const server = await withHttpServer((request, response) => {
      const path = pathname(request.url);
      if (path.includes('manifest')) {
        manifestStarted = true;
        response.writeHead(200, { 'content-type': 'application/json' }).write('{');
      } else {
        if (path.includes('summary')) summaryRead = true;
        serve(path.slice(1), response);
      }
    });
    try {
      await expect(verifyDeploymentWithRetry(server.url, 'release-1', { timeoutMs: 1000, retryDelayMs: 10 }))
        .rejects.toThrow(/timed out/i);
      expect(manifestStarted).toBe(true);
      expect(summaryRead).toBe(false);
    } finally { await server.close(); }
  });
});
