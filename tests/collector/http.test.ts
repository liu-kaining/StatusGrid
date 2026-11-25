import { afterEach, describe, expect, it } from 'vitest';
import { createHttpClient, decodeBody } from '../../src/collector/http.js';
import { TransportError } from '../../src/collector/errors.js';
import { withHttpServer } from '../helpers/http-server.js';

const servers: Array<{ close: () => Promise<void> }> = [];
async function server(handler: Parameters<typeof withHttpServer>[0]) {
  const instance = await withHttpServer(handler);
  servers.push(instance);
  return instance.url;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((instance) => instance.close()));
});

describe('HTTP transport', () => {
  it('times out a stalled local response', async () => {
    const url = await server(() => {});
    await expect(createHttpClient({ timeoutMs: 30, retries: 0 }).getText(url, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'timeout' });
  });

  it('retries a 429 and returns the successful response with one UA', async () => {
    let attempts = 0;
    const agents: string[] = [];
    const url = await server((request, response) => {
      agents.push(request.headers['user-agent'] ?? '');
      attempts++;
      response.writeHead(attempts === 1 ? 429 : 200, { 'content-type': 'application/json' });
      response.end(attempts === 1 ? 'slow down' : '{"ok":true}');
    });
    const result = await createHttpClient({ timeoutMs: 1000, retries: 1, retryBaseMs: 1 })
      .getJson(url, new AbortController().signal);
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(agents).toEqual(['StatusGrid/0.1 (+public-status-collector)', 'StatusGrid/0.1 (+public-status-collector)']);
  });

  it('retries a 429 even when its error body cannot be decoded', async () => {
    let attempts = 0;
    const url = await server((_request, response) => {
      attempts++;
      response.writeHead(attempts === 1 ? 429 : 200, { 'content-type': 'application/json' });
      response.end(attempts === 1 ? Buffer.from([0xff]) : '{"ok":true}');
    });
    expect(await createHttpClient({ timeoutMs: 1000, retries: 1, retryBaseMs: 1 })
      .getJson(url, new AbortController().signal)).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it('rejects Retry-After beyond the remaining budget without retrying', async () => {
    let attempts = 0;
    const url = await server((_request, response) => {
      attempts++;
      response.writeHead(429, { 'retry-after': '60' });
      response.end('limited');
    });
    await expect(createHttpClient({ timeoutMs: 100, totalBudgetMs: 100, retries: 2 })
      .getText(url, new AbortController().signal)).rejects.toMatchObject({ kind: 'http_error', status: 429 });
    expect(attempts).toBe(1);
  });

  it('does not retry 404', async () => {
    let attempts = 0;
    const url = await server((_request, response) => {
      attempts++;
      response.writeHead(404);
      response.end('missing');
    });
    await expect(createHttpClient({ timeoutMs: 1000, retries: 2, retryBaseMs: 1 })
      .getText(url, new AbortController().signal)).rejects.toMatchObject({ kind: 'http_error', status: 404 });
    expect(attempts).toBe(1);
  });

  it('classifies a 200 HTML challenge as blocked', async () => {
    const url = await server((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><title>Verify you are human</title></html>');
    });
    await expect(createHttpClient({ timeoutMs: 1000, retries: 0 }).getJson(url, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'blocked' });
  });

  it('decodes UTF-8, UTF-16LE and UTF-16BE independently of mislabeled charset', () => {
    expect(decodeBody(Uint8Array.from([0xef, 0xbb, 0xbf, 0x5b, 0x5d]), 'application/json')).toBe('[]');
    expect(decodeBody(Uint8Array.from([0xff, 0xfe, 0x5b, 0x00, 0x5d, 0x00]), 'application/json;charset=utf-16')).toBe('[]');
    expect(decodeBody(Uint8Array.from([0xfe, 0xff, 0x00, 0x5b, 0x00, 0x5d]), 'application/json;charset=utf-16')).toBe('[]');
  });

  it('cancels a request externally, without retrying', async () => {
    let attempts = 0;
    const url = await server(() => { attempts++; });
    const controller = new AbortController();
    const pending = createHttpClient({ timeoutMs: 1000, retries: 2 }).getText(url, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(attempts).toBeLessThanOrEqual(1);
  });

  it('does not expose response headers in error summaries', async () => {
    const url = await server((_request, response) => {
      response.writeHead(403, { 'set-cookie': 'secret-session=value' });
      response.end('access denied');
    });
    try {
      await createHttpClient({ timeoutMs: 1000, retries: 0 }).getText(url, new AbortController().signal);
      throw new Error('expected HTTP rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TransportError);
      expect(String(error)).not.toContain('secret-session');
    }
  });
});
