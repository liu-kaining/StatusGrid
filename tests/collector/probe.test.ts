import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpClient } from '../../src/collector/http.js';
import { probeProvider } from '../../scripts/probe.js';
import { withHttpServer } from '../helpers/http-server.js';

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

it.each([
  { githubActions: undefined, environment: 'local' },
  { githubActions: 'true', environment: 'github-actions' },
])('writes actual response bytes and G0 metadata for $environment without claiming semantics', async ({ githubActions, environment }) => {
  vi.stubEnv('GITHUB_ACTIONS', githubActions);
  const local = await withHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json;charset=utf-16' });
    response.end(Buffer.from([0xfe, 0xff, 0x00, 0x5b, 0x00, 0x5d]));
  });
  servers.push(local);
  const output = await mkdtemp(join(tmpdir(), 'statusgrid-probe-'));
  const directory = await probeProvider({
    id: 'aws-cn',
    adapter: { endpoints: { current: `${local.url}/public/currentevents` }, timeoutMs: 500, retries: 0 },
  }, createHttpClient({ timeoutMs: 500, retries: 0 }), output);
  const bytes = await readFile(join(directory, 'responses/current.body'));
  const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')) as Record<string, unknown>;
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) as Record<string, unknown>;
  expect(bytes).toEqual(Buffer.from([0xfe, 0xff, 0x00, 0x5b, 0x00, 0x5d]));
  expect(metadata).toMatchObject({
    providerId: 'aws-cn',
    environment,
    responses: {
      current: {
        statusCode: 200,
        encoding: 'utf-16be',
        bodyBytes: 6,
        bodyHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
    },
  });
  expect(new Date(String(metadata.checkedAt)).toISOString()).toBe(metadata.checkedAt);
  expect(result).toMatchObject({ transport: 'success', semanticChecks: [], parserVersion: null });
  expect(result).not.toHaveProperty('status');
});

it('returns a failure and creates no success report when an endpoint fails', async () => {
  const local = await withHttpServer((_request, response) => {
    response.writeHead(404);
    response.end('missing');
  });
  servers.push(local);
  const output = await mkdtemp(join(tmpdir(), 'statusgrid-probe-fail-'));
  await expect(probeProvider({
    id: 'test',
    adapter: { endpoints: { current: `${local.url}/missing` }, timeoutMs: 500, retries: 0 },
  }, createHttpClient({ timeoutMs: 500, retries: 0 }), output)).rejects.toMatchObject({ kind: 'http_error' });
  const runs = await readdir(output);
  expect(runs).toHaveLength(1);
  expect(await readdir(join(output, runs[0]!, 'test'))).not.toContain('result.json');
});

it('exits nonzero for a non-configured provider without claiming success', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/probe.ts', '--provider', 'nonexistent'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('G0 transport evidence saved');
  expect(result.stderr).toContain('Unknown or disabled provider');
});
