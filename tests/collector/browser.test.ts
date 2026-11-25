import { afterEach, expect, it } from 'vitest';
import { createBrowserPool } from '../../src/collector/browser.js';
import { withHttpServer } from '../helpers/http-server.js';

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

it('starts lazily and isolates cookies between parallel collection tasks', async () => {
  const local = await withHttpServer((request, response) => {
    if (request.url?.startsWith('/api')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? null }));
    } else {
      const cookie = new URL(`http://localhost${request.url}`).searchParams.get('cookie');
      if (cookie) response.setHeader('set-cookie', `session=${cookie}; Path=/`);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<script>fetch("/api")</script>');
    }
  });
  servers.push(local);
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 15000 });
  expect(pool.isStarted()).toBe(false);
  try {
    const [first, second] = await Promise.all([
      pool.collect('one', `${local.url}/?cookie=one`, new AbortController().signal, (url) => url.endsWith('/api')),
      pool.collect('two', `${local.url}/?cookie=two`, new AbortController().signal, (url) => url.endsWith('/api')),
    ]);
    expect(pool.isStarted()).toBe(true);
    expect(first.map((item) => JSON.parse(item.body))).toEqual([{ cookie: 'session=one' }]);
    expect(second.map((item) => JSON.parse(item.body))).toEqual([{ cookie: 'session=two' }]);
  } finally {
    await pool.close();
  }
  expect(pool.isStarted()).toBe(false);
}, 25000);

it('cancels a browser task and closes cleanly', async () => {
  const local = await withHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<script>fetch("/api")</script>');
  });
  servers.push(local);
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 5000 });
  const controller = new AbortController();
  controller.abort();
  await expect(pool.collect('cancelled', local.url, controller.signal, () => true))
    .rejects.toMatchObject({ kind: 'cancelled' });
  expect(pool.isStarted()).toBe(false);
  await pool.close();
});

it('keeps at most two browser tasks active', async () => {
  let active = 0;
  let maximum = 0;
  const local = await withHttpServer((request, response) => {
    if (request.url?.startsWith('/api')) {
      active++;
      maximum = Math.max(maximum, active);
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        active--;
      }, 300);
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<script>fetch("/api")</script>');
    }
  });
  servers.push(local);
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 15000 });
  try {
    await Promise.all([1, 2, 3].map((index) =>
      pool.collect(String(index), `${local.url}/?task=${index}`, new AbortController().signal, (url) => url.endsWith('/api'))));
    expect(maximum).toBe(2);
  } finally {
    await pool.close();
  }
}, 25000);

it('decodes matched browser responses using their BOM and charset', async () => {
  const local = await withHttpServer((request, response) => {
    if (request.url === '/api') {
      response.writeHead(200, { 'content-type': 'application/octet-stream;charset=utf-16' });
      response.end(Buffer.from([0xfe, 0xff, 0x00, 0x5b, 0x00, 0x5d]));
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<script>fetch("/api")</script>');
    }
  });
  servers.push(local);
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 15000 });
  try {
    const responses = await pool.collect('aws-cn', local.url, new AbortController().signal, (url) => url.endsWith('/api'));
    expect(responses).toMatchObject([{ status: 200, body: '[]' }]);
  } finally {
    await pool.close();
  }
}, 25000);

it('interrupts an active navigation on external cancellation', async () => {
  const local = await withHttpServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('late');
    }, 3000);
  });
  servers.push(local);
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 15000 });
  try {
    const controller = new AbortController();
    const task = pool.collect('cancelled', local.url, controller.signal, () => false);
    setTimeout(() => controller.abort(), 500);
    await expect(task).rejects.toMatchObject({ kind: 'cancelled' });
  } finally {
    await pool.close();
  }
}, 25000);

it('honors cancellation immediately after admission, before browser startup', async () => {
  let requests = 0;
  const local = await withHttpServer((_request, response) => {
    requests++;
    response.end('unexpected');
  });
  servers.push(local);
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 2000 });
  try {
    const controller = new AbortController();
    const task = pool.collect('immediate', local.url, controller.signal, () => false);
    controller.abort();
    await expect(task).rejects.toMatchObject({ kind: 'cancelled' });
    expect(requests).toBe(0);
  } finally {
    await pool.close();
  }
}, 10000);

it('applies one deadline to startup, queued admission, navigation, and cleanup', async () => {
  const local = await withHttpServer(() => {});
  servers.push(local);
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 750 });
  try {
    const start = performance.now();
    const results = await Promise.allSettled([1, 2, 3].map((index) =>
      pool.collect(String(index), local.url, new AbortController().signal, () => false)));
    const elapsed = performance.now() - start;
    expect(results.map((result) => result.status === 'rejected' && 'kind' in result.reason ? result.reason.kind : 'resolved'))
      .toEqual(['timeout', 'timeout', 'timeout']);
    expect(elapsed).toBeLessThan(1250);
  } finally {
    await pool.close();
  }
  expect(pool.isStarted()).toBe(false);
}, 10000);
