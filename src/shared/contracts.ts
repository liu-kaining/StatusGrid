export const COLLECTION_INTERVAL_MINUTES = [5, 10] as const;
export const DEFAULT_INTERVAL_MINUTES = 5;
export type CollectionIntervalMinutes = (typeof COLLECTION_INTERVAL_MINUTES)[number];

export type Category = 'ai' | 'cloud-cn' | 'cloud-global' | 'infra';
export type ServiceStatus =
  | 'operational'
  | 'maintenance'
  | 'degraded'
  | 'partial_outage'
  | 'major_outage';
export type PublicStatus = ServiceStatus | 'stale';
export type Freshness = 'fresh' | 'stale' | 'missing';
export type FailureReason =
  | 'not_connected'
  | 'timeout'
  | 'http_error'
  | 'blocked'
  | 'invalid_payload'
  | 'unknown_status'
  | 'coverage_incomplete'
  | 'overdue';

export interface Coverage {
  basis: 'official_public';
  regions: string[];
  componentScope: 'full' | 'filtered' | 'events_only';
  currentState: 'complete' | 'partial' | 'unavailable';
  history: 'native' | 'observed' | 'mixed' | 'none';
  observedSince: string | null;
  nativeHistoryEarliestAt: string | null;
  limitation: string | null;
}

export interface CollectionState {
  outcome: 'success' | 'partial' | 'failure' | 'not_connected';
  freshness: Freshness;
  reason: FailureReason | null;
  message: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  sourceUpdatedAt: string | null;
  durationMs: number | null;
  consecutiveFailures: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  category: Category;
  aliases: string[];
  tags: string[];
  officialStatusUrl: string;
  officialHomeUrl: string | null;
  displayOrder: number;
  enabled: boolean;
  adapter: {
    type:
      | 'statuspage-v2'
      | 'incident-io'
      | 'deepseek'
      | 'google-cloud-json'
      | 'apple-status'
      | 'azure-status'
      | 'aws-cn-health'
      | 'tencent-cloud'
      | 'aliyun'
      | 'baidu-cloud';
    endpoints: Record<string, string>;
    sourcePageId?: string;
    timeoutMs: number;
    retries: number;
    requiredRegions: string[];
    componentGroups: Array<{
      id: string;
      name: string;
      upstreamIds: string[];
      namePatterns: string[];
    }>;
    componentDisplay?: {
      excludeIds: string[];
      collapseOperational: boolean;
    };
    browserFallback: boolean;
  };
}

export interface Component {
  id: string;
  upstreamId: string | null;
  groupId: string | null;
  name: string;
  aliases: string[];
  region: string | null;
  reportedStatus: ServiceStatus | null;
  displayCollapsed?: boolean;
}

export type IncidentState =
  | 'investigating'
  | 'identified'
  | 'monitoring'
  | 'resolved'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'unknown';
export type IncidentKind = 'incident' | 'maintenance' | 'advisory';

export interface Incident {
  id: string;
  sourceIdentity: string;
  episode: number;
  providerId: string;
  upstreamId: string | null;
  kind: IncidentKind;
  title: string;
  severity: Exclude<ServiceStatus, 'operational'> | null;
  sourceSeverity: string | null;
  severityBasis: 'source' | 'component' | 'derived' | 'unknown';
  state: IncidentState;
  origin: 'official' | 'observed';
  isSynthetic: boolean;
  affectedComponentIds: string[];
  affectedRegions: string[];
  startedAt: string;
  startTimeBasis:
    | 'source_started_at'
    | 'source_created_at'
    | 'source_published_at'
    | 'source_reopened_at'
    | 'first_observed';
  resolvedAt: string | null;
  resolvedTimeBasis: 'source' | 'first_observed' | null;
  lastObservedAt: string;
  updatedAt: string;
  durationMinutes: number | null;
  sourceUrl: string;
  postmortemUrl: string | null;
  supersededBy: string | null;
  updates: Array<{
    id: string;
    phase: IncidentState;
    body: string;
    timestamp: string;
  }>;
}

export interface SourceIncident extends Omit<
  Incident,
  'id' | 'episode' | 'supersededBy' | 'origin' | 'isSynthetic'
> {
  origin: 'official';
  isSynthetic: false;
}

export interface AdapterResult {
  providerId: string;
  reportedStatus: ServiceStatus | null;
  components: Component[];
  incidents: SourceIncident[];
  coverage: Coverage;
  sourceUpdatedAt: string | null;
  evidence: {
    requiredChecks: Array<{
      name: string;
      passed: boolean;
      checkedAt: string;
    }>;
    historyCompleteThrough: string | null;
    currentIncidentIds?: string[];
    historyError?: FailureReason | null;
    warnings: string[];
  };
}

export interface HttpResponse {
  url: string;
  status: number;
  contentType: string | null;
  encoding: string;
  durationMs: number;
  bytes: Uint8Array;
  text: string;
}

export interface HttpClient {
  getText(url: string, signal: AbortSignal): Promise<string>;
  getJson(url: string, signal: AbortSignal): Promise<unknown>;
  getResponse(url: string, signal: AbortSignal): Promise<HttpResponse>;
}

export interface BrowserPool {
  collect(
    providerId: string,
    url: string,
    signal: AbortSignal,
    responseMatcher: (url: string) => boolean,
    options?: BrowserCollectionOptions,
  ): Promise<BrowserResponse[]>;
  close(): Promise<void>;
}

export interface BrowserResponse {
  url: string;
  status: number;
  body: string;
  /** Only explicitly selected public query fields; never headers or entire request bodies. */
  requestScope?: Record<string, string>;
}

export interface BrowserCollectionOptions {
  requestScopeFields?: string[];
  steps?: Array<{
    clickText: string;
    waitFor: { url: string; requestFields?: Record<string, string> }
      | Array<{ url: string; requestFields?: Record<string, string> }>;
  }>;
}

export interface AdapterContext {
  now: string;
  signal: AbortSignal;
  http: HttpClient;
  browser: BrowserPool;
}

export interface Adapter {
  collect(config: ProviderConfig, context: AdapterContext): Promise<AdapterResult>;
}

export interface Envelope {
  schemaVersion: '1.0';
  snapshotId: string;
  generatedAt: string;
  intervalMinutes: number;
  dataMode: 'live' | 'fixture';
}

export interface ProviderSummary {
  id: string;
  name: string;
  category: Category;
  status: PublicStatus;
  reportedStatus: ServiceStatus | null;
  officialStatusUrl: string;
  collection: CollectionState;
  coverage: Coverage;
  componentSummary: {
    total: number;
    abnormal: number;
    abnormalNames: string[];
    affectedRegions: string[];
  };
  dailyTrack30d: string;
  dailyCoverage30d: Array<{ observedCoverageMinutes: number; unknownMinutes: number }>;
  activeIncidents: Array<{
    id: string;
    title: string;
    severity: Incident['severity'];
    origin: Incident['origin'];
    startedAt: string;
    updatedAt: string;
    sourceUrl: string;
  }>;
}

export interface Summary extends Envelope {
  globalSummary: {
    overallStatus: PublicStatus;
    totalProviders: number;
    connectedProviders: number;
    countsByStatus: Record<PublicStatus, number>;
    abnormalProviderCount: number;
    activeIncidentCount: number;
    maintenanceCount: number;
    staleProviderCount: number;
  };
  providers: ProviderSummary[];
}

export interface DailyStat {
  date: string;
  worstStatus: ServiceStatus | null;
  incidentCount: number;
  reportedImpactMinutes: number | null;
  observedImpactMinutes: number | null;
  observedCoverageMinutes: number;
  unknownMinutes: number;
  hasEstimatedTimes: boolean;
}

export interface ProviderDetail extends Envelope {
  provider: ProviderSummary;
  componentGroups: Array<{ id: string; name: string; components: Component[] }>;
  dailyHistory30d: DailyStat[];
  recentIncidents: Incident[];
  warnings: string[];
}

export interface Manifest extends Envelope {
  archiveIndexRevision: string;
  paths: {
    summary: string;
    providers: Record<string, string>;
    recentIncidents: string;
    health: string;
    search: string;
    archiveIndex: string;
  };
}

export interface ArchiveIndex {
  schemaVersion: '1.0';
  revision: string;
  generatedAt: string;
  months: Array<{
    month: string;
    revision: string;
    path: string;
    incidentCount: number;
    minStartedAt: string | null;
    maxResolvedAt: string | null;
    updatedAt: string;
  }>;
}

export interface IncidentArchive {
  schemaVersion: '1.0';
  month: string;
  revision: string;
  updatedAt: string;
  incidents: Incident[];
}

export interface SearchIndex extends Envelope {
  providers: Array<{
    providerId: string;
    names: string[];
    components: string[];
    regions: string[];
    incidentTitles: string[];
  }>;
}

export interface RecentIncidents extends Envelope {
  incidents: Incident[];
}

export interface CollectorHealth extends Envelope {
  runId: string;
  durationMs: number;
  latestPublishedSnapshotId: string;
  providers: Array<{
    providerId: string;
    sourceType: ProviderConfig['adapter']['type'];
    collection: CollectionState;
  }>;
}

/** Public immutable cold objects carry provenance independently of a hot snapshot. */
export type PublicArchiveIndex = ArchiveIndex & { dataMode: Envelope['dataMode'] };
export type PublicIncidentArchive = IncidentArchive & { dataMode: Envelope['dataMode'] };
