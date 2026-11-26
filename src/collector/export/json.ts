import registry from '../../../registry/providers.json';
import type {
  Component, Coverage, Envelope, Incident, Manifest, ProviderDetail, ProviderSummary, PublicArchiveIndex, PublicIncidentArchive,
} from '../../shared/contracts.js';
import { parseRegistry } from '../../shared/schemas.js';
import { incidentSchema } from '../../shared/entity-schemas.js';
import { publicStatus, STATUS_SEVERITY, summarizeProviders } from '../../shared/status.js';
import type { CollectionRun, PersistedState, ProviderCollection } from '../types.js';
import { buildDailyStats } from '../storage/rollup.js';
import { buildArchives, revisionOf } from '../storage/archive.js';
import { isActiveFault, isCurrentNativeFault } from '../events/normalize.js';
import { buildSearch } from './search.js';
import { buildFeeds } from './feeds.js';
import type { PublicArtifacts } from './types.js';

const configs = parseRegistry(registry);
const groupLabels: Record<string, string> = {
  'openai:01K5H8S53SY1KMS4GQMNMQM1K5': 'APIs',
  'openai:01K5H8S53SY1KMS4GQMNMZXTR1': 'ChatGPT',
  'openai:01KMKF9EBTCD8BN9PG8DJZXRSQ': 'Codex',
  'openai:01KKACDSZF5G5JTBJY83GF176Z': 'FedRAMP',
  'openai:01KTQBYDGR2AKA7D6HW6RVAGZC': 'Ads Platform',
};
const unknownCoverage: Coverage = {
  basis: 'official_public', regions: [], componentScope: 'events_only', currentState: 'unavailable',
  history: 'none', observedSince: null, nativeHistoryEarliestAt: null, limitation: 'No trusted collection available',
};
const availableFault = (incident: Incident) => isActiveFault(incident) && incident.kind === 'incident'
  && incident.severity !== 'maintenance' && !incident.supersededBy;
function activeFaults(provider: ProviderCollection, state: PersistedState): Incident[] {
  const trusted = provider.result ?? provider.lastTrustedResult;
  if (!trusted) return [];
  return state.incidents.filter((incident) => incident.providerId === provider.providerId && availableFault(incident)
    && (incident.origin === 'official' ? isCurrentNativeFault(incident, trusted)
      : trusted.components.some((component) => incident.affectedComponentIds.includes(component.id)
        && component.reportedStatus !== null && STATUS_SEVERITY[component.reportedStatus] >= 2)
        || (incident.affectedComponentIds.length === 0 && trusted.reportedStatus !== null && STATUS_SEVERITY[trusted.reportedStatus] >= 2)));
}
function componentGroups(providerId: string, components: Component[]): ProviderDetail['componentGroups'] {
  const groups = new Map<string, Component[]>();
  for (const component of components) {
    const id = component.groupId ?? `${providerId}:ungrouped`;
    groups.set(id, [...groups.get(id) ?? [], component]);
  }
  const config = configs.find(({ id }) => id === providerId)!;
  return [...groups].map(([id, values]) => ({ id,
    name: groupLabels[id] ?? config.adapter.componentGroups.find((group) =>
      id === `${providerId}:${group.id}` || id === group.id)?.name
      ?? (id === `${providerId}:ungrouped` ? config.name : id),
    components: values }));
}

export function buildPublicArtifacts(
  run: CollectionRun, state: PersistedState, options: { dataMode?: Envelope['dataMode'] } = {},
): PublicArtifacts {
  if (state.latest?.snapshotId !== run.snapshotId) throw new Error('Public export requires the matching persistent snapshot');
  if (new Set(run.providers.map(({ providerId }) => providerId)).size !== run.providers.length) throw new Error('Duplicate provider');
  const envelope: Envelope = { schemaVersion: '1.0', snapshotId: run.snapshotId, generatedAt: run.completedAt,
    intervalMinutes: run.intervalMinutes, dataMode: options.dataMode ?? 'live' };
  const selected = run.providers.map((provider) => {
    const config = configs.find(({ id }) => id === provider.providerId);
    if (!config) throw new Error(`Unconfigured provider ${provider.providerId}`);
    return config;
  }).sort((a, b) => a.displayOrder - b.displayOrder);
  const recentCutoff = Date.parse(run.completedAt) - 30 * 86_400_000;
  const recentIncidents = state.incidents.filter((incident) => !incident.supersededBy
    && (state.openIncidents.some(({ id }) => id === incident.id) || Date.parse(incident.resolvedAt ?? incident.lastObservedAt) >= recentCutoff));
  const details: Record<string, ProviderDetail> = {};
  for (const config of selected) {
    const provider = run.providers.find(({ providerId }) => providerId === config.id)!;
    const trusted = provider.result ?? provider.lastTrustedResult;
    const components = trusted?.components ?? [];
    const abnormal = components.filter(({ reportedStatus }) => reportedStatus !== null && STATUS_SEVERITY[reportedStatus] >= 2);
    const days = buildDailyStats(state, run.completedAt, run.intervalMinutes, config.id).slice(-30);
    const summary: ProviderSummary = {
      id: config.id, name: config.name, category: config.category,
      status: publicStatus(trusted?.reportedStatus ?? null, provider.collection.freshness),
      reportedStatus: trusted?.reportedStatus ?? null, officialStatusUrl: config.officialStatusUrl,
      collection: provider.collection, coverage: trusted?.coverage ?? { ...unknownCoverage, regions: config.adapter.requiredRegions },
      componentSummary: { total: components.length, abnormal: abnormal.length,
        abnormalNames: [...new Set(abnormal.map(({ name }) => name))].slice(0, 5),
        affectedRegions: [...new Set(abnormal.flatMap(({ region }) => region ? [region] : []))] },
      dailyTrack30d: days.map((day) => day.worstStatus && STATUS_SEVERITY[day.worstStatus] > 0
        ? String(STATUS_SEVERITY[day.worstStatus]) : day.worstStatus === 'operational' && day.unknownMinutes === 0 ? '0' : '9').join(''),
      dailyCoverage30d: days.map(({ observedCoverageMinutes, unknownMinutes }) => ({ observedCoverageMinutes, unknownMinutes })),
      activeIncidents: activeFaults(provider, state).map(({ id, title, severity, origin, startedAt, updatedAt, sourceUrl }) =>
        ({ id, title, severity, origin, startedAt, updatedAt, sourceUrl })),
    };
    details[config.id] = { ...envelope, provider: summary, componentGroups: componentGroups(config.id, components),
      dailyHistory30d: days, recentIncidents: trusted ? recentIncidents.filter(({ providerId }) => providerId === config.id) : [],
      warnings: [...trusted?.evidence.warnings ?? [], ...provider.collection.message ? [provider.collection.message] : []] };
  }
  const providers = selected.map(({ id }) => details[id]!.provider);
  const summary = { ...envelope, globalSummary: summarizeProviders(providers), providers };
  const search = buildSearch(envelope, selected, details);
  const recent = { ...envelope, incidents: recentIncidents };
  const health = { ...envelope, runId: run.snapshotId, durationMs: Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)),
    latestPublishedSnapshotId: run.snapshotId, providers: selected.map((config) => ({
      providerId: config.id, sourceType: config.adapter.type,
      collection: run.providers.find(({ providerId }) => providerId === config.id)!.collection,
    })) };
  const archives: PublicIncidentArchive[] = buildArchives(state).archives.map((archive) => {
    const incidents = archive.incidents.map((incident) => incidentSchema.parse(incident));
    return { ...archive, incidents, dataMode: envelope.dataMode, revision: revisionOf({ dataMode: envelope.dataMode, incidents }) };
  });
  const months: PublicArchiveIndex['months'] = archives.map((archive) => ({
    month: archive.month, revision: archive.revision,
    path: `/api/v1/incidents/archive/${archive.month}/${archive.revision}.json`,
    incidentCount: archive.incidents.length, minStartedAt: archive.incidents[0]?.startedAt ?? null,
    maxResolvedAt: archive.incidents.flatMap(({ resolvedAt }) => resolvedAt ? [resolvedAt] : []).sort().at(-1) ?? null,
    updatedAt: archive.updatedAt,
  }));
  const archiveIndex: PublicArchiveIndex = { schemaVersion: '1.0', dataMode: envelope.dataMode,
    revision: revisionOf({ dataMode: envelope.dataMode, months }),
    generatedAt: months.map(({ updatedAt }) => updatedAt).sort().at(-1) ?? null, months };
  const base = `/api/v1/snapshots/${run.snapshotId}`;
  const manifest: Manifest = { ...envelope, archiveIndexRevision: archiveIndex.revision, paths: {
    summary: `${base}/summary.json`, providers: Object.fromEntries(selected.map(({ id }) => [id, `${base}/providers/${id}.json`])),
    recentIncidents: `${base}/incidents/recent.json`, health: `${base}/meta/health.json`, search: `${base}/search.json`,
    archiveIndex: `/api/v1/incidents/archive/indexes/${archiveIndex.revision}.json`,
  } };
  const files: Record<string, unknown> = { 'api/v1/manifest.json': manifest, [`${base.slice(1)}/manifest.json`]: manifest };
  const hot = { 'summary.json': summary, 'search.json': search, 'incidents/recent.json': recent, 'meta/health.json': health,
    ...Object.fromEntries(selected.map(({ id }) => [`providers/${id}.json`, details[id]])) };
  for (const [path, value] of Object.entries(hot)) { files[`api/v1/${path}`] = value; files[`${base.slice(1)}/${path}`] = value; }
  files['api/v1/incidents/archive/index.json'] = archiveIndex;
  files[manifest.paths.archiveIndex.slice(1)] = archiveIndex;
  for (const archive of archives) {
    files[`api/v1/incidents/archive/${archive.month}.json`] = archive;
    files[`api/v1/incidents/archive/${archive.month}/${archive.revision}.json`] = archive;
  }
  const feeds = buildFeeds(state, envelope, selected);
  return { manifest, summary, details, search, recent, health, archiveIndex, archives, files, feeds };
}
