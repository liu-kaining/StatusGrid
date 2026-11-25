import { afterEach, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
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

it('does not admit a replacement while a cancelled context still owns a live request', async () => {
  let live = 0;
  let peak = 0;
  const started: string[] = [];
  const closed: string[] = [];
  const local = await withHttpServer((request, response) => {
    const id = new URL(`http://localhost${request.url}`).searchParams.get('task')!;
    started.push(id);
    live++;
    peak = Math.max(peak, live);
    response.once('close', () => {
      live--;
      closed.push(id);
    });
  });
  servers.push(local);
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 6000 });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const thirdController = new AbortController();
  const first = pool.collect('one', `${local.url}/?task=one`, firstController.signal, () => false);
  const second = pool.collect('two', `${local.url}/?task=two`, secondController.signal, () => false);
  let third: ReturnType<typeof pool.collect> | null = null;
  try {
    await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 3000 });
    firstController.abort();
    await expect(first).rejects.toMatchObject({ kind: 'cancelled' });
    third = pool.collect('three', `${local.url}/?task=three`, thirdController.signal, () => false);
    await vi.waitFor(() => expect(started).toContain('three'), { timeout: 3000 });
    expect(closed).toContain('one');
    expect(peak).toBe(2);
  } finally {
    firstController.abort();
    secondController.abort();
    thirdController.abort();
    await Promise.allSettled([first, second, ...(third ? [third] : [])]);
    await pool.close();
  }
}, 12000);

it('closes the actual Chrome connections before pool.close resolves', async () => {
  let live = 0;
  const local = await withHttpServer((_request, response) => {
    live++;
    response.once('close', () => { live--; });
  });
  servers.push(local);
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 2500 });
  const controller = new AbortController();
  const task = pool.collect('open', local.url, controller.signal, () => false);
  try {
    await vi.waitFor(() => expect(live).toBe(1), { timeout: 2000 });
    controller.abort();
    await expect(task).rejects.toMatchObject({ kind: 'cancelled' });
    await pool.close();
    expect(live).toBe(0);
    expect(pool.isStarted()).toBe(false);
  } finally {
    controller.abort();
    await pool.close();
  }
}, 10000);

it('characterizes context closure during a stalled navigation', async () => {
  let live = 0;
  const local = await withHttpServer((_request, response) => {
    live++;
    response.once('close', () => { live--; });
  });
  servers.push(local);
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const navigation = page.goto(local.url, { waitUntil: 'networkidle' }).catch(() => {});
    await vi.waitFor(() => expect(live).toBe(1), { timeout: 2000 });
    await context.close();
    await navigation;
    expect(live).toBe(0);
  } finally {
    await browser.close();
  }
}, 10000);

it('does not report shutdown complete while the real browser close is pending', async () => {
  const local = await withHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html></html>');
  });
  servers.push(local);
  const originalLaunch = chromium.launch.bind(chromium);
  let finishClose!: () => void;
  const closeGate = new Promise<void>((resolve) => { finishClose = resolve; });
  const launchSpy = vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
    const browser = await originalLaunch(options);
    const originalClose = browser.close.bind(browser);
    vi.spyOn(browser, 'close').mockImplementation(async (closeOptions) => {
      await closeGate;
      await originalClose(closeOptions);
    });
    return browser;
  });
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 2000 });
  try {
    await pool.collect('ready', local.url, new AbortController().signal, () => false);
    let settled = false;
    const shutdown = pool.close().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(settled).toBe(false);
    finishClose();
    await shutdown;
    expect(pool.isStarted()).toBe(false);
  } finally {
    finishClose();
    await pool.close();
    launchSpy.mockRestore();
  }
}, 10000);

it('stops admission and reports failed context disposal after browser shutdown', async () => {
  let live = 0;
  let requests = 0;
  const local = await withHttpServer((_request, response) => {
    requests++;
    live++;
    response.once('close', () => { live--; });
  });
  servers.push(local);
  const originalLaunch = chromium.launch.bind(chromium);
  const launchSpy = vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
    const browser = await originalLaunch(options);
    const originalNewContext = browser.newContext.bind(browser);
    vi.spyOn(browser, 'newContext').mockImplementation(async (contextOptions) => {
      const context = await originalNewContext(contextOptions);
      vi.spyOn(context, 'close').mockRejectedValueOnce(new Error('forced context disposal failure'));
      return context;
    });
    return browser;
  });
  const pool = createBrowserPool({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', timeoutMs: 2000 });
  const controller = new AbortController();
  try {
    const first = pool.collect('one', local.url, controller.signal, () => false);
    await vi.waitFor(() => expect(live).toBe(1), { timeout: 1500 });
    controller.abort();
    await expect(first).rejects.toMatchObject({ kind: 'cancelled' });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(pool.collect('two', local.url, new AbortController().signal, () => false))
      .rejects.toMatchObject({ kind: 'cancelled' });
    expect(requests).toBe(1);
    await expect(pool.close()).rejects.toThrow('forced context disposal failure');
    expect(live).toBe(0);
    expect(pool.isStarted()).toBe(false);
  } finally {
    controller.abort();
    await pool.close().catch(() => {});
    launchSpy.mockRestore();
  }
}, 10000);
