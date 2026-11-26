import { createHash } from 'node:crypto';
import type { BrowserResponse, ProviderConfig } from '../../shared/contracts.js';
import { AdapterError } from '../errors.js';
import { record, text, timestamp } from './common.js';

export function requireRegions(config: ProviderConfig): string[] {
  const regions = config.adapter.requiredRegions;
  if (!regions.length || new Set(regions).size !== regions.length) {
    throw new AdapterError('coverage_incomplete', 'An explicit nonempty, unique region scope is required');
  }
  return regions;
}

export function requireCoverage(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AdapterError('coverage_incomplete', message);
}

export function shanghaiDate(now: string): string {
  return new Date(Date.parse(now) + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function chinaTime(raw: unknown, label: string): string {
  if (typeof raw === 'number') return timestamp(new Date(raw).toISOString(), label);
  const value = text(raw, label);
  return timestamp(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d)?$/.test(value)
    ? `${value.replace(' ', 'T')}+08:00` : value, label);
}

export function digestIdentity(...fields: string[]): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 24);
}

export function browserJson(response: BrowserResponse): unknown {
  if (response.status < 200 || response.status >= 300) {
    throw new AdapterError(response.status === 401 || response.status === 403 ? 'blocked' : 'http_error',
      'Public browser business response failed');
  }
  try { return JSON.parse(response.body) as unknown; }
  catch { throw new AdapterError('invalid_payload', 'Public browser response is not JSON'); }
}

export function scopedResponse(responses: BrowserResponse[], url: string,
  requestFields?: Record<string, string>): unknown {
  const matching = responses.filter((response) => response.url === url
    && Object.entries(requestFields ?? {}).every(([key, value]) => response.requestScope?.[key] === value));
  requireCoverage(matching.length, `Required public response missing: ${url}${requestFields ? ' (region scope)' : ''}`);
  const payloads = matching.map(browserJson);
  requireCoverage(payloads.every((payload) => JSON.stringify(payload) === JSON.stringify(payloads[0])),
    'Conflicting public responses for the same required scope');
  return payloads[0];
}

export function businessData(raw: unknown, vendor: 'aliyun' | 'baidu'): unknown {
  const envelope = record(raw, `${vendor} business envelope`);
  const success = vendor === 'aliyun' ? envelope.success === true && envelope.code === 200 : envelope.code === 0;
  if (!success) {
    const blocked = vendor === 'aliyun' ? envelope.code === 502 : envelope.code === 90003;
    throw new AdapterError(blocked ? 'blocked' : 'http_error', `${vendor} public business request rejected (code ${String(envelope.code)})`);
  }
  return envelope.data;
}
