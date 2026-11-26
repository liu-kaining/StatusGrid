import type { AdapterContext, AdapterResult, CollectionIntervalMinutes, CollectionState, DailyStat, HttpClient, Incident, ProviderConfig, ServiceStatus } from '../shared/contracts.js';

export interface ProviderCollection {
  providerId: string;
  officialStatusUrl?: string;
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
  clock?: { now(): string; monotonic(): number };
}

export interface IncidentIdentity {
  sourceIdentity: string;
  latestEpisode: number;
  latestIncidentId: string;
  resolvedAt: string | null;
  aliases: string[];
}

export interface Milestone {
  id: string;
  incidentId: string;
  kind: 'triggered' | 'escalated' | 'resolved';
  at: string;
}

export interface NotificationLedger {
  milestones: Milestone[];
  /** Native lifecycle ID -> original notification lifecycle ID. */
  aliases: Record<string, string>;
}

export interface Observation {
  at: string;
  through: string;
  intervalMinutes: CollectionIntervalMinutes;
  status: ServiceStatus | null;
}

export interface ReconcileResult {
  incidents: Incident[];
  openIncidents: Incident[];
  identities: Record<string, IncidentIdentity>;
  ledger: NotificationLedger;
  milestones: Milestone[];
}

export interface PersistedState {
  schemaVersion: '1.0';
  latest: CollectionRun | null;
  incidents: Incident[];
  openIncidents: Incident[];
  identities: Record<string, IncidentIdentity>;
  ledger: NotificationLedger;
  observations: Record<string, Observation[]>;
  dailyStats: Record<string, DailyStat[]>;
}
