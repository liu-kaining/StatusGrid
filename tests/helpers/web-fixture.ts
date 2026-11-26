import registry from '../../registry/providers.json';
import { buildPublicArtifacts } from '../../src/collector/export/json.js';
import { emptyState, applyCollection } from '../../src/collector/events/reconcile.js';
import type { CollectionRun } from '../../src/collector/types.js';
import type { AdapterResult, ServiceStatus, SourceIncident } from '../../src/shared/contracts.js';
import { source } from './history.js';

/** Explicit fixture data, passed through the real reconciliation and public exporter. */
export function webFixture(at = '2026-11-26T08:00:00.000Z') {
  const makeRun = (date: string, historical: boolean): CollectionRun => ({
    snapshotId: `fixture-${date.replace(/[:.]/g, '-')}`, startedAt: date, completedAt: date, intervalMinutes: 5,
    providers: ['openai', 'github', 'cloudflare', 'aliyun'].map((id) => {
      const config = registry.find((provider) => provider.id === id)!;
      const status: ServiceStatus = historical ? 'operational' : id === 'openai' ? 'degraded' : id === 'cloudflare' ? 'maintenance' : 'operational';
      const incidents: SourceIncident[] = id === 'openai' ? [source({
        providerId: id, sourceIdentity: `${id}:${historical ? 'october' : 'current'}`, upstreamId: historical ? 'october' : 'current',
        title: historical ? 'October API interruption' : 'API requests experiencing elevated latency',
        startedAt: historical ? date : new Date(Date.parse(date) - 60 * 60_000).toISOString(), updatedAt: date, lastObservedAt: date,
        state: historical ? 'resolved' : 'investigating', resolvedAt: historical ? date : null,
        resolvedTimeBasis: historical ? 'source' : null, affectedComponentIds: [`${id}:api`],
        sourceUrl: 'https://status.openai.com/incidents/fixture',
        updates: [{ id: 'update-1', phase: historical ? 'resolved' : 'investigating', timestamp: date,
          body: historical ? 'Service restored.' : '<strong>Investigating</strong> elevated latency. Upstream text stays text.' }],
      })] : [];
      const result: AdapterResult | null = id === 'aliyun' ? null : {
        providerId: id, reportedStatus: status, components: [
          { id: `${id}:api`, upstreamId: 'api', groupId: null, name: id === 'openai' ? 'Chat Completions' : 'API', aliases: ['neural-endpoint'],
            region: 'us-east-1', reportedStatus: status },
        ], incidents, sourceUpdatedAt: date,
        coverage: { basis: 'official_public', regions: ['us-east-1'], componentScope: 'filtered',
          currentState: 'complete', history: 'mixed', observedSince: date, nativeHistoryEarliestAt: date,
          limitation: '仅覆盖配置的 us-east-1 地域，未覆盖所有产品。' },
        evidence: { requiredChecks: [], currentIncidentIds: historical ? [] : incidents.map(({ sourceIdentity }) => sourceIdentity),
          historyCompleteThrough: date, warnings: [] },
      };
      return { providerId: id, officialStatusUrl: config.officialStatusUrl, result, lastTrustedResult: result,
        collection: { outcome: result ? 'success' : 'failure', freshness: result ? 'fresh' : 'missing',
          reason: result ? null : 'blocked', message: result ? null : '公共源请求受阻；无法判断服务状态',
          lastCheckedAt: date, lastSuccessAt: result ? date : null, sourceUpdatedAt: result ? date : null,
          durationMs: 10, consecutiveFailures: result ? 0 : 1 } };
    }),
  });
  const historicalAt = new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() - 1, 15, 8)).toISOString();
  const old = makeRun(historicalAt, true);
  const current = makeRun(at, false);
  const state = applyCollection(applyCollection(emptyState(), old), current);
  return buildPublicArtifacts(current, state, { dataMode: 'fixture' });
}
