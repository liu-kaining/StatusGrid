import type { z } from 'zod';
import type { Envelope, Incident, Manifest, ProviderDetail, SearchIndex, Summary } from '../../shared/contracts.js';
import { archiveIndexSchema, archiveSchema, manifestSchema, providerDetailSchema, recentSchema, searchSchema, summarySchema } from '../../shared/public-schemas.js';
import type { HistoryFilters } from '../state/types.js';
import { deduplicateIncidents } from './queries.js';

export class SnapshotChangedError extends Error {
  constructor() { super('快照已更新，请刷新以读取同一版本的数据。'); this.name = 'SnapshotChangedError'; }
}
const aborted = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export function createDataClient(options: { fetcher?: typeof fetch; baseUrl?: string } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const base = options.baseUrl ?? '';
  let latest: Manifest | null = null;
  const manifests = new Map<string, Manifest>();
  async function read<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const response = await fetcher(`${base}${path}`, { signal, cache: path === '/api/v1/manifest.json' ? 'no-cache' : 'default' });
    if (!response.ok) throw new Error(`数据请求失败 (${response.status})：${path}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`数据格式或版本校验失败：${path}`);
    return parsed.data;
  }
  function checkEnvelope(value: Envelope, manifest: Manifest) {
    if (value.snapshotId !== manifest.snapshotId || value.generatedAt !== manifest.generatedAt
      || value.dataMode !== manifest.dataMode || value.intervalMinutes !== manifest.intervalMinutes) {
      throw new Error('快照版本不匹配，未使用未经验证的数据。');
    }
  }
  async function discover(signal: AbortSignal) {
    const manifest = await read('/api/v1/manifest.json', manifestSchema, signal);
    const prefix = `/api/v1/snapshots/${manifest.snapshotId}/`;
    const paths = [manifest.paths.summary, manifest.paths.search, manifest.paths.recentIncidents, manifest.paths.health,
      ...Object.values(manifest.paths.providers)];
    if (paths.some((path) => !path.startsWith(prefix))
      || manifest.paths.archiveIndex !== `/api/v1/incidents/archive/indexes/${manifest.archiveIndexRevision}.json`) {
      throw new Error('Manifest 版本化路径不匹配');
    }
    latest = manifest;
    manifests.set(manifest.snapshotId, manifest);
    return manifest;
  }
  async function retry<T>(action: (again: boolean) => Promise<T>) {
    try { return await action(false); } catch (error) {
      if (aborted(error) || error instanceof SnapshotChangedError) throw error;
      return action(true);
    }
  }
  async function manifestFor(snapshotId: string, signal: AbortSignal, refresh = false) {
    const manifest = refresh ? await discover(signal) : manifests.get(snapshotId) ?? await discover(signal);
    if (manifest.snapshotId !== snapshotId) throw new SnapshotChangedError();
    return manifest;
  }
  async function loadSnapshot(signal: AbortSignal): Promise<Summary> {
    return retry(async () => {
      const manifest = await discover(signal);
      const summary = await read(manifest.paths.summary, summarySchema, signal);
      checkEnvelope(summary, manifest);
      if (summary.providers.some(({ id }) => !manifest.paths.providers[id])
        || summary.providers.length !== Object.keys(manifest.paths.providers).length) throw new Error('快照厂商索引不匹配');
      return summary;
    });
  }
  async function loadProvider(id: string, snapshotId: string, signal: AbortSignal): Promise<ProviderDetail> {
    return retry(async (again) => {
      const manifest = await manifestFor(snapshotId, signal, again);
      const path = manifest.paths.providers[id];
      if (!path) throw new Error('此快照中没有该厂商');
      const detail = await read(path, providerDetailSchema, signal);
      checkEnvelope(detail, manifest);
      if (detail.provider.id !== id) throw new Error('厂商详情身份校验失败');
      return detail;
    });
  }
  async function loadSearch(snapshotId: string, signal: AbortSignal): Promise<SearchIndex> {
    return retry(async (again) => {
      const manifest = await manifestFor(snapshotId, signal, again);
      const search = await read(manifest.paths.search, searchSchema, signal);
      checkEnvelope(search, manifest);
      if (new Set(search.providers.map(({ providerId }) => providerId)).size !== search.providers.length
        || search.providers.length !== Object.keys(manifest.paths.providers).length
        || search.providers.some(({ providerId }) => !manifest.paths.providers[providerId])) throw new Error('搜索厂商索引不匹配');
      return search;
    });
  }
  async function loadHistory(filters: HistoryFilters, signal: AbortSignal): Promise<Incident[]> {
    return retry(async (again) => {
      const manifest = filters.snapshotId ? await manifestFor(filters.snapshotId, signal, again)
        : again || !latest ? await discover(signal) : latest;
      const recent = await read(manifest.paths.recentIncidents, recentSchema, signal);
      checkEnvelope(recent, manifest);
      const index = await read(manifest.paths.archiveIndex, archiveIndexSchema, signal);
      if (index.revision !== manifest.archiveIndexRevision || index.dataMode !== manifest.dataMode) throw new Error('归档索引 revision 版本不匹配');
      const now = Date.parse(manifest.generatedAt);
      const month = filters.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(filters.month) ? filters.month : manifest.generatedAt.slice(0, 7);
      const start = filters.range === 'month' ? Date.parse(`${month}-01T00:00:00Z`)
        : now - Number.parseInt(filters.range) * 86_400_000;
      const end = filters.range === 'month'
        ? Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1) : now + 1;
      const months = index.months.filter((entry) => {
        const monthStart = Date.parse(`${entry.month}-01T00:00:00Z`);
        const monthEnd = Date.UTC(new Date(monthStart).getUTCFullYear(), new Date(monthStart).getUTCMonth() + 1, 1);
        return monthStart < end && (monthEnd > start || (entry.maxResolvedAt && Date.parse(entry.maxResolvedAt) >= start));
      });
      const archives = await Promise.all(months.map(async (entry) => {
        if (entry.path !== `/api/v1/incidents/archive/${entry.month}/${entry.revision}.json`) throw new Error('归档路径版本不匹配');
        const archive = await read(entry.path, archiveSchema, signal);
        if (archive.revision !== entry.revision || archive.month !== entry.month || archive.dataMode !== manifest.dataMode) {
          throw new Error('归档 revision 版本不匹配');
        }
        return archive.incidents;
      }));
      return deduplicateIncidents([...recent.incidents, ...archives.flat()]).filter((incident) => {
        const overlaps = Date.parse(incident.startedAt) < end && (!incident.resolvedAt || Date.parse(incident.resolvedAt) >= start);
        return overlaps && (!filters.providers?.length || filters.providers.includes(incident.providerId))
          && (!filters.severity?.length || (incident.severity !== null && incident.severity !== 'maintenance' && filters.severity.includes(incident.severity)));
      });
    });
  }
  return { loadSnapshot, loadProvider, loadSearch, loadHistory,
    getManifest: (snapshotId?: string) => snapshotId ? manifests.get(snapshotId) : latest };
}
export const dataClient = createDataClient();
export const { loadSnapshot, loadProvider, loadHistory } = dataClient;
