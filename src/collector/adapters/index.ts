import type { Adapter, ProviderConfig } from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
import { statuspageAdapter } from './statuspage.js';
import { deepseekAdapter } from './deepseek.js';
import { flashdutyAdapter } from './flashduty.js';
import { googleCloudAdapter } from './google-cloud.js';
import { appleAdapter } from './apple.js';
import { azureAdapter } from './azure.js';
import { awsChinaAdapter } from './aws-cn.js';
import { tencentAdapter } from './tencent.js';
import { aliyunAdapter } from './aliyun.js';
import { baiduAdapter } from './baidu.js';
import { incidentIoAdapter } from './incident-io.js';

export function createAdapter(config: ProviderConfig): Adapter {
  if (config.adapter.type === 'statuspage-v2') return statuspageAdapter;
  if (config.adapter.type === 'deepseek') return deepseekAdapter;
  if (config.adapter.type === 'flashduty') return flashdutyAdapter;
  if (config.adapter.type === 'google-cloud-json') return googleCloudAdapter;
  if (config.adapter.type === 'apple-status') return appleAdapter;
  if (config.adapter.type === 'azure-status') return azureAdapter;
  if (config.adapter.type === 'aws-cn-health') return awsChinaAdapter;
  if (config.adapter.type === 'tencent-cloud') return tencentAdapter;
  if (config.adapter.type === 'aliyun') return aliyunAdapter;
  if (config.adapter.type === 'baidu-cloud') return baiduAdapter;
  if (config.adapter.type === 'incident-io') return incidentIoAdapter;
  throw new AdapterError('not_connected', `Unregistered adapter: ${config.adapter.type}`);
}
