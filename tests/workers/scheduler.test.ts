import { afterEach, describe, expect, it, vi } from 'vitest';
import scheduler from '../../workers/scheduler/index.js';

const controller = { cron: '*/5 * * * *', scheduledTime: Date.parse('2026-11-27T04:05:00.000Z') };
const env = { GITHUB_TOKEN: 'test-private-token', GITHUB_REPOSITORY: 'liu-kaining/StatusGrid', GITHUB_REF: 'main' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Cloudflare scheduled collection', () => {
  it.each([200, 204])('dispatches a sync with the scheduled time when GitHub returns %s', async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      status === 200 ? JSON.stringify({ workflow_run_id: 123, html_url: 'https://github.com/liu-kaining/StatusGrid/actions/runs/123' }) : null,
      { status, headers: { 'x-github-request-id': 'test-request' } },
    ));
    vi.stubGlobal('fetch', request);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.scheduled(controller, env);

    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/liu-kaining/StatusGrid/actions/workflows/sync.yml/dispatches');
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: 'Bearer test-private-token',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'StatusGrid-Cloudflare-Scheduler',
      },
    });
    expect(JSON.parse(options!.body as string)).toEqual({
      ref: 'main',
      inputs: { mode: 'sync', 'scheduled-at': '2026-11-27T04:05:00.000Z' },
    });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      event: 'github_dispatch_accepted',
      scheduledAt: '2026-11-27T04:05:00.000Z',
      httpStatus: status,
      requestId: 'test-request',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(env.GITHUB_TOKEN);
  });

  it.each([
    { ...env, GITHUB_TOKEN: '' },
    { ...env, GITHUB_TOKEN: '   ' },
    { ...env, GITHUB_REPOSITORY: '' },
    { ...env, GITHUB_REPOSITORY: '../wrong/repo' },
    { ...env, GITHUB_REF: '' },
  ])('rejects incomplete or malformed configuration before contacting GitHub: %j', async (configuration) => {
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', request);

    await expect(scheduler.scheduled(controller, configuration)).rejects.toThrow(/configuration/i);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308, 401, 403, 404, 422, 500])('fails the Cron event on HTTP %s without logging the body or secret', async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-response-body', {
      status, headers: { 'x-github-request-id': 'failed-request' },
    }));
    vi.stubGlobal('fetch', request);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const error: unknown = await scheduler.scheduled(controller, env).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`HTTP ${status}`);
    expect((error as Error).message).not.toMatch(/private-response-body|test-private-token/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('propagates a network failure rather than claiming dispatch succeeded', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('network unavailable')));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(scheduler.scheduled(controller, env)).rejects.toThrow(/network unavailable/);
    expect(log).not.toHaveBeenCalled();
  });
});
