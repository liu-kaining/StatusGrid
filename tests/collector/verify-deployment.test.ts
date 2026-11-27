import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { verifyDeployment } from '../../scripts/verify-deployment.js';
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

describe('deployment verification URLs', () => {
  it.each([
    { mode: 'live', snapshot: 'release-1', paths: [
      '/StatusGrid/', '/StatusGrid/api/v1/manifest.json', '/StatusGrid/api/v1/snapshots/release-1/summary.json',
    ] },
    { mode: 'empty', snapshot: null, paths: ['/StatusGrid/', '/StatusGrid/api/v1/manifest.json'] },
  ])('verifies a $mode project deployment without requesting the account root', async ({ snapshot, paths }) => {
    const requests: string[] = [];
    const server = await withHttpServer((request, response) => {
      const path = request.url ?? '';
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
      destinationRequests.push(request.url ?? '');
      serve((request.url ?? '').slice(1), response);
    });
    const entryRequests: string[] = [];
    const entry = await withHttpServer((request, response) => {
      entryRequests.push(request.url ?? '');
      if (request.url === '/StatusGrid/') response.writeHead(301, { Location: `${destination.url}/` }).end();
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
      serve((request.url ?? '').slice(1), response, request.url === path ? status : 200);
    });
    try {
      const error: unknown = await verifyDeployment(server.url, snapshot).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`HTTP ${status}`);
      expect((error as Error).message).toContain(`${server.url}${path}`);
    } finally { await server.close(); }
  });
});
