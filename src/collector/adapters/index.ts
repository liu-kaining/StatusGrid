import type { Adapter, ProviderConfig } from '../../shared/contracts.js';
import { statuspageAdapter } from './statuspage.js';

export function createAdapter(config: ProviderConfig): Adapter {
  if (config.adapter.type === 'statuspage-v2') return statuspageAdapter;
  throw new Error(`Unregistered adapter: ${config.adapter.type}`);
}
