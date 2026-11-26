import type { Category } from '../../shared/contracts.js';
import type { FaultSeverity, ViewState } from './types.js';

const categories = ['ai', 'cloud-cn', 'cloud-global', 'infra'];
export const faultSeverities: FaultSeverity[] = ['degraded', 'partial_outage', 'major_outage'];
const validId = (value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
export function parseViewState(search: string): ViewState {
  const params = new URLSearchParams(search);
  const category = params.get('cat') ?? '';
  const provider = params.get('provider') ?? '';
  const range = params.get('range') ?? '';
  const month = params.get('month') ?? '';
  const severities = (params.get('severity') ?? '').split(',');
  return {
    view: params.get('view') === 'incidents' ? 'incidents' : 'grid',
    category: categories.includes(category) ? category as Category : '',
    query: (params.get('q') ?? '').trim().slice(0, 200),
    onlyAbnormal: params.get('only_abnormal') === '1',
    provider: validId(provider) ? provider : '',
    range: range === '7d' || range === '90d' || range === 'month' ? range : '30d',
    month: /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : '',
    severity: faultSeverities.filter((value) => severities.includes(value)),
    providers: [...new Set((params.get('providers') ?? '').split(',').filter(validId))].slice(0, 50),
  };
}

export function serializeViewState(state: ViewState): string {
  const params = new URLSearchParams();
  if (state.view !== 'grid') params.set('view', state.view);
  if (state.category) params.set('cat', state.category);
  if (state.query.trim()) params.set('q', state.query.trim());
  if (state.onlyAbnormal) params.set('only_abnormal', '1');
  if (state.provider) params.set('provider', state.provider);
  if (state.range !== '30d') params.set('range', state.range);
  if (state.month) params.set('month', state.month);
  if (state.severity.length) params.set('severity', state.severity.join(','));
  if (state.providers.length) params.set('providers', state.providers.join(','));
  const value = params.toString();
  return value ? `?${value}` : '';
}
