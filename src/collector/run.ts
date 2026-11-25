import { randomUUID } from 'node:crypto';
import { COLLECTION_INTERVAL_MINUTES } from '../shared/contracts.js';
import type { CollectionState, FailureReason, ProviderConfig } from '../shared/contracts.js';
import { TransportError } from './errors.js';
import { AdapterError } from './adapters/statuspage.js';
import { createAdapter } from './adapters/index.js';
import type { CollectionContext, CollectionRun, ProviderCollection } from './types.js';

const PROVIDER_BUDGET_MS = 60_000;
const RUN_BUDGET_MS = 120_000;
const HTTP_CONCURRENCY = 6;

function reasonOf(error: unknown): FailureReason {
  if (error instanceof AdapterError) return error.reason;
  if (error instanceof TransportError) return error.kind === 'cancelled' ? 'timeout' : error.kind;
  return 'invalid_payload';
}

async function withinBudget<T>(work: (signal: AbortSignal) => Promise<T>, upstream: AbortSignal, ms: number): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  upstream.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, ms);
  if (upstream.aborted) cancel();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new TransportError('timeout', 'Collection deadline exceeded'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    upstream.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function collectOne(
  config: ProviderConfig, previous: ProviderCollection | undefined, context: CollectionContext,
  signal: AbortSignal,
): Promise<ProviderCollection> {
  const start = Date.now();
  const previousTrusted = previous?.lastTrustedResult ?? previous?.result ?? null;
  const checkedAt = new Date().toISOString();
  let result: ProviderCollection['result'] = null;
  let reason: FailureReason | null = null;
  let message: string | null = null;
  try {
    if (!config.enabled || config.adapter.type !== 'statuspage-v2') {
      reason = 'not_connected';
      message = `Adapter ${config.adapter.type} is not connected`;
    } else {
      result = await withinBudget(
        (providerSignal) => createAdapter(config).collect(config, {
          ...context,
          http: context.httpForProvider?.(config) ?? context.http,
          signal: providerSignal,
        }), signal, PROVIDER_BUDGET_MS,
      );
      if (result.coverage.currentState !== 'complete') {
        throw new AdapterError('coverage_incomplete', 'Current source coverage is incomplete');
      }
    }
  } catch (error) {
    reason = reasonOf(error);
    message = error instanceof Error ? error.message : 'Collection failed';
    result = null;
  }
  const freshness = result ? 'fresh' : previousTrusted ? 'stale' : 'missing';
  const collection: CollectionState = {
    outcome: result ? result.evidence.historyError ? 'partial' : 'success'
      : reason === 'not_connected' ? 'not_connected' : 'failure',
    freshness, reason, message,
    lastCheckedAt: checkedAt,
    lastSuccessAt: result ? checkedAt : previous?.collection.lastSuccessAt ?? null,
    sourceUpdatedAt: result?.sourceUpdatedAt ?? previousTrusted?.sourceUpdatedAt ?? null,
    durationMs: Date.now() - start,
    consecutiveFailures: result ? 0 : (previous?.collection.consecutiveFailures ?? 0) + 1,
  };
  return {
    providerId: config.id, result,
    lastTrustedResult: result ?? previousTrusted,
    collection,
  };
}

export async function collectProviders(
  configs: ProviderConfig[],
  previous: ReadonlyMap<string, ProviderCollection>,
  context: CollectionContext,
): Promise<CollectionRun> {
  if (!COLLECTION_INTERVAL_MINUTES.some((value) => value === context.intervalMinutes)) {
    throw new Error(`Invalid collection interval: ${context.intervalMinutes}`);
  }
  const intervalMinutes = context.intervalMinutes as CollectionRun['intervalMinutes'];
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  context.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, RUN_BUDGET_MS);
  if (context.signal.aborted) cancel();
  const providers = new Array<ProviderCollection>(configs.length);
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(HTTP_CONCURRENCY, configs.length) }, async () => {
      while (next < configs.length) {
        const index = next++;
        const config = configs[index]!;
        providers[index] = await collectOne(config, previous.get(config.id), context, controller.signal);
      }
    }));
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', cancel);
  }
  return { snapshotId: randomUUID(), startedAt, completedAt: new Date().toISOString(), intervalMinutes, providers };
}
