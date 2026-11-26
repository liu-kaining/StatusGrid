import type { Envelope, ProviderConfig, ProviderDetail, SearchIndex } from '../../shared/contracts.js';

const unique = (values: string[]) => [...new Set(values)];
export function buildSearch(envelope: Envelope, configs: ProviderConfig[], details: Record<string, ProviderDetail>): SearchIndex {
  return { ...envelope, providers: configs.map((config) => {
    const detail = details[config.id]!;
    const components = detail.componentGroups.flatMap((group) => group.components);
    return {
      providerId: config.id, names: unique([config.name, config.id, ...config.aliases, ...config.tags]),
      components: unique(components.flatMap(({ name, aliases }) => [name, ...aliases])),
      regions: unique([...detail.provider.coverage.regions, ...components.flatMap(({ region }) => region ? [region] : [])]),
      incidentTitles: unique(detail.recentIncidents.map(({ title }) => title)),
    };
  }) };
}
