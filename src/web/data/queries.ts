import type { Incident, ProviderSummary, PublicStatus, SearchIndex } from '../../shared/contracts.js';
import type { ViewState } from '../state/types.js';

export const statusLabels: Record<PublicStatus, string> = {
  operational: '官方未报告异常', maintenance: '计划维护', degraded: '性能下降',
  partial_outage: '部分中断', major_outage: '严重中断', stale: '采集受阻',
};
export const statusSymbols: Record<PublicStatus, string> = {
  operational: '●', maintenance: '◇', degraded: '▲', partial_outage: '▲', major_outage: '◆', stale: '⊘',
};
export const categoryLabels = { ai: 'AI 服务', 'cloud-cn': '国内云', 'cloud-global': '全球云', infra: '基础设施' };
const order: Record<PublicStatus, number> = { major_outage: 0, partial_outage: 1, degraded: 2, maintenance: 3, stale: 4, operational: 5 };
const latestEvent = (provider: ProviderSummary) => Math.max(0, ...provider.activeIncidents.map(({ updatedAt }) => Date.parse(updatedAt)));
export function filterProviders(providers: ProviderSummary[], state: ViewState, search?: SearchIndex | null, snapshotExpired = false): ProviderSummary[] {
  const displayStatus = (provider: ProviderSummary) => snapshotExpired ? 'stale' : provider.status;
  const query = state.query.toLocaleLowerCase().trim();
  return providers.filter((provider) => {
    if (state.category && provider.category !== state.category) return false;
    if (state.onlyAbnormal && displayStatus(provider) === 'operational') return false;
    if (!query) return true;
    const entry = search?.providers.find(({ providerId }) => providerId === provider.id);
    const words = [provider.id, provider.name, ...entry ? [...entry.names, ...entry.components, ...entry.regions, ...entry.incidentTitles] : []];
    return words.some((word) => word.toLocaleLowerCase().includes(query));
  }).sort((a, b) => order[displayStatus(a)] - order[displayStatus(b)]
    || (displayStatus(a) !== 'operational' ? latestEvent(b) - latestEvent(a) : 0));
}
export function snapshotFreshness(at: string, intervalMinutes: number, now = Date.now()): 'fresh' | 'delayed' | 'stale' {
  const age = now - Date.parse(at);
  return age >= intervalMinutes * 3 * 60_000 ? 'stale' : age >= intervalMinutes * 2 * 60_000 ? 'delayed' : 'fresh';
}
export function trackDate(generatedAt: string, index: number): string {
  const at = new Date(generatedAt);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - 29 + index)).toISOString().slice(0, 10);
}
export function timeLabel(value: string | null): string {
  return value ? `${value.slice(0, 10)} ${value.slice(11, 19)} UTC` : '暂无可信记录';
}
export function ageLabel(at: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  return minutes < 1 ? '不足 1 分钟' : minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${Math.floor(minutes / 1440)} 天`;
}
export function deduplicateIncidents(incidents: Incident[]): Incident[] {
  const byId = new Map<string, Incident>();
  for (const incident of incidents) {
    if (incident.supersededBy) continue;
    const previous = byId.get(incident.id);
    if (!previous || incident.updatedAt > previous.updatedAt) byId.set(incident.id, incident);
  }
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
