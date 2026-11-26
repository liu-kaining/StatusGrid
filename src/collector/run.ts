import { randomUUID } from 'node:crypto';
import { COLLECTION_INTERVAL_MINUTES } from '../shared/contracts.js';
import type { CollectionState, FailureReason, ProviderConfig } from '../shared/contracts.js';
import { AdapterError, TransportError } from './errors.js';
import { createAdapter } from './adapters/index.js';
import type { CollectionContext, CollectionRun, PersistedState, ProviderCollection } from './types.js';
import { applyCollection } from './events/reconcile.js';
import { loadState } from './storage/load.js';
import { stageState } from './storage/save.js';

export async function runPersistentCollection(
  configs: ProviderConfig[], context: CollectionContext, directory: string,
): Promise<{ kind: 'valid'; run: CollectionRun; state: PersistedState; hasProviderFailures: boolean }> {
  const previous = await loadState(directory);
  const selected = new Set(configs.map(({ id }) => id));
  if (previous.latest?.providers.some(({ providerId }) => !selected.has(providerId))) {
    throw new Error('Persistent collection cannot replace the previous provider scope with a subset');
  }
  const run = await collectProviders(configs, new Map(previous.latest?.providers.map((provider) => [provider.providerId, provider]) ?? []), context);
  const state = applyCollection(previous, run);
  await stageState(state, directory, { expectedSnapshotId: previous.latest?.snapshotId ?? null });
  return { kind: 'valid', run, state, hasProviderFailures: run.providers.some(({ collection }) => collection.freshness !== 'fresh') };
}

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
  const clock = context.clock!;
  const start = clock.monotonic();
  const previousTrusted = previous?.lastTrustedResult ?? previous?.result ?? null;
  const observedAt = clock.now();
  let result: ProviderCollection['result'] = null;
  let reason: FailureReason | null = null;
  let message: string | null = null;
  try {
    if (!config.enabled) {
      reason = 'not_connected';
      message = `Provider ${config.id} is disabled`;
    } else {
      result = await withinBudget(
        (providerSignal) => createAdapter(config).collect(config, {
          ...context,
          now: observedAt,
          http: context.httpForProvider?.(config) ?? context.http,
          signal: providerSignal,
        }), signal, PROVIDER_BUDGET_MS,
      );
      if (result.coverage.currentState !== 'complete' || !result.evidence.requiredChecks.every(({ passed }) => passed)) {
        throw new AdapterError('coverage_incomplete', 'Current source coverage is incomplete');
      }
      result.coverage.observedSince = previousTrusted?.coverage.observedSince ?? observedAt;
    }
  } catch (error) {
    reason = reasonOf(error);
    message = error instanceof Error ? error.message : 'Collection failed';
    result = null;
  }
  const checkedAt = clock.now();
  const freshness = result ? 'fresh' : previousTrusted ? 'stale' : 'missing';
  const collection: CollectionState = {
    outcome: result ? result.evidence.historyError ? 'partial' : 'success'
      : reason === 'not_connected' ? 'not_connected' : 'failure',
    freshness, reason, message,
    lastCheckedAt: checkedAt,
    lastSuccessAt: result ? checkedAt : previous?.collection.lastSuccessAt ?? null,
    sourceUpdatedAt: result?.sourceUpdatedAt ?? previousTrusted?.sourceUpdatedAt ?? null,
    durationMs: Math.max(0, clock.monotonic() - start),
    consecutiveFailures: result ? 0 : (previous?.collection.consecutiveFailures ?? 0) + 1,
  };
  return {
    providerId: config.id, officialStatusUrl: config.officialStatusUrl, result,
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
  const base = Date.parse(context.now);
  if (!Number.isFinite(base)) throw new Error('Invalid collection observation time');
  const monotonicBase = performance.now();
  const clock = context.clock ?? {
    now: () => new Date(base + Math.max(0, performance.now() - monotonicBase)).toISOString(),
    monotonic: () => performance.now(),
  };
  context = { ...context, clock };
  const startedAt = clock.now();
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
  return { snapshotId: randomUUID(), startedAt, completedAt: clock.now(), intervalMinutes, providers };
}
