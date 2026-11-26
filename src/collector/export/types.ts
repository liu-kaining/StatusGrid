import type {
  CollectorHealth, Manifest, ProviderDetail, PublicArchiveIndex, PublicIncidentArchive, RecentIncidents, SearchIndex, Summary,
} from '../../shared/contracts.js';

export interface PublicArtifacts {
  manifest: Manifest;
  summary: Summary;
  details: Record<string, ProviderDetail>;
  search: SearchIndex;
  recent: RecentIncidents;
  health: CollectorHealth;
  archiveIndex: PublicArchiveIndex;
  archives: PublicIncidentArchive[];
  files: Record<string, unknown>;
  feeds: Record<string, string>;
}
export interface ReleaseOptions {
  providerIds?: string[];
  requireLive?: boolean;
  maxSummaryGzipBytes?: number;
}
export interface ReleaseFile {
  path: string;
  parsed: unknown;
  bytes: number;
  gzipBytes: number;
}
export interface ReleaseReport {
  valid: boolean;
  errors: string[];
  files: ReleaseFile[];
  summaryGzipBytes: number;
  snapshotId: string | null;
}
