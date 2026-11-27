import { fileURLToPath } from 'node:url';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import config from '../../workers/scheduler/wrangler.json';

let runtime: Miniflare | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

describe('scheduler in the Workers runtime', () => {
  it.each([
    { status: 200, outcome: 'ok' },
    { status: 204, outcome: 'ok' },
    { status: 307, outcome: 'exception' },
    { status: 401, outcome: 'exception' },
  ])('sends one request and reports $outcome for HTTP $status', async ({ status, outcome }) => {
    const requests: { url: string; authorization: string | null; body: unknown }[] = [];
    runtime = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(new URL('../../workers/scheduler/index.js', import.meta.url)),
      compatibilityDate: config.compatibility_date,
      cf: false,
      unsafeTriggerHandlers: true,
      log: new Log(LogLevel.NONE),
      bindings: {
        GITHUB_TOKEN: 'test-private-token',
        GITHUB_REPOSITORY: 'liu-kaining/StatusGrid',
        GITHUB_REF: 'main',
      },
      outboundService: async (request) => {
        requests.push({
          url: request.url,
          authorization: request.headers.get('authorization'),
          body: await request.json(),
        });
        return new Response(null, {
          status,
          headers: status === 307 ? { Location: 'https://redirect.invalid/capture' } : {},
        });
      },
    }));

    const trigger = new URL('http://localhost/cdn-cgi/local/scheduled');
    trigger.searchParams.set('time', String(Date.parse('2026-11-27T05:30:00.000Z')));
    trigger.searchParams.set('cron', '*/5 * * * *');
    trigger.searchParams.set('format', 'json');
    const result = await (await runtime.dispatchFetch(trigger.href)).json();

    expect(requests).toEqual([{
      url: 'https://api.github.com/repos/liu-kaining/StatusGrid/actions/workflows/sync.yml/dispatches',
      authorization: 'Bearer test-private-token',
      body: { ref: 'main', inputs: { mode: 'sync', 'scheduled-at': '2026-11-27T05:30:00.000Z' } },
    }]);
    expect(result).toMatchObject({ outcome });
  }, 15_000);
});
