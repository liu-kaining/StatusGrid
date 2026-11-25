import type { HttpClient, HttpResponse } from '../shared/contracts.js';
import { TransportError } from './errors.js';

const USER_AGENT = 'StatusGrid/0.1 (+public-status-collector)';

export interface HttpOptions {
  timeoutMs: number;
  retries: number;
  totalBudgetMs?: number;
  retryBaseMs?: number;
}

function encodingOf(bytes: Uint8Array, contentType: string | null): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
  return charset === 'utf-16' ? 'utf-16le' : (charset ?? 'utf-8');
}

export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  try {
    const encoding = encodingOf(bytes, contentType);
    const start = encoding === 'utf-8' && bytes[0] === 0xef ? 3
      : encoding.startsWith('utf-16') && (bytes[0] === 0xfe || bytes[0] === 0xff) ? 2 : 0;
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start));
  } catch {
    throw new TransportError('invalid_payload', 'Response body cannot be decoded');
  }
}

function retryDelay(header: string | null, attempt: number, baseMs: number): number {
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return baseMs * (2 ** attempt);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new TransportError('cancelled', 'Request cancelled'));
      return;
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    function cancel() {
      clearTimeout(timer);
      reject(new TransportError('cancelled', 'Request cancelled'));
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export function createHttpClient(options: HttpOptions): HttpClient {
  const { timeoutMs, retries, totalBudgetMs = timeoutMs * (retries + 1) + 4000, retryBaseMs = 1000 } = options;
  if (timeoutMs <= 0 || retries < 0 || totalBudgetMs <= 0 || retryBaseMs < 0) {
    throw new Error('Invalid HTTP transport options');
  }
  async function getResponse(url: string, signal: AbortSignal): Promise<HttpResponse> {
    const start = Date.now();
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new TransportError('cancelled', 'Request cancelled');
      const remaining = totalBudgetMs - (Date.now() - start);
      if (remaining <= 0) throw new TransportError('timeout', 'HTTP request budget exhausted');
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
      try {
        const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: controller.signal });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const contentType = response.headers.get('content-type');
        if (!response.ok) {
          const error = new TransportError('http_error', `HTTP ${response.status}`, response.status);
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          const delay = retryDelay(response.headers.get('retry-after'), attempt, retryBaseMs);
          if (!retryable || attempt >= retries || delay >= totalBudgetMs - (Date.now() - start)) throw error;
          await wait(delay, signal);
          continue;
        }
        const text = decodeBody(bytes, contentType);
        if (/text\/html/i.test(contentType ?? '') && /(?:captcha|verify you are human|challenge|access denied)/i.test(text)) {
          throw new TransportError('blocked', 'HTML challenge response', response.status);
        }
        return {
          url: response.url,
          status: response.status,
          contentType,
          encoding: encodingOf(bytes, contentType),
          durationMs: Date.now() - start,
          bytes,
          text,
        };
      } catch (error) {
        if (signal.aborted) throw new TransportError('cancelled', 'Request cancelled');
        if (controller.signal.aborted) throw new TransportError('timeout', 'HTTP request timed out');
        if (error instanceof TransportError) throw error;
        if (attempt >= retries) throw new TransportError('http_error', 'HTTP network request failed');
        const delay = retryDelay(null, attempt, retryBaseMs);
        if (delay >= totalBudgetMs - (Date.now() - start)) throw new TransportError('http_error', 'HTTP network request failed');
        await wait(delay, signal);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    }
  }
  return {
    getResponse,
    async getText(url, signal) {
      return (await getResponse(url, signal)).text;
    },
    async getJson(url, signal) {
      const response = await getResponse(url, signal);
      if (/text\/html/i.test(response.contentType ?? '')) {
        throw new TransportError('invalid_payload', 'Expected JSON, received HTML', response.status);
      }
      try {
        return JSON.parse(response.text) as unknown;
      } catch {
        throw new TransportError('invalid_payload', 'Invalid JSON response', response.status);
      }
    },
  };
}
