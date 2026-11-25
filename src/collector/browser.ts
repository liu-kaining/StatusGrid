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
  let cleanupFailure: Error | null = null;
  let active = 0;
  const tasks = new Set<Promise<unknown>>();
  const cancellations = new Set<() => void>();
  const pending: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    cancel: () => void;
  }> = [];

  function stopAdmission(error?: unknown) {
    if (error !== undefined && cleanupFailure === null) {
      cleanupFailure = error instanceof Error ? error : new Error('Browser context disposal failed', { cause: error });
    }
    closed = true;
    for (const cancel of cancellations) cancel();
    for (const waiter of pending.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.cancel);
      waiter.reject(new TransportError('cancelled', 'Browser pool closed'));
    }
  }

  async function disposeContext(context: BrowserContext) {
    try {
      await context.close();
    } catch (error) {
      stopAdmission(error);
      throw error;
    }
  }

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
      if (closed) throw new TransportError('cancelled', 'Browser pool closed');
      const controller = new AbortController();
      let rejectAbort!: (error: TransportError) => void;
      const abort = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      void abort.catch(() => {});
      const cancel = () => controller.abort();
      const onInternalAbort = () => {
        rejectAbort(new TransportError(
          signal.aborted || closed ? 'cancelled' : 'timeout',
          'Browser collection interrupted',
        ));
      };
      controller.signal.addEventListener('abort', onInternalAbort, { once: true });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const timer = setTimeout(cancel, options.timeoutMs);
      const withinBudget = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, abort]);
      const work = async () => {
        let admitted = false;
        let context: BrowserContext | null = null;
        let contextPromise: Promise<BrowserContext> | null = null;
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
          return await withinBudget(Promise.all(responses));
        } catch (error) {
          if (signal.aborted || closed) throw new TransportError('cancelled', `Browser collection cancelled for ${providerId}`);
          if (controller.signal.aborted) throw new TransportError('timeout', `Browser collection timed out for ${providerId}`);
          if (error instanceof TransportError) throw error;
          throw new TransportError('http_error', `Browser collection failed for ${providerId}`);
        } finally {
          try {
            if (context) {
              await disposeContext(context);
            } else if (contextPromise) {
              const created = await contextPromise.catch(() => null);
              if (created) await disposeContext(created);
            }
          } finally {
            if (admitted) release();
          }
        }
      };
      const task = work().finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', onInternalAbort);
        cancellations.delete(cancel);
        tasks.delete(task);
      });
      cancellations.add(cancel);
      tasks.add(task);
      return await Promise.race([task, abort]);
    },
    close() {
      if (closing) return closing;
      stopAdmission();
      closing = (async () => {
        await Promise.allSettled([...tasks]);
        if (browserPromise) {
          const browser = await browserPromise.catch(() => null);
          await browser?.close();
          browserPromise = null;
        }
        if (cleanupFailure) throw cleanupFailure;
      })();
      return closing;
    },
  };
}
