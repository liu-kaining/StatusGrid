import type { Freshness, ProviderSummary, PublicStatus, ServiceStatus, Summary } from './contracts';

export function publicStatus(reportedStatus: ServiceStatus | null, freshness: Freshness): PublicStatus {
  return freshness === 'fresh' && reportedStatus !== null ? reportedStatus : 'stale';
}

const severity: Record<ServiceStatus, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
};

export function summarizeProviders(providers: ProviderSummary[]): Summary['globalSummary'] {
  const countsByStatus: Record<PublicStatus, number> = {
    operational: 0,
    maintenance: 0,
    degraded: 0,
    partial_outage: 0,
    major_outage: 0,
    stale: 0,
  };
  let connectedProviders = 0;
  let activeIncidentCount = 0;
  let highestKnown: ServiceStatus = 'operational';

  for (const provider of providers) {
    const expectedStatus = publicStatus(provider.reportedStatus, provider.collection.freshness);
    if (provider.status !== expectedStatus) {
      throw new Error(`Inconsistent public status for provider ${provider.id}`);
    }
    const connected = provider.collection.freshness === 'fresh'
      && (provider.collection.outcome === 'success' || provider.collection.outcome === 'partial')
      && provider.coverage.currentState === 'complete';
    const status = connected ? provider.status : 'stale';
    countsByStatus[status] += 1;
    if (status !== 'stale') {
      connectedProviders += 1;
      if (severity[status] > severity[highestKnown]) highestKnown = status;
    }
    activeIncidentCount += provider.activeIncidents.length;
  }

  const staleProviderCount = countsByStatus.stale;
  const overallStatus: PublicStatus = severity[highestKnown] >= severity.degraded
    ? highestKnown
    : staleProviderCount > 0 || providers.length === 0
      ? 'stale'
      : highestKnown;

  return {
    overallStatus,
    totalProviders: providers.length,
    connectedProviders,
    countsByStatus,
    abnormalProviderCount: countsByStatus.degraded
      + countsByStatus.partial_outage + countsByStatus.major_outage,
    activeIncidentCount,
    maintenanceCount: countsByStatus.maintenance,
    staleProviderCount,
  };
}
