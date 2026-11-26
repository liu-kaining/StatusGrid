import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { parseAwsChina } from '../../src/collector/adapters/aws-cn.js';
import { decodeBody } from '../../src/collector/http.js';
import observed from '../fixtures/aws-cn/observed-event.json';
import catalog from '../fixtures/aws-cn/services.json';

const config = parseRegistry(registry).find(({ id }) => id === 'aws-cn')!;
const now = '2026-11-25T16:20:00Z';
describe('AWS China current events', () => {
  it.each(['utf-8', 'utf-16le', 'utf-16be'])('accepts verified empty events in %s', (encoding) => {
    const bytes = encoding === 'utf-16be' ? Uint8Array.from([0xfe, 0xff, 0, 91, 0, 93]) : Buffer.from('[]', encoding as BufferEncoding);
    const text = decodeBody(bytes, `application/json;charset=${encoding}`);
    const result = parseAwsChina(config, JSON.parse(text), now);
    expect(result.reportedStatus).toBeNull();
    expect(result.coverage.currentState).toBe('partial');
    expect(result.coverage.regions).toEqual(['cn-north-1', 'cn-northwest-1']);
  });
  it('rejects unverified nonempty shape instead of assuming event semantics', () => {
    expect(() => parseAwsChina(config, [{ id: 'foo', status: 'open' }], now))
      .toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
    expect(() => parseAwsChina(config, [{ ...observed[0], typeCode: 'NEW_TYPE' }], now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
    expect(() => parseAwsChina(config, {}, now)).toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
  });
  it('retains observed nonempty AWS fields as historical evidence without inventing enum meanings', () => {
    const result = parseAwsChina(config, observed, now);
    expect(result.reportedStatus).toBeNull();
    expect(result.coverage.currentState).toBe('partial');
    expect(result.incidents[0]).toMatchObject({
      sourceSeverity: 'AWS_MULTIPLE_SERVICES_OPERATIONAL_ISSUE',
      severity: null, state: 'resolved', affectedRegions: ['cn-north-1'],
      startedAt: '2026-11-18T16:36:07.000Z',
      resolvedAt: '2026-11-19T01:41:28.000Z',
    });
    expect(result.incidents[0]?.updates).toHaveLength(2);
    expect(result.incidents[0]?.updates[0]?.phase).toBe('unknown');
  });
  it('matches the saved UTF-16BE response', () => {
    const actual = Buffer.from(readFileSync('tests/fixtures/transport/aws-cn-utf16be.hex', 'utf8').trim(), 'hex');
    expect(parseAwsChina(config, JSON.parse(decodeBody(actual, 'application/json;charset=utf-16')), now).coverage.currentState).toBe('partial');
  });
  it('accepts empty current events when independent official catalog covers both configured regions', () => {
    const result = parseAwsChina(config, [], now, catalog);
    expect(result.reportedStatus).toBe('operational');
    expect(result.coverage.currentState).toBe('complete');
    expect(result.evidence.requiredChecks.map(({ name }) => name)).toEqual(['currentevents_shape', 'services_region_catalog']);
  });
  it('fails closed when the catalog misses a required region', () => {
    expect(() => parseAwsChina(config, [], now, catalog.slice(0, 1)))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });
  it('accepts null message on observed AWS history update without losing event identity', () => {
    const event = { ...observed[0]!, metadata: {
      EVENT_LOG: JSON.stringify([{ summary: 'Update', message: null, status: 2, timestamp: 1795021514 }]),
    } };
    const result = parseAwsChina(config, [], now, catalog, [event]);
    expect(result.incidents[0]?.updates[0]?.body).toBe('');
    expect(result.reportedStatus).toBe('operational');
  });
  it('normalizes a constructed current impact using source JS status 2, but not unknown status 1', () => {
    const active = { ...observed[0]!, endTime: null, metadata: {
      EVENT_LOG: JSON.stringify([{ summary: 'Elevated errors', message: 'Service impact',
        status: 2, timestamp: 1795019767 }]),
    } };
    const result = parseAwsChina(config, [active], now, catalog);
    expect(result.reportedStatus).toBe('degraded');
    expect(result.incidents[0]).toMatchObject({ state: 'investigating', resolvedAt: null });
    expect(result.evidence.currentIncidentIds).toHaveLength(1);
    const unknown = { ...active, metadata: {
      EVENT_LOG: JSON.stringify([{ summary: 'Information', message: 'Notice',
        status: 1, timestamp: 1795019767 }]),
    } };
    expect(() => parseAwsChina(config, [unknown], now, catalog))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });
});
