import type { AdapterContext, AdapterResult, CollectionIntervalMinutes, CollectionState, HttpClient, ProviderConfig } from '../shared/contracts.js';

export interface ProviderCollection {
  providerId: string;
  result: AdapterResult | null;
  lastTrustedResult: AdapterResult | null;
  collection: CollectionState;
}

export interface CollectionRun {
  snapshotId: string;
  startedAt: string;
  completedAt: string;
  intervalMinutes: CollectionIntervalMinutes;
  providers: ProviderCollection[];
}

export interface CollectionContext extends AdapterContext {
  intervalMinutes: number;
  httpForProvider?: (config: ProviderConfig) => HttpClient;
}
