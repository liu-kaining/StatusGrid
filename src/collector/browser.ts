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
  let closing: Promise<void> | null = null;
  let closed = false;
  let active = 0;
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
      const controller = new AbortController();
      let rejectAbort!: (error: TransportError) => void;
      const abort = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      void abort.catch(() => {});
      const onAbort = () => {
        controller.abort();
        rejectAbort(new TransportError('cancelled', 'Browser collection cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const timer = setTimeout(() => {
        controller.abort();
        rejectAbort(new TransportError('timeout', 'Browser collection timed out'));
      }, options.timeoutMs);
      const withinBudget = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, abort]);
      let admitted = false;
      let context: BrowserContext | null = null;
      let contextPromise: Promise<BrowserContext> | null = null;
      let result: Array<{ url: string; status: number; body: string }> | null = null;
      let failure: unknown = null;
      try {
        await acquire(controller.signal);
        admitted = true;
        if (controller.signal.aborted || closed) throw new TransportError('cancelled', 'Browser collection cancelled');
        if (!browserPromise) {
          browserPromise = chromium.launch({
            headless: true,
            executablePath: options.executablePath,
            timeout: options.timeoutMs,
          });
        }
        const browser = await withinBudget(browserPromise);
        contextPromise = browser.newContext();
        context = await withinBudget(contextPromise);
        const page = await withinBudget(context.newPage());
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
        await withinBudget(page.goto(url, { waitUntil: 'networkidle' }));
        result = await withinBudget(Promise.all(responses));
      } catch (error) {
        failure = error;
      } finally {
        if (context) {
          if (!controller.signal.aborted) {
            await withinBudget(context.close().catch(() => {})).catch(() => {});
          }
          // Cancelled contexts are closed by Browser.close; concurrent context.close
          // and Browser.close can block Playwright teardown during a stalled navigation.
        } else if (contextPromise) {
          void contextPromise.then((created) => created.close()).catch(() => {});
        }
        if (admitted) release();
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
      if (signal.aborted || closed) throw new TransportError('cancelled', `Browser collection cancelled for ${providerId}`);
      if (controller.signal.aborted) throw new TransportError('timeout', `Browser collection timed out for ${providerId}`);
      if (failure instanceof TransportError) throw failure;
      if (failure) throw new TransportError('http_error', `Browser collection failed for ${providerId}`);
      return result!;
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const waiter of pending.splice(0)) {
        waiter.signal.removeEventListener('abort', waiter.cancel);
        waiter.reject(new TransportError('cancelled', 'Browser pool closed'));
      }
      const shutdown = async () => {
        if (browserPromise) {
          const browser = await browserPromise.catch(() => null);
          await browser?.close();
          browserPromise = null;
        }
      };
      closing = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.timeoutMs);
        void shutdown().catch(() => {}).finally(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return closing;
    },
  };
}
