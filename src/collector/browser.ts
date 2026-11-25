import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { BrowserPool } from '../shared/contracts.js';
import { TransportError } from './errors.js';
import { decodeBody } from './http.js';

export interface BrowserOptions {
  timeoutMs: number;
  executablePath?: string;
}

export interface ManagedBrowserPool extends BrowserPool {
  close(): Promise<void>;
  isStarted(): boolean;
}

export function createBrowserPool(options: BrowserOptions): ManagedBrowserPool {
  if (options.timeoutMs <= 0) throw new Error('Invalid browser timeout');
  let browserPromise: Promise<Browser> | null = null;
  let closed = false;
  let active = 0;
  const contexts = new Set<BrowserContext>();
  const pending: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    cancel: () => void;
  }> = [];

  function release() {
    active--;
    while (!closed && active < 2 && pending.length > 0) {
      const waiter = pending.shift()!;
      waiter.signal.removeEventListener('abort', waiter.cancel);
      if (waiter.signal.aborted) {
        waiter.reject(new TransportError('cancelled', 'Browser collection cancelled'));
      } else {
        active++;
        waiter.resolve();
      }
    }
  }

  function acquire(signal: AbortSignal): Promise<void> {
    if (closed || signal.aborted) return Promise.reject(new TransportError('cancelled', 'Browser collection cancelled'));
    if (active < 2) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, cancel };
      pending.push(waiter);
      function cancel() {
        const index = pending.indexOf(waiter);
        if (index !== -1) {
          pending.splice(index, 1);
          reject(new TransportError('cancelled', 'Browser collection cancelled'));
        }
      }
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  return {
    isStarted: () => browserPromise !== null,
    async collect(providerId, url, signal, responseMatcher) {
      await acquire(signal);
      let context: BrowserContext | null = null;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        if (!browserPromise) {
          browserPromise = chromium.launch({ headless: true, executablePath: options.executablePath });
        }
        const browser = await browserPromise;
        if (controller.signal.aborted || closed) throw new TransportError(signal.aborted ? 'cancelled' : 'timeout', 'Browser collection cancelled');
        context = await browser.newContext();
        contexts.add(context);
        const page = await context.newPage();
        const responses: Array<Promise<{ url: string; status: number; body: string }>> = [];
        page.on('response', (response) => {
          if (responseMatcher(response.url())) {
            const bodyPromise = response.body().then((bytes) => ({
              url: response.url(),
              status: response.status(),
              body: decodeBody(
                bytes,
                // Chromium may return UTF-8-normalized response bytes despite a UTF-16 header.
                bytes[0] === 0xfe || bytes[0] === 0xff || bytes.includes(0)
                  ? response.headers()['content-type'] ?? null
                  : 'text/plain;charset=utf-8',
              ),
            }));
            void bodyPromise.catch(() => {});
            responses.push(bodyPromise);
          }
        });
        const abort = new Promise<never>((_resolve, reject) => {
          if (controller.signal.aborted) reject(new TransportError(signal.aborted ? 'cancelled' : 'timeout', 'Browser collection interrupted'));
          else controller.signal.addEventListener('abort', () => reject(new TransportError(signal.aborted ? 'cancelled' : 'timeout', 'Browser collection interrupted')), { once: true });
        });
        await Promise.race([page.goto(url, { waitUntil: 'networkidle' }), abort]);
        return await Promise.race([Promise.all(responses), abort]);
      } catch (error) {
        if (error instanceof TransportError) throw error;
        if (signal.aborted || closed) throw new TransportError('cancelled', `Browser collection cancelled for ${providerId}`);
        if (controller.signal.aborted) throw new TransportError('timeout', `Browser collection timed out for ${providerId}`);
        throw new TransportError('http_error', `Browser collection failed for ${providerId}`);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (context) {
          contexts.delete(context);
          await context.close().catch(() => {});
        }
        release();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const waiter of pending.splice(0)) {
        waiter.signal.removeEventListener('abort', waiter.cancel);
        waiter.reject(new TransportError('cancelled', 'Browser pool closed'));
      }
      await Promise.all([...contexts].map((context) => context.close().catch(() => {})));
      if (browserPromise) {
        const browser = await browserPromise.catch(() => null);
        await browser?.close();
        browserPromise = null;
      }
    },
  };
}
